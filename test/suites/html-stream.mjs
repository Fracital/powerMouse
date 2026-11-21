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
//   and the style applies;
// - a frame of the first case that is not displayed (it draws no frames:
//   the page's first writes wait for one, or for a timer) loads whole;
// - a head that is still coming (YouTube's is 800 KB, one inline script)
//   is in the page as it comes: the document is committed and the head's
//   first script ran before the rest of the head arrives (the worker held
//   the page until the body began), and a meta CSP with Trusted Types later
//   in the head refuses what it refuses natively;
// - a head whose inline script trickles in (YouTube's 780 KB) is in, and
//   the body's first heading after it, while the rest is on its way (the
//   worker cut the markup only once twice as much had come as when it
//   last found the script unfinished, which passed the document's end),
//   and so is one whose script's end tag comes in two pieces (the worker
//   looks for it in what came last and the end of what came before);
// - a piece that ends the markup so far is in the page as soon as it comes
//   (a lone heading, one in a div, the text after the last tag, a void
//   element after a heading), and the page loads whole: the client held
//   back the last element or text of what came, which the parser could
//   still add to, until more markup followed it.
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
// the page once it is whole and loaded (its last script sets __done while
// the parser is still on it, so readyState is read once it says complete: a
// read at the poll's moment raced the load, either way round)
const whole = () =>
	window.__done && document.readyState === 'complete'
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

async function hiddenCase(proxied) {
	const { page, find } = await open(
		`${FIXTURE}stream/hidden?wait=1500`,
		proxied,
	);
	try {
		const inner = () =>
			page.frames().filter((f) => f.parentFrame() === find())[0];
		const end = await poll(inner, whole, undefined, 400, 50);
		const frame = inner();
		const elements = frame
			? await evaluateIsolated(frame, shape).catch(() => null)
			: null;
		return { end, elements };
	} finally {
		await page.close();
	}
}

async function slowheadCase(proxied) {
	const { page, find } = await open(
		`${FIXTURE}stream/slowhead?wait=${WAIT}`,
		proxied,
	);
	try {
		const mid = await poll(
			find,
			() =>
				window.__order
					? {
							order: window.__order.join(),
							readyState: document.readyState,
							body: !!document.body,
						}
					: null,
			undefined,
			400,
			25,
		);
		const end = await poll(find, whole, undefined, 400, 50);
		return { mid, end };
	} finally {
		await page.close();
	}
}

// midway for the trickle page: its first heading and the script after it
// come in one chunk, which a loaded parser may still split, so the read waits
// for that script (`late` says whether it ran only once the rest came)
const trickleMidway = () =>
	document.getElementById('early') && window.__order?.includes('a')
		? {
				late: !!document.getElementById('late'),
				w1: !!document.getElementById('w1'),
				readyState: document.readyState,
				order: window.__order?.join() ?? null,
			}
		: null;

async function trickleCase(proxied, split = false) {
	const { page, find } = await open(
		`${FIXTURE}stream/trickle?wait=${WAIT}${split ? '&split' : ''}`,
		proxied,
	);
	try {
		const mid = await poll(find, trickleMidway, undefined, 400, 25);
		const end = await poll(find, whole, undefined, 400, 50);
		return { mid, end };
	} finally {
		await page.close();
	}
}

// the lone page once the piece is in (`arg`: the id that says so, with text
// for any but an image)
const loneMidway = (id) => {
	const mark = document.getElementById(id);
	if (!mark || (mark.localName !== 'img' && !mark.textContent)) return null;
	return {
		early: document.getElementById('early')?.textContent ?? null,
		pic: !!document.getElementById('pic'),
		late: !!document.getElementById('late'),
		readyState: document.readyState,
	};
};

async function loneCase(proxied, piece) {
	const { page, find } = await open(
		`${FIXTURE}stream/lone?wait=${WAIT}&piece=${piece}`,
		proxied,
	);
	try {
		const mid = await poll(
			find,
			loneMidway,
			piece === 'void' ? 'pic' : 'early',
			400,
			25,
		);
		await poll(
			find,
			() =>
				document.readyState === 'complete' && document.getElementById('late')
					? true
					: null,
			undefined,
			400,
			50,
		);
		const frame = find();
		const end = frame
			? await evaluateIsolated(frame, () => ({
					text: document.body.textContent,
					elements: [...document.body.getElementsByTagName('*')]
						.map((e) => e.localName + (e.id ? `#${e.id}` : ''))
						.join(),
				})).catch(() => null)
			: null;
		return { mid, end };
	} finally {
		await page.close();
	}
}
const LONE = ['element', 'nested', 'text', 'void'];

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
	hidden: await hiddenCase(false),
	slowhead: await slowheadCase(false),
	trickle: await trickleCase(false),
	split: await trickleCase(false, true),
	lone: {},
};
for (const piece of LONE) native.lone[piece] = await loneCase(false, piece);
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
	hidden: await hiddenCase(true),
	slowhead: await slowheadCase(true),
	trickle: await trickleCase(true),
	split: await trickleCase(true, true),
	lone: {},
};
for (const piece of LONE) proxied.lone[piece] = await loneCase(true, piece);
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
ok(
	'proxied: a frame that is not displayed loads whole, as natively',
	!!native.hidden.end &&
		JSON.stringify(proxied.hidden.end) === JSON.stringify(native.hidden.end) &&
		proxied.hidden.elements === native.hidden.elements,
	`${JSON.stringify(proxied.hidden.end)} natively ${JSON.stringify(native.hidden.end)}`,
);

ok(
	"proxied: while the rest of the head is on its way, the document is committed and the head's first script ran, as natively",
	native.slowhead.mid?.body === false &&
		JSON.stringify(proxied.slowhead.mid) ===
			JSON.stringify(native.slowhead.mid),
	`${JSON.stringify(proxied.slowhead.mid)} natively ${JSON.stringify(native.slowhead.mid)}`,
);
ok(
	"proxied: the rest of the head's meta CSP and Trusted Types refuse what they refuse natively",
	!!native.slowhead.end &&
		JSON.stringify(proxied.slowhead.end) ===
			JSON.stringify(native.slowhead.end),
	`${JSON.stringify(proxied.slowhead.end)} natively ${JSON.stringify(native.slowhead.end)}`,
);
ok(
	'proxied: while the rest of a page whose head script trickled in is on its way, the script ran and the first heading is in, as natively',
	native.trickle.mid?.late === false &&
		JSON.stringify(proxied.trickle.mid) === JSON.stringify(native.trickle.mid),
	`${JSON.stringify(proxied.trickle.mid)} natively ${JSON.stringify(native.trickle.mid)}`,
);
ok(
	'proxied: the page whose head script trickled in loads whole, as natively',
	!!native.trickle.end &&
		JSON.stringify(proxied.trickle.end) === JSON.stringify(native.trickle.end),
	`${JSON.stringify(proxied.trickle.end)} natively ${JSON.stringify(native.trickle.end)}`,
);
ok(
	"proxied: while the rest of a page whose head script's end tag came in two pieces is on its way, the script ran and the first heading is in, as natively",
	native.split.mid?.late === false &&
		JSON.stringify(proxied.split.mid) === JSON.stringify(native.split.mid),
	`${JSON.stringify(proxied.split.mid)} natively ${JSON.stringify(native.split.mid)}`,
);
ok(
	"proxied: the page whose head script's end tag came in two pieces loads whole, as natively",
	!!native.split.end &&
		JSON.stringify(proxied.split.end) === JSON.stringify(native.split.end),
	`${JSON.stringify(proxied.split.end)} natively ${JSON.stringify(native.split.end)}`,
);

for (const piece of LONE) {
	const mine = proxied.lone[piece];
	const theirs = native.lone[piece];
	ok(
		`proxied: a piece that ends the markup so far (${piece}) is in the page before the rest comes, as natively`,
		theirs.mid?.late === false &&
			JSON.stringify(mine.mid) === JSON.stringify(theirs.mid),
		`${JSON.stringify(mine.mid)} natively ${JSON.stringify(theirs.mid)}`,
	);
	ok(
		`proxied: the page whose piece ended the markup so far (${piece}) loads whole, as natively`,
		!!theirs.end && JSON.stringify(mine.end) === JSON.stringify(theirs.end),
		`${JSON.stringify(mine.end)} natively ${JSON.stringify(theirs.end)}`,
	);
}

await done(browser);
