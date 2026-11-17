import type { WorkerPolicies } from '../../csp';
import {
	injectWorkerJS,
	pageBlobURL,
	proxyBlobURL,
	routeRefused,
	routeURL,
} from '../../routeURL';
import { routeJS } from '../../scriptRoutes';
import StompURL from '../../StompURL';
import {
	CSP_FACTS,
	CSP_WORKER,
	WORKER_BASE,
	WORKER_ERROR,
	WORKER_PARTITION,
} from '../../transport/messages';
import Client from '../Client';
import Module from '../Module';
import { failsToParse, withStack } from '../nativeErrors';
import { LazyWeakSet } from '../ownCollections';
import { requestRefused } from '../requestVerdict';
import { modifyJS } from '../rewriter';
import {
	trustedScriptURL,
	trustedTypesUsed,
	trustedWorker,
	useTrustedTypes,
} from '../trusted';
import { blobOf, PRIVATE_URL_MS, WORKER_LOADED } from '../workerBlobs';
import ProxyModule, { catchRequiredArguments } from './Proxy';
import {
	reportedLocations,
	scopePrefix,
	unrouteURL,
	type ErrorLocation,
} from './Unroute';

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
		 * The script URL a worker should really start with. A blob: URL is no
		 * request the service worker sees, so the worker starts from a small
		 * bootstrap instead: the usual worker preamble (inject, client), then
		 * the page's blob, which that import routes to the service worker to
		 * be rewritten (ObjectURL).
		 */
		/** the private URL each worker took its script from, released once it has (see workerBlobs) */
		let lastPrivate: string | undefined;
		const workerURL = (source: string, isModule: boolean): string => {
			lastPrivate = undefined;
			const url = moduleClient.encodingParse(
				source,
				moduleClient.baseURL.toString(),
			);
			const type = isModule ? 'workerModule' : 'worker';
			if (url.protocol === 'blob:') {
				// resolved now, as the browser resolves it at construction: the
				// bootstrap imports a private URL of the page's Blob, which the
				// page's revoke right after `new Worker()` does not reach
				// (workerBlobs). A URL whose Blob is not known here is imported
				// as it is
				const blob = blobOf(proxyBlobURL(url.href));
				// a classic worker of a document whose policy refuses a blob:
				// script (src/csp.ts) cannot import the page's: its Blob is the
				// bootstrap's own text, after the preamble
				const inline =
					!!blob &&
					!isModule &&
					!!(
						moduleClient as {
							browserRefuses?: (directive: string, scheme: string) => boolean;
						}
					).browserRefuses?.('script-src-elem', 'blob:');
				let script = url.href;
				// once the import is done the bootstrap says so, on a message
				// the hook below takes before any of the page's listeners
				let loaded = '';
				if (blob && !inline) {
					script = lastPrivate = proxyBlobURL(global.URL.createObjectURL(blob));
					// (a shared worker's scope has no postMessage)
					loaded = `\nif (typeof postMessage === 'function') postMessage({ [${JSON.stringify(WORKER_LOADED)}]: ${JSON.stringify(script)} });`;
				}
				// the page's URL first, so the client resolves relative URLs
				// against it rather than against the blob
				// and its partition, which the client reads before the page's
				// script runs (a routed worker's route names it)
				const partition = moduleClient.partition;
				// and its document's script policy, which a blob: worker
				// inherits (src/csp.ts ScriptFacts), and its connect policies
				// (WorkerPolicies), which judge the worker's own WebSockets and
				// WebTransport sessions
				const connect = (
					moduleClient as {
						connectInheritance?: () => WorkerPolicies | null;
					}
				).connectInheritance?.();
				const base =
					`globalThis[${JSON.stringify(WORKER_BASE)}] = ${JSON.stringify(
						moduleClient.url.toString(),
					)};` +
					(partition
						? `globalThis[${JSON.stringify(WORKER_PARTITION)}] = ${JSON.stringify(partition)};`
						: '') +
					(connect
						? `globalThis[${JSON.stringify(CSP_WORKER)}] = ${JSON.stringify(
								// (and the page's script the bootstrap imports, which no
								// policy of the worker's judges: its worker-src did)
								inline ? connect : { ...connect, script },
							)};`
						: '') +
					// (and its Trusted Types, which a worker's own code meets too)
					(moduleClient.trustedTypesRequired() && trustedTypesUsed()
						? trustedWorker(
								JSON.stringify(CSP_FACTS),
								JSON.stringify({
									evaluates: moduleClient.scriptFacts.evaluates,
									tt: useTrustedTypes(),
									rtt: moduleClient.trustedTypesRequired(),
								}),
							)
						: moduleClient.scriptFacts.evaluates
							? ''
							: `globalThis[${JSON.stringify(CSP_FACTS)}] = { evaluates: false };`);
				if (inline)
					return proxyBlobURL(
						global.URL.createObjectURL(
							new NativeBlob(
								[
									base +
										modifyJS('', moduleClient.url, moduleClient.config, type) +
										'\n',
									blob!,
								],
								{ type: 'text/javascript' },
							),
						),
					);
				// the page's script as the bootstrap loads it: routed here (the
				// load is the bootstrap's own, no code the rewriter sees), and
				// absolute, as a blob: base resolves no path
				const routed = (kind: string) =>
					new URL(
						routeURL(kind, new StompURL(pageBlobURL(script), moduleClient.url)),
						scopePrefix(moduleClient),
					).href;
				// (a name the page never learns: the client's own, extended)
				const own = `${moduleClient.names.client}_importScripts`;
				const bootstrap =
					base +
					(isModule
						? // a static import would run the page's module before this
							// module's body, which is what loads the client: imported
							// once the client is in place instead, with the messages
							// that come meanwhile held for the handlers it sets
							modifyJS('', moduleClient.url, moduleClient.config, type) +
							`\nawait ${moduleClient.names.client}.holdEvents(import(${JSON.stringify(
								routed('js:genericModule'),
							)}));` +
							loaded
						: // the browser's own importScripts, taken before the inject
							// hooks it: the page's script is the worker's own, which
							// its document's policy let start (worker-src), not a
							// script the worker imports (script-src)
							`const ${own} = self.importScripts;` +
							modifyJS('', moduleClient.url, moduleClient.config, type) +
							`\n${own}.call(self, ${JSON.stringify(routed('js:worker'))});` +
							loaded);
				// the bootstrap's own blob: URL goes to the browser, so in the
				// proxy's form (createObjectURL hands the page the page's)
				return proxyBlobURL(
					global.URL.createObjectURL(
						new NativeBlob([bootstrap], { type: 'text/javascript' }),
					),
				);
			}
			// a data: worker is rewritten here, into the data: URL it starts
			// from: it inherits its creator's connect policies (WorkerPolicies)
			const connect =
				url.protocol === 'data:'
					? (
							moduleClient as {
								connectInheritance?: () => WorkerPolicies | null;
							}
						).connectInheritance?.()
					: null;
			return routeJS(
				new StompURL(url, moduleClient.url),
				moduleClient.url,
				moduleClient.config,
				type,
				moduleClient.partition,
				connect
					? `${moduleClient.names.client}.judgeConnections(${JSON.stringify({ ...connect, named: 'data' })});`
					: '',
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

		/**
		 * A script of another real origin is refused as the browser refuses
		 * one (every route is same-origin to it, so it never does): a
		 * SecurityError naming the script and the page's origin.
		 */
		const checkOrigin = (name: string, source: string) => {
			const url = new URL(source, moduleClient.baseURL.toString());
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
		/**
		 * The worker's first listeners, before any of the page's. An error the
		 * browser located in the inject (a hook called the native API that
		 * threw) is reported on the Worker with that location, and the event
		 * there has no error object to find the page's from: the worker says
		 * where it was, in a message ahead of the report (Unroute), taken here
		 * and kept for the event's getters. A report the worker's own handler
		 * cancelled never comes, and its location is passed over.
		 */
		const watchErrors = (
			worker: Worker,
			own: string | undefined,
			script: string,
		) => {
			const located: (ErrorLocation & { message: string })[] = [];
			worker.addEventListener(
				'message',
				(event) => {
					const report = (event as MessageEvent).data?.[WORKER_ERROR];
					if (!report) return;
					event.stopImmediatePropagation();
					located.push(report);
				},
				true,
			);
			worker.addEventListener(
				'error',
				(event) => {
					const message = messageOf(event);
					const index = located.findIndex(
						(report) => report.message === message,
					);
					if (index !== -1) {
						reportedLocations.set(event, located[index]);
						located.splice(0, index + 1);
					} else {
						// a worker the page terminated says nothing more: the
						// error is its script's, at no known place
						const filename = filenameOf(event);
						if (filename && unrouteURL(moduleClient, filename) === null)
							reportedLocations.set(event, {
								routed: null,
								filename: script,
								lineno: 0,
								colno: 0,
							});
					}
					if (!terminated.has(worker)) return;
					const bundle = new URL(
						injectWorkerJS(moduleClient.url, moduleClient.config),
						moduleClient.url.directory,
					).href;
					// the browser writes the message by reading the exception's,
					// which the worker's own hooks unroute (Unroute): its private
					// URL comes in the page's form
					if (
						![bundle, own, own && pageBlobURL(own)].some(
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
						moduleClient.baseURL.toString(),
					);
					if (requestRefused(moduleClient, 'worker-src', resolved)) {
						args[0] = trustedScriptURL(
							routeRefused(new StompURL(resolved, moduleClient.url)),
						);
						return Reflect.construct(target, args, newTarget);
					}
					const url = workerURL(source, isModuleOptions(args[1]));
					args[0] = trustedScriptURL(url);
					const own = lastPrivate;
					const worker: Worker = Reflect.construct(target, args, newTarget);
					watchErrors(
						worker,
						own,
						moduleClient.encodingParse(source, moduleClient.baseURL.toString())
							.href,
					);
					moduleClient.provisionWorkerTransport(worker, blobScript(url));
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
					const url = workerURL(source, isModuleOptions(args[1]));
					args[0] = trustedScriptURL(url);
					// a shared worker has no postMessage to say it took its
					// private URL: that one goes after PRIVATE_URL_MS
					const own = lastPrivate;
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
								new URL(String(args[0]), moduleClient.baseURL.toString()),
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
