// The site pool (docs/site-pool.md) on a revisit: a site keeps the slot it
// was given on an earlier visit, so a frame can end up in the slot of the
// frame it is in, a document of another site there, while the page above
// both is in another slot. Natively three sites, the frames' parents are
// the browser's: a climb from the inner frame by `parent` reaches `top`
// in two steps, the loop with which ad and consent scripts look for a
// frame up the tree (Prebid's and the IAB stubs' `while (win !== top)
// win = win.parent`). A proxied frame of another site in reach is a
// stand-in, whose `parent` answered with the stand-in itself when its own
// parent was of another slot: the climb never got to `top`, and Yahoo's
// ads spun their renderer for good on a revisit.
// Checked against Chrome on the same pages: a page of 127.0.0.1, a frame
// of localhost in it, and a frame of 127.0.0.2 in that.
// The other layout, the inner frame in the page's slot (a first visit
// with two slots makes it): the frame between them is of another slot, and
// the browser's own `parent` of its window is the page's window, of the
// inner frame's origin. In both, the inner frame reaches nothing of the page
// above (`parent.parent.location.href`, its document), as natively: a window
// of another site is never the page's raw, whatever slot it is in.
import { done, FIXTURE, launch, ok, PROXY, REWRITER, sleep } from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const C = FIXTURE.replace('127.0.0.1', '127.0.0.2');
const PAGE = 'pages/site-pool.html';

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

/** `code` run in `frame` as the page's own code runs: rewritten (the frame's Function) */
const asPage = (frame, code) =>
	frame.evaluate((code) => Function(code)(), code);

/** the frame of an element handle, once it shows a document whose URL passes `test` */
async function frameOf(element, test = () => true, ms = 45000) {
	const until = Date.now() + ms;
	for (;;) {
		const frame = await element.contentFrame();
		if (frame && test(frame.url())) {
			try {
				await frame.waitForLoadState('load', { timeout: 5000 });
			} catch (error) {
				// loaded by the time its URL shows
			}
			return frame;
		}
		if (Date.now() > until) return frame;
		await sleep(100);
	}
}
const childOf = async (parent, test, ms) =>
	frameOf(await parent.$('#child'), test, ms);

// the climb, bounded: what it took, whether it got to `top`, and what each
// step's window says of itself where it can
const CLIMB = `
	let win = window;
	let steps = 0;
	for (; steps < 16; steps++) {
		if (win === window.top) break;
		win = win.parent;
	}
	return { steps, reached: win === window.top, parentOfTop: window.top.parent === window.top };
`;
// what the inner frame reaches of the page above its parent
const REACH = `
	const name = (read) => { try { read(); return 'read'; } catch (error) { return error.name; } };
	return {
		href: name(() => parent.parent.location.href),
		document: name(() => parent.parent.document.title),
		topDocument: name(() => top.document.title),
		viaFrames: name(() => parent.frames.parent.document.title),
		viaOpener: name(() => parent.parent.frames[0].parent.document.title),
	};
`;
// the same through the browser's own getters, past the rewrite: whatever
// they answer (natively the page's window, of another origin), the page's
// document is out of reach
const PAST = `
	const name = (read) => { try { read(); return 'read'; } catch (error) { return error.name; } };
	const parentOf = Object.getOwnPropertyDescriptor(window, 'parent').get;
	const topOf = Object.getOwnPropertyDescriptor(window, 'top').get;
	return {
		parentGetter: name(() => parentOf.call(parentOf.call(window)).document.title),
		topGetter: name(() => topOf.call(window).document.title),
		reflect: name(() => Reflect.get(Reflect.get(window, 'parent'), 'parent').document.title),
	};
`;
const nested = (base) =>
	`${A}${PAGE}?${base}&child=${encodeURIComponent(
		`${B}${PAGE}?${base}-b&child=${encodeURIComponent(`${C}${PAGE}?${base}-c`)}`,
	)}`;

// --- natively ---
const native = await context.newPage();
await native.goto(nested('native'));
const nativeB = await childOf(native.mainFrame(), (u) => u.startsWith(B));
const nativeC = await childOf(nativeB, (u) => u.startsWith(C));
const nativeClimb = await nativeC.evaluate(new Function(CLIMB));
ok(
	'natively, the inner frame climbs to top by parent in two steps',
	nativeClimb.steps === 2 && nativeClimb.reached,
	JSON.stringify(nativeClimb),
);
const nativeReach = await nativeC.evaluate(new Function(REACH));
ok(
	'natively, the inner frame reaches nothing of the page',
	Object.values(nativeReach).every((value) => value === 'SecurityError'),
	JSON.stringify(nativeReach),
);
/** the inner frame of a proxied layout reads the page above as natively */
const reachesAsNatively = async (name, frame) => {
	const reach = await asPage(frame, REACH);
	ok(
		`${name}: the inner frame reaches nothing of the page, as natively`,
		JSON.stringify(reach) === JSON.stringify(nativeReach),
		JSON.stringify({ native: nativeReach, proxied: reach }),
	);
	const past = await asPage(frame, PAST);
	ok(
		`${name}: nor through the browser's own getters`,
		Object.values(past).every((value) => value !== 'read'),
		JSON.stringify(past),
	);
};
await native.close();

// --- proxied: a pool of two slots the demo serves, and the single-origin controller ---
await page.goto(`${PROXY}?nopool`);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const ports = await page.evaluate(() => window.STOMP_CONFIG.sitePool);
ok(
	'the demo server answers on four ports of STOMP_SITE_POOL',
	Array.isArray(ports) && ports.length >= 4,
	JSON.stringify(ports),
);
const SLOTS = ports.slice(-2).map((port) => `http://127.0.0.1:${port}`);
// a second pool of two, which this run gives no site before the page
const FRESH = ports.slice(-4, -2).map((port) => `http://127.0.0.1:${port}`);
const slotOf = (url) => {
	try {
		return new URL(url).origin;
	} catch (error) {
		return null;
	}
};
await page.evaluate(
	async ({ rewriter, SLOTS, FRESH }) => {
		document.getElementById('landing')?.style.setProperty('display', 'none');
		const { StompController } = await import('/stomp/controller.mjs');
		const make = (extra) =>
			new StompController({
				serviceworker: window.controller.serviceworker,
				transport: window.controller.transport,
				directory: '/stomp/',
				codec: 'xor',
				...rewriter,
				...extra,
			});
		window.pool = make({ sitePool: { origins: SLOTS } });
		window.fresh = make({ sitePool: { origins: FRESH } });
		window.single = make({});
		await Promise.all([
			window.pool.wait(),
			window.fresh.wait(),
			window.single.wait(),
		]);
		window.show = async (controller, url) => {
			const element = document.createElement('iframe');
			element.style.cssText = 'width: 600px; height: 300px';
			document.body.append(element);
			const frame = controller.createFrame(element);
			await frame.go(url);
			return element;
		};
	},
	{ rewriter: REWRITER, SLOTS, FRESH },
);
const show = async (controller, url, test) => {
	const element = (
		await page.evaluateHandle(
			({ controller, url }) => window.show(window[controller], url),
			{ controller, url },
		)
	).asElement();
	return frameOf(element, test);
};
const proxied =
	(slots = null) =>
	(url) =>
		url.includes('/stomp/') && (!slots || slots.includes(slotOf(url)));

// the first visit: a page of 127.0.0.2 alone, which takes the first slot
const first = await show('pool', `${C}${PAGE}?first`, proxied(SLOTS));
ok(
	'a first visit shows a site from a slot',
	SLOTS.includes(slotOf(first.url())),
	first.url(),
);

// the revisit: the page of 127.0.0.1 gets the slot nobody has, its frame of
// localhost the other one (never the slot of the document it comes from),
// and the frame of 127.0.0.2 in that keeps its slot from the first visit
const top = await show('pool', nested('pool'), proxied(SLOTS));
const frameB = await childOf(top, proxied(SLOTS));
const frameC = await childOf(frameB, proxied(SLOTS));
const layout = [top, frameB, frameC].map((frame) => slotOf(frame.url()));
ok(
	'on the revisit, the inner frame shares the slot of the frame it is in, the page has the other',
	layout[1] === layout[2] &&
		layout[0] !== layout[1] &&
		layout[2] === slotOf(first.url()),
	JSON.stringify(layout),
);
const poolClimb = await asPage(frameC, CLIMB);
ok(
	'the inner frame climbs to top by parent in two steps, as natively',
	poolClimb.steps === nativeClimb.steps && poolClimb.reached,
	JSON.stringify(poolClimb),
);
await reachesAsNatively('on the revisit', frameC);

// a first visit to the same pages with a pool of two: the page takes one
// slot, its frame the other, and the inner frame, of a third site, the
// page's (not its embedder's)
const freshTop = await show('fresh', nested('fresh'), proxied(FRESH));
const freshB = await childOf(freshTop, proxied(FRESH));
const freshC = await childOf(freshB, proxied(FRESH));
const freshLayout = [freshTop, freshB, freshC].map((frame) =>
	slotOf(frame.url()),
);
ok(
	'on a first visit, the inner frame shares the slot of the page',
	freshLayout[0] === freshLayout[2] && freshLayout[0] !== freshLayout[1],
	JSON.stringify(freshLayout),
);
// the frame of localhost between them is another slot's, and the browser's
// own `parent` of its window is the page's window, of the inner frame's
// origin: the inner frame gets the stand-in for the frame between, whose
// `parent` is the stand-in the inner frame has for `top`
const freshClimb = await asPage(freshC, CLIMB);
ok(
	'on a first visit too, the inner frame climbs to top by parent in two steps, as natively',
	freshClimb.steps === nativeClimb.steps && freshClimb.reached,
	JSON.stringify(freshClimb),
);
await reachesAsNatively('on a first visit', freshC);

// the single-origin controller, the same pages
const singleTop = await show('single', nested('single'), proxied());
const singleB = await childOf(singleTop, proxied());
const singleC = await childOf(singleB, proxied());
const singleClimb = await asPage(singleC, CLIMB);
ok(
	'with the single-origin controller too',
	singleClimb.steps === nativeClimb.steps && singleClimb.reached,
	JSON.stringify(singleClimb),
);
await reachesAsNatively('with the single-origin controller', singleC);

await done(browser, errors);
