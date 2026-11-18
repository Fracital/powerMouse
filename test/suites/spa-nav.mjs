// A single-page app as Discord's is (test/pages/spa-nav.html): the router's
// pushState on a link click, React's default transition indicator (a
// replacing Navigation API navigation to the current entry, intercepted
// until the transition ends) alone and under a click, a Navigation API
// navigation and a traversal the page intercepts, history.back() and
// forward(), lazy chunks (import(), a JSONP script, a stylesheet, each also
// failing), and a target=_blank link that a root listener cancels and routes
// (Discord's channel links: proxied, the host opened it as a new tab, which
// read as the whole page reloading). The document stays the one that loaded
// through every step, and each step leaves the page where it leaves it
// natively. Then the user's click on a target=_blank link the page leaves
// alone opens it in a new window natively and in a new tab of the host
// proxied, and nothing else opened. Both modes, against the page loaded
// natively at the top of a tab.
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

/** a click of the user's on the link the page leaves alone (`#out`) */
const clickOut = (frame) => frame.click('#out');

const nativePage = await browser.newPage();
const nativePopups = [];
nativePage.on('popup', (popup) => nativePopups.push(popup.url()));
const native = await measure(nativePage, () => nativePage.goto(PAGE));
ok(
	'natively: the routed target=_blank link opened no window',
	nativePopups.length === 0,
	JSON.stringify(nativePopups),
);
await clickOut(nativePage.mainFrame());
for (let i = 0; i < 40 && !nativePopups.length; i++) await sleep(100);
ok(
	"natively: the user's click on the link the page leaves alone opened it in a new window",
	JSON.stringify(nativePopups) ===
		JSON.stringify([`${FIXTURE}pages/walk-3.html`]),
	JSON.stringify(nativePopups),
);
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
	await page.evaluate(() => {
		window.__opens = [];
		window.controller.addEventListener('open', (event) =>
			window.__opens.push(event.detail.url),
		);
	});
	const proxied = await measure(page, () => submitLanding(page, PAGE));
	ok(
		`${mode}: the routed target=_blank link opened no tab`,
		(await page.evaluate(() => window.__opens.length)) === 0,
		JSON.stringify(await page.evaluate(() => window.__opens)),
	);
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
	const frame = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	await clickOut(frame);
	let opens = [];
	for (let i = 0; i < 40 && !opens.length; i++) {
		await sleep(100);
		opens = await page.evaluate(() => window.__opens);
	}
	ok(
		`${mode}: the user's click on the link the page leaves alone opened it in a new tab, as natively in a new window`,
		JSON.stringify(opens) === JSON.stringify([`${FIXTURE}pages/walk-3.html`]),
		JSON.stringify(opens),
	);
	await page.close();
}

await done(browser);
