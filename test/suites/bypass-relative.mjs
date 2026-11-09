// The relative twin of the bypass suite. A proxied document lives at a route
// (/stomp/<id>/html/<encoded URL>), which is what the browser resolves a
// relative URL against when no hook routed it: the request then goes to the
// proxy origin under a path that names nothing, or to the wrong real URL.
// bypass-relative.html fires every vector of bypass.html with a relative
// URL marked `?rb=<vector>`, from a page under a deeper path
// (/pages/deep/a/b/) and again under a <base href> elsewhere on the site,
// with URLs inside stylesheets, imported sheets, workers and modules that
// resolve against their own URLs. The page loaded natively is the ground
// truth: for each vector it names the real URLs the browser requests.
// Through the proxy, in both modes, each vector must reach the worker, the
// real URLs the worker fetched must be exactly the native ones, and no
// request may carry a marker unrouted (to the proxy origin or past it).
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/deep/a/b/bypass-relative.html`;
const VARIANTS = [
	['deep', ''],
	['base', `base=${encodeURIComponent('../../x/y/z/')}&`],
];
const fixtureHost = new URL(FIXTURE).host;
const vectorOf = (url) => /[?&]rb=([\w-]+)/.exec(url)?.[1] ?? null;
const withoutHash = (url) => url.split('#')[0];

/** the page's report, from whichever frame holds it */
async function report(page) {
	let state = null;
	for (let i = 0; i < 80 && !state?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__relbypass)
				.catch(() => null);
			if (value) state = value;
		}
	}
	return state;
}

/** vector -> the set of real URLs (without the fragment) it requested */
function byVector(urls) {
	const map = new Map();
	for (const url of urls) {
		const plain = withoutHash(url);
		const vector = vectorOf(plain);
		if (!vector) continue;
		if (!map.has(vector)) map.set(vector, new Set());
		map.get(vector).add(plain);
	}
	return map;
}

const browser = await launch();

for (const [variant, query] of VARIANTS) {
	// the ground truth: the page on the real site, framed as the proxied
	// page is
	const nativeContext = await browser.newContext();
	const nativeRecorder = await recordRequests(nativeContext);
	const nativePage = await nativeContext.newPage();
	await nativePage.goto(`${FIXTURE}pages/hist-1.html`);
	await nativePage.evaluate((url) => {
		const frame = document.createElement('iframe');
		frame.src = url;
		document.body.append(frame);
	}, `${PAGE}?${query}k=native`);
	const nativeState = await report(nativePage);
	await sleep(4000);
	const native = byVector(
		nativeRecorder.log
			.filter((entry) => new URL(entry.url).host === fixtureHost)
			.map((entry) => entry.url),
	);
	await nativeContext.close();
	ok(
		`${variant}: the page fires its vectors natively`,
		native.size > 50 && nativeState?.done === true,
		`${native.size} fired: ${[...native.keys()].join(', ')}; errors ${JSON.stringify(nativeState?.errors ?? {})}`,
	);

	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const label = `${variant} ${mode}`;
		const page = await openDemo(browser, base);
		const recorder = await recordRequests(page.context());
		await page.evaluate(() => {
			window.__served = [];
			window.controller.addEventListener('request', (event) =>
				window.__served.push(event.detail.url),
			);
		});
		await submitLanding(page, `${PAGE}?${query}k=${mode}`);
		const state = await report(page);
		// late loads (a refresh, a worker's fetch) and the request log's grace
		await sleep(4000);
		const served = await page.evaluate(() => window.__served);
		const through = byVector(served);
		ok(
			`${label}: the page ran every vector`,
			state?.done === true,
			JSON.stringify(state),
		);

		// a marker in a URL the browser requested as it is: resolved against
		// the route (the proxy origin with a path that is no route) or sent
		// past the proxy. A routed URL carries the marker encoded
		const unrouted = new Map();
		for (const entry of recorder.log) {
			if (entry.kind === 'local') continue;
			const vector = vectorOf(withoutHash(entry.url));
			const rawToSite =
				entry.kind === 'raw' && new URL(entry.url).host === fixtureHost;
			if (!vector && !rawToSite) continue;
			// a GET form's fields follow its routed action as a query: a route
			if (
				entry.kind === 'worker' &&
				(await page.evaluate(
					(url) => window.controller.unroute(url),
					withoutHash(entry.url),
				)) !== null
			)
				continue;
			const key = vector ?? `unmarked ${entry.url.slice(0, 80)}`;
			if (!unrouted.has(key))
				unrouted.set(key, [entry.kind, entry.source, entry.url.slice(0, 120)]);
		}
		ok(
			`${label}: no relative URL is requested unrouted`,
			unrouted.size === 0,
			JSON.stringify([...unrouted]),
		);

		// every vector that fires natively reaches the worker
		const lost = [...native.keys()].filter(
			(vector) =>
				!through.has(vector) &&
				!(vector.startsWith('websocket') && state?.sockets?.[vector]),
		);
		ok(
			`${label}: every vector that fires natively goes through the proxy`,
			lost.length === 0,
			`lost: ${lost.join(', ')}; page errors: ${JSON.stringify(state?.errors ?? {})}`,
		);

		// and the worker fetched the URLs the browser resolves natively
		const wrong = [];
		for (const [vector, urls] of native) {
			const proxied = through.get(vector);
			if (!proxied) continue;
			const same =
				proxied.size === urls.size && [...urls].every((u) => proxied.has(u));
			if (!same)
				wrong.push(
					`${vector}: native ${[...urls].map((u) => u.replace(FIXTURE, '/')).join(' ')} proxied ${[...proxied].map((u) => u.replace(FIXTURE, '/')).join(' ')}`,
				);
		}
		ok(
			`${label}: each relative URL resolves where it does natively`,
			wrong.length === 0,
			wrong.join('; '),
		);

		// a socket reaches the path it names natively (compared by path and
		// query: the epoxy before its ws-handshake patches sent an absolute
		// request-target)
		const target = (url) => {
			const parsed = new URL(url, 'ws://x');
			return parsed.pathname + parsed.search;
		};
		const sockets = ['websocket', 'websocketstream'].filter(
			(name) => nativeState?.sockets?.[name],
		);
		ok(
			`${label}: a relative WebSocket URL resolves where it does natively`,
			sockets.length > 0 &&
				sockets.every(
					(name) =>
						state?.sockets?.[name] !== undefined &&
						target(state.sockets[name]) === target(nativeState.sockets[name]),
				),
			JSON.stringify({ native: nativeState?.sockets, proxied: state?.sockets }),
		);

		const extra = [...through.keys()].filter((v) => !native.has(v));
		if (extra.length)
			console.log(`  ${label}: through the proxy only: ${extra.join(', ')}`);
		await page.close();
	}
}
await done(browser);
