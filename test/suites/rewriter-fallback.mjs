// The rewriter library is in no inject bundle (meriyah, escodegen, css-tree,
// tldts and the rewriters on them are the asset `rewriterLib`), and a realm
// gets it this way:
//
// - the service worker writes the file's script into a proxied top's shell,
//   before the bundle, under both backends. With `rewriter: 'js'` the top's
//   library is made from it; with `'wasm'` the top keeps it and hands its
//   text to its light library when a call needs it (a script its module
//   declined or has not arrived for, an error message's expression). A
//   frame asks its top; a frame sandboxed without allow-same-origin is
//   handed the text and keeps a library of its own. Nothing of that script
//   is left for the page: no element, no resource timing entry, no global;
// - a realm with no such top (a worker, a frame under a top of another
//   build) loads the file with one synchronous request the first time, and
//   what it rewrites is what the page would have run before. On a
//   document's main thread the browser reports such a request as
//   deprecated: the page is not shown that report.
//
// The controller fetched the file when it started, so those loads come
// from the HTTP cache: once the demo is ready no request for the file
// reaches the network. A host that does not serve it fails when the
// controller starts, not in some page later.
//
// Last, how often a page's rewrites took each path on a few fixture pages
// (`rewriteCounts`): printed, and no top makes a request for the library.
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

const WASM = process.env.STOMP_REWRITER === 'wasm';
const target = `${FIXTURE}pages/deep/rwf/rewriter-fallback.html`;
const xml = `${FIXTURE}pages/deep/rwf/rewriter-fallback.xhtml`;
const LIBRARY = /\/rewriterLib\.js(\?|$)/;
/** fixture pages of other suites, for the counts: scripts, styles, frames, workers, errors */
const SMOKE = [
	'first-rewrite.html',
	'dom.html',
	'xhr.html',
	'css.html',
	'workers.html',
	'docwrite.html',
	'nested-same.html',
	'error-messages.html',
	'frame-memory.html',
];

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
 * A child of `top` (the fixture's child page, same origin): what it
 * answered and the deprecation reports its page was shown. With `name`
 * (the client's, through the proxy) the child takes its top for one of
 * another build (an older build's client has no library text to hand over,
 * and its library is not shared), and how its rewrites went is read too.
 */
const childOf = (top, frameName, name = null) =>
	top.evaluate(
		async ([frameName, name]) => {
			const client = name === null ? null : window[name];
			if (client) {
				Reflect.defineProperty(client, 'sharedRewriter', {
					configurable: true,
					get: () => ({ build: 'another build' }),
				});
				Reflect.defineProperty(client, 'rewriterLibraryText', {
					configurable: true,
					value: undefined,
				});
			}
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
					reports: frame.contentWindow.reportIds(),
				};
			} finally {
				if (client) {
					Reflect.deleteProperty(client, 'sharedRewriter');
					Reflect.deleteProperty(client, 'rewriterLibraryText');
				}
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
	reports: window.reportIds(),
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
 * Every request for the library the tab's renderer makes from now on, as
 * the network stack reports it: `network` holds the ones that were not
 * answered from the HTTP cache.
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
	// the isolated mode's proxied frames are another process's: their
	// requests are not this session's to see
	const watch = mode === 'same-origin' ? await watchLibrary(page) : null;
	const name = await clientName(page);
	// every document from here on notes, after each script its parser runs,
	// whether the name the library's file assigns is there and enumerable
	await page.addInitScript(() => {
		const states = [];
		const note = () => {
			const descriptor = Object.getOwnPropertyDescriptor(
				window,
				'__stompRewriterLib',
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

	// where each realm's library came from
	const topCounts = await counts(top, name);
	const child = page.frames().find((frame) => frame.name() === 'sandboxed');
	const childCounts = child ? await counts(child, name) : null;
	const silent = page.frames().find((frame) => frame.name() === 'silent');
	const silentCounts = silent ? await counts(silent, name) : null;
	if (WASM)
		ok(
			`${mode}: with 'wasm' the top's library was handed the file's text once, for what its module does not answer, with no request`,
			topCounts.loads === 1 &&
				topCounts.requests === 0 &&
				topCounts.answered >= 1 &&
				topCounts.library >= 1,
			JSON.stringify(topCounts),
		);
	else
		ok(
			`${mode}: with 'js' the top's library is the one its shell loaded`,
			topCounts.loads === 0 &&
				topCounts.requests === 0 &&
				topCounts.library >= 1,
			JSON.stringify(topCounts),
		);
	ok(
		`${mode}: the sandboxed frame keeps a library of its own, made from the text its top holds`,
		childCounts?.loads === 1 &&
			childCounts.requests === 0 &&
			childCounts.library >= 1,
		JSON.stringify(childCounts),
	);
	// its script policy refuses eval: the library is run there as a script
	// with the policy's nonce, and its page's markup is still rewritten
	ok(
		`${mode}: the frame without allow-scripts got its library too, with no request, and nothing threw`,
		silentCounts?.library >= 1 &&
			silentCounts.requests === 0 &&
			page.errors.length === 0,
		`${JSON.stringify(silentCounts)} ${JSON.stringify(page.errors)}`,
	);

	// a frame under a top of another build shares nothing with it: it
	// fetches the file, on its document's main thread
	const other = await childOf(top, 'other-build', name);
	ok(
		`${mode}: a frame under a top of another build rewrites with a library of its own, fetched with one request`,
		other.answered.href === nativeChild.answered.href &&
			other.counts.loads === 1 &&
			other.counts.requests === 1,
		JSON.stringify(other),
	);
	ok(
		`${mode}: its page is shown no deprecation report for that request, as natively`,
		JSON.stringify(other.reports) === JSON.stringify(nativeChild.reports),
		`${JSON.stringify(other.reports)}, natively ${JSON.stringify(nativeChild.reports)}`,
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
			/stompRewriterLib/i.test(name),
		),
		has: '__stompRewriterLib' in window,
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
		ok(
			`${mode}: every load of the library came from the HTTP cache`,
			watch.all().length >= 2 && watch.network().length === 0,
			JSON.stringify(watch.all()),
		);
		const answer = watch.all()[0];
		ok(
			`${mode}: the demo serves the library under its hashed URL, cacheable for good`,
			/\?[0-9a-f]{16}$/.test(answer?.url ?? '') &&
				/immutable/.test(answer?.cacheControl ?? ''),
			JSON.stringify(answer),
		);

		// the cache emptied: the next realm that has to fetch the library
		// waits for the network once, and rewrites all the same
		watch.clear();
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Network.clearBrowserCache');
		await cdp.detach();
		const cold = await childOf(top, 'cold', name);
		ok(
			`${mode}: with nothing cached the library is fetched from the network, once, and the rewrite is the same`,
			cold.answered.href === nativeChild.answered.href &&
				cold.counts.requests === 1 &&
				watch.network().length === 1,
			`${JSON.stringify(cold.answered)} waited ${cold.counts.ms.toFixed(1)} ms ${JSON.stringify(watch.all())}`,
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
			reports: window.reportIds(),
			counts: window[name].rewriteCounts,
			sources: document.querySelectorAll('script[src]').length,
			states: [...new Set(window.__libraryName())],
		}),
		name,
	);
	ok(
		`${mode}: an XHTML top rewrites with the library its shell loaded: no request, no report, no script or name left`,
		xmlSeen.href === nativeXML.href &&
			JSON.stringify(xmlSeen.reports) === JSON.stringify(nativeXML.reports) &&
			xmlSeen.counts.requests === 0 &&
			xmlSeen.counts.library + xmlSeen.counts.answered >= 1 &&
			xmlSeen.sources === 0 &&
			!xmlSeen.states.includes('listed') &&
			xmlSeen.states.includes('hidden'),
		`${JSON.stringify(xmlSeen)}, natively ${JSON.stringify(nativeXML)}`,
	);

	// how the rewrites of a few pages went: one top each
	if (mode === 'same-origin') {
		const rows = [];
		for (const file of SMOKE) {
			const url = `${FIXTURE}pages/${file}`;
			await submitOmni(page, url);
			const frame = await waitActive(
				page,
				`document.readyState === 'complete' && window[${JSON.stringify(name)}]?.url?.url?.href === ${JSON.stringify(url)}`,
			).catch(() => null);
			await sleep(1500);
			rows.push([
				file,
				frame ? await counts(frame, name).catch(() => null) : null,
			]);
		}
		console.log(
			`\nrewrites asked in the page, ${WASM ? "'wasm'" : "'js'"}    module  declined   early library   loads requests`,
		);
		for (const [file, row] of rows)
			console.log(
				`  ${file.padEnd(28)} ${
					row
						? [
								row.answered,
								row.declined,
								row.early,
								row.library,
								row.loads,
								row.requests,
							]
								.map((n) => String(n).padStart(8))
								.join('')
						: 'did not load'
				}`,
			);
		console.log('');
		ok(
			'every one of those pages loaded',
			rows.every(([, row]) => row),
			rows
				.filter(([, row]) => !row)
				.map(([file]) => file)
				.join(' '),
		);
		ok(
			'none of those tops made a request for the library',
			rows.every(([, row]) => row && row.requests === 0),
			rows.map(([file, row]) => `${file} ${row?.requests}`).join(', '),
		);
	}
	await page.close();
}

// a host that does not serve the file: the controller says so when it
// starts, under either backend, and names the asset's key
{
	const page = await openDemo(browser, PROXY);
	for (const rewriter of ['js', 'wasm']) {
		const outcome = await page.evaluate(async (rewriter) => {
			const controller = new window.StompController({
				serviceworker: (
					await navigator.serviceWorker.getRegistration('/stomp/')
				).active,
				transport: window.controller.transport,
				directory: '/stomp/',
				codec: 'xor',
				cache: false,
				id: `rewriter-fallback-${rewriter}`,
				rewriter,
				assets: { rewriterLib: 'not-served.js' },
			});
			return Promise.race([
				controller.wait().then(
					() => 'ready',
					(error) => `rejected: ${error.message}`,
				),
				new Promise((resolve) => setTimeout(() => resolve('no answer'), 15000)),
			]);
		}, rewriter);
		ok(
			`a '${rewriter}' controller whose host does not serve the library fails when it starts, naming the asset`,
			outcome.startsWith('rejected: ') &&
				outcome.includes("'rewriterLib'") &&
				outcome.includes('not-served.js'),
			outcome,
		);
	}
	await page.close();
}

await done(browser);
