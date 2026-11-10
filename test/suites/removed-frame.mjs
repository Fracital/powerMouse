// A removed frame's storage, document and XMLHttpRequest answer at once
// (removed-frame.html). On discord.com, Sentry and rrweb take functions from
// a hidden iframe they remove right away. The client of such a frame sent
// its synchronous requests from the document that runs the bundle, but read
// the answer in the removed frame's own document, which has no browsing
// context and reads no cookies: the service worker answered in milliseconds
// and every call spun to the bridge's limit (10 s, 30 s for an XHR) and threw
// RangeError. The page times each call; the cookie reads and writes are
// compared with the page loaded natively, in both demo modes. Natively the
// removed frame's storage throws SecurityError and its synchronous XHR
// NetworkError; through the proxy they may answer instead, but at once.
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

const target = `${FIXTURE}pages/removed-frame.html`;
const read = () => window.__rf ?? null;
// the bridge's own limit is 10 s, 30 s for an XHR; an answer takes ms
const PROMPT_MS = 2000;

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 80 && !native?.done; i++) {
	await sleep(250);
	native = await nativePage.evaluate(read).catch(() => null);
}
await nativePage.close();
const n = native?.results ?? {};
ok(
	'natively, the removed frame document reads no cookie',
	n.cookie?.value === '',
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	// before the fix every call spun to its limit: wait long enough to report
	// which ones did, not for all of them
	for (let i = 0; i < 160 && !proxied?.done; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		proxied = (await frame?.evaluate(read).catch(() => null)) ?? proxied;
	}
	ok(`${mode}: the page makes every call`, proxied?.done === true);
	const p = proxied?.results ?? {};
	for (const name of ['cookie', 'cookieWrite', 'getItem', 'syncXHR']) {
		const outcome = p[name];
		ok(
			`${mode}: ${name} through the removed frame settles at once`,
			outcome !== undefined && outcome.ms < PROMPT_MS,
			JSON.stringify(outcome),
		);
		ok(
			`${mode}: ${name} through the removed frame does not reach the bridge's limit`,
			outcome !== undefined && outcome.threw !== 'RangeError',
			JSON.stringify(outcome),
		);
	}
	const same = (name, a, b) => {
		const x = JSON.stringify(a);
		const y = JSON.stringify(b);
		ok(`${mode}: ${name} as natively`, x === y, `native ${x} proxied ${y}`);
	};
	same('the removed frame document reads', n.cookie?.value, p.cookie?.value);
	same(
		"after a write through the removed frame document, the page's cookie reads",
		n.cookieWrite?.value,
		p.cookieWrite?.value,
	);
	same('in the end the page cookie reads', native?.cookie, proxied?.cookie);
	ok(
		`${mode}: the removed frame storage reads the stored value, or throws as natively`,
		p.getItem?.value === 'yes' || p.getItem?.threw === n.getItem?.threw,
		`native ${JSON.stringify(n.getItem)} proxied ${JSON.stringify(p.getItem)}`,
	);
	ok(
		`${mode}: the removed frame synchronous XHR loads, or throws as natively`,
		p.syncXHR?.value === 200 || p.syncXHR?.threw === n.syncXHR?.threw,
		`native ${JSON.stringify(n.syncXHR)} proxied ${JSON.stringify(p.syncXHR)}`,
	);
	ok(
		`${mode}: no error reached the page`,
		page.errors.length === 0,
		page.errors.join(' | '),
	);
	await page.close();
}
await done(browser);
