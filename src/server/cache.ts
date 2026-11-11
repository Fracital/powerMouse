// An HTTP cache in front of the transport, in a Cache API store keyed by the
// real URL and the request's network partition (partitionedKey). It keeps
// what Chrome's HTTP cache keeps and asks the origin when Chrome's does
// (docs/http-cache.md has the table, measured in Chrome 152 and 156): a
// response with a freshness lifetime (max-age, Expires, a tenth of its age
// by Last-Modified, a permanent redirect) is used without asking while it
// is fresh, and one that is stale, `no-cache`, or made for other request
// headers than its Vary names is used only once the origin has confirmed
// it with a 304 to the validators it gave. Anything else but `no-store` is
// kept too, for a request that takes an entry however stale
// (`force-cache`). A 206 is kept as a part of the resource (Part), and a
// later request is given the bytes it holds, confirmed, with the rest asked
// for by range, until the parts make the whole. One difference is kept on
// purpose: an
// entry made for a request with credentials (a Cookie or Authorization
// header) is confirmed with the origin before a request with other
// credentials is given it, where Chrome hands it over; the proxy's cache
// outlives what a site takes for a session. Entries keep the upstream
// (pre-rewrite) body and headers, so the rewriters run on hits as on fetches.

const STORE = 'stomp-http-cache';
const ENTRY_LIMIT = 5 * 1024 * 1024;
const BUDGET = 50 * 1024 * 1024;
/** the share of the budget an eviction leaves */
const EVICT_TO = 0.8;
const CACHEABLE_STATUS = [200, 203, 204, 300, 301, 404, 410];
const STORED_AT = 'x-stomp-stored-at';
const SIZE = 'x-stomp-size';
const VARY = 'x-stomp-vary';
/**
 * a `Vary` that names `*`, while the entry is in the store: the Cache API
 * refuses a response that carries one
 */
const VARY_ALL = 'x-stomp-vary-all';
/** a digest of the credentials the entry's request carried (credentialsKey) */
const CREDENTIALS = 'x-stomp-credentials';
/** the bytes an entry kept from a 206 holds, `<from>-<to>/<size>` (Part) */
const PART = 'x-stomp-part';
/** the headers an entry carries for the cache alone */
const OWN = [STORED_AT, SIZE, VARY, VARY_ALL, CREDENTIALS, PART];
/** statuses that are never kept: no content, a part, a confirmation, a challenge */
const NEVER_KEPT = [204, 206, 304, 401, 407];
/** statuses whose answer holds until the origin says otherwise (Chrome's heuristic) */
const PERMANENT = [300, 301, 308, 410];
/** statuses a freshness lifetime is made up for from Last-Modified */
const HEURISTIC = [200, 203];

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

/**
 * Whether the response is to be confirmed with the origin before every use:
 * `no-cache` without field names (`no-cache="set-cookie"` is about that
 * header only), or `Pragma: no-cache` (Chrome heeds it on a response beside
 * any Cache-Control)
 */
export function alwaysRevalidated(headers: Headers): boolean {
	return (
		parseCacheControl(headers.get('cache-control')).get('no-cache') === '' ||
		/(^|,)\s*no-cache\s*(,|$)/i.test(headers.get('pragma') || '')
	);
}

/**
 * Whether the origin can confirm a kept response: Chrome sends a conditional
 * request for a 200 that came with an ETag or a Last-Modified, and for no
 * other status
 */
export function hasValidator(status: number, headers: Headers): boolean {
	return (
		status === 200 && (headers.has('etag') || headers.has('last-modified'))
	);
}

/**
 * Seconds the response may be served without revalidation, as Chrome
 * reckons them, or null when nothing says: max-age (a browser's cache is
 * not a shared one: s-maxage is not for it), Expires, then for a 200 or 203
 * a tenth of the time since its Last-Modified, and for a permanent redirect
 * (and 300, 410) no end. `at` is when the response was received, for one
 * without a Date.
 */
export function freshnessLifetime(
	headers: Headers,
	status = 200,
	at = Date.now(),
): number | null {
	const control = parseCacheControl(headers.get('cache-control'));
	const value = control.get('max-age');
	if (value !== undefined && /^\d+$/.test(value)) return Number(value);
	const date = Date.parse(headers.get('date') || '') || at;
	const expires = headers.get('expires');
	if (expires !== null) {
		const until = Date.parse(expires);
		return Number.isNaN(until) ? 0 : Math.max(0, (until - date) / 1000);
	}
	if (HEURISTIC.includes(status)) {
		const modified = Date.parse(headers.get('last-modified') || '');
		if (!Number.isNaN(modified) && modified <= date)
			return (date - modified) / 1000 / 10;
	}
	if (PERMANENT.includes(status)) return Infinity;
	return null;
}

/** a digest of the credentials a request carries, '' for none (not the credentials: an entry says only whether they were the same) */
export function credentialsKey(headers: Headers): string {
	const text = `${headers.get('cookie') || ''}\n${headers.get('authorization') || ''}`;
	if (text === '\n') return '';
	// two FNV-1a passes with different offsets: 64 bits between them
	let a = 0x811c9dc5;
	let b = 0x01000193;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a = Math.imul(a ^ code, 0x01000193);
		b = Math.imul(b ^ code, 0x811c9dc5) + 0x9e3779b9;
	}
	return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
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
 * Whether the HTTP cache stores a response, as Chrome's does: any answer
 * to a GET but `no-store`, a part (isPartCacheable), a challenge or one
 * too large; one with neither time to live nor a validator is for a
 * request that takes a stale entry (`force-cache`). Not one with `Vary: *`
 * and no validator, which no request could be given. A request's
 * credentials do not keep its answer out (the cache is this browser's own,
 * and `private` is for it); match() says when they stand in the way of
 * using it. The rewrite cache has rules of its own (mayKeep).
 */
export function isCacheable({
	method,
	status,
	responseHeaders,
}: Cacheability): boolean {
	if (method !== 'GET') return false;
	if (status < 200 || NEVER_KEPT.includes(status)) return false;
	const control = parseCacheControl(responseHeaders.get('cache-control'));
	if (control.has('no-store')) return false;
	const length = Number(responseHeaders.get('content-length'));
	if (!Number.isFinite(length) || length < 0 || length > ENTRY_LIMIT)
		return false;
	if (hasValidator(status, responseHeaders)) return true;
	return !(responseHeaders.get('vary') || '')
		.split(',')
		.some((name) => name.trim() === '*');
}

/** a run of a resource's bytes, `from` to `to` inclusive, of `size` in all */
export interface Part {
	from: number;
	to: number;
	size: number;
}

/** the bytes a 206's Content-Range says it holds, null when it says no size */
export function contentRange(value: string | null): Part | null {
	const said = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(value ?? '');
	if (!said) return null;
	const [from, to, size] = said.slice(1).map(Number);
	return from <= to && to < size ? { from, to, size } : null;
}

/**
 * The one run of a `size`-byte resource a Range header asks for, as a
 * Part: null when it asks for none, undefined for one this does not take
 * (several, another unit, or past the end)
 */
export function askedRange(
	value: string | null,
	size: number,
): Part | null | undefined {
	if (value === null) return null;
	const asked = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(value);
	if (!asked || (!asked[1] && !asked[2])) return undefined;
	let from: number;
	let to: number;
	if (!asked[1]) {
		// the last bytes
		from = Math.max(0, size - Number(asked[2]));
		to = size - 1;
	} else {
		from = Number(asked[1]);
		to = asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1;
	}
	return from <= to && from < size ? { from, to, size } : undefined;
}

/**
 * Whether a 206 is kept as a part of its resource, as Chrome keeps one: to
 * a GET, not `no-store`, with the size its Content-Range gives, and a
 * strong validator to have the rest confirmed against
 */
export function isPartCacheable({
	method,
	status,
	responseHeaders,
}: Cacheability): boolean {
	if (method !== 'GET' || status !== 206) return false;
	if (parseCacheControl(responseHeaders.get('cache-control')).has('no-store'))
		return false;
	const part = contentRange(responseHeaders.get('content-range'));
	if (!part || part.size > ENTRY_LIMIT) return false;
	if ((responseHeaders.get('vary') || '').includes('*')) return false;
	const etag = responseHeaders.get('etag');
	return (
		(etag !== null && !/^W\//.test(etag)) ||
		responseHeaders.has('last-modified')
	);
}

/** whether two responses' validators say they are of one version */
export function sameVersion(a: Headers, b: Headers): boolean {
	const etag = a.get('etag');
	if (etag !== null) return etag === b.get('etag');
	const modified = a.get('last-modified');
	return modified !== null && modified === b.get('last-modified');
}

export interface CacheHit {
	response: Response;
	fresh: boolean;
	/**
	 * the origin has to confirm it before this request is given it, fresh
	 * or not: it is `no-cache`, or was made for other request headers than
	 * its Vary names (Chrome asks with the entry's validators then, rather
	 * than fetch anew), or for other credentials
	 */
	revalidate: boolean;
	/**
	 * it was made for another request than this one (what its Vary names,
	 * or the credentials): not even a request that takes a stale entry
	 * (`force-cache`) is given it unconfirmed
	 */
	mismatch: boolean;
	/** never serve stale: `must-revalidate` / `proxy-revalidate` */
	mustRevalidate: boolean;
	etag: string | null;
	lastModified: string | null;
	/** seconds since the origin made the response: since it was stored, and its Age then */
	age: number;
	/** seconds past its freshness lifetime (0 while fresh) */
	staleFor: number;
	/** the window the origin allowed for serving stale while revalidating, in seconds */
	staleWhileRevalidate: number | null;
	/**
	 * the bytes it holds when it was kept from a 206 (its response's body is
	 * those bytes alone, its status 200); null for a whole response
	 */
	part: Part | null;
}

/** a body read whole, null when it is over the entry limit (the rest is dropped) */
async function wholeBody(
	body: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer | null> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > ENTRY_LIMIT) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes.buffer;
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
	/** the request headers an entry was stored for, the ones its Vary names (`*`: what no request has) */
	static varyKey(vary: string | null, headers: Headers): string {
		const names = (vary || '')
			.split(',')
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean)
			.sort();
		if (names.includes('*')) return `* ${Date.now()} ${Math.random()}`;
		return JSON.stringify(names.map((name) => [name, headers.get(name)]));
	}
	/** a `Vary: *` goes into the store under another name (VARY_ALL) */
	private static hideVaryAll(headers: Headers) {
		const vary = headers.get('vary');
		if (vary === null || !vary.split(',').some((name) => name.trim() === '*'))
			return;
		headers.set(VARY_ALL, vary);
		headers.delete('vary');
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
		if (headers.has(VARY_ALL)) headers.set('vary', headers.get(VARY_ALL)!);
		const control = parseCacheControl(headers.get('cache-control'));
		const made = headers.get(CREDENTIALS) || '';
		const mismatch =
			// (`Vary: *` names what no request can match)
			(headers.get(VARY) !== null &&
				headers.get(VARY) !==
					HttpCache.varyKey(headers.get('vary'), requestHeaders)) ||
			// made for a request with credentials, and this one has others
			(made !== '' &&
				!control.has('public') &&
				made !== credentialsKey(requestHeaders));
		const revalidate = alwaysRevalidated(headers) || mismatch;
		// made for another request, and nothing to confirm it with: there is
		// no entry for this request (one that is `no-cache` and has none is
		// still for a request that takes a stale entry)
		const validator = hasValidator(stored.status, headers);
		if (mismatch && !validator) return null;
		const part = contentRange(
			headers.has(PART) ? `bytes ${headers.get(PART)}` : null,
		);
		const storedAt = Number(headers.get(STORED_AT));
		const lifetime = freshnessLifetime(headers, stored.status, storedAt) ?? 0;
		// (with the age it arrived with: what a cache on the way had kept)
		const age =
			(Date.now() - storedAt) / 1000 + (Number(headers.get('age')) || 0);
		for (const name of OWN) headers.delete(name);
		// what a cache says about an entry it serves
		headers.set('age', String(Math.max(0, Math.round(age))));
		return {
			response: new Response(stored.body, {
				status: stored.status,
				statusText: stored.statusText,
				headers,
			}),
			fresh: age < lifetime,
			revalidate,
			mismatch,
			mustRevalidate:
				control.has('must-revalidate') || control.has('proxy-revalidate'),
			etag: validator ? headers.get('etag') : null,
			lastModified: validator ? headers.get('last-modified') : null,
			age,
			staleFor: Math.max(0, age - lifetime),
			staleWhileRevalidate: seconds(control, 'stale-while-revalidate'),
			part,
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
	/**
	 * store the upstream response (its body stream is consumed); one the
	 * store does not take is not kept, and that is all
	 */
	put(
		url: string,
		requestHeaders: Headers,
		response: Response,
		body: ReadableStream<Uint8Array> | null,
		part?: Part,
	): Promise<void> {
		const write = this.write(url, requestHeaders, response, body, part)
			.catch(() => {})
			.finally(() => {
				if (this.pending.get(url) === write) this.pending.delete(url);
			});
		this.pending.set(url, write);
		return write;
	}
	private async write(
		url: string,
		requestHeaders: Headers,
		response: Response,
		body: ReadableStream<Uint8Array> | null,
		part?: Part,
	): Promise<void> {
		const headers = new Headers(response.headers);
		headers.delete('set-cookie');
		// (the cache's own names are its own: an origin that sends one says nothing)
		for (const name of OWN) headers.delete(name);
		if (part) headers.set(PART, `${part.from}-${part.to}/${part.size}`);
		let size = Number(headers.get('content-length')) || 0;
		let kept: ReadableStream<Uint8Array> | ArrayBuffer | null = body;
		// a body that does not say its length is read first: the budget counts
		// what it is, and one over the entry limit is not kept
		if (body && !headers.has('content-length')) {
			kept = await wholeBody(body);
			if (kept === null) return;
			size = kept.byteLength;
		}
		headers.set(STORED_AT, String(Date.now()));
		headers.set(SIZE, String(size));
		if (headers.has('vary'))
			headers.set(VARY, HttpCache.varyKey(headers.get('vary'), requestHeaders));
		const credentials = credentialsKey(requestHeaders);
		if (credentials) headers.set(CREDENTIALS, credentials);
		HttpCache.hideVaryAll(headers);
		const cache = await this.open();
		await cache.put(
			url,
			new Response(kept, {
				status: response.status,
				statusText: response.statusText,
				headers,
			}),
		);
		if (this.bytes < 0) await this.measure();
		this.bytes += size;
		if (this.bytes > BUDGET) await this.evict();
	}
	/**
	 * a 304: keep the body, take the fresher headers, start the clock again.
	 * The entry is from here on the answer to the request that was confirmed
	 * (`requestHeaders`: what its Vary names, its credentials).
	 */
	/**
	 * keep `bytes`, the `part` of the resource a 206 (`response`, its
	 * headers) gave: with the part already kept when the two are of one
	 * version and meet, and as the whole response once they make it. A
	 * whole response kept of the same version stays as it is.
	 */
	async putPart(
		url: string,
		requestHeaders: Headers,
		response: Response,
		bytes: Uint8Array,
		part: Part,
	): Promise<void> {
		await this.pending.get(url);
		const cache = await this.open();
		const stored = await cache.match(url).catch(() => undefined);
		let { from, to } = part;
		let body = bytes;
		if (stored && sameVersion(stored.headers, response.headers)) {
			const was = contentRange(
				stored.headers.has(PART) ? `bytes ${stored.headers.get(PART)}` : null,
			);
			if (!was) {
				// the whole is kept already
				await stored.body?.cancel().catch(() => {});
				return;
			}
			if (was.size === part.size && was.from <= to + 1 && from <= was.to + 1) {
				const old = new Uint8Array(await stored.arrayBuffer());
				const first = Math.min(from, was.from);
				const last = Math.max(to, was.to);
				body = new Uint8Array(last - first + 1);
				body.set(old, was.from - first);
				body.set(bytes, from - first);
				from = first;
				to = last;
			}
		}
		const headers = new Headers(response.headers);
		headers.delete('content-range');
		headers.set('content-length', String(body.byteLength));
		const whole = from === 0 && to === part.size - 1;
		await this.put(
			url,
			requestHeaders,
			new Response(null, { status: 200, headers }),
			new Response(body as Uint8Array<ArrayBuffer>).body,
			whole ? undefined : { from, to, size: part.size },
		);
	}
	async refresh(
		url: string,
		hit: CacheHit,
		notModified: Headers,
		requestHeaders: Headers,
	): Promise<Response> {
		const cache = await this.open();
		const stored = await cache.match(url);
		if (!stored) return hit.response;
		const headers = new Headers(stored.headers);
		if (headers.has(VARY_ALL)) headers.set('vary', headers.get(VARY_ALL)!);
		headers.delete(VARY_ALL);
		// (confirmed now: its age is the 304's, none when it says none)
		headers.delete('age');
		for (const [name, value] of notModified)
			if (
				!['content-length', 'content-type', 'transfer-encoding'].includes(name)
			)
				headers.set(name, value);
		headers.set(STORED_AT, String(Date.now()));
		if (headers.has('vary'))
			headers.set(VARY, HttpCache.varyKey(headers.get('vary'), requestHeaders));
		else headers.delete(VARY);
		const credentials = credentialsKey(requestHeaders);
		if (credentials) headers.set(CREDENTIALS, credentials);
		else headers.delete(CREDENTIALS);
		const vary = headers.get('vary');
		HttpCache.hideVaryAll(headers);
		const body = await stored.arrayBuffer();
		await cache.put(
			url,
			new Response(body, {
				status: stored.status,
				statusText: stored.statusText,
				headers,
			}),
		);
		for (const name of OWN) headers.delete(name);
		if (vary !== null) headers.set('vary', vary);
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
	/** drop the entry kept under `url` */
	async drop(url: string): Promise<void> {
		await this.pending.get(url);
		const cache = await this.open();
		const stored = await cache.match(url);
		if (await cache.delete(url))
			this.bytes -= Number(stored?.headers.get(SIZE)) || 0;
	}
	/** drop what is kept of `origin`'s responses, in every partition (Clear-Site-Data: "cache") */
	async clearOrigin(origin: string): Promise<void> {
		const cache = await this.open();
		for (const request of await cache.keys()) {
			let kept: string;
			try {
				// (partitionedKey: the real URL is the last segment)
				kept = new URL(
					decodeURIComponent(
						request.url.slice(request.url.lastIndexOf('/') + 1),
					),
				).origin;
			} catch (error) {
				continue;
			}
			if (kept !== origin) continue;
			await this.pending.get(request.url);
			const stored = await cache.match(request);
			if (await cache.delete(request))
				this.bytes -= Number(stored?.headers.get(SIZE)) || 0;
		}
	}
	private async measure() {
		const cache = await this.open();
		this.bytes = 0;
		for (const request of await cache.keys()) {
			const stored = await cache.match(request);
			this.bytes += Number(stored?.headers.get(SIZE)) || 0;
		}
	}
	/**
	 * drop the oldest entries until well under budget (so the next writes
	 * do not each walk the store), counting anew what is kept (an entry a
	 * write replaced was counted twice)
	 */
	private async evict() {
		const cache = await this.open();
		const entries: [Request, number, number][] = [];
		let bytes = 0;
		for (const request of await cache.keys()) {
			const stored = await cache.match(request);
			const size = Number(stored?.headers.get(SIZE)) || 0;
			bytes += size;
			entries.push([
				request,
				Number(stored?.headers.get(STORED_AT)) || 0,
				size,
			]);
		}
		this.bytes = bytes;
		entries.sort((a, b) => a[1] - b[1]);
		for (const [request, , size] of entries) {
			if (this.bytes <= BUDGET * EVICT_TO) break;
			await cache.delete(request);
			this.bytes -= size;
		}
	}
}

/**
 * What a kept 200 makes of a request for one range of its bytes, as
 * Chrome's cache answers it: a 206 of those bytes. Null when the request
 * names no range, or one this does not take (several, or past the end):
 * the whole entry goes then, which a server may answer too.
 */
export async function byteRange(
	response: Response,
	range: string | null,
): Promise<Response | null> {
	if (range === null || response.status !== 200) return null;
	const body = new Uint8Array(await response.clone().arrayBuffer());
	const size = body.byteLength;
	const asked = askedRange(range, size);
	if (!asked) return null;
	const { from, to } = asked;
	await response.body?.cancel().catch(() => {});
	const headers = new Headers(response.headers);
	headers.set('content-range', `bytes ${from}-${to}/${size}`);
	headers.set('content-length', String(to - from + 1));
	return new Response(body.slice(from, to + 1), {
		status: 206,
		statusText: 'Partial Content',
		headers,
	});
}

/**
 * Whether a Clear-Site-Data header tells the browser to drop what its
 * caches keep of the origin: the "cache" type, or "*"
 */
export function clearsCache(header: string | null): boolean {
	return (header || '')
		.split(',')
		.some((type) => /^\s*"(cache|\*)"\s*$/.test(type));
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
		if (control.has('no-store') || alwaysRevalidated(headers)) return false;
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
	/** the origin of the URL a key() is for, null when it is not one */
	static origin(key: string): string | null {
		// (the URL is what follows the site and the mode)
		const url = key.slice(key.indexOf(' ', key.indexOf(' ') + 1) + 1);
		try {
			return new URL(url).origin;
		} catch (error) {
			return null;
		}
	}
	/** drop what is kept of `origin`'s responses, for every site (Clear-Site-Data: "cache") */
	clearOrigin(origin: string) {
		for (const [key, entry] of this.#entries)
			if (MemoryCache.origin(key) === origin) this.#drop(key, entry);
	}
}

/** the renderer's memory cache, one for every controller of this worker */
export const memoryCache = new MemoryCache();
