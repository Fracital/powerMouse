// The rewriter is the wasm core module; no inject bundle carries a parser.
// What the bundles do carry is the light library (the wasm glue,
// src/rewriterLight.ts), and a realm gets it this way:
//
// - the service worker writes the light library's file into a proxied top's
//   shell, before the bundle. The top evaluates it in a realm of its own and
//   the frames under it share that copy. Nothing of that script is left for
//   the page: no element, no resource timing entry, no global;
// - a realm with no such top (a worker carries its own in its bundle; a frame
//   under a top of another build, or one sandboxed without allow-same-origin,
//   loads the file with one synchronous request the first time it rewrites).
//
// Either way every realm rewrites what the page runs, reading its location as
// the page sees it, which only rewritten code does. The compiled module
// reaches a top over a message round trip, so a rewrite in the window before
// it arrives compiles the module's bytes synchronously (the suite cold-start
// proves the top's first-script case); here every realm's rewrites are shown
// correct once the page has settled.
//
// The controller fetches the light library and compiles the core module when
// it starts, so those loads come from the HTTP cache and a host that serves
// neither fails when the controller starts, naming the asset, not in some
// page later.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/deep/rwf/rewriter-fallback.html`;
const xml = `${FIXTURE}pages/deep/rwf/rewriter-fallback.xhtml`;
const LIBRARY = /\/rewriterLib\.js(\?|$)/;

/** what the fixture answers, in `frame` (its top) */
async function answers(frame) {
	const ask = (name, ...args) =>
		frame
			.evaluate(
				([name, args]) => window.__fallback[name](...args),
				[name, args],
			)
			.catch((error) => ({ error: String(error) }));
	return {
		made: await ask('made'),
		message: await ask('message'),
		dedicated: await ask('dedicated'),
		shared: await ask('shared'),
		service: await ask('service'),
		sandboxed: await ask('sandboxed', 'allow-scripts', 'sandboxed'),
		// no script of this one runs
		silent: await ask('sandboxed', '', 'silent', 3000),
	};
}

/**
 * A child of `top` (the fixture's child page, same origin): what it answered.
 * With `name` (the client's, through the proxy) the child takes its top for
 * one of another build, whose library it does not share, so it loads a light
 * library of its own; its rewrite counts are read too.
 */
const childOf = (top, frameName, name = null) =>
	top.evaluate(
		async ([frameName, name]) => {
			const client = name === null ? null : window[name];
			if (client)
				Reflect.defineProperty(client, 'sharedRewriter', {
					configurable: true,
					get: () => ({ build: 'another build' }),
				});
			try {
				const frame = document.createElement('iframe');
				frame.name = frameName;
				frame.src = 'rewriter-fallback-child.html';
				const answer = new Promise((resolve) => {
					addEventListener('message', (event) => {
						if (event.source === frame.contentWindow && event.data.href)
							resolve(event.data);
					});
					setTimeout(() => resolve({ error: 'no answer' }), 15000);
				});
				document.body.append(frame);
				const answered = await answer;
				await new Promise((resolve) => setTimeout(resolve, 300));
				return {
					answered,
					counts: client ? frame.contentWindow[name].rewriteCounts : null,
				};
			} finally {
				if (client) Reflect.deleteProperty(client, 'sharedRewriter');
			}
		},
		[frameName, name],
	);

// natively
const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
const native = await answers(nativePage.mainFrame());
const nativeScripts = await nativePage.evaluate(() => document.scripts.length);
const nativeChild = await childOf(nativePage.mainFrame(), 'child');
await nativePage.goto(xml);
await nativePage.waitForFunction(() => typeof window.__xml === 'object');
await sleep(300);
const nativeXML = await nativePage.evaluate(() => ({
	href: window.__xml.href,
}));
await nativeBrowser.close();
ok(
	'natively, every realm of the fixture answers its location',
	native.made === target &&
		/rewriter-fallback-worker\.js$/.test(native.dedicated?.href ?? '') &&
		native.shared?.href === native.dedicated.href &&
		native.service?.href === native.dedicated.href &&
		/rewriter-fallback-child\.html$/.test(native.sandboxed?.href ?? '') &&
		nativeChild.answered.href === native.sandboxed.href &&
		nativeXML.href === xml &&
		native.message.includes('o[k]'),
	JSON.stringify([native, nativeChild, nativeXML]),
);

const browser = await launch();

/** a top's client, by the name the demo's controller gave it */
const clientName = (page) =>
	page.evaluate(() => window.controller.config.names.client);
const counts = (frame, name) =>
	frame.evaluate((name) => window[name].rewriteCounts, name);

/**
 * Every request for the light library the tab's renderer makes from now on,
 * as the network stack reports it: `network` holds the ones not answered from
 * the HTTP cache.
 */
async function watchLibrary(page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Network.enable');
	const asked = new Map();
	cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
		if (LIBRARY.test(request.url))
			asked.set(requestId, { url: request.url, cached: false, done: false });
	});
	cdp.on('Network.requestServedFromCache', ({ requestId }) => {
		const entry = asked.get(requestId);
		if (entry) entry.cached = true;
	});
	cdp.on('Network.responseReceived', ({ requestId, response }) => {
		const entry = asked.get(requestId);
		if (!entry) return;
		entry.status = response.status;
		entry.cacheControl =
			response.headers['cache-control'] ?? response.headers['Cache-Control'];
		if (response.fromDiskCache || response.fromPrefetchCache)
			entry.cached = true;
	});
	cdp.on('Network.loadingFinished', ({ requestId }) => {
		const entry = asked.get(requestId);
		if (entry) entry.done = true;
	});
	return {
		all: () => [...asked.values()],
		network: () => [...asked.values()].filter((entry) => !entry.cached),
		clear: () => asked.clear(),
		stop: () => cdp.detach().catch(() => {}),
	};
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// the isolated mode's proxied frames are another process's: their requests
	// are not this session's to see
	const watch = mode === 'same-origin' ? await watchLibrary(page) : null;
	const name = await clientName(page);
	// every document from here on notes, after each script its parser runs,
	// whether the name the light library's file assigns is there and enumerable
	await page.addInitScript(() => {
		const states = [];
		const note = () => {
			const descriptor = Object.getOwnPropertyDescriptor(
				window,
				'__stompRewriterLight',
			);
			states.push(
				!descriptor ? 'absent' : descriptor.enumerable ? 'listed' : 'hidden',
			);
		};
		Object.defineProperty(window, '__libraryName', {
			value: () => {
				note();
				return states;
			},
		});
		new MutationObserver(note).observe(document, {
			childList: true,
			subtree: true,
		});
	});

	await submitLanding(page, target);
	const top = await waitActive(page, `typeof window.__fallback === 'object'`);

	const proxied = await answers(top);
	for (const [what, key] of [
		['a function the page makes from a string', 'made'],
		["an error's message names the page's expression", 'message'],
		['a dedicated worker', 'dedicated'],
		['a shared worker', 'shared'],
		["the page's service worker", 'service'],
		['a frame sandboxed without allow-same-origin', 'sandboxed'],
		['a frame sandboxed without allow-scripts', 'silent'],
	])
		ok(
			`${mode}: ${what} reads as natively`,
			JSON.stringify(proxied[key]) === JSON.stringify(native[key]),
			`${JSON.stringify(proxied[key])}, natively ${JSON.stringify(native[key])}`,
		);

	// the top's rewrites were the module's, and nothing was fetched for a
	// rewrite (the shell loaded the library, the controller the module)
	const topCounts = await counts(top, name);
	ok(
		`${mode}: the top rewrote in the module, with no synchronous request for a rewrite`,
		topCounts.answered >= 1 &&
			topCounts.library >= 1 &&
			topCounts.requests === 0,
		JSON.stringify(topCounts),
	);
	const silent = page.frames().find((frame) => frame.name() === 'silent');
	ok(
		`${mode}: the frame without allow-scripts rewrote its page and nothing threw`,
		page.errors.length === 0,
		`${silent ? 'silent frame present' : 'no silent frame'} ${JSON.stringify(page.errors)}`,
	);

	// the shell's scripts: nothing of them is the page's to see
	const states = await top.evaluate(() => window.__libraryName());
	ok(
		`${mode}: the name the library's file assigns is never enumerable and is gone before the page's first script`,
		!states.includes('listed') &&
			states.at(-1) === 'absent' &&
			states.includes('hidden'),
		[...new Set(states)].join(', '),
	);
	const seen = await top.evaluate(() => ({
		scripts: document.scripts.length,
		sources: [...document.querySelectorAll('script[src]')].map(
			(script) => script.src,
		),
		entries: performance
			.getEntries()
			.map((entry) => entry.name)
			.filter((name) => /rewriterLib|injectDocument|\/stomp\//.test(name)),
		names: Object.getOwnPropertyNames(window).filter((name) =>
			/stompRewriterLi(b|ght)/i.test(name),
		),
		has: '__stompRewriterLib' in window || '__stompRewriterLight' in window,
	}));
	ok(
		`${mode}: the page sees no script, timing entry or global of the library's`,
		seen.scripts === nativeScripts &&
			seen.sources.length === 0 &&
			seen.entries.length === 0 &&
			seen.names.length === 0 &&
			!seen.has,
		JSON.stringify(seen),
	);

	if (watch) {
		const answer = watch.all()[0];
		ok(
			`${mode}: the demo serves the library under its hashed URL, cacheable for good`,
			/\?[0-9a-f]{16}$/.test(answer?.url ?? '') &&
				/immutable/.test(answer?.cacheControl ?? ''),
			JSON.stringify(watch.all()),
		);

		// a frame under a top of another build does not share the top's library
		// instance; it takes the light library's text from its top and makes a
		// copy of its own, then rewrites all the same (its module compiled from
		// bytes it fetched, not watched here)
		const other = await childOf(top, 'other-build', name);
		ok(
			`${mode}: a frame under a top of another build rewrites with a copy of its own`,
			other.answered.href === nativeChild.answered.href &&
				other.counts.answered >= 1,
			`${JSON.stringify(other.answered)} ${JSON.stringify(other.counts)}`,
		);
		await watch.stop();
	}

	// an XML document as a top: its shell loads the library too
	await submitOmni(page, xml);
	const xmlTop = await waitActive(
		page,
		`typeof window.__xml === 'object' && typeof window.reportIds === 'function'`,
	);
	await sleep(300);
	const xmlSeen = await xmlTop.evaluate(
		(name) => ({
			href: window.__xml.href,
			counts: window[name].rewriteCounts,
			sources: document.querySelectorAll('script[src]').length,
			states: [...new Set(window.__libraryName())],
		}),
		name,
	);
	ok(
		`${mode}: an XHTML top rewrites with the library its shell loaded: no request for a rewrite, no script or name left`,
		xmlSeen.href === nativeXML.href &&
			xmlSeen.counts.requests === 0 &&
			xmlSeen.counts.library + xmlSeen.counts.answered >= 1 &&
			xmlSeen.sources === 0 &&
			!xmlSeen.states.includes('listed') &&
			xmlSeen.states.includes('hidden'),
		`${JSON.stringify(xmlSeen)}, natively ${JSON.stringify(nativeXML)}`,
	);
	await page.close();
}

// a host that does not serve the core module: the controller says so when it
// starts, naming the asset's key, not in some page later (the rewriter is
// wasm-only, so without the module no script can be rewritten)
{
	const page = await openDemo(browser, PROXY);
	const outcome = await page.evaluate(async () => {
		const controller = new window.StompController({
			serviceworker: (await navigator.serviceWorker.getRegistration('/stomp/'))
				.active,
			transport: window.controller.transport,
			directory: '/stomp/',
			codec: 'xor',
			cache: false,
			id: 'rewriter-fallback-core',
			assets: { core: 'not-served.wasm' },
		});
		return Promise.race([
			controller.wait().then(
				() => 'ready',
				(error) => `rejected: ${error.message}`,
			),
			new Promise((resolve) => setTimeout(() => resolve('no answer'), 15000)),
		]);
	});
	ok(
		`a controller whose host does not serve 'core' fails when it starts, naming the asset`,
		outcome.startsWith('rejected: ') &&
			outcome.includes("'core'") &&
			outcome.includes('not-served'),
		outcome,
	);
	await page.close();
}

await done(browser);
