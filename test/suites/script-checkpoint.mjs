// The page's markup reaches the browser through document.write (loadHTML),
// and the scripts of one write run back to back: no microtask checkpoint
// between them, where a parser fed by the network performs one before each
// script it inserted (the HTML standard's "text" insertion mode). A
// MutationObserver then saw a script only after it had run, and a script's
// promise reactions ran after the next scripts. The markup is now written in
// pieces that end before each `</script`, each from a microtask queued after
// those of the piece before, and a script the parser has not run yet reads
// back as the page wrote it, not as the rewrite it holds. The fixture
// (test/pages/script-checkpoint.html) logs what an observer sees of each
// script, edits two before they run (one after a parser-blocking external
// script) and logs its promise reactions; through the proxy the log is the
// native one but for where the reactions stand against the observer's
// callback (below). Between two pieces the page's write and open() open the
// document, as where the network's parser has no insertion point (WPT's
// document-write/mutation-observer.html), and while the pieces are written a
// script's close() ends nothing, as with the network's parser
// (test/pages/script-checkpoint-close.html).
import { done, FIXTURE, launch, ok, PROXY } from '../lib.mjs';

const browser = await launch();
const site = `${FIXTURE}pages/script-checkpoint.html`;
const logOf = (frame) =>
	frame
		.waitForFunction(() => window.__checkpoint?.includes('last'), null, {
			timeout: 20000,
		})
		.then(() => frame.evaluate(() => [...window.__checkpoint]));

const nativePage = await browser.newPage();
await nativePage.goto(site);
const native = await logOf(nativePage.mainFrame());
// a script that writes and calls close() while the page is parsed: the
// network's parser is no script-created parser, so close() ends nothing
const closing = `${FIXTURE}pages/script-checkpoint-close.html`;
await nativePage.goto(closing);
const closedOf = (frame) =>
	frame
		.waitForFunction(() => window.__closed, null, { timeout: 20000 })
		.then(() => frame.evaluate(() => window.__closed))
		// the rest of the page lost: what the frame has
		.catch(() =>
			frame.evaluate(() =>
				[...document.querySelectorAll('p')].map((p) => p.id),
			),
		);
const nativeClosed = await closedOf(nativePage.mainFrame());
await nativePage.close();
ok(
	'natively an observer sees each script before it runs, and edits the two it is given',
	native.includes('microtask of the first') &&
		native.indexOf('microtask of the second') <
			native.indexOf("saw log('EDIT_ME as written');") &&
		native.filter((entry) => entry === 'edited').length === 2 &&
		!native.some((entry) => /^EDIT_ME/.test(entry)),
	JSON.stringify(native),
);

const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(async (site) => {
	const element = document.createElement('iframe');
	element.name = 'checkpoint';
	document.body.append(element);
	const frame = window.controller.createFrame(element);
	await frame.go(site);
}, site);
const proxied = await logOf(page.frame({ name: 'checkpoint' }));
await page.evaluate(async (closing) => {
	const element = document.createElement('iframe');
	element.name = 'closing';
	document.body.append(element);
	await window.controller.createFrame(element).go(closing);
}, closing);
const proxiedClosed = await closedOf(page.frame({ name: 'closing' }));
ok(
	"a script's close() while the page is parsed ends nothing, as natively",
	JSON.stringify(nativeClosed) === JSON.stringify(['written', 'after']) &&
		JSON.stringify(proxiedClosed) === JSON.stringify(nativeClosed),
	JSON.stringify([proxiedClosed, nativeClosed]),
);
// what an observer sees and edits, and what runs, in order
const seen = (log) => log.filter((entry) => !entry.startsWith('microtask'));
ok(
	'through the proxy an observer sees each script as the page wrote it, before it runs, and its edits run in its place',
	JSON.stringify(seen(proxied)) === JSON.stringify(seen(native)),
	JSON.stringify([proxied, native]),
);
// a script's promise reactions run before the next script does. (Natively
// they also run before the observer hears of the next script; through the
// proxy the observer hears first: a classic script's first statement puts
// the page's text back for document.currentScript, a mutation whose
// observers' microtask is queued before the script's own reactions)
const before = (log, entry, next) =>
	log.indexOf(entry) !== -1 && log.indexOf(entry) < log.indexOf(next);
ok(
	"through the proxy a script's promise reactions run before the next script, as natively",
	[native, proxied].every(
		(log) =>
			before(log, 'microtask of the first', 'second') &&
			before(log, 'microtask of the second', 'edited'),
	),
	JSON.stringify([proxied, native]),
);

await browser.close();
done();
