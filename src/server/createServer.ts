import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { openDB } from 'idb';
import { Config, generateConfigCodecKey, parseConfig } from '../config';
import { registerCookies } from './Cookies';
import { registerRewrites } from './rewrites';
import Router from './Router';
import { registerStorage } from './Storage';
import { registerXhr } from './Sync';

export interface StompServer {
	router: Router;
	/** turn a URL into the proxied URL a frame should navigate to */
	route(url: string): string;
}

export default async function createServer(
	config: Config,
	transport: ProxyTransport,
): Promise<StompServer> {
	const db = await openDB('stompConfig', 1, {
		upgrade: (db) => {
			db.createObjectStore('consts');
		},
	});

	const tx = db.transaction('consts', 'readwrite');
	const store = tx.objectStore('consts');

	if (!(await store.get(`codecKey:${config.codec}`))) {
		await store.put(
			generateConfigCodecKey(config.codec),
			`codecKey:${config.codec}`,
		);
	}

	const codecKey = await store.get(`codecKey:${config.codec}`);

	await tx.done;

	const init = parseConfig(config, codecKey);

	const router = new Router(init.directory);

	const cookies = await registerCookies(router);
	const { route } = registerRewrites(router, init, cookies, transport);
	await registerStorage(router);
	registerXhr(router);

	return { router, route };
}
