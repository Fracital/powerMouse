// A URL property whose attribute is missing or empty reads back as the
// browser would answer on the real site: the document's URL (form.action,
// formAction, base.href) or its base URL (an empty href or src), never the
// proxy's raw address, and such a form keeps no action attribute the page
// could read. A submission of it lands where the browser would send it. Last.fm's sign-in read such a value and handed it on,
// which routed the proxy's URL again. Every value is compared with the same
// page loaded straight from the fixture; both demo modes.
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

const target = `${FIXTURE}pages/url-defaults.html?q=1#frag`;

/** the page's report (the one after a submission of form `submitted`) */
async function readDefaults(page, submitted = null) {
	for (let i = 0; i < 60; i++) {
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__defaults)
				.catch(() => null);
			if (value && value.submitted === submitted) return { frame, value };
		}
		await sleep(250);
	}
	return { frame: null, value: null };
}

/** where a submission of each action-less form lands: a GET and a POST */
async function submissions(page, frame) {
	const landed = {};
	for (const id of ['get', 'form']) {
		await frame.evaluate((id) => window.__submit(id), id).catch(() => {});
		const after = await readDefaults(page, id);
		landed[id] = after.value?.href ?? null;
		if (after.frame) frame = after.frame;
	}
	return landed;
}

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
const { frame: nativeFrame, value: native } = await readDefaults(nativePage);
const nativeLanded = nativeFrame
	? await submissions(nativePage, nativeFrame)
	: {};
await nativePage.close();
ok('the page reports natively', !!native, JSON.stringify(native));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const { frame, value: proxied } = await readDefaults(page);
	ok(`${mode}: the page reports through the proxy`, !!proxied);
	if (!native || !proxied) continue;
	const differ = Object.keys(native).filter(
		(key) => JSON.stringify(native[key]) !== JSON.stringify(proxied[key]),
	);
	ok(
		`${mode}: a missing or empty URL attribute reads back as on the real site`,
		differ.length === 0,
		JSON.stringify(
			Object.fromEntries(
				differ.map((key) => [
					key,
					{ native: native[key], proxied: proxied[key] },
				]),
			),
		),
	);
	const landed = await submissions(page, frame);
	ok(
		`${mode}: a form without an action submits to the document's URL, GET and POST`,
		JSON.stringify(landed) === JSON.stringify(nativeLanded) &&
			landed.get !== null &&
			landed.form !== null,
		JSON.stringify({ native: nativeLanded, proxied: landed }),
	);
	await page.close();
}
await done(browser);
