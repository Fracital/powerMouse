// A body the worker transforms (a document's shell, a rewritten script, one
// from the rewrite cache, a rewritten stylesheet) goes out with its own length or none, never the
// origin's: the origin's Content-Length counted the bytes the origin sent,
// and a shell 2367 bytes long went out saying 1137. A body passed through
// keeps the origin's length, for a GET and a HEAD, as natively (a gzipped
// one too). A HEAD of a route that transforms has no body to measure, so it
// says no length. Both modes; the route-level HEAD in same-origin mode, where
// the host can fetch as the proxied frame.
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
const PAGE = `${FIXTURE}pages/content-length.html`;
const ROUTED = /\/stomp\/[\w-]+\/(html|js|css)[:/]/;

async function lengths(frame) {
	for (let i = 0; i < 60; i++) {
		const value = await frame()
			?.evaluate(() => window.__lengths ?? null)
			.catch(() => null);
		if (value) return value;
		await sleep(250);
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await lengths(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: the passthrough files carry the length the fixture sent, the gzipped one its encoding',
	native?.['content-length.txt GET']?.length ===
		String(native?.['content-length.txt GET']?.body) &&
		native?.['content-length.gz.bin GET']?.encoding === 'gzip',
	JSON.stringify(native),
);

// the proxied page: the routed frame the host itself holds
const frameOf = (page) =>
	page
		.frames()
		.findLast(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html[:/]/.test(f.url()),
		);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// every response the worker made for the page: its length against its body
	const made = [];
	page.context().on('response', async (response) => {
		if (!ROUTED.test(response.url())) return;
		const body = await response.body().catch(() => null);
		if (body === null) return;
		made.push({
			kind: ROUTED.exec(response.url())[1],
			length: response.headers()['content-length'] ?? null,
			body: body.length,
		});
	});
	await submitLanding(page, PAGE);
	const proxied = await lengths(() => frameOf(page));
	// again in the same tab: the script's rewrite comes from the rewrite cache
	await frameOf(page)?.evaluate(() => location.reload());
	await sleep(500);
	await lengths(() => frameOf(page));
	await sleep(500);
	const kinds = new Set(made.map((entry) => entry.kind));
	ok(
		`${mode}: the document, script and stylesheet the worker rewrote say their own length or none`,
		['html', 'js', 'css'].every((kind) => kinds.has(kind)) &&
			// the script twice, the second from the rewrite cache
			made.filter((entry) => entry.kind === 'js').length >= 2 &&
			made.every(
				(entry) => entry.length === null || Number(entry.length) === entry.body,
			),
		JSON.stringify(made),
	);
	for (const key of [
		'content-length.txt GET',
		'content-length.txt HEAD',
		'content-length.gz.bin GET',
		'content-length.gz.bin HEAD',
	])
		ok(
			`${mode}: ${key} passed through says the origin's length, as natively`,
			proxied?.[key]?.length === native?.[key]?.length &&
				proxied?.[key]?.body === native?.[key]?.body,
			`native ${JSON.stringify(native?.[key])} proxied ${JSON.stringify(proxied?.[key])}`,
		);
	if (mode === 'same-origin') {
		// a srcdoc frame the host's own DOM methods put in the proxied document
		// has no hooks, and the worker controls it (it inherits its parent's):
		// its fetch of the document's route reaches the worker
		const route = await page
			.evaluate(async () => {
				// Location's members are unforgeable: the frame's hooks cannot
				// reach them, so this is its routed URL
				const frame = [...document.querySelectorAll('iframe')]
					.map((element) => element.contentWindow)
					.find((w) => {
						try {
							return /\/stomp\/[\w-]+\/html[:/]/.test(w.location.href);
						} catch (error) {
							return false;
						}
					});
				// the page's frame of content-length-head.html.bin, whose origin
				// says its length for a HEAD too
				const url = frame.frames[0].location.href;
				const blank = Document.prototype.createElement.call(
					frame.document,
					'iframe',
				);
				// a srcdoc document is controlled by its parent's worker
				Element.prototype.setAttribute.call(blank, 'srcdoc', '<p>probe</p>');
				const loaded = new Promise((resolve) =>
					EventTarget.prototype.addEventListener.call(blank, 'load', resolve),
				);
				Node.prototype.appendChild.call(frame.document.body, blank);
				await loaded;
				const own = Reflect.getOwnPropertyDescriptor(
					HTMLIFrameElement.prototype,
					'contentWindow',
				).get.call(blank);
				const get = await own.fetch(url);
				const head = await own.fetch(url, { method: 'HEAD' });
				return {
					get: get.headers.get('content-length'),
					body: (await get.arrayBuffer()).byteLength,
					head: head.headers.get('content-length'),
					headType: head.headers.get('content-type'),
					controlled: !!own.navigator.serviceWorker?.controller,
				};
			})
			.catch((error) => ({ error: String(error).slice(0, 200) }));
		ok(
			"same-origin: a GET of a document's route says the shell's length, a HEAD says none (its origin said one)",
			(route.get === null || Number(route.get) === route.body) &&
				route.head === null &&
				/text\/html/.test(route.headType ?? ''),
			JSON.stringify(route),
		);
	}
	await page.close();
}

await done(browser);
