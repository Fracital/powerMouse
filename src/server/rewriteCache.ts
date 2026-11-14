// A cache of the rewriter's output for scripts, in a Cache API store, made
// under a digest of everything the output depends on: the response body's
// bytes (a hit decodes nothing), the URL (the output names it), the script
// type, the config the page gets (helper names, flags) with the codec's
// key, the rewriter's generation (src/version.ts REWRITE_GENERATION, the
// identity of the rewriter that made it), and the partition it was made for
// (the top-level site, the site of the frame or worker that asked, and
// whether the request had credentials, as the HTTP cache is kept): what one
// site's page loaded is never another's, not even as the time a rewrite did
// not take. A worker of another generation drops the whole store when it
// activates (adopt), and keeps it when the generation is the same (a deploy
// that did not touch the rewriter): a revisit after it comes back warm,
// where before every activation dropped it. A document's inline script is
// kept under its digest. A script the page loads is kept under the routed
// URL it was asked for, as the response it was given, with its digest
// (matchServed): a hit is answered with the store's own Response, which is
// what lets Chrome keep the script's compiled code (V8's code cache) for
// the next visit. A URL has one entry: when another partition's load takes
// its place the one that was there moves under its digest, and comes back
// from it without a rewrite. A repeat visit, or the browser fetching the
// same script twice skips the rewrite; anything that would change the
// output misses. It keeps only what the HTTP cache's privacy rules allow
// (see mayKeep), at most LIMIT entries of ENTRY_LIMIT each and TOTAL_LIMIT
// in all (the oldest put go first: eviction by age, not use), and is
// cleared with the HTTP cache. Sizes are counted in characters, which for a
// script is about its bytes. An entry could be 8 MB at most, which kept no
// output of Discord's 13 MB bundle and, since a rewritten script carries
// its text for its functions' sources (src/functionSource.ts), none of a
// script of 4 MB or more; and there could be 300, which Discord's 450 to
// 700 scripts pushed out of each other on every visit.
const STORE = 'stomp-rewrite-cache';
const LIMIT = 3000;
const ENTRY_LIMIT = 48 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
/** the header an entry's size is kept in */
const SIZE = 'x-stomp-size';
/**
 * The store's own entry (not a rewrite) that records the generation its
 * entries were made under: adopt reads it to decide whether a new worker
 * keeps the store or drops it. Its URL is not a digest (64 hex) and not a
 * routed URL, so no rewrite's entry and no served script is ever under it,
 * and eviction leaves it be.
 */
const GENERATION = '__generation';
/** the header a served entry (matchServed) keeps the key of its output in */
const DIGEST = 'x-stomp-digest';
/** the header a served entry keeps a digest of the partition it was made for in */
const PARTITION = 'x-stomp-partition';

export type RewriteCacheOutcome = 'hit' | 'miss' | 'skip';

export class RewriteCache {
	#store?: Promise<Cache>;
	#open(): Promise<Cache> {
		return (this.#store ??= caches.open(STORE));
	}
	#request(key: string) {
		return new Request(`https://rewrite-cache.invalid/${key}`);
	}
	/** puts not finished yet, by key: a match for one of them waits for it */
	#pending = new Map<string, Promise<void>>();
	/** the digest the output for `body` (its bytes as they came) is kept under, given everything else it depends on */
	async key(parts: string[], body: Uint8Array): Promise<string> {
		const head = new TextEncoder().encode(`${parts.join('\u0000')}\u0000`);
		const bytes = new Uint8Array(head.length + body.length);
		bytes.set(head);
		bytes.set(body, head.length);
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		let hex = '';
		for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
		return hex;
	}
	/**
	 * The output kept under `key`, as the store's Blob: it goes to the page
	 * as it is, never decoded into a string here
	 */
	async match(key: string): Promise<Blob | null> {
		try {
			await this.#pending.get(key);
			const response = await (await this.#open()).match(this.#request(key));
			return response ? await response.blob() : null;
		} catch (error) {
			return null;
		}
	}
	/** keep `output` under `key`; the caller need not wait (a match does) */
	put(key: string, output: string): Promise<void> {
		return this.#track(key, () =>
			this.#put(
				this.#request(key),
				new Response(output, {
					headers: {
						'content-type': 'text/plain',
						[SIZE]: String(output.length),
					},
				}),
				output.length,
			),
		);
	}
	/**
	 * The response kept under `url` (a routed script's URL) for the output
	 * made under `key`: the store's own Response, given to the page as it
	 * is. Chrome keeps V8's code cache with a Cache API entry, and only for
	 * a response a worker answers straight from the store under the URL
	 * the page asked for (not one made from its body, nor one kept under
	 * another URL): a returning visit then compiles nothing it compiled
	 * before. Null when there is none, or it was made for other input (the
	 * partition is part of the key: another site's load never matches).
	 */
	async matchServed(url: string, key: string): Promise<Response | null> {
		try {
			await this.#pending.get(url);
			const response = await (await this.#open()).match(url);
			return response?.headers.get(DIGEST) === key ? response : null;
		} catch (error) {
			return null;
		}
	}
	/**
	 * Keep the response the page was given for `url` (`body`, `init`), made
	 * under `key` for `partition`, for matchServed; the caller need not wait.
	 * The entry another partition's load left under `url` moves under its
	 * own key first (match finds it there), and this output's copy under its
	 * key, if it was there, goes: one copy of each.
	 */
	putServed(
		url: string,
		key: string,
		partition: string,
		body: BodyInit,
		size: number,
		init: { status: number; statusText: string; headers: Headers },
	): Promise<void> {
		return this.#track(url, async () => {
			if (size > ENTRY_LIMIT) return;
			// the entry names its partition by a digest: the response goes to
			// the page as it is, and need not say a site in so many words
			const made = await this.key([partition], new Uint8Array());
			const headers = new Headers(init.headers);
			headers.set(DIGEST, key);
			headers.set(PARTITION, made);
			headers.set(SIZE, String(size));
			try {
				const store = await this.#open();
				const old = await store.match(url);
				const oldKey = old?.headers.get(DIGEST);
				if (
					old &&
					oldKey &&
					oldKey !== key &&
					old.headers.get(PARTITION) !== made
				) {
					const kept = await old.blob();
					await this.#put(
						this.#request(oldKey),
						new Response(kept, {
							headers: {
								'content-type': 'text/plain',
								[SIZE]: String(kept.size),
							},
						}),
						kept.size,
					);
				}
			} catch (error) {
				// not moved: that partition rewrites it again
			}
			await this.#put(
				new Request(url),
				new Response(body, {
					status: init.status,
					statusText: init.statusText,
					headers,
				}),
				size,
			);
			await this.#delete(this.#request(key).url);
		});
	}
	#track(id: string, put: () => Promise<void>): Promise<void> {
		// a put that fails keeps nothing, and is nobody's error
		const done: Promise<void> = put()
			.catch(() => {})
			.finally(() => {
				if (this.#pending.get(id) === done) this.#pending.delete(id);
			});
		this.#pending.set(id, done);
		return done;
	}
	/**
	 * Each entry's size by its URL, oldest first, read from the store once
	 * (as it lists them, in the order they were put) and kept here after:
	 * listing every key on every put grew with the store
	 */
	#loading?: Promise<Map<string, number>>;
	#load(store: Cache): Promise<Map<string, number>> {
		return (this.#loading ??= (async () => {
			const entries = new Map<string, number>();
			for (const kept of await store.keys()) {
				const response = await store.match(kept);
				entries.set(kept.url, Number(response?.headers.get(SIZE)) || 0);
			}
			this.#total = 0;
			for (const size of entries.values()) this.#total += size;
			return entries;
		})());
	}
	#total = 0;
	async #put(request: Request, response: Response, size: number) {
		if (size > ENTRY_LIMIT) return;
		try {
			const store = await this.#open();
			const sizes = await this.#load(store);
			await store.put(request, response);
			// put again, it is the newest
			this.#total -= sizes.get(request.url) ?? 0;
			sizes.delete(request.url);
			sizes.set(request.url, size);
			this.#total += size;
			const marker = this.#request(GENERATION).url;
			for (const [url, kept] of sizes) {
				if (sizes.size <= LIMIT && this.#total <= TOTAL_LIMIT) break;
				if (url === request.url || url === marker) continue;
				sizes.delete(url);
				this.#total -= kept;
				await store.delete(url);
			}
		} catch (error) {
			// a full or unavailable store: the output is simply not kept
		}
	}
	async #delete(url: string) {
		try {
			const store = await this.#open();
			const sizes = await this.#load(store);
			if (!sizes.has(url)) return;
			this.#total -= sizes.get(url) ?? 0;
			sizes.delete(url);
			await store.delete(url);
		} catch (error) {
			// an unavailable store: nothing to delete
		}
	}
	/**
	 * Keep the store only when it was made under `generation` (the rewriter's
	 * identity: src/version.ts REWRITE_GENERATION), called by a newly
	 * activated worker. A worker of the same generation (a deploy that did not
	 * touch the rewriter) keeps every entry, so its revisits come back warm; a
	 * worker of another generation drops the whole store, as all of it is the
	 * last rewriter's output and none could be served under the new key
	 * anyway. The generation is recorded in an entry of the store's own
	 * (GENERATION), which eviction leaves be, so it outlasts the worker that
	 * wrote it. Returns whether the store was kept.
	 */
	async adopt(generation: string): Promise<boolean> {
		try {
			const marker = this.#request(GENERATION);
			const held = await (await this.#open()).match(marker);
			if (held && (await held.text()) === generation) return true;
			await this.clear();
			await (
				await this.#open()
			).put(
				marker,
				new Response(generation, {
					headers: { 'content-type': 'text/plain', [SIZE]: '0' },
				}),
			);
			return false;
		} catch (error) {
			// an unavailable store: nothing kept, the next rewrite makes it again
			return false;
		}
	}
	async clear(): Promise<void> {
		this.#store = undefined;
		this.#loading = undefined;
		this.#total = 0;
		await caches.delete(STORE);
	}
}
