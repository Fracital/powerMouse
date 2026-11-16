// A preload is the request its element or its stylesheet's background or
// font then takes: each file of the page is asked of the origin once, as
// natively. The inject writes the page's markup (document.open and write,
// loadHTML), and Chrome does not hand a preload fetched through a service
// worker to a request from the other side of that write ("A preload ... is
// found, but is not used because it is a cross-world service worker resource
// mismatch"): a Link header's preload to an <img> of the markup in a frame,
// a preload of the markup to a stylesheet's background or @font-face. Each
// was fetched from the origin twice (Discord's background image); natively
// Chrome does the same for a page written so, and a page the network parser
// reads has none of it. The worker now answers the same document's repeat of
// an image or a font from the first response, one still arriving among
// them. Counted at the fixture server, against the page loaded natively, in
// both modes.
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

const PAGE = `${FIXTURE}pages/preload-consumers.html`;
const browser = await launch();
const served = async () =>
	(await (await fetch(`${FIXTURE}requests`)).json()).filter((path) =>
		path.startsWith('/pages/pc-'),
	);
const count = (paths) => {
	const counts = {};
	for (const path of paths) counts[path] = (counts[path] || 0) + 1;
	return counts;
};

let before = (await served()).length;
const page = await browser.newPage();
await page.goto(PAGE);
await page.waitForFunction(() => window.__done, null, { timeout: 30000 });
const nativeDone = await page.evaluate(() => window.__done);
await sleep(500);
const native = count((await served()).slice(before));
await page.close();
const files = Object.keys(native).sort();
ok(
	'natively: each of the nine files is asked of the origin once',
	files.length === 9 && files.every((file) => native[file] === 1),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	before = (await served()).length;
	await submitLanding(page, PAGE);
	let got = null;
	for (let i = 0; i < 120 && !got; i++) {
		await sleep(250);
		for (const frame of page.frames())
			if (/\/stomp\/[\w-]+\/html\//.test(frame.url()))
				got ||= await frame
					.evaluate(() => window.__done ?? null)
					.catch(() => null);
	}
	await sleep(500);
	const proxied = count((await served()).slice(before));
	ok(
		`${mode}: the page's images and fonts load as natively`,
		JSON.stringify(got) === JSON.stringify(nativeDone),
		JSON.stringify({ native: nativeDone, proxied: got }),
	);
	const twice = files.filter((file) => (proxied[file] ?? 0) > native[file]);
	ok(
		`${mode}: no file is asked of the origin more often than natively`,
		twice.length === 0,
		JSON.stringify({ twice, native, proxied }),
	);
	await page.close();
}

await done(browser);
