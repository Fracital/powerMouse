// A page's load event waits for its frames' documents, as natively, however
// late a timer runs. A proxied document starts as STomp's shell, whose
// script cannot open the document while the parser runs it
// (DocumentClient.loadHTML), so the page was written from a timer. On a
// loaded machine the shell's parse could end before that timer ran: the
// frame was then complete, the parent's load fired, and its onload found the
// frame holding the empty shell (web-platform-tests' big5-decode-errors.html
// read none of its frame's spans, one run in a full suite). Here the timer
// the shell's own script sets runs 300 ms late in every document (an init
// script wraps the window's setTimeout), so that the shell's parse ends
// first on every run; natively no such timer exists and nothing changes.
// The parent's onload must find the frame's page with its three spans, the
// frame's document complete, and the frame element must have fired load once.
// Both modes, each compared with the page loaded natively.
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

const PAGE = `${FIXTURE}pages/frame-onload-parent.html`;

// the shell's timer, set by its inline script (the one that calls
// loadHTML), runs 300 ms late; every other timer as it was. The natives are
// taken before the bundle hooks anything
const LATE_SHELL_TIMER = () => {
	const setTimeout = window.setTimeout;
	const currentScript = Object.getOwnPropertyDescriptor(
		Document.prototype,
		'currentScript',
	).get;
	const text = Object.getOwnPropertyDescriptor(
		Node.prototype,
		'textContent',
	).get;
	window.setTimeout = function (callback, delay, ...rest) {
		let shell = false;
		try {
			const script = currentScript.call(document);
			shell = !!script && /\.loadHTML\(/.test(text.call(script));
		} catch {
			// no document
		}
		return Reflect.apply(setTimeout, this, [
			callback,
			shell && !delay ? 300 : delay,
			...rest,
		]);
	};
};

const browser = await launch();
const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
/** what the parent page recorded at its onload, once it has */
async function recorded(getFrame) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		const value = await getFrame()
			?.evaluate(() => window.__onload ?? null)
			.catch(() => null);
		if (value) return value;
	}
	return null;
}

const nativePage = await browser.newPage();
await nativePage.addInitScript(LATE_SHELL_TIMER);
await nativePage.goto(PAGE);
const native = await recorded(() => nativePage.mainFrame());
await nativePage.close();
ok(
	"natively: the parent's onload finds the frame's page, complete, and the frame fired load once",
	native?.spans === 3 && native.readyState === 'complete' && native.loads === 1,
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await page.addInitScript(LATE_SHELL_TIMER);
	await submitLanding(page, PAGE);
	const proxied = await recorded(() => frameOf(page));
	ok(
		`${mode}: the parent's onload finds the frame's page as natively, with the shell's timer late`,
		JSON.stringify(proxied) === JSON.stringify(native),
		`native ${JSON.stringify(native)} proxied ${JSON.stringify(proxied)}`,
	);
	await page.close();
}

await done(browser);
