// xml-stylesheet processing instructions and XML documents, natively and
// through the proxy in both demo modes: a PI a script puts in an HTML
// document (made, imported from a DOMParser document, its data set or
// edited) loads its stylesheet through the proxy, a cross-site one too,
// and reads back as the page wrote it; a text/xml document's prolog PI
// styles it and its XHTML script runs with the proxy's hooks; an
// application/xml document whose PI names an XSLT shows the transform's
// output. Nothing reaches the network past the proxy.
//
// Chrome 158 removed XSLT: there the XSLT document is not transformed and
// its stylesheet is never requested, natively and through the proxy, which
// is what is compared for it (XSLT_GONE).
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const FILES = ['pi-html.html', 'pi-doc.xml', 'pi-xslt.xml'];
const XSLT_GONE = Number(browser.version().split('.')[0]) >= 158;
const XSLT_FILE = 'pi-xslt.xml';

/** how often the fixture served `file` */
const served = async (file) =>
	(await (await fetch(`${FIXTURE}hits`)).json())[file]?.requests ?? 0;

/**
 * What a browser without XSLT makes of the XSLT document, read from its
 * frame once its tree is there: whether the transform ran (its output's
 * list and title), and whether its stylesheet was requested
 */
async function untransformed(page, proxied, before) {
	let facts = null;
	for (let i = 0; i < 50 && !facts; i++) {
		await sleep(200);
		const frames = proxied
			? page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			: [page.mainFrame()];
		for (const frame of frames)
			facts ??= await frame
				.evaluate(() =>
					document.readyState === 'complete'
						? {
								transformed:
									!!document.getElementById('list') ||
									document.title === 'XSLT OUTPUT',
							}
						: null,
				)
				.catch(() => null);
	}
	// (a request would have gone out with the document's)
	await sleep(1000);
	return facts && { ...facts, sheet: (await served('pi-xslt.xsl')) > before };
}

/** the cases the page reported, from whichever frame reports them */
async function read(page, proxied) {
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		const frames = proxied
			? page.frames().filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))
			: [page.mainFrame()];
		for (const frame of frames.reverse()) {
			const value = await frame.evaluate(() => window.__pi).catch(() => null);
			if (value?.done) return value.cases;
		}
	}
	return null;
}

const native = {};
for (const file of FILES) {
	const page = await browser.newPage();
	const before = await served('pi-xslt.xsl');
	await page.goto(`${FIXTURE}pages/${file}`, { waitUntil: 'commit' });
	native[file] =
		XSLT_GONE && file === XSLT_FILE
			? { xslt: await untransformed(page, false, before) }
			: await read(page, false);
	await page.close();
}
if (XSLT_GONE) {
	const page = await browser.newPage();
	await page.goto(`${FIXTURE}pages/pi-html.html`, { waitUntil: 'commit' });
	const kind = await page.evaluate(() => typeof XSLTProcessor);
	await page.close();
	ok(
		`natively, Chrome ${browser.version()} has no XSLT: the XSLT document is not transformed and its stylesheet is not requested`,
		kind === 'undefined' &&
			native[XSLT_FILE]?.xslt?.transformed === false &&
			native[XSLT_FILE].xslt.sheet === false,
		JSON.stringify({ XSLTProcessor: kind, ...native[XSLT_FILE] }),
	);
}
ok(
	'natively, every page reported',
	FILES.every((file) => native[file]),
	JSON.stringify(native),
);

const proxyOrigin = new URL(PROXY).origin;
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const file of FILES) {
		const page = await openDemo(browser, base);
		const recorder = await recordRequests(page.context());
		const before = await served('pi-xslt.xsl');
		await submitLanding(page, `${FIXTURE}pages/${file}`);
		const proxied =
			XSLT_GONE && file === XSLT_FILE
				? { xslt: await untransformed(page, true, before) }
				: await read(page, true);
		for (const [name, want] of Object.entries(native[file] ?? {})) {
			const got = proxied?.[name];
			ok(
				`${mode}: ${file} ${name} as natively`,
				JSON.stringify(got) === JSON.stringify(want),
				JSON.stringify({ native: want, proxied: got ?? null }),
			);
		}
		const text = JSON.stringify(proxied ?? null);
		ok(
			`${mode}: ${file} reads no proxy URL`,
			!text.includes('/stomp/') && !text.includes(proxyOrigin),
			text.slice(0, 400),
		);
		const raw = recorder.raw();
		ok(
			`${mode}: ${file} makes no request past the proxy`,
			raw.length === 0,
			raw.map((entry) => `${entry.url} (${entry.type})`).join(' | '),
		);
		await page.context().close();
	}
}
await done(browser);
