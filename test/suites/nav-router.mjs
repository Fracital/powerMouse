// A real router on the Navigation API (test/pages/nav-router.html): UI-Router
// with its Navigation API location service, which navigates with
// navigation.navigate() and intercepts its own navigations and every
// traversal. Its steps (pushes, a redirect, a replace, a slow resolve,
// navigation.back(), history.back(), navigation.forward(), traverseTo(), a
// URL sync, a fragment the router does not intercept and the Back from it)
// leave the page where they leave it natively: the URL, the router's state,
// the entries, the scroll the traversal restored, and the events the page
// heard of each. Natively at the top of a tab, then proxied in the demo's
// default mode and in its just-call-stomp mode (?mode=just-call-stomp).
import {
	done,
	FIXTURE,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';

const browser = await launch();
const PAGE = `${FIXTURE}pages/nav-router.html`;

/** the steps the document told the console, until the last */
async function measure(page, start) {
	const steps = [];
	page.on('console', (message) => {
		const text = message.text();
		if (!text.startsWith('NAVROUTER ')) return;
		try {
			steps.push(JSON.parse(text.slice(10)));
		} catch (error) {
			steps.push(['unparsed', text]);
		}
	});
	await start();
	for (let i = 0; i < 160 && !steps.some(([step]) => step === 'end'); i++)
		await sleep(250);
	return steps;
}

const nativePage = await browser.newPage({
	viewport: { width: 800, height: 600 },
});
const native = await measure(nativePage, () => nativePage.goto(PAGE));
await nativePage.close();
ok(
	'natively: the steps ran to their end',
	native.some(([step]) => step === 'end'),
	JSON.stringify(native).slice(0, 2000),
);

// (dialing on the content slots too where the run has them: test/run.mjs
// STOMP_SLOT_PORTS, so the documents are of another origin than the host's)
for (const [mode, query] of [
	['default', ''],
	['just-call-stomp', '?nopool&mode=just-call-stomp'],
	...(process.env.CONTENT_SLOT_PORTS
		? [['just-call-stomp on slots', '?mode=just-call-stomp']]
		: []),
]) {
	await waitForServer(PROXY);
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto(`${PROXY}${query}`);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: 45000 },
	);
	const proxied = await measure(page, () => submitLanding(page, PAGE));
	ok(
		`${mode}: the steps ran to their end, as natively`,
		JSON.stringify(proxied.map(([step]) => step)) ===
			JSON.stringify(native.map(([step]) => step)),
		`native ${JSON.stringify(native.map(([step]) => step))} proxied ${JSON.stringify(proxied.map(([step]) => step))}`,
	);
	const steps = new Map(proxied);
	// What the proxy answers honestly where the native tab's answer cannot be
	// had, each checked to be that honest answer and then compared as the
	// native one. In the default mode the page is a frame, and Chrome makes a
	// traversal's navigate event cancelable only in a top-level page. In
	// dialing every navigate event is the inject's own, which the browser
	// never marks trusted (src/inject/dom/calledNavigation.ts).
	const honest = [];
	const heard = (facts, wanted) =>
		facts.heard.map((one) => {
			if (one[0] !== 'navigate') return one;
			const copy = [...one];
			const want = wanted?.heard.find(
				(other) => other[0] === 'navigate' && other[6] === one[6],
			);
			if (mode === 'default' && copy[1] === 'traverse') {
				if (copy[5] !== false) honest.push(`${copy[6]} cancelable`);
				copy[5] = want?.[5] ?? copy[5];
			}
			if (mode.startsWith('just-call-stomp')) {
				if (copy[8] !== false) honest.push(`${copy[6]} trusted`);
				copy[8] = want?.[8] ?? copy[8];
			}
			return copy;
		});
	for (const [step, want] of native) {
		if (step === 'end') continue;
		const got = steps.get(step);
		// the scroll is the frame's: the demo's frame is not the native tab's
		// size, so only whether it was restored is compared
		const shape = (facts, wanted) =>
			facts && {
				...facts,
				scrollY: facts.scrollY > 0,
				...(facts.heard && wanted && { heard: heard(facts, wanted) }),
			};
		ok(
			`${mode}: ${step} as natively`,
			JSON.stringify(shape(want)) === JSON.stringify(shape(got, want)),
			`native ${JSON.stringify(want)} proxied ${JSON.stringify(got)}`,
		);
	}
	ok(
		mode === 'default'
			? `${mode}: a traversal's navigate event in the frame is not cancelable`
			: `${mode}: no navigate event the inject fires is trusted`,
		!honest.length,
		honest.join('; '),
	);
	ok(
		`${mode}: the host page raised no error`,
		!errors.length,
		errors.join('; '),
	);
	await page.close();
}

await done(browser);
