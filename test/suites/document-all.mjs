// document.all is read through a computed member as natively: it is
// loosely equal to null (and typeof 'undefined'), and the access helpers'
// test for null or undefined, minified to `== null`, took it for one, so
// `document.all[i]` threw an empty TypeError and `document.all?.[i]` was
// undefined. ThreatMetrix's script on chase.com walks `document.all[i]` and
// threw on every load. Each case of document-all.html is compared with the
// page loaded natively; both demo modes.
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

const target = `${FIXTURE}pages/document-all.html`;

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__all).catch(() => null);
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
	'natively, every case reports, and document.all reads as an object',
	names.length === 14 &&
		native.index?.value === 'HTML' &&
		native['an optional index']?.value === 'HTML' &&
		native['loosely null']?.value === 'true',
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
