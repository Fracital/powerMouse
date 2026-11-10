// The proxy's own artifacts are not there for a page to find, compared with
// the page loaded natively, in both demo modes (test/pages/tells.html):
// - the helper names the rewriter and the inject rely on ($s$j and the client
//   on the window, $s$L and $s$N on the location and eval stand-ins, or a
//   deployment's own): enumeration, hasOwnProperty, Object.hasOwn,
//   Reflect.has, propertyIsEnumerable, getOwnPropertyDescriptor(s),
//   Object.keys and entries, for...in and the `in` operator (a computed key,
//   a literal, a template, a key that converts to the name) deny them; a
//   page's own object with such a key still answers natively;
// - Error.prepareStackTrace is undefined on Error and on what inherits from
//   it, by every reflective question, while stacks stay clean of routes; a
//   formatter the page sets runs, reads back as itself and deletes as an own
//   property does, and deleting the proxy's changes nothing;
// - getInstalledRelatedApps() answers as a top-level page's (a frame's
//   rejects, and the host shows every proxied page in one).
// A read of the access API by its name is recorded, not compared.
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
		'no helper name is enumerable or own on the window, document, location or eval',
		['windowNames', 'locationNames', 'evalNames', 'documentNames'],
	],
	[
		'hasOwnProperty, Object.hasOwn, Reflect.has and propertyIsEnumerable deny the helper names',
		['windowAsks', 'locationAsks', 'evalAsks'],
	],
	[
		'the in operator finds no helper name, by a computed key, a literal, a template or a key that converts to it',
		[
			'inOperator',
			'inOthers',
			'inLiteral',
			'inTemplate',
			'inConverted',
			'inPlain',
			'inNative',
			'inPrimitive',
		],
	],
	[
		'Object.keys, Object.entries, for...in and the descriptors of the window show no helper name',
		['windowKeys', 'windowForIn', 'windowEntries', 'windowDescriptors'],
	],
	[
		"a page's own object with such a key answers natively",
		['plainHasOwn', 'plainAsks', 'plainNames'],
	],
	[
		'Error.prepareStackTrace is undefined, on Error and what inherits from it, by every reflective question',
		[
			'prepare',
			'prepareInherited',
			'prepareIn',
			'prepareOwn',
			'errorKeys',
			'errorNames',
			'errorIdentity',
		],
	],
	[
		'stacks name the page, never a route, deleting the formatter or not',
		['stackDefault', 'stackThrown', 'stackSubclass', 'deleteDefault'],
	],
	[
		"a page's own formatter runs, reads back as itself and deletes as an own property",
		['pageFormatter'],
	],
	[
		'the page runs rewritten: its functions read as written, the real URL, itself as top',
		['functionSource', 'rewritten'],
	],
	[
		"getInstalledRelatedApps() answers as a top-level page's, not a frame's",
		['relatedApps'],
	],
];

const browser = await launch();
const errors = [];

/** the page's record, from the newest frame that has one */
async function collect(find) {
	// a slow runner can take more than ten seconds to show the frame
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		const tells = await (
			await find()
		)
			?.evaluate(() => window.__tells)
			.catch(() => null);
		if (tells) return tells;
	}
	return {};
}

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	// the names this controller uses (it mints the client's), so the page
	// checks the real ones
	const names = await page.evaluate(() => {
		const { access, client, globalProxy, globalName } = {
			access: '$s$j',
			globalProxy: '$s$L',
			globalName: '$s$N',
			...window.controller.config.names,
		};
		return [access, client, globalProxy, globalName].join(',');
	});
	const target = `${FIXTURE}pages/tells.html?names=${encodeURIComponent(names)}`;

	const nativePage = await browser.newPage();
	nativePage.on('pageerror', (error) =>
		errors.push(`native: ${error.message}`),
	);
	await nativePage.goto(target);
	const native = await collect(async () => nativePage.mainFrame());
	await nativePage.close();

	await submitLanding(page, target);
	const tells = await collect(async () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url())),
	);
	for (const [label, keys] of GROUPS) {
		const pick = (record) =>
			JSON.stringify(Object.fromEntries(keys.map((key) => [key, record[key]])));
		const wrong = keys.filter(
			(key) => JSON.stringify(tells[key]) !== JSON.stringify(native[key]),
		);
		ok(
			`${mode}: ${label}`,
			keys.every((key) => key in native) && wrong.length === 0,
			wrong.length
				? wrong
						.map(
							(key) =>
								`${key}: ${JSON.stringify(native[key])} -> ${JSON.stringify(tells[key])}`,
						)
						.join('; ')
						.slice(0, 1500)
				: pick(tells).slice(0, 300),
		);
	}
	console.log(
		`${mode}: recorded, not compared:`,
		JSON.stringify({
			reads: [native.reads, tells.reads],
			readStatic: [native.readStatic, tells.readStatic],
		}),
	);
	errors.push(...page.errors.map((error) => `${mode}: ${error}`));
	await page.close();
}
await done(browser, errors);
