// A script is decoded as Chrome decodes it: a byte order mark first (UTF-8
// only, for a module), then the Content-Type charset (for a module only
// windows-1252: one served as windows-1250 reads as UTF-8), then UTF-8. The worker rewrites a script as text, so
// it decodes the bytes itself; it read every script as UTF-8, so a script
// served as windows-1252 or as UTF-16 with a byte order mark ran with other
// characters than natively (or not at all: UTF-16 read as UTF-8 is a syntax
// error). Classic and module scripts of an element and a dedicated worker's
// script, each with one non-ASCII character, read back as code points and
// compared with the page loaded natively, in both demo modes.
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

const browser = await launch();
const PAGE = `${FIXTURE}pages/script-charset.html`;
const CASES = [
	'classic1252',
	'classicUtf16',
	'module1252',
	'moduleUtf16',
	'module1250',
	'worker1252',
	'workerUtf16',
];

async function read(frame) {
	for (let i = 0; i < 100; i++) {
		const value = await frame()
			?.evaluate(() => window.__charsetOut)
			.catch(() => null);
		if (value?.done) return value;
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await read(() => nativePage.mainFrame());
await nativePage.close();
// (a module script in UTF-16 does not run natively: a module is not decoded
// by a UTF-16 byte order mark, and the parse error fires no element event,
// so it reads as a timeout, which the proxied run must read too)
ok(
	'natively, every script but the UTF-16 module ran and answered',
	CASES.every(
		(name) => /^\d/.test(native?.[name] ?? '') === (name !== 'moduleUtf16'),
	),
	JSON.stringify(native),
);

const frameOf = (page) =>
	page
		.frames()
		.findLast(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html[:/]/.test(f.url()),
		);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await read(() => frameOf(page));
	for (const name of CASES)
		ok(
			`${mode}: ${name} reads what it reads natively (${native?.[name]})`,
			proxied?.[name] === native?.[name],
			JSON.stringify(proxied),
		);
	await page.close();
}

await done(browser);
