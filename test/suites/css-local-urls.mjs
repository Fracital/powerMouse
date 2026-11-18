// A url() whose target is only a fragment (`fill: url(#gradient)`) names an
// element of the document itself: the browser paints with it, loads
// nothing, and reads the value back as written. Reddit's challenge page
// paints its logo that way under an img-src that does not allow its own
// origin. The CSS rewriter routed such a url() as a binary resource of the
// page's URL, so the reference named another document: the logo lost its
// gradients, the browser fetched the page again as an image, the page saw an
// img-src violation natively absent, and getComputedStyle answered an
// absolute URL. Compared with the page loaded natively, in both modes: the
// computed values and the page's readbacks, the pixels of every shape, the
// violations and how often the page itself was requested.
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
import { decodePNG } from '../visited-lib.mjs';

const PATH = '/pages/css-local-urls.html';
const PAGE = new URL(PATH, FIXTURE).href;
const browser = await launch();

/** how often the fixture served the page so far */
const served = async () => {
	const response = await fetch(new URL('/requests', FIXTURE));
	const paths = await response.json();
	return paths.filter((path) => path === PATH).length;
};

/** the colour of the middle of each shape, and of the clipped half */
const POINTS = [20, 60, 100, 140, 170, 190, 220, 260, 300];
async function pixels(frame) {
	const svg = await frame.$('#shapes');
	const image = decodePNG(await svg.screenshot());
	return POINTS.map((x) => image.at(x, 20).join(','));
}

async function readout(frame) {
	for (let i = 0; i < 80; i++) {
		const value = await frame
			.evaluate(() => window.__localURLs ?? null)
			.catch(() => null);
		if (value) return value;
		await sleep(250);
	}
	return null;
}

const before = await served();
const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await readout(nativePage.mainFrame());
const nativePixels = await pixels(nativePage.mainFrame());
await sleep(500);
const nativeLoads = (await served()) - before;
await nativePage.close();
ok('natively: the page reports', native !== null);
ok(
	'natively: the gradient, the clip and the filter paint (the oracle holds)',
	nativePixels[0] === '0,255,0' &&
		nativePixels[4] === '0,0,255' &&
		nativePixels[5] === '255,255,255' &&
		nativePixels[6] === '0,255,0',
	JSON.stringify(nativePixels),
);
ok(
	'natively: no violation, the page loaded once',
	native?.violations.length === 0 && nativeLoads === 1,
	JSON.stringify({ violations: native?.violations, nativeLoads }),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const start = await served();
	await submitLanding(page, PAGE);
	let frame = null;
	let report = null;
	for (let i = 0; i < 80 && !report; i++) {
		await sleep(250);
		for (const candidate of page.frames().reverse())
			if (/\/stomp\/[\w-]+\/html\//.test(candidate.url())) {
				report = await candidate
					.evaluate(() => window.__localURLs ?? null)
					.catch(() => null);
				if (report) {
					frame = candidate;
					break;
				}
			}
	}
	ok(`${mode}: the page reports`, report !== null);
	if (!report) {
		await page.close();
		continue;
	}
	const shown = await pixels(frame);
	await sleep(500);
	const loads = (await served()) - start;
	ok(
		`${mode}: every computed fill, clip-path and filter reads as natively`,
		JSON.stringify(report.computed) === JSON.stringify(native.computed),
		JSON.stringify({ proxied: report.computed, native: native.computed }),
	);
	ok(
		`${mode}: the style attribute, the CSSOM value and the rule read as natively`,
		report.inline === native.inline &&
			report.cssom === native.cssom &&
			report.rule === native.rule,
		JSON.stringify({ proxied: report, native }),
	);
	ok(
		`${mode}: every shape paints as natively`,
		JSON.stringify(shown) === JSON.stringify(nativePixels),
		JSON.stringify({ proxied: shown, native: nativePixels }),
	);
	ok(
		`${mode}: no violation, as natively`,
		JSON.stringify(report.violations) === JSON.stringify(native.violations),
		JSON.stringify(report.violations),
	);
	ok(
		`${mode}: the page was requested as often as natively`,
		loads === nativeLoads,
		JSON.stringify({ loads, nativeLoads }),
	);
	await page.close();
}
await done(browser);
