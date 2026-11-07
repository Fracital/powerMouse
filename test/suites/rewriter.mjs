// JS shapes the rewriter must keep valid and still spoof: class fields and
// catch parameters named like unforgeables, labels, typeof, destructuring
// aliases, object shorthand, import names, bare specifiers through an import
// map, and re-exports. The fixture's /rewriter page runs one script per case
// and records a boolean for each; a case the rewriter breaks never records.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const CASES = [
	'classField',
	'catchParam',
	'classExpr',
	'label',
	'typeofTop',
	'aliasPattern',
	'shorthandPattern',
	'shorthand',
	'nestedPattern',
	'nestedAssign',
	'deepPattern',
	'paramPattern',
	'arrowParam',
	'arrowExprParam',
	'defaultParam',
	'methodParam',
	'strictParam',
	'importName',
	'bare',
	'reexport',
	'dynBare',
	'classicImportBase',
	'metaResolve',
];

const browser = await launch();
const page = await openDemo(browser);
await submitLanding(page, `${FIXTURE}rewriter`);

let frame;
let results = {};
for (let i = 0; i < 60; i++) {
	frame = page.frames().find((f) => f.url().includes('/stomp/html/'));
	try {
		results = (await frame?.evaluate(() => window.__rw)) || {};
	} catch (error) {
		results = {};
	}
	if (results.done) break;
	await sleep(500);
}
ok(
	'fixture page ran to the end',
	results.done === true,
	JSON.stringify(results),
);
for (const name of CASES)
	ok(
		`${name} runs and holds`,
		results[name] === true,
		JSON.stringify(results[name]),
	);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
