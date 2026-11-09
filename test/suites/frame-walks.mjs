// The frame-tree walks of imgur's ad sync pixels (frame-walks.html), from a
// document nested in a frame of another origin: a climb by `parent` until
// `top`, and a descent through every `frames[i]` from `top`. Compared with
// the page loaded natively, in both demo modes. Before, imgur never
// rendered through the proxy and its tab hung: the climb never reached
// `top` (one frame's own view of the top was not the other's, and the top's
// parent read as the raw top), and a frame not yet loaded read as the top,
// so the descent went round the tree until the tab ran out of memory.
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

const target = `${FIXTURE}pages/frame-walks.html`;
const read = () => (window.__fw?.done ? window.__fw : null);
const find = async (frames) => {
	for (const frame of frames) {
		const value = await frame.evaluate(read).catch(() => null);
		if (value) return value;
	}
	return null;
};

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 60 && !native; i++) {
	await sleep(250);
	native = await find(nativePage.frames());
}
await nativePage.close();
ok(
	'natively, the climb takes two steps and the descent visits four windows',
	native?.climb === 2 && native?.descent === 4,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	// a slow runner can take more than ten seconds to show the frames
	for (let i = 0; i < 120 && !proxied; i++) {
		await sleep(250);
		proxied = await find(
			page.frames().filter((f) => /\/stomp\/[\w-]+\/html/.test(f.url())),
		);
	}
	ok(`${mode}: the walks finish through the proxy`, !!proxied);
	for (const name of Object.keys(native ?? {})) {
		const a = JSON.stringify(native[name]);
		const b = JSON.stringify(proxied?.[name]);
		ok(
			`${mode}: ${name} reads as natively`,
			a === b,
			a === b ? a : `native ${a} proxied ${b}`,
		);
	}
	await page.close();
}
await done(browser);
