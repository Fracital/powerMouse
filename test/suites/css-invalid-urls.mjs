// A url() or @import no URL parser takes says nothing in the console, as
// natively. The CSS rewriter logged the TypeError of every one it could
// not resolve ("Failed to construct 'URL': Invalid URL", seven on
// browserleaks' features page), which a page that wraps console.error
// sees. Compared with the page loaded natively, in both modes.
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

const PAGE = `${FIXTURE}pages/css-invalid-urls.html`;
const browser = await launch();
const invalid = (lines) => lines.filter((line) => /Invalid URL/.test(line));

const nativePage = await browser.newPage();
const nativeLines = [];
nativePage.on('console', (message) => nativeLines.push(message.text()));
await nativePage.goto(PAGE);
await nativePage.waitForFunction(() => window.__cssInvalid === true);
await nativePage.close();
ok(
	'natively: the console says nothing of them',
	invalid(nativeLines).length === 0,
	JSON.stringify(nativeLines),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const lines = [];
	page.on('console', (message) => lines.push(message.text()));
	await submitLanding(page, PAGE);
	let ready = false;
	for (let i = 0; i < 80 && !ready; i++) {
		await sleep(250);
		for (const frame of page.frames())
			if (
				/\/stomp\/[\w-]+\/html\//.test(frame.url()) &&
				(await frame.evaluate(() => window.__cssInvalid).catch(() => false))
			)
				ready = true;
	}
	ok(`${mode}: the page ran`, ready);
	ok(
		`${mode}: the console says nothing of them, as natively`,
		invalid(lines).length === invalid(nativeLines).length,
		JSON.stringify(invalid(lines)),
	);
	await page.close();
}
await done(browser);
