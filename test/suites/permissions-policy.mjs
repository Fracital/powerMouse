// A document's permissions policy is the browser's own, as natively
// (test/pages/permissions-policy.html): a page served with a
// Permissions-Policy that turns features off (Cloudflare's challenge pages
// send one), frames of another site without and with an allow attribute,
// a frame of the page's own site, a frame of another site whose own policy
// turns more off, and one with `allowfullscreen`. Each reports
// `document.featurePolicy`'s allowed features, whether it allows the
// camera, and what a synchronous XMLHttpRequest does (`sync-xhr`),
// compared with the page loaded natively, in both modes. sync-xhr is the
// one exception the proxy keeps a double standard on: STomp's own inject
// makes a synchronous XHR (the WebRTC rtcStack loader), so the served
// Permissions-Policy never disables the feature and the browser lets the
// inject's request through in every proxied document, while the guest's own
// synchronous request is emulated to fail exactly as the real page's policy
// would (src/server/clientHints.ts, src/inject/dom/modules/XMLHttpRequest.ts). The browser sees
// every proxied document as same-origin with its parent and never sees a
// page's own policy, so a frame of another site had every `self` feature
// (Turnstile's challenge frame read Summarizer and LanguageModel as
// downloadable) and a page's policy turned nothing off. Only the features the host lets its proxied frame have are
// compared (isolation mode's frame has those its allow attribute names, a
// host's choice), and `cross-origin-isolated` is the isolation suites'.
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

const target = `${FIXTURE}pages/permissions-policy.html`;
const plain = `${FIXTURE}pages/permissions-policy-frame.html?plain`;
const browser = await launch();

/** the newest frame that answers `read` with something */
async function find(page, read, title) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		for (const frame of page.frames().reverse()) {
			if (
				title &&
				(await frame.evaluate(() => document.title).catch(() => '')) !== title
			)
				continue;
			const value = await frame.evaluate(read).catch(() => null);
			if (value) return value;
		}
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await find(nativePage, () => window.__policy);
await nativePage.close();
ok(
	'natively, every document reports',
	native && Object.keys(native).length === 6,
	JSON.stringify(native && Object.keys(native)),
);
// the policy under test really disables sync-xhr on the top document (as
// Cloudflare's challenge pages do), so the double standard the proxy keeps
// below is meaningful: the browser refuses the top's synchronous request and
// reads the feature as not allowed
ok(
	'natively the page disables sync-xhr',
	native?.top?.allowsSyncXhr === false &&
		!native.top.syncXhr.startsWith('sent'),
	JSON.stringify({
		allowsSyncXhr: native?.top?.allowsSyncXhr,
		syncXhr: native?.top?.syncXhr,
	}),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// what the host lets its proxied frame have: a page without a policy
	await submitLanding(page, plain);
	const host = new Set(
		(await find(
			page,
			() => document.featurePolicy.allowedFeatures(),
			'POLICY FRAME',
		)) ?? [],
	);
	host.delete('cross-origin-isolated');
	await submitLanding(page, target);
	const proxied = await find(page, () => window.__policy, 'PERMISSIONS POLICY');
	const view = (record) =>
		record && {
			// sync-xhr is never compared as a browser-allowed feature: STomp
			// always serves it on (its own inject makes a synchronous XHR), so
			// the proxied documents read it allowed though the page's real
			// policy turned it off. The guest's own synchronous request
			// (syncXhr) is emulated to fail exactly as natively, and that is
			// what is compared, beside the browser-level double standard below
			allowed: record.allowed.filter(
				(feature) => feature !== 'sync-xhr' && host.has(feature),
			),
			camera: record.camera && host.has('camera'),
			syncXhr: record.syncXhr,
		};
	for (const name of [
		'top',
		'cross',
		'crossAllowed',
		'same',
		'crossOwn',
		'crossFullscreen',
	]) {
		const want = view(native?.[name]);
		const got = view(proxied?.[name]);
		const missing = want?.allowed.filter((f) => !got?.allowed.includes(f));
		const extra = got?.allowed.filter((f) => !want?.allowed.includes(f));
		ok(
			`${mode}: ${name}: the features the browser allows, the camera and a synchronous XMLHttpRequest are as natively`,
			host.size > 0 &&
				want &&
				got &&
				!missing.length &&
				!extra.length &&
				want.camera === got.camera &&
				want.syncXhr === got.syncXhr,
			JSON.stringify({
				missing,
				extra,
				camera: [want?.camera, got?.camera],
				syncXhr: [want?.syncXhr, got?.syncXhr],
			}).slice(0, 1500),
		);
		// the double standard: STomp's served Permissions-Policy never
		// disables sync-xhr, so its own inject (the WebRTC loader's
		// synchronous request) is never refused by the browser in any proxied
		// document, even this one whose real policy turned the feature off and
		// whose guest synchronous request (syncXhr, compared above) still
		// fails exactly as natively
		ok(
			`${mode}: ${name}: the browser serves sync-xhr on, so STomp's inject can make a synchronous request`,
			proxied?.[name]?.allowsSyncXhr === true,
			JSON.stringify({ allowsSyncXhr: proxied?.[name]?.allowsSyncXhr }),
		);
	}
	await page.close();
}
await done(browser);
