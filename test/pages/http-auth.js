// The HTTP authentication battery of the http-auth suite, run by
// http-auth.html on 127.0.0.1 (origin A) with localhost (origin B) as the
// other site. Each case is a request or two against test/auth-server.mjs's
// protection spaces, in order (the cases build on what the auth cache kept
// from the ones before), and reports what the page can read (the status);
// the suite compares that, and the Authorization the server got for every
// request of the case, with the native load. `?k=<key>` keys one load.
(() => {
	const key = new URLSearchParams(location.search).get('k') ?? 'none';
	const A = location.origin;
	const B = A.replace('127.0.0.1', 'localhost');
	const withCredentials = (origin) => origin.replace('://', '://user:pass@');
	const route = (origin, path, name, extra = '') =>
		`${origin}/auth/${path}?k=${key}&c=${encodeURIComponent(name)}${extra}`;
	const report = (window.__httpAuth = { results: {}, done: false });

	function xhr(url, user, pass, { method = 'GET', body = null, cors } = {}) {
		return new Promise((resolve) => {
			const request = new XMLHttpRequest();
			try {
				if (user === undefined) request.open(method, url);
				else request.open(method, url, true, user, pass);
				if (cors) request.withCredentials = true;
				request.onloadend = () =>
					resolve({ status: request.status, type: request.statusText });
				request.send(body);
			} catch (error) {
				resolve({ threw: error.name });
			}
		});
	}
	async function get(url, init) {
		try {
			const response = await fetch(url, init);
			await response.text();
			return { status: response.status, type: response.type };
		} catch (error) {
			return { threw: error.name };
		}
	}
	/** a frame at `src`: what it posted (a frame of B), or its title (A's) */
	function frame(src, posts) {
		return new Promise((resolve) => {
			const element = document.createElement('iframe');
			const timer = setTimeout(() => resolve({ timeout: true }), 15000);
			const done = (value) => {
				clearTimeout(timer);
				removeEventListener('message', onMessage);
				resolve(value);
			};
			const onMessage = (event) => {
				if (posts && event.source === element.contentWindow) done(event.data);
			};
			addEventListener('message', onMessage);
			element.onload = () => {
				if (posts) return;
				let title;
				try {
					title = element.contentDocument?.title ?? null;
				} catch (error) {
					title = `threw ${error.name}`;
				}
				done({ loaded: true, title });
			};
			element.src = src;
			document.body.append(element);
		});
	}
	function worker(name) {
		return new Promise((resolve) => {
			const it = new Worker('http-auth-worker.js');
			const timer = setTimeout(() => resolve({ timeout: true }), 15000);
			it.onmessage = (event) => {
				clearTimeout(timer);
				it.terminate();
				resolve(event.data);
			};
			it.postMessage({ key, name });
		});
	}

	const CASES = [
		// Basic: nothing before the challenge, open()'s credentials answer it,
		// the answer is sent ahead under the directory and kept for the realm
		['basic none', (c) => xhr(route(A, 'basic/b1/none', c))],
		['basic userpass', (c) => xhr(route(A, 'basic/b1/a', c), 'user', 'pass')],
		['basic ahead', (c) => xhr(route(A, 'basic/b1/b', c))],
		['basic ahead deeper', (c) => xhr(route(A, 'basic/b1/sub/c', c))],
		['basic realm reuse', (c) => xhr(route(A, 'basic/b1x/a', c, '&realm=b1'))],
		['basic url creds', (c) => xhr(route(withCredentials(A), 'basic/b2/a', c))],
		['basic wrong', (c) => xhr(route(A, 'basic/b3/a', c), 'user', 'nope')],
		[
			'basic kept then wrong',
			async (c) => ({
				first: await xhr(route(A, 'basic/b5/a', c), 'user', 'pass'),
				wrong: await xhr(route(A, 'basic/b5/b', c), 'user', 'nope'),
			}),
		],
		// a rejected identity forgets what the realm kept
		['basic after wrong', (c) => xhr(route(A, 'basic/b5/c', c))],
		[
			'basic realm after wrong',
			(c) => xhr(route(A, 'basic/b5x/a', c, '&realm=b5')),
		],
		// Digest (RFC 7616): the same, with a nonce count that goes up for
		// each request sent ahead, and a stale nonce answered with the new one
		['md5 userpass', (c) => xhr(route(A, 'md5/d1/a', c), 'user', 'pass')],
		['md5 ahead', (c) => xhr(route(A, 'md5/d1/b', c))],
		['md5 ahead again', (c) => xhr(route(A, 'md5/d1/sub/c', c))],
		['md5 stale', (c) => xhr(route(A, 'md5/d1/d', c, '&stale=1'))],
		['md5 after stale', (c) => xhr(route(A, 'md5/d1/e', c))],
		[
			'md5 post',
			(c) =>
				xhr(route(A, 'md5/d1/post', c), undefined, undefined, {
					method: 'POST',
					body: 'x=1',
				}),
		],
		['md5 realm reuse', (c) => xhr(route(A, 'md5/d1x/a', c, '&realm=d1'))],
		['md5 url creds', (c) => xhr(route(withCredentials(A), 'md5/d2/a', c))],
		['md5 wrong', (c) => xhr(route(A, 'md5/d3/a', c), 'user', 'nope')],
		['md5 after wrong', (c) => xhr(route(A, 'md5/d3/b', c))],
		[
			'md5-sess userpass',
			(c) => xhr(route(A, 'md5-sess/s1/a', c), 'user', 'pass'),
		],
		['md5-sess ahead', (c) => xhr(route(A, 'md5-sess/s1/b', c))],
		['sha256 userpass', (c) => xhr(route(A, 'sha256/h1/a', c), 'user', 'pass')],
		['sha256 ahead', (c) => xhr(route(A, 'sha256/h1/b', c))],
		['sha256 stale', (c) => xhr(route(A, 'sha256/h1/c', c, '&stale=1'))],
		[
			'sha256-sess userpass',
			(c) => xhr(route(A, 'sha256-sess/t1/a', c), 'user', 'pass'),
		],
		// a Basic and a Digest challenge: the browser answers the stronger
		['both userpass', (c) => xhr(route(A, 'both/m1/a', c), 'user', 'pass')],
		['both ahead', (c) => xhr(route(A, 'both/m1/b', c))],
		// fetch(): the kept credentials go with a request that may carry
		// credentials, a page's own Authorization goes as it is
		['fetch basic ahead', (c) => get(route(A, 'basic/b1/f', c))],
		['fetch md5 ahead', (c) => get(route(A, 'md5/d1/f', c))],
		[
			'fetch omit',
			(c) => get(route(A, 'basic/b1/omit', c), { credentials: 'omit' }),
		],
		[
			'fetch own authorization',
			(c) =>
				get(route(A, 'basic/b1/own', c), {
					headers: { authorization: `Basic ${btoa('user:nope')}` },
				}),
		],
		// another origin never gets A's credentials, sent ahead or to answer
		// a challenge of the same realm (the security invariant)
		['cross basic', (c) => xhr(route(B, 'basic/b1/a', c))],
		['cross md5', (c) => xhr(route(B, 'md5/d1/a', c))],
		[
			'cross basic realm',
			(c) =>
				xhr(route(B, 'basic/z1/a', c, '&realm=b1'), undefined, undefined, {
					cors: true,
				}),
		],
		[
			'cross userpass',
			(c) =>
				xhr(route(B, 'basic/r6/a', c), 'user', 'pass', {
					cors: true,
				}),
		],
		[
			'cross fetch include',
			(c) => get(route(B, 'basic/b1/f', c), { credentials: 'include' }),
		],
		[
			'cross fetch md5 include',
			(c) => get(route(B, 'md5/d1/f', c), { credentials: 'include' }),
		],
		// a redirect to another origin: what went to A stays behind
		[
			'redirect kept',
			(c) =>
				xhr(
					route(
						A,
						'basic/b1/go',
						c,
						`&to=${encodeURIComponent(route(B, 'basic/b1/landed', c))}`,
					),
				),
		],
		[
			'redirect md5 kept',
			(c) =>
				xhr(
					route(
						A,
						'md5/d1/go',
						c,
						`&to=${encodeURIComponent(route(B, 'md5/d1/landed', c))}`,
					),
				),
		],
		[
			'redirect userpass',
			(c) =>
				xhr(
					route(
						A,
						'basic/o1/go',
						c,
						`&open=1&to=${encodeURIComponent(route(B, 'basic/r1/landed', c))}`,
					),
					'user',
					'pass',
				),
		],
		[
			'redirect userpass with credentials',
			(c) =>
				xhr(
					route(
						A,
						'basic/o1/go',
						c,
						`&open=1&to=${encodeURIComponent(route(B, 'basic/r5/landed', c))}`,
					),
					'user',
					'pass',
					{ cors: true },
				),
		],
		[
			'redirect md5 userpass',
			(c) =>
				xhr(
					route(
						A,
						'basic/o1/go',
						c,
						`&open=1&to=${encodeURIComponent(route(B, 'md5/r2/landed', c))}`,
					),
					'user',
					'pass',
				),
		],
		[
			'redirect url creds',
			(c) =>
				xhr(
					route(
						withCredentials(A),
						'basic/o1/go',
						c,
						`&open=1&to=${encodeURIComponent(route(B, 'basic/r3/landed', c))}`,
					),
				),
		],
		[
			'redirect userpass same origin',
			(c) =>
				xhr(
					route(
						A,
						'basic/o1/go',
						c,
						`&open=1&to=${encodeURIComponent(route(A, 'basic/r4/landed', c))}`,
					),
					'user',
					'pass',
				),
		],
		// frames: a document of B asks B, A's own frame gets A's credentials
		[
			'frame of other origin',
			(c) =>
				frame(
					`${B}/pages/http-auth-frame.html?k=${key}&c=${encodeURIComponent(c)}`,
					true,
				),
		],
		[
			'frame of other origin challenged',
			async (c) => {
				await frame(route(B, 'basic/b1/doc', c, '&html=1'), false);
				return {};
			},
		],
		[
			'frame of own origin',
			(c) => frame(route(A, 'basic/b1/doc', c, '&html=1'), false),
		],
		['worker md5', (c) => worker(c)],
		// what a browser sends to an NTLM challenge (the suite reports it)
		['ntlm userpass', (c) => xhr(route(A, 'ntlm/n1/a', c), 'user', 'pass')],
		// Clear-Site-Data "cookies" clears what the site's auth answered
		// (Chrome's console says it does not, measured: it does), of the site
		// alone; "cache" leaves it
		[
			'clear setup',
			async (c) => ({
				basic: await xhr(route(A, 'basic/cs1/a', c), 'user', 'pass'),
				md5: await xhr(route(A, 'md5/cs2/a', c), 'user', 'pass'),
			}),
		],
		[
			'clear other site',
			(c) =>
				get(`${B}/auth/csd?k=${key}&c=${c}&types="cookies"`, {
					credentials: 'include',
				}),
		],
		['after clear other site', (c) => xhr(route(A, 'basic/cs1/b', c))],
		[
			'clear own site cache',
			(c) => get(`${A}/auth/csd?k=${key}&c=${c}&types="cache"`),
		],
		['after clear cache', (c) => xhr(route(A, 'basic/cs1/d', c))],
		[
			'clear own site',
			(c) => get(`${A}/auth/csd?k=${key}&c=${c}&types="cookies"`),
		],
		['after clear basic', (c) => xhr(route(A, 'basic/cs1/c', c))],
		['after clear md5', (c) => xhr(route(A, 'md5/cs2/b', c))],
	];

	(async () => {
		for (const [name, run] of CASES) {
			report.at = name;
			try {
				report.results[name] = await run(name);
			} catch (error) {
				report.results[name] = { failed: String(error) };
			}
		}
		const log = await fetch(`${A}/auth/log?k=${key}`, {
			credentials: 'omit',
		});
		report.log = await log.json();
		report.done = true;
	})();
})();
