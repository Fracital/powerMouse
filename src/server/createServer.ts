import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { IDBPDatabase, openDB } from 'idb';
import {
	Config,
	ConfigCodec,
	generateConfigCodecKey,
	parseConfig,
} from '../config';
import { parseRoutedURL } from '../routeURL';
import type { RequestInfo, RequestRule } from '../transport/messages';
import { HttpCache } from './cache';
import Cookies, { openCookies, registerCookies } from './Cookies';
import { hostErrorPage } from './errorPage';
import { registerRewrites } from './rewrites';
import Router, { json } from './Router';
import { openStorage, registerStorage, StorageHosts } from './Storage';
import { registerXhr } from './Sync';

export interface StompServer {
	router: Router;
	/** turn a URL into the proxied URL a frame should navigate to */
	route(url: string): string;
	/** drop every entry of the HTTP cache (a no-op when it is off) */
	clearCache(): Promise<void>;
	/** the cookie jar, for the host's cookies API */
	cookies: Cookies;
	/** replace the host's request rules */
	setRules(rules: RequestRule[]): void;
	/** the real URL of a routed one; the input when it is not routed */
	realURL(routed: string): string;
}

/**
 * What the controllers of one scope share: a controller is a tab, not a
 * browser, so two host tabs on one scope see the same cookies, the same
 * cache and the same storage partitions. Opened once per scope; the servers
 * register their own routes over the shared instances.
 */
interface SharedStores {
	cookies: Cookies;
	cache: HttpCache;
	storage: StorageHosts;
}

const shared = new Map<string, Promise<SharedStores>>();

function sharedStores(scope: string): Promise<SharedStores> {
	let stores = shared.get(scope);
	if (!stores) {
		stores = (async () => ({
			cookies: await openCookies(),
			cache: new HttpCache(),
			storage: await openStorage(),
		}))();
		// a failure to open is not kept: the next server tries again
		stores.catch(() => shared.delete(scope));
		shared.set(scope, stores);
	}
	return stores;
}

/** the worker's own settings: the codec keys and the codec of every address it served */
export function openConfigDB(): Promise<IDBPDatabase> {
	return openDB('stompConfig', 1, {
		upgrade: (db) => {
			db.createObjectStore('consts');
		},
	});
}

const CODECS: ConfigCodec[] = ['generic', 'xor', 'aes', 'base64'];

/**
 * The codec of the controller that was (or is) registered at `directory`,
 * remembered when its server was created, so a routed URL whose controller
 * is gone can be handed to a live controller of the same codec. Undefined
 * for an address this worker never served.
 */
export async function addressCodec(
	directory: string,
): Promise<ConfigCodec | undefined> {
	const db = await openConfigDB();
	const codec = await db.get('consts', `controller:${directory}`);
	return CODECS.includes(codec) ? codec : undefined;
}

export default async function createServer(
	config: Config,
	transport: ProxyTransport,
	log?: (info: RequestInfo) => void,
): Promise<StompServer> {
	const db = await openConfigDB();

	const tx = db.transaction('consts', 'readwrite');
	const store = tx.objectStore('consts');

	// an IndexedDB transaction commits during any other await, so nothing
	// but the store may be awaited until tx.done
	let newKey = false;
	if (!(await store.get(`codecKey:${config.codec}`))) {
		await store.put(
			generateConfigCodecKey(config.codec),
			`codecKey:${config.codec}`,
		);
		newKey = true;
	}

	const codecKey = await store.get(`codecKey:${config.codec}`);
	// the address's codec outlives the controller (see addressCodec)
	await store.put(config.codec, `controller:${config.directory}`);

	await tx.done;

	// routed URLs change with the key; nothing cached is reachable anymore
	if (newKey) await new HttpCache().clear();

	const init = parseConfig(config, codecKey);
	const stores = await sharedStores(init.scope);

	const router = new Router(init.directory);
	const realURL = (routed: string): string => {
		try {
			return parseRoutedURL(
				routed,
				init.codec,
				`${location.origin}${init.directory}`,
			).url.toString();
		} catch (error) {
			return routed;
		}
	};
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
	// a page asks who it is (its service worker client id) and reports it to
	// the host, so the host can attribute requests to frames
	router.routes.set(/^\/whoami$/, (request, url, context) =>
		json(200, context?.clientId ?? null),
	);
	const { route, setRules } = registerRewrites(
		router,
		init,
		cookies,
		transport,
		cache,
		log,
	);
	registerStorage(router, stores.storage);
	registerXhr(router);

	return {
		router,
		route,
		cookies,
		clearCache: async () => {
			await cache?.clear();
		},
		setRules,
		realURL,
	};
}
