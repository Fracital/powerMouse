import {
	BareCompatibleClient,
	type ProxyTransport,
} from '@mercuryworkshop/proxy-transports';
import { IDBPDatabase, openDB } from 'idb';
import type { AdblockInit, SiteShields } from '../blocker/types';
import type GenericCodec from '../Codecs';
import {
	assetName,
	Assets,
	Config,
	ConfigCodec,
	generateConfigCodecKey,
	parseConfig,
	validConfigCodecKey,
} from '../config';
import { workerKindPartition } from '../partition';
import { usePasskeysRemote } from '../passkeys/authenticator';
import { isDocumentKind, parseRoutedURL, proxyOrigins } from '../routeURL';
import StompURL from '../StompURL';
import { getPublicSuffix } from '../suffix';
import type {
	HostReload,
	RequestInfo,
	RequestRule,
} from '../transport/messages';
import { ECHO_ROUTE, SEALER_ROUTE, SEALER_SOURCE } from '../transport/messages';
import {
	contextText,
	linkRoute,
	parseLinkRoute,
	type VisitedContext,
} from '../visited';
import { heldModules, moduleOf } from '../wasm/thread';
import { Blocker, registerBlocker, type BlockerLike } from './blocker';
import { HttpCache, memoryCache } from './cache';
import {
	CACHE_SECRET_KEY,
	keepCacheSecretWith,
	newCacheSecret,
	renewCacheSecret,
	useCacheSecret,
} from './cacheMarks';
import { warmClientHints } from './clientHints';
import Cookies, { openCookies, registerCookies } from './Cookies';
import { hostErrorPage } from './errorPage';
import { registerIntegrityLoads } from './integrityLoads';
import { RemoteJar, type JarPort } from './jarDB';
import { registerKeptLoads } from './keptLoads';
import { registerMediaLoads } from './mediaLoads';
import { registerPermissionRoute, usePermissionsRemote } from './permissions';
import { RewriteCache } from './rewriteCache';
import type { RewritePool } from './rewritePool';
import { registerRewrites } from './rewrites';
import Router, { json } from './Router';
import { serviceWorkers } from './serviceWorkers';
import { ShieldsStore } from './shields';
import {
	forgetSiteStorage,
	openStorage,
	registerStorage,
	StorageHosts,
} from './Storage';
import { registerXhr } from './Sync';
import { addWindowRoutes } from './windowURLs';

export interface StompServer {
	router: Router;
	/** turn a URL into the proxied URL a frame should navigate to */
	route(url: string): string;
	/** drop every entry of the HTTP cache and the rewrite cache (a no-op when they are off) */
	clearCache(): Promise<void>;
	/** the host page was reloaded: what it restores takes that cache mode (rewrites.ts) */
	hostReloaded(mode: HostReload): void;
	/** the cookie jar, for the host's cookies API */
	cookies: Cookies;
	/**
	 * Clear every virtualized store of a site on the proxy origin (the "Forget
	 * me when I close this site" shield): its localStorage, sessionStorage,
	 * IndexedDB and Cache Storage (src/server/Storage.ts). The cookie jar is
	 * cleared through `cookies`.
	 */
	forgetStorage(origin: string): Promise<void>;
	/** replace the host's request rules */
	setRules(rules: RequestRule[]): void;
	/** the real URL of a routed one; the input when it is not routed */
	realURL(routed: string): string;
	/** the route kind and real URL of a routed one, and the codec its kind and URL are written in, or null */
	routeOf(
		routed: string,
	): { resource: string; url: string; codec: GenericCodec } | null;
	/** the codec of this controller's routes */
	codec: GenericCodec;
	/** the routed URL of a real one under a route kind (`binary`, `sw:<version>`) */
	routeAs(kind: string, url: string): string;
	/**
	 * the built-in blocker, unless the host turned it off (docs/adblock.md);
	 * a slot of the site pool asks the hub's worker's
	 * (src/server/remoteBlocker.ts)
	 */
	blocker?: BlockerLike;
	/**
	 * Change the built-in blocker's lists at runtime (the controller's `adblock`
	 * RPC, from the demo's Filter Lists editor): the engine is rebuilt in place
	 * and keeps serving the old lists until the new ones compile. `force`
	 * re-fetches even unchanged lists (the "Update lists" button). A no-op when
	 * the host turned the blocker off (there is no engine to reload).
	 */
	reloadBlocker(init: AdblockInit, force?: boolean): Promise<void>;
	/** the per-site shields the controller set (src/server/shields.ts) */
	shields: ShieldsStore;
	/** replace the per-site shields allowlist (the controller's `shields` RPC) */
	setShields(list: SiteShields[], seed?: number): void;
	/** the context and real URL of a link route (src/visited.ts), or null */
	linkOf(routed: string): { context: VisitedContext; url: URL } | null;
	/** the link route of `url` for a link in a document of `context` */
	linkRoute(context: VisitedContext, url: URL): string;
	/** the key of this server's codec (the site pool hands the host's to every slot's worker) */
	codecKey: string;
}

/** the public suffix of a host, private registries counted, as Chrome's sites have it */
export const publicSuffix = (host: string) => getPublicSuffix(host, true);

/**
 * What the controllers of one scope share: a controller is a tab, not a
 * browser, so two host tabs on one scope see the same cookies, the same
 * cache and the same storage partitions. Opened once per scope; the servers
 * register their own routes over the shared instances.
 */
interface SharedStores {
	cookies: Cookies;
	cache: HttpCache;
	/** the rewriter's output for scripts, kept with the HTTP cache */
	rewrites: RewriteCache;
	storage: StorageHosts;
}

const shared = new Map<string, Promise<SharedStores>>();

/**
 * The blocker of a scope (docs/adblock.md): one engine for every controller
 * of the scope that asks for the same lists, fetching through the transport
 * of whichever controller registered last (the earlier one's tab may be gone)
 */
const blockers = new Map<
	string,
	{ blocker: Blocker; bare: BareCompatibleClient }
>();

/** a blocker of the `blockers` map is keyed by its scope and everything that
 * shapes its engine, so controllers of one scope asking for the same lists
 * share one, and a runtime list change (reloadBlocker) re-keys it */
function blockerKey(scope: string, init: AdblockInit): string {
	return JSON.stringify([
		scope,
		init.lists,
		init.resources,
		init.engine ?? '',
		init.refreshMs,
	]);
}

function sharedBlocker(
	scope: string,
	init: AdblockInit,
	bare: BareCompatibleClient,
): Blocker {
	const key = blockerKey(scope, init);
	let entry = blockers.get(key);
	// one that never got an engine (no module, no list fetched) is tried
	// again by the next controller to shake hands
	if (!entry || entry.blocker.failed) {
		const holder = { bare } as { blocker: Blocker; bare: BareCompatibleClient };
		// the module is this thread's, handed over with the handshake and
		// compiling behind it (src/wasm/thread.ts)
		holder.blocker = new Blocker(
			init,
			(url) => holder.bare.fetch(url, { redirect: 'follow' }),
			() => heldModules().then(() => moduleOf('blocker')),
		);
		entry = holder;
		blockers.set(key, entry);
	} else entry.bare = bare;
	return entry.blocker;
}

/**
 * Change a scope's blocker lists at runtime (the demo's Filter Lists editor,
 * docs/adblock.md): the engine is rebuilt in place, so the request path that
 * holds this Blocker keeps working, and the `blockers` map is re-keyed to the
 * new lists so a later controller of the scope with the same lists reuses it.
 */
function reconfigureBlocker(
	scope: string,
	blocker: Blocker,
	init: AdblockInit,
	force: boolean,
): Promise<void> {
	for (const [key, entry] of blockers)
		if (entry.blocker === blocker) {
			blockers.delete(key);
			blockers.set(blockerKey(scope, init), entry);
			break;
		}
	return blocker.reconfigure(init, force);
}

/** the site pool: the host's jar as this worker asks it (src/server/jarDB.ts) */
let remoteJar: RemoteJar | undefined;

function sharedStores(scope: string, jar?: JarPort): Promise<SharedStores> {
	// every handshake's port, the newest asked first (RemoteJar)
	if (jar) {
		(remoteJar ??= new RemoteJar()).bind(jar);
		usePermissionsRemote(remoteJar);
		usePasskeysRemote(remoteJar);
	}
	let stores = shared.get(scope);
	if (!stores) {
		stores = (async () => ({
			cookies: await openCookies(publicSuffix, jar ? remoteJar : undefined),
			cache: new HttpCache(),
			rewrites: new RewriteCache(),
			storage: await openStorage(),
		}))();
		// a failure to open is not kept: the next server tries again
		stores.catch(() => shared.delete(scope));
		shared.set(scope, stores);
	}
	return stores;
}

/** the worker's own settings: the codec keys, the codec of every address it served, the cache marks' secret */
export function openConfigDB(): Promise<IDBPDatabase> {
	return openDB('stompConfig', 1, {
		upgrade: (db) => {
			db.createObjectStore('consts');
		},
	});
}

// a secret of the cache marks drawn again is kept with the others
keepCacheSecretWith(async (secret) =>
	(await openConfigDB()).put('consts', secret, CACHE_SECRET_KEY),
);

const CODECS: ConfigCodec[] = ['generic', 'xor', 'aes', 'base64'];

/** what the worker remembers about an address: `controller:<address>` rows */
interface AddressRecord {
	codec: ConfigCodec;
	/** a slot of the site pool: the hub's origin (Config.sites), which shows the address's documents once its agent is gone */
	hub?: string;
	/** when the row was written, so the oldest go first */
	at: number;
}
/** how many addresses a scope remembers (a host that passes no id adds one per load) */
const ADDRESS_ROWS = 64;
/** the segment an address adds to its scope */
const ADDRESS_SEGMENT = /^[A-Za-z0-9_-]{1,32}\/$/;

/**
 * The codec of the controller that was (or is) registered at `directory`,
 * remembered when its server was created, so a routed URL whose controller
 * is gone can be handed to a live controller of the same codec. Undefined
 * for an address this worker never served (or has since forgotten).
 */
export async function addressCodec(
	directory: string,
): Promise<ConfigCodec | undefined> {
	const db = await openConfigDB();
	const record: AddressRecord | undefined = await db.get(
		'consts',
		`controller:${directory}`,
	);
	return record && CODECS.includes(record.codec) ? record.codec : undefined;
}

/** a slot's config: the origin of its hub's controller (SitesConfig.home) */
export function slotHome(config: Config): string | undefined {
	return config.sites?.home ?? config.sites?.hub;
}

/**
 * The site pool: the hub's origin of the agent that was (or is) registered
 * at `directory` on this slot's origin, undefined for any other address
 */
export async function addressHub(
	directory: string,
): Promise<string | undefined> {
	const db = await openConfigDB();
	const record: AddressRecord | undefined = await db.get(
		'consts',
		`controller:${directory}`,
	);
	return typeof record?.hub === 'string' ? record.hub : undefined;
}

/** a regexp source matching exactly `text` */
const exact = (text: string) =>
	`^\\/${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

/**
 * The bundles a page or worker loads, answered under the address as well:
 * a worker of the build before addresses built them under the controller's
 * directory, so a shell it produced for a new controller asks for
 * `/stomp/<id>/injectDocument.js`; this worker sends that to the scope's
 * file instead of letting it fall to the host's 404.
 */
function registerAssets(router: Router, scope: string, assets?: Assets) {
	for (const key of [
		'injectDocument',
		'injectDocumentFull',
		'injectWorker',
		'injectWorkerFull',
		'transportWorker',
		'rewriterLib',
	] as const) {
		const name = assetName(assets, key);
		router.routes.set(new RegExp(exact(name)), () =>
			Response.redirect(`${location.origin}${scope}${name}`, 307),
		);
	}
}

export default async function createServer(
	config: Config,
	transport: ProxyTransport,
	log?: (info: RequestInfo) => void,
	/** the controller's rewrite workers, when it started any */
	pool?: RewritePool,
	/** the built-in blocker's lists, unless the host turned it off */
	adblock?: AdblockInit,
	/** the site pool: the host's worker's codec key, which this worker takes */
	givenKey?: string,
	/** the site pool: the host's cookie jar, asked over this port */
	jar?: JarPort,
	/** a slot of the site pool: the hub's worker's blocker, instead of an engine of this worker's */
	remoteBlocker?: BlockerLike,
): Promise<StompServer> {
	const db = await openConfigDB();

	const tx = db.transaction('consts', 'readwrite');
	const store = tx.objectStore('consts');

	// an IndexedDB transaction commits during any other await, so nothing
	// but the store may be awaited until tx.done
	let newKey = false;
	// (a key of the xor codec before docs/codec.md is none of today's: its
	// routes showed most of the URL, and a new one is drawn in its place)
	if (
		givenKey !== undefined &&
		(await store.get(`codecKey:${config.codec}`)) !== givenKey
	) {
		await store.put(givenKey, `codecKey:${config.codec}`);
		newKey = true;
	} else if (
		!validConfigCodecKey(
			config.codec,
			await store.get(`codecKey:${config.codec}`),
		)
	) {
		await store.put(
			generateConfigCodecKey(config.codec),
			`codecKey:${config.codec}`,
		);
		newKey = true;
	}

	const codecKey = await store.get(`codecKey:${config.codec}`);
	// the secret the memory cache's site marks are drawn from (cacheMarks.ts)
	let cacheSecret: unknown = await store.get(CACHE_SECRET_KEY);
	if (typeof cacheSecret !== 'string') {
		cacheSecret = newCacheSecret();
		await store.put(cacheSecret, CACHE_SECRET_KEY);
	}
	// the address's codec outlives the controller (see addressCodec); the
	// scope keeps the newest ADDRESS_ROWS of them
	await store.put(
		{
			codec: config.codec,
			at: Date.now(),
			...(slotHome(config) ? { hub: slotHome(config) } : {}),
		} satisfies AddressRecord,
		`controller:${config.directory}`,
	);
	const scopeKey = `controller:${config.scope}`;
	// every key under the scope's prefix (U+FFFF sorts after any id character)
	const range = IDBKeyRange.bound(
		scopeKey,
		`${scopeKey}${String.fromCharCode(0xffff)}`,
	);
	const keys = (await store.getAllKeys(range)) as string[];
	const records = (await store.getAll(range)) as AddressRecord[];
	const rows = keys
		.map((key, i) => ({ key, at: records[i]?.at ?? 0 }))
		.filter(({ key }) => ADDRESS_SEGMENT.test(key.slice(scopeKey.length)))
		.sort((a, b) => a.at - b.at);
	for (const { key } of rows.slice(0, Math.max(0, rows.length - ADDRESS_ROWS)))
		await store.delete(key);

	await tx.done;
	useCacheSecret(cacheSecret);

	// routed URLs change with the key; nothing cached is reachable anymore
	if (newKey) {
		await new HttpCache().clear();
		memoryCache.clear();
		await new RewriteCache().clear();
	}

	const init = parseConfig(config, codecKey);
	const stores = await sharedStores(init.scope, jar);

	const router = new Router(init.directory);
	const scopePrefix = `${location.origin}${init.scope}`;
	const linkOf = (routed: string) =>
		parseLinkRoute(routed, init.codec, scopePrefix, publicSuffix);
	const realURL = (routed: string): string => {
		// with the site pool a route is this origin's or another of the
		// proxy's (the hub's, a slot's: proxyOrigins), which a host reads off
		// a frame of the pool
		const origin =
			proxyOrigins(init).find((other) =>
				routed.startsWith(`${other}${init.scope}`),
			) ?? location.origin;
		// a link's route stands for its URL as a document's does
		const link = parseLinkRoute(
			routed,
			init.codec,
			`${origin}${init.scope}`,
			publicSuffix,
		);
		if (link) return link.url.href;
		try {
			return parseRoutedURL(
				routed,
				init.codec,
				`${origin}${init.directory}`,
			).url.toString();
		} catch (error) {
			return routed;
		}
	};
	// the real URLs of this controller's documents, for the change notes of
	// the jar and the stores (windowURLs.ts)
	addWindowRoutes(init.directory, (url) => {
		if (!url.startsWith(scopePrefix)) return undefined;
		// a link's route stands for its document's URL (src/visited.ts)
		const link = linkOf(url);
		if (link) return link.url.href;
		const prefix = `${location.origin}${init.directory}`;
		if (!url.startsWith(prefix)) return undefined;
		try {
			const { resource, url: real } = parseRoutedURL(url, init.codec, prefix);
			// a document's route names the URL its client is of; any other
			// (a document the page made, served from its shell) is read as
			// no route
			return isDocumentKind(resource) ? real.url.href : null;
		} catch (error) {
			return null;
		}
	});
	// a routing error on a document: the host's page when it has one
	router.errorPage = (request, status, message) =>
		hostErrorPage(init, {
			url: realURL(request.url),
			status,
			error: message,
			kind: 'routing',
		});

	const cookies = registerCookies(router, stores.cookies);
	const cache = config.cache === false ? undefined : stores.cache;
	warmStores(cache, config.serviceWorkers !== false);
	const rewrites = config.cache === false ? undefined : stores.rewrites;
	// a page asks who it is (its service worker client id) and reports it to
	// the host, so the host can attribute requests to frames
	router.routes.set(/^\/whoami$/, (request, url, context) =>
		json(200, context?.clientId ?? null),
	);
	registerAssets(router, init.scope, init.assets);
	// a worker's questions about its site's permissions and devices, as the
	// site its route names (its partition's top, else its own origin)
	registerPermissionRoute(router, (url) => {
		try {
			const { pathname, protocol } = new URL(url);
			if (!/^https?:$/.test(protocol) || !pathname.startsWith(init.directory))
				return null;
			const partition = workerKindPartition(
				pathname.slice(init.directory.length).split('/')[0],
				init.codec,
			);
			return new URL(partition ? partition.slice(1) : realURL(url)).origin;
		} catch (error) {
			return null;
		}
	});
	// a body as the type the path names (messages.ts ECHO_ROUTE)
	router.routes.set(new RegExp(`^/${ECHO_ROUTE}/`), async (request, url) => {
		if (request.method !== 'POST') return new Response(null, { status: 405 });
		let type = 'text/plain';
		try {
			type = decodeURIComponent(url.slice(ECHO_ROUTE.length + 2));
		} catch (error) {
			// not a type: plain text
		}
		return new Response(await request.arrayBuffer(), {
			headers: { 'content-type': type, 'cache-control': 'no-store' },
		});
	});
	// the sealed copies' worker, for a document whose policy refuses one
	// from a blob: URL (messages.ts)
	router.routes.set(
		new RegExp(`^/${SEALER_ROUTE}$`),
		() =>
			new Response(SEALER_SOURCE, {
				headers: { 'content-type': 'text/javascript' },
			}),
	);
	const blocker: BlockerLike | undefined = !adblock
		? undefined
		: (remoteBlocker ??
			sharedBlocker(init.scope, adblock, new BareCompatibleClient(transport)));
	const shields = new ShieldsStore();
	const { route, setRules, hostReloaded } = registerRewrites(
		router,
		init,
		cookies,
		transport,
		cache,
		log,
		rewrites,
		pool,
		blocker,
		!adblock?.byDefault,
		shields,
		stores.storage,
	);
	if (blocker) registerBlocker(router, blocker);
	registerStorage(router, stores.storage, init.codec);
	registerMediaLoads(router);
	registerKeptLoads(router);
	registerIntegrityLoads(router);
	registerXhr(router);

	return {
		router,
		route,
		blocker,
		shields,
		setShields: (list, seed) => shields.set(list, seed),
		reloadBlocker: (next, force = false) =>
			blocker instanceof Blocker
				? reconfigureBlocker(init.scope, blocker, next, force)
				: Promise.resolve(),
		cookies,
		forgetStorage: (origin) => forgetSiteStorage(origin, stores.storage),
		clearCache: async () => {
			await cache?.clear();
			await rewrites?.clear();
			// and what the renderer keeps under the sites' marks is no later
			// document's (natively the renderers' memory caches go too)
			await renewCacheSecret();
		},
		setRules,
		hostReloaded,
		realURL,
		codec: init.codec,
		routeOf: (routed) => {
			try {
				const { resource, url } = parseRoutedURL(
					routed,
					init.codec,
					`${location.origin}${init.directory}`,
				);
				return { resource, url: url.toString(), codec: init.codec };
			} catch (error) {
				return null;
			}
		},
		routeAs: (kind, url) => {
			const prefix = `${location.origin}${init.directory}`;
			return `${prefix}${kind}/${new StompURL(url, init.codec, prefix).encode()}`;
		},
		linkOf,
		codecKey,
		linkRoute: (context, url) =>
			linkRoute(
				scopePrefix,
				init.codec,
				contextText(context, publicSuffix),
				url,
			),
	};
}

/**
 * Start the reads a request makes once per worker start, so that they run
 * side by side now rather than one after another in the first navigation's
 * way to the network: the emulated service workers' registrations (does
 * one control the page), the client hints' stores and the HTTP cache's.
 * Each is the same promise the request then waits on; a failure is left
 * to it.
 */
function warmStores(cache: HttpCache | undefined, workers: boolean) {
	const reads: Promise<unknown>[] = [warmClientHints()];
	if (workers) reads.push(serviceWorkers.any());
	if (cache) reads.push(cache.warm());
	for (const read of reads) read.catch(() => {});
}
