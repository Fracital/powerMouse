// A page's `<script type="importmap">` must resolve its specifiers through the
// proxy exactly as the browser resolves them natively: a bare specifier mapped
// to a module and a trailing-slash prefix mapped to a package directory,
// imported statically and dynamically. Every target is routed, so a specifier
// the page imports loads a rewritten module from the proxy and never the real
// origin. Scopes are a documented limitation: a scope key is a URL prefix the
// browser matches against the importer's URL, and a proxied module's URL is a
// codec-routed one that no real-origin prefix can match, so a scoped override
// falls back to the global mapping (asserted below so a future fix is
// noticed). Both modes, against the page loaded natively.
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

const browser = await launch();
const PAGE = `${FIXTURE}pages/importmap.html`;
// the cases that must resolve exactly as natively
const STRICT = [
	'staticBare',
	'staticPrefix',
	'staticGlobalDep',
	'dynBare',
	'dynPrefix',
];

async function measure(getFrame) {
	for (let i = 0; i < 80; i++) {
		const report = await getFrame()
			?.evaluate(() => (window.__im?.done ? window.__im : null))
			.catch(() => null);
		if (report) return report;
		await sleep(250);
	}
	return {};
}

const nativePage = await browser.newPage();
await nativePage.goto(PAGE);
const native = await measure(() => nativePage.mainFrame());
await nativePage.close();
ok(
	'natively: every import-map specifier resolves (bare, prefix, scope, static, dynamic)',
	native.staticBare === 'REACT-DEFAULT' &&
		native.staticPrefix === 'RD-CLIENT:ROOT' &&
		native.staticGlobalDep === 'DEP-GLOBAL' &&
		native.scopedDep === 'DEP-SCOPED' &&
		native.dynBare === 'REACT-DEFAULT' &&
		native.dynPrefix === 'RD-CLIENT',
	JSON.stringify(native),
);

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, PAGE);
	const proxied = await measure(() => frameOf(page));
	for (const name of STRICT)
		ok(
			`${mode}: the ${name} specifier resolves as natively`,
			proxied[name] === native[name],
			`native ${JSON.stringify(native[name])} proxied ${JSON.stringify(proxied[name])}`,
		);
	// documented limitation: the scope does not apply to a routed importer, so
	// the dependency comes from the global mapping instead of the scoped one
	ok(
		`${mode}: a scoped override falls back to the global mapping (known limitation)`,
		proxied.scopedDep === 'DEP-GLOBAL' && native.scopedDep === 'DEP-SCOPED',
		`native ${JSON.stringify(native.scopedDep)} proxied ${JSON.stringify(proxied.scopedDep)}`,
	);
	await page.close();
}

await done(browser);
