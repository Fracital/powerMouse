// The wptserve python handlers behind the vendored html/ and dom/ tests
// (history, location, the script element, event handlers, node insertion,
// windows), reimplemented: each entry names the .py file it stands for.
import { existsSync, readFileSync } from 'node:fs';

export default ({ root, stash, setHeaders, cookiePairs }) => {
	const SCRIPT = '/html/semantics/scripting-1/the-script-element';
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const send = (res, status, headers, body) => {
		res.statusCode = status;
		setHeaders(res, headers);
		res.end(body);
	};
	const cookie = (req, name) =>
		cookiePairs(req).find(([key]) => key === name)?.[1] ?? null;

	// common/redirect.py and module/dynamic-import/beta/redirect.py
	const redirect = (req, res, url) => {
		const headers = [['Location', url.searchParams.get('location') ?? '']];
		if (url.searchParams.has('enable-cors') && req.headers.origin)
			headers.push(
				['Content-Type', 'text/plain'],
				['Access-Control-Allow-Origin', req.headers.origin],
				['Access-Control-Allow-Credentials', 'true'],
			);
		send(res, Number(url.searchParams.get('status')) || 302, headers, '');
	};

	// module/resources/referrer-checker.py
	const referrerChecker = (req, res) =>
		send(
			res,
			200,
			[
				['Content-Type', 'text/javascript'],
				['Access-Control-Allow-Origin', '*'],
			],
			`export const referrer = '${req.headers.referer ?? ''}';`,
		);

	const handlers = {
		// common/slow.py: an empty answer after `delay` ms
		'/common/slow.py': async (req, res, url) => {
			await sleep(Number(url.searchParams.get('delay') ?? 2000));
			send(res, 200, [], '');
		},
		'/common/redirect.py': redirect,
		[`${SCRIPT}/module/dynamic-import/beta/redirect.py`]: redirect,
		'/xhr/resources/delay.py': async (req, res, url) => {
			await sleep(Number(url.searchParams.get('ms') ?? 500));
			send(
				res,
				200,
				[
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Allow-Methods', 'YO'],
					['Content-Type', 'text/plain'],
				],
				'TEST_DELAY',
			);
		},
		'/html/infrastructure/urls/terminology-0/resources/echo-referrer-text.py': (
			req,
			res,
		) =>
			send(
				res,
				200,
				[['Content-Type', 'text/plain']],
				req.headers.referer ?? '',
			),
		// windows/resources/window-name-stash.py: a POST keeps ?value under
		// ?id, a GET takes it
		'/html/browsers/windows/resources/window-name-stash.py': (
			req,
			res,
			url,
		) => {
			const key = `window-name|${url.searchParams.get('id')}`;
			if (req.method === 'POST') {
				stash.set(key, url.searchParams.get('value') ?? '');
				return send(res, 200, [], 'OK');
			}
			const value = stash.get(key);
			stash.delete(key);
			send(res, 200, [], value ?? 'NONE');
		},
		[`${SCRIPT}/cacheable-script-throw.py`]: (req, res) =>
			send(
				res,
				200,
				[
					['Content-Type', 'text/javascript'],
					['Cache-Control', 'public, max-age=100'],
				],
				"throw('fox');",
			),
		// log.py: `log('<id>')` after `sec` seconds
		[`${SCRIPT}/log.py`]: async (req, res, url) => {
			const id = Number.parseInt(url.searchParams.get('id'), 10);
			const seconds = Number.parseInt(url.searchParams.get('sec'), 10);
			if (Number.isNaN(id) || Number.isNaN(seconds))
				return send(res, 400, [], 'Invalid parameter');
			await sleep(seconds * 1000);
			send(res, 200, [['Content-Type', 'text/javascript']], `log('${id}')`);
		},
		// module-fetch-tester.py: counts the fetches of a key and fails the
		// first one, every one or none
		[`${SCRIPT}/module-fetch-tester.py`]: (req, res, url) => {
			const key = `module-fetch|${url.searchParams.get('key')}`;
			if (url.searchParams.get('action') === 'stat')
				return send(
					res,
					200,
					[['Content-Type', 'text/plain']],
					String(stash.get(key) ?? 0),
				);
			const count = (stash.get(key) ?? 0) + 1;
			stash.set(key, count);
			const mode = url.searchParams.get('mode') ?? 'fail-first';
			if (mode === 'always-fail' || (mode === 'fail-first' && count === 1))
				return send(res, 404, [['Content-Type', 'text/plain']], 'not found');
			send(
				res,
				200,
				[['Content-Type', 'application/javascript']],
				"export default 'hello';",
			);
		},
		[`${SCRIPT}/script-not-found-not-executed.py`]: (req, res) =>
			send(
				res,
				404,
				[['Content-Type', 'text/javascript']],
				'test1_token = "script executed";',
			),
		[`${SCRIPT}/script-not-found-not-executed-2.py`]: (req, res) =>
			send(
				res,
				200,
				[['Content-Type', 'text/javascript']],
				'test2_token = "script executed";',
			),
		// serve-custom-response.py: a response whose status, type and failure
		// an earlier `action=set` request chose, counting how often it ran
		[`${SCRIPT}/serve-custom-response.py`]: (req, res, url) => {
			const query = url.searchParams;
			const key = `custom-response|${query.get('key')}`;
			const context = stash.get(key) ?? {
				networkError: false,
				runCount: 0,
				status: 200,
				type: 'application/javascript',
			};
			stash.set(key, context);
			const plain = [['Content-Type', 'text/plain']];
			const action = query.get('action');
			if (action === 'stat')
				return send(res, 200, plain, String(context.runCount));
			if (action === 'reset-stat') {
				context.runCount = 0;
				return send(res, 200, plain, 'OK');
			}
			if (action === 'set') {
				if (query.has('code')) context.status = Number(query.get('code'));
				if (query.has('content-type')) context.type = query.get('content-type');
				if (query.has('network-error'))
					context.networkError =
						query.get('network-error').toLowerCase() === 'true';
				return send(res, 200, plain, 'OK');
			}
			context.runCount++;
			if (context.networkError) return res.socket.destroy();
			const bodies = {
				'application/javascript': "export default 'hello';",
				'application/json': '{"hello": "world"}',
				'text/css': '#test { background-color: rgb(0, 255, 0); }',
			};
			send(
				res,
				context.status,
				[['Content-Type', context.type]],
				bodies[context.type] ?? '42',
			);
		},
		// serve-with-content-type.py: a file of the directory under the
		// Content-Type the query names
		[`${SCRIPT}/serve-with-content-type.py`]: (req, res, url) => {
			const name = url.searchParams.get('fn') ?? '';
			const file = `${root}${SCRIPT.slice(1)}/${name}`;
			if (!name || name.includes('..') || !existsSync(file))
				return send(res, 400, [], 'Not enough parameters or file not found');
			send(
				res,
				200,
				[['Content-Type', url.searchParams.get('ct') ?? '']],
				readFileSync(file),
			);
		},
		// resources/cross-origin.py: says whether the request carried milk=1
		[`${SCRIPT}/resources/cross-origin.py`]: (req, res) => {
			const headers = [['Content-Type', 'text/javascript']];
			if (req.headers.origin)
				headers.push(
					['Access-Control-Allow-Origin', req.headers.origin],
					['Access-Control-Allow-Methods', 'GET'],
					['Access-Control-Allow-Credentials', 'true'],
				);
			if (req.method === 'OPTIONS') return send(res, 200, headers, '');
			send(res, 200, headers, `var included = ${cookie(req, 'milk') === '1'};`);
		},
		// resources/load-error-events.py: a script that runs (`_load` in the
		// test's name) or a 404 whose body must not run
		[`${SCRIPT}/resources/load-error-events.py`]: (req, res, url) => {
			const test = url.searchParams.get('test') ?? '';
			if (!/^[a-zA-Z0-9_]+$/.test(test)) return send(res, 500, [], '');
			const headers = [['Content-Type', 'text/javascript']];
			if (test.includes('_load'))
				return send(
					res,
					200,
					headers,
					`"use strict"; ${test}.executed = true;`,
				);
			send(
				res,
				404,
				headers,
				`"use strict"; ${test}.test.step(function() { assert_unreached("404 script should not be executed"); });`,
			);
		},
		// module/resources/check-cookie.py: sets window.<id> to what the
		// request's cookie said
		[`${SCRIPT}/module/resources/check-cookie.py`]: (req, res, url) => {
			const query = url.searchParams;
			const value = cookie(req, query.get('cookieName') ?? '');
			const result =
				value === null
					? 'not found'
					: value === '1'
						? 'found'
						: `different value: ${value}`;
			send(
				res,
				200,
				[
					['Content-Type', 'text/javascript'],
					['Access-Control-Allow-Origin', query.get('origin') ?? ''],
					['Access-Control-Allow-Credentials', 'true'],
				],
				`window.${query.get('id')} = '${result}';`,
			);
		},
		[`${SCRIPT}/module/resources/delayed-modulescript.py`]: async (
			req,
			res,
			url,
		) => {
			await sleep(Number(url.searchParams.get('ms') ?? 500));
			send(
				res,
				200,
				[['Content-Type', 'text/javascript']],
				'export let delayedLoaded = true;',
			);
		},
		[`${SCRIPT}/module/resources/referrer-checker.py`]: referrerChecker,
	};

	// wptserve serves the IDL parser under this name (tools/serve/serve.py)
	const patterns = [
		[
			/^\/resources\/WebIDLParser\.js$/,
			(req, res) =>
				send(
					res,
					200,
					[['Content-Type', 'text/javascript; charset=utf-8']],
					readFileSync(`${root}resources/webidl2/lib/webidl2.js`),
				),
		],
	];

	// The report script, as served (the harness requests of this area, until
	// the script itself does it): a page that moves itself with pushState or
	// replaceState still reports under the path it was loaded from, and a
	// subtest named after location.origin does not carry the fixture's port,
	// which changes with every run, into the expected list, and the report
	// is posted to the page's own origin whatever its base URL has become.
	const patches = {
		'/resources/testharnessreport.js': [
			[
				'var TEST_STATUS = [',
				'var LOADED_FROM = [location.pathname, location.search];\n\tvar TEST_STATUS = [',
			],
			['path: location.pathname,', 'path: LOADED_FROM[0],'],
			['search: location.search,', 'search: LOADED_FROM[1],'],
			// (a page that moved its <base href> to another host would post
			// there)
			["fetch('/_wpt/report'", "fetch(location.origin + '/_wpt/report'"],
			[
				'name: test.name,',
				"name: test.name.replace(/:\\d{4,5}\\b/g, ':PORT'),",
			],
		],
	};

	return { handlers, patterns, upgrades: {}, patches };
};
