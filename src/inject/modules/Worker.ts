import { routeRefused } from '../../routeURL';
import { routeJS } from '../../scriptRoutes';
import StompURL from '../../StompURL';
import Client from '../Client';
import Module from '../Module';
import { failsToParse, withStack } from '../nativeErrors';
import { LazyWeakSet } from '../ownCollections';
import { requestRefused } from '../requestVerdict';
import { trustedScriptURL } from '../trusted';
import { PRIVATE_URL_MS } from '../workerBlobs';
import type { WorkerStart } from '../workerStart';
import { workerStartParts } from '../workerStartParts';
import ProxyModule, { catchRequiredArguments } from './Proxy';

const WORKER_CTOR_ERROR = (name: string) =>
	`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`;

/**
 * A worker started from a blob: URL (its bootstrap) makes no request for its
 * script, so the service worker cannot see who made it: the request for its
 * transport says (InitRemoteTransportMessage)
 */
const blobScript = (url: unknown): string | undefined =>
	typeof url === 'string' && url.startsWith('blob:') ? url : undefined;

export default class WorkerModule extends Module<Client> {
	/** the realm's Worker before the hook below: the inject's own workers (the WebRTC worker) start through it */
	nativeWorker: typeof Worker | undefined;
	apply() {
		const moduleClient = this.client;
		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const global = moduleClient.global;
		this.nativeWorker = global.Worker;
		// (the bootstrap below is our own code, made in the realm's own Blob)
		const NativeBlob = global.Blob;

		/**
		 * A script of another real origin is refused as the browser refuses
		 * one (every route is same-origin to it, so it never does): a
		 * SecurityError naming the script and the page's origin.
		 */
		const checkOrigin = (name: string, source: string) => {
			const url = new URL(source, moduleClient.baseHref);
			const { origin } = moduleClient.url.url;
			if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin)
				throw withStack(
					new global.DOMException(
						`Failed to construct '${name}': Script at '${url.href}' cannot be accessed from origin '${origin}'.`,
						'SecurityError',
					),
				);
		};

		// the native fields, which name the routes and the bundle the browser
		// loaded ('' for an event that is no ErrorEvent: a script that failed
		// to load)
		const nativeField = (key: string) => {
			const getter = Reflect.getOwnPropertyDescriptor(
				global.ErrorEvent?.prototype ?? {},
				key,
			)?.get;
			return (event: Event): string => {
				try {
					return getter ? String(Reflect.apply(getter, event, [])) : '';
				} catch (error) {
					return '';
				}
			};
		};
		const messageOf = nativeField('message');
		const filenameOf = nativeField('filename');

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
		const terminated = new LazyWeakSet<object>();
		const start: WorkerStart = {
			client: moduleClient,
			global: global as typeof globalThis,
			NativeBlob,
			terminated,
			messageOf,
			filenameOf,
		};
		/**
		 * A blob: worker is controlled by its creator's service worker, and a
		 * document none controls (an about:blank frame or popup, a document
		 * written into one) has none to give it: the bootstrap's import of the
		 * page's script, and every routed request the worker made, reached the
		 * proxy origin's own server. Such a worker is started by the Worker of
		 * the nearest document a worker controls (Client.transportClient),
		 * with this realm's prototype, and ended when this document goes, as
		 * its own would be. Null where this document is controlled.
		 */
		const controlledWorker = (): typeof Worker | null => {
			if (moduleClient.controlled) return null;
			const via = moduleClient.transportClient();
			if (!via || via === moduleClient) return null;
			return via.getModule(WorkerModule)?.nativeWorker ?? null;
		};
		const listen = global.EventTarget?.prototype.addEventListener;

		// a shared worker scope has no Worker constructor
		if (typeof global.Worker === 'function') {
			const terminate = global.Worker.prototype.terminate;
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
					// (the page's Trusted Types judge the URL first)
					const source = moduleClient.trustedValue(
						args[0],
						'TrustedScriptURL',
						'Worker constructor',
						() => Reflect.construct(target, args, newTarget),
					);
					if (source === null) return undefined;
					// the browser's own SyntaxError
					if (failsToParse(moduleClient, source))
						return Reflect.construct(target, args, newTarget);
					checkOrigin('Worker', source);
					// a worker a worker's worker-src refuses fails to start, as the
					// browser fails it (requestVerdict reports it)
					const resolved = moduleClient.encodingParse(
						source,
						moduleClient.baseHref,
					);
					if (requestRefused(moduleClient, 'worker-src', resolved)) {
						args[0] = trustedScriptURL(
							routeRefused(new StompURL(resolved, moduleClient.url)),
						);
						return Reflect.construct(target, args, newTarget);
					}
					// (a deferred part, ../workerStart.ts: without it the constructor
					// throws here, before the browser's is called)
					const parts = workerStartParts.start!();
					const { url, own } = parts.workerURL(
						start,
						source,
						isModuleOptions(args[1]),
					);
					args[0] = trustedScriptURL(url);
					const via = blobScript(url) ? controlledWorker() : null;
					const worker: Worker = Reflect.construct(
						via ?? target,
						args,
						newTarget,
					);
					if (via && listen)
						Reflect.apply(listen, global, [
							'pagehide',
							() => Reflect.apply(terminate, worker, []),
							{ once: true },
						]);
					parts.watchErrors(
						start,
						worker,
						own,
						moduleClient.encodingParse(source, moduleClient.baseHref).href,
					);
					moduleClient.provisionWorkerTransport(worker, blobScript(url));
					if (own) parts.releaseOnLoad(start, worker, own);
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
					// (the page's Trusted Types judge the URL first)
					const source = moduleClient.trustedValue(
						args[0],
						'TrustedScriptURL',
						'SharedWorker constructor',
						() => Reflect.construct(target, args, newTarget),
					);
					if (source === null) return undefined;
					if (failsToParse(moduleClient, source))
						return Reflect.construct(target, args, newTarget);
					checkOrigin('SharedWorker', source);
					const { url, own } = workerStartParts.start!().workerURL(
						start,
						source,
						isModuleOptions(args[1]),
						true,
					);
					args[0] = trustedScriptURL(url);
					// a shared worker has no postMessage to say it took its
					// private URL: that one goes after PRIVATE_URL_MS
					if (own)
						setTimeout(() => global.URL.revokeObjectURL(own), PRIVATE_URL_MS);
					// shared workers are found by name within an origin: keep
					// proxied origins, and partitions of one, apart
					const suffix = `@${moduleClient.storageKey}`;
					if (typeof args[1] === 'object' && args[1] !== null)
						args[1] = { ...args[1], name: `${args[1].name ?? ''}${suffix}` };
					// (null is the empty options dictionary, as undefined is)
					else
						args[1] = `${args[1] === undefined || args[1] === null ? '' : String(args[1])}${suffix}`;
					const worker: SharedWorker = Reflect.construct(
						target,
						args,
						newTarget,
					);
					moduleClient.provisionPortTransport(worker.port, blobScript(url));
					return worker;
				},
				true,
			);

		// worklets load modules; no inject runs inside one, so the module is
		// routed as a worklet's, whose rewrite declares the access API it
		// calls (src/workletLead.ts)
		const worklet = (global as { Worklet?: typeof Worklet }).Worklet;
		if (worklet && typeof worklet.prototype.addModule === 'function')
			worklet.prototype.addModule = proxyModule.wrapFunction(
				worklet.prototype.addModule,
				(target, that, args) => {
					if (args.length)
						args[0] = routeJS(
							new StompURL(
								new URL(String(args[0]), moduleClient.baseHref),
								moduleClient.url,
							),
							moduleClient.url,
							moduleClient.config,
							'workletModule',
						);
					return Reflect.apply(target, that, args);
				},
			);
	}
}
