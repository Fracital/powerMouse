// The wptserve handlers of the vendored beacon tests (beacon/resources/*.py,
// common/redirect.py and fetch/api/resources/redirect.py), ported from the
// python, and the constants of those tests that name an https origin.
//
// The fixture speaks http only, on one port. The tests that ask
// get_host_info() for an https origin get the http one of the same host
// (localhost is a secure context either way), and the second half of the
// four `.https.html` referrer pages, a beacon from an https page down to
// http, has nothing to run against and is taken out: left in, it would
// repeat the first half's subtest name, which the harness reports as an
// error of the whole page.

/** the value of the form field `name` in a multipart body, null when absent */
function formField(body, contentType, name) {
	const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
	if (!boundary) return null;
	const mark = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
	let at = body.indexOf(mark);
	while (at >= 0) {
		const next = body.indexOf(mark, at + mark.length);
		if (next < 0) break;
		const part = body.subarray(at + mark.length, next);
		const split = part.indexOf('\r\n\r\n');
		if (
			split >= 0 &&
			part.subarray(0, split).toString('latin1').includes(`name="${name}"`)
		)
			// the part ends with the CRLF before the next boundary
			return part.subarray(split + 4, part.length - 2);
		at = next;
	}
	return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default ({ stash, setHeaders, readBodyBytes }) => {
	// the half of a referrer page that sends from https down to http
	const downgrade = (origin, expected) => [
		`testBase = get_host_info().${origin} + RESOURCES_DIR;\n      testReferrerHeader(testBase, ${expected}, true);`,
		'// (no http origin below this page on the fixture: not run)',
	];
	return {
		handlers: {
			// beacon.py: `store` keeps what a beacon carried (its Content-Type,
			// and whether the payload is the `<size>:***...` it should be),
			// `stat` takes it
			'/beacon/resources/beacon.py': async (req, res, url) => {
				const q = url.searchParams;
				const id = q.get('id');
				const command = (q.get('cmd') ?? '').toLowerCase();
				const headers = [];
				if (q.has('origin'))
					headers.push(['Access-Control-Allow-Origin', q.get('origin')]);
				if (q.has('credentials'))
					headers.push([
						'Access-Control-Allow-Credentials',
						q.get('credentials'),
					]);
				let body = '';
				res.statusCode = 200;
				if (command === 'store') {
					if (req.method === 'POST') {
						const type = req.headers['content-type'] ?? '(missing)';
						const sent = await readBodyBytes(req);
						const payload = type.includes('form-data')
							? (formField(sent, type, 'payload') ?? Buffer.alloc(0))
							: sent;
						let error = null;
						const parts = payload
							.toString('latin1')
							.split(':')
							.filter((part) => part !== '');
						if (parts.length > 1) {
							const size = parseInt(parts[0], 10);
							if (size !== payload.length)
								error = `expected ${size} characters but got ${payload.length}`;
							else
								for (let i = parts[0].length + 1; i < payload.length; i++)
									if (payload[i] !== 0x2a) {
										error = `expected '*' at index ${i} but got '${String.fromCharCode(payload[i])}''`;
										break;
									}
						}
						stash.set(`beacon|${id}`, { error, type });
					} else if (req.method === 'OPTIONS') {
						if (q.has('preflightExpected'))
							headers.push(
								['Access-Control-Allow-Headers', 'content-type'],
								['Access-Control-Allow-Methods', 'POST'],
							);
						else
							stash.set(`beacon|${id}`, { error: 'Preflight not expected.' });
					}
				} else if (command === 'stat') {
					const data = stash.get(`beacon|${id}`);
					stash.delete(`beacon|${id}`);
					headers.push(['Content-Type', 'text/plain']);
					body = JSON.stringify(data ? [data] : []);
				} else res.statusCode = 400;
				setHeaders(res, headers);
				res.end(body);
			},
			'/beacon/resources/content-type-and-body.py': async (req, res, url) => {
				const q = url.searchParams;
				const key = `content-type-and-body|${q.get('id')}`;
				const command = (q.get('cmd') ?? '').toLowerCase();
				res.setHeader('Content-Type', 'text/plain');
				if (command === 'put') {
					stash.set(
						key,
						Buffer.concat([
							Buffer.from(`${req.headers['content-type'] ?? ''}: `, 'latin1'),
							await readBodyBytes(req),
						]),
					);
					res.statusCode = 200;
					return res.end();
				}
				if (command === 'get' && stash.has(key)) {
					const kept = stash.get(key);
					stash.delete(key);
					res.statusCode = 200;
					return res.end(kept);
				}
				res.statusCode = 400;
				res.end('ERROR: Bad Command!');
			},
			'/beacon/resources/inspect-header.py': (req, res, url) => {
				const q = url.searchParams;
				const header = q.get('header') ?? '';
				const key = `inspect-header|${q.get('id')}`;
				const command = (q.get('cmd') ?? '').toLowerCase();
				res.setHeader('Content-Type', 'text/plain');
				if (command === 'put')
					stash.set(key, req.headers[header.toLowerCase()] ?? '');
				else if (command === 'get') {
					if (stash.has(key)) {
						res.setHeader(`x-request-${header}`, stash.get(key));
						stash.delete(key);
					}
				} else {
					res.statusCode = 400;
					return res.end('ERROR: Bad Command!');
				}
				res.statusCode = 200;
				res.end();
			},
			// url-echo.py: the query string as the beacon sent it
			'/beacon/resources/url-echo.py': (req, res, url) => {
				const q = url.searchParams;
				const key = `url-echo|${q.get('id')}`;
				res.statusCode = 200;
				if (q.get('cmd') === 'store') {
					const mark = req.url.indexOf('?');
					stash.set(key, mark < 0 ? '' : req.url.slice(mark + 1));
				} else if (q.get('cmd') === 'stat') {
					const kept = stash.get(key);
					stash.delete(key);
					res.setHeader('Content-Type', 'text/plain');
					return res.end(kept ?? '');
				} else res.statusCode = 400;
				res.end();
			},
			'/common/redirect.py': (req, res, url) => {
				const q = url.searchParams;
				const status = Number(q.get('status') ?? 302);
				res.statusCode = Number.isInteger(status) ? status : 302;
				const headers = [['Location', q.get('location') ?? '']];
				if (q.has('enable-cors') && req.headers.origin)
					headers.push(
						['Content-Type', 'text/plain'],
						['Access-Control-Allow-Origin', req.headers.origin],
						['Access-Control-Allow-Credentials', 'true'],
					);
				setHeaders(res, headers);
				res.end();
			},
			// fetch/api/resources/redirect.py, under a path of this directory:
			// the fixture's handler of that name is the short one the
			// fetch-metadata tests need (see `patches`)
			'/beacon/resources/fetch-redirect.py': async (req, res, url) => {
				const q = url.searchParams;
				const headers = [
					['Content-Type', 'text/plain'],
					['Cache-Control', 'no-cache'],
					['Pragma', 'no-cache'],
				];
				if (req.headers.origin !== undefined)
					headers.push(
						['Access-Control-Allow-Origin', req.headers.origin],
						['Access-Control-Allow-Credentials', 'true'],
					);
				else headers.push(['Access-Control-Allow-Origin', '*']);
				const token = q.get('token');
				const kept = (token !== null && stash.get(`redirect|${token}`)) || {
					count: 0,
					preflight: '0',
				};
				if (token !== null) stash.delete(`redirect|${token}`);
				const answer = (status, body) => {
					res.statusCode = status;
					setHeaders(res, headers);
					res.end(body);
				};
				if (req.method === 'OPTIONS') {
					if (q.has('allow_headers'))
						headers.push([
							'Access-Control-Allow-Headers',
							q.get('allow_headers'),
						]);
					kept.preflight = '1';
					// a preflight is not redirected
					if (!q.has('redirect_preflight')) {
						if (token !== null) stash.set(`redirect|${token}`, kept);
						return answer(200, '');
					}
				}
				const status = Number(q.get('redirect_status') ?? 302);
				kept.count++;
				if (q.has('location')) {
					let location = q.get('location');
					if (
						!q.has('simple') &&
						/^(https?:|[^:/?#]*([/?#]|$))/.test(location)
					) {
						// the request's own parameters ride along, and a count, so
						// the location changes on every turn of a redirect loop
						const again = new URLSearchParams();
						for (const key of new Set(q.keys())) again.set(key, q.get(key));
						location += `${location.includes('?') ? '&' : '?'}${again}&count=${kept.count}`;
					}
					headers.push(['Location', location]);
				}
				if (q.has('redirect_referrerpolicy'))
					headers.push(['Referrer-Policy', q.get('redirect_referrerpolicy')]);
				if (q.has('delay')) await sleep(Number(q.get('delay')) || 0);
				if (token !== null) {
					stash.set(`redirect|${token}`, kept);
					// past `max_count` turns: stop and say how many there were
					if (q.has('max_count') && kept.count > Number(q.get('max_count'))) {
						res.statusCode = 200;
						return res.end(String(kept.count - 1));
					}
				}
				answer(status, '');
			},
		},
		patches: {
			'/beacon/beacon-cors.https.window.js': [
				[
					'const {HTTPS_ORIGIN, ORIGIN, HTTPS_REMOTE_ORIGIN} = get_host_info();',
					'const {ORIGIN, HTTP_REMOTE_ORIGIN: HTTPS_REMOTE_ORIGIN} = get_host_info();',
				],
				[
					'/fetch/api/resources/redirect.py',
					'/beacon/resources/fetch-redirect.py',
				],
			],
			'/beacon/headers/header-referrer-no-referrer-when-downgrade.https.html': [
				downgrade('HTTP_ORIGIN', '""'),
				['get_host_info().HTTPS_ORIGIN', 'get_host_info().HTTP_ORIGIN'],
			],
			'/beacon/headers/header-referrer-strict-origin.https.html': [
				downgrade('HTTP_ORIGIN', '""'),
				['get_host_info().HTTPS_ORIGIN', 'get_host_info().HTTP_ORIGIN'],
			],
			'/beacon/headers/header-referrer-strict-origin-when-cross-origin.https.html':
				[
					downgrade('HTTP_REMOTE_ORIGIN', '""'),
					[
						'get_host_info().HTTPS_REMOTE_ORIGIN',
						'get_host_info().HTTP_REMOTE_ORIGIN',
					],
				],
			'/beacon/headers/header-referrer-unsafe-url.https.html': [
				downgrade('HTTP_ORIGIN', 'referrerUrl'),
				['get_host_info().HTTPS_ORIGIN', 'get_host_info().HTTP_ORIGIN'],
			],
		},
	};
};
