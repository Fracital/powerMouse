// What a page reads of the objects the proxy replaces matches the page
// loaded natively, in both demo modes (test/pages/native-shapes.html):
// - an inline style attribute with a URL reads as the page wrote it, by
//   getAttribute, attributes, its attribute node, outerHTML and cssText;
// - every member of the Location object has the native descriptor, and its
//   functions the native name, length and source;
// - every constructor on the window and a worker's global has the native
//   own properties (statics, prototype attributes, name, length), parent,
//   prototype chain and prototype.constructor; a named constructor (Audio,
//   Image, Option) shares its element's prototype without being its
//   constructor;
// - the Cookie Store API is there as natively, reads and writes the jar
//   document.cookie does, fails as natively and reports its changes.
// Recorded, not compared: whether the cookie change events are trusted,
// whether document.cookie shows a cookieStore.set() before it settles (a race
// natively), and the members of the replaced prototypes.
// SHAPES_DUMP=<path prefix> writes both records of each mode to
// <prefix>-<mode>.json.
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

const GROUPS = [
	[
		'an inline style attribute with a URL reads as written, every way',
		[
			'styleParsed',
			'styleParsedQuoted',
			'styleSetAttribute',
			'styleCssText',
			'styleNamed',
			'styleSetProperty',
			'styleNode',
			'styleInnerHTML',
			'styleMixed',
			'styleMixedParsed',
			'styleRemoved',
			'styleCloned',
		],
	],
	[
		"the Location object's members have the native descriptors, names, lengths and sources",
		[
			'locationOwn',
			'locationPrototype',
			'locationIdentity',
			'locationCalls',
			'locationFunctions',
		],
	],
	[
		'Audio, Image and Option share their element prototype, whose constructor is the element',
		['namedConstructors'],
	],
	[
		"an instance's constructor is the global, a subclass inherits the statics",
		['instances', 'subclass', 'illegal'],
	],
	[
		"a function's kinds have the native constructors, as Function has",
		['hiddenConstructors'],
	],
	[
		'cookieStore is there as natively, reads, writes, fails and reports changes as natively, with document.cookie',
		['cookieStore'],
	],
];

// interfaces the proxy takes away on purpose: the service worker API (the
// Navigator module). FedCM's interfaces are now kept and stood in for (the
// Credentials module), so they are compared like any other.
const ABSENT = new Set(['ServiceWorkerContainer', 'ServiceWorkerRegistration']);
const present = (map = {}) =>
	Object.fromEntries(Object.entries(map).filter(([name]) => !ABSENT.has(name)));

const browser = await launch();
const errors = [];

/** the page's record, from the newest frame that has one */
async function collect(find) {
	// a slow runner can take more than ten seconds to show the frame
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		const record = await (
			await find()
		)
			?.evaluate(() =>
				window.__shapesRecord ? JSON.stringify(window.__shapesRecord) : null,
			)
			.catch(() => null);
		if (record) return JSON.parse(record);
	}
	return {};
}

const show = (value) => JSON.stringify(value) ?? 'undefined';
/** where two values differ: each path with both values */
function paths(a, b, path, out) {
	if (show(a) === show(b)) return out;
	if (
		a &&
		b &&
		typeof a === 'object' &&
		typeof b === 'object' &&
		Array.isArray(a) === Array.isArray(b)
	) {
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
			paths(a[key], b[key], `${path}.${key}`, out);
		return out;
	}
	out.push(`${path}: ${show(a)?.slice(0, 300)} -> ${show(b)?.slice(0, 300)}`);
	return out;
}
/** the keys of two records that differ, path by path */
const differences = (native, proxied, keys) =>
	keys.flatMap((key) => paths(native[key], proxied[key], key, []));
/** the named entries of two maps that differ, path by path */
const entryDifferences = (native, proxied) =>
	paths(present(native), present(proxied), '', []);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const target = `${FIXTURE}pages/native-shapes.html`;

	const nativePage = await browser.newPage();
	nativePage.on('pageerror', (error) =>
		errors.push(`native: ${error.message}`),
	);
	await nativePage.goto(target);
	const native = await collect(async () => nativePage.mainFrame());
	await nativePage.close();

	await submitLanding(page, target);
	const proxied = await collect(async () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	if (process.env.SHAPES_DUMP)
		(await import('node:fs')).writeFileSync(
			`${process.env.SHAPES_DUMP}-${mode}.json`,
			JSON.stringify({ native, proxied }),
		);
	for (const [label, keys] of GROUPS) {
		const wrong = differences(native, proxied, keys);
		ok(
			`${mode}: ${label}`,
			keys.every((key) => key in native) && wrong.length === 0,
			wrong.join('; ').slice(0, 3000),
		);
	}
	for (const [label, pick] of [
		['window', (record) => record.constructors],
		['worker', (record) => record.worker?.constructors],
	]) {
		const wrong = entryDifferences(pick(native), pick(proxied));
		ok(
			`${mode}: every constructor on the ${label} has the native own properties, parent, chain and prototype.constructor`,
			Object.keys(pick(native) ?? {}).length > 50 && wrong.length === 0,
			wrong.join('; ').slice(0, 4000),
		);
	}
	// the proxy dispatches the Cookie Store API's change events itself, and
	// an event a script dispatches is never trusted
	console.log(
		`${mode}: cookie change events trusted, recorded, not compared:`,
		JSON.stringify([native.cookieTrusted, proxied.cookieTrusted]),
	);
	// natively a race (test/pages/native-shapes.html, 'set and read at once')
	console.log(
		`${mode}: a cookieStore.set() seen by document.cookie before it settles, recorded, not compared:`,
		JSON.stringify([native.cookieSetSeenAtOnce, proxied.cookieSetSeenAtOnce]),
	);
	for (const [label, pick] of [
		['window', (record) => record.prototypes],
		['worker', (record) => record.worker?.prototypes],
	]) {
		const wrong = entryDifferences(pick(native), pick(proxied));
		console.log(
			`${mode}: ${label} prototypes, recorded, not compared: ${wrong.join('; ').slice(0, 4000)}`,
		);
	}
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}
await done(browser, errors);
