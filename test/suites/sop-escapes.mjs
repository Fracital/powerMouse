// The same-origin policy between two proxied sites, against Chrome. A page
// on one site (the fixture on 127.0.0.1) reaches another (the fixture on
// localhost) every way the policy governs (test/pages/sop.js): fetch and
// XMLHttpRequest under CORS (preflights, the Access-Control-* answers,
// credentials, no-cors opacity, redirects), canvas and WebGL tainting,
// Cross-Origin-Resource-Policy, muted script errors, font CORS,
// Timing-Allow-Origin, the document's origins and document.domain, another
// site's storage, channels and locks, and workers. Every proxied site shares
// the proxy's one real origin, so the browser enforces none of it: the
// proxy must. Each case's result is compared with the same page loaded
// natively, in both modes, and so is what reached the other site's server.
//
// SOP_ONLY=<prefix> runs the cases under one prefix (fetch/, canvas/, ...).
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
} from '../lib.mjs';

// Cases known to differ from Chrome, by why (docs/same-origin-policy.md). A
// case on the list that now reads as natively fails too: take it off. A name
// that starts with a mode (`isolated: `) is known in that mode only.
const KNOWN_BY_REASON = {
	"a video or sound copied for a document no service worker controls keeps a blob: URL the page's process can fetch while the element shows it: its loads go on (a seek, a replay), and Chrome resolves a blob: URL again for each (docs/same-origin-policy.md)":
		[
			'gate/the URL a video of another site has in a written about:blank frame, fetched',
		],
	// the suite's host is cross-origin isolated (test/run.mjs), which the
	// coi/ case needs
	"a frame of another origin than its top-level page gets no window for the popups it opens once that page sends COOP same-origin (Chrome opens them without an opener), which the isolated mode's host does to be cross-origin isolated":
		['isolated: canvas/a popup tainted its canvas, the opener draws it'],
	'the tracks of a stream captured from a canvas end when the canvas is tainted (their player shows nothing), where Chrome keeps them live and sends them no more frames (their player keeps the last one)':
		['canvas/the tracks of a stream captured before its canvas was tainted'],
};
const KNOWN = new Map(
	Object.entries(KNOWN_BY_REASON).flatMap(([why, names]) =>
		names.map((name) => [name, why]),
	),
);

const other = new URL(FIXTURE.replace('127.0.0.1', 'localhost')).origin;
const only = process.env.SOP_ONLY ?? '';
const pageURL = (k) =>
	`${FIXTURE}pages/sop.html?b=${encodeURIComponent(other)}&k=${k}${
		only ? `&only=${encodeURIComponent(only)}` : ''
	}`;

/** the battery's report, from whichever frame holds it */
async function report(page) {
	for (let i = 0; i < 600; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame?.evaluate(() => window.__sop).catch(() => null);
			if (value?.done) return value.cases;
		}
	}
	return null;
}

// a run's own keys and the proxy's ports say nothing about the policy
const normal = (value) =>
	JSON.stringify(value ?? null).replace(/k=[\w-]+/g, 'k=KEY');

// (media plays without a gesture, so Web Audio has an element's sound to hear)
const browser = await launch(['--autoplay-policy=no-user-gesture-required']);

// what a realm the inject's hooks do not run in would hold: the browser's
// own functions, taken before anything else runs in each document (the
// gate/ cases)
const NATIVES = `window.__sopNative = {
	fetch: window.fetch,
	text: Response.prototype.text,
	getAttribute: Element.prototype.getAttribute,
	MutationObserver: window.MutationObserver,
};`;

const nativePage = await browser.newPage();
await nativePage.context().addInitScript(NATIVES);
await nativePage.goto(pageURL('native'));
const native = await report(nativePage);
await nativePage.context().close();
ok(
	'natively, the battery ran every case',
	native !== null && Object.keys(native).length > 0,
	normal(native),
);
// what the battery relies on, so a change in the browser shows here first
ok(
	'natively, a cross-origin read without CORS fails and a tainted canvas throws',
	native?.['fetch/cors without ACAO']?.result ===
		'TypeError: Failed to fetch' &&
		/SecurityError/.test(
			native?.['canvas/cross-origin image']?.getImageData ?? '',
		),
	normal([
		native?.['fetch/cors without ACAO'],
		native?.['canvas/cross-origin image'],
	]),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.context().addInitScript(NATIVES);
	// the header each copy went out with (a grant's token, src/server/
	// loadGrants.ts), as only the network sees it: the battery replays them
	const seen = [];
	let asked = 0;
	page.context().on('request', (request) => {
		const token = request.headers()['x-stomp-load'];
		// (the battery's own forgeries carry the header too)
		if (token && /^[\w-]{22}$/.test(token))
			seen.push({ url: request.url(), token });
	});
	await page.context().exposeBinding('__sopSeen', () => {
		asked++;
		return seen;
	});
	await page.evaluate((url) => {
		const form = document.getElementById('mainForm');
		form.url.value = url;
		form.requestSubmit();
	}, pageURL(mode));
	const proxied = await report(page);
	ok(`${mode}: the battery ran every case`, proxied !== null, normal(proxied));
	compare(mode, native, proxied);
	if (!only || 'gate/'.startsWith(only) || only.startsWith('gate/'))
		ok(
			`${mode}: the copies went out with single-use tokens, which the battery replayed`,
			asked > 0 && seen.length > 0,
			JSON.stringify({ asked, seen: seen.length }),
		);
	await page.context().close();
}

// The second part: a page whose service worker (an emulated one through
// the proxy, the demo's `?sw`) answers its requests to the other site in its
// own ways (test/pages/sop-sw.js): the worker's answers reach the page as
// natively (an opaque one only to a no-cors request), and the worker's own
// reads are judged as the worker's origin's, preflighted once
if (!only || only.startsWith('sw/')) {
	const swURL = (k) =>
		`${FIXTURE}pages/deep/sopsw/sop-sw.html?b=${encodeURIComponent(other)}&k=${k}`;
	const swReport = async (page) => {
		for (let i = 0; i < 400; i++) {
			await sleep(250);
			for (const frame of page.frames()) {
				const value = await frame
					?.evaluate(() => window.__sopSW)
					.catch(() => null);
				if (value?.done) return value;
			}
		}
		return null;
	};
	const swNativePage = await browser.newPage();
	await swNativePage.goto(swURL('native'));
	const swNative = await swReport(swNativePage);
	await swNativePage.context().close();
	ok(
		'natively, the service worker controlled the page and ran every case',
		swNative?.controlled === true && !swNative.error,
		normal(swNative),
	);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, `${base}?sw`);
		await page.evaluate((url) => {
			const form = document.getElementById('mainForm');
			form.url.value = url;
			form.requestSubmit();
		}, swURL(mode));
		const proxied = await swReport(page);
		ok(
			`${mode}: the emulated service worker controlled the page and ran every case`,
			proxied?.controlled === true && !proxied.error,
			normal(
				proxied && { controlled: proxied.controlled, error: proxied.error },
			),
		);
		compare(mode, swNative?.cases, proxied?.cases);
		await page.context().close();
	}
}

// The third part: a page that opts into cross-origin isolation, top-level
// natively (only a top-level document's COOP makes an isolated group)
if (!only || only.startsWith('coi/')) {
	const coiReport = async (page) => {
		for (let i = 0; i < 120; i++) {
			await sleep(250);
			for (const frame of page.frames()) {
				const value = await frame
					?.evaluate(() => window.__coi)
					.catch(() => null);
				if (value) return value;
			}
		}
		return null;
	};
	const coiURL = `${FIXTURE}pages/sop-coi.html`;
	const coiNativePage = await browser.newPage();
	await coiNativePage.goto(coiURL);
	const coiNative = {
		'coi/a page that sends COOP and COEP': await coiReport(coiNativePage),
	};
	await coiNativePage.context().close();
	ok(
		'natively, a page that sends COOP and COEP is cross-origin isolated',
		coiNative['coi/a page that sends COOP and COEP']?.crossOriginIsolated ===
			true,
		normal(coiNative),
	);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		await page.evaluate((url) => {
			const form = document.getElementById('mainForm');
			form.url.value = url;
			form.requestSubmit();
		}, coiURL);
		compare(mode, coiNative, {
			'coi/a page that sends COOP and COEP': await coiReport(page),
		});
		await page.context().close();
	}
}

// The fourth part: the gate under the policies a document can have
// (test/pages/gate-csp.html). An image of another site copied for an
// about:blank frame gets a URL a worker of the inject's made, and the
// worker's script is a blob: URL, which a policy can refuse: the page's
// own header or meta (the proxy strips them, so the browser never applies
// them), a sandbox, the policy the proxy puts on a frame without
// allow-scripts, and a list's `$csp=` (the blocker's, which the browser
// does apply: then the worker comes from the service worker's route the
// carried policy names). In each, the URL the element holds names nothing
// by the time it is set, as the other site's URL natively does.
if (!only || only.startsWith('csp/')) {
	const cspURL = (file, name = '') =>
		`${FIXTURE}pages/${file}?b=${encodeURIComponent(other)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
	// each document's cases, once every one of them is in
	const cspReport = async (page, count) => {
		let cases = {};
		for (let i = 0; i < 160; i++) {
			await sleep(250);
			cases = {};
			let pending = false;
			for (const frame of page.frames()) {
				const value = await Promise.race([
					frame?.evaluate(() => window.__gateCsp).catch(() => null),
					sleep(3000).then(() => null),
				]);
				if (value && !value.done) pending = true;
				if (value?.done) Object.assign(cases, value.cases);
			}
			if (!pending && Object.keys(cases).length >= count) break;
		}
		return cases;
	};
	const OWN = 7;
	const cspNativePage = await browser.newPage();
	await cspNativePage.context().addInitScript(NATIVES);
	await cspNativePage.goto(cspURL('gate-csp.html'));
	const cspNative = await cspReport(cspNativePage, OWN);
	await cspNativePage.context().close();
	// a list's policy is the blocker's: natively the same page has none,
	// and what its image's URL reads is the other site's refusal again
	const LISTED = {
		"csp/a page a list gives $csp=worker-src 'none'":
			'gate-csp-list-worker.html',
		"csp/a page a list gives $csp=script-src 'self' 'unsafe-inline' 'unsafe-eval'":
			'gate-csp-list-script.html',
		"csp/a page a list gives $csp=child-src 'none'": 'gate-csp-list-child.html',
	};
	for (const [name, file] of Object.entries(LISTED)) {
		const page = await browser.newPage();
		await page.context().addInitScript(NATIVES);
		await page.goto(cspURL(file, name));
		Object.assign(cspNative, await cspReport(page, 1));
		await page.context().close();
	}
	ok(
		'natively, every document of the csp/ cases loaded its image and its URL is refused',
		Object.keys(cspNative).length === OWN + Object.keys(LISTED).length &&
			Object.values(cspNative).every(
				(value) =>
					value?.event === 'load' &&
					value.width === 1 &&
					value.read === 'TypeError: Failed to fetch',
			),
		normal(cspNative),
	);
	const cspShape = (cases) =>
		Object.fromEntries(
			Object.entries(cases ?? {}).map(([name, value]) => [
				name,
				value && { event: value.event, width: value.width, read: value.read },
			]),
		);
	for (const [mode, base] of [
		['same-origin', PROXY],
		['isolated', HOST],
	]) {
		const page = await openDemo(browser, base);
		await page.context().addInitScript(NATIVES);
		await page.evaluate((url) => {
			const form = document.getElementById('mainForm');
			form.url.value = url;
			form.requestSubmit();
		}, cspURL('gate-csp.html'));
		const proxied = await cspReport(page, OWN);
		// the lists: a controller of the suite's own with the blocker on,
		// in the demo page (same-origin) or the isolated host
		// (the lists' policies: a document's own never reaches the browser,
		// and the proxy's frame-ancestors names no worker)
		const policies = [];
		page.context().on('response', (response) => {
			const policy = response.headers()['content-security-policy'];
			if (policy && /(worker|child|script)-src/.test(policy))
				policies.push(policy);
		});
		for (const [name, file] of Object.entries(LISTED)) {
			await page.evaluate(
				async ({ mode, proxy, fixture, url }) => {
					// the fixture's resources: the default ones are another
					// site's, which a run without the network cannot reach
					const adblock = {
						resources: `${fixture}pages/adblock-resources.json`,
						lists: [
							{ url: `${fixture}pages/gate-csp-list.txt`, trusted: true },
						],
					};
					window.__cspController ??=
						mode === 'isolated'
							? new window.StompRemoteController({
									proxyOrigin: proxy.replace(/\/$/, ''),
									directory: '/stomp/',
									transport: {
										module: `${proxy}epoxy/index.mjs`,
										options: [{ wisp: `${proxy.replace(/^http/, 'ws')}wisp/` }],
									},
									codec: 'xor',
									cache: false,
									adblock,
								})
							: new window.StompController({
									serviceworker: window.controller.serviceworker,
									transport: window.controller.transport,
									directory: window.controller.directory.pathname,
									codec: 'xor',
									cache: false,
									adblock,
								});
					await window.__cspController.wait();
					document.getElementById('__cspFrame')?.remove();
					const element = document.createElement('iframe');
					element.id = '__cspFrame';
					document.body.append(element);
					await window.__cspController.createFrame(element).go(url);
				},
				{ mode, proxy: PROXY, fixture: FIXTURE, url: cspURL(file, name) },
			);
			for (let i = 0; i < 80 && !proxied[name]; i++) {
				const found = await cspReport(page, 1);
				if (found[name]) proxied[name] = found[name];
			}
		}
		ok(
			`${mode}: a list's policy reaches the documents, and names the proxy's route among its worker sources`,
			policies.length >= Object.keys(LISTED).length &&
				policies.every((policy) =>
					/worker-src [^,;]*http:\/\/[^ ,;]+\/stomp\/[\w-]+\/sealer(?=$|[;,])/.test(
						policy,
					),
				) &&
				policies.some((policy) =>
					/worker-src http:\/\/\S+\/sealer$/.test(policy),
				),
			JSON.stringify(policies),
		);
		compare(mode, cspShape(cspNative), cspShape(proxied));
		await page.context().close();
	}
}

await done(browser);

/** each case natively against the proxy, a known difference against its list */
function compare(mode, native, proxied) {
	for (const name of Object.keys(native ?? {})) {
		const want = normal(native[name]);
		const got = normal(proxied?.[name]);
		const detail = `\n      native  ${want}\n      proxied ${got}`;
		const known = KNOWN.get(`${mode}: ${name}`) ?? KNOWN.get(name);
		if (known)
			ok(
				`${mode}: ${name} differs as known (${known})`,
				want !== got,
				`now as natively: take it off the list${detail}`,
			);
		else ok(`${mode}: ${name} as natively`, want === got, detail);
	}
}
