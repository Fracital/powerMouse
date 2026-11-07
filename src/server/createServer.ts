import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { openDB } from 'idb';
import { Config, generateConfigCodecKey, parseConfig } from '../config';
import { parseRoutedURL } from '../routeURL';
import type { RequestInfo, RequestRule } from '../transport/messages';
import { HttpCache } from './cache';
import Cookies, { registerCookies } from './Cookies';
import { hostErrorPage } from './errorPage';
import { registerRewrites } from './rewrites';
import Router, { json } from './Router';
import { registerStorage } from './Storage';
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

export default async function createServer(
	config: Config,
	transport: ProxyTransport,
	log?: (info: RequestInfo) => void,
): Promise<StompServer> {
	const db = await openDB('stompConfig', 1, {
		upgrade: (db) => {
			db.createObjectStore('consts');
		},
	});

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

	await tx.done;

	// routed URLs change with the key; nothing cached is reachable anymore
	if (newKey) await new HttpCache().clear();

	const init = parseConfig(config, codecKey);

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

	const cookies = await registerCookies(router);
	const cache = config.cache === false ? undefined : new HttpCache();
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
	await registerStorage(router);
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
