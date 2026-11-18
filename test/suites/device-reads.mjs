// A frame the browser refuses usb, hid and serial reads navigator.usb, hid
// and serial with no violation, as natively. The device hooks (first read
// of each) listened for connect and disconnect on the object, and adding a
// listener where the feature is refused is a violation the browser reports:
// a console message and a permissions-policy-violation report to the page's
// ReportingObserver, for each feature. Cloudflare's script reads all three
// in the Vimeo player frame on figma.com. The page (device-reads.html) on
// 127.0.0.1 frames itself from localhost (another origin, no allow); what
// the child read and what its observer heard are compared with native, and
// the console with no such violation, in both modes.
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

const other = FIXTURE.replace('127.0.0.1', 'localhost');
const target = `${FIXTURE}pages/device-reads.html?to=${encodeURIComponent(other)}`;
const VIOLATION = /Permissions policy violation: (usb|hid|serial)/;

async function report(page) {
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__done).catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

const browser = await launch();
const nativePage = await browser.newPage();
const nativeConsole = [];
nativePage.on('console', (m) => nativeConsole.push(m.text()));
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, the child reads the three objects and hears no report',
	native?.read?.join() === 'usb object,hid object,serial object' &&
		native.reports.length === 0 &&
		!nativeConsole.some((text) => VIOLATION.test(text)),
	JSON.stringify({
		native,
		console: nativeConsole.filter((t) => VIOLATION.test(t)),
	}),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const messages = [];
	page.on('console', (m) => messages.push(m.text()));
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(
		`${mode}: the child reads and hears as natively`,
		JSON.stringify(proxied) === JSON.stringify(native),
		JSON.stringify({ native, proxied }),
	);
	const violations = messages.filter((text) => VIOLATION.test(text));
	ok(
		`${mode}: no permissions policy violation in the console`,
		violations.length === 0,
		JSON.stringify(violations),
	);
	await page.close();
}
await done(browser);
