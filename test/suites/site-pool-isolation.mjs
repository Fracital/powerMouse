// The site pool in the isolated mode (RemoteController, docs/site-pool.md):
// the hub is the controller inside the controller frame on the proxy
// origin, its agents are that frame's frames on the slots' origins, and the
// proxied frames are the host page's own, navigated by the host to the slot
// of their site. Checked against Chrome on the same fixture (a page of
// 127.0.0.1 with a frame of localhost) and against the isolated mode
// without the pool (the demo's default there):
// - a page and the frame of another site in it are two processes, as
//   natively (out-of-process frames, the page's busy loop does not hold up
//   the frame's timers), where without the pool they share the proxy
//   origin's;
// - a frame that goes to its parent's site joins its process again;
// - the host frame's url, Back, Forward and reload follow the frame across
//   slots, and a link the page follows to another site is reported;
// - nothing the pages do throws.
import { done, FIXTURE, HOST, launch, ok, openDemo, sleep } from '../lib.mjs';

const A = FIXTURE;
const B = FIXTURE.replace('127.0.0.1', 'localhost');
const PAGE = 'pages/site-pool.html';

const browser = await launch();

/** the iframe targets (out-of-process frames) the browser has, by URL */
async function oopifs(page) {
	const cdp = await page.context().newCDPSession(page);
	const { targetInfos } = await cdp.send('Target.getTargets');
	await cdp.detach();
	return targetInfos.filter((t) => t.type === 'iframe').map((t) => t.url);
}
const asPage = (frame, code) =>
	frame.evaluate((code) => Function(code)(), code);
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
async function observe(parent) {
	const gap = await asPage(parent, 'return __sp.probe()');
	const rtt = await asPage(parent, 'return __sp.rtt(100)');
	return { gap, rtt };
}
const slotOf = (url) => {
	try {
		return new URL(url).origin;
	} catch (error) {
		return null;
	}
};

// --- natively ---
const context = await browser.newContext();
const native = await context.newPage();
await native.goto(
	`${A}${PAGE}?native&child=${encodeURIComponent(`${B}${PAGE}?nc`)}`,
);
const nativeChild = await childOf(native, (u) => u.startsWith(B));
const nativeCross = await observe(native.mainFrame(), nativeChild);
ok(
	'natively, the frame of another site is out of process and not held up',
	(await oopifs(native)).some((url) => url.startsWith(B)) &&
		nativeCross.gap < 200,
	`${nativeCross.gap} ms`,
);
await native.close();
await context.close();

/** the demo's isolated host page with a RemoteFrame of its own, `query` on its address */
async function host(query) {
	const page = await openDemo(browser, `${HOST}${query}`);
	await page.waitForFunction(
		() => window.controller && window.controller.isReady,
		null,
		{ timeout: 45000 },
	);
	await page.evaluate(() => {
		document.getElementById('landing')?.style.setProperty('display', 'none');
		window.show = async (url) => {
			const element = document.createElement('iframe');
			element.style.cssText = 'width: 400px; height: 200px';
			document.body.append(element);
			const frame = window.controller.createFrame(element);
			window.shown = frame;
			await frame.go(url);
			return element;
		};
	});
	return page;
}
async function show(page, url, test) {
	const started = Date.now();
	const element = (
		await page.evaluateHandle((url) => window.show(url), url)
	).asElement();
	const frame = await frameOf(element, test);
	return { element, frame, ms: Date.now() - started };
}
const proxied = (url) => url.includes('/stomp/');

// --- without the pool ---
const plain = await host('?nopool');
const proxyOrigin = await plain.evaluate(() => window.controller.proxyOrigin);
ok(
	'without the pool the isolated controller says it shows no pool',
	(await plain.evaluate(() => window.controller.siteMode)) === false,
);
const sa = await show(
	plain,
	`${A}${PAGE}?sa&child=${encodeURIComponent(`${B}${PAGE}?sab`)}`,
	proxied,
);
const sab = await childOf(sa.frame, proxied);
console.log(`first frame without the pool: ${sa.ms} ms to show`);
const single = await observe(sa.frame, sab);
ok(
	'without the pool both sites share the proxy origin process',
	single.gap >= 280 &&
		slotOf(sa.frame.url()) === proxyOrigin &&
		slotOf(sab.url()) === proxyOrigin,
	`${single.gap} ms`,
);
await plain.close();

// --- with the pool (the demo's default in the isolated mode too) ---
const page = await host('');
// a demo without slot ports (STOMP_SITE_POOL=0) has no pool to show
if (!(await page.evaluate(() => window.STOMP_CONFIG.sitePool?.length))) {
	console.log('SKIP the pool half: the demo answers on no slot ports');
	await done(browser);
}
const slots = await page.evaluate(() =>
	window.STOMP_CONFIG.sitePool.map(
		(port) =>
			`${new URL(window.controller.proxyOrigin).protocol}//127.0.0.1:${port}`,
	),
);
ok(
	'the isolated controller shows the sites from a pool',
	(await page.evaluate(() => window.controller.siteMode)) === true,
	JSON.stringify(slots),
);
const inPool = (url) => slots.includes(slotOf(url)) && proxied(url);
const a = await show(
	page,
	`${A}${PAGE}?a&child=${encodeURIComponent(`${B}${PAGE}?ab`)}`,
	inPool,
);
const ab = await childOf(a.frame, inPool);
const slotA = slotOf(a.frame.url());
const slotB = slotOf(ab.url());
ok(
	'a site is shown from a slot, the frame of another site in it from another',
	slots.includes(slotA) && slots.includes(slotB) && slotA !== slotB,
	`${slotA} ${slotB}`,
);
console.log(`first frame of the pool: ${a.ms} ms to show`);
ok(
	'each proxied page knows its real URL',
	(await asPage(a.frame, 'return location.href')).startsWith(
		`${A}${PAGE}?a&`,
	) && (await asPage(ab, 'return location.href')) === `${B}${PAGE}?ab`,
);
ok(
	'the host frame reports the real URL',
	(await page.evaluate(() => window.shown.url))?.startsWith(`${A}${PAGE}?a&`),
	await page.evaluate(() => window.shown.url),
);
const targets = await oopifs(page);
ok(
	'the page and the frame of another site are out-of-process frames of their slots',
	targets.some((url) => url.startsWith(slotA)) &&
		targets.some((url) => url.startsWith(slotB)),
	JSON.stringify(targets),
);
const cross = await observe(a.frame, ab);
ok(
	'the page busy loop does not hold up the frame of another site, as natively',
	cross.gap < 200,
	`${cross.gap} ms (natively ${nativeCross.gap} ms, without the pool ${single.gap} ms)`,
);
ok(
	'each side of a message sees the other site as its origin, as natively',
	cross.rtt.child === nativeCross.rtt.child &&
		cross.rtt.parent === nativeCross.rtt.parent,
	JSON.stringify(cross.rtt),
);
console.log(
	`timers held up by the parent's 300 ms: natively ${nativeCross.gap}, pool ${cross.gap}, without the pool ${single.gap}`,
);
// the frame goes to its parent's site: into the parent's slot and process
await asPage(ab, `location.href = ${JSON.stringify(`${A}${PAGE}?aa`)}`);
const aa = await childOf(
	a.frame,
	(url) => slotOf(url) === slotA && proxied(url),
);
const same = await observe(a.frame, aa);
ok(
	'a frame that goes to its parent site joins its slot and process',
	slotOf(aa.url()) === slotA && same.gap >= 280,
	`${aa.url()} ${same.gap} ms`,
);

// the host frame's history across slots
const h = await show(page, `${A}${PAGE}?h1`, inPool);
const url = () => page.evaluate(() => window.shown.url);
await page.evaluate((to) => window.shown.go(to), `${B}${PAGE}?h2`);
await frameOf(h.element, (u) => slotOf(u) === slotB);
ok(
	'go() shows the next site from its slot',
	(await url()) === `${B}${PAGE}?h2`,
	await url(),
);
ok(
	'and the frame can go back',
	(await page.evaluate(() => window.shown.canGoBack)) === true,
);
ok(
	'Back steps to the slot before',
	(await page.evaluate(() => window.shown.back())) === true &&
		(await url()) === `${A}${PAGE}?h1` &&
		slotOf((await h.element.contentFrame()).url()) === slotA,
	`${await url()} ${(await h.element.contentFrame()).url()}`,
);
ok(
	'Forward to the slot after',
	(await page.evaluate(() => window.shown.forward())) === true &&
		(await url()) === `${B}${PAGE}?h2`,
	await url(),
);
/**
 * the frame's url once it is `want` and its document loaded (a navigation
 * of a frame whose document is still loading replaces its entry), or what
 * it is after 10 s
 */
async function settled(want) {
	for (let i = 0; i < 100 && (await url()) !== want; i++) await sleep(100);
	await frameOf(h.element);
	return url();
}
await page.evaluate((to) => window.shown.go(to), `${B}${PAGE}?h3`);
await settled(`${B}${PAGE}?h3`);
// a step within one slot: its agent's (a traversal, which resolves before
// the document it shows reports, as without the pool)
await page.evaluate((to) => window.shown.go(to), `${B}${PAGE}?h4`);
await settled(`${B}${PAGE}?h4`);
const within = await page.evaluate(() => window.shown.back());
ok(
	'Back within a slot steps through its agent',
	within === true && (await settled(`${B}${PAGE}?h3`)) === `${B}${PAGE}?h3`,
	`${within} ${await url()}`,
);
ok(
	'reload reloads the document of a slot',
	(await page.evaluate(() => window.shown.reload())) === true &&
		(await settled(`${B}${PAGE}?h3`)) === `${B}${PAGE}?h3`,
	await url(),
);
// a link the page follows to another site
await page.evaluate(
	(to) => window.shown.go(to),
	`${A}${PAGE}?to=${encodeURIComponent(`${B}${PAGE}?linked`)}`,
);
const linking = await frameOf(h.element, (u) => slotOf(u) === slotA);
await linking.click('#to');
for (let i = 0; i < 100 && (await url()) !== `${B}${PAGE}?linked`; i++)
	await sleep(100);
ok(
	"a link to another site is reported from that site's slot",
	(await url()) === `${B}${PAGE}?linked` &&
		slotOf((await h.element.contentFrame()).url()) === slotB,
	await url(),
);
ok(
	'nothing threw in the host page',
	page.errors.length === 0,
	page.errors.join(' | '),
);

await done(browser);
