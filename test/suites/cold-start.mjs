// The rewriter is the wasm core module, with no JavaScript parser shipped.
// The controller compiles the module, and a page's first task often
// rewrites something (eval, new Function, a script element's inline text,
// an inline style) before a message from it could arrive. This suite proves
// that cold-start window is handled: a page whose LITERAL FIRST script does
// those rewrites gets them rewritten, byte-for-byte as the native page sees
// them. A top (and the frames under it) take the compiled module from the
// window the controller left it on, which they reach synchronously, and
// make no request for it (rewriteCounts coreReached, coreRequests); a
// window opened with noopener reaches none, and its library compiles the
// module's bytes from a synchronous request the first time a rewrite needs
// it (src/inject/rewriter.ts provideModule, src/wasm/thread.ts).
//
// location.href is the tell: rewritten code reads the page's own URL, code
// that ran raw would read the proxy's routed URL. If the cold-start rewrite
// fell through to nothing, these would be raw (the proxy URL) or would throw.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/cold-start.html`;
/** the runtime-rewrite results the fixture's first script recorded */
const JS_KEYS = ['directEval', 'indirectEval', 'newFunction', 'inlineScript'];

const read = (frame) => frame.evaluate(() => window.__cold);

// natively: every field is the page's own URL
const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
await nativePage.waitForFunction(() => window.__cold?.ready === true);
const native = await read(nativePage.mainFrame());
await nativeBrowser.close();
ok(
	'natively, the first script reads the page URL every way',
	JS_KEYS.every((k) => native[k] === target) &&
		typeof native.inlineStyle === 'string',
	JSON.stringify(native),
);

const browser = await launch();
const clientName = (page) =>
	page.evaluate(() => window.controller.config.names.client);
const counts = (frame, name) =>
	frame.evaluate((name) => window[name].rewriteCounts, name);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const name = await clientName(page);
	await submitOmni(page, target);
	const top = await waitActive(page, `window.__cold?.ready === true`);
	const proxied = await read(top);

	for (const key of JS_KEYS)
		ok(
			`${mode}: the first script's ${key} is rewritten (reads the page URL, not the proxy URL)`,
			proxied[key] === target,
			`${JSON.stringify(proxied[key])}, natively ${JSON.stringify(target)}`,
		);
	ok(
		`${mode}: the first script's inline style reads back as the native page's`,
		proxied.inlineStyle === native.inlineStyle,
		`${JSON.stringify(proxied.inlineStyle)}, natively ${JSON.stringify(native.inlineStyle)}`,
	);

	// the module answered the first script's rewrites, and the top held it
	// before the first of them: it came from the window the controller left
	// it on, which the top reaches synchronously (the host's page in
	// same-origin mode, the controller's frame beside the top in isolated
	// mode), with no synchronous request for core.wasm and no compile on the
	// page's main thread. The isolated mode's top is in another process, but
	// its rewriteCounts are still this realm's to read.
	const topCounts = await counts(top, name);
	ok(
		`${mode}: the module answered the first script's rewrites`,
		topCounts.answered >= 1 && topCounts.loads >= 1,
		JSON.stringify(topCounts),
	);
	ok(
		`${mode}: the top took the controller's compiled module, with no synchronous request for core.wasm`,
		topCounts.coreReached >= 1 &&
			topCounts.coreRequests === 0 &&
			topCounts.early === 0,
		JSON.stringify(topCounts),
	);
	// a frame under the top rewrites in the top's library, which holds it
	const framed = await top.evaluate(async () => {
		const frame = document.createElement('iframe');
		frame.src = 'cold-start.html?framed';
		document.body.append(frame);
		for (let i = 0; i < 200 && !frame.contentWindow?.__cold?.ready; i++)
			await new Promise((resolve) => setTimeout(resolve, 50));
		return frame.contentWindow?.__cold ?? null;
	});
	ok(
		`${mode}: a frame's first script is rewritten too`,
		JS_KEYS.every((k) => framed?.[k] === `${target}?framed`),
		JSON.stringify(framed),
	);
	// a window opened with noopener (here by the host, as a host without
	// onOpen lets a proxied page's popups open) is a browsing context group
	// of its own, which reaches no window of the controller's: its first
	// rewrite asks for the bytes with a synchronous request and compiles
	// them before it answers (the cold path), as correctly
	const [bare] = await Promise.all([
		page.context().waitForEvent('page', { timeout: 30000 }),
		page.evaluate(
			(url) => void window.open(url, '_blank', 'noopener'),
			top.url(),
		),
	]);
	await bare.waitForFunction(() => window.__cold?.ready === true, null, {
		timeout: 30000,
	});
	const bareCold = await read(bare.mainFrame());
	ok(
		`${mode}: a window opened with noopener rewrites its first script`,
		JS_KEYS.every((k) => bareCold[k] === target),
		JSON.stringify(bareCold),
	);
	const bareCounts = await counts(bare.mainFrame(), name);
	ok(
		`${mode}: that window compiled the module from a synchronous request`,
		bareCounts.coreReached === 0 &&
			bareCounts.coreRequests === 1 &&
			bareCounts.early >= 1,
		JSON.stringify(bareCounts),
	);
	await bare.close();
	ok(
		`${mode}: nothing threw loading the page`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}

await done(browser);
