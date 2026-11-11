// An empty query (`/p?`) and an empty fragment (`/p#`) are part of a URL:
// `href` keeps them, and a page reads them in every URL it is given. The
// URL API's `search` and `hash` read both as '', the same as no query and
// no fragment at all, so a URL put together from those parts loses them.
// These read the parts as written, from the serialization.

const fragmentStart = (href: string) => href.indexOf('#');

/** `url` without its fragment: an empty query is kept */
export function beforeFragment(url: URL | string): string {
	const href = typeof url === 'string' ? url : url.href;
	const hash = fragmentStart(href);
	return hash === -1 ? href : href.slice(0, hash);
}

/** the fragment as written: `#` alone for an empty one, '' for none */
export function fragmentOf(url: URL | string): string {
	const href = typeof url === 'string' ? url : url.href;
	const hash = fragmentStart(href);
	return hash === -1 ? '' : href.slice(hash);
}

/** the query as written: `?` alone for an empty one, '' for none */
export function queryOf(url: URL | string): string {
	const head = beforeFragment(url);
	const query = head.indexOf('?');
	return query === -1 ? '' : head.slice(query);
}

/** what follows a `data:` URL's scheme, up to its fragment (a `?` in it is data too) */
export function dataBody(url: URL): string {
	return beforeFragment(url).slice(url.protocol.length);
}

/**
 * `url` with its query replaced by `query` as written: `?` alone gives it an
 * empty one. Chrome's `search` setter makes `?` no query at all (measured,
 * 152 and 156; the spec, and node, keep an empty one), so the URL is parsed
 * again from its text instead.
 */
export function withQuery(url: URL, query: string): URL {
	const head = beforeFragment(url);
	const start = head.indexOf('?');
	return new URL(
		(start === -1 ? head : head.slice(0, start)) + query + fragmentOf(url),
	);
}
