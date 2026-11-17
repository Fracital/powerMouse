// The renderer's memory cache, shared per site (docs/same-origin-policy.md,
// "The renderer's memory cache"). Natively each site's documents are in a
// renderer of their own, and its
// memory cache hands an image or a font one document loaded to the next
// document of the site without asking anyone. Every proxied site shares one
// real origin and one renderer, whose memory cache is keyed by the URL the
// browser loads. So the route of what that cache keeps carries a mark of
// the site of the document that routes it, after the route's kind
// (`binary;m=<mark>/...`, before an integrity mark): the documents of one
// site write one URL, those of another site another. The mark is no site
// name a page could write: the service worker draws it from a secret of its
// own (src/server/cacheMarks.ts) and gives each document its site's in the
// shell, so a page that learned the route's shape still cannot name a URL
// another site's documents loaded. A route without a mark, or with a mark
// that is not its client's, is handed out as no-cache, as every one was
// before. Rust is not involved: the rewriters ask the host to route each
// URL (src/wasm/scanner.ts, src/wasm/rewriter.ts), and the host's routeURL
// writes the mark.

/** what follows a route's kind when it carries the mark of its document's site */
export const CACHE_MARK = ';m=';

/**
 * The route kinds the mark goes on: what a renderer keeps in its memory
 * cache that the service worker hands out as the origin sent it (images,
 * fonts, text tracks, a video's poster), never a body it rewrites (scripts
 * and stylesheets stay no-cache: a rewrite is the worker's output)
 */
export const MARKED_KINDS: ReadonlySet<string> = new Set([
	'binary',
	'binary:set',
]);

/**
 * The policy directives that judge the loads of MARKED_KINDS: a document
 * with a policy that governs one of them (directly or through default-src)
 * marks none of its routes, and the worker hands it no route's load with the
 * origin's caching headers. Natively the renderer judges every load by the
 * document's policy before its memory cache answers it; here the worker
 * judges a load by its real URL (the browser's copy of the policy cannot
 * name the hosts), and a load the renderer's memory cache answers never
 * reaches the worker.
 */
export const MARK_DIRECTIVES = ['img-src', 'font-src', 'media-src'];

/** a mark as the worker makes them (base64url, never a `/`, `;` or `#`) */
export const CACHE_MARK_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The mark of an opaque origin's document (a frame sandboxed without
 * allow-same-origin, a data: document), which no site's mark is (those are
 * longer): natively its renderer and its HTTP cache are its own, and its
 * loads share nothing with its site's documents. The worker cannot tell
 * such a document's image or font load from its site's otherwise (the load
 * carries no header of the inject's). A page that wrote it on a route of
 * its own would only lose the caches.
 */
export const OPAQUE_MARK = 'o';

/**
 * Where this realm's routes take their mark from: the document client's
 * (its site's, which its shell gave it), or nothing (a worker, the service
 * worker, a realm that has no document of its own). A StompURL's own `mark`
 * comes first: the service worker sets it per request, the rewriter library
 * per call.
 */
let markSource: (() => string) | null = null;

export function setCacheMarkSource(source: (() => string) | null) {
	markSource = source;
}

/** the mark this realm's routes carry when their StompURL names none ('' for none) */
export function realmCacheMark(): string {
	return markSource?.() ?? '';
}

/** a route kind without its cache mark, and the mark ('' for none) */
export function splitCacheMark(kind: string): [string, string] {
	const at = kind.indexOf(CACHE_MARK);
	return at === -1
		? [kind, '']
		: [kind.slice(0, at), kind.slice(at + CACHE_MARK.length)];
}
