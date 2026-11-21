// The Navigation API across two sites answers as natively
// (test/pages/navigation-api.html): a navigation to the other site cannot
// be intercepted (canIntercept false, intercept() and a precommit
// handler's redirect throw the browser's SecurityError), entries(),
// currentEntry, canGoBack and traverseTo() know only the run of this
// site's entries around the document, a traversal into the other site's
// entry is never heard of, and pageswap shows no activation for a
// navigation to the other site. Every proxied site is the proxy origin to
// the browser, so each of them saw the other site's entries and could
// commit its URL in this document. The default mode's two (same-origin and
// isolated) and dialing, against the pages loaded natively at the top of a
// tab.
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
const PAGE = `${FIXTURE}pages/navigation-api.html?s=1`;

/** what the documents told the console, step by step, until the last */
async function measure(page, start) {
	const steps = [];
	page.on('console', (message) => {
		const text = message.text();
		if (!text.startsWith('NAVAPI ')) return;
		try {
			steps.push(JSON.parse(text.slice(7)));
		} catch (error) {
			steps.push(['unparsed', text]);
		}
	});
	await start();
	for (let i = 0; i < 120 && !steps.some(([step]) => step === 'end'); i++)
		await sleep(250);
	return steps;
}

const nativePage = await browser.newPage();
const native = await measure(nativePage, () => nativePage.goto(PAGE));
await nativePage.close();
ok(
	'natively: the walk ran to its end',
	native.some(([step]) => step === 'end'),
	JSON.stringify(native).slice(0, 2000),
);
const nativeSteps = new Map(native);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
	// dialing: the documents' Navigation API is the inject's, over the
	// history the host keeps (src/inject/dom/calledNavigation.ts)
	['dial', `${PROXY}?nopool&mode=just-call-stomp`],
	// and on the content slots where the run has them (test/run.mjs
	// STOMP_SLOT_PORTS): the documents of another origin than the host's
	...(process.env.CONTENT_SLOT_PORTS
		? [['dial on slots', `${PROXY}?mode=just-call-stomp`]]
		: []),
]) {
	const page = await openDemo(browser, base);
	const proxied = await measure(page, () => submitLanding(page, PAGE));
	const proxiedSteps = new Map(proxied);
	ok(
		`${mode}: the documents told of the same steps`,
		JSON.stringify(proxied.map(([step]) => step)) ===
			JSON.stringify(native.map(([step]) => step)),
		`native ${JSON.stringify(native.map(([step]) => step))} proxied ${JSON.stringify(proxied.map(([step]) => step))}`,
	);
	for (const [step, value] of nativeSteps) {
		if (value === null || typeof value !== 'object') continue;
		for (const key of Object.keys(value)) {
			const want = JSON.stringify(value[key]);
			const got = JSON.stringify(proxiedSteps.get(step)?.[key]);
			ok(
				`${mode}: ${step} ${key} as natively`,
				want === got,
				`native ${want} proxied ${got}`,
			);
		}
	}
	await page.close();
}

await done(browser);
