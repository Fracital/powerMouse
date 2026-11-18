// A single-page app as Discord's is (test/pages/spa-nav.html): the router's
// pushState on a link click, React's default transition indicator (a
// replacing Navigation API navigation to the current entry, intercepted
// until the transition ends) alone and under a click, a Navigation API
// navigation and a traversal the page intercepts, history.back() and
// forward(), and lazy chunks (import(), a JSONP script, a stylesheet, each
// also failing). The document stays the one that loaded through every step,
// and each step leaves the page where it leaves it natively. Both modes,
// against the page loaded natively at the top of a tab.
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
const PAGE = `${FIXTURE}pages/spa-nav.html`;
// what a step reports that depends on where the document is, not on how
// many entries the tab had before it (a native tab starts at about:blank)
const KEYS = ['result', 'path', 'state', 'view', 'entryPath'];

/** the steps the document told the console, until the last */
async function measure(page, start) {
	const steps = [];
	page.on('console', (message) => {
		const text = message.text();
		if (!text.startsWith('SPANAV ')) return;
		try {
			steps.push(JSON.parse(text.slice(7)));
		} catch (error) {
			steps.push(['unparsed', text]);
		}
	});
	await start();
	for (let i = 0; i < 160 && !steps.some(([step]) => step === 'end'); i++)
		await sleep(250);
	return steps;
}

const nativePage = await browser.newPage();
const native = await measure(nativePage, () => nativePage.goto(PAGE));
await nativePage.close();
ok(
	'natively: the steps ran to their end in one document',
	native.some(([step]) => step === 'end') &&
		native.filter(([step]) => step === 'boot').length === 1,
	JSON.stringify(native).slice(0, 2000),
);
const nativeSteps = new Map(native);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const proxied = await measure(page, () => submitLanding(page, PAGE));
	const boots = proxied.filter(([step]) => step === 'boot');
	ok(
		`${mode}: no step loaded the document again`,
		boots.length === 1 && boots[0][1].loads === 1,
		JSON.stringify(boots),
	);
	ok(
		`${mode}: the steps ran to their end, as natively`,
		JSON.stringify(proxied.map(([step]) => step)) ===
			JSON.stringify(native.map(([step]) => step)),
		`native ${JSON.stringify(native.map(([step]) => step))} proxied ${JSON.stringify(proxied.map(([step]) => step))}`,
	);
	const proxiedSteps = new Map(proxied);
	for (const [step, value] of nativeSteps) {
		if (step === 'boot' || step === 'end') continue;
		const want = JSON.stringify(KEYS.map((key) => value?.[key]));
		const got = JSON.stringify(
			KEYS.map((key) => proxiedSteps.get(step)?.[key]),
		);
		ok(
			`${mode}: ${step} as natively`,
			want === got,
			`native ${want} proxied ${got}`,
		);
	}
	ok(
		`${mode}: the page never unloaded`,
		proxiedSteps.get('end')?.unload === null,
		JSON.stringify(proxiedSteps.get('end')),
	);
	await page.close();
}

await done(browser);
