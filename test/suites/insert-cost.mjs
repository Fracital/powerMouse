// Inserting nodes into a connected tree runs the insertion hooks: every
// element inserted gets its attributes routed if a hook watches them (nodes a
// DOMParser made were never seen by the hooks). The pass swapped every
// element's prototype twice to read its attributes, asked each one whether
// it was a style through a getter that threw for a missing parent, and
// tried a querySelector to learn whether a node was an element: on YouTube,
// which stamps Polymer templates by the thousand, that was over half a
// second of the page's main thread. A page stamps a template of 250 plain
// elements 100 times, then inserts a DOMParser's link: the link is still
// routed and reads back as written, and (unless SKIP_TIMING) the stamping
// takes at most a few times what it takes natively. Both modes.
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

const browser = await launch();
const PAGE = `${FIXTURE}pages/insert-cost.html`;
// measured on a 32-core machine: 15 times native before (75 ms against
// 5), about 2 after
const LIMIT = 8;

const result = (frame) =>
	frame?.evaluate(() => window.__insert ?? null).catch(() => null);

// natively, framed like a proxied page is (best of three)
const nativePage = await browser.newPage();
let native = Infinity;
for (let i = 0; i < 3; i++) {
	await nativePage.setContent(`<iframe src="${PAGE}"></iframe>`);
	let value = null;
	for (let j = 0; j < 40 && !value; j++) {
		await sleep(100);
		value = await result(nativePage.frames()[1]);
	}
	if (value) native = Math.min(native, value.ms);
}
await nativePage.close();

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	let best = null;
	for (let i = 0; i < 3; i++) {
		await submitLanding(page, PAGE);
		let value = null;
		for (let j = 0; j < 120 && !value; j++) {
			await sleep(250);
			value = await result(
				page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
			);
		}
		if (value && (!best || value.ms < best.ms)) best = value;
	}
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	// the real attribute, through a realm the page's hooks do not reach
	const real =
		mode === 'same-origin'
			? await frame
					?.evaluate(() =>
						top.Element.prototype.getAttribute.call(
							document.getElementById('probe'),
							'href',
						),
					)
					.catch(() => null)
			: null;
	const detail = JSON.stringify({ native, proxied: best, real });
	ok(
		`${mode}: every stamped element is in the page`,
		best?.elements === 25000,
		detail,
	);
	ok(
		`${mode}: a link no hook saw is routed when it is inserted, and reads back as written`,
		best?.href === '/pages/insert-cost-target.html' &&
			(mode !== 'same-origin' || /\/stomp\/[\w-]+\/html\//.test(real ?? '')),
		detail,
	);
	if (process.env.SKIP_TIMING !== '1')
		ok(
			`${mode}: stamping takes at most ${LIMIT} times what it takes natively`,
			!!best && best.ms < Math.max(native, 1) * LIMIT,
			detail,
		);
	await page.close();
}

await done(browser);
