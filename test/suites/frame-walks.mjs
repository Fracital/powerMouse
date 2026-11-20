// The frame-tree walks of imgur's ad sync pixels (frame-walks.html), from a
// document nested in a frame of another origin: a climb by `parent` until
// `top`, and a descent through every `frames[i]` from `top`. Compared with
// the page loaded natively, in both demo modes. Before, imgur never
// rendered through the proxy and its tab hung: the climb never reached
// `top` (one frame's own view of the top was not the other's, and the top's
// parent read as the raw top), and a frame not yet loaded read as the top,
// so the descent went round the tree until the tab ran out of memory.
// And the climb of a measurement tag in the about:blank and srcdoc children
// of a sandboxed safe frame (frame-walks-blank.html), with every way those
// children reach the top and its frames compared by identity: a sandboxed
// document made stand-ins of its own, so the child's `top` was not its
// parent's `parent`, and nytimes' tab hung in DoubleVerify's climb.
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

// Each target: what one frame holds (merged over every frame of the
// page: the children of a proxied frame are about:blank and about:srcdoc),
// when the merge is complete, and the native check
const safeFrame = () =>
	window.__fwb?.done
		? { [window.__who]: window.__fwb }
		: window.__fws
			? { frame: window.__fws }
			: null;
const targets = [
	[
		'',
		`${FIXTURE}pages/frame-walks.html`,
		() => (window.__fw?.done ? window.__fw : null),
		(all) => all.done,
		(native) => native?.climb === 2 && native?.descent === 4,
		'natively, the climb takes two steps and the descent visits four windows',
	],
	[
		'safe frame: ',
		`${FIXTURE}pages/frame-walks-blank.html`,
		safeFrame,
		(all) => all.blank && all.srcdoc && all.frame,
		(native) =>
			native?.blank?.climbTimed === 2 &&
			native?.srcdoc?.climbTimed === 2 &&
			native?.frame?.parentIsTop === true,
		"natively, the safe frame's children climb to the top in two steps",
	],
	[
		'opaque safe frame: ',
		`${FIXTURE}pages/frame-walks-blank.html?opaque`,
		safeFrame,
		(all) => all.srcdoc && all.frame,
		(native) =>
			native?.srcdoc?.climbTimed === 2 && native?.frame?.parentIsTop === true,
		"natively, an opaque safe frame's srcdoc child climbs to the top in two steps",
	],
];
const find = async (frames, read, ready) => {
	const all = {};
	for (const frame of frames)
		Object.assign(all, await frame.evaluate(read).catch(() => null));
	return ready(all) ? all : null;
};
// every value of `value`, by its path (`blank.climb`)
const leaves = (value, path = '') =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? Object.entries(value).flatMap(([key, inner]) =>
				leaves(inner, path ? `${path}.${key}` : key),
			)
		: [[path, value]];

const browser = await launch();
for (const [prefix, target, read, ready, nativeOk, nativeName] of targets) {
	const nativePage = await browser.newPage();
	await nativePage.goto(target);
	let native = null;
	for (let i = 0; i < 60 && !native; i++) {
		await sleep(250);
		native = await find(nativePage.frames(), read, ready);
	}
	await nativePage.close();
	ok(nativeName, nativeOk(native), JSON.stringify(native));

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
			proxied = await find(page.frames(), read, ready);
		}
		ok(`${mode}: ${prefix}the walks finish through the proxy`, !!proxied);
		const theirs = new Map(leaves(proxied ?? {}));
		for (const [name, value] of leaves(native ?? {})) {
			const a = JSON.stringify(value);
			const b = JSON.stringify(theirs.get(name));
			ok(
				`${mode}: ${prefix}${name} reads as natively`,
				a === b,
				a === b ? a : `native ${a} proxied ${b}`,
			);
		}
		await page.close();
	}
}
await done(browser);
