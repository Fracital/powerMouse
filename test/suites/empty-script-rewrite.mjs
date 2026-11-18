// A script with no text has nothing to rewrite: an external script, a module,
// an empty element and one added with no text. The page's rewriter answered
// its text all the same, and a top document's first task, before the
// controller's compiled module has reached the realm, fetched the wasm core
// module synchronously and compiled it (src/inject/rewriter.ts
// provideModule) to rewrite ''. Every proxied top whose markup had an
// external script paid that, 15 to 30 ms before its first paint. The page
// here has only prewritten inline scripts and scripts with no text: the
// proxied page asks its rewriter for nothing early, and its scripts run and
// read back as natively.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const target = `${FIXTURE}pages/empty-scripts.html`;
const read = (frame) => frame.evaluate(() => window.__empty);

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
await nativePage.waitForFunction(() => window.__empty?.ready === true);
const native = await read(nativePage.mainFrame());
await nativeBrowser.close();
ok(
	'natively, the external and module scripts ran and every script reads back its text',
	native.ran.join() === `classic,${target},module,${target}` &&
		native.addedText === '',
	JSON.stringify(native),
);

const browser = await launch();
const page = await openDemo(browser);
const name = await page.evaluate(() => window.controller.config.names.client);
await submitOmni(page, target);
const top = await waitActive(page, `window.__empty?.ready === true`);
const proxied = await read(top);
ok(
	'proxied, the scripts ran as natively and read back the same texts',
	JSON.stringify(proxied) === JSON.stringify(native),
	`${JSON.stringify(proxied)}, natively ${JSON.stringify(native)}`,
);
const counts = await top.evaluate((name) => window[name].rewriteCounts, name);
ok(
	'proxied, nothing was asked of the rewriter before its module arrived, and no synchronous module load was waited for',
	counts.early === 0 && counts.requests === 0,
	JSON.stringify(counts),
);
ok(
	'nothing threw loading the page',
	page.errors.length === 0,
	JSON.stringify(page.errors),
);

await done(browser);
