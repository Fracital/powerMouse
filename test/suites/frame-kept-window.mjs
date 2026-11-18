// A frame's requests are the frame's own after its parent read the frame's
// initial about:blank (test/pages/frame-kept-window.html): the parent's
// connect-src allows its own origin only, and each frame of another origin
// fetches its own. Through the proxy every document is of the proxy's
// origin, so Chrome keeps the about:blank's window for the frame's document,
// and with it the hooks the parent's bundle put on it. Reading that
// about:blank's navigator.serviceWorker left the document's container with
// no controller (Chrome 157), and the hooks sent its requests through the
// parent's realm: refused by the parent's policy and named as the parent's
// (figma's Vimeo players, 70-140 refusals a load). Compared with native in
// both demo modes; the parent's own request stays refused.
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

const target = `${FIXTURE}pages/frame-kept-window.html`;
const show = (value) => JSON.stringify(value) ?? 'undefined';
const WAYS = ['untouched', 'markupRead', 'markupPost', 'madeRead'];

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

const POLICY = /violates the following Content Security Policy/;
const nativePage = await browser.newPage();
const nativeRefusals = [];
nativePage.on('console', (message) => {
	if (POLICY.test(message.text())) nativeRefusals.push(message.text());
});
nativePage.on('pageerror', (error) => errors.push(`native: ${error.message}`));
await nativePage.goto(target);
const native = await collect(async () => nativePage.mainFrame());
await nativePage.close();

ok(
	'native: every frame fetches its own origin',
	WAYS.every((way) => native[way] === 'fetch 200, xhr 200'),
	show(native),
);
ok(
	"native: the parent's own request is refused",
	native.parent === 'threw TypeError',
	show(native.parent),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const refusals = [];
	page.context().on('console', (message) => {
		if (POLICY.test(message.text())) refusals.push(message.text());
	});
	await submitLanding(page, target);
	const top = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	const proxied = await collect(async () => top());
	for (const key of ['parent', ...WAYS])
		ok(
			`${mode}: ${key} as native`,
			proxied[key] === native[key],
			`native ${show(native[key])} -> proxied ${show(proxied[key])}`,
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
			await evaluateIsolated(
				frame,
				() =>
					`${window.name || location.search}: ${!!navigator.serviceWorker.controller}`,
			).catch((error) => `threw ${error.message}`),
		);
	ok(
		`${mode}: every frame's document is controlled`,
		controlled.length === WAYS.length &&
			controlled.every((line) => line.endsWith(': true')),
		show(controlled),
	);
	// the parent's request is refused as often as natively, and nothing else
	ok(
		`${mode}: refusals as native`,
		refusals.length === nativeRefusals.length,
		`native ${nativeRefusals.length} -> proxied ${refusals.length}: ${show(refusals.slice(0, 2))}`,
	);
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}

await done(browser, errors);
