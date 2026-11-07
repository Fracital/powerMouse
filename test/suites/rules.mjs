// Request rules: declarative, run in the service worker on the real URLs. A
// controller created with `rules` (or given them with setRules) can block a
// request, add or delete request and response headers, answer with a status
// or redirect a navigation; the first matching rule wins; setRules([]) clears
// them. Same-origin mode, a controller of our own (it replaces the demo's
// in the worker, so it runs last in its own page).
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const result = await page.evaluate(async (fixture) => {
	const log = [];
	const controller = new window.StompController({
		serviceworker: window.controller.serviceworker,
		transport: window.controller.transport,
		directory: window.controller.directory.pathname,
		codec: 'xor',
		onRequest: (info) => log.push(info),
		rules: [
			{ match: { url: 'http://*:*/pages/hdr.json' }, action: 'block' },
			{
				// the query makes this rule specific: the plain echo matches no rule
				match: { url: 'http://127.0.0.1:*/echo-headers?tap', method: ['GET'] },
				// (not User-Agent: the transport fills one in when it is missing)
				action: { requestHeaders: { 'x-tap': '1', 'accept-language': null } },
			},
			{
				match: { url: 'http://*:*/pages/fresh.json' },
				action: {
					responseHeaders: { 'x-from-tap': 'yes', 'cache-control': null },
				},
			},
			{
				match: { url: 'http://*:*/pages/nostore.json' },
				action: { status: 204 },
			},
			{
				match: { url: 'http://*:*/pages/hist-1.html', destination: ['iframe'] },
				action: { redirect: `${fixture}pages/hist-2.html` },
			},
			{ match: { url: 'not a pattern [' }, action: 'block' },
			// a host's own Origin and Referer for one configured host (Fracital WS1)
			{
				match: { url: 'http://localhost:*/echo-headers' },
				action: {
					requestHeaders: {
						origin: 'https://host.example',
						referer: 'https://host.example/',
					},
				},
			},
		],
	});
	await controller.wait();
	const element = document.createElement('iframe');
	document.body.append(element);
	const frame = controller.createFrame(element);
	const loaded = () =>
		new Promise((r) => element.addEventListener('load', r, { once: true }));
	const load = loaded();
	await frame.go(`${fixture}pages/hist-1.html`);
	await load;
	const win = element.contentWindow;
	const out = {};
	out.redirectedTitle = element.contentDocument?.title;
	out.blocked = await win.fetch('/pages/hdr.json').then(
		(r) => r.status,
		(e) => `error ${e.message}`,
	);
	const echoed = await win.fetch('/echo-headers?tap').then((r) => r.json());
	out.tapHeader = echoed['x-tap'];
	out.language = echoed['accept-language'] ?? null;
	const fresh = await win.fetch('/pages/fresh.json');
	out.fromTap = fresh.headers.get('x-from-tap');
	out.cacheControl = fresh.headers.get('cache-control');
	out.status = await win.fetch('/pages/nostore.json').then((r) => r.status);
	await new Promise((r) => setTimeout(r, 300));
	const blocked = log.find((i) => i.url.endsWith('/pages/hdr.json'));
	out.loggedBlock = blocked && {
		status: blocked.status,
		error: blocked.error,
		rule: blocked.rule,
	};
	// the configured host carries the host's headers; another host is
	// untouched (compared below with the no-rules baseline)
	const other = fixture.replace('127.0.0.1', 'localhost');
	out.configured = await win
		.fetch(new URL('/echo-headers', other).href)
		.then((r) => r.json());
	out.unconfigured = await win.fetch('/echo-headers').then((r) => r.json());
	// the cache path: fresh.json again is a hit, the rule still reports
	const second = await win.fetch('/pages/fresh.json');
	out.fromTapCached = second.headers.get('x-from-tap');
	await new Promise((r) => setTimeout(r, 300));
	out.freshLog = log
		.filter((i) => i.url.endsWith('/pages/fresh.json'))
		.map((i) => [i.cached, i.rule]);
	out.plainLog = log
		.filter((i) => i.url === `${fixture}echo-headers`)
		.map((i) => i.rule);
	try {
		await controller.setRules([]);
		// the baseline first: the unblocked hdr.json sets a cookie
		out.baseline = await win.fetch('/echo-headers').then((r) => r.json());
		out.unblocked = await win.fetch('/pages/hdr.json').then((r) => r.status);
	} catch (error) {
		out.unblocked = String(error);
	}
	return out;
}, FIXTURE);
ok(
	'a blocked request is answered 403 and logged as blocked',
	result.blocked === 403 &&
		result.loggedBlock?.status === 403 &&
		/rule/.test(result.loggedBlock?.error || ''),
	JSON.stringify([result.blocked, result.loggedBlock]),
);
ok(
	'a request header is added and another deleted',
	result.tapHeader === '1' && result.language === null,
	JSON.stringify([result.tapHeader, result.language]),
);
ok(
	'a response header is set and another deleted',
	result.fromTap === 'yes' && result.cacheControl === null,
	JSON.stringify([result.fromTap, result.cacheControl]),
);
ok(
	'a status rule answers without going upstream',
	result.status === 204,
	JSON.stringify(result.status),
);
ok(
	'a redirect rule sends a frame navigation elsewhere',
	result.redirectedTitle === 'HIST 2',
	JSON.stringify(result.redirectedTitle),
);
ok(
	'setRules([]) clears the rules',
	result.unblocked === 200,
	JSON.stringify(result.unblocked),
);
ok(
	"a configured host gets the host's Origin and Referer",
	result.configured?.origin === 'https://host.example' &&
		result.configured?.referer === 'https://host.example/',
	JSON.stringify([result.configured?.origin, result.configured?.referer]),
);
ok(
	'an unconfigured request is identical to the no-rules baseline',
	JSON.stringify(result.unconfigured) === JSON.stringify(result.baseline) &&
		result.plainLog?.length === 1 &&
		result.plainLog[0] === undefined,
	JSON.stringify([result.unconfigured, result.baseline, result.plainLog]),
);
ok(
	'the rule reports its index, on the cache path too',
	result.loggedBlock?.rule === 0 &&
		result.fromTapCached === 'yes' &&
		JSON.stringify(result.freshLog) ===
			JSON.stringify([
				[false, 2],
				[true, 2],
			]),
	JSON.stringify([result.loggedBlock, result.fromTapCached, result.freshLog]),
);
await done(browser);
