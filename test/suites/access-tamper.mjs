// A page that replaces a native gains nothing by it. The access helpers
// decide what a page reads of its `location`, its `top` and its `eval`, and
// whether an element it assigns by index lands through the hooks; a helper
// that asked one of the page's own natives on the way (`Array.isArray`,
// `Number.isInteger`, a RegExp's `test` or `exec`, `Proxy`) would decide
// what the page told it to, and hand out the real location or the real top. test/pages/access-tamper.html
// replaces one native per load (`?case=`) and then reads each of those every
// way the helpers serve; every answer must be the one the same page gives
// natively (where replacing the native changes nothing of the kind).
//
// test/pages/access-tamper-frame.html does the same for the collections
// the inject keeps windows in (`WeakSet.prototype.has`,
// `WeakMap.prototype.get`), and then reads a frame of another site, which
// it must be refused as natively: by index, and as the page keeps the
// frame's window in its own objects, arrays and arguments and reads it
// back by a computed key (the helpers' short ways for those receivers).
//
// What this does not cover: the natives the rest of the inject calls. A
// page that replaces `Array.prototype.includes` (`?case=includes`, which the
// fixture knows and this suite does not run) still reads its real location,
// and the inject's other collections and arrays still call the page's
// methods: open.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	submitLanding,
	submitOmni,
	waitActive,
} from '../lib.mjs';

const CASES = [
	'none',
	'isArrayFalse',
	'isArrayTrue',
	'isInteger',
	'regexpTest',
	'regexpExec',
	'proxy',
];
const FRAME_CASES = ['none', 'weakSetHas', 'weakMapGet'];
const url = (which) => `${FIXTURE}pages/access-tamper.html?case=${which}`;
const frameURL = (which) =>
	`${FIXTURE}pages/access-tamper-frame.html?case=${which}`;
const runs = [
	...CASES.map((which) => ({ which, address: url(which) })),
	...FRAME_CASES.map((which) => ({
		which: `frame-${which}`,
		address: frameURL(which),
	})),
];

const browser = await launch();
const natives = {};
for (const { which, address } of runs) {
	const page = await browser.newPage();
	await page.goto(address);
	await page.waitForFunction(() => window.__tamper?.done === true);
	natives[which] = await page.evaluate(() => window.__tamper);
	await page.close();
}

const tab = await openDemo(browser, PROXY);
for (const [index, { which, address }] of runs.entries()) {
	const own = new URL(address).searchParams.get('case');
	await (index === 0 ? submitLanding : submitOmni)(tab, address);
	const frame = await waitActive(
		tab,
		`window.__tamper?.done === true && window.__tamper.case === '${own}' && document.title === ${JSON.stringify(
			index < CASES.length ? 'access tamper' : 'access tamper frame',
		)}`,
	);
	const proxied = await frame.evaluate(() => window.__tamper);
	const native = natives[which];
	for (const name of Object.keys(native)) {
		if (name === 'done' || name === 'case') continue;
		ok(
			`${which}: ${name} as natively`,
			proxied[name] === native[name],
			proxied[name] === native[name]
				? native[name]
				: `natively ${native[name]}, proxied ${proxied[name]}`,
		);
	}
}
// (natively the page is the top and its location is the fixture's)
ok(
	'natively, the page reads its own location and is its own top',
	natives.none.location === url('none') && natives.none.topIsWindow === 'true',
	natives.none.location,
);
// (natively a frame of another site is refused)
ok(
	'natively, the frame of another site is refused',
	natives['frame-none'].indexDocument === 'threw SecurityError' &&
		natives['frame-none'].contentDocument === 'null',
	JSON.stringify(natives['frame-none']),
);
// (natively, so is its window read back out of the page's own objects)
for (const name of [
	'objectKey',
	'objectKeyAgain',
	'arrayIndex',
	'argumentsIndex',
	'nested',
	'compound',
	'compoundAnswer',
	'forIn',
	'method',
	'written',
])
	ok(
		`natively, ${name} is refused`,
		natives['frame-none'][name] === 'threw SecurityError',
		natives['frame-none'][name],
	);
await done(browser, tab.errors);
