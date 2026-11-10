// Nothing the proxy keeps on a page's window leads that page to another
// site's window. Every proxied site shares the proxy's real origin, so a
// handle the inject holds (the client's `parent`, a native evaluator whose
// code reads the unforgeable `top`) reaches any other proxied window as is.
// The client lives under a name the controller mints, which no page is told;
// a page that learns it anyway (a frame of its own site shows it in its
// shell while it loads) reads nothing by it, however it names it (computed,
// reflected, destructured, in code it makes at run time), and the access API
// hands out no native evaluator. A document of another site
// (helper-seal-child.html) framed by helper-seal.html hunts for its parent's
// secret every one of those ways, in both demo modes, with and without the
// parent reading the frame's contentWindow before the child arrives (which
// puts the parent's client in the frame's initial about:blank).
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

/** the child's report, from any frame of the context */
async function collect(context) {
	for (let i = 0; i < 120; i++) {
		await sleep(250);
		for (const page of context.pages())
			for (const frame of page.frames()) {
				const value = await frame
					?.evaluate(() => window.__seal)
					.catch(() => null);
				if (value?.done) return value;
			}
	}
	return null;
}

// every way the child reads the client by the name it learned
const LEARNED = [
	'learnedBracket',
	'learnedReflect',
	'learnedDescriptor',
	'learnedDestructure',
	'learnedParameter',
	'learnedWith',
	'learnedIndirectEval',
	'learnedFunction',
	'learnedMember',
	'learnedScript',
];

const browser = await launch();
const errors = [];
const clientNames = [];
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const early of [false, true]) {
		const label = `${mode}${early ? ', parent read the frame early' : ''}`;
		const page = await openDemo(browser, base);
		clientNames.push(
			await page.evaluate(() => window.controller.config.names?.client),
		);
		await submitLanding(
			page,
			`${FIXTURE}pages/helper-seal.html${early ? '?early' : ''}`,
		);
		const report = await collect(page.context());
		ok(`${label}: the child reports`, !!report, '');
		const paths = report?.paths ?? {};
		const detail = JSON.stringify(paths);
		ok(
			`${label}: the access API is named in the page's rewritten source`,
			paths.accessNamed === 'true',
			detail,
		);
		ok(
			`${label}: no client by the old default name`,
			paths.defaultClient === 'TypeError,TypeError,TypeError,TypeError',
			detail,
		);
		ok(
			`${label}: no own key of the window leads to the parent`,
			paths.scanClient === 'none',
			detail,
		);
		ok(
			`${label}: no access API function runs code that reaches the parent`,
			paths.accessFunctions === 'none',
			detail,
		);
		ok(
			`${label}: the access API's objects are of the child's realm`,
			paths.accessRealm === 'undefined' &&
				paths.accessFunctionRealm === 'undefined',
			detail,
		);
		ok(
			`${label}: the page's own eval and Function reach nothing`,
			['eval', 'indirectEval', 'Function'].every(
				(key) => !String(paths[key]).includes('SEAL-SECRET'),
			),
			detail,
		);
		ok(
			`${label}: the page learns the client's name from a loading frame of its site`,
			paths.learnedName === 'true',
			detail,
		);
		// by the name it learned, the page reads nothing: undefined, or the
		// TypeError a destructuring proxy's invariant throws (the client is a
		// non-configurable property, so the proxy cannot answer undefined)
		for (const path of LEARNED)
			ok(
				`${label}: ${path} by the learned name reaches nothing`,
				paths[path] === 'nothing' || paths[path] === 'threw TypeError',
				detail,
			);
		ok(
			`${label}: a fresh about:blank frame reached by a literal name runs no code that reaches the parent`,
			!String(paths.blankEval).includes('SEAL-SECRET'),
			detail,
		);
		errors.push(...page.errors);
		await page.context().close();
	}
}
ok(
	'each controller minted its own client name, never the old default',
	clientNames.every(
		(name) => typeof name === 'string' && name !== '$P$s' && name.length >= 12,
	) && new Set(clientNames).size === clientNames.length,
	JSON.stringify(clientNames),
);
await done(browser, errors);
