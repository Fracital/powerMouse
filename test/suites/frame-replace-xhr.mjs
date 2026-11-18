// A frame its parent sends to another origin from its initial about:blank,
// in the turn that made it, makes an XMLHttpRequest of its own origin with a
// header that is not safelisted, and asks nothing first
// (test/pages/frame-replace-xhr.html). On bankofamerica.com porte.js makes
// the fraud-detection frame this way (src about:blank, appendChild, then
// contentWindow.location.replace(iconnectmx.html on dull.bankofamerica.com)),
// and the frame posts to its own origin with X-Embedding-Uri. Its page report
// then reads every frame's window while each is still on its initial
// about:blank, which through the proxy injected the new context's about:blank
// and left the frame's document with no controller (Chrome 157). Compared with
// native in both demo modes, for a frame given its src and the two location
// writes, and the browser's own view of whether the worker controls each.
import {
	done,
	evaluateIsolated,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

// www.localhost frames dull.localhost: another origin of the same site, as
// www.bankofamerica.com frames dull.bankofamerica.com
const target = `http://www.localhost:${new URL(FIXTURE).port}/pages/frame-replace-xhr.html`;
const ways = ['src', 'replace', 'assign', 'porte'].flatMap((way) => [
	`${way}-0`,
	`${way}-300`,
]);
const show = (value) => JSON.stringify(value) ?? 'undefined';

async function collect(find) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		const record = await (
			await find()
		)
			?.evaluate(() =>
				window.__record && window.__record.done
					? JSON.stringify(window.__record)
					: null,
			)
			.catch(() => null);
		if (record) return JSON.parse(record);
	}
	return {};
}

const browser = await launch();
const errors = [];

const nativePage = await browser.newPage();
nativePage.on('pageerror', (error) => errors.push(`native: ${error.message}`));
await nativePage.goto(target);
const native = await collect(async () => nativePage.mainFrame());
await nativePage.close();
ok(
	'native: every frame posts to its own origin',
	ways.every((way) => native[way] === '200 {"bytes":6}'),
	show(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const top = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	const proxied = await collect(async () => top());
	for (const way of ways)
		ok(
			`${mode}: the ${way} frame's post as native`,
			native[way] !== undefined && proxied[way] === native[way],
			`native ${show(native[way])} -> proxied ${show(proxied[way])}`,
		);
	// what the browser itself says of each frame (a world the page's hooks
	// do not reach): the service worker controls it, as it controls every
	// proxied document
	const frames = (top()?.childFrames() ?? []).filter((frame) =>
		/html:nested:/.test(frame.url()),
	);
	const controlled = [];
	for (const frame of frames)
		controlled.push(
			await evaluateIsolated(frame, () => !!navigator.serviceWorker.controller)
				.then((yes) => (yes ? 'controlled' : 'not controlled'))
				.catch((error) => `threw ${error.message}`),
		);
	ok(
		`${mode}: every frame's document is controlled`,
		controlled.length === ways.length &&
			controlled.every((line) => line === 'controlled'),
		show(controlled),
	);
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}

await done(browser, errors);
