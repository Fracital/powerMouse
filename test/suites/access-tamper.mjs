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
// What this does not cover: the natives the rest of the inject calls. A
// page that replaces `Array.prototype.includes` (`?case=includes`, which the
// fixture knows and this suite does not run) or a collection's `has` still
// reads its real location or another site's window: open.
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
const url = (which) => `${FIXTURE}pages/access-tamper.html?case=${which}`;

const browser = await launch();
const natives = {};
for (const which of CASES) {
	const page = await browser.newPage();
	await page.goto(url(which));
	await page.waitForFunction(() => window.__tamper?.done === true);
	natives[which] = await page.evaluate(() => window.__tamper);
	await page.close();
}

const tab = await openDemo(browser, PROXY);
for (const [index, which] of CASES.entries()) {
	await (index === 0 ? submitLanding : submitOmni)(tab, url(which));
	const frame = await waitActive(
		tab,
		`window.__tamper?.done === true && window.__tamper.case === '${which}'`,
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
await done(browser, tab.errors);
