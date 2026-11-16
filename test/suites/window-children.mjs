// A window is array-like by its children (`window[0]` is its first frame's
// window), and the browser's own methods that read an array-like read them
// with no hook in the way: `Array.prototype.at.call(window, 0)`, `values`,
// `find`, `slice` and the rest of Array.prototype, a window given as the
// arguments of `f.apply`, `Reflect.apply` or `Reflect.construct`, and what
// is built on those (an iterator helper, a Map of the entries). A frame of
// another site came out of them as the proxy's own window, whose document
// the page then read. test/pages/window-children.html frames a page of
// another site and reads its document every such way; each must end as it
// does natively (refused, a SecurityError, or the TypeError of a window
// that is not iterable).
//
// Also: a sort's comparisons (the browser refuses its writes after them),
// what the page has of a child found by indexOf and includes, a callback's
// last argument, a method that NodeList shares with Array, a method bound
// to a window or reached by `call.call` and `call.bind`, an iterator that
// sees a frame added after it was made, `concat` of a window the page made
// spreadable, JSON.stringify's replacer, a typed array's `from` and
// Array.fromAsync.
//
// An object spread of a window (`{ ...window }`) copies its own enumerable
// properties with no call the inject can wrap: its children, and its `top`
// and `location` (a document's spread its `location`), which came out as
// the browser holds them, the real top and the proxy's own URL. The
// rewriter routes the spread through the access API, which hands each out
// as a member read does. An object pattern's rest (`const { ...rest } =
// window`, in a declaration, an assignment, a parameter, a loop's head, a
// nested pattern) copies the same, and a pattern's index key
// (`const { 0: child } = window`) reads a child: the rewriter routes their
// source too.
//
// What this does not cover: an array method the page made a method of the
// window itself and calls as one; it is listed below as known, and fails
// the suite once it reads as natively.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	submitLanding,
	waitActive,
} from '../lib.mjs';

const KNOWN = new Map([
	[
		'ownMethod',
		"Array.prototype's method made a window's own and called as one has the window as `this` with no call the inject sees (the methods are not wrapped: src/inject/modules/Reflection.ts applyWindowChildren)",
	],
]);
const address = `${FIXTURE}pages/window-children.html`;
const browser = await launch();
const page = await browser.newPage();
await page.goto(address);
await page.waitForFunction(() => window.__children?.done === true);
const native = await page.evaluate(() => window.__children);
await page.close();

const tab = await openDemo(browser, PROXY);
await submitLanding(tab, address);
const frame = await waitActive(
	tab,
	"window.__children?.done === true && document.title === 'window children'",
);
const proxied = await frame.evaluate(() => window.__children);
for (const name of Object.keys(native)) {
	if (name === 'done') continue;
	const same = proxied[name] === native[name];
	const known = KNOWN.get(name);
	ok(
		known ? `KNOWN ${name}: ${known}` : `${name} as natively`,
		known ? !same : same,
		same ? native[name] : `natively ${native[name]}, proxied ${proxied[name]}`,
	);
}
ok(
	'natively, the frame of another site is refused',
	native.at === 'threw SecurityError' &&
		native.values === 'threw SecurityError',
	JSON.stringify(native),
);
await done(browser, tab.errors);
