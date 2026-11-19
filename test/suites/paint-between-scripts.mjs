// A page whose markup runs long scripts after its first content paints
// before the last of them runs, as natively: the network's parser yields to
// rendering once it has run a while. Through the proxy the page's markup is
// written in pieces, each script's from a microtask after the one before,
// and the page painted only once every script of the pass had run (YouTube
// back from another page: its player ran 700 ms inside one write, and the
// first paint came a second after the native one). Both demo modes.
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

const target = `${FIXTURE}pages/paint-between-scripts.html`;

async function report(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame.evaluate(() => window.__pbs).catch(() => null);
			if (value?.ends?.length === 3 && value.fcp !== undefined) return value;
		}
	}
	return null;
}
const before = (value) =>
	!!value && value.fcp < value.ends[2] && value.fcp >= 0;

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await report(nativePage);
await nativePage.close();
ok(
	'natively, the page paints before its last long script ends',
	before(native),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await report(page);
	ok(
		`${mode}: the page paints before its last long script ends`,
		before(proxied),
		JSON.stringify(proxied),
	);
	await page.close();
}

await done(browser);
