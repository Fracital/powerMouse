// A document keeps its encoding through the proxy. The worker decoded a
// page with the encoding the browser would pick and served it as UTF-8, so
// the browser encoded the query of the page's links, its GET forms, its
// XMLHttpRequests and its workers' URLs as UTF-8 (a search reached the
// server as other bytes than natively), and document.characterSet read
// UTF-8; and a classic script or a stylesheet that names no encoding, which
// takes its document's, was read as UTF-8. A Shift_JIS and an EUC-KR page,
// their text in their own bytes, each read what the page sees (the three
// getters, a link's, an image's, a made link's and a form's URL, new URL and
// an inert document's link, which are UTF-8 natively too, an
// XMLHttpRequest's and a worker's URL, the text of a script and a sheet
// that name no encoding and of a sheet in the other encoding by its
// @charset) and then navigate by a link, by a form in the page's encoding,
// by a form that names UTF-8 and by location.assign; each landing's query is
// compared with the page loaded natively, in both demo modes.
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

const browser = await launch();
const PAGES = ['shift_jis', 'euc-kr'];
const NAVIGATIONS = ['link', 'form', 'utf8Form', 'assign'];

/** what the page read, once its worker answered */
async function read(frame) {
	for (let i = 0; i < 100; i++) {
		const value = await frame()
			?.evaluate(() => window.__encodingOut)
			.catch(() => null);
		if (value?.done) return value;
		await sleep(250);
	}
	return null;
}

/** the query of the landing page the frame navigated to */
async function landed(frame) {
	for (let i = 0; i < 100; i++) {
		const value = await frame()
			?.evaluate(() => window.__landed ?? null)
			.catch(() => null);
		if (typeof value === 'string') return value;
		await sleep(250);
	}
	return null;
}

const frameOf = (page) => () =>
	page
		.frames()
		.findLast(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html[:/]/.test(f.url()),
		);

const native = {};
for (const name of PAGES) {
	const url = `${FIXTURE}pages/document-encoding-${name}.bin`;
	const page = await browser.newPage();
	await page.goto(url);
	const result = { read: await read(() => page.mainFrame()) };
	for (const kind of NAVIGATIONS) {
		await page.goto(url);
		await read(() => page.mainFrame());
		await page.evaluate((kind) => window.__navigate[kind](), kind);
		result[kind] = await landed(() => page.mainFrame());
	}
	await page.close();
	native[name] = result;
	ok(
		`natively, the ${name} page reads its own encoding and its legacy queries`,
		result.read?.characterSet !== 'UTF-8' &&
			result.read?.linkSearch !== result.read?.newURL &&
			result.form !== null,
		JSON.stringify(result),
	);
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const name of PAGES) {
		const url = `${FIXTURE}pages/document-encoding-${name}.bin`;
		const page = await openDemo(browser, base);
		await submitLanding(page, url);
		const proxied = await read(frameOf(page));
		for (const [key, value] of Object.entries(native[name].read ?? {}))
			ok(
				`${mode}: ${name} ${key} reads what it reads natively (${value})`,
				proxied?.[key] === value,
				JSON.stringify(proxied?.[key]),
			);
		await page.close();
		// each navigation from a page of its own
		for (const kind of NAVIGATIONS) {
			const from = await openDemo(browser, base);
			await submitLanding(from, url);
			await read(frameOf(from));
			await frameOf(from)()
				?.evaluate((kind) => window.__navigate[kind](), kind)
				.catch(() => {});
			const query = await landed(frameOf(from));
			ok(
				`${mode}: ${name} ${kind} lands on the query it lands on natively (${native[name][kind]})`,
				query === native[name][kind],
				JSON.stringify(query),
			);
			await from.close();
		}
	}
}

await done(browser);
