// Another origin's video or sound loaded with crossorigin=anonymous plays
// as natively. The worker showed every cors answer of another origin only
// the headers CORS lets a page read, which is right for the page's own
// fetch or XMLHttpRequest but not for an element: the element reads the
// whole response, and a media element's Range request answered with a 206
// and no Content-Range is a format error (amazon.com: every homepage video
// failed with MEDIA_ERR_SRC_NOT_SUPPORTED). The page
// (test/pages/media-cors.html) loads a video and a sound of another origin
// with and without crossorigin, and fetches a range of the video itself;
// the suite compares the proxied record with native in both demo modes.
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

const target = `${FIXTURE}pages/media-cors.html`;
const show = (value) => JSON.stringify(value) ?? 'undefined';

async function collect(find) {
	for (let i = 0; i < 200; i++) {
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
	'native: the cors video and sound load, and the page reads no Content-Range',
	/^metadata/.test(native['video anonymous']) &&
		/^metadata/.test(native['audio anonymous']) &&
		/^206 cors {2}video\/webm 100$/.test(native.fetch),
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
