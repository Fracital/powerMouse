// A cache of the rewriter's output for scripts, in a Cache API store keyed
// by a digest of everything the output depends on: the response body, the
// URL (the output names it), the script type, the config the page gets
// (helper names, flags) with the codec's key, and the build; a new worker
// clears it on activation besides. A repeat visit, a
// second tab, or the browser fetching the same script twice skips the
// rewrite; anything that would change the output misses. It keeps only what
// the HTTP cache's privacy rules allow (see mayKeep), at most LIMIT entries
// of ENTRY_LIMIT each and TOTAL_LIMIT in all (the oldest put go first:
// eviction by age, not use), and is cleared with the HTTP cache. Sizes are
// counted in characters, which for a script is about its bytes. An entry
// could be 8 MB at most, which kept no output of Discord's 13 MB bundle and,
// since a rewritten script carries its text for its functions' sources
// (src/functionSource.ts), none of a script of 4 MB or more.
const STORE = 'stomp-rewrite-cache';
const LIMIT = 300;
const ENTRY_LIMIT = 48 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
/** the header an entry's size is kept in */
const SIZE = 'x-stomp-size';

export type RewriteCacheOutcome = 'hit' | 'miss' | 'skip';

export class RewriteCache {
	#store?: Promise<Cache>;
	/** the size of each entry by its URL, read from the store once */
	#sizes?: Map<string, number>;
	#open(): Promise<Cache> {
		return (this.#store ??= caches.open(STORE));
	}
	#request(key: string) {
		return new Request(`https://rewrite-cache.invalid/${key}`);
	}
	/** the digest the output for `body` is kept under, given everything else it depends on */
	async key(parts: string[], body: string): Promise<string> {
		const bytes = new TextEncoder().encode(
			`${parts.join('\u0000')}\u0000${body}`,
		);
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		let hex = '';
		for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
		return hex;
	}
	async match(key: string): Promise<string | null> {
		try {
			const response = await (await this.#open()).match(this.#request(key));
			return response ? await response.text() : null;
		} catch (error) {
			return null;
		}
	}
	async put(key: string, output: string): Promise<void> {
		if (output.length > ENTRY_LIMIT) return;
		try {
			const store = await this.#open();
			const request = this.#request(key);
			await store.put(
				request,
				new Response(output, {
					headers: {
						'content-type': 'text/plain',
						[SIZE]: String(output.length),
					},
				}),
			);
			// the oldest entries go first (a store lists them as they were put)
			const keys = await store.keys();
			if (!this.#sizes) {
				this.#sizes = new Map();
				for (const kept of keys) {
					const response = await store.match(kept);
					this.#sizes.set(kept.url, Number(response?.headers.get(SIZE)) || 0);
				}
			}
			const sizes = this.#sizes;
			sizes.set(request.url, output.length);
			let total = 0;
			for (const kept of keys) total += sizes.get(kept.url) ?? 0;
			let count = keys.length;
			for (const kept of keys) {
				if (count <= LIMIT && total <= TOTAL_LIMIT) break;
				if (kept.url === request.url) continue;
				await store.delete(kept);
				total -= sizes.get(kept.url) ?? 0;
				sizes.delete(kept.url);
				count--;
			}
		} catch (error) {
			// a full or unavailable store: the output is simply not kept
		}
	}
	async clear(): Promise<void> {
		this.#store = undefined;
		this.#sizes = undefined;
		await caches.delete(STORE);
	}
}
