// An HTTP cache in front of the transport, in a Cache API store keyed by the
// real URL and the request's network partition (partitionedKey). Deliberately narrow: only GET/HEAD responses with explicit
// freshness, never for requests with credentials unless the response says
// `public`, no heuristics; stale entries revalidate with the validators the
// server gave, and a 304 refreshes them. Entries keep the upstream
// (pre-rewrite) body and headers, so the rewriters run on hits as on fetches.

const STORE = 'stomp-http-cache';
const ENTRY_LIMIT = 5 * 1024 * 1024;
const BUDGET = 50 * 1024 * 1024;
const CACHEABLE_STATUS = [200, 203, 204, 300, 301, 404, 410];
const STORED_AT = 'x-stomp-stored-at';
const SIZE = 'x-stomp-size';
const VARY = 'x-stomp-vary';

/**
 * The key an entry is kept under: the real URL, with the request's top-level
 * site and the site of the frame (or worker) that makes it, as Chrome keys
 * its HTTP cache (its network isolation key, measured in Chrome 152: a
 * resource another top-level site, or another frame site under the same top,
 * loaded is fetched again; B framed by A framed by B gets what B's top-level
 * page loaded). A Cache API key is a URL, so the three are put in one under
 * a host nothing resolves.
 */
export function partitionedKey(
	url: string,
	topSite: string,
	frameSite: string,
): string {
	return `https://partition.stomp.invalid/${encodeURIComponent(topSite)}/${encodeURIComponent(frameSite)}/${encodeURIComponent(url)}`;
}

export function parseCacheControl(value: string | null): Map<string, string> {
	const directives = new Map<string, string>();
	for (const part of (value || '').split(',')) {
		const [name, ...rest] = part.split('=');
		if (name.trim())
			directives.set(
				name.trim().toLowerCase(),
				rest.join('=').trim().replace(/^"|"$/g, ''),
			);
	}
	return directives;
}

/** seconds the response may be served without revalidation, or null when nothing explicit says so */
export function freshnessLifetime(headers: Headers): number | null {
	const control = parseCacheControl(headers.get('cache-control'));
	for (const name of ['s-maxage', 'max-age']) {
		const value = control.get(name);
		if (value !== undefined && /^\d+$/.test(value)) return Number(value);
	}
	const expires = headers.get('expires');
	if (expires !== null) {
		const date = Date.parse(headers.get('date') || '') || Date.now();
		const until = Date.parse(expires);
		return Number.isNaN(until) ? 0 : Math.max(0, (until - date) / 1000);
	}
	return null;
}

export interface Cacheability {
	method: string;
	requestHeaders: Headers;
	status: number;
	responseHeaders: Headers;
}

/**
 * Whether anything made from a response may be kept on disk at all: the
 * privacy rules of the HTTP cache (no credentials it was not told it may
 * keep, no `no-store` or `private` answer). The rewrite cache keeps its
 * output under the same rules.
 */
export function mayKeep({
	method,
	requestHeaders,
	status,
	responseHeaders,
}: Cacheability): boolean {
	if (method !== 'GET' && method !== 'HEAD') return false;
	if (requestHeaders.has('authorization')) return false;
	if (!CACHEABLE_STATUS.includes(status)) return false;
	const control = parseCacheControl(responseHeaders.get('cache-control'));
	if (control.has('no-store') || control.has('private')) return false;
	if ((responseHeaders.get('vary') || '').trim() === '*') return false;
	// a page fetched with cookies is personalised unless the server says not
	if ((requestHeaders.get('cookie') || '') !== '' && !control.has('public'))
		return false;
	return true;
}

/**
 * Whether the HTTP cache stores a response: what mayKeep allows, with a
 * size and an explicit freshness, and not `no-cache` (this cache does not
 * keep what it would have to revalidate every time). The rewrite cache keys
 * on the body it was just sent, so `no-cache` does not concern it.
 */
export function isCacheable(cacheability: Cacheability): boolean {
	if (!mayKeep(cacheability)) return false;
	const { responseHeaders } = cacheability;
	if (parseCacheControl(responseHeaders.get('cache-control')).has('no-cache'))
		return false;
	const length = Number(responseHeaders.get('content-length'));
	if (!Number.isFinite(length) || length < 0 || length > ENTRY_LIMIT)
		return false;
	return freshnessLifetime(responseHeaders) !== null;
}

export interface CacheHit {
	response: Response;
	fresh: boolean;
	/** never serve stale: `must-revalidate` / `proxy-revalidate` */
	mustRevalidate: boolean;
	etag: string | null;
	lastModified: string | null;
	/** seconds since the entry was stored */
	age: number;
	/** seconds past its freshness lifetime (0 while fresh) */
	staleFor: number;
	/** the window the origin allowed for serving stale while revalidating, in seconds */
	staleWhileRevalidate: number | null;
	/** the window the origin allowed for serving stale on an error, in seconds */
	staleIfError: number | null;
}

/** a directive's seconds, or null when absent or not a number */
function seconds(control: Map<string, string>, name: string): number | null {
	const value = control.get(name);
	return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

export class HttpCache {
	private cache?: Promise<Cache>;
	private bytes = -1;
	private open(): Promise<Cache> {
		return (this.cache ??= caches.open(STORE));
	}
	/** the request headers an entry was stored for, the ones its Vary names */
	static varyKey(vary: string | null, headers: Headers): string {
		const names = (vary || '')
			.split(',')
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean)
			.sort();
		return JSON.stringify(names.map((name) => [name, headers.get(name)]));
	}
	/** writes in flight, by URL: a request for the same URL waits for them */
	private pending = new Map<string, Promise<void>>();
	async match(url: string, requestHeaders: Headers): Promise<CacheHit | null> {
		// the entry a previous request is still writing (its body streams in)
		// counts as stored: a follow-up request must not race it upstream
		await this.pending.get(url);
		const cache = await this.open();
		const stored = await cache.match(url);
		if (!stored) return null;
		const headers = new Headers(stored.headers);
		if (
			headers.get(VARY) !== null &&
			headers.get(VARY) !==
				HttpCache.varyKey(headers.get('vary'), requestHeaders)
		)
			return null;
		const storedAt = Number(headers.get(STORED_AT));
		const lifetime = freshnessLifetime(headers) ?? 0;
		const age = (Date.now() - storedAt) / 1000;
		const control = parseCacheControl(headers.get('cache-control'));
		for (const name of [STORED_AT, SIZE, VARY]) headers.delete(name);
		// what a cache says about an entry it serves
		headers.set('age', String(Math.max(0, Math.round(age))));
		return {
			response: new Response(stored.body, {
				status: stored.status,
				statusText: stored.statusText,
				headers,
			}),
			fresh: age < lifetime,
			mustRevalidate:
				control.has('must-revalidate') || control.has('proxy-revalidate'),
			etag: headers.get('etag'),
			lastModified: headers.get('last-modified'),
			age,
			staleFor: Math.max(0, age - lifetime),
			staleWhileRevalidate: seconds(control, 'stale-while-revalidate'),
			staleIfError: seconds(control, 'stale-if-error'),
		};
	}
	/** background revalidations in flight, by URL: one per key however many stale hits arrive */
	private revalidating = new Map<string, Promise<void>>();
	/**
	 * Run `task` (a revalidation of `url`) unless one is already running for
	 * it; failures are swallowed, the stale entry simply stays.
	 */
	revalidateOnce(url: string, task: () => Promise<void>): Promise<void> {
		let pending = this.revalidating.get(url);
		if (!pending) {
			pending = task()
				.catch(() => {})
				.finally(() => {
					if (this.revalidating.get(url) === pending)
						this.revalidating.delete(url);
				});
			this.revalidating.set(url, pending);
		}
		return pending;
	}
	/** store the upstream response (its body stream is consumed) */
	put(
		url: string,
		requestHeaders: Headers,
		response: Response,
		body: ReadableStream<Uint8Array> | null,
	): Promise<void> {
		const write = this.write(url, requestHeaders, response, body).finally(
			() => {
				if (this.pending.get(url) === write) this.pending.delete(url);
			},
		);
		this.pending.set(url, write);
		return write;
	}
	private async write(
		url: string,
		requestHeaders: Headers,
		response: Response,
		body: ReadableStream<Uint8Array> | null,
	): Promise<void> {
		const headers = new Headers(response.headers);
		headers.delete('set-cookie');
		const size = Number(headers.get('content-length')) || 0;
		headers.set(STORED_AT, String(Date.now()));
		headers.set(SIZE, String(size));
		if (headers.has('vary'))
			headers.set(VARY, HttpCache.varyKey(headers.get('vary'), requestHeaders));
		const cache = await this.open();
		await cache.put(
			url,
			new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			}),
		);
		if (this.bytes < 0) await this.measure();
		this.bytes += size;
		if (this.bytes > BUDGET) await this.evict();
	}
	/** a 304: keep the body, take the fresher headers, start the clock again */
	async refresh(
		url: string,
		hit: CacheHit,
		notModified: Headers,
	): Promise<Response> {
		const cache = await this.open();
		const stored = await cache.match(url);
		if (!stored) return hit.response;
		const headers = new Headers(stored.headers);
		for (const [name, value] of notModified)
			if (
				!['content-length', 'content-type', 'transfer-encoding'].includes(name)
			)
				headers.set(name, value);
		headers.set(STORED_AT, String(Date.now()));
		const body = await stored.arrayBuffer();
		await cache.put(
			url,
			new Response(body, {
				status: stored.status,
				statusText: stored.statusText,
				headers,
			}),
		);
		for (const name of [STORED_AT, SIZE, VARY]) headers.delete(name);
		return new Response(body, {
			status: stored.status,
			statusText: stored.statusText,
			headers,
		});
	}
	async clear(): Promise<void> {
		this.cache = undefined;
		this.bytes = 0;
		await caches.delete(STORE);
	}
	private async measure() {
		const cache = await this.open();
		this.bytes = 0;
		for (const request of await cache.keys()) {
			const stored = await cache.match(request);
			this.bytes += Number(stored?.headers.get(SIZE)) || 0;
		}
	}
	/** drop the oldest entries until under budget */
	private async evict() {
		const cache = await this.open();
		const entries: [Request, number, number][] = [];
		for (const request of await cache.keys()) {
			const stored = await cache.match(request);
			entries.push([
				request,
				Number(stored?.headers.get(STORED_AT)) || 0,
				Number(stored?.headers.get(SIZE)) || 0,
			]);
		}
		entries.sort((a, b) => a[1] - b[1]);
		for (const [request, , size] of entries) {
			if (this.bytes <= BUDGET) break;
			await cache.delete(request);
			this.bytes -= size;
		}
	}
}

/**
 * The request destinations whose responses the browser keeps in a renderer's
 * memory cache and hands to another document of that renderer without asking
 * (images, scripts, stylesheets, fonts, text tracks)
 */
export const MEMORY_DESTINATIONS = new Set([
	'image',
	'script',
	'style',
	'font',
	'track',
]);

/** what the memory cache keeps in all, and of one response */
const MEMORY_BUDGET = 96 * 1024 * 1024;
const MEMORY_ENTRY_LIMIT = 24 * 1024 * 1024;

interface MemoryEntry {
	status: number;
	statusText: string;
	headers: [string, string][];
	body: ArrayBuffer;
	storedAt: number;
	/** seconds it stays fresh */
	lifetime: number;
	/** the request headers its Vary names, as HttpCache.varyKey has them */
	vary: string | null;
}

/**
 * The renderer's memory cache, as the worker keeps it for the proxied sites.
 * Natively each site's documents are in a renderer process of their own, and
 * its memory cache answers a fresh resource that site loaded before without
 * asking anyone; through the proxy every site's documents are in one
 * renderer, so the browser is handed these responses as `no-cache` (and
 * without validators) and comes back to the worker for each document, which
 * answers from here: per site of the document that asks, in memory, fresh
 * entries only, the least recently used going first past the budget. A miss
 * goes on to the HTTP cache (keyed by the network partition) and the
 * network.
 */
export class MemoryCache {
	#entries = new Map<string, MemoryEntry>();
	#bytes = 0;
	/**
	 * the key of `url` for documents of `site`, loaded with credentials or
	 * not (the renderer does not hand one to a load of the other mode)
	 */
	static key(site: string, credentials: boolean, url: string): string {
		return `${site} ${credentials ? 'c' : 'a'} ${url}`;
	}
	/** a fresh entry for `key` that the request's headers match, as a response */
	match(key: string, requestHeaders: Headers): Response | null {
		const entry = this.#entries.get(key);
		if (!entry) return null;
		const age = (Date.now() - entry.storedAt) / 1000;
		if (age >= entry.lifetime) {
			this.#drop(key, entry);
			return null;
		}
		const headers = new Headers(entry.headers);
		if (
			entry.vary !== null &&
			entry.vary !== HttpCache.varyKey(headers.get('vary'), requestHeaders)
		)
			return null;
		// the most recently used last
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		headers.set('age', String(Math.max(0, Math.round(age))));
		return new Response(entry.body, {
			status: entry.status,
			statusText: entry.statusText,
			headers,
		});
	}
	/** whether a response is one to keep: a fresh 200 of a size it takes */
	static keeps(status: number, headers: Headers): boolean {
		if (status !== 200) return false;
		const control = parseCacheControl(headers.get('cache-control'));
		if (control.has('no-store') || control.has('no-cache')) return false;
		if ((headers.get('vary') || '').trim() === '*') return false;
		const lifetime = freshnessLifetime(headers);
		if (lifetime === null || lifetime <= 0) return false;
		return !(Number(headers.get('content-length')) > MEMORY_ENTRY_LIMIT);
	}
	/** keep `body` (a branch of the response's) under `key`, once it is read */
	async put(
		key: string,
		requestHeaders: Headers,
		response: Response,
		body: ReadableStream<Uint8Array>,
	): Promise<void> {
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MEMORY_ENTRY_LIMIT) {
				await reader.cancel();
				return;
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const headers = new Headers(response.headers);
		headers.delete('set-cookie');
		const old = this.#entries.get(key);
		if (old) this.#drop(key, old);
		this.#entries.set(key, {
			status: response.status,
			statusText: response.statusText,
			headers: [...headers],
			body: bytes.buffer,
			storedAt: Date.now(),
			// what is left of it: an HTTP cache hit has aged already
			lifetime:
				(freshnessLifetime(headers) ?? 0) - (Number(headers.get('age')) || 0),
			vary: headers.has('vary')
				? HttpCache.varyKey(headers.get('vary'), requestHeaders)
				: null,
		});
		this.#bytes += size;
		for (const [oldest, entry] of this.#entries) {
			if (this.#bytes <= MEMORY_BUDGET) break;
			this.#drop(oldest, entry);
		}
	}
	#drop(key: string, entry: MemoryEntry) {
		this.#entries.delete(key);
		this.#bytes -= entry.body.byteLength;
	}
	clear() {
		this.#entries.clear();
		this.#bytes = 0;
	}
}

/** the renderer's memory cache, one for every controller of this worker */
export const memoryCache = new MemoryCache();
