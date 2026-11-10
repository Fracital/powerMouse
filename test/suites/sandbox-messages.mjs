// A frame sandboxed without allow-same-origin posts to its parent, its
// sibling and itself as natively (sandbox-messages.html). LinkedIn showed
// "Invalid target origin 'null'": the hooked postMessage named the sending
// realm's location.origin as the target origin, which reads "null" in an
// opaque document (and in an about:srcdoc one), and Chrome refuses that.
// The frame posts with "*", the site's origin, an options bag, another
// origin, "/", "null" and no target origin; a sandboxed srcdoc frame and a
// plain one post to the page and to themselves. What each receiver gets
// (event.origin, event.source, the data) and what each sender catches are
// compared with the page loaded natively, in both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	proxiedOnlyErrors,
	PROXY,
	sleep,
	submitLanding,
	trackErrors,
} from '../lib.mjs';

const target = `${FIXTURE}pages/sandbox-messages.html`;
const read = () => (window.__sm?.done ? window.__sm : null);
const sorted = (list) =>
	list && [...list].map((entry) => JSON.stringify(entry)).sort();

// the sandboxed frame collects garbage once it has loaded and the page
// holds its own load 1.5 s longer (sandbox-messages.html): an element
// wrapper nothing references is made again by whatever reaches the element
// next, in that code's realm. The sandboxed frame's own inject did, from an
// IntersectionObserver entry's target (AnimationFrames), and the page's
// iframe.contentWindow then ran the frame's hooks: its messages reached the
// page from a window that matched no frame. That took a busy machine (about
// 1 run in 3 here, more on CI); this makes it every run
const browser = await launch(['--js-flags=--expose-gc']);
const nativePage = await browser.newPage();
const nativeErrors = trackErrors(nativePage);
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 60 && !native; i++) {
	await sleep(250);
	native = await nativePage.evaluate(read).catch(() => null);
}
await nativePage.close();
ok(
	'natively, the sandboxed frame is opaque and its messages for "*" arrive from it with origin "null"',
	native?.reports?.box?.origin === 'null' &&
		native.parent.some(
			(m) => m.kind === 'star' && m.origin === 'null' && m.from === 'box',
		) &&
		native.sibling?.some(
			(m) => m.kind === 'sibling' && m.origin === 'null' && m.from === 'box',
		),
	JSON.stringify(native),
);

const errors = [];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	for (let i = 0; i < 80 && !proxied; i++) {
		await sleep(250);
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())))
			proxied ??= await frame.evaluate(read).catch(() => null);
	}
	ok(`${mode}: the page ran to the end`, !!proxied);
	const same = (name, a, b) => {
		const x = JSON.stringify(a);
		const y = JSON.stringify(b);
		ok(`${mode}: ${name} as natively`, x === y, `native ${x} proxied ${y}`);
	};
	same(
		'what the sandboxed frame caught is',
		native?.reports?.box?.threw,
		proxied?.reports?.box?.threw,
	);
	same(
		"the sandboxed frame's origin and location.origin are",
		[native?.reports?.box?.origin, native?.reports?.box?.locationOrigin],
		[proxied?.reports?.box?.origin, proxied?.reports?.box?.locationOrigin],
	);
	same(
		'what reaches the parent (kind, origin, source) is',
		sorted(native?.parent),
		sorted(proxied?.parent),
	);
	same(
		'what reaches the sibling (kind, origin, source) is',
		sorted(native?.sibling),
		sorted(proxied?.sibling),
	);
	same(
		'what the sandboxed frame posts to itself (kind, origin, source) is',
		sorted(native?.reports?.box?.self),
		sorted(proxied?.reports?.box?.self),
	);
	for (const [who, name] of [
		['doc', 'sandboxed srcdoc frame'],
		['plain', 'srcdoc frame'],
	])
		same(
			`what the ${name} catches, its origin and what it posts to itself are`,
			native?.reports?.[who],
			proxied?.reports?.[who],
		);
	errors.push(
		...proxiedOnlyErrors(nativeErrors, page.errors, page.errorStacks).map(
			(e) => `${mode}: ${e}`,
		),
	);
	await page.close();
}
await done(browser, errors);
