// The helper names the rewriter and the inject rely on ($s$j and the client
// on the window, $s$L and $s$N on the location and eval stand-ins) are not
// visible to a page asking reflectively: enumeration, hasOwnProperty, Object.hasOwn,
// Reflect.has and propertyIsEnumerable all deny them; a page's own object with
// such a key still answers natively. The bare `in` operator and
// Error.prepareStackTrace being a function stay documented tells.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser);
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
await submitLanding(
	page,
	`${FIXTURE}pages/tells.html?names=${encodeURIComponent(names)}`,
);
let tells = null;
// a slow runner can take more than ten seconds to show the frame
for (let i = 0; i < 120 && !tells; i++) {
	await sleep(250);
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	tells = await frame?.evaluate(() => window.__tells).catch(() => null);
}
tells ||= {};
ok(
	'no helper name is enumerable or own on the window, document, location or eval',
	['windowNames', 'locationNames', 'evalNames', 'documentNames'].every(
		(key) => Array.isArray(tells[key]) && tells[key].length === 0,
	),
	JSON.stringify([
		tells.windowNames,
		tells.locationNames,
		tells.evalNames,
		tells.documentNames,
	]),
);
ok(
	'hasOwnProperty, Object.hasOwn, Reflect.has and propertyIsEnumerable deny the helper names',
	['windowAsks', 'locationAsks', 'evalAsks'].every(
		(key) => Array.isArray(tells[key]) && tells[key].length === 0,
	),
	JSON.stringify([tells.windowAsks, tells.locationAsks, tells.evalAsks]),
);
ok(
	"a page's own object with such a key answers natively",
	tells.plainHasOwn === true &&
		JSON.stringify(tells.plainNames) === JSON.stringify([names.split(',')[1]]),
	JSON.stringify([tells.plainHasOwn, tells.plainNames]),
);
console.log(
	'documented tells:',
	JSON.stringify({
		inOperator: tells.inOperator,
		prepareStackTrace: tells.prepare,
		functionSource: tells.functionSource,
	}),
);
await done(browser, page.errors);
