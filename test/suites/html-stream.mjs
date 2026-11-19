// A document is parsed and painted as its markup arrives, as natively: the
// worker waited for the whole body before the page got any of it, and the
// client copied and wrote all of it in one task, so a large page painted
// nothing for seconds (CNN 3.4 s, a 20 MB page 7.5 s, natively 0.1 s). The
// fixture's documents (test/stream-server.mjs) pause between their first
// part and the rest, and each is compared with the same document loaded
// natively:
// - while the rest is on its way, the first part is in the page (its
//   heading, a write of its script), the rest is not, and the document is
//   loading; then the scripts of the rest run in order (an external one
//   that arrives late, a write landing after its script) and the page is
//   whole;
// - a timer's write while the rest is on its way opens the document again,
//   and the rest never lands;
// - a Shift_JIS page whose characters are split between the parts reads
//   the same text;
// - the navigation's body sizes are the document's, not the shell's;
// - a sandboxed frame (allow-scripts, an opaque origin) of the first case
//   loads as natively, and one sandboxed with nothing allowed holds the
//   whole page and ran none of it;
// - a head of 1.5 MB, most of it one style (CNN's is 3.7 MB), is in while
//   the rest is on its way, its scripts read the style's text as natively,
//   and the style applies.
import {
	done,
	evaluateIsolated,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const WAIT = 4000;
const ROUTE = /\/stomp\/[\w-]+\/html[:/]/;

/** `read` in the frame `find` gives, until it answers non-null */
async function poll(find, read, arg, tries = 200, every = 50) {
	for (let i = 0; i < tries; i++) {
		const frame = find();
		const value = frame
			? await frame.evaluate(read, arg).catch(() => null)
			: null;
		if (value !== null && value !== undefined) return value;
		await sleep(every);
	}
	return null;
}

/** a page's frame that shows `url`: natively its main frame, proxied the landing's frame */
async function open(url, proxied) {
	if (!proxied) {
		const page = await browser.newPage();
		page.goto(url, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
		return { page, find: () => page.mainFrame() };
	}
	const page = await openDemo(browser, PROXY);
	await submitLanding(page, url);
	return {
		page,
		find: () =>
			page
				.frames()
				.findLast(
					(f) => f.parentFrame() === page.mainFrame() && ROUTE.test(f.url()),
				),
	};
}

// what of the page is there once its heading is, while the rest is on its way
const midway = () =>
	document.getElementById('early')
		? {
				late: !!document.getElementById('late'),
				w1: !!document.getElementById('w1'),
				readyState: document.readyState,
				order: window.__order?.join() ?? null,
			}
		: null;
// the page once it is whole: its elements' names, in the isolated world
const whole = () =>
	window.__done
		? {
				order: window.__order?.join() ?? null,
				readyState: document.readyState,
			}
		: null;
const shape = () =>
	[...document.body.getElementsByTagName('*')]
		.map((element) => element.localName + (element.id ? `#${element.id}` : ''))
		.join();

async function paintCase(proxied) {
	const { page, find } = await open(
		`${FIXTURE}stream/paint?wait=${WAIT}`,
		proxied,
	);
	try {
		const mid = await poll(find, midway, undefined, 400, 25);
		const end = await poll(find, whole, undefined, 400, 50);
		const frame = find();
		const elements = frame
			? await evaluateIsolated(frame, shape).catch(() => null)
			: null;
		return { mid, end, elements };
	} finally {
		await page.close();
	}
}

async function bigheadCase(proxied) {
	const { page, find } = await open(
		`${FIXTURE}stream/bighead?wait=${WAIT}`,
		proxied,
	);
	try {
		const mid = await poll(find, midway, undefined, 400, 25);
		const end = await poll(
			find,
			() =>
				window.__done
					? {
							order: window.__order.join(),
							color: getComputedStyle(document.getElementById('early')).color,
							text: [
								document.getElementById('big').textContent.slice(0, 160),
								document.getElementById('big').textContent.slice(-80),
							],
							rules: document.styleSheets[0].cssRules.length,
						}
					: null,
			undefined,
			400,
			50,
		);
		return { mid, end };
	} finally {
		await page.close();
	}
}

async function wipeCase(proxied) {
	const { page, find } = await open(
		`${FIXTURE}stream/wipe?wait=${WAIT}`,
		proxied,
	);
	try {
		await poll(find, () => window.__wiped ?? null, undefined, 400, 25);
		// the rest arrives meanwhile
		await sleep(WAIT + 1000);
		const frame = find();
		return frame
			? {
					wiped: await frame
						.evaluate(() => window.__wiped ?? null)
						.catch(() => null),
					after: await frame
						.evaluate(() => window.__after ?? false)
						.catch(() => null),
					elements: await evaluateIsolated(frame, shape).catch(() => null),
				}
			: null;
	} finally {
		await page.close();
	}
}

async function sjisCase(proxied) {
	const { page, find } = await open(`${FIXTURE}stream/sjis?wait=1500`, proxied);
	try {
		return await poll(
			find,
			() =>
				window.__done
					? {
							charset: document.characterSet,
							early: document.getElementById('early')?.textContent,
							late: document.getElementById('late')?.textContent,
						}
					: null,
			undefined,
			400,
			50,
		);
	} finally {
		await page.close();
	}
}

async function sizesCase(proxied) {
	const { page, find } = await open(
		`${FIXTURE}stream/sizes?wait=1500`,
		proxied,
	);
	try {
		return await poll(
			find,
			() => {
				if (document.readyState !== 'complete') return null;
				const entry = performance.getEntriesByType('navigation')[0];
				return entry
					? {
							encoded: entry.encodedBodySize,
							decoded: entry.decodedBodySize,
							transfer: entry.transferSize > entry.encodedBodySize,
						}
					: null;
			},
			undefined,
			400,
			50,
		);
	} finally {
		await page.close();
	}
}

async function frameCase(proxied) {
	const { page, find } = await open(
		`${FIXTURE}stream/frame?wait=1500`,
		proxied,
	);
	try {
		const child = (index) => () =>
			page.frames().filter((f) => f.parentFrame() === find())[index];
		const inner = child(0);
		const end = await poll(inner, whole, undefined, 400, 50);
		const frame = inner();
		const elements = frame
			? await evaluateIsolated(frame, shape).catch(() => null)
			: null;
		// the frame that runs no script: what its markup made, once loaded
		let bare = null;
		for (let i = 0; i < 200 && bare === null; i++) {
			const frame = child(1)();
			bare = frame
				? await evaluateIsolated(frame, () =>
						document.readyState === 'complete' &&
						document.getElementById('tail')
							? [...document.body.getElementsByTagName('*')]
									.map((e) => e.localName + (e.id ? `#${e.id}` : ''))
									.join()
							: null,
					).catch(() => null)
				: null;
			if (bare === null) await sleep(50);
		}
		return { end, elements, bare };
	} finally {
		await page.close();
	}
}

const native = {
	paint: await paintCase(false),
	wipe: await wipeCase(false),
	sjis: await sjisCase(false),
	sizes: await sizesCase(false),
	frame: await frameCase(false),
	bighead: await bigheadCase(false),
};
ok(
	'natively: the heading is in while the rest is on its way, and the page loads whole',
	native.paint.mid?.late === false &&
		native.paint.mid?.readyState === 'loading' &&
		native.paint.end?.order?.endsWith('end'),
	JSON.stringify({ mid: native.paint.mid, end: native.paint.end }),
);
ok(
	"natively: a timer's write opens the document, and the rest never lands",
	native.wipe?.wiped === 'loading' && native.wipe?.after === false,
	JSON.stringify(native.wipe),
);

const proxied = {
	paint: await paintCase(true),
	wipe: await wipeCase(true),
	sjis: await sjisCase(true),
	sizes: await sizesCase(true),
	frame: await frameCase(true),
	bighead: await bigheadCase(true),
};
ok(
	'proxied: while the rest is on its way, the page holds its first part (its heading, its write) and not the rest, and is loading',
	JSON.stringify(proxied.paint.mid) === JSON.stringify(native.paint.mid),
	`${JSON.stringify(proxied.paint.mid)} natively ${JSON.stringify(native.paint.mid)}`,
);
ok(
	"proxied: the rest's scripts run in order (a late external one, a write after its script), as natively",
	JSON.stringify(proxied.paint.end) === JSON.stringify(native.paint.end),
	`${JSON.stringify(proxied.paint.end)} natively ${JSON.stringify(native.paint.end)}`,
);
ok(
	'proxied: the page is whole, element for element',
	proxied.paint.elements !== null &&
		proxied.paint.elements === native.paint.elements,
	`${proxied.paint.elements?.length} natively ${native.paint.elements?.length}`,
);
ok(
	"proxied: a timer's write while the rest is on its way opens the document, and the rest never lands",
	JSON.stringify(proxied.wipe) === JSON.stringify(native.wipe),
	`${JSON.stringify(proxied.wipe)} natively ${JSON.stringify(native.wipe)}`,
);
ok(
	'proxied: a Shift_JIS page split between its parts reads as natively',
	!!proxied.sjis &&
		JSON.stringify(proxied.sjis) === JSON.stringify(native.sjis),
	`${JSON.stringify(proxied.sjis)} natively ${JSON.stringify(native.sjis)}`,
);
ok(
	"proxied: the navigation's body sizes are the document's",
	!!proxied.sizes &&
		JSON.stringify(proxied.sizes) === JSON.stringify(native.sizes),
	`${JSON.stringify(proxied.sizes)} natively ${JSON.stringify(native.sizes)}`,
);
ok(
	'proxied: a sandboxed frame of an opaque origin loads as it comes, as natively',
	JSON.stringify(proxied.frame.end) === JSON.stringify(native.frame.end) &&
		proxied.frame.elements === native.frame.elements,
	`${JSON.stringify(proxied.frame?.end)} natively ${JSON.stringify(native.frame?.end)}`,
);
ok(
	'proxied: a frame sandboxed with nothing allowed holds its whole markup and ran none of its scripts, as natively',
	native.frame.bare !== null && proxied.frame.bare === native.frame.bare,
	`${proxied.frame.bare?.slice(0, 120)} natively ${native.frame.bare?.slice(0, 120)}`,
);
ok(
	'proxied: while the rest of a page with a 1.5 MB head is on its way, its head and first heading are in, as natively',
	!!native.bighead.mid &&
		JSON.stringify(proxied.bighead.mid) === JSON.stringify(native.bighead.mid),
	`${JSON.stringify(proxied.bighead.mid)} natively ${JSON.stringify(native.bighead.mid)}`,
);
ok(
	"proxied: the big head's scripts read its style's text, and the style applies, as natively",
	!!native.bighead.end &&
		JSON.stringify(proxied.bighead.end) === JSON.stringify(native.bighead.end),
	`${JSON.stringify(proxied.bighead.end)?.slice(0, 400)} natively ${JSON.stringify(native.bighead.end)?.slice(0, 400)}`,
);

await done(browser);
