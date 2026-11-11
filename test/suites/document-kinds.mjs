// Every kind of document a page makes itself, each with one image in its
// markup: an about:blank frame (fresh, written, sandboxed), a srcdoc frame,
// blob:, data: and javascript: documents, a real page, each of them again
// inside an about:blank frame, popups and the frames in them, an <object>'s
// and an <embed>'s document. Chrome gives an about:blank document no service
// worker (nor a srcdoc document under one, nor an object's or embed's), so
// the proxy copies those documents' loads (docs/same-origin-policy.md); the
// rest are served by the worker. Whatever the way, the image loads where it
// loads natively, in both modes, and each kind is reached the way the
// document says.
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

const target = `${FIXTURE}pages/document-kinds.html`;
// how each kind's image is loaded through the proxy: a copy the inject
// fetched, or a route the document's own service worker answers
const COPIED = [
	'blank',
	'blank-written',
	'srcdoc-in-blank',
	'blank-in-srcdoc',
	'blank-in-blank',
	'sandbox-same-origin-blank',
	'sandbox-scripts-same-origin-blank',
	'object',
	'embed',
	'popup',
	'popup-written',
	'blank-in-popup',
	'srcdoc-in-popup',
];
const browser = await launch();

/** each kind's image: the event it fired, its width, and how it was loaded */
async function read(page) {
	const out = { cases: null, kinds: {} };
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		let finished = null;
		for (const frame of page
			.context()
			.pages()
			.flatMap((p) => p.frames())) {
			const value = await frame
				.evaluate(() => window.__kinds)
				.catch(() => null);
			if (value?.done) finished = value;
		}
		if (finished) {
			out.cases = finished.cases;
			break;
		}
	}
	for (const p of page.context().pages())
		for (const frame of p.frames()) {
			let handles;
			try {
				handles = await frame.locator('img[id^="k-"]').elementHandles();
			} catch (error) {
				continue;
			}
			for (const handle of handles)
				try {
					// the attributes as the browser holds them (the page's own reads
					// go through the proxy's hooks)
					const id = (await handle.getAttribute('id')).slice(2);
					const src = await handle.getAttribute('src');
					out.kinds[id] = {
						event: (await handle.getAttribute('data-e')) ?? 'pending',
						width: await handle.evaluate((element) => element.naturalWidth),
						how: src?.startsWith('blob:') ? 'copy' : 'route',
					};
				} catch (error) {
					// a frame that went away
				}
		}
	return out;
}

const nativePage = await browser.newPage();
await nativePage.goto(target);
const native = await read(nativePage);
await nativePage.context().close();
const names = Object.keys(native.cases ?? {});
ok(
	'natively, every kind of document was made and its image is there',
	names.length > 20 &&
		names.every((name) => native.cases[name] === 'made' && native.kinds[name]),
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const proxied = await read(page);
	for (const name of names) {
		const want = native.kinds[name];
		const got = proxied.kinds[name];
		ok(
			`${mode}: the image of ${name} as natively (${want?.event})`,
			!!got && got.event === want?.event && got.width === want?.width,
			JSON.stringify({ native: want, proxied: got ?? null }),
		);
		ok(
			`${mode}: ${name} is ${COPIED.includes(name) ? 'copied (no service worker controls it)' : 'served by the worker'}`,
			got?.how === (COPIED.includes(name) ? 'copy' : 'route'),
			JSON.stringify(got ?? null),
		);
	}
	await page.context().close();
}
await done(browser);
