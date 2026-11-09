// document.cookie is cached in the page and stays fresh: fifty reads cost one
// round trip to the jar, and the next read after the page's own write, a
// same-origin sibling frame's write, a fetch whose response set a cookie or a
// sibling frame's navigation whose response deleted one shows the change.
import { done, FIXTURE, launch, ok, PROXY, sleep } from '../lib.mjs';

const browser = await launch();
const page = await browser.newPage();
await page.goto(PROXY);
await page.waitForFunction(
	() => window.controller && window.controller.isReady,
	null,
	{ timeout: 45000 },
);
await page.evaluate(async (fixture) => {
	const element = document.createElement('iframe');
	document.body.append(element);
	window.__el = element;
	await window.controller
		.createFrame(element)
		.go(`${fixture}pages/cookie-cache.html`);
	// the page counts its client's reads of the jar through this reader:
	// no page can reach its client (by the name the controller minted)
	const name = window.controller.config.names.client;
	element.contentWindow.__reads = () => element.contentWindow[name].cookieReads;
}, FIXTURE);
let cc = {};
for (let i = 0; i < 60 && !cc.done; i++) {
	await sleep(500);
	const frame = page
		.frames()
		.find(
			(f) =>
				f.parentFrame() === page.mainFrame() &&
				/\/stomp\/[\w-]+\/html\//.test(f.url()),
		);
	try {
		cc = (await frame?.evaluate(() => window.__cc)) || {};
	} catch (error) {
		cc = {};
	}
}
ok(
	'the page ran to the end',
	cc.done === true && !cc.error,
	JSON.stringify(cc),
);
ok(
	'fifty reads of document.cookie cost one round trip',
	cc.fiftyReads === 1,
	JSON.stringify(cc.fiftyReads),
);
ok('the page sees its own write at once', cc.ownWrite === true);
ok(
	"the page sees a same-origin sibling frame's write at once",
	cc.siblingWrite === true,
);
ok(
	'a cookie set by the response to a fetch is visible when the fetch resolves',
	cc.afterFetch === true,
);
ok(
	"a cookie deleted by a sibling frame's navigation is gone when the frame has loaded",
	cc.afterNavigation === true,
);
await done(browser);
