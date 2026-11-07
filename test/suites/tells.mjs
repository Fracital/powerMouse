// The helper names the rewriter and the inject rely on ($s$j and $P$s on the
// window, $s$L and $s$N on the location and eval stand-ins) are not visible to
// a page asking reflectively: enumeration, hasOwnProperty, Object.hasOwn,
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
await submitLanding(page, `${FIXTURE}pages/tells.html`);
let tells = null;
for (let i = 0; i < 40 && !tells; i++) {
	await sleep(250);
	const frame = page.frames().findLast((f) => f.url().includes('/stomp/html/'));
	tells = await frame.evaluate(() => window.__tells).catch(() => null);
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
		JSON.stringify(tells.plainNames) === JSON.stringify(['$P$s']),
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
