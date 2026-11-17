// The wptserve python handlers the vendored workers/ tests call
// (test/wpt/workers), ported: redirects between the baseurl directories, a
// worker script that reports its own request (Referer, cookie), and the
// scripts served with a content type the test names.
import { readFileSync } from 'node:fs';

export default ({ setHeaders, root, hosts }) => {
	const redirect = (location) => (req, res) => {
		res.statusCode = 302;
		setHeaders(res, [['Location', location]]);
		res.end("postMessage('executed redirecting script');");
	};
	const script = (res, headers, body) => {
		res.statusCode = 200;
		setHeaders(res, [['Content-Type', 'text/javascript'], ...headers]);
		res.end(body);
	};
	/** the value of the cookie the credentials tests set, '' when not sent */
	const credential = (req) =>
		/(?:^|;\s*)COOKIE_NAME=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
	const credentialed = (req) => [
		['Access-Control-Allow-Credentials', 'true'],
		...(req.headers.origin
			? [['Access-Control-Allow-Origin', req.headers.origin]]
			: []),
	];
	// a classic worker script that posts `value` to whoever started it
	const posting = (value) =>
		"if ('DedicatedWorkerGlobalScope' in self &&" +
		'    self instanceof DedicatedWorkerGlobalScope) {' +
		`  postMessage('${value}');` +
		'} else if (' +
		"    'SharedWorkerGlobalScope' in self &&" +
		'    self instanceof SharedWorkerGlobalScope) {' +
		`  onconnect = e => e.ports[0].postMessage('${value}');` +
		'}';
	// redirect.py, the copy common/ has and the one modules/resources/ keeps
	// beside its scripts
	const redirectTo = (req, res, url) => {
		res.statusCode = Number(url.searchParams.get('status')) || 302;
		const headers = [['Location', url.searchParams.get('location') ?? '']];
		if (url.searchParams.has('enable-cors') && req.headers.origin)
			headers.push(
				['Content-Type', 'text/plain'],
				['Access-Control-Allow-Origin', req.headers.origin],
				['Access-Control-Allow-Credentials', 'true'],
			);
		setHeaders(res, headers);
		res.end();
	};
	const handlers = {
		'/common/redirect.py': redirectTo,
		'/workers/modules/resources/redirect.py': redirectTo,
		'/workers/interfaces/WorkerGlobalScope/location/helper-redirect.py': (
			req,
			res,
		) => {
			res.statusCode = 302;
			setHeaders(res, [['Location', 'post-location-members.js?a']]);
			res.end();
		},
		// the service worker tests' redirect.py, which same-origin-check borrows
		'/service-workers/service-worker/resources/redirect.py': (
			req,
			res,
			url,
		) => {
			const query = url.searchParams;
			res.statusCode = Number(query.get('Status')) || 302;
			const headers = [['Location', query.get('Redirect') ?? '']];
			for (const origin of (query.get('ACAOrigin') ?? '').split(','))
				if (origin) headers.push(['Access-Control-Allow-Origin', origin]);
			for (const suffix of ['Headers', 'Methods', 'Credentials'])
				if (query.has(`ACA${suffix}`))
					headers.push([
						`Access-Control-Allow-${suffix}`,
						query.get(`ACA${suffix}`),
					]);
			if (query.has('ACEHeaders'))
				headers.push([
					'Access-Control-Expose-Headers',
					query.get('ACEHeaders'),
				]);
			setHeaders(res, headers);
			res.end();
		},
		// a module another origin may import, different on every request
		'/workers/modules/resources/export-on-load-script.py': (req, res) =>
			script(
				res,
				[
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Allow-Headers', 'Service-Worker'],
				],
				`export const importedModules = ['export-on-load-script.js'];// ${Date.now() / 1000}`,
			),
		'/workers/modules/resources/export-credentials.py': (req, res) =>
			script(
				res,
				credentialed(req),
				`export const cookie = '${credential(req)}';`,
			),
		'/workers/modules/resources/postmessage-credentials.py': (req, res) =>
			script(res, credentialed(req), posting(credential(req))),
		'/workers/modules/resources/export-referrer-checker.py': (req, res) =>
			script(
				res,
				[['Access-Control-Allow-Origin', '*']],
				`export const referrer = '${req.headers.referer ?? ''}';`,
			),
		'/workers/modules/resources/postmessage-referrer-checker.py': (req, res) =>
			script(
				res,
				[['Access-Control-Allow-Origin', '*']],
				posting(req.headers.referer ?? ''),
			),
		// the page asks with a query written in its own encoding: PASS when the
		// bytes that arrive are UTF-8
		'/workers/semantics/encodings/003-1.py': (req, res, url) => {
			res.statusCode = 200;
			setHeaders(res, [['Content-Type', 'text/plain']]);
			res.end(url.searchParams.get('x') === 'å' ? 'PASS' : 'FAIL');
		},
		'/workers/support/imported_script.py': (req, res, url) => {
			res.statusCode = 200;
			// wptserve sends the value as it is, the empty one included
			res.setHeader('Content-Type', url.searchParams.get('mime') ?? '');
			res.end('');
		},
		'/workers/support/nosiniff-error-worker.py': (req, res) => {
			res.statusCode = 200;
			setHeaders(res, [
				['Content-Type', 'text/html'],
				['X-Content-Type-Options', 'nosniff'],
			]);
			res.end('');
		},
	};
	for (const name of ['import', 'importScripts', 'worker', 'xhr', 'xhr-worker'])
		handlers[`/workers/baseurl/beta/${name}.py`] = redirect(
			`../gamma/${name}.js`,
		);
	// wptserve sends a document without a charset, so its own <meta charset>
	// decides; the fixture says utf-8 for every .html
	const patterns = [
		[
			/^\/workers\/worker-url-encoding\.html$/,
			(req, res, url) => {
				res.statusCode = 200;
				setHeaders(res, [['Content-Type', 'text/html']]);
				res.end(readFileSync(root + url.pathname.slice(1)));
			},
		],
	];
	const patches = {
		// wptserve's name for this host is its punycode form
		'/workers/WorkerLocation-origin.sub.window.js': [
			[
				`\u5929\u6c17\u306e\u826f\u3044\u65e5.${hosts.SAME_ORIGIN_HOST}`,
				`xn--n8j6ds53lwwkrqhv28a.${hosts.SAME_ORIGIN_HOST}`,
			],
		],
	};
	return { handlers, patterns, patches };
};
