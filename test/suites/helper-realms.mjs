// Rewritten code in realms of its own (helper-realms.html): a javascript:
// URL in a fresh iframe, blob: module and classic workers, a data: worker.
// Code the rewriter rewrote calls the access helper (`$s$j.get(...)`), so
// wherever it runs the inject must have installed it first, or the page's
// code throws a ReferenceError instead of running. Each route's report is
// compared with the same page loaded natively, and the proxied load may
// raise no page error the native one does not. Both demo modes.
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

const url = `${FIXTURE}pages/helper-realms.html`;

async function reportOf(page) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__realms?.done && window.__realms.report)
				.catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

const ROUTES = [
	'iframe.src = javascript:',
	'iframe.setAttribute(src, javascript:)',
	'javascript: statements',
	'markup iframe src=javascript:',
	'blob: module worker, on message',
	'blob: module worker, top level',
	'blob: classic worker, top level',
	'data: worker, new Request(relative)',
];

const browser = await launch();
const nativePage = await browser.newPage();
const nativeErrors = trackErrors(nativePage);
await nativePage.goto(url);
const native = await reportOf(nativePage);
await sleep(500);
await nativePage.close();
ok(
	'natively, every route reports',
	native !== null && ROUTES.every((name) => name in native),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, url);
	const proxied = await reportOf(page);
	await sleep(500);
	for (const name of ROUTES)
		ok(
			`${mode}: ${name} runs and sees what it sees natively`,
			proxied !== null &&
				JSON.stringify(proxied[name]) === JSON.stringify(native?.[name]),
			JSON.stringify({ native: native?.[name], proxied: proxied?.[name] }),
		);
	const extra = proxiedOnlyErrors(nativeErrors, page.errors, page.errorStacks);
	ok(
		`${mode}: the page raises no error it does not raise natively`,
		extra.length === 0,
		JSON.stringify(extra),
	);
	await page.close();
}
await done(browser);
