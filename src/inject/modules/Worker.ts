import { modifyJS, routeJS } from '../../rewriteJS';
import { proxyBlobURL } from '../../routeURL';
import StompURL from '../../StompURL';
import { WORKER_BASE } from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
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
		const workerURL = (source: string, isModule: boolean): string => {
			const url = new URL(source, this.client.url.toString());
			const type = isModule ? 'workerModule' : 'worker';
			if (url.protocol === 'blob:') {
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
								proxyBlobURL(url.href),
							)}));`
						: modifyJS(
								`importScripts(${JSON.stringify(url.href)});`,
								this.client.url,
								this.client.config,
								type,
							));
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

		const isModuleOptions = (options: unknown) =>
			typeof options === 'object' &&
			options !== null &&
			(options as WorkerOptions).type === 'module';

		// a shared worker scope has no Worker constructor
		if (typeof global.Worker === 'function')
			global.Worker = proxyModule.wrapFunction(
				global.Worker,
				(target, that, args, newTarget) => {
					if (!newTarget) throw new TypeError(WORKER_CTOR_ERROR('Worker'));
					catchRequiredArguments(args.length, 1, 'Worker', 'constructor');
					args[0] = workerURL(String(args[0]), isModuleOptions(args[1]));
					const worker: Worker = Reflect.construct(target, args, newTarget);
					this.client.provisionWorkerTransport(worker);
					return worker;
				},
				true,
			);

		if (typeof global.SharedWorker === 'function')
			global.SharedWorker = proxyModule.wrapFunction(
				global.SharedWorker,
				(target, that, args, newTarget) => {
					if (!newTarget)
						throw new TypeError(WORKER_CTOR_ERROR('SharedWorker'));
					catchRequiredArguments(args.length, 1, 'SharedWorker', 'constructor');
					args[0] = workerURL(String(args[0]), isModuleOptions(args[1]));
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
