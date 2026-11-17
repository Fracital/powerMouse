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
// test/pages/access-tamper-iterators.html replaces the natives of the
// iteration protocol, as a polyfill does (`Array.prototype[Symbol.iterator]`,
// `%ArrayIteratorPrototype%.next`, the String, Map and Set iterators,
// `%IteratorPrototype%[Symbol.iterator]` and the generators' `next`, one
// group per load and all of them at once), with functions that count their
// calls, and then does what pages do; each answer and each count must be the
// one the same page gets natively, in both modes, as a top, in a
// same-origin child frame and in a sandboxed one (which evaluates a rewriter
// of its own after the page ran), whose parent replaces the same natives and
// whose own child must call none of them either. A count the inject's own
// loops, spreads, destructuring and collections added would be a call the
// page could have answered otherwise.
//
// The String and Array methods the inject calls are its own too
// (scripts/ownMethods.mjs): `?case=includes` replaces
// `Array.prototype.includes` (with it the page once read its real
// location), `stringMethods` and `arrayMethods` replace a dozen of each with
// methods that answer what they never would.
//
// What this does not cover: the natives the rest of the inject calls (the
// collections' methods, a RegExp's own Symbol.replace and Symbol.split).
import {
	done,
	FIXTURE,
	HOST,
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
	'includes',
	'stringMethods',
	'arrayMethods',
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

const ITERATOR_CASES = [
	'none',
	'arrayIterator',
	'arrayIteratorNext',
	'stringIterator',
	'mapIterator',
	'setIterator',
	'iteratorPrototype',
	'all',
];
// (a sandboxed child evaluates a rewriter of its own once the page replaced
// the natives: a few cases of it)
const SANDBOX_CASES = ['none', 'arrayIterator', 'all'];
const iteratorRuns = ITERATOR_CASES.flatMap((which) =>
	['top', 'frame', ...(SANDBOX_CASES.includes(which) ? ['sandbox'] : [])].map(
		(where) => ({
			which,
			where,
			name: `iterators ${which}${where === 'top' ? '' : ` [${where}]`}`,
			address:
				`${FIXTURE}pages/access-tamper-iterators.html?case=${which}` +
				(where === 'top' ? '' : `&in=${where}`),
		}),
	),
);
// Differences known, of none of the natives (each still has to differ, so
// a fix shows here): a sandboxed page's XMLHttpRequest that CORS refuses is
// a network error the worker answers, and its resource timing entry names a
// fetch (the inject knows an XMLHttpRequest's entry by a Server-Timing
// metric of the answer, src/inject/modules/ResourceTiming.ts XHR_MARKER,
// and an error has none)
const LISTED = { sandbox: ['resources'] };
// (each run says on the console when it is done: polling the page's realm
// meanwhile would run the driver's own loops through the page's replacements)
const announced = (page, { which, where }) =>
	page.waitForEvent('console', {
		predicate: (message) =>
			message.text() === `access tamper iterators done ${which} ${where}`,
		timeout: 40000,
	});
const iteratorReady = ({ which, where }) =>
	`window.__tamper?.done === true && window.__tamper.case === '${which}' && window.__tamper.in === '${where}' && document.title === 'access tamper iterators'`;

const browser = await launch();
const natives = {};
for (const { which, address } of runs) {
	const page = await browser.newPage();
	await page.goto(address);
	await page.waitForFunction(() => window.__tamper?.done === true);
	natives[which] = await page.evaluate(() => window.__tamper);
	await page.close();
}
for (const run of iteratorRuns) {
	const page = await browser.newPage();
	const ended = announced(page, run);
	await page.goto(run.address);
	await ended;
	natives[run.name] = await page.evaluate(() => window.__tamper);
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
// the iterator cases, in both modes
const errors = [...tab.errors];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const iteratorTab = await openDemo(browser, base);
	for (const [index, run] of iteratorRuns.entries()) {
		const ended = announced(iteratorTab, run);
		await (index === 0 ? submitLanding : submitOmni)(iteratorTab, run.address);
		await ended;
		const frame = await waitActive(iteratorTab, iteratorReady(run));
		const proxied = await frame.evaluate(() => window.__tamper);
		const native = natives[run.name];
		for (const name of Object.keys(native)) {
			if (name === 'done' || name === 'case' || name === 'in') continue;
			if (LISTED[run.where]?.includes(name)) {
				ok(
					`${mode}: ${run.name}: ${name} differs as listed`,
					proxied[name] !== native[name],
					`natively ${native[name]}, proxied ${proxied[name]}`,
				);
				continue;
			}
			ok(
				`${mode}: ${run.name}: ${name} as natively`,
				proxied[name] === native[name],
				proxied[name] === native[name]
					? native[name]
					: `natively ${native[name]}, proxied ${proxied[name]}`,
			);
		}
	}
	errors.push(...iteratorTab.errors);
	await iteratorTab.close();
}
// (natively the page replaced what it names: its own loops count)
ok(
	'natively, the replacements count the page own iteration',
	natives['iterators all'].ownLoop === '13' &&
		/array=\d/.test(natives['iterators all']['ownLoop [calls]']) &&
		natives['iterators none']['ownLoop [calls]'] === 'none',
	natives['iterators all']['ownLoop [calls]'],
);
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
await done(browser, errors);
