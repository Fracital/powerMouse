// The response-header side of the fixture (header-policies suites and
// adversarial-headers): a document or resource whose response headers the
// query names, and a log of what reached it, so a suite can tell a page the
// browser fetched by itself (a prefetch, a refused frame) from one it never
// asked for.
//
//   /hdr/doc?k=<key>&...   a document; every request is logged under k
//     h=<name>:<value>     a response header (repeatable, in order)
//     post=<tag>           the page posts {hdr: tag, cookie} to its parent
//                          and its opener once it runs
//     body=<html>          the body instead (text/html)
//     ct=<type>            the content type (default text/html)
//     echo=cookie          the body is the request's Cookie header
//   /hdr/log?k=<key>       what reached /hdr/* under k, in order: path,
//                          query, the cookie, sec-purpose and
//                          sec-required-csp headers
//
// test/fixture.mjs calls `headersFixture(req, res)` first and serves the rest.

const logs = new Map();

const POST = (tag) => `<!doctype html><title>hdr ${tag}</title>
<script>
	const message = { hdr: ${JSON.stringify(tag)}, cookie: document.cookie };
	try { if (parent !== window) parent.postMessage(message, '*'); } catch (e) {}
	try { if (top !== parent) top.postMessage(message, '*'); } catch (e) {}
	try { if (opener) opener.postMessage(message, '*'); } catch (e) {}
</script>`;

/** true when the request was one of ours and has been answered */
export function headersFixture(req, res) {
	const url = new URL(req.url, 'http://x');
	if (!url.pathname.startsWith('/hdr/')) return false;
	const query = url.searchParams;
	const key = query.get('k');
	if (url.pathname === '/hdr/log') {
		res.setHeader('content-type', 'application/json');
		res.setHeader('cache-control', 'no-store');
		res.setHeader('access-control-allow-origin', '*');
		res.end(JSON.stringify(logs.get(key) ?? []));
		return true;
	}
	if (key !== null) {
		if (!logs.has(key)) logs.set(key, []);
		logs.get(key).push({
			path: url.pathname,
			query: url.search,
			cookie: req.headers.cookie ?? null,
			purpose: req.headers['sec-purpose'] ?? null,
			requiredCSP: req.headers['sec-required-csp'] ?? null,
		});
	}
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', query.get('ct') ?? 'text/html; charset=utf-8');
	for (const header of query.getAll('h')) {
		const colon = header.indexOf(':');
		if (colon < 1) continue;
		res.appendHeader(header.slice(0, colon).trim(), header.slice(colon + 1));
	}
	const post = query.get('post');
	if (query.get('echo') === 'cookie') {
		res.end(req.headers.cookie ?? '');
		return true;
	}
	res.end(query.get('body') ?? (post !== null ? POST(post) : 'hdr'));
	return true;
}
