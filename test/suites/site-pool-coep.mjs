// The site pool (docs/site-pool.md) under production's host page, which is
// cross-origin isolated (STOMP_ISOLATION=on: COOP same-origin and COEP
// credentialless). A frame of another site is shown from another slot than
// its page's, so to the browser it is a frame of another origin in a
// document with an embedder policy: everything its navigations meet on the
// way, the proxy's own redirects included, has to carry a
// Cross-Origin-Resource-Policy that lets that document have it, or Chrome
// refuses the frame (blockedReason
// corp-not-same-origin-after-defaulted-to-same-origin-by-coep) and it shows
// its error page. Natively, a page of A with a frame of B: the frame goes
// on to another page of B, back to A by a script's location.href, by a
// link and by a form it posts, and each lands where it went.
// Through the demo's own controller (the pool on, a cross-origin isolated
// host) each lands there as well, on the slot of its site.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const PAGE = 'pages/site-pool.html';
const run = Date.now().toString(36);

const browser = await launch();
const context = await browser.newContext();
const errors = [];

/** the frame of `element` once its URL passes `test` (null when it never does) */
async function frameOf(element, test, ms = 30000) {
	const until = Date.now() + ms;
	for (;;) {
		const frame = await element.contentFrame();
		const url = frame?.url() ?? '';
		if (frame && test(url)) {
			await frame.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
			return frame;
		}
		// the browser refused the navigation: its error page is where it ends
		if (url.startsWith('chrome-error:') || Date.now() > until) return frame;
		await sleep(100);
	}
}

/** where the frame's document says it is, run as the page's own code (rewritten) */
const hrefOf = (frame) =>
	frame
		?.evaluate(() => Function('return location.href')())
		.catch((error) => `(${error.message.split('\n')[0]})`);

// each way the frame of B goes, the URL it goes to and how it goes there
const WAYS = {
	'to another page of its own site, by location.href': {
		to: () => `${B}${PAGE}?bb`,
		go: (frame, to) =>
			frame.evaluate(
				(to) => Function(`location.href = ${JSON.stringify(to)}`)(),
				to,
			),
	},
	"to its page's site, by location.href": {
		to: () => `${A}${PAGE}?ba`,
		go: (frame, to) =>
			frame.evaluate(
				(to) => Function(`location.href = ${JSON.stringify(to)}`)(),
				to,
			),
	},
	"to its page's site, by a link": {
		to: (key) => `${A}${PAGE}?link-${key}`,
		go: (frame) => frame.evaluate(() => document.getElementById('to').click()),
	},
	"to its page's site, by a form": {
		to: (key) => `${A}${PAGE}?form-${key}`,
		go: (frame) =>
			frame.evaluate(() => document.getElementById('post').submit()),
	},
};
/** the frame of B's page, with `to` where its link and form go */
const childOf = (to) => `${B}${PAGE}?to=${encodeURIComponent(to)}`;

// --- natively ---
const native = await context.newPage();
const nativeLanded = {};
for (const [way, { to, go }] of Object.entries(WAYS)) {
	const target = to(run);
	await native.goto(
		`${A}${PAGE}?n&child=${encodeURIComponent(childOf(target))}`,
	);
	const element = await native.$('#child');
	const frame = await frameOf(element, (url) => url.startsWith(B));
	await go(frame, target);
	const landed = await frameOf(element, (url) => url === target);
	nativeLanded[way] = landed?.url() ?? null;
	ok(
		`natively, a frame of another site goes ${way}`,
		nativeLanded[way] === target,
		nativeLanded[way],
	);
}
await native.close();

// --- proxied: the demo's page, its pool, a cross-origin isolated host ---
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
const host = await page.evaluate(() => ({
	isolated: globalThis.crossOriginIsolated,
	pool: window.controller.siteMode === true,
	slots: window.STOMP_CONFIG.sitePool ?? [],
}));
ok(
	"the host's page is cross-origin isolated and shows sites from a pool, as in production",
	host.isolated === true && host.pool && host.slots.length >= 2,
	JSON.stringify(host),
);
const slotOf = (url) => {
	try {
		const { origin, port } = new URL(url);
		return host.slots.includes(Number(port)) && url.includes('/stomp/')
			? origin
			: null;
	} catch (error) {
		return null;
	}
};
await page.evaluate(() => {
	// the demo's landing overlay would take the clicks
	document.getElementById('landing')?.style.setProperty('display', 'none');
});
for (const [way, { to, go }] of Object.entries(WAYS)) {
	const target = to(run);
	const element = (
		await page.evaluateHandle(
			(url) => {
				const element = document.createElement('iframe');
				element.style.cssText = 'width: 400px; height: 300px';
				document.body.append(element);
				window.controller.createFrame(element).go(url);
				return element;
			},
			`${A}${PAGE}?p&child=${encodeURIComponent(childOf(target))}`,
		)
	).asElement();
	const a = await frameOf(element, (url) => !!slotOf(url));
	const child = await a.$('#child');
	const b = await frameOf(child, (url) => {
		const slot = slotOf(url);
		return !!slot && slot !== slotOf(a.url());
	});
	if (!b || !slotOf(b.url())) {
		ok(
			`a frame of another site goes ${way}, as natively`,
			false,
			`B never showed: ${b?.url()}`,
		);
		continue;
	}
	await go(b, target);
	const wanted = target.startsWith(A) ? slotOf(a.url()) : slotOf(b.url());
	const landed = await frameOf(
		child,
		(url) => slotOf(url) === wanted && url !== b.url(),
	);
	const href = await hrefOf(landed);
	ok(
		`a frame of another site goes ${way}, as natively`,
		href === nativeLanded[way] && slotOf(landed?.url()) === wanted,
		`native ${nativeLanded[way]} proxied ${href} at ${landed?.url()}`,
	);
	await element.evaluate((element) => element.remove());
}
ok('no page errors', errors.length === 0, errors.join(' | '));
await done(browser);
