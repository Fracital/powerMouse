// A frame's XMLHttpRequest of its own origin with a header that is not
// safelisted asks nothing first, after its parent read the frame's initial
// about:blank (test/pages/frame-template-xhr.html). On foxnews.com the
// template frame of static.foxnews.com loads its templates this way
// (jQuery's $.ajax adds X-Requested-With) while an ad-safety script reads
// every new frame's contentWindow. Through the proxy that read left the
// frame's document without a controller in Chrome 157 and its requests went
// through the parent's realm, so the worker judged them as the parent's
// (www.foxnews.com): cross-origin, preflighted, and refused when the origin
// answered the OPTIONS with 403. Compared with native in both demo modes,
// for a frame the page left alone and one whose about:blank it read.
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

const target = `${FIXTURE}pages/frame-template-xhr.html`;
const show = (value) => JSON.stringify(value) ?? 'undefined';

async function collect(find) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		const record = await (
			await find()
		)
			?.evaluate(() =>
				window.__record && window.__record.done
					? JSON.stringify(window.__record)
					: null,
			)
			.catch(() => null);
		if (record) return JSON.parse(record);
	}
	return {};
}

const browser = await launch();
const errors = [];

const nativePage = await browser.newPage();
nativePage.on('pageerror', (error) => errors.push(`native: ${error.message}`));
await nativePage.goto(target);
const native = await collect(async () => nativePage.mainFrame());
await nativePage.close();
ok(
	'native: both frames load their template',
	native.untouched === '200 template text' &&
		native.read === '200 template text',
	show(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const top = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	const proxied = await collect(async () => top());
	for (const way of ['untouched', 'read'])
		ok(
			`${mode}: the ${way} frame's template as native`,
			native[way] !== undefined && proxied[way] === native[way],
			`native ${show(native[way])} -> proxied ${show(proxied[way])}`,
		);
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}

await done(browser, errors);
