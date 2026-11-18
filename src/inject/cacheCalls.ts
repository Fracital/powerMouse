// What a page's Cache API calls do past their hooks' checks
// (modules/Partition.ts): add() and addAll() fetch through the proxy and
// keep what came back, and caches.match() looks in this origin's caches
// only, in the order they were made, as the browser looks in the origin's
// (natively it would search every proxied site's caches and STomp's own
// HTTP cache, whose entries are keyed by the real URLs and hold the
// origin's raw bodies). A deferred part of the document bundle
// (./dom/deferredParts.ts), made at a realm's first such call before the
// browser is asked anything; the worker bundle has it itself
// (./cacheCallParts.ts). Its top level reads no global.
import type Client from './Client';
import { cacheableResponse } from './modules/Fetch';
import { redirected } from './storageRedirect';

/** what the part reads of the Partition module's scope */
export interface CacheCallsContext {
	global: typeof globalThis;
	asRequest: (input: unknown) => Request;
	/** the browser's Cache.prototype.put, CacheStorage.prototype's keys, open and has */
	put: Function;
	keys: Function;
	open: Function;
	has: Function;
	client: Client;
	/** a cache name of the page's under the key `key` */
	scoped: (name: unknown, key: string) => string;
}

/** the part's calls, for one realm */
export function cacheCalls({
	global,
	asRequest,
	put,
	keys,
	open,
	has,
	client,
	scoped,
}: CacheCallsContext) {
	return {
		/** addAll(), and add() as one request's */
		async addAll(that: Cache, list: unknown): Promise<void> {
			const requests = [...(list as Iterable<unknown>)].map(asRequest);
			const responses = await Promise.all(
				requests.map((request) => global.fetch(request)),
			);
			for (const [index, response] of responses.entries()) {
				if (!response.ok)
					throw new TypeError(
						`Failed to execute 'addAll' on 'Cache': Request failed`,
					);
				await Reflect.apply(put, that, [
					requests[index],
					cacheableResponse(response),
				]);
			}
		},
		/** caches.match() */
		async match(
			receiver: unknown,
			args: unknown[],
		): Promise<Response | undefined> {
			const [that, key] = redirected(receiver, client.storageKey);
			if (args.length && args[0] !== undefined) args[0] = asRequest(args[0]);
			const options = args[1] as MultiCacheQueryOptions | undefined;
			const names =
				options?.cacheName !== undefined
					? (await Reflect.apply(has, that, [scoped(options.cacheName, key)]))
						? [scoped(options.cacheName, key)]
						: []
					: ((await Reflect.apply(keys, that, [])) as string[]).filter((name) =>
							name.endsWith(`@${key}`),
						);
			for (const name of names) {
				const cache = (await Reflect.apply(open, that, [name])) as Cache;
				const hit = await cache.match(args[0] as RequestInfo, options);
				if (hit) return hit;
			}
			return undefined;
		},
	};
}

export type CacheCalls = ReturnType<typeof cacheCalls>;
