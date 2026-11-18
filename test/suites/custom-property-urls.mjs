// A custom property's value reads back as the page wrote it: a url() in
// one is neither resolved nor quoted, in a computed style, a rule's style or
// an element's (natively a custom property keeps its tokens as written).
// The readback served a computed one as the absolute, quoted URL, and
// lichess.org, which cuts `url(` and `)` off its `---white-king` and loads
// the rest, asked for `/"https://lichess.org/assets/...` for every chess
// piece. The page (test/pages/custom-property-urls.html) reads custom
// properties of a style element, a linked sheet and an inline style, and
// loads an image from one as lichess does; compared with native in both
// demo modes.
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

const target = `${FIXTURE}pages/custom-property-urls.html`;
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
	'native: the values read as written and the image loads',
	native['computed --piece'] === 'url(/pages/blank-cors-image.svg)' &&
		native.image === 'load 3',
	show(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await collect(async () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	for (const key of Object.keys(native).filter((k) => k !== 'done'))
		ok(
			`${mode}: ${key} as native`,
			proxied[key] === native[key],
			`native ${show(native[key])} -> proxied ${show(proxied[key])}`,
		);
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}

await done(browser, errors);
