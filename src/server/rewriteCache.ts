// A cache of the rewriter's output for scripts, in a Cache API store keyed
// by a digest of everything the output depends on: the response body, the
// URL (the output names it), the script type, the config the page gets
// (helper names, flags) with the codec's key, and the build; a new worker
// clears it on activation besides. A repeat visit, a
// second tab, or the browser fetching the same script twice skips the
// rewrite; anything that would change the output misses. It keeps only what
// the HTTP cache's privacy rules allow (see mayKeep), at most LIMIT entries
// (the oldest put go first: eviction by age, not use) of ENTRY_LIMIT each, and is cleared with the HTTP
// cache.
const STORE = 'stomp-rewrite-cache';
const LIMIT = 300;
const ENTRY_LIMIT = 8 * 1024 * 1024;

export type RewriteCacheOutcome = 'hit' | 'miss' | 'skip';

export class RewriteCache {
	#store?: Promise<Cache>;
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
			await store.put(
				this.#request(key),
				new Response(output, { headers: { 'content-type': 'text/plain' } }),
			);
			// the oldest entries go first (a store lists them as they were put)
			const keys = await store.keys();
			for (const request of keys.slice(0, Math.max(0, keys.length - LIMIT)))
				await store.delete(request);
		} catch (error) {
			// a full or unavailable store: the output is simply not kept
		}
	}
	async clear(): Promise<void> {
		this.#store = undefined;
		await caches.delete(STORE);
	}
}
