// The rewriter is the wasm core module, with no JavaScript parser shipped.
// The controller compiles the module and a page is handed it once it has, but
// a page's first task often rewrites something (eval, new Function, a script
// element's inline text, an inline style) before that compiled module has
// arrived over the message round trip. This suite proves that cold-start
// window is handled: a page whose LITERAL FIRST script does those rewrites
// gets them rewritten, byte-for-byte as the native page sees them, because the
// page's library compiles the module's bytes synchronously the first time a
// rewrite needs it (src/inject/rewriter.ts provideModule, src/wasm/thread.ts).
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

	// the cold-start path actually fired: a rewrite was asked before this
	// realm held the module (early), the module was then handed in (loads) and
	// answered the rewrite (answered). The isolated mode's top is in another
	// process, but its rewriteCounts are still this realm's to read.
	const topCounts = await counts(top, name);
	ok(
		`${mode}: a rewrite was asked before the module arrived, then the module answered it`,
		topCounts.early >= 1 && topCounts.answered >= 1 && topCounts.loads >= 1,
		JSON.stringify(topCounts),
	);
	ok(
		`${mode}: nothing threw loading the page`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}

await done(browser);
