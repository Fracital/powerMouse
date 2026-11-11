// The URL shapes side of the fixture (url-shapes suite): addresses that end
// in an empty query (`?`), an empty fragment (`#`) or both, and what reached
// the server of them. The id of a document is in its path, so the shape
// after it is the only query or fragment it has.
//
//   /shape/top?...              the battery's page (test/pages/url-shapes.js)
//   /shape/frame/<id><shape>    a document that reports to its parent what
//                               it reads of its own address
//   /shape/to/<id>/<shape name> a 302 to /shape/frame/<id><shape>
//   /shape/go?u=<url>           a 302 to `u`, exactly as given
//   /shape/echo<anything>       JSON: the request target and the Referer
//   /shape/w.js<anything>       a worker that posts what it reads of its
//                               location
//   /shape/m.js<anything>       a module that exports its import.meta.url
//
// test/fixture.mjs calls `shapes(req, res)` and serves the rest.

/** the shapes, by a name a path can carry */
export const SHAPES = {
	'empty-query': '?',
	'empty-fragment': '#',
	'empty-both': '?#',
	'empty-query-fragment': '?#f',
	'query-empty-fragment': '?a=1#',
};

const html = (body) =>
	`<!doctype html><meta charset="utf-8"><title>shape</title><body>${body}`;

/** true when the request was one of ours and has been answered */
export function shapes(req, res) {
	// the request target as it arrived: its query, empty or not, intact
	const target = req.url;
	if (!target.startsWith('/shape/')) return false;
	const path = target.replace(/[?#].*$/s, '');
	res.setHeader('cache-control', 'no-store');
	if (path === '/shape/top') {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(html('<script src="/pages/url-shapes.js"></script>'));
		return true;
	}
	const frame = /^\/shape\/frame\/([\w-]+)$/.exec(path);
	if (frame) {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(
			html(
				`<script>window.__shape = ${JSON.stringify({
					id: frame[1],
					target,
					referer: req.headers.referer ?? null,
				}).replace(
					/</g,
					'\\u003c',
				)};</script><script src="/pages/url-shapes.js"></script>`,
			),
		);
		return true;
	}
	const to = /^\/shape\/to\/([\w-]+)\/([\w-]+)$/.exec(path);
	if (to) {
		res.statusCode = 302;
		res.setHeader('location', `/shape/frame/${to[1]}${SHAPES[to[2]] ?? ''}`);
		res.end();
		return true;
	}
	if (path === '/shape/go') {
		res.statusCode = 302;
		res.setHeader(
			'location',
			new URL(target, 'http://x').searchParams.get('u') ?? '/',
		);
		res.end();
		return true;
	}
	if (path === '/shape/echo') {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ target, referer: req.headers.referer ?? null }));
		return true;
	}
	if (path === '/shape/m.js') {
		res.setHeader('content-type', 'text/javascript');
		res.end('export const url = import.meta.url;');
		return true;
	}
	if (path === '/shape/w.js') {
		res.setHeader('content-type', 'text/javascript');
		res.end(
			'postMessage({ href: location.href, search: location.search, hash: location.hash, string: String(location) });',
		);
		return true;
	}
	res.statusCode = 404;
	res.end();
	return true;
}
