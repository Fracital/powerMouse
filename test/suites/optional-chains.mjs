// An optional chain that short-circuits evaluates nothing after its `?.`
// through the proxy either: not a computed key the rewriter hands the access
// API, not a call's arguments, not an awaited key, and the rest of the chain
// past a call short-circuits too (optional-chains.html). Discord's login page
// threw "Cannot read properties of undefined (reading 'messages')" on
// `t?.messages[s.current % t.messages.length]` and never rendered. Each case
// is compared with the page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/optional-chains.html`;

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__chains)
				.catch(() => null);
			if (value?.done) return value.results;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
const names = Object.keys(native ?? {});
ok(
	'natively, every case reports',
	names.length >= 14 &&
		native['discord-shape-undefined']?.value === 'undefined' &&
		native['discord-shape-defined']?.value === 'two',
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(`${mode}: the page reports`, !!proxied, JSON.stringify(proxied));
	for (const name of names)
		ok(
			`${mode}: ${name} evaluates as natively`,
			JSON.stringify(proxied?.[name]) === JSON.stringify(native[name]),
			JSON.stringify({ native: native[name], proxied: proxied?.[name] }),
		);
	await page.close();
}
await done(browser);
