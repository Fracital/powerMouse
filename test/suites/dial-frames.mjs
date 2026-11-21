// Dialing's nested frames (src/inject/dom/calledFrames.ts) when the page
// reads a frame's window or document before the frame is dialed.
//
// A dialed document's frame loads the call page (its depth's), which is of
// the document's origin on the host, so the browser keeps the frame's
// initial about:blank window for it. A read of the frame's `contentWindow`
// or `contentDocument` then must leave that window as the browser made it:
// the frame is still dialed, its document loads and its `load` fires once,
// as without the read. The window read early is another origin's stand-in
// until the frame's document is written (natively it is the frame's window
// from the start): it gives the page nothing, never a window that runs
// nothing of the proxy's.
//
// At the page's own load every frame's document has loaded, as natively
// (the worker holds an image of the document's while a frame of it is
// called, calledFrames.ts hold): a fresh read of a frame of its origin
// gives its document and its `navigation`.
//
// The frame's next document, while the frame is on its call page again:
// the window the page held never shows the call page's document.
//
// Fail closed: a frame of another origin, read early, gives the page
// nothing of its document then or after (its document null, its window's
// members SecurityErrors), as natively.
//
// Run in plain dialing (`?nopool&mode=just-call-stomp`) and on the content
// slots (`?mode=just-call-stomp` with STOMP_SLOT_PORTS), where the frame of
// another origin is on another slot.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const PAGES = `${FIXTURE}pages/`;
const SLOTS = (process.env.CONTENT_SLOT_PORTS ?? '')
	.split(',')
	.map(Number)
	.filter((port) => port > 0);

const browser = await launch();
const errors = [];

async function run(label, url) {
	const page = await openDemo(browser, url);
	const reports = [];
	const early = [];
	page.on('console', (message) => {
		const text = message.text();
		try {
			if (text.startsWith('JCS:')) reports.push(JSON.parse(text.slice(4)));
			if (text.startsWith('EARLY:')) early.push(JSON.parse(text.slice(6)));
		} catch (error) {
			// cut short
		}
	});
	const waitFor = async (list, pred, timeout = 30000) => {
		for (const start = Date.now(); Date.now() - start < timeout;) {
			const found = list.find(pred);
			if (found) return found;
			await sleep(100);
		}
		return null;
	};
	await submitLanding(page, `${PAGES}dial-early.html`);
	const loaded = await waitFor(early, (r) => r.why === 'load');
	const childLoad = (tag) =>
		waitFor(
			reports,
			(r) => r.step === 'child' && r.why === 'load' && r.href.includes(tag),
		);
	const markup = await childLoad('?early-markup');
	const made = await childLoad('?early-made');
	const other = await childLoad('?early-other');
	await sleep(1500);
	const last = early.at(-1) ?? {};
	console.log(`# ${label}${JSON.stringify(last)}`);
	ok(`${label}the page loads`, !!loaded, JSON.stringify(early.at(-1)));
	ok(
		`${label}a frame of the markup read early is dialed and its document loads`,
		!!markup,
	);
	ok(
		`${label}a frame a script made, read early, is dialed and its document loads`,
		!!made,
	);
	ok(
		`${label}a frame of another origin read early is dialed and its document loads`,
		!!other,
	);
	ok(
		`${label}each frame's load fired once before the page's, as natively`,
		loaded?.markupLoads === 1 &&
			loaded?.madeLoads === 1 &&
			loaded?.otherLoads === 1,
		JSON.stringify([
			loaded?.markupLoads,
			loaded?.madeLoads,
			loaded?.otherLoads,
		]),
	);
	for (const name of ['markup', 'made']) {
		const at = loaded?.[`${name}AtLoad`] ?? {};
		ok(
			`${label}at the page's load, its ${name} frame's document has loaded and reads as natively`,
			at.title === 'JCS child' && at.navigation === 'object',
			JSON.stringify(at),
		);
		// (natively the window read early is the frame's window from then
		// on; here it is another origin's stand-in, which gives the page
		// nothing, and the frame's next read is its window)
		ok(
			`${label}its window read early gave nothing of an unwritten frame`,
			loaded?.[`${name}Early`]?.[1] === 'null' &&
				/^throws SecurityError$/.test(at.earlyTitle) &&
				/^throws SecurityError$/.test(at.earlyNavigation),
			JSON.stringify([loaded?.[`${name}Early`], at]),
		);
	}
	const second = await waitFor(early, (r) => r.why === 'second');
	ok(
		`${label}the window the page holds never shows the frame's call page while its next document is called`,
		!!second &&
			second.heldSeen.length > 0 &&
			!second.heldSeen.includes('the call page') &&
			second.markupLoads === 2,
		JSON.stringify(second && [second.heldSeen, second.markupLoads]),
	);
	ok(
		`${label}and once it is written, the frame's next document is read through the frame`,
		second?.nowTitle === 'JCS child',
		JSON.stringify(second && [second.nowTitle, second.heldTitle]),
	);
	const foreign = loaded?.otherAtLoad ?? {};
	ok(
		`${label}a frame of another origin read early gives nothing of its document`,
		foreign.document === 'null' &&
			/^throws SecurityError$/.test(foreign.title) &&
			/^throws SecurityError$/.test(foreign.earlyTitle) &&
			/^throws SecurityError$/.test(foreign.eval) &&
			/^throws SecurityError$/.test(foreign.navigation),
		JSON.stringify(foreign),
	);
	errors.push(...page.errors);
	await page.close();
}

await run('', `${PROXY}?nopool&mode=just-call-stomp`);
if (SLOTS.length) await run('content slots: ', `${PROXY}?mode=just-call-stomp`);
else console.log('# no content slots (CONTENT_SLOT_PORTS): not run on them');
await done(browser, errors);
