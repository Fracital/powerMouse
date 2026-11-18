// A frame's requests are its own however its parent reads its window
// (test/pages/frame-own-requests.html). On vimeo.com and figma.com
// Cloudflare's Turnstile frames its challenge (challenges.cloudflare.com)
// and reads the frame's contentWindow every few milliseconds; the challenge
// asks its own origin for a resource answered 401 with no CORS headers, and
// natively reads the 401. Through the proxy a read of the frame's window
// injects it with the parent's bundle: on its initial about:blank, whose
// client the browser keeps for the frame's document (and that client never
// read the document's service worker container, so it took the document for
// one no worker controls), or after the frame's document arrived and before
// its own shell ran (and that client made the document's requests in the
// parent's realm). Either way requests went as the parent's: "blocked by
// CORS policy", or a worker that could not start its transport. Compared
// with native in both demo modes: each frame's fetch, XMLHttpRequest with a
// header that is not safelisted, blob: worker's fetch and nested
// about:blank frame's fetch, and whether the worker controls each frame.
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

// www.localhost frames dull.localhost: another origin of the same site
const target = `http://www.localhost:${new URL(FIXTURE).port}/pages/frame-own-requests.html`;
const ways = ['untouched', 'polled', 'sentOn'];
const NATIVE = 'fetch 401, xhr 401, worker 401, nested 401';
const show = (value) => JSON.stringify(value) ?? 'undefined';

async function collect(find) {
	for (let i = 0; i < 120; i++) {
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
	'native: every frame reads its own 401',
	ways.every((way) => native[way] === NATIVE),
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
			`${mode}: the ${way} frame's requests as native`,
			native[way] !== undefined && proxied[way] === native[way],
			`native ${show(native[way])} -> proxied ${show(proxied[way])}`,
		);
	// the browser's own view (a world no hook reaches)
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
