// A page reads another realm's hooked functions through its own
// Function.prototype.toString and sees the native source: a same-origin frame
// that loaded its own copy of the inject (whose wrappers this realm's copy
// never made) and an about:blank frame this page's copy injected.
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

const target = `${FIXTURE}pages/function-strings.html`;
const browser = await launch();

const nativePage = await browser.newPage();
await nativePage.goto(target);
await sleep(1500);
const native = await nativePage.evaluate(() => window.__read());
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
					'FUNCTION STRINGS'
			)
				frame = f;
	}
	await sleep(1500);
	const proxied = frame
		? await frame.evaluate(() => window.__read()).catch((e) => String(e))
		: null;
	ok(
		`${mode}: another realm's hooked functions read as native`,
		JSON.stringify(proxied) === JSON.stringify(native),
		JSON.stringify({ native, proxied }),
	);
	await page.close();
}
await done(browser);
