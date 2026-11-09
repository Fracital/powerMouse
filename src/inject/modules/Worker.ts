import { modifyJS, routeJS } from '../../rewriteJS';
import { injectWorkerJS, proxyBlobURL } from '../../routeURL';
import StompURL from '../../StompURL';
import { WORKER_BASE } from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
import { blobsByURL, PRIVATE_URL_MS, WORKER_LOADED } from '../workerBlobs';
import ProxyModule, { catchRequiredArguments } from './Proxy';

const WORKER_CTOR_ERROR = (name: string) =>
	`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`;

export default class WorkerModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		// the bootstrap below is our own code: a document's BlobDocuments
		// module (it applies after this one) would rewrite it once more as a
		// script blob, and the rewritten preamble then called the access
		// helper before it had loaded the inject that defines it
		const NativeBlob = global.Blob;

		/**
		 * The script URL a worker should really start with. A blob: URL holds
		 * page data the service worker can never read, so the worker starts
		 * from a small bootstrap instead: the usual worker preamble (inject,
		 * client), then the page's blob. A document rewrote the blob's script
		 * when the page made it (BlobDocuments); a worker's are not rewritten.
		 */
		/** the private URL each worker took its script from, released once it has (see workerBlobs) */
		let lastPrivate: string | undefined;
		const workerURL = (source: string, isModule: boolean): string => {
			lastPrivate = undefined;
			const url = new URL(source, this.client.url.toString());
			const type = isModule ? 'workerModule' : 'worker';
			if (url.protocol === 'blob:') {
				// resolved now, as the browser resolves it at construction: the
				// bootstrap imports a private URL of the page's Blob, which the
				// page's revoke right after `new Worker()` does not reach
				// (workerBlobs). A URL whose Blob is not known here is imported
				// as it is
				const blob = blobsByURL.get(proxyBlobURL(url.href));
				let script = url.href;
				// once the import is done the bootstrap says so, on a message
				// the hook below takes before any of the page's listeners
				let loaded = '';
				if (blob) {
					script = lastPrivate = proxyBlobURL(global.URL.createObjectURL(blob));
					// (a shared worker's scope has no postMessage)
					loaded = `\nif (typeof postMessage === 'function') postMessage({ [${JSON.stringify(WORKER_LOADED)}]: ${JSON.stringify(script)} });`;
				}
				// the page's URL first, so the client resolves relative URLs
				// against it rather than against the blob
				const base = `globalThis[${JSON.stringify(WORKER_BASE)}] = ${JSON.stringify(
					this.client.url.toString(),
				)};`;
				const bootstrap =
					base +
					(isModule
						? // a static import would run the page's module before this
							// module's body, which is what loads the client: imported
							// once the client is in place instead, with the messages
							// that come meanwhile held for the handlers it sets
							modifyJS('', this.client.url, this.client.config, type) +
							`\nawait ${this.client.names.client}.holdEvents(import(${JSON.stringify(
								proxyBlobURL(script),
							)}));` +
							loaded
						: modifyJS(
								`importScripts(${JSON.stringify(script)});`,
								this.client.url,
								this.client.config,
								type,
							) + loaded);
				// the bootstrap's own blob: URL goes to the browser, so in the
				// proxy's form (createObjectURL hands the page the page's)
				return proxyBlobURL(
					global.URL.createObjectURL(
						new NativeBlob([bootstrap], { type: 'text/javascript' }),
					),
				);
			}
			return routeJS(
				new StompURL(url, this.client.url),
				this.client.url,
				this.client.config,
				type,
			);
		};

		/**
		 * Release a worker's private URL when its bootstrap says it has taken
		 * it. The listener is the worker's first, and capturing (a page's
		 * capturing listener would run before a bubbling one), so the message
		 * stops there: the page's own never see it. A worker whose script
		 * failed before saying so lets it go after PRIVATE_URL_MS
		 */
		const releaseOnLoad = (worker: Worker, own: string) => {
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				worker.removeEventListener('message', listener, true);
				global.URL.revokeObjectURL(own);
			};
			const listener = (event: Event) => {
				const data = (event as MessageEvent).data;
				if (data?.[WORKER_LOADED] !== own) return;
				event.stopImmediatePropagation();
				release();
			};
			worker.addEventListener('message', listener, true);
			setTimeout(release, PRIVATE_URL_MS);
		};

		const isModuleOptions = (options: unknown) =>
			typeof options === 'object' &&
			options !== null &&
			(options as WorkerOptions).type === 'module';

		/**
		 * The workers the page terminated. Chrome reports an import a
		 * terminated worker was still loading as an error event on its
		 * Worker; a worker of ours imports the inject bundle (and a blob:
		 * worker the private URL of its script) before any script of the
		 * page's, so a page that terminates a worker at once (Cloudflare's
		 * challenge probes one that way) saw "importScripts ... failed to
		 * load" naming a URL of ours, where natively nothing was loading
		 * and nothing is reported. An import of the page's own reports as
		 * natively.
		 */
		const terminated = new WeakSet<object>();
		const hideOwnLoss = (worker: Worker, own: string | undefined) => {
			worker.addEventListener(
				'error',
				(event) => {
					if (!terminated.has(worker)) return;
					const message = String((event as ErrorEvent).message);
					const bundle = new URL(
						injectWorkerJS(this.client.url, this.client.config),
						this.client.url.directory,
					).href;
					if (
						![bundle, own].some(
							(url) => url !== undefined && message.includes(`'${url}'`),
						)
					)
						return;
					// not the page's to see, nor the window's to report
					event.stopImmediatePropagation();
					event.preventDefault();
				},
				true,
			);
		};

		// a shared worker scope has no Worker constructor
		if (typeof global.Worker === 'function') {
			global.Worker.prototype.terminate = proxyModule.wrapFunction(
				global.Worker.prototype.terminate,
				(target, that, args) => {
					if (typeof that === 'object' && that !== null) terminated.add(that);
					return Reflect.apply(target, that, args);
				},
			);
			global.Worker = proxyModule.wrapFunction(
				global.Worker,
				(target, that, args, newTarget) => {
					if (!newTarget) throw new TypeError(WORKER_CTOR_ERROR('Worker'));
					catchRequiredArguments(args.length, 1, 'Worker', 'constructor');
					args[0] = workerURL(String(args[0]), isModuleOptions(args[1]));
					const own = lastPrivate;
					const worker: Worker = Reflect.construct(target, args, newTarget);
					// the worker's first listener, before any of the page's
					hideOwnLoss(worker, own);
					this.client.provisionWorkerTransport(worker);
					if (own) releaseOnLoad(worker, own);
					return worker;
				},
				true,
			);
		}

		if (typeof global.SharedWorker === 'function')
			global.SharedWorker = proxyModule.wrapFunction(
				global.SharedWorker,
				(target, that, args, newTarget) => {
					if (!newTarget)
						throw new TypeError(WORKER_CTOR_ERROR('SharedWorker'));
					catchRequiredArguments(args.length, 1, 'SharedWorker', 'constructor');
					args[0] = workerURL(String(args[0]), isModuleOptions(args[1]));
					// a shared worker has no postMessage to say it took its
					// private URL: that one goes after PRIVATE_URL_MS
					const own = lastPrivate;
					if (own)
						setTimeout(() => global.URL.revokeObjectURL(own), PRIVATE_URL_MS);
					// shared workers are found by name within an origin: keep
					// proxied origins apart
					const suffix = `@${this.client.url.url.origin}`;
					if (typeof args[1] === 'object' && args[1] !== null)
						args[1] = { ...args[1], name: `${args[1].name ?? ''}${suffix}` };
					else
						args[1] = `${args[1] === undefined ? '' : String(args[1])}${suffix}`;
					const worker: SharedWorker = Reflect.construct(
						target,
						args,
						newTarget,
					);
					this.client.provisionPortTransport(worker.port);
					return worker;
				},
				true,
			);

		// worklets load modules; nothing of ours can run inside one, so the
		// module is only routed
		const worklet = (global as { Worklet?: typeof Worklet }).Worklet;
		if (worklet && typeof worklet.prototype.addModule === 'function')
			worklet.prototype.addModule = proxyModule.wrapFunction(
				worklet.prototype.addModule,
				(target, that, args) => {
					if (args.length)
						args[0] = routeJS(
							new StompURL(
								new URL(String(args[0]), this.client.url.toString()),
								this.client.url,
							),
							this.client.url,
							this.client.config,
							'genericModule',
						);
					return Reflect.apply(target, that, args);
				},
			);
	}
}
