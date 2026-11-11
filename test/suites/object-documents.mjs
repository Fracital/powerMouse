// An <object>'s HTML document, wherever the page puts it: in the top, in a
// frame's parsed markup, by a frame's script (made, as innerHTML and by
// document.write) and in a srcdoc frame. Each
// shows its image as natively, and one that names its own <base href>
// resolves the image by it (test/pages/object-kinds*.html). Both modes.
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
const target = `${FIXTURE}pages/object-kinds.html`;

/** every object document's report, by its case, once `count` are in (or after a while) */
async function reports(pages, count) {
	let found = {};
	for (let i = 0; i < 80; i++) {
		found = {};
		for (const frame of pages().flatMap((page) => page.frames())) {
			const report = await frame
				.evaluate(() => window.__objectKind ?? null)
				.catch(() => null);
			// once its image settled
			if (report?.case && report.width !== null) found[report.case] = report;
		}
		if (count !== undefined && Object.keys(found).length >= count) break;
		await sleep(250);
	}
	return Object.fromEntries(Object.entries(found).sort());
}

const nativePage = await browser.newPage();
await nativePage.goto(target);
/** the cases the pages make (test/pages/object-kinds*.html) */
const CASES = 9;
const native = await reports(() => [nativePage], CASES);
ok(
	'natively, every object document shows its image, by its own base where it names one',
	Object.keys(native).length === CASES &&
		Object.values(native).every(
			(report) =>
				report.width > 0 && (!('base' in report) || report.base === '/sop/'),
		),
	JSON.stringify(native),
);
await nativePage.close();

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await reports(
		() => page.context().pages(),
		Object.keys(native).length,
	);
	for (const [name, expected] of Object.entries(native))
		ok(
			`${mode}: the object document of case ${name} shows as natively`,
			JSON.stringify(proxied[name]) === JSON.stringify(expected),
			JSON.stringify({ native: expected, proxied: proxied[name] ?? null }),
		);
	await page.context().close();
}
await done(browser);
