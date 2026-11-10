import { getDomain, getPublicSuffix } from 'tldts';
import { Config, ConfigCodec } from '../config';
import { kindPartition, partitionSite } from '../partition';
import { addRouteScope } from '../routeURL';
import { SW_ROUTE, type ApiReply } from '../serviceWorkerTypes';
import {
	ABORT_REQUEST,
	BLOB_MINTED,
	BlobMintedMessage,
	CONTROLLER_CLIENT,
	CONTROLLER_CLOSE,
	CONTROLLER_INIT,
	CONTROLLER_RPC,
	Controllerbound,
	ControllerClientMessage,
	ControllerCloseMessage,
	ControllerInitMessage,
	INIT_REMOTE_TRANSPORT,
	InitRemoteTransportMessage,
	INLINE_DOCUMENT,
	InlineDocumentMessage,
	NAVIGATION_HINT,
	NavigationHintMessage,
	postToPort,
	RequestInfo,
	ServiceWorkerApiMessage,
	SW_API,
	SW_REVIVE,
	SWbound,
} from '../transport/messages';
import RemoteTransport from '../transport/RemoteTransport';
import { RpcHelper } from '../transport/rpc';
import { BUILD } from '../version';
import { recordBlobOrigin } from './blobOrigins';
import { forScript, onJarChange } from './Cookies';
import createServer, { addressCodec, StompServer } from './createServer';
import { hostErrorPage } from './errorPage';
import { INLINE_MAX, INLINE_TOKEN, putInline } from './inline';
import { recordNavigationHint } from './navigationHints';
import { RewriteCache } from './rewriteCache';
import { RewritePool } from './rewritePool';
import { abortRequest } from './rewrites';
import { ApiError, serviceWorkers, type WorkerHost } from './serviceWorkers';

interface ControllerRef {
	/** the controller's address: its scope plus its id */
	directory: string;
	config: Config;
	port: MessagePort;
	rpc: RpcHelper<SWbound, Controllerbound>;
	/** the controller's transport, over the second port or the rpc port */
	transport: RemoteTransport;
	/** the controller's rewrite workers, when it started any */
	pool?: RewritePool;
	server: Promise<StompServer>;
	ready?: StompServer;
	/**
	 * the client that registered it (the host page, or the controller frame).
	 * A document request at the address is served only while that client is
	 * fully active (not in the back/forward cache, not prerendering); the ref
	 * itself goes only when the port closes
	 */
	client?: string;
	/** the client that registered it, which alone may close it or re-point `client` */
	owner?: string;
	/** registration order: the newest live controller of a scope takes over an address whose controller is gone */
	serial: number;
	/** the emulated service workers' host in this controller, unless `serviceWorkers` is off */
	host?: WorkerHost;
}

/** the fetch-metadata site of a request from `initiator` to `url` */
function siteOf(
	initiator: string,
	url: string,
): 'same-origin' | 'same-site' | 'cross-site' {
	try {
		const from = new URL(initiator);
		const to = new URL(url);
		// schemeful same-site: ws is http, wss is https
		for (const u of [from, to])
			if (u.protocol === 'ws:') u.protocol = 'http:';
			else if (u.protocol === 'wss:') u.protocol = 'https:';
		if (from.origin === to.origin) return 'same-origin';
		if (from.protocol !== to.protocol) return 'cross-site';
		const domain = getDomain(from.hostname);
		// an IP or localhost has no registrable domain: the host itself is the site
		return (domain !== null && domain === getDomain(to.hostname)) ||
			from.hostname === to.hostname
			? 'same-site'
			: 'cross-site';
	} catch (error) {
		return 'cross-site';
	}
}

/**
 * one controller per address (`/stomp/<id>/`): the controllers of a scope
 * (two host tabs on `/stomp/`) live side by side and share the scope's
 * stores (createServer); only the same id again replaces
 */
const controllers = new Map<string, ControllerRef>();
let serials = 0;

function registerController(
	{ directory, config: given, rewritePool }: ControllerInitMessage,
	ports: MessagePort[],
	client?: string,
) {
	// the handshake's ports: the rpc's, the transport's when it lives in the
	// controller's worker, then one per rewrite worker
	const poolPorts =
		rewritePool && rewritePool.ports > 0
			? ports.splice(Math.max(1, ports.length - rewritePool.ports))
			: [];
	const [port, transportPort] = ports;
	const pool = poolPorts.length
		? new RewritePool(poolPorts, rewritePool!.timeout)
		: undefined;
	const existing = controllers.get(directory);

	if (existing) {
		// the controller hears why its calls fail before the port goes
		existing.rpc.call('replaced', undefined).catch(() => {});
		forget(existing, 'Controller replaced');
	}

	// a controller bundle from before addresses sends no scope: its directory
	// is the scope
	const config: Config = { ...given, scope: given.scope || given.directory };
	// a URL under the scope is already a route: routeURL unwraps it
	addRouteScope(location.origin, config.scope);

	// a controller whose transport lives in its worker sends a second port,
	// served from there; otherwise the transport shares the rpc port
	const transport = new RemoteTransport(transportPort ?? port);
	// the host's request log, only when it asked: one RPC per request. The
	// rpc is created below; requests only arrive once it exists
	function report(info: RequestInfo) {
		rpc.call('request', info);
	}
	const server = createServer(
		config,
		transport,
		config.requestLog ? report : undefined,
		pool,
	);

	const rpc = new RpcHelper<SWbound, Controllerbound>(
		{
			route: async (url) => [(await server).route(url), []],
			unroute: async (url) => {
				const ready = await server;
				const real = ready.realURL(url);
				return [real === url ? null : real, []];
			},
			rules: async (rules) => {
				(await server).setRules(rules);
			},
			clearCache: async () => {
				await (await server).clearCache();
			},
			cookies: async (command) => {
				const { cookies } = await server;
				switch (command.op) {
					case 'get':
						return [
							(
								await cookies.get(
									command.url,
									command.initiator
										? { site: siteOf(command.initiator, command.url) }
										: {},
								)
							).toString(),
							[],
						];
					case 'set':
						await cookies.set(command.setCookie, command.url);
						return [undefined, []];
					case 'list':
						return [await cookies.list(command.origin), []];
					case 'clear':
						await cookies.clear(command.origin);
						return [undefined, []];
				}
			},
		},
		CONTROLLER_RPC,
		(data, transfer) => postToPort(port, data, transfer),
	);

	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.start();

	const ref: ControllerRef = {
		directory,
		config,
		port,
		rpc,
		transport,
		server,
		pool,
		client,
		owner: client,
		serial: ++serials,
	};
	server.then((ready) => {
		ref.ready = ready;
		if (config.serviceWorkers !== false) ref.host = workerHost(ref, ready);
		if (config.serviceWorkerEventDelay)
			serviceWorkers.setEventDelay(config.serviceWorkerEventDelay);
	});
	controllers.set(directory, ref);
	for (const wake of [...registrationWaiters]) wake();
	// the controller's side of the port went away (it shook hands again over
	// a new channel; Chrome does not fire this when the tab itself goes, the
	// controller's close message covers that): forget it, unless the address
	// has already been taken over. Only this and the close message remove a ref
	port.addEventListener('close', () => forget(ref, 'Controller port closed'));

	server.then(
		() => rpc.call('ready', { build: BUILD }),
		(error) => console.error('Stomp: failed to create server', error),
	);
}

/**
 * What a controller does for the pages' emulated service workers
 * (docs/service-workers.md): it starts and stops their Workers, and its
 * server fetches their scripts and routes their navigations
 */
function workerHost(ref: ControllerRef, ready: StompServer): WorkerHost {
	return {
		directory: ref.directory,
		start: (id, url, type) =>
			ref.rpc.call('startServiceWorker', { id, url, type }),
		stop: (id) => {
			ref.rpc.call('stopServiceWorker', { id }).catch(() => {});
		},
		scriptRoute: (version, scriptURL) =>
			ready.routeAs(`${SW_ROUTE}:${version}`, scriptURL),
		fetchScript: (url, clientId, bypassCache) =>
			ready.router.route(
				new Request(ready.routeAs('binary', url), {
					headers: { 'service-worker': 'script' },
				}),
				{ clientId, bypassCache, internal: true },
			),
		routeDocument: (url) => ready.route(url),
		jarCookies: async (url, partitionKey) =>
			forScript(await ready.cookies.get(url, { partitionKey })),
		fetchResource: (url, init, clientId) =>
			ready.router.route(
				new Request(ready.routeAs('binary', url), {
					method: init.method,
					headers: init.headers,
				}),
				// a background fetch's download is the page's CORS request
				{ clientId, internal: true, cors: true },
			),
		timeout: ref.config.serviceWorkerTimeout,
	};
}

// a page's emulated service worker hears the jar's changes its
// registration subscribed to (registration.cookies)
onJarChange(() => serviceWorkers.cookiesChanged());

serviceWorkers.setEnvironment({
	describe(url) {
		if (!url.startsWith(`${location.origin}/`)) return null;
		const ref = controllerFor(new URL(url).pathname);
		const route = ref?.ready?.routeOf(url);
		if (!ref || !route) return null;
		try {
			const origin = new URL(route.url).origin;
			return {
				url: route.url,
				origin,
				partition: routePartition(route.resource, origin),
				resource: route.resource,
				directory: ref.directory,
			};
		} catch (error) {
			return null;
		}
	},
	host(directory) {
		const own = directory ? controllers.get(directory)?.host : undefined;
		if (own) return own;
		return [...controllers.values()]
			.filter((ref) => ref.host)
			.sort((a, b) => b.serial - a.serial)[0]?.host;
	},
});

function controllerFor(pathname: string): ControllerRef | undefined {
	let match: ControllerRef | undefined;

	for (const ref of controllers.values())
		if (
			pathname.startsWith(ref.directory) &&
			(!match || ref.directory.length > match.directory.length)
		)
			match = ref;

	return match;
}

/**
 * Whether the tab that registered `ref` is fully active right now. The
 * clients list leaves out a tab in the back/forward cache or prerendering,
 * whose port still works and which may come back, so a miss only decides
 * the document request at hand (an orphan answer), never the ref's fate;
 * a controller that registered without a client is trusted.
 */
async function alive(ref: ControllerRef): Promise<boolean> {
	if (!ref.client) return true;
	return (await self.clients.get(ref.client)) !== undefined;
}

/** the newest of `refs` whose tab is fully active, else undefined */
async function newestAlive(
	refs: ControllerRef[],
): Promise<ControllerRef | undefined> {
	for (const ref of refs) if (await alive(ref)) return ref;
	return undefined;
}

/**
 * Drop a controller: its calls and its transport's fail at once, and its
 * address is free (unless a later registration already took it over).
 */
function forget(ref: ControllerRef, reason: string) {
	serviceWorkers.dropHost(ref.directory);
	ref.rpc.abort(reason);
	ref.transport.close(reason);
	ref.pool?.close();
	ref.port.close();
	if (controllers.get(ref.directory) === ref) controllers.delete(ref.directory);
}

/** a page API call's sender: a document routed under `ref`'s address, by its real URL */
function serviceWorkerSender(
	source: Client,
	ref: ControllerRef | undefined,
): { url: string; origin: string; partition: string } | null {
	if (
		!ref?.ready ||
		!source.url.startsWith(`${location.origin}${ref.directory}`)
	)
		return null;
	const route = ref.ready.routeOf(source.url);
	if (!route || !route.resource.startsWith('html')) return null;
	try {
		const origin = new URL(route.url).origin;
		return {
			url: route.url,
			origin,
			partition: routePartition(route.resource, origin),
		};
	} catch (error) {
		return null;
	}
}

/**
 * The storage partition of a client of `origin` routed as `kind`: what its
 * route names (a nested document's top, a partitioned worker's), or for an
 * emulated service worker its registration's
 */
function routePartition(kind: string, origin: string): string {
	if (kind.startsWith('sw:'))
		return serviceWorkers.versionPartition(kind.slice(3));
	return kindPartition(kind, origin, (host) =>
		getPublicSuffix(host, { allowPrivateDomains: true }),
	);
}

/** the first segment under the scope, and the rest of the path */
const SEGMENT = /^([^/]+)\/(.+)$/;
/** the segment an address adds to its scope: a controller id */
const ID = /^[A-Za-z0-9_-]{1,32}$/;

/** the ready controllers of a scope, newest first */
function scopeControllers(scope: string): ControllerRef[] {
	return [...controllers.values()]
		.filter((ref) => ref.config.scope === scope && ref.ready)
		.sort((a, b) => b.serial - a.serial);
}

/** a routed URL whose address names no live controller, under a scope that has some */
interface Orphan {
	/** the gone controller's address; the scope itself for a URL of the shape before addresses */
	directory: string;
	/** the route under the address (`html/...`) */
	rest: string;
	/** the scope's live controllers that would route `rest`, newest first */
	candidates: ControllerRef[];
	/** a URL from before addresses (`/stomp/html/...`): no codec to match, the newest controller takes it */
	legacy?: boolean;
}

/**
 * A routed URL under a scope with live controllers, at an address that is
 * none of theirs (or is `except`'s, whose tab is not active right now): the
 * address of a controller that is gone (a closed tab, a history entry or a
 * link from one). A URL of the shape before addresses, `/stomp/html/...`,
 * is an orphan of the scope itself. Null for anything else under the scope,
 * such as its assets or the host's own files, which no controller would
 * route.
 */
function orphanOf(pathname: string, except?: ControllerRef): Orphan | null {
	const scopes = [
		...new Set([...controllers.values()].map((ref) => ref.config.scope)),
	].sort((a, b) => b.length - a.length);
	for (const scope of scopes) {
		if (!pathname.startsWith(scope)) continue;
		const match = SEGMENT.exec(pathname.slice(scope.length));
		if (!match) continue;
		const [, id, rest] = match;
		const live = scopeControllers(scope).filter((ref) => ref !== except);
		const routes = (ref: ControllerRef, path: string) =>
			ref.ready!.router.willRoute(`${location.origin}${ref.directory}${path}`);
		if (ID.test(id)) {
			const candidates = live.filter((ref) => routes(ref, rest));
			if (candidates.length)
				return { directory: `${scope}${id}/`, rest, candidates };
		}
		const legacy = live.filter((ref) => routes(ref, `${id}/${rest}`));
		if (legacy.length)
			return {
				directory: scope,
				rest: `${id}/${rest}`,
				candidates: legacy,
				legacy: true,
			};
	}
	return null;
}

/**
 * The newest live controller of the scope with the gone controller's codec
 * takes the request: a redirect to the same route at its address, so the
 * document and everything it loads run under a live address. Without one
 * (the codec is another, or this worker never served the address) the
 * host's error page answers with kind `controller`. A URL from before
 * addresses names no controller to match a codec against: the newest takes
 * it (a host has one codec in practice; another fails on decode as any bad
 * URL does).
 */
async function answerOrphan(
	request: Request,
	{ directory, rest, candidates, legacy }: Orphan,
): Promise<Response> {
	const codec = legacy ? undefined : await addressCodec(directory);
	// a controller still in the table whose tab is gone or parked cannot take
	// anything (and would send the request round in circles)
	const taker = await newestAlive(
		legacy
			? candidates
			: candidates.filter((ref) => codec && ref.config.codec === codec),
	);
	if (taker) {
		const url = new URL(request.url);
		url.pathname = `${taker.directory}${rest}`;
		return Response.redirect(url.href, 307);
	}
	const page = (await newestAlive(candidates)) ?? candidates[0];
	return orphanError(request, page.config, directory, codec);
}

/**
 * No live controller can take an address: 410 when this worker knows whose
 * it was (its codec is `codec`), 404 when it never served it. A document
 * gets the host's error page (`config.errorPage`) with kind `controller`.
 */
async function orphanError(
	request: Request,
	config: Config,
	directory: string,
	codec: ConfigCodec | undefined,
): Promise<Response> {
	const message = codec
		? `Stomp: the controller at ${directory} is gone and no live controller uses its codec (${codec})`
		: `Stomp: no controller is registered at ${directory}`;
	console.warn(message);
	const status = codec ? 410 : 404;
	if (!DOCUMENT_DESTINATIONS.has(request.destination))
		return new Response(null, { status });
	return (
		(await hostErrorPage(config, {
			url: request.url,
			status,
			error: message,
			kind: 'controller',
		})) ??
		new Response(
			`<!doctype html><title>${status}</title><h1>${status}</h1><p>${escapeHTML(message)}</p>`,
			{
				status,
				headers: { 'content-type': 'text/html; charset=utf-8' },
			},
		)
	);
}

self.addEventListener('message', (event: ExtendableMessageEvent) => {
	const { data } = event;
	if (typeof data !== 'object' || data === null) return;

	const sender = event.source instanceof Client ? event.source.id : undefined;

	if (CONTROLLER_INIT in data) {
		registerController(data[CONTROLLER_INIT], [...event.ports], sender);
	} else if (INLINE_DOCUMENT in data) {
		// only from a document of that controller (its routed URL under the
		// address), with a well-formed token and bounded markup
		const message = data[INLINE_DOCUMENT] as InlineDocumentMessage;
		const source =
			event.source instanceof Client ? event.source.url : undefined;
		if (
			!message ||
			typeof message.directory !== 'string' ||
			!controllers.has(message.directory) ||
			!source?.startsWith(`${location.origin}${message.directory}`) ||
			typeof message.token !== 'string' ||
			!INLINE_TOKEN.test(message.token) ||
			typeof message.markup !== 'string' ||
			message.markup.length > INLINE_MAX ||
			typeof message.url !== 'string'
		)
			return;
		// its partition is its creator's, read from the creator's route
		// (never from the message)
		const route = controllers.get(message.directory)?.ready?.routeOf(source);
		let partition = '';
		try {
			if (route)
				partition = routePartition(route.resource, new URL(route.url).origin);
		} catch (error) {
			// not a URL: first-party
		}
		putInline(message.token, {
			directory: message.directory,
			markup: message.markup,
			url: message.url,
			...(partition ? { partition } : {}),
		});
	} else if (BLOB_MINTED in data) {
		// from a routed document of that controller, for a blob: URL of this
		// origin; the origin recorded is the document's own real one, never
		// one the message names
		const message = data[BLOB_MINTED] as BlobMintedMessage;
		const source =
			event.source instanceof Client ? event.source.url : undefined;
		if (
			!message ||
			typeof message.directory !== 'string' ||
			typeof message.url !== 'string' ||
			message.url.length > 512 ||
			!message.url.startsWith(`blob:${location.origin}/`) ||
			!source?.startsWith(`${location.origin}${message.directory}`)
		)
			return;
		const ready = controllers.get(message.directory)?.ready;
		if (!ready) return;
		const real = ready.realURL(source);
		if (real === source) return;
		try {
			const origin = new URL(real).origin;
			// and its partition, from its route: the worker started from it
			// is in it too
			const route = ready.routeOf(source);
			recordBlobOrigin(
				message.url,
				origin,
				(event.source as Client).id,
				route ? partitionSite(routePartition(route.resource, origin)) : null,
			);
		} catch (error) {
			// not a URL: nothing to record
		}
	} else if (NAVIGATION_HINT in data) {
		// as BLOB_MINTED: from a routed document of that controller; the
		// initiator is the document's own origin, the hint is keyed by the
		// destination's real URL
		const message = data[NAVIGATION_HINT] as NavigationHintMessage;
		const source =
			event.source instanceof Client ? event.source.url : undefined;
		if (
			!message ||
			typeof message.directory !== 'string' ||
			typeof message.url !== 'string' ||
			message.url.length > 16384 ||
			!source?.startsWith(`${location.origin}${message.directory}`)
		)
			return;
		const ready = controllers.get(message.directory)?.ready;
		if (!ready) return;
		const real = ready.realURL(source);
		if (real === source) return;
		try {
			// the page's view of the destination is the real URL (the inject's
			// readback); a routed one is decoded to it
			const target = new URL(ready.realURL(message.url));
			if (!/^https?:$/.test(target.protocol)) return;
			recordNavigationHint(target.href, {
				origin: new URL(real).origin,
				activated: message.activated === true,
			});
		} catch (error) {
			// not a URL: nothing to record
		}
	} else if (SW_API in data) {
		// a page's navigator.serviceWorker: from a routed document of that
		// controller, whose site the worker reads from its own routed URL
		const message = data[SW_API] as ServiceWorkerApiMessage;
		const [reply, ...ports] = event.ports;
		const source = event.source instanceof Client ? event.source : null;
		const answer = (value: ApiReply) => {
			try {
				reply?.postMessage(value);
			} catch (error) {
				reply?.postMessage({
					error: { name: 'DataCloneError', message: String(error) },
				});
			}
		};
		const ref =
			message && typeof message.directory === 'string'
				? controllers.get(message.directory)
				: undefined;
		const described = source ? serviceWorkerSender(source, ref) : null;
		if (!reply || !ref?.host || !described || !source) {
			answer({
				error: {
					name: 'InvalidStateError',
					message: 'The document is in an invalid state.',
				},
			});
			return;
		}
		event.waitUntil(
			serviceWorkers
				.api(
					{ clientId: source.id, ...described, directory: ref.directory },
					String(message.method),
					(message.args ?? {}) as Record<string, unknown>,
					ports,
					(promise) => event.waitUntil(promise),
				)
				.then(
					(value) => answer({ value }),
					(error) =>
						answer({
							error:
								error instanceof ApiError
									? error.info
									: { name: 'TypeError', message: String(error) },
						}),
				)
				.finally(() => serviceWorkers.sweep()),
		);
	} else if (ABORT_REQUEST in data) {
		abortRequest((data as Record<string, unknown>)[ABORT_REQUEST]);
	} else if (CONTROLLER_CLOSE in data) {
		// only the tab that registered the controller may close it (a proxied
		// page is a client too, and must not be able to kill its host's)
		const { directory } = data[CONTROLLER_CLOSE] as ControllerCloseMessage;
		const ref = controllers.get(directory);
		if (ref && ref.owner === sender) forget(ref, 'Controller closed');
	} else if (CONTROLLER_CLIENT in data) {
		const { directory, client } = data[
			CONTROLLER_CLIENT
		] as ControllerClientMessage;
		// only the registering tab may re-point its own activity check (a
		// proxied page could otherwise orphan its host's address, or make
		// itself the client the close guard trusts)
		const ref = controllers.get(directory);
		if (ref && ref.owner === sender)
			ref.client = typeof client === 'string' ? client : sender;
	} else if (INIT_REMOTE_TRANSPORT in data) {
		const { directory } = data[
			INIT_REMOTE_TRANSPORT
		] as InitRemoteTransportMessage;
		const ref = controllers.get(directory);

		if (!ref) {
			console.error(`Stomp: no controller registered for ${directory}`);
			return;
		}

		const [port] = event.ports;
		ref.rpc.call('initRemoteTransport', port, [port]);
	}
});

/**
 * How long a routed request may take before the worker answers 504 instead.
 * A transport request that never settles (epoxy ignores abort) would
 * otherwise keep its fetch event, and with it this worker, alive for good,
 * and a waiting worker of a newer build could never activate. Documents and
 * media get longer; `config.fetchTimeout` overrides both (tests).
 */
const FETCH_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_LONG_MS = 120000;
const LONG_DESTINATIONS = new Set([
	'document',
	'iframe',
	'frame',
	'embed',
	'object',
	'video',
	'audio',
	'track',
]);
const DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame']);

const escapeHTML = (text: string) =>
	text.replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
	);

async function timedOut(
	request: Request,
	ms: number,
	ref: ControllerRef,
): Promise<Response> {
	const message = `Stomp: no answer for ${request.url} within ${ms / 1000} seconds`;
	console.warn(message);
	if (DOCUMENT_DESTINATIONS.has(request.destination))
		return (
			(await hostErrorPage(ref.config, {
				url: ref.ready?.realURL(request.url) ?? request.url,
				status: 504,
				error: message,
				kind: 'timeout',
			})) ??
			new Response(
				`<!doctype html><title>504</title><h1>504</h1><p>${escapeHTML(message)}</p>`,
				{
					status: 504,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				},
			)
		);
	return new Response(null, { status: 504 });
}

/** the response, or a 504 when it takes longer than the destination allows */
function bounded(
	request: Request,
	response: Promise<Response>,
	ref: ControllerRef,
): Promise<Response> {
	const ms =
		ref.config.fetchTimeout ??
		(LONG_DESTINATIONS.has(request.destination)
			? FETCH_TIMEOUT_LONG_MS
			: FETCH_TIMEOUT_MS);
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<Response>((resolve) => {
		timer = setTimeout(() => resolve(timedOut(request, ms, ref)), ms);
	});
	return Promise.race([response.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * The request through its controller. A document for a controller whose tab
 * is not active right now (in the back/forward cache, or gone without its
 * port closing yet) is answered as an orphan, so a link copied from it lands
 * on a live controller; the ref stays, since the tab may come back.
 */
async function serve(event: FetchEvent, ref: ControllerRef): Promise<Response> {
	const { request } = event;
	// a navigation has no client yet; the document it creates is the one the
	// host will hear from, so the report carries that id
	const clientId =
		request.mode === 'navigate'
			? event.resultingClientId || event.clientId
			: event.clientId;
	if (DOCUMENT_DESTINATIONS.has(request.destination) && !(await alive(ref))) {
		const orphan = orphanOf(new URL(request.url).pathname, ref);
		if (orphan) return answerOrphan(request, orphan);
		// nothing else live under the scope: the controller's own error page
		return orphanError(request, ref.config, ref.directory, ref.config.codec);
	}
	const server = ref.ready ?? (await ref.server);
	return server.router.willRoute(request.url)
		? server.router.route(request, {
				clientId,
				requestClientId: event.clientId,
				resultingClientId: event.resultingClientId,
				isReload: (event as FetchEvent & { isReload?: boolean }).isReload,
				waitUntil: (promise) => event.waitUntil(promise),
			})
		: fetch(request);
}

/** when this worker (re)started: its first moments are the revive window */
const STARTED_AT = Date.now();
/**
 * How long after the worker starts a routed request whose controller has not
 * registered yet waits for it. A restarted worker knows no controller until
 * they answer its revive (below), which takes a moment, more when the
 * controller checks first; a request in that window would otherwise fall
 * through to the host's server.
 */
const REVIVE_HOLD_MS = 3000;
/** requests waiting for a controller to register, woken by every registration */
const registrationWaiters = new Set<() => void>();

/** a routed address under this worker's scope: `<scope><id>/<route>` */
function addressShaped(pathname: string): boolean {
	const scope = new URL(self.registration.scope).pathname;
	if (!pathname.startsWith(scope)) return false;
	const match = SEGMENT.exec(pathname.slice(scope.length));
	return !!match && ID.test(match[1]);
}

/** the answer for a request whose controller is known, or null when no controller of ours takes it */
function answerFor(
	event: FetchEvent,
	pathname: string,
): Promise<Response> | null {
	const ref = controllerFor(pathname);
	if (ref) {
		// the server is still opening its databases: decide once it's up
		if (ref.ready && !ref.ready.router.willRoute(event.request.url))
			return null;
		return bounded(event.request, serve(event, ref), ref);
	}
	const orphan = orphanOf(pathname);
	return orphan ? answerOrphan(event.request, orphan) : null;
}

/**
 * A request in the revive window: held until its own controller registers
 * (another tab's registering does not count: that tab's controller would
 * take the address over as an orphan's) or the window ends, then answered
 * as it would have been, the network last
 */
async function heldForRevive(
	event: FetchEvent,
	pathname: string,
): Promise<Response> {
	const deadline = STARTED_AT + REVIVE_HOLD_MS;
	while (!controllerFor(pathname) && Date.now() < deadline)
		await new Promise<void>((resolve) => {
			const wake = () => {
				registrationWaiters.delete(wake);
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(wake, deadline - Date.now());
			registrationWaiters.add(wake);
		});
	return answerFor(event, pathname) ?? fetch(event.request);
}

self.addEventListener('fetch', (event: FetchEvent) => {
	const { pathname } = new URL(event.request.url);
	// in the revive window an address whose controller has not answered yet
	// waits for it, before another controller could take it over as an orphan
	if (
		!controllerFor(pathname) &&
		Date.now() - STARTED_AT < REVIVE_HOLD_MS &&
		addressShaped(pathname)
	) {
		event.respondWith(heldForRevive(event, pathname));
		return;
	}
	const answer = answerFor(event, pathname);
	if (answer) event.respondWith(answer);
});

self.addEventListener('install', () => {
	self.skipWaiting();
});

// a new worker is new bytes, and may be a new rewriter: what the last one
// made is dropped (the key names the build, but a build made from an
// uncommitted tree has the same name as its commit's)
self.addEventListener('activate', (event: ExtendableEvent) => {
	event.waitUntil(
		Promise.all([self.clients.claim(), new RewriteCache().clear()]),
	);
});

// This script only runs again when the worker was terminated and restarted.
// Nothing in `controllers` survived, so ask every client to re-register.
setTimeout(async () => {
	for (const client of await self.clients.matchAll({
		includeUncontrolled: true,
	}))
		client.postMessage({ [SW_REVIVE]: {} });
}, 100);
