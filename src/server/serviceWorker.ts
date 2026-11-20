import type { SiteShields } from '../blocker/types';
import { utf8Bytes } from '../byteString';
import type GenericCodec from '../Codecs';
import { assetName, Config, ConfigCodec, type BundleAsset } from '../config';
import { switchesGroup, type OpenerFacts } from '../coop';
import type { HopPolicy } from '../csp';
import { isolationResponseHeaders, SERVED_EMBEDDER_POLICY } from '../isolation';
import {
	kindPartition,
	partitionSite,
	siteOf as schemefulSite,
} from '../partition';
import {
	forgetPasskeysOf,
	passkeyCommand,
	runCeremony,
} from '../passkeys/authenticator';
import { nestedMarkOfKind, nestedTopOf } from '../rewriteHTML';
import { addRouteScope, proxyOrigins, unwrapRoute } from '../routeURL';
import { SW_ROUTE, type ApiReply } from '../serviceWorkerTypes';
import { getPublicSuffix } from '../suffix';
import HandoffTransport, {
	CONTROLLER_REPLACED,
	CONTROLLER_RETIRED,
} from '../transport/HandoffTransport';
import {
	ABORT_REQUEST,
	BLOB_MINTED,
	BlobMintedMessage,
	BLOCKER_SERVE,
	BlockerServeMessage,
	CLIENT_HINTS,
	ClientHintsReport,
	CONTROLLER_CLIENT,
	CONTROLLER_CLOSE,
	CONTROLLER_INIT,
	CONTROLLER_MODULES,
	CONTROLLER_RPC,
	Controllerbound,
	ControllerClientMessage,
	ControllerCloseMessage,
	ControllerInitMessage,
	ControllerModulesMessage,
	IMAGES_SEEN,
	INIT_PAGE_MODULES,
	INIT_REMOTE_TRANSPORT,
	InitPageModulesMessage,
	InitRemoteTransportMessage,
	INLINE_DOCUMENT,
	InlineDocumentMessage,
	LEGACY_FS_CLEARED,
	LOAD_CHANNEL,
	LoadChannelMessage,
	NAVIGATION_HINT,
	NavigationHintMessage,
	PASSKEY,
	PasskeyMessage,
	PERMISSION,
	PermissionMessage,
	postToPort,
	RequestInfo,
	ReviveMessage,
	ServiceWorkerApiMessage,
	SiteArrival,
	SRCDOC_CLAIM,
	SRCDOC_VOUCH,
	STANDBY_DECLINED,
	StandbyDeclined,
	SW_API,
	SW_REVIVE,
	SWbound,
	type SrcdocMessage,
} from '../transport/messages';
import RemoteTransport from '../transport/RemoteTransport';
import { RpcHelper } from '../transport/rpc';
import { BUILD, DOCUMENT, DOCUMENT_FULL, REWRITE_GENERATION } from '../version';
import {
	isLinkRoute,
	makesSelfLink,
	sameContext,
	selfContext,
	type VisitedContext,
} from '../visited';
import { suffixListPin } from '../wasm/suffix';
import {
	adoptModules,
	heldModules,
	modulesComing,
	SERVING_MEMORY_LIMIT,
	setMemoryLimit,
} from '../wasm/thread';
import { allowApartAgent, apartClient } from './apartAgent';
import { knownOriginOf, knownTopSiteOf, recordBlobOrigin } from './blobOrigins';
import { Blocker, heardBlockerBytes } from './blocker';
import { memoryCache } from './cache';
import { legacyFileSystemCleared } from './clearSiteData';
import {
	hintsDocument,
	recordReport as recordClientHintsReport,
} from './clientHints';
import { forScript, jarWrittenElsewhere, onJarChange } from './Cookies';
import createServer, {
	addressCodec,
	addressHub,
	openDatabasesEarly,
	publicSuffix,
	slotHome,
	StompServer,
} from './createServer';
import { hostErrorPage } from './errorPage';
import { identityDone, identityState } from './identityStates';
import { INLINE_MAX, INLINE_TOKEN, putInline } from './inline';
import { openLoadChannel, servedLoadClient } from './loadGrants';
import {
	awaitNavigationHintPeek,
	noteHostNavigation,
	peekNavigationHint,
	recordNavigationChain,
	recordNavigationHint,
} from './navigationHints';
import { passkeyCeremony } from './passkeys';
import {
	decide,
	deviceOp,
	deviceSalt,
	documentStates,
	forgetDeviceIds,
	settle,
	SIMULATED_PERMISSIONS,
} from './permissions';
import { RemoteBlocker, serveBlocker } from './remoteBlocker';
import {
	goneClients,
	noteBlobWorker,
	noteRequestClients,
	requestOwner,
} from './requestClients';
import { RewriteCache } from './rewriteCache';
import { RewritePool } from './rewritePool';
import {
	abortRequest,
	blobResponses,
	bundleRequested,
	departingMixedContent,
	imagesSeen,
	noteRequest,
	siteArrived,
	siteBetween,
	siteDeparture,
} from './rewrites';
import { ApiError, serviceWorkers, type WorkerHost } from './serviceWorkers';
import { contextArrived, contextDeparture } from './siteContext';
import { claim, vouch } from './srcdocVouches';
import {
	rememberVisitedHop,
	takeVisitedHop,
	visitedArrived,
	type VisitedHop,
} from './visitedHops';

interface ControllerRef {
	/** the controller's address: its scope plus its id */
	directory: string;
	config: Config;
	port: MessagePort;
	rpc: RpcHelper<SWbound, Controllerbound>;
	/** the controller's transport, over the second port or the rpc port */
	transport: HandoffTransport;
	/**
	 * the StompController instance that registered it (its handshakes all
	 * name it): a handshake that names it again is that controller over a
	 * new channel, never another controller taking the address
	 */
	token?: string;
	/** let go of: what was in flight on it is answered, then it closes (drainController) */
	draining?: boolean;
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
	/**
	 * the site pool (src/controller/sitePool.ts): this origin is a slot, and
	 * these are the slots of the sites this worker asked about (a site keeps
	 * its slot)
	 */
	slots?: Map<string, string>;
	/** this origin is a slot of the site pool (its documents ask for an agent cluster of their own) */
	slot?: boolean;
	/** lets go of the wait for the modules its handshake's port brings (portModules) */
	dropModules?: () => void;
}

/**
 * The fetch-metadata site of a request from `initiator` to `url`, which a
 * page's WebSocket handshake takes its SameSite cookies by: decided as for
 * a fetch (siteBetween)
 */
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
		return siteBetween(from, to);
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

// this thread rewrites a site's scripts whenever no rewrite worker does:
// its instances keep what a large one needed for the next
setMemoryLimit(SERVING_MEMORY_LIMIT);

let serials = 0;

/**
 * the least a slot of the site pool keeps of its rewriter instance's memory
 * between documents (SERVING_MEMORY_LIMIT shared out): a document of 500 KB
 * or so, past which an instance is made again for each one
 */
const SLOT_MEMORY_LIMIT = 16 * 1024 * 1024;

/**
 * a slot of the site pool: each hub's worker's blocker, by the
 * controller's address (two hubs may name other lists), asked over the
 * newest handshake's port
 */
const remoteBlockers = new Map<string, RemoteBlocker>();

/** the time a handshake's modules get to follow on its port (ControllerInitMessage.modulesOnPort) */
const PORT_MODULES_MS = 10000;
/**
 * The modules a handshake's port brings first (a CONTROLLER_MODULES),
 * adopted as the handshake's own are (heldModules waits for them);
 * nothing when the port closes or brings none in PORT_MODULES_MS. The
 * function returned lets the wait go when this worker closes the port
 * itself (forget): a port closed at this end hears no close, and a
 * registration replaced at once kept the blocker's first build waiting
 */
function portModules(port: MessagePort): () => void {
	let drop = () => {};
	const adopted = new Promise<void>((resolve) => {
		const stop = () => {
			port.removeEventListener('message', take);
			port.removeEventListener('close', none);
			clearTimeout(timer);
		};
		const none = () => {
			stop();
			resolve();
		};
		const take = (event: MessageEvent) => {
			const message = (event.data as Record<string, unknown> | null)?.[
				CONTROLLER_MODULES
			] as ControllerModulesMessage | undefined;
			if (typeof message?.modules !== 'object' || message.modules === null)
				return;
			stop();
			heardBlockerBytes(message.modules);
			resolve(adoptModules(message.modules));
		};
		const timer = setTimeout(none, PORT_MODULES_MS);
		port.addEventListener('message', take);
		port.addEventListener('close', none);
		drop = none;
	});
	modulesComing(adopted);
	return drop;
}

function registerController(
	{
		directory,
		config: given,
		rewritePool,
		modules,
		modulesOnPort,
		adblock,
		standby,
		codecKey,
		slot,
		slots,
		pooled,
		token,
	}: ControllerInitMessage,
	ports: MessagePort[],
	client?: string,
) {
	// an offer for a worker that lost this controller: this one has it. It
	// says so before the ports go, so the controller lets its end go at once
	// and knows this run is up (it offers no other for a while)
	if (standby && controllers.has(directory)) {
		ports[0]?.postMessage({
			[STANDBY_DECLINED]: { instance: INSTANCE } satisfies StandbyDeclined,
		});
		for (const port of ports) port.close();
		return;
	}
	// the controller's wasm modules, for this thread (src/wasm/thread.ts):
	// compiled behind the handshake, the JavaScript rewriters answer until then
	heardBlockerBytes(modules);
	void adoptModules(modules);
	const dropModules =
		modulesOnPort && ports[0] ? portModules(ports[0]) : undefined;
	// the handshake's ports: the rpc's, the transport's when it lives in the
	// controller's worker, then one per rewrite worker
	const poolPorts =
		rewritePool && rewritePool.ports > 0
			? ports.splice(Math.max(1, ports.length - rewritePool.ports))
			: [];
	// (a slot of the site pool: then the host's cookie jar's and the hub's
	// blocker's)
	const [port, transportPort, jarPort, blockerPort] = ports;
	// the slots' workers write the hub's jar through its jar server
	if (slot || pooled) jarWrittenElsewhere();
	// the pool's workers share one process: each slot keeps its share of
	// the memory cache's budget, and of the memory its rewriter's instance
	// keeps between documents (at least SLOT_MEMORY_LIMIT)
	if (slot) {
		memoryCache.share(slots ?? 1);
		setMemoryLimit(
			Math.max(
				SLOT_MEMORY_LIMIT,
				Math.floor(SERVING_MEMORY_LIMIT / Math.max(1, slots ?? 1)),
			),
		);
	}
	let remoteBlocker: RemoteBlocker | undefined;
	if (slot && blockerPort) {
		remoteBlocker = remoteBlockers.get(directory) ?? new RemoteBlocker();
		remoteBlockers.set(directory, remoteBlocker);
		remoteBlocker.bind(blockerPort);
	}
	const pool = poolPorts.length
		? new RewritePool(poolPorts, rewritePool!.timeout)
		: undefined;
	const existing = controllers.get(directory);

	if (
		existing &&
		token !== undefined &&
		existing.token === token &&
		existing.owner === client
	) {
		// the same controller shaking hands again (a rebind, a revive it could
		// not place, a standby offer taken while its handshake was on the
		// way): what is in flight on the channel it had is answered there.
		// Its emulated service workers are started again (it stopped them)
		serviceWorkers.dropHost(directory);
		drainController(existing);
	} else if (existing) {
		// another controller takes the address. It hears why its calls fail
		// before the port goes; what was in flight on its transport is sent
		// again through this one where that is safe (HandoffTransport)
		existing.rpc.call('replaced', undefined).catch(() => {});
		forget(existing, CONTROLLER_REPLACED);
	}

	// a controller bundle from before addresses sends no scope: its directory
	// is the scope
	const config: Config = { ...given, scope: given.scope || given.directory };
	// a URL under the scope is already a route: routeURL unwraps it
	addRouteScope(location.origin, config.scope);
	// the site pool: the hub's and every slot's origin are the proxy's too
	for (const origin of proxyOrigins(config))
		addRouteScope(origin, config.scope);

	// a controller whose transport lives in its worker sends a second port,
	// served from there; otherwise the transport shares the rpc port
	const transport = new HandoffTransport(
		new RemoteTransport(transportPort ?? port),
		async () => {
			// the registration at the address now, when it is another one
			// (another controller, or this one over a new channel) that reads
			// its routes as this one did
			const now = controllers.get(directory);
			if (!now || now === ref || now.config.codec !== config.codec)
				return undefined;
			await now.server;
			return now.transport;
		},
	);
	// the host's request log, only when it asked: one RPC per request. The
	// rpc is created below; requests only arrive once it exists
	function report(info: RequestInfo) {
		// a worker's request names the document that made the worker
		const send = (owner?: string) =>
			rpc.call('request', owner ? { ...info, owner } : info);
		const owner = info.client ? requestOwner(info.client) : undefined;
		if (owner instanceof Promise) owner.then(send, () => send());
		else send(owner);
	}
	const server = createServer(
		config,
		transport,
		config.requestLog ? report : undefined,
		pool,
		adblock,
		codecKey,
		slot && jarPort
			? {
					port: jarPort,
					// the agent that shook hands (its tab may close before an older one)
					alive: () =>
						client
							? self.clients.get(client).then((found) => found !== undefined)
							: Promise.resolve(true),
				}
			: undefined,
		remoteBlocker,
		// (the rpc is made below; nothing asks before a request arrives)
		() => rpc.call('isolationEngine', undefined),
		() => rpc.call('blobProbe', undefined),
		(client) => void rpc.call('isolationWanted', client).catch(() => {}),
		() => void rpc.call('apartServed', undefined).catch(() => {}),
	);

	const rpc = new RpcHelper<SWbound, Controllerbound>(
		{
			codecKey: async () => [(await server).codecKey, []],
			siteOf: async (url) => [schemefulSite(url, publicSuffix), []],
			arrive: async (arrival) => {
				expectArrival(arrival);
			},
			route: async (url) => [(await server).route(url), []],
			typed: async (routed) => {
				noteHostNavigation((await server).realURL(routed));
			},
			unroute: async (url) => {
				const ready = await server;
				const real = ready.realURL(url);
				return [real === url ? null : real, []];
			},
			rules: async (rules) => {
				(await server).setRules(rules);
			},
			apartAgent: async ({ token, script }) => {
				allowApartAgent(token, script);
			},
			clearCache: async () => {
				await (await server).clearCache();
			},
			forgetDeviceIds: async (origin) => {
				let host: string | undefined;
				try {
					if (origin) host = new URL(origin).hostname;
				} catch (error) {
					return;
				}
				await forgetDeviceIds(host);
			},
			shields: async (payload) => {
				// the controller sends { list, seed }; an array is the legacy
				// list-only shape (and the remote controller's frame hop)
				const { list, seed } = Array.isArray(payload)
					? { list: payload, seed: undefined }
					: (payload as { list: SiteShields[]; seed?: number });
				(await server).setShields(list, seed);
			},
			adblock: async ({ init, refresh }) => {
				await (await server).reloadBlocker(init, !!refresh);
			},
			forgetStorage: async (origin) => {
				await (await server).forgetStorage(origin);
				// a site's passkeys are its data too (docs/passkeys.md)
				try {
					await forgetPasskeysOf(new URL(origin).hostname);
				} catch (error) {
					// not an origin, or no store
				}
			},
			passkeys: async (command) => [await passkeyCommand(command), []],
			modules: async () => [await heldModules(), []],
			suffixList: async () => {
				await heldModules();
				return [suffixListPin(), []];
			},
			socket: async ({ url, source, type }) => {
				// a WebSocket never passes this worker: the controller asks from
				// its handshake hook and refuses the socket on a yes
				// a WebSocket the site's shields let through (shields down, or the
				// blocker in "allow all") is not refused; a host with no entry is
				// checked as before. The Origin the handshake carries is the host
				const srv = await server;
				let socketHost: string;
				try {
					socketHost = source ? new URL(source).hostname : '';
				} catch (error) {
					socketHost = '';
				}
				// the extensions' rules (src/server/dnr.ts) first: the site's
				// shields are the built-in blocker's, not theirs
				const ruled = srv.dnr.socketBlocked(url, source, type);
				const blocked =
					!!ruled ||
					(srv.shields.blocks(socketHost) &&
						!!(await srv.blocker?.socket(url, source, type)));
				if (blocked && config.requestLog)
					report({
						url,
						method: type ? 'CONNECT' : 'GET',
						destination: type ?? 'websocket',
						status: 0,
						ms: 0,
						cached: false,
						bytes: null,
						error: ruled?.action
							? `blocked by extension ${ruled.action.extensionId}, rule ${ruled.action.ruleId}`
							: 'blocked by the content blocker',
						kind: 'blocked',
					});
				return [blocked, []];
			},
			hostReload: async (mode) => {
				(await server).hostReloaded(mode);
			},
			historyStep: async (url) => {
				if (typeof url === 'string') (await server).historyStepped(url);
			},
			// the controller shook hands again (with this worker or another):
			// this channel answers what is in flight on it, then closes
			retire: async () => {
				drainController(ref);
			},
			goneClients: async (asked) => {
				const gone = Array.isArray(asked) ? await goneClients(asked) : [];
				// (a gone document's frame no longer holds allowAllRequests)
				if (gone.length) {
					const { dnr } = await server;
					for (const id of gone) dnr.forgetClient(id);
				}
				return [gone, []];
			},
			dnr: async (command) => [await (await server).dnr.command(command), []],
			cookies: async (command) => {
				const { cookies } = await server;
				switch (command.op) {
					case 'get': {
						const jar = await cookies.get(
							command.url,
							// a context in a partition is another site's to the jar,
							// as its document.cookie is
							command.partitionKey !== undefined
								? {
										site: 'cross-site',
										partitionKey: command.partitionKey,
									}
								: command.initiator
									? { site: siteOf(command.initiator, command.url) }
									: {},
						);
						// a handshake's Cookie field is bytes, as a request's is
						return [command.header ? jar.header() : jar.toString(), []];
					}
					case 'set':
						// the host's Set-Cookie is text, where a response's is
						// bytes (Cookies.ts parseCookie): as its UTF-8 bytes
						await cookies.set(
							typeof command.setCookie === 'string'
								? utf8Bytes(command.setCookie)
								: command.setCookie.map(utf8Bytes),
							command.url,
						);
						return [undefined, []];
					case 'list':
						return [await cookies.list(command.origin), []];
					case 'clear': {
						await cookies.clear(command.origin);
						// the device ids of the host's origins go with its cookies
						let host: string | undefined;
						try {
							if (command.origin) host = new URL(command.origin).hostname;
						} catch (error) {
							// not a URL: the jar refused it above
						}
						await forgetDeviceIds(host);
						return [undefined, []];
					}
				}
			},
		},
		CONTROLLER_RPC,
		(data, transfer) => postToPort(port, data, transfer),
	);

	port.addEventListener('message', (event) => rpc.receive(event.data));
	// a slot: a port of the hub's blocker that closed is asked for again
	if (remoteBlocker)
		remoteBlocker.renew = () => rpc.call('blockerPort', undefined);
	port.start();
	// which run of the worker has this controller: its revive, on its way or
	// still to come, is not for it (a controller of an earlier build has no
	// such method and checks over the port instead)
	rpc
		.call('hello', {
			instance: INSTANCE,
			...(modulesOnPort ? { portModules: true } : {}),
		})
		.catch(() => {});

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
		...(token !== undefined ? { token } : {}),
		serial: ++serials,
		...(dropModules ? { dropModules } : {}),
		// a slot's worker, or the hub's (whose documents of a site with a
		// slot leave for it too)
		...(slot || pooled ? { slots: new Map<string, string>() } : {}),
		...(slot ? { slot: true } : {}),
	};
	server.then((ready) => {
		ref.ready = ready;
		if (config.serviceWorkers !== false) ref.host = workerHost(ref, ready);
		if (config.serviceWorkerEventDelay)
			serviceWorkers.setEventDelay(config.serviceWorkerEventDelay);
	});
	controllers.set(directory, ref);
	closed.delete(directory);
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
		// a worker in a partition reads the jar as another site's
		jarCookies: async (url, partitionKey) =>
			forScript(
				await ready.cookies.get(
					url,
					partitionKey === undefined
						? {}
						: { partitionKey, site: 'cross-site' },
				),
			),
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
				partition: routePartition(route.resource, origin, route.codec),
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
	// a registration a later one took over has no say in the address's
	// emulated service workers any more
	if (controllers.get(ref.directory) === ref) {
		serviceWorkers.dropHost(ref.directory);
		controllers.delete(ref.directory);
	}
	ref.rpc.abort(reason);
	ref.transport.close(reason);
	ref.pool?.close();
	ref.dropModules?.();
	ref.port.close();
}

/**
 * The controllers whose tab said it is going (CONTROLLER_CLOSE), by
 * address, for CLOSED_MS. Chrome runs the host page's pagehide before its
 * frames', so what a proxied document asks as it unloads comes after the
 * close: a page's storage read in its pagehide (Twitch's) found no
 * controller, went to the host's server and spun to the bridge's 10 s limit,
 * on the renderer the reloaded host page needed to commit (a reload, a hard
 * one most often, waited 10 s with nothing on screen), and its writes there
 * were lost. A document's request at such an address is still answered by
 * its controller's server, whose transport is closed: what needs the
 * network fails at once. A navigation to it is an orphan's, as before.
 */
const closed = new Map<string, ControllerRef>();
const CLOSED_MS = 15000;

function closeController(ref: ControllerRef) {
	forget(ref, 'Controller closed');
	closed.set(ref.directory, ref);
	setTimeout(() => {
		if (closed.get(ref.directory) === ref) closed.delete(ref.directory);
	}, CLOSED_MS);
}

/** the closed controller that still answers a document's `request` at `pathname` (closed) */
function closedFor(
	request: Request,
	pathname: string,
): ControllerRef | undefined {
	if (request.mode === 'navigate') return undefined;
	for (const ref of closed.values())
		if (pathname.startsWith(ref.directory)) return ref;
	return undefined;
}

/** the longest a registration being let go keeps a request in flight waiting before it closes */
const DRAIN_MS = 60000;

/**
 * Let go of a registration its own controller replaced with a new channel:
 * the requests and calls in flight on it get their answers there (a
 * navigation, a long poll, a permission prompt), and once nothing waits on
 * it, or after DRAIN_MS, it is forgotten. It used to be forgotten at once,
 * which failed all of them: the page's fetches, and a navigation as the
 * host's error page (502, "Controller replaced").
 */
function drainController(ref: ControllerRef) {
	if (ref.draining) return;
	ref.draining = true;
	const sleep = (ms: number) =>
		new Promise<void>((wake) => setTimeout(wake, ms));
	void (async () => {
		await Promise.race([
			Promise.all([ref.transport.settled(), ref.rpc.settled()]),
			sleep(DRAIN_MS),
		]);
		// told by the controller over the old channel (`retire`) before its
		// new handshake reached this worker, or with no new handshake here
		// at all (it went to the worker that replaced this one): the address
		// stays served a moment longer, never an orphan in between
		if (controllers.get(ref.directory) === ref) await sleep(RETIRE_GRACE_MS);
		forget(ref, CONTROLLER_RETIRED);
	})();
}
/** how long a registration that is let go keeps its address when no new handshake took it */
const RETIRE_GRACE_MS = 5000;

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
			partition: routePartition(route.resource, origin, route.codec),
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
function routePartition(
	kind: string,
	origin: string,
	codec: GenericCodec,
): string {
	if (kind.startsWith('sw:'))
		return serviceWorkers.versionPartition(kind.slice(3));
	return kindPartition(
		kind,
		origin,
		(host) => getPublicSuffix(host, true),
		codec,
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

/** the address (`directory`) a page's message names, if it names one */
function addressNamed(data: Record<string, unknown>): string | null {
	for (const value of Object.values(data)) {
		const directory =
			typeof value === 'object' && value !== null
				? (value as { directory?: unknown }).directory
				: undefined;
		if (typeof directory === 'string') return directory;
	}
	return null;
}

self.addEventListener('message', (event: ExtendableMessageEvent) => {
	const { data } = event;
	if (typeof data !== 'object' || data === null) return;
	// In the revive window a page's message for an address whose controller
	// has not registered yet waits for it, as a request does: a worker the
	// browser stopped and a page's message started again knows no controller,
	// and what it dropped then never came (the transport port of the first
	// WebSocket a page opens after sitting idle, an inline document, a
	// blob: URL). A controller's own messages are for now
	const address =
		CONTROLLER_INIT in data ||
		CONTROLLER_CLOSE in data ||
		CONTROLLER_CLIENT in data
			? null
			: addressNamed(data as Record<string, unknown>);
	if (
		address !== null &&
		!controllers.has(address) &&
		Date.now() - reviveFrom < REVIVE_HOLD_MS
	) {
		event.waitUntil(
			registered(() => controllers.has(address)).then(() =>
				handleMessage(event),
			),
		);
		return;
	}
	handleMessage(event);
});

function handleMessage(event: ExtendableMessageEvent) {
	const data = event.data as Record<string, any>;

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
			typeof message.url !== 'string' ||
			// a Blob, or a blob: URL of this origin (read here, never fetched
			// elsewhere)
			(message.blob !== undefined &&
				!(message.blob instanceof Blob) &&
				!(
					typeof message.blob === 'string' &&
					message.blob.length <= 512 &&
					message.blob.startsWith(`blob:${location.origin}/`)
				))
		)
			return;
		// its partition is its creator's, read from the creator's route
		// (never from the message, but for a first-party creator's `^`,
		// LoadGrantMessage)
		const route = controllers.get(message.directory)?.ready?.routeOf(source);
		let partition = '';
		try {
			if (route) {
				const origin = new URL(route.url).origin;
				partition = routePartition(route.resource, origin, route.codec);
				if (message.cross === true && partition === '')
					partition = `^${schemefulSite(origin, publicSuffix)}`;
			}
		} catch (error) {
			// not a URL: first-party
		}
		putInline(message.token, {
			directory: message.directory,
			markup: message.markup,
			url: message.url,
			...(message.blob
				? { blob: message.blob, client: (event.source as Client).id }
				: {}),
			...(message.blob && message.isolated === true ? { isolated: true } : {}),
			// (its creator is in the cluster the proxy's Document-Isolation-Policy
			// isolates: so is it)
			...(apartClient((event.source as Client).id) ? { apart: true } : {}),
			...(partition ? { partition } : {}),
		});
	} else if (LOAD_CHANNEL in data) {
		// a window's load channel (loadGrants.ts): from a routed document
		// of that controller. The first one a client opens when this worker
		// served its document (its inject ran before anything of the
		// page's), else the one that answers the worker's challenge
		const message = data[LOAD_CHANNEL] as LoadChannelMessage;
		const source = event.source instanceof Client ? event.source : null;
		const [port] = event.ports;
		if (
			!port ||
			!message ||
			typeof message.directory !== 'string' ||
			!controllers.has(message.directory) ||
			!source ||
			source.type !== 'window' ||
			!source.url.startsWith(`${location.origin}${message.directory}`)
		) {
			port?.close();
			return;
		}
		openLoadChannel(source.id, port, message.answer);
	} else if (SRCDOC_VOUCH in data) {
		// from a routed document of that controller: the srcdoc document
		// under it is of its real origin and partition, read from its own
		// route (an inline document's from what the worker recorded when it
		// served it: its route names its referrer, and a data: document is of
		// no origin a srcdoc document under it could be bound as)
		const message = data[SRCDOC_VOUCH] as SrcdocMessage;
		const source =
			event.source instanceof Client ? event.source.url : undefined;
		if (
			!message ||
			typeof message.directory !== 'string' ||
			typeof message.token !== 'string' ||
			!INLINE_TOKEN.test(message.token) ||
			!source?.startsWith(`${location.origin}${message.directory}`)
		)
			return;
		const ready = controllers.get(message.directory)?.ready;
		const route = ready?.routeOf(source);
		if (!ready || !route) return;
		const inline = source.startsWith(
			`${location.origin}${message.directory}inline:`,
		);
		event.waitUntil(
			(async () => {
				try {
					const origin = inline
						? (await knownOriginOf(source))?.origin
						: new URL(ready.realURL(source)).origin;
					if (!origin || origin === 'null') return;
					vouch(message.token, {
						origin,
						top: inline
							? await knownTopSiteOf(source)
							: partitionSite(
									routePartition(route.resource, origin, route.codec),
								),
					});
				} catch (error) {
					// not a URL: no vouch
				}
			})(),
		);
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
			const partition = route
				? routePartition(route.resource, origin, route.codec)
				: null;
			recordBlobOrigin(
				message.url,
				origin,
				(event.source as Client).id,
				// (one a document the client's realm made minted, in the
				// partition a load grant's `^` names: only from a first-party one)
				message.cross === true && partition === ''
					? schemefulSite(origin, publicSuffix)
					: partition === null
						? null
						: partitionSite(partition),
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
			const csp =
				message.coopOnly !== true &&
				message.csp &&
				Array.isArray(message.csp.policies) &&
				message.csp.policies.length <= 32 &&
				JSON.stringify(message.csp).length <= 65536
					? message.csp
					: undefined;
			// a top-level navigation's opener policy facts (src/coop.ts)
			const coop = message.coop;
			const opener: OpenerFacts | undefined =
				Array.isArray(coop) &&
				coop.length === 4 &&
				typeof coop[0] === 'boolean' &&
				coop
					.slice(1)
					.every((part) => typeof part === 'string' && part.length <= 2048)
					? (coop as OpenerFacts)
					: undefined;
			if (csp || opener)
				recordNavigationChain(
					target.href,
					(csp?.policies ?? []).filter(
						(policy): policy is HopPolicy =>
							Array.isArray(policy) &&
							typeof policy[0] === 'string' &&
							Array.isArray(policy[1]) &&
							policy[1].every((source) => typeof source === 'string') &&
							(policy[2] === 'enforce' || policy[2] === 'report') &&
							typeof policy[3] === 'string',
					),
					Array.isArray(csp?.ancestors) &&
						csp.ancestors.every((origin) => typeof origin === 'string')
						? csp.ancestors
						: undefined,
					(event.source as Client).id,
					csp?.parent === true,
					typeof csp?.required === 'string' && csp.required.length <= 4096
						? csp.required
						: undefined,
					opener,
				);
			// carried by another site's document: the window's facts only
			if (message.coopOnly === true) return;
			recordNavigationHint(target.href, {
				origin: new URL(real).origin,
				activated: message.activated === true,
				...(typeof message.allow === 'string' && message.allow.length <= 4096
					? { allow: message.allow }
					: {}),
				directory: message.directory,
				nested: typeof message.nested === 'string' ? message.nested : false,
				own: message.own !== false,
			});
		} catch (error) {
			// not a URL: nothing to record
		}
	} else if (PERMISSION in data) {
		// from a routed document of that controller: its site is the proxied
		// top's real origin, read from its own routed URL (a frame's route
		// names its top), and its policy is the one the worker recorded
		const message = data[PERMISSION] as PermissionMessage;
		const [reply] = event.ports;
		const source = event.source instanceof Client ? event.source : null;
		const ref =
			message && typeof message.directory === 'string'
				? controllers.get(message.directory)
				: undefined;
		const ready = ref?.ready;
		if (
			!reply ||
			!ref ||
			!ready ||
			!source?.url.startsWith(`${location.origin}${ref.directory}`)
		) {
			reply?.postMessage(null);
			return;
		}
		const real = ready.realURL(source.url);
		let site: string;
		try {
			site =
				nestedTopOf(new URL(source.url).pathname, ref.directory, ready.codec) ??
				new URL(real).origin;
		} catch (error) {
			reply.postMessage(null);
			return;
		}
		const name = 'name' in message ? String(message.name) : '';
		const work = (async () => {
			if (message.op === 'states')
				return documentStates(site, hintsDocument(source.id, source.url));
			// the document's own origin, not its top's: an origin's ids are
			// the same in any top-level site
			if (message.op === 'deviceSalt') return deviceSalt(new URL(real).origin);
			// the controller's document asks the browser (mediaVerdict.ts); no
			// answer in time is no verdict
			if (message.op === 'media')
				return Promise.race([
					ref.rpc.call('mediaVerdict', message.constraints),
					new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
				]);
			// FedCM (src/server/identityStates.ts): the document's own origin
			// is the relying party, under its top
			if (
				message.op === 'identity' ||
				message.op === 'identityDone' ||
				message.op === 'identityChooser'
			) {
				const rp = new URL(real).origin;
				const idp = String(message.idp);
				if (message.op === 'identity')
					return identityState(site, rp, idp, ref.config.fedcmTesting === true);
				if (message.op === 'identityDone')
					return identityDone(site, rp, message);
				// the host's page draws the chooser over the document's frame;
				// the port tells it the document went away, or a message on
				// it that the request ended (its signal aborted: Chrome fires
				// no close event for a port closed)
				const gone = new MessageChannel();
				reply.addEventListener('close', () => gone.port1.close());
				reply.addEventListener('message', () => gone.port1.postMessage(null));
				reply.start();
				const name = (origin: string) => {
					try {
						return new URL(origin).host;
					} catch (error) {
						return origin;
					}
				};
				return ref.rpc.call(
					'identityChooser',
					{
						request: {
							client: source.id,
							site: name(site),
							idp: name(idp),
							accounts: (Array.isArray(message.accounts)
								? message.accounts.slice(0, 64)
								: []
							).map((account) => {
								const text = (value: unknown) =>
									typeof value === 'string' ? value.slice(0, 1024) : '';
								const link = (value: unknown) => {
									try {
										const url = new URL(text(value));
										return /^https?:$/.test(url.protocol)
											? url.href
											: undefined;
									} catch (error) {
										return undefined;
									}
								};
								return {
									name: text(account?.name),
									email: text(account?.email),
									signUp: account?.signUp === true,
									privacyPolicy: link(account?.privacyPolicy),
									termsOfService: link(account?.termsOfService),
								};
							}),
						},
						port: gone.port2,
					},
					[gone.port2],
				);
			}
			const devices = deviceOp(site, message);
			if (devices) return devices;
			if (!SIMULATED_PERMISSIONS.includes(name)) return null;
			if (message.op === 'request')
				return decide(
					site,
					name,
					message.real === 'granted' || message.real === 'denied'
						? message.real
						: 'prompt',
					() =>
						ref.rpc.call('permission', {
							origin: site,
							permission: name,
							client: source.id,
						}),
				);
			if (message.op === 'result')
				await settle(
					site,
					name,
					String(message.token),
					message.state === 'granted' || message.state === 'denied'
						? message.state
						: 'prompt',
				);
			return null;
		})();
		event.waitUntil(
			work.then(
				(value) => reply.postMessage(value),
				() => reply.postMessage(null),
			),
		);
	} else if (PASSKEY in data) {
		// from a routed document of that controller, whose host asks the
		// user about passkeys: who asks is read from the sender
		// (src/server/passkeys.ts), never from the message
		const message = data[PASSKEY] as PasskeyMessage;
		const [reply] = event.ports;
		const source = event.source instanceof Client ? event.source : null;
		const ref =
			message && typeof message.directory === 'string'
				? controllers.get(message.directory)
				: undefined;
		const ready = ref?.ready;
		if (
			!reply ||
			!ref ||
			!ready ||
			!ref.config.passkeys ||
			!source?.url.startsWith(`${location.origin}${ref.directory}`)
		) {
			// nobody to ask: the port closes, and the page's request ends
			reply?.close();
			return;
		}
		const real = ready.realURL(source.url);
		const work = (async () => {
			const top =
				nestedTopOf(new URL(source.url).pathname, ref.directory, ready.codec) ??
				new URL(real).origin;
			const ceremony = await passkeyCeremony(
				message,
				real,
				top,
				hintsDocument(source.id, source.url),
				source.id,
				ref.transport,
			);
			if ('error' in ceremony || !('type' in ceremony))
				return reply.postMessage(ceremony);
			// this worker makes and signs; the host only asks the user, and
			// the event lives until it is asked: the user may take minutes,
			// which the controller's keepalive covers
			await runCeremony(
				{
					config: ref.config.passkeys!,
					prompt: (request, cancel) =>
						ref.rpc.call('passkeyPrompt', { request, port: cancel }, [cancel]),
					// Chrome asks whether the tab is in front, not the frame: a
					// frame that is not focused itself asks while the focus is
					// in its top's document or another frame under that top
					focused: async () => {
						const windows = await self.clients.matchAll({ type: 'window' });
						const here = windows.some((client) => {
							if (
								!(client instanceof WindowClient) ||
								!client.focused ||
								!client.url.startsWith(`${location.origin}${ref.directory}`)
							)
								return false;
							if (client.id === source.id) return true;
							try {
								const { pathname } = new URL(client.url);
								return (
									(nestedTopOf(pathname, ref.directory, ready.codec) ??
										new URL(ready.realURL(client.url)).origin) === top
								);
							} catch (error) {
								return false;
							}
						});
						// the site pool: its top may be a document of another slot,
						// which is no client of this worker; the hub knows where
						// the focus is in the host's page
						return (
							here ||
							(!!ref.config.sites &&
								(await ref.rpc
									.call('passkeyFocused', source.id)
									.catch(() => false)) === true)
						);
					},
				},
				ceremony,
				reply,
			);
		})();
		event.waitUntil(work.catch(() => reply.close()));
	} else if (CLIENT_HINTS in data) {
		// from a client of that controller: a routed document files its own
		// view under its own client id; any other client (the controller's
		// page) adds only what every window shares
		const message = data[CLIENT_HINTS] as ClientHintsReport;
		const source = event.source instanceof Client ? event.source : null;
		if (
			!message ||
			typeof message.directory !== 'string' ||
			!controllers.has(message.directory) ||
			!source
		)
			return;
		const routed = source.url.startsWith(
			`${location.origin}${message.directory}`,
		);
		recordClientHintsReport(
			message.directory,
			routed ? source.id : undefined,
			message,
		);
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
	} else if (LEGACY_FS_CLEARED in data) {
		legacyFileSystemCleared(data[LEGACY_FS_CLEARED]);
	} else if (ABORT_REQUEST in data) {
		abortRequest((data as Record<string, unknown>)[ABORT_REQUEST]);
	} else if (IMAGES_SEEN in data) {
		imagesSeen((data as Record<string, unknown>)[IMAGES_SEEN]);
	} else if (CONTROLLER_CLOSE in data) {
		// only the tab that registered the controller may close it (a proxied
		// page is a client too, and must not be able to kill its host's)
		const { directory } = data[CONTROLLER_CLOSE] as ControllerCloseMessage;
		const ref = controllers.get(directory);
		if (ref && ref.owner === sender) closeController(ref);
	} else if (BLOCKER_SERVE in data) {
		// the hub of a site pool: from the registering tab
		// only, a port on which a slot's worker asks this worker's engine
		const { directory } = data[BLOCKER_SERVE] as BlockerServeMessage;
		const [port] = event.ports;
		const ref = controllers.get(directory);
		if (!port) return;
		if (!ref || ref.owner !== sender) {
			port.close();
			return;
		}
		serveBlocker(port, () => {
			const blocker = controllers.get(directory)?.ready?.blocker;
			return blocker instanceof Blocker ? blocker : undefined;
		});
	} else if (CONTROLLER_MODULES in data) {
		// the modules compiled after the handshake: from the registering tab
		// only, as for every other message that acts on a controller
		const { directory, modules } = data[
			CONTROLLER_MODULES
		] as ControllerModulesMessage;
		const ref = controllers.get(directory);
		if (ref && ref.owner === sender) {
			heardBlockerBytes(modules);
			void adoptModules(modules);
		}
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
		const { directory, worker } = data[
			INIT_REMOTE_TRANSPORT
		] as InitRemoteTransportMessage;
		const ref = controllers.get(directory);
		if (sender && typeof worker === 'string' && worker.startsWith('blob:'))
			noteBlobWorker(worker, sender);

		if (!ref) {
			console.error(`Stomp: no controller registered for ${directory}`);
			return;
		}

		const [port] = event.ports;
		ref.rpc.call('initRemoteTransport', port, [port]);
	} else if (INIT_PAGE_MODULES in data) {
		// a proxied top's library realm (src/inject/rewriter.ts): its
		// controller answers on the port, this worker only passes it on (a
		// compiled module does not cross into or out of a service worker)
		const { directory } = data[INIT_PAGE_MODULES] as InitPageModulesMessage;
		const [port] = event.ports;
		if (port) controllers.get(directory)?.rpc.call('pageModules', port, [port]);
	}
}

/**
 * A routed request takes as long as its origin takes, as natively: Chrome
 * puts no time limit on a request's headers (a server that holds them for
 * minutes, a long poll, is answered when it answers). What bounds it is
 * Chrome's own limit on a service worker's fetch event, which applies to
 * this worker as to any site's: a respondWith not settled in 5 minutes is
 * a network error (measured on Chrome 157: 310 s, against 330 s answered
 * with no worker in between), and a worker of a newer build activates
 * after the same while however long a request of this one hangs. The
 * worker used to answer 504 after 60 s (120 s for documents and media),
 * which cut short every slow answer Chrome waits for (office.com's scripts
 * behind a slow transport). `config.fetchTimeout` sets a bound (tests).
 */
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

/** the response, or a 504 when it takes longer than a bound set by config.fetchTimeout (tests) */
function bounded(
	request: Request,
	response: Promise<Response>,
	ref: ControllerRef,
): Promise<Response> {
	const ms = ref.config.fetchTimeout;
	if (!ms) return response;
	let timer: ReturnType<typeof setTimeout>;
	let late = false;
	const timeout = new Promise<Response>((resolve) => {
		timer = setTimeout(() => {
			late = true;
			resolve(timedOut(request, ms, ref));
		}, ms);
	});
	// the answer that comes after the 504 went out is read by nobody: its
	// body is cancelled, or the transport goes on receiving it
	response.then(
		(answer) => {
			if (late) answer.body?.cancel().catch(() => {});
		},
		() => {},
	);
	return Promise.race([response.finally(() => clearTimeout(timer)), timeout]);
}

/** a navigation's destinations: a document of the proxy's in a frame or a window */
const NAVIGATION_DESTINATIONS = new Set([
	'document',
	'iframe',
	'frame',
	'embed',
	'object',
]);

/**
 * In a host whose page is cross-origin isolated (config.isolated) a frame's
 * document without an embedder policy does not load at all. The documents
 * the rewriter serves carry theirs (src/isolation.ts); this covers every
 * other one this worker makes (an error page, an inline document, an
 * emulated service worker's script), which are never isolated themselves.
 */
async function isolatedHost(
	request: Request,
	answer: Promise<Response>,
): Promise<Response> {
	const response = await answer;
	const navigation =
		request.mode === 'navigate' &&
		NAVIGATION_DESTINATIONS.has(request.destination);
	const worker =
		request.destination === 'worker' || request.destination === 'sharedworker';
	// a redirect on the way to a frame needs no embedder policy, only the
	// resource policy that lets a host's page of another origin have it
	// (measured: without it the frame does not load)
	const redirect = response.status >= 300 && response.status < 400;
	if (
		(!navigation && !worker) ||
		// the network's own answer (a file of the host's server), a network
		// error, or one that has its policy already
		response.url !== '' ||
		response.type !== 'default' ||
		(redirect
			? !navigation || response.headers.has('cross-origin-resource-policy')
			: response.headers.has('cross-origin-embedder-policy'))
	)
		return response;
	const headers = new Headers(response.headers);
	if (redirect) headers.set('cross-origin-resource-policy', 'cross-origin');
	else if (navigation)
		isolationResponseHeaders(headers, {
			isolated: false,
			topLevel: request.destination === 'document',
		});
	else headers.set('cross-origin-embedder-policy', SERVED_EMBEDDER_POLICY);
	return new Response(redirect ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * A link route's answer (src/visited.ts) is no controller's own: made for a
 * host's page that is cross-origin isolated when a controller of its scope
 * says its host is. With the site pool its redirect is a frame's whose
 * embedder is of another slot's origin, which Chrome refuses without the
 * resource policy (measured: blockedReason
 * corp-not-same-origin-after-defaulted-to-same-origin-by-coep).
 */
async function isolatedScope(
	request: Request,
	answer: Promise<Response>,
	scope: string,
): Promise<Response> {
	const response = await answer;
	for (const ref of controllers.values())
		if (ref.config.isolated && ref.config.scope === scope)
			return isolatedHost(request, Promise.resolve(response));
	return response;
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
		// a slot of the site pool whose agent is gone (its renderer crashed,
		// the hub's page removed it): the hub's own origin shows the
		// document, as without a pool
		const hub = ref.slot ? slotHome(ref.config) : undefined;
		if (hub && request.mode === 'navigate') return toHub(request, hub);
		const orphan = orphanOf(new URL(request.url).pathname, ref);
		if (orphan) return answerOrphan(request, orphan);
		// nothing else live under the scope: the controller's own error page
		return orphanError(request, ref.config, ref.directory, ref.config.codec);
	}
	noteRequestClients(
		request.destination,
		event.clientId,
		event.resultingClientId,
	);
	const server = ref.ready ?? (await ref.server);
	if (ref.slots && request.mode === 'navigate') {
		const away = await leaveSlot(request, ref, server);
		if (away) return away;
	}
	// the document this navigation makes is this worker's: its inject's load
	// channel is the first its client opens (loadGrants.ts)
	if (request.mode === 'navigate') servedLoadClient(event.resultingClientId);
	const answer = server.router.willRoute(request.url)
		? server.router.route(request, {
				clientId,
				requestClientId: event.clientId,
				resultingClientId: event.resultingClientId,
				isReload: (event as FetchEvent & { isReload?: boolean }).isReload,
				waitUntil: (promise) => event.waitUntil(promise),
			})
		: fetch(request);
	if (!ref.slots || request.mode !== 'navigate') return answer;
	// (a link route's redirect goes on to its slot: onItsSlot)
	const response = await linkOnItsSlot(ref, await answer);
	return ref.slot ? originKeyed(response) : response;
}

/** a redirect of a navigation to a link route, sent to its slot's (onItsSlot) */
async function linkOnItsSlot(
	ref: ControllerRef,
	response: Response,
): Promise<Response> {
	const location = REDIRECTS.includes(response.status)
		? response.headers.get('location')
		: null;
	if (
		!location ||
		!isLinkRoute(location, `${self.location.origin}${ref.config.scope}`)
	)
		return response;
	const moved = await onItsSlot(ref, location);
	if (moved === location) return response;
	const headers = new Headers(response.headers);
	headers.set('location', moved);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * The site pool: navigations on their way here from another slot's worker
 * (`arrive`), by routed path; each is taken by the navigation it names
 */
const arrivals = new Map<string, { arrival: SiteArrival; at: number }>();
/** how long an arrival waits for its navigation */
const ARRIVAL_TTL_MS = 10000;

function expectArrival(arrival: SiteArrival) {
	if (typeof arrival?.path !== 'string') return;
	const now = Date.now();
	for (const [path, entry] of arrivals)
		if (now - entry.at > ARRIVAL_TTL_MS) arrivals.delete(path);
	arrivals.set(arrival.path, { arrival, at: now });
}

/** the same route on the hub's origin (a slot of the site pool that cannot show it) */
function toHub(request: Request, hub: string): Response {
	const url = new URL(request.url);
	const scope = new URL(self.registration.scope).pathname;
	// marked (HOMED_SEGMENT), so the hub's worker keeps it rather than send
	// it back to this slot before the hub heard the agent is gone
	const path = url.pathname.startsWith(scope)
		? `${scope}${HOMED_SEGMENT}${url.pathname.slice(scope.length)}`
		: url.pathname;
	return new Response(null, {
		status: 307,
		headers: {
			location: `${hub}${path}${url.search}`,
			'cache-control': 'no-store',
			// a frame's embedder of another slot's origin under an isolated
			// host refuses it without (isolatedHost); this worker may know
			// no controller to ask whether the host is
			'cross-origin-resource-policy': 'cross-origin',
		},
	});
}

/**
 * The site pool: the segment after the scope of a navigation a slot's
 * worker sends to the hub's origin because its agent is gone. The hub's
 * worker answers it with a 307 to the route without it, which it then
 * serves itself (HOMED_MS), and tells the hub the slot is gone. It is no
 * address (an id has no `~`).
 */
const HOMED_SEGMENT = '~home/';
/** routed path and query -> when the slot sent it back */
const homed = new Map<string, number>();
/** how long a navigation sent back from a slot is kept on the hub's origin */
const HOMED_MS = 10000;

/** a navigation a slot sent back (HOMED_SEGMENT): the route without the mark, remembered */
function unmarkHomed(request: Request): Response | null {
	const url = new URL(request.url);
	const scope = new URL(self.registration.scope).pathname;
	if (!url.pathname.startsWith(`${scope}${HOMED_SEGMENT}`)) return null;
	if (request.mode !== 'navigate') return new Response(null, { status: 404 });
	const path = `${scope}${url.pathname.slice(scope.length + HOMED_SEGMENT.length)}`;
	const now = Date.now();
	for (const [key, at] of homed) if (now - at > HOMED_MS) homed.delete(key);
	homed.set(`${path}${url.search}`, now);
	return new Response(null, {
		status: 307,
		headers: {
			location: `${url.origin}${path}${url.search}`,
			'cache-control': 'no-store',
			// (toHub)
			'cross-origin-resource-policy': 'cross-origin',
		},
	});
}

/**
 * A request under an address no controller of this run of the worker has:
 * the network's, unless it is a navigation at the address of a slot's
 * agent that is gone (its renderer crashed and took this worker with it),
 * which goes to the hub's origin, as without a pool
 */
async function unclaimed(
	request: Request,
	pathname: string,
): Promise<Response> {
	if (request.mode === 'navigate' && addressShaped(pathname)) {
		const scope = new URL(self.registration.scope).pathname;
		const [, id] = SEGMENT.exec(pathname.slice(scope.length))!;
		const hub = await addressHub(`${scope}${id}/`).catch(() => undefined);
		if (hub && hub !== location.origin) return toHub(request, hub);
	}
	return fetch(request);
}

/** the arrival `request` (a navigation to `url`) was told of, taken */
function takeArrival(
	request: Request,
	url: string,
	directory: string,
	nested: string | null,
) {
	const routed = new URL(request.url);
	const path = `${routed.pathname}${routed.search}`;
	const arrived = arrivals.get(path);
	if (!arrived) return;
	arrivals.delete(path);
	siteArrived(request, url, arrived.arrival);
	contextArrived(
		arrived.arrival.context,
		arrived.arrival.referrer
			? `${routed.origin}${arrived.arrival.referrer}`
			: null,
		directory,
		nested === null,
	);
	visitedArrived(request.url, arrived.arrival.visited);
}

/**
 * The site pool (src/controller/sitePool.ts): a navigation to a document of
 * a site that is shown from another slot goes there, a 307 to the same route
 * on that slot's origin once the controller has that slot's worker up and
 * has handed it what this worker knew of the navigation. A navigation that
 * came from another slot's worker takes what that worker sent. Null: it is
 * this slot's to answer (the site's slot is this one, or the pool could not
 * say).
 */
async function leaveSlot(
	request: Request,
	ref: ControllerRef,
	server: StompServer,
): Promise<Response | null> {
	const url = new URL(request.url);
	const path = `${url.pathname}${url.search}`;
	const routed = server.routeOf(request.url);
	if (!routed) return null;
	let target: string;
	try {
		target = schemefulSite(routed.url, publicSuffix);
	} catch (error) {
		return null;
	}
	// the document the navigation makes is a frame's when its route is a
	// nested one (its main frame's origin)
	const nested = nestedTopOf(url.pathname, ref.directory, server.codec);
	const here = () => {
		takeArrival(request, routed.url, ref.directory, nested);
		return null;
	};
	// the hub's worker: a navigation the site's slot sent back (its agent is
	// gone) stays here, and the hub leaves that slot out
	if (!ref.slot && homed.has(path)) {
		homed.delete(path);
		ref.slots!.set(target, url.origin);
		ref.rpc.call('siteHomed', target).catch(() => {});
		return here();
	}
	// a form's route answers with a redirect to its document's route, which
	// is what leaves: served where the document that submitted the form is
	// (its referrer, its client, the policies it is judged by), as without
	// a pool
	if (/^html:form(:|$)/.test(routed.resource)) return here();
	// an inline document's route (src/server/inline.ts) is on the origin of
	// the document that registered it, whose worker alone holds its token:
	// served here, as that document's, or refused here with the error page.
	// Its URL names the referrer, whose site's slot never has the token, and
	// sending it there would only turn a live document into the error page.
	if (/^inline:/.test(routed.resource)) return here();
	// a route of a route of the proxy (a double route): the router answers it
	// here with a redirect to the inner route, on its own origin already.
	// Any other URL of the proxy's origins is a site like another
	// (proxy-ception), shown from a slot of its own
	if (
		proxyOrigins(ref.config).includes(new URL(routed.url).origin) &&
		unwrapRoute(new URL(routed.url), server.codec, ref.directory)
	)
		return here();
	let slot = ref.slots!.get(target);
	if (slot === undefined) {
		try {
			slot = (await ref.rpc.call('siteSlot', target)) ?? undefined;
		} catch (error) {
			// a controller of a build without the pool, or one gone
		}
		if (slot === undefined) return here();
		ref.slots!.set(target, slot);
	}
	if (slot === url.origin) return here();
	// (the visit a link route began goes on there: visitedHops.ts)
	const visited = takeVisitedHop(request.url);
	const departure = await siteDeparture(
		request,
		routed.url,
		ref.config.navigationHintWait ?? NAVIGATION_HINT_WAIT_MS,
		(first) => server.routeOf(first)?.url ?? null,
		nestedTopOf(url.pathname, ref.directory, server.codec) !== null,
	);
	// a later hop the policies of its chain refuse: refused here, where the
	// documents that told them are (they hear of a report-only one)
	if (departure.refused) return Response.redirect(departure.refused, 302);
	// served here after all, as it would have been
	const servedHere = () => {
		if (visited) rememberVisitedHop(request.url, visited);
		if (departure.referrer !== undefined || departure.hop || departure.hint)
			siteArrived(request, routed.url, { path, ...departure });
		return null;
	};
	const departingReferrer = departure.referrer
		? `${url.origin}${departure.referrer}`
		: null;
	const mixed = departingMixedContent(request, departingReferrer, nested, {
		directory: ref.directory,
		codec: server.codec,
		shields: server.shields,
	});
	if (mixed) return mixed;
	// a window the browser holds COOP same-origin for (src/coop.ts realPolicy):
	// that policy keeps the window's browsing context group only for a
	// document of the same real origin, so a document that keeps the group
	// natively (one that sends none) would leave it on another slot's
	// origin, whatever header it got there. Such a navigation is served
	// here, where the real policy keeps the group or switches it as natively
	const coop = departure.chain?.coop as OpenerFacts | undefined;
	if (
		nested === null &&
		request.destination === 'document' &&
		coop?.[3] === 'same-origin' &&
		!switchesGroup(coop, '', new URL(routed.url).origin)
	)
		return servedHere();
	const context = await contextDeparture(
		departingReferrer,
		nested,
		ref.directory,
	);
	let origin: string | null = null;
	try {
		origin = await ref.rpc.call('crossSite', {
			site: target,
			arrival: {
				path,
				...departure,
				...(context ? { context } : {}),
				...(visited && { visited: { hop: visited } }),
			},
		});
	} catch (error) {
		// the controller is gone
	}
	if (!origin || origin === url.origin) return servedHere();
	return new Response(null, {
		status: 307,
		headers: { location: `${origin}${path}`, 'cache-control': 'no-store' },
	});
}

/** how long a navigation with no referrer waits for its document's hint before it leaves for another site */
const NAVIGATION_HINT_WAIT_MS = 100;

/**
 * A document of a slot of the site pool asks for an agent cluster keyed by
 * its origin: the slots are of one site to the browser (one host, other
 * ports), and only so does each get a process of its own
 * (docs/process-model.md)
 */
function originKeyed(response: Response): Response {
	if (response.type === 'opaqueredirect' || response.status === 0)
		return response;
	try {
		response.headers.set('origin-agent-cluster', '?1');
		return response;
	} catch (error) {
		// a response whose headers are the network's
	}
	const headers = new Headers(response.headers);
	headers.set('origin-agent-cluster', '?1');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** when this worker (re)started: its first moments are the revive window */
const STARTED_AT = Date.now();
/**
 * When the revive window began: the start, and again the activation. A new
 * build's worker starts when it installs and may wait long before it
 * activates (Chrome activates it once the old one has no event in
 * progress); from then on every controller's address is its, and none has
 * shaken hands with it yet. The window from its start was long over, and
 * what the pages asked before their controller's handshake reached it went
 * to the host's server (a frame's whoami, its scripts, its storage calls).
 */
let reviveFrom = STARTED_AT;
/** this run of the worker, to its controllers (ReviveMessage) */
const INSTANCE = `${STARTED_AT.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
	const ref = controllerFor(pathname) ?? closedFor(event.request, pathname);
	if (ref) {
		// the server is still opening its databases: decide once it's up
		if (ref.ready && !ref.ready.router.willRoute(event.request.url))
			return null;
		const answer = bounded(event.request, serve(event, ref), ref);
		return ref.config.isolated ? isolatedHost(event.request, answer) : answer;
	}
	const orphan = orphanOf(pathname);
	if (!orphan) return null;
	// an address without a controller is answered for a host's page all the
	// same (a redirect to the controller that takes it over, the error
	// page): isolated when a controller that is left says its host is
	const answer = answerOrphan(event.request, orphan);
	for (const other of controllers.values())
		if (other.config.isolated) return isolatedHost(event.request, answer);
	return answer;
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
	await registered(() => !!controllerFor(pathname));
	return answerFor(event, pathname) ?? unclaimed(event.request, pathname);
}

/** resolves once `there()` holds (looked at with every registration), or when the revive window ends */
async function registered(there: () => boolean): Promise<void> {
	const deadline = reviveFrom + REVIVE_HOLD_MS;
	while (!there() && Date.now() < deadline)
		await new Promise<void>((resolve) => {
			const wake = () => {
				registrationWaiters.delete(wake);
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(wake, deadline - Date.now());
			registrationWaiters.add(wake);
		});
}

/** the scope `pathname` is a link route of (src/visited.ts), if it is one */
function linkScopeOf(pathname: string): string | null {
	const scopes = new Set([new URL(self.registration.scope).pathname]);
	for (const ref of controllers.values()) scopes.add(ref.config.scope);
	for (const scope of scopes) if (isLinkRoute(pathname, scope)) return scope;
	return null;
}

/** how long a link route waits for the hint of the document that navigates */
const LINK_HINT_WAIT_MS = 100;

/**
 * A link route (src/visited.ts): the URL a link of a proxied document has
 * for the browser, which names the link's partition and no controller. It
 * is answered with a redirect to the document's address, so the browser's
 * history records the link route under the navigation's own key, and a
 * later link of the same partition, in any tab, reads visited as natively.
 *
 * Which controller, and whether its frame is a nested one: the navigation's
 * referrer when it is a routed document (the link's own, as the link's
 * route used to say) and what the document that navigates told the worker
 * (NAVIGATION_HINT: all there is without a referrer, and the frame's kind
 * for a document a page wrote itself), else the newest live controller, at
 * the top level.
 *
 * Chrome counts a visit from a top-level site's own origin for the visited
 * URL's own site as well (self-links, makesSelfLink): such a navigation
 * goes through the link route of that site's context first.
 */
async function answerLink(event: FetchEvent, scope: string): Promise<Response> {
	const { request } = event;
	const back = linkArrival(request.url);
	if (back)
		return new Response(null, {
			status: 307,
			headers: { location: back, 'cache-control': 'no-store' },
		});
	const deadline = reviveFrom + REVIVE_HOLD_MS;
	while (!scopeControllers(scope).length && Date.now() < deadline)
		await new Promise<void>((resolve) => {
			const wake = () => {
				registrationWaiters.delete(wake);
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(wake, deadline - Date.now());
			registrationWaiters.add(wake);
		});
	const live = scopeControllers(scope);
	if (!live.length) return fetch(request);
	const state = takeVisitedHop(request.url);
	const stated = state?.directory
		? controllers.get(state.directory)
		: undefined;
	// the document that started the navigation, when the browser names it
	let referrer: { ref: ControllerRef; kind: string } | undefined;
	try {
		const from = new URL(request.referrer);
		const ref =
			from.origin === location.origin ? controllerFor(from.pathname) : null;
		if (ref?.ready && ref.config.scope === scope)
			referrer = {
				ref,
				kind: from.pathname.slice(ref.directory.length).split('/')[0],
			};
	} catch (error) {
		// no referrer
	}
	let parsed: ReturnType<StompServer['linkOf']> = null;
	for (const ref of [stated, referrer?.ref, ...live]) {
		parsed = ref?.ready?.linkOf(request.url) ?? null;
		if (parsed) break;
	}
	if (!parsed)
		return new Response(
			'<!doctype html><title>404</title><p>Stomp: not a link of a live controller</p>',
			{ status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
		);
	// (a document tells of every navigation it starts, so the hint is
	// there, or on its way: only a navigation no document started, a host's
	// or the user's own, waits the whole time)
	const hint = state
		? peekNavigationHint(parsed.url.href)
		: await awaitNavigationHintPeek(
				parsed.url.href,
				live[0].config.navigationHintWait ?? LINK_HINT_WAIT_MS,
			);
	const hinted = hint ? controllers.get(hint.directory) : undefined;
	let ref =
		stated ??
		referrer?.ref ??
		(hinted?.config.scope === scope ? hinted : undefined);
	if (!ref?.ready?.linkOf(request.url) || !(await alive(ref)))
		ref = await newestAlive(
			live.filter((candidate) => candidate.ready!.linkOf(request.url)),
		);
	if (!ref)
		return orphanError(request, live[0].config, scope, live[0].config.codec);
	// the frame's kind of route: the referrer's own when the document that
	// navigates is the one at that address, else what the document said (one
	// a page wrote itself, whose referrer is its creator's address)
	const nested =
		state?.nested ??
		(hinted === ref && !hint!.own
			? hint!.nested
			: referrer?.ref === ref && referrer.kind.startsWith('html')
				? (nestedMarkOfKind(referrer.kind, ref.ready!.codec) ?? false)
				: hinted === ref
					? hint!.nested
					: false);
	const next = await linkStep(ref, parsed, {
		context: state?.context ?? parsed.context,
		nested,
		hops: (state?.hops ?? 0) + 1,
		...(state?.crossed && { crossed: true }),
	});
	return new Response(null, {
		status: 307,
		headers: { location: ref.slots ? await onItsSlot(ref, next) : next },
	});
}

/**
 * Where a link route's navigation goes next, remembered for that URL: the
 * link route of the visited URL's own site's context (Chrome's self-links,
 * makesSelfLink), else the document's address. With the site pool, the
 * self-link only when that site is shown from this slot: Chrome keys the
 * visit by the frame origin of the document that started the navigation,
 * which is this slot, and the visited URL's own site's documents, shown
 * from another, would never read it (docs/site-pool.md).
 */
async function linkStep(
	ref: ControllerRef,
	link: { context: VisitedContext; url: URL },
	hop: VisitedHop & { nested: string | false },
): Promise<string> {
	const ready = ref.ready!;
	const self = selfContext(link.url, publicSuffix);
	if (
		makesSelfLink(hop.context) &&
		!sameContext(link.context, self) &&
		(!ref.slots || (await slotOf(ref, self.top)) === location.origin)
	) {
		const next = ready.linkRoute(self, link.url);
		rememberVisitedHop(next, { ...hop, directory: ref.directory });
		return next;
	}
	const target = ready.routeAs(
		`html${hop.nested ? `:nested:${ready.codec.encode(hop.nested)}` : ''}`,
		link.url.href,
	);
	rememberVisitedHop(target, {
		context: hop.context,
		hops: hop.hops,
		...(hop.crossed && { crossed: true }),
	});
	return target;
}

/** the site pool: the origin of the slot `site` is shown from, null when the pool cannot say */
async function slotOf(
	ref: ControllerRef,
	site: string,
): Promise<string | null> {
	const known = ref.slots!.get(site);
	if (known !== undefined) return known;
	try {
		const slot = await ref.rpc.call('siteSlot', site);
		if (slot) ref.slots!.set(site, slot);
		return slot ?? null;
	} catch (error) {
		// a controller of a build without the pool, or one gone
		return null;
	}
}

/** the URL a link route of another slot's sends the browser on to (SiteArrival `visited.back`), taken */
function linkArrival(url: string): string | null {
	const { pathname, search } = new URL(url);
	const arrived = arrivals.get(`${pathname}${search}`);
	const back = arrived?.arrival.visited?.back;
	if (typeof back !== 'string') return null;
	arrivals.delete(`${pathname}${search}`);
	if (Date.now() - arrived!.at > ARRIVAL_TTL_MS) return null;
	try {
		return /^https?:$/.test(new URL(back).protocol) ? back : null;
	} catch (error) {
		return null;
	}
}

/**
 * The site pool: a link route (src/visited.ts) a navigation goes through
 * belongs on the origin of the documents whose links name it, the slot of
 * its context's site, where Chrome's history keys the visit by that frame
 * origin. One of another slot's goes there: that slot's worker is told where
 * the navigation goes on to (the next step, as this worker's own link route
 * would have answered it) and sends the browser straight back, so the
 * navigation stays this worker's. `location` as it is otherwise.
 */
async function onItsSlot(
	ref: ControllerRef,
	location: string,
): Promise<string> {
	const ready = ref.ready ?? (await ref.server);
	const link = ready.linkOf(location);
	if (!link || link.context.frame === 'null') return location;
	const url = new URL(location);
	let site: string;
	try {
		site = schemefulSite(link.context.frame, publicSuffix);
	} catch (error) {
		return location;
	}
	const slot = await slotOf(ref, site);
	if (slot === null || slot === url.origin) return location;
	const hop = takeVisitedHop(location);
	if (!hop) return location;
	const back = await onItsSlot(
		ref,
		await linkStep(ref, link, {
			context: hop.context,
			nested: hop.nested ?? false,
			hops: hop.hops + 1,
			...(hop.crossed && { crossed: true }),
		}),
	);
	const path = `${url.pathname}${url.search}`;
	let origin: string | null = null;
	try {
		origin = await ref.rpc.call('crossSite', {
			site,
			arrival: { path, visited: { back } },
		});
	} catch (error) {
		// the controller is gone
	}
	if (!origin || origin === url.origin) {
		rememberVisitedHop(location, hop);
		return location;
	}
	return `${origin}${path}${url.hash}`;
}

// ---- the document bundles (src/version.ts DOCUMENT)

/** the store of the document bundles this worker and the ones before it kept, by URL */
const BUNDLES = 'stomp-document-bundles';
/** the bundles' files, by the names this worker's build gave them */
const OWN_BUNDLES: [BundleAsset, string][] = [
	['injectDocument', DOCUMENT],
	['injectDocumentFull', DOCUMENT_FULL],
];

/** the first 16 hex digits of the SHA-256 of `bytes`, as build.js names a file */
async function fileHash(bytes: ArrayBuffer): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	let hex = '';
	for (const byte of digest.subarray(0, 8))
		hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/**
 * The URLs the store holds, as this worker last read or wrote it: a
 * request is answered from the store only when its file is known to be
 * there, so one that is not goes to the browser's own fetch at once
 */
const keptBundles = new Set<string>();
let keptBundlesRead: Promise<void> | undefined;
function readKeptBundles() {
	keptBundlesRead ??= (async () => {
		for (const request of await (await caches.open(BUNDLES)).keys())
			keptBundles.add(request.url);
	})().catch(() => {
		// no store: every request goes to the browser's fetch
	});
	return keptBundlesRead;
}
readKeptBundles();
openDatabasesEarly();

/** the keeps in flight, by URL */
const keeping = new Map<string, Promise<void>>();

/**
 * Fetch this build's file at `url` and keep it when its bytes are the ones
 * `hash` names (a host that serves another build's bytes under it, as a
 * deploy in progress may, is not kept from)
 */
function keepBundle(url: string, hash: string): Promise<void> {
	let keep = keeping.get(url);
	if (!keep) {
		keep = (async () => {
			await readKeptBundles();
			if (keptBundles.has(url)) return;
			const response = await fetch(url);
			if (!response.ok || response.type !== 'basic') return;
			const copy = response.clone();
			if ((await fileHash(await response.arrayBuffer())) !== hash) return;
			// a Response the browser fetched, which has its URL: Chrome keeps
			// a code cache only for such an entry
			await (await caches.open(BUNDLES)).put(url, copy);
			keptBundles.add(url);
		})()
			.catch(() => {
				// not kept: the next document's load fetches it again
			})
			.finally(() => keeping.delete(url));
		keeping.set(url, keep);
	}
	return keep;
}

/**
 * A document bundle's request: a proxied document's shell asks for
 * `injectDocument.js?<hash>`, one file of one build, which the host serves
 * with no-cache or for good, and the document waited for its revalidation
 * before its first script (a round trip to the host, 54 to 129 ms over a
 * link of 40 ms). A file the store holds is answered from it: this
 * worker's own build's, which it fetched once and checked against its
 * hash, or another build's that the worker before it kept (a document of
 * that worker, still open through an update, whose frames ask for it), so
 * neither is ever answered with the other's. One the store does not hold
 * goes to the browser's own fetch, as it did before (a worker's answer
 * costs the worker's thread, busy with the document then), and this
 * build's is kept for the next. The browser's memory cache answers the
 * documents after the first of a page's process itself, the file being
 * fresh under its hash. False for any other request.
 */
function documentBundle(
	event: FetchEvent,
	pathname: string,
	search: string,
): boolean {
	const { request } = event;
	if (request.method !== 'GET' || !search) return false;
	const scopes = new Set([new URL(self.registration.scope).pathname]);
	const names = new Map<string, string>();
	for (const [key, hash] of OWN_BUNDLES)
		names.set(assetName(undefined, key), hash);
	for (const ref of controllers.values()) {
		scopes.add(ref.config.scope);
		for (const [key, hash] of OWN_BUNDLES)
			names.set(assetName(ref.config.assets, key), hash);
	}
	let own: string | undefined;
	let known = false;
	for (const scope of scopes)
		for (const [name, hash] of names)
			if (pathname === `${scope}${name}`) {
				known = true;
				own = hash;
			}
	if (!known) return false;
	// its document's head is rewritten once this is answered (streamMarkup)
	if (event.clientId) bundleRequested(event.clientId);
	if (keptBundles.has(request.url)) {
		event.respondWith(
			(async () => {
				try {
					const kept = await (await caches.open(BUNDLES)).match(request);
					if (kept) return kept;
				} catch (error) {
					// the store went (storage cleared): the network's answer
				}
				keptBundles.delete(request.url);
				return fetch(request);
			})(),
		);
		return true;
	}
	if (own && search === `?${encodeURIComponent(own)}`)
		event.waitUntil(keepBundle(request.url, own));
	return true;
}

/**
 * Keep this worker's bundles and the ones the worker before it kept (its
 * documents may still be open, and frames they make ask for that build's
 * file): every other build's goes
 */
async function sweepBundles() {
	const store = await caches.open(BUNDLES);
	const own = new Set(
		OWN_BUNDLES.map(([, hash]) => (hash ? `?${encodeURIComponent(hash)}` : '')),
	);
	const others = new Map<string, { request: Request; at: number }[]>();
	for (const request of await store.keys()) {
		const { pathname, search } = new URL(request.url);
		if (own.has(search)) continue;
		const at = Date.parse(
			(await store.match(request))?.headers.get('date') ?? '',
		);
		const list = others.get(pathname) ?? [];
		list.push({ request, at: Number.isNaN(at) ? 0 : at });
		others.set(pathname, list);
	}
	for (const list of others.values()) {
		list.sort((a, b) => b.at - a.at);
		for (const { request } of list.slice(1)) {
			keptBundles.delete(request.url);
			await store.delete(request);
		}
	}
}

/**
 * An about:srcdoc client's claim (SRCDOC_CLAIM): a request of its own, so
 * its client is the document's (Chrome reports its URL as empty until the
 * document is parsed)
 */
function srcdocClaim(event: FetchEvent, pathname: string): boolean {
	const ref = controllerFor(pathname);
	const prefix = `${ref?.directory}${SRCDOC_CLAIM}/`;
	const token = pathname.slice(prefix.length);
	if (
		!ref ||
		!pathname.startsWith(prefix) ||
		(token !== '' && !INLINE_TOKEN.test(token))
	)
		return false;
	event.respondWith(
		(async () => {
			const source = await clients.get(event.clientId);
			if (
				source?.type === 'window' &&
				(source as WindowClient).frameType === 'nested' &&
				(source.url === '' || source.url.startsWith('about:srcdoc'))
			)
				claim(token, source.id);
			return new Response(null, { status: 204 });
		})(),
	);
	return true;
}

self.addEventListener('fetch', (event: FetchEvent) => {
	const { pathname, search } = new URL(event.request.url);
	if (documentBundle(event, pathname, search)) return;
	if (srcdocClaim(event, pathname)) return;
	noteRequest(event.request, event.clientId);
	const unmarked = unmarkHomed(event.request);
	if (unmarked) {
		event.respondWith(unmarked);
		return;
	}
	const linkScope = linkScopeOf(pathname);
	if (linkScope) {
		event.respondWith(
			isolatedScope(event.request, answerLink(event, linkScope), linkScope),
		);
		return;
	}
	// in the revive window an address whose controller has not answered yet
	// waits for it, before another controller could take it over as an orphan
	if (
		!controllerFor(pathname) &&
		!closedFor(event.request, pathname) &&
		Date.now() - reviveFrom < REVIVE_HOLD_MS &&
		addressShaped(pathname)
	) {
		event.respondWith(heldForRevive(event, pathname));
		return;
	}
	const answer = answerFor(event, pathname);
	if (answer)
		event.respondWith(
			event.request.mode === 'navigate' ? lasting(event, answer) : answer,
		);
	// the site pool: a slot's navigation whose agent is gone
	else if (event.request.mode === 'navigate' && addressShaped(pathname))
		event.respondWith(unclaimed(event.request, pathname));
});

/**
 * A navigation's answer, whose body this worker goes on writing once it is
 * handed over (the rewriter streams the document): the event lasts until
 * the body is written. Chrome activates a waiting worker the moment the
 * active one has no event in progress, and stops the old one there and
 * then: a document it was still writing never ended, and its frame showed
 * nothing for good. A body that is a Blob is whole already and goes as it
 * is (blobResponses): the browser reads it, not this worker.
 */
function lasting(
	event: FetchEvent,
	answer: Promise<Response>,
): Promise<Response> {
	return answer.then((response) => {
		// (before its body is asked for: WebKit's getter makes the Blob a
		// stream this worker reads)
		if (
			blobResponses.has(response) ||
			response.type !== 'default' ||
			!response.body
		)
			return response;
		const { readable, writable } = new TransformStream<Uint8Array>();
		event.waitUntil(response.body.pipeTo(writable).catch(() => {}));
		return new Response(readable, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	});
}

self.addEventListener('install', () => {
	self.skipWaiting();
});

// a new worker is new bytes, but not always a new rewriter: it keeps the
// rewrite cache when its generation is the same (a deploy that touched the
// demo or the infra, not the rewriter), so a revisit after it comes back
// warm, and drops it when the generation differs, so the last rewriter's
// output is never served (adopt). A dev build bakes in no generation (its
// rewriter can change without the commit changing, so the generation could
// not be trusted): the cache falls back to the build in its key and is
// dropped on every activation, as it was before.
self.addEventListener('activate', (event: ExtendableEvent) => {
	reviveFrom = Date.now();
	event.waitUntil(
		Promise.all([
			self.clients.claim(),
			REWRITE_GENERATION
				? new RewriteCache().adopt(REWRITE_GENERATION)
				: new RewriteCache().clear(),
			sweepBundles().catch(() => {}),
		]),
	);
});

// This script only runs again when the worker was terminated and restarted.
// Nothing in `controllers` survived, so ask every client to re-register, as
// soon as the script has run: whatever woke the worker (a navigation, a
// host's call) waits for that handshake. A controller whose own handshake
// woke the worker takes the revive while it waits for that handshake's
// hello and finds it is the same run (src/controller/index.ts), so an early
// revive asks nothing twice. (It went out 100 ms later, and every load
// after Chrome stopped an idle worker waited for it.)
setTimeout(async () => {
	for (const client of await self.clients.matchAll({
		includeUncontrolled: true,
	}))
		client.postMessage({
			[SW_REVIVE]: { instance: INSTANCE } satisfies ReviveMessage,
		});
}, 0);
