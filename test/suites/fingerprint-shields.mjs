// Brave-parity anti-fingerprinting, the opt-in per-surface Shields layer
// (src/inject/dom/modules/Fingerprint.ts, src/server/shields.ts). Every surface
// is OFF by default, so by default a proxied page reads this browser's own
// values, unchanged (the pass-bot-check baseline); a site turned ON farbles or
// limits the surface. Checked against native, same-origin demo mode:
//   - OFF (default): canvas, cores, device memory, screen, languages and
//     measureText match native exactly (passthrough unchanged).
//   - ON: canvas readback is farbled (differs from native), per site
//     (two proxied sites of the same content differ) and stable within a site
//     (a reload repeats); hardwareConcurrency is capped; deviceMemory is capped;
//     screen is rounded to a bucket; languages/timezone are standardised;
//     measureText is farbled per site.
import {
	done,
	evaluateIsolated,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const PAGE = 'pages/fingerprint.html';
const targetA = `${FIXTURE}${PAGE}`;
const hostA = new URL(FIXTURE).hostname;
// the same fixture reached under another hostname is another site (eTLD+1)
const baseB = FIXTURE.replace('127.0.0.1', 'localhost');
const targetB = `${baseB}${PAGE}`;
const hostB = new URL(baseB).hostname;

const ALL_ON = {
	canvas: true,
	webgl: true,
	audio: true,
	fonts: true,
	screen: true,
	hardwareConcurrency: true,
	deviceMemory: true,
	mediaDevices: true,
	locale: true,
};

/**
 * The fixture's __fp once it is computed, from the frame of `host` (the
 * proxied page reads its own real hostname): so navigating one tab between two
 * sites never reads the frame it just left.
 */
async function readFp(page, host) {
	for (let i = 0; i < 80; i++) {
		await sleep(200);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => (window.__fp?.ok ? window.__fp : null))
				.catch(() => null);
			if (
				value &&
				(!host || value.host === host) &&
				(value.audioDone || i > 20)
			)
				return { ...value, realScreen: await realScreenOf(frame) };
		}
	}
	return null;
}

/**
 * The screen the browser reports to the document of `frame`, read in a world
 * of its own in that document, which no hook reaches: the baseline a proxied
 * page's screen passes through to, or is rounded from. Not the host
 * window's: Playwright emulates its viewport's screen in the page's renderer
 * only, and a frame in another process (a site pool's slot, as natively a
 * frame of another site) reports the browser's own screen (measured).
 */
const realScreenOf = (frame) =>
	evaluateIsolated(frame, () =>
		[screen.width, screen.height, screen.availWidth, screen.availHeight].join(
			'x',
		),
	).catch(() => null);

// a screen no dimension of which is a 50 px bucket, so a rounded screen
// always differs from it (headless Chrome's own is 800x600)
const browser = await launch(['--screen-info={1283x803}']);

// native, loaded directly (no proxy)
const nativePage = await browser.newPage();
await nativePage.goto(targetA);
const native = await readFp(nativePage);
await nativePage.close();
ok(
	'natively, the fixture computes its surfaces',
	native?.ok && native.canvasImage > 0 && native.cores > 0,
	JSON.stringify({ canvas: native?.canvasImage, cores: native?.cores }),
);

// --- OFF (the default): every surface passes through to native ---------------
{
	const page = await openDemo(browser, PROXY);
	await page.evaluate(
		(host) =>
			window.controller.shields.set(host, {
				enabled: true,
				blockFingerprinting: true,
			}),
		hostA,
	);
	await sleep(500); // let the shields reach the worker before the navigation
	await submitLanding(page, targetA);
	const fpOff = await readFp(page, hostA);
	const off = fpOff;
	ok(
		'default: the canvas readback matches native (no farbling)',
		off &&
			off.canvasImage === native.canvasImage &&
			off.canvasUrl === native.canvasUrl,
		JSON.stringify({ off: off?.canvasImage, native: native.canvasImage }),
	);
	ok(
		'default: hardwareConcurrency and deviceMemory match native',
		off &&
			off.cores === native.cores &&
			off.deviceMemory === native.deviceMemory,
		JSON.stringify({
			cores: [off?.cores, native.cores],
			mem: [off?.deviceMemory, native.deviceMemory],
		}),
	);
	ok(
		"default: screen (vs the browser's for the document), languages and measureText pass through",
		off &&
			!!off.realScreen &&
			off.screen === off.realScreen &&
			off.languages === native.languages &&
			off.measure === native.measure,
		JSON.stringify({
			screen: [off?.screen, off?.realScreen],
			languages: [off?.languages, native.languages],
		}),
	);
	await page.close();
}

// --- ON: the surfaces are farbled / limited ----------------------------------
// One page (one browser context, so one persisted farbling seed), navigating
// its one tab between the two sites: site A, then B, then back to A. With the
// same seed, A and B differ only by their eTLD+1 (per-site noise), and A's
// second load repeats A's first (stable within a site).
const onPatch = {
	enabled: true,
	blockFingerprinting: true,
	fingerprint: ALL_ON,
};
const onPage = await openDemo(browser, PROXY);
await onPage.evaluate(
	([a, b, patch]) => {
		window.controller.shields.set(a, patch);
		window.controller.shields.set(b, patch);
	},
	[hostA, hostB, onPatch],
);
await sleep(500);
await submitLanding(onPage, targetA);
const onA = await readFp(onPage, hostA);
await submitOmni(onPage, targetB);
const onB = await readFp(onPage, hostB);
await submitOmni(onPage, targetA);
const onA2 = await readFp(onPage, hostA);
await onPage.close();

ok(
	'canvas on: the readback is farbled (differs from native)',
	onA &&
		onA.canvasImage !== native.canvasImage &&
		onA.canvasUrl !== native.canvasUrl,
	JSON.stringify({ on: onA?.canvasImage, native: native.canvasImage }),
);
ok(
	'canvas on: two proxied sites of the same content get different noise',
	onA && onB && onA.canvasImage !== onB.canvasImage,
	JSON.stringify({ a: onA?.canvasImage, b: onB?.canvasImage }),
);
ok(
	'canvas on: a site is stable within itself (a reload repeats the readback)',
	onA && onA2 && onA.canvasImage === onA2.canvasImage,
	JSON.stringify({ first: onA?.canvasImage, second: onA2?.canvasImage }),
);
ok(
	'hardwareConcurrency on: capped low (<= 2) and never above native',
	onA && onA.cores <= 2 && onA.cores <= native.cores,
	JSON.stringify({ on: onA?.cores, native: native.cores }),
);
ok(
	'deviceMemory on: capped (<= 4) and never above native',
	onA &&
		(native.deviceMemory === null ||
			native.deviceMemory === undefined ||
			(onA.deviceMemory <= 4 && onA.deviceMemory <= native.deviceMemory)),
	JSON.stringify({ on: onA?.deviceMemory, native: native.deviceMemory }),
);
ok(
	"screen on: every dimension is rounded to a 50 px bucket (differs from the browser's)",
	onA &&
		!!onA.realScreen &&
		onA.screen.split('x').every((n) => Number(n) % 50 === 0) &&
		onA.screen !== onA.realScreen,
	JSON.stringify({ on: onA?.screen, real: onA?.realScreen }),
);
ok(
	'locale on: languages and timezone are standardised (en-US, UTC)',
	onA &&
		onA.language === 'en-US' &&
		onA.languages === 'en-US,en' &&
		onA.timezone === 'UTC' &&
		onA.tzOffset === 0,
	JSON.stringify({ lang: onA?.languages, tz: onA?.timezone }),
);
ok(
	'fonts on: measureText is farbled per site, still sub-pixel (layout intact)',
	onA &&
		onB &&
		onA.measure !== onB.measure &&
		Math.abs(onA.measure - native.measure) < 1,
	JSON.stringify({ a: onA?.measure, b: onB?.measure, native: native.measure }),
);
// webgl and audio are best-effort in headless (no GPU / no debug extension on
// some runners): assert only when the native run exposed them
ok(
	'webgl on: the unmasked vendor is spoofed when the browser exposes it',
	!native.webglVendor || (onA && onA.webglVendor === 'Google Inc. (Google)'),
	JSON.stringify({ on: onA?.webglVendor, native: native.webglVendor }),
);
ok(
	'audio on: the render is farbled when Web Audio is available',
	native.audio === undefined ||
		(onA && onA.audio !== undefined && onA.audio !== native.audio),
	JSON.stringify({ on: onA?.audio, native: native.audio }),
);

await done(browser);
