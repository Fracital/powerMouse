// The proxied frame's sandbox only stops a page navigating the host: what a
// page may do natively it may do through the proxy. PresentationRequest,
// screen.orientation.lock and the same in a popup it opens, compared with the
// page loaded natively, in both modes.
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

const target = `${FIXTURE}pages/frame-features.html`;
const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await nativePage.evaluate(() => window.__features());
await nativePage.close();

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let frame = null;
	for (let i = 0; i < 80 && !frame; i++) {
		await sleep(250);
		for (const f of page.frames())
			if (
				/\/stomp\/[\w-]+\/html\//.test(f.url()) &&
				(await f.evaluate(() => document.title).catch(() => '')) ===
					'FRAME FEATURES'
			)
				frame = f;
	}
	const proxied = frame
		? await frame.evaluate(() => window.__features()).catch((e) => String(e))
		: null;
	ok(
		`${mode}: the page may use what it may use natively`,
		JSON.stringify(proxied) === JSON.stringify(native),
		JSON.stringify({ native, proxied }),
	);
	await page.close();
}
await done(browser);
