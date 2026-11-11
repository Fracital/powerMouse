// A document's origin is its own URL's, never its base URL's. A page of one
// site (127.0.0.1) names a page of another (localhost) as its <base href>,
// which the browser resolves URLs against and nothing else: natively it
// reads nothing of that site's localStorage, cookies or IndexedDB, and a
// frame of that site is another origin's window. Through the proxy the
// document's identity followed its base, and it read them all. Both modes.
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

const OTHER = FIXTURE.replace('127.0.0.1', 'localhost');
const writer = `${OTHER}pages/base-identity.html?write`;
const reader = `${FIXTURE}pages/base-identity.html?read=${encodeURIComponent(
	`${OTHER}pages/`,
)}`;

/** the report of the page that did `kind` (wrote or read) */
async function reportOf(pages, kind) {
	for (let i = 0; i < 80; i++) {
		for (const frame of pages().flatMap((page) => page.frames())) {
			const report = await frame
				.evaluate(() => window.__baseIdentity)
				.catch(() => null);
			if (report?.done && (kind === 'wrote' ? report.wrote : 'base' in report))
				return report;
		}
		await sleep(250);
	}
	return null;
}

const browser = await launch();
const context = await browser.newContext();
const nativePage = await context.newPage();
await nativePage.goto(writer);
await reportOf(() => [nativePage], 'wrote');
await nativePage.goto(reader);
const native = await reportOf(() => [nativePage], 'read');
ok(
	"natively, a page whose base is another site's page reads nothing of that site",
	native?.base === true &&
		native.local === null &&
		native.cookie === false &&
		native.databases === false &&
		native.frame === 'SecurityError',
	JSON.stringify(native),
);
await context.close();

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, writer);
	const wrote = await reportOf(() => page.context().pages(), 'wrote');
	ok(`${mode}: the other site's page stored its secret`, wrote?.wrote === true);
	await page.click('#home').catch(() => {});
	await submitLanding(page, reader);
	const proxied = await reportOf(() => page.context().pages(), 'read');
	ok(
		`${mode}: a page whose base is another site's page reads what it reads natively`,
		JSON.stringify(proxied) === JSON.stringify(native),
		`\n      native  ${JSON.stringify(native)}\n      proxied ${JSON.stringify(proxied)}`,
	);
	await page.context().close();
}
await done(browser);
