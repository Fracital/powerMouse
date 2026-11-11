// Every error surface a page reads that the browser fills with a URL reads
// as natively: no routed URL, no proxy origin, no inject bundle or helper
// name. test/pages/error-surfaces.html runs each case in turn (window error
// events and onerror for a thrown, a cross-origin, a failed, a syntax-error
// and a module-import script; stacks from a script, eval, new Function and a
// string timer; rejections of import() and fetch; the DOMExceptions of a
// cross-origin pushState, Worker, SharedWorker and frame access and of bad
// URLs; dedicated, module and shared workers' own surfaces and the events on
// their Worker objects; Server-Timing, a CSP violation and ReportingObserver)
// and the suite compares every case with the page loaded natively, along with
// the uncaught errors the console shows. Both demo modes.
//
// Source positions (line and column numbers) are compared apart: the
// rewriter regenerates a script's code, so they differ for every rewritten
// script (a known gap, printed as a measurement). The proxy does not forward
// a page's CSP, so a violation never fires through it: measured, not
// compared. A resource the page's markup loads is listed twice through the
// proxy (Chrome fetches what its preload scanner found in a written document
// again when a service worker controls it, CHANGELOG known limitations), so
// the Server-Timing case compares the distinct entries.
//
// ERRSURF_DUMP=<dir> writes each mode's full report there.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PORT,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const PAGE = `${FIXTURE}pages/error-surfaces.html`;
const DUMP = process.env.ERRSURF_DUMP;
// measured, not compared (see above)
const MEASURED = new Set(['cspViolation']);

async function measure(getFrame) {
	for (let i = 0; i < 360; i++) {
		const report = await getFrame()
			?.evaluate(() => (window.__surfaces?.done ? window.__surfaces : null))
			.catch(() => null);
		if (report) return report;
		await sleep(250);
	}
	return { cases: {} };
}

// what the proxy must never show a page: a route, the proxy's origin (the
// demo server's port), a bundle, a helper name
const leaks = (text) =>
	/\/stomp\/|inject\w*\.js|\$s\$|\$P\$s|\$stomp|stompError/.test(text) ||
	text.includes(`:${PORT}/`) ||
	text.includes(`:${PORT}"`);

const POSITION_KEYS = ['lineno', 'colno', 'lineNumber', 'columnNumber'];
// a case with every source position replaced, and the positions on their own
const positionless = (value) =>
	JSON.stringify(value, (key, field) => {
		if (POSITION_KEYS.includes(key) && typeof field === 'number') return 'N';
		if (typeof field === 'string') return field.replace(/:\d+:\d+\b/g, ':L:C');
		return field;
	});
const positions = (value) => {
	const found = [];
	JSON.stringify(value, (key, field) => {
		if (POSITION_KEYS.includes(key) && typeof field === 'number')
			found.push(field);
		else if (typeof field === 'string')
			for (const match of field.matchAll(/:(\d+):(\d+)\b/g))
				found.push(Number(match[1]), Number(match[2]));
		return field;
	});
	return found.join(',');
};
const distinct = (report) => {
	const timing = report.cases.serverTiming;
	if (Array.isArray(timing?.value))
		timing.value = [
			...new Map(timing.value.map((e) => [JSON.stringify(e), e])).values(),
		];
	return report;
};
// the cases that made their shared worker again (Chrome dropped its error
// event), with the tries each took
const tries = (report) =>
	Object.entries(report.tries ?? {})
		.map(([name, count]) => `${name} ${count}`)
		.join(', ') || 'none';

const nativePage = await browser.newPage();
const nativeErrors = [];
nativePage.on('pageerror', (error) =>
	nativeErrors.push(error.stack || error.message),
);
await nativePage.goto(PAGE);
const native = distinct(await measure(() => nativePage.mainFrame()));
await nativePage.close();
ok(
	'natively: every case ran',
	Object.keys(native.cases).length === 35,
	Object.keys(native.cases).join(','),
);
console.log(`natively: cases tried again: ${tries(native)}`);
ok(
	'natively: the CSP violation fires',
	Array.isArray(native.cases.cspViolation?.value) &&
		native.cases.cspViolation.value.length === 1,
	JSON.stringify(native.cases.cspViolation),
);
if (DUMP) {
	mkdirSync(DUMP, { recursive: true });
	writeFileSync(
		`${DUMP}/native.json`,
		JSON.stringify({ ...native, console: nativeErrors }, null, 2),
	);
}

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = distinct(await measure(() => frameOf(page)));
	console.log(`${mode}: cases tried again: ${tries(proxied)}`);
	await sleep(500);
	const consoleErrors = page.errorStacks;
	if (DUMP)
		writeFileSync(
			`${DUMP}/${mode}.json`,
			JSON.stringify({ ...proxied, console: consoleErrors }, null, 2),
		);
	const moved = [];
	for (const name of Object.keys(native.cases)) {
		const got = JSON.stringify(proxied.cases[name]);
		ok(`${mode}: ${name} names no proxy URL`, !leaks(got ?? ''), got);
		if (MEASURED.has(name)) {
			console.log(`${mode}: measured ${name}: proxied ${got}`);
			continue;
		}
		const want = positionless(native.cases[name]);
		const have = positionless(proxied.cases[name]);
		ok(
			`${mode}: ${name} reads as natively`,
			have === want,
			`native ${want} proxied ${have}`,
		);
		if (
			have === want &&
			positions(native.cases[name]) !== positions(proxied.cases[name])
		)
			moved.push(name);
	}
	console.log(
		`${mode}: measured source positions that differ (rewritten code): ${moved.join(', ') || 'none'}`,
	);
	const shown = consoleErrors.filter((stack) => !/registerPaint/.test(stack));
	ok(
		`${mode}: the console's uncaught errors name no proxy URL`,
		!shown.some(leaks),
		shown.filter(leaks).join(' | '),
	);
	await page.close();
}

await done(browser);
