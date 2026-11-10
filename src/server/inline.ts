/**
 * Inline documents: markup the page made itself (a javascript: URL's string,
 * a text/html blob, a data: frame) that the browser would show from a
 * document no service worker controls, so its subresources would miss the
 * worker. The page posts the markup here under a token and navigates the
 * frame to `<address>inline:<token>/<encoded referrer URL>`; this store hands
 * it to that route once. A token is unguessable (from the page's
 * crypto.getRandomValues), single-use, scoped to the controller address it
 * was registered for, and expires in seconds. The route rewrites the markup
 * itself; nothing the page sends is served as written.
 */

/** how long a registration waits for its navigation */
const TTL_MS = 10_000;
/** how long a navigation waits for its registration (the two race) */
const WAIT_MS = 3_000;
/** the largest markup accepted, in UTF-16 code units */
export const INLINE_MAX = 4 * 1024 * 1024;
/** a token: 16 random bytes in base64url */
export const INLINE_TOKEN = /^[A-Za-z0-9_-]{22}$/;

export interface InlineDocument {
	/** the controller address (`/stomp/<id>/`) it belongs to */
	directory: string;
	markup: string;
	/** the document's URL as its readbacks show it (the shell's base) */
	url: string;
	/**
	 * the partition of the document that registered it (src/partition.ts),
	 * as the worker read it from that document's route: a document a page
	 * makes is of the page's origin and in the page's frame tree, so it is
	 * in the page's partition
	 */
	partition?: string;
}

const entries = new Map<string, InlineDocument & { expires: number }>();
const waiting = new Map<string, (entry: InlineDocument | null) => void>();

function sweep(now: number) {
	for (const [token, entry] of entries)
		if (entry.expires <= now) entries.delete(token);
}

export function putInline(token: string, entry: InlineDocument) {
	const now = Date.now();
	sweep(now);
	const waiter = waiting.get(token);
	if (waiter) {
		waiting.delete(token);
		waiter(entry);
		return;
	}
	entries.set(token, { ...entry, expires: now + TTL_MS });
}

/** the document registered under `token` for `directory`, once; null for an unknown, used, expired or foreign token */
export function takeInline(
	token: string,
	directory: string,
): Promise<InlineDocument | null> {
	const now = Date.now();
	sweep(now);
	const check = (entry: InlineDocument | null) =>
		entry && entry.directory === directory ? entry : null;
	const entry = entries.get(token);
	if (entry) {
		entries.delete(token);
		return Promise.resolve(check(entry));
	}
	if (waiting.has(token)) return Promise.resolve(null);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			waiting.delete(token);
			resolve(null);
		}, WAIT_MS);
		waiting.set(token, (entry) => {
			clearTimeout(timer);
			resolve(check(entry));
		});
	});
}
