// The renderer's memory cache, per site (src/memoryMark.ts), against Chrome.
// A page of site A frames, one after another, documents that load one
// resource the origin lets be kept for an hour and takes 400 ms to answer,
// as an image and as a font: two of site A, two of site B, one more of site
// A, and one of site A sandboxed into an opaque origin. Natively the second
// document of a site takes the first one's copy from the memory cache of
// the site's renderer (no request, the resource timing of a cache), and a
// document of another site, or an opaque one, has its own renderer and
// waits for the network. Through the proxy every site is in one renderer:
// the routes of a site's documents carry that site's mark, so the renderer
// keeps one copy per site and hands it to the next document of that site
// only. What a document can tell of its load (its time, its resource
// timing) and what the renderer did (Network.requestServedFromCache) are
// compared with the same sequence natively, in both modes. A document of
// site B that names the route site A's document loaded gets its own load of
// the URL, never site A's copy.
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
} from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const ROUTE = /\/stomp\/[\w-]+\/html\//;
/** the origin takes this long to answer: a load that takes less did not wait for it */
const WAIT_MS = 400;
/** the steps: who loads the resource, of which site, sandboxed or not */
const STEPS = [
	['A1', A],
	['A2', A],
	['B1', B],
	['B2', B],
	['A3', A],
	['opaque', A, 'allow-scripts'],
];
const resource = (run, as) =>
	`${A}sop/r?k=${run}&type=${as === 'font' ? 'font' : 'png'}&acao=*&ms=${WAIT_MS}&cc=${encodeURIComponent('max-age=3600')}`;
const childURL = (site, as, url, name) =>
	`${site}pages/memory-share.html?as=${as}&r=${encodeURIComponent(url)}&n=${name}`;

/**
 * The image and font loads the renderer of `top` served from its memory
 * cache, by frame: the session of `top`'s own target when it has one (the
 * proxy's frame in isolation mode), else the tab's
 */
async function watch(tab, top) {
	const cdp = await tab
		.context()
		.newCDPSession(top)
		.catch(() => tab.context().newCDPSession(tab));
	await cdp.send('Network.enable');
	const requests = new Map();
	cdp.on('Network.requestWillBeSent', (event) => {
		if (event.type === 'Image' || event.type === 'Font')
			requests.set(event.requestId, { frame: event.frameId, cached: false });
	});
	cdp.on('Network.requestServedFromCache', (event) => {
		const request = requests.get(event.requestId);
		if (request) request.cached = true;
	});
	return {
		/** the frame ids, and whether each frame's loads were served from the memory cache */
		cachedIn: (frameId) =>
			[...requests.values()]
				.filter((request) => request.frame === frameId)
				.some((request) => request.cached),
		frameId: async (frame) => {
			const { frameTree } = await cdp.send('Page.getFrameTree');
			const walk = (node) => [
				node.frame,
				...(node.childFrames ?? []).flatMap(walk),
			];
			return (
				walk(frameTree).find(
					(f) => f.url + (f.urlFragment ?? '') === frame.url(),
				)?.id ?? null
			);
		},
	};
}

/** a new frame of `top` showing `src` (sandboxed by `sandbox`), and what it reported */
async function step(tab, top, src, sandbox) {
	const before = new Set(tab.frames());
	await top.evaluate(
		([src, sandbox]) => {
			const frame = document.createElement('iframe');
			if (sandbox) frame.sandbox = sandbox;
			frame.src = src;
			document.body.append(frame);
		},
		[src, sandbox ?? null],
	);
	let frame;
	for (let i = 0; i < 80 && !frame; i++) {
		await sleep(250);
		frame = tab
			.frames()
			.find((f) => !before.has(f) && f.url() && f.url() !== 'about:blank');
	}
	let share = null;
	for (let i = 0; i < 80 && !share; i++) {
		await sleep(250);
		share = await frame
			?.evaluate(() => window.__share ?? null)
			.catch(() => null);
	}
	return { frame, share };
}

/** what each step saw of a run, `as` an image or a font */
async function run(tab, top, tag, as) {
	const network = await watch(tab, top);
	const key = `${tag}-${as}-${Date.now()}`;
	const url = resource(key, as);
	const seen = {};
	for (const [name, site, sandbox] of STEPS) {
		const { frame, share } = await step(
			tab,
			top,
			childURL(site, as, url, name),
			sandbox,
		);
		await sleep(300);
		const frameId = frame ? await network.frameId(frame) : null;
		seen[name] = {
			loaded: share?.loaded ?? null,
			// (waited for the origin, or not)
			waited: share ? share.ms >= WAIT_MS - 50 : null,
			ms: share?.ms ?? null,
			entries: share?.entries ?? null,
			// a frame of another renderer is not in the tab's own session
			cached: frameId === null ? null : network.cachedIn(frameId),
			reached: (await (await fetch(`${A}sop/log?k=${key}`)).json()).length,
		};
	}
	return { seen };
}

const browser = await launch();

const nativeTab = await browser.newPage();
await nativeTab.goto(`${A}pages/frame-memory.html?top`);
await nativeTab.waitForFunction(() => typeof window.__ranAt === 'number');
const native = {};
for (const as of ['image', 'font'])
	native[as] = (await run(nativeTab, nativeTab.mainFrame(), 'native', as)).seen;
await nativeTab.close();

// what the comparison relies on, so a change in the browser shows here first
for (const as of ['image', 'font']) {
	const seen = native[as];
	ok(
		`natively, a site's second document takes the ${as} from the memory cache of its renderer`,
		seen.A2?.loaded &&
			seen.A2.cached === true &&
			!seen.A2.waited &&
			seen.A2.reached === 1,
		JSON.stringify(seen.A2),
	);
	ok(
		`natively, another site's document waits for the ${as} from the network, and so does an opaque one`,
		seen.B1?.loaded &&
			seen.B1.waited &&
			seen.B1.reached === 2 &&
			seen.opaque?.waited === true,
		JSON.stringify([seen.B1, seen.opaque]),
	);
}

/** a step's report as compared: what the page can tell, and what the renderer did */
const pageView = (seen) =>
	JSON.stringify({
		loaded: seen?.loaded ?? null,
		waited: seen?.waited ?? null,
		entries: seen?.entries ?? null,
	});

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const tab = await openDemo(browser, base);
	const before = new Set(tab.frames());
	await submitLanding(tab, `${A}pages/frame-memory.html?top`);
	let top;
	for (let i = 0; i < 120 && !top; i++) {
		await sleep(250);
		top = tab.frames().findLast((f) => !before.has(f) && ROUTE.test(f.url()));
	}
	await top.waitForFunction(() => typeof window.__ranAt === 'number', null, {
		timeout: 30000,
	});
	for (const as of ['image', 'font']) {
		const { seen } = await run(tab, top, mode, as);
		const want = native[as];
		for (const [name] of STEPS)
			ok(
				`${mode}: ${as}, ${name}: what the document can tell of its load, as natively`,
				pageView(seen[name]) === pageView(want[name]),
				`\n      native  ${pageView(want[name])}\n      proxied ${pageView(seen[name])}`,
			);
		ok(
			`${mode}: ${as}: a site's next documents take the renderer's copy, as natively (no request reaches the worker)`,
			seen.A2.cached === true && seen.A3.cached === true && seen.B2.cached,
			JSON.stringify([seen.A2, seen.A3, seen.B2]),
		);
		ok(
			`${mode}: ${as}: another site's document, and an opaque one, take nothing of site A's copy`,
			seen.B1.cached === false &&
				seen.B1.waited &&
				seen.opaque.cached === false &&
				seen.opaque.waited,
			JSON.stringify([seen.B1, seen.opaque]),
		);
		ok(
			`${mode}: ${as}: the origin was asked as often as natively`,
			STEPS.every(([name]) => seen[name].reached === want[name].reached),
			JSON.stringify(
				STEPS.map(([name]) => [name, want[name].reached, seen[name].reached]),
			),
		);
		if (as !== 'image') continue;
		// the route a document of site A loaded, as a document of site B
		// names it: routed again, as that site's (a resource site B never
		// loaded, so its own copy cannot answer)
		const url = resource(`${mode}-named-${Date.now()}`, as);
		const routes = [];
		const listen = (request) => {
			if (
				request.resourceType() === 'image' &&
				/\/binary[;/]/.test(request.url())
			)
				routes.push(request.url());
		};
		tab.on('request', listen);
		const { share: again } = await step(tab, top, childURL(A, as, url, 'A4'));
		await sleep(300);
		const routeOfA = routes.at(-1);
		const { share: named } = await step(
			tab,
			top,
			childURL(B, as, routeOfA ?? url, 'Bnamed'),
		);
		await sleep(300);
		tab.off('request', listen);
		const marks = [
			...new Set(routes.map((route) => /;m=([\w-]+)/.exec(route)?.[1])),
		];
		ok(
			`${mode}: a document of site B that names the route site A's documents loaded waits for its own load`,
			again?.loaded && named?.loaded && named.ms >= WAIT_MS - 50,
			JSON.stringify({ again, named, routeOfA }),
		);
		ok(
			`${mode}: the two sites' routes carry two marks, neither of which names its site`,
			marks.length === 2 &&
				marks.every(
					(mark) =>
						mark &&
						!/127|localhost/.test(mark) &&
						!new URL(A).host.includes(mark),
				),
			JSON.stringify({ marks, routes }),
		);
	}
	await tab.close();
}

await done(browser);
