// What a Worker or SharedWorker construction does once the page's script
// passed its checks (./modules/Worker.ts): the script URL the worker starts
// with (a blob: worker's bootstrap, a data: worker rewritten in place, a
// route), and the worker's first listeners. A deferred part of the document
// bundle (./dom/deferred.ts), made at a document's first worker; the worker
// bundle's own (./workerStartParts.ts). Without it the constructor throws
// before the browser's is called.
import type { WorkerPolicies } from '../csp';
import {
	injectWorkerJS,
	pageBlobURL,
	proxyBlobURL,
	routeURL,
} from '../routeURL';
import { routeJS } from '../scriptRoutes';
import StompURL from '../StompURL';
import {
	CSP_FACTS,
	CSP_WORKER,
	WORKER_BASE,
	WORKER_PARTITION,
	workerErrorKey,
} from '../transport/messages';
import type Client from './Client';
import {
	reportedLocations,
	scopePrefix,
	unrouteURL,
	type ErrorLocation,
} from './modules/Unroute';
import type { LazyWeakSet } from './ownCollections';
import { modifyJS } from './rewriter';
import { trustedTypesUsed, trustedWorker, useTrustedTypes } from './trusted';
import { blobOf, PRIVATE_URL_MS, WORKER_LOADED } from './workerBlobs';

/** what the Worker module took at load and hands the part */
export interface WorkerStart {
	client: Client;
	global: typeof globalThis;
	/** the realm's own Blob (the bootstrap is our own code, made in it) */
	NativeBlob: typeof Blob;
	/** the workers the page terminated (the terminate hook) */
	terminated: LazyWeakSet<object>;
	/** an error event's native message and filename */
	messageOf: (event: Event) => string;
	filenameOf: (event: Event) => string;
}

/**
 * The script URL a worker should really start with. A blob: URL is no
 * request the service worker sees, so the worker starts from a small
 * bootstrap instead: the usual worker preamble (inject, client), then
 * the page's blob, which that import routes to the service worker to
 * be rewritten (ObjectURL).
 */
export function workerURL(
	start: WorkerStart,
	source: string,
	isModule: boolean,
	shared = false,
): { url: string; own?: string } {
	const { client: moduleClient, global, NativeBlob } = start;
	let lastPrivate: string | undefined;
	const url = moduleClient.encodingParse(
		source,
		moduleClient.baseURL.toString(),
	);
	const type = isModule ? 'workerModule' : 'worker';
	// a dedicated worker is as isolated as the context that starts it: one
	// of a context that is not (its shell said `n`, or it is such a worker)
	// says so in its route, or in what its bootstrap runs first, and its
	// client answers as a worker that is not isolated (WebKit and Firefox
	// isolate every worker of an isolated page: src/isolation.ts)
	const unisolated =
		!shared &&
		moduleClient.hostIsolated &&
		(
			(moduleClient as { isolationFacts?: string }).isolationFacts ??
			moduleClient.isolation ??
			''
		).includes('n');
	const preamble = unisolated
		? `${moduleClient.names.client}.notIsolated();`
		: '';
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
			return {
				url: proxyBlobURL(
					global.URL.createObjectURL(
						new NativeBlob(
							[
								base +
									modifyJS(
										'',
										moduleClient.url,
										moduleClient.config,
										type,
										preamble,
									) +
									'\n',
								blob!,
							],
							{ type: 'text/javascript' },
						),
					),
				),
			};
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
					modifyJS('', moduleClient.url, moduleClient.config, type, preamble) +
					`\nawait ${moduleClient.names.client}.holdEvents(import(${JSON.stringify(
						routed('js:genericModule'),
					)}));` +
					loaded
				: // the browser's own importScripts, taken before the inject
					// hooks it: the page's script is the worker's own, which
					// its document's policy let start (worker-src), not a
					// script the worker imports (script-src)
					`const ${own} = self.importScripts;` +
					modifyJS('', moduleClient.url, moduleClient.config, type, preamble) +
					`\n${own}.call(self, ${JSON.stringify(routed('js:worker'))});` +
					loaded);
		// the bootstrap's own blob: URL goes to the browser, so in the
		// proxy's form (createObjectURL hands the page the page's)
		return {
			url: proxyBlobURL(
				global.URL.createObjectURL(
					new NativeBlob([bootstrap], { type: 'text/javascript' }),
				),
			),
			own: lastPrivate,
		};
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
	return {
		url: routeJS(
			new StompURL(url, moduleClient.url),
			moduleClient.url,
			moduleClient.config,
			type,
			moduleClient.partition,
			preamble +
				(connect
					? `${moduleClient.names.client}.judgeConnections(${JSON.stringify({ ...connect, named: 'data' })});`
					: ''),
			unisolated,
		),
	};
}

/**
 * Release a worker's private URL when its bootstrap says it has taken
 * it. The listener is the worker's first, and capturing (a page's
 * capturing listener would run before a bubbling one), so the message
 * stops there: the page's own never see it. A worker whose script
 * failed before saying so lets it go after PRIVATE_URL_MS
 */
export function releaseOnLoad(start: WorkerStart, worker: Worker, own: string) {
	const { global } = start;
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
}

/**
 * The worker's first listeners, before any of the page's. An error the
 * browser located in the inject (a hook called the native API that
 * threw) is reported on the Worker with that location, and the event
 * there has no error object to find the page's from: the worker says
 * where it was, in a message ahead of the report (Unroute), taken here
 * and kept for the event's getters. A report the worker's own handler
 * cancelled never comes, and its location is passed over.
 */
export function watchErrors(
	start: WorkerStart,
	worker: Worker,
	own: string | undefined,
	script: string,
) {
	const { client: moduleClient, terminated, messageOf, filenameOf } = start;
	const located: (ErrorLocation & { message: string })[] = [];
	const key = workerErrorKey(moduleClient.names.globalName);
	worker.addEventListener(
		'message',
		(event) => {
			const report = (event as MessageEvent).data?.[key];
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
			const index = located.findIndex((report) => report.message === message);
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
}

/** the part's functions, as one (./workerStartParts.ts) */
export const workerStart = { workerURL, releaseOnLoad, watchErrors };
