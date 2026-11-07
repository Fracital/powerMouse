// A proxied page reads its own URLs back, never routed ones: performance
// entries (getEntries*, PerformanceObserver, toJSON) name the page's URLs
// and hide the inject bundles, hashchange oldURL/newURL and the Navigation
// API's entry and destination URLs are the page's, error stacks name the
// page's scripts (a page's own Error.prepareStackTrace still runs), a script
// the page inserted reads back the source the page wrote, and
// document.documentURI / window.origin match document.URL / location. Both
// demo modes, since the same-origin controller and the isolated one hand the
// frame different documents.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PORT,
	PROXY,
	sleep,
} from '../lib.mjs';

const browser = await launch();
const pages = [];
const real = `${FIXTURE}pages/readback.html`;
const realOrigin = new URL(FIXTURE).origin;
// the frame itself is always on 127.0.0.1:PORT; anything there is a leak
const leaks = (value) =>
	String(value).includes(`127.0.0.1:${PORT}`) ||
	String(value).includes('/stomp/');

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await browser.newPage();
	pages.push(page);
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.errors = errors;
	await page.goto(base);
	await page.waitForFunction(
		() => window.controller && window.controller.isReady,
		null,
		{ timeout: 45000 },
	);
	await page.evaluate(async (url) => {
		const element = document.createElement('iframe');
		document.body.append(element);
		const frame = window.controller.createFrame(element);
		await frame.go(url);
	}, real);

	let rb = {};
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => f.url().includes('/stomp/html/'));
		try {
			rb = (await frame.evaluate(() => window.__rb)) || {};
		} catch (error) {
			rb = {};
		}
		if (rb.done) break;
	}
	ok(`${mode}: the fixture finished`, rb.done === true, JSON.stringify(rb));
	const check = (name, condition, value) =>
		ok(`${mode}: ${name}`, condition, JSON.stringify(value));

	// 5. document and window
	check(
		'document.URL is the real URL',
		rb.documentURL === real,
		rb.documentURL,
	);
	check(
		'document.documentURI is the real URL',
		rb.documentURI === real,
		rb.documentURI,
	);
	check(
		'window.origin is the real origin',
		rb.origin === realOrigin,
		rb.origin,
	);
	check(
		'self.origin and globalThis.origin agree',
		rb.selfOrigin === realOrigin && rb.globalThisOrigin === realOrigin,
		[rb.selfOrigin, rb.globalThisOrigin],
	);

	// 3. error stacks
	check(
		'an inline script error stack names the page, not the route',
		typeof rb.inlineStack === 'string' &&
			rb.inlineStack.includes(real) &&
			!leaks(rb.inlineStack),
		rb.inlineStack,
	);
	check(
		'an external script error stack names the script, not the route',
		typeof rb.externalStack === 'string' &&
			rb.externalStack.includes(`${FIXTURE}pages/paint.js`) &&
			!leaks(rb.externalStack),
		rb.externalStack,
	);
	check(
		"the page's own Error.prepareStackTrace runs and sees real file names",
		typeof rb.customPrepare === 'string' &&
			rb.customPrepare.startsWith('CUSTOM ') &&
			rb.customPrepare.includes(real) &&
			!leaks(rb.customPrepare),
		rb.customPrepare,
	);
	check(
		'clearing the custom formatter restores the cleaned default',
		typeof rb.stackAfterCustom === 'string' &&
			rb.stackAfterCustom.startsWith('Error: z') &&
			rb.stackAfterCustom.includes(real) &&
			!leaks(rb.stackAfterCustom),
		rb.stackAfterCustom,
	);

	// 4. inserted scripts
	check(
		'script.textContent reads back what the page wrote',
		rb.scriptTextContent === true,
		rb.scriptTextContentRaw,
	);
	check(
		'script.text reads back what the page wrote',
		rb.scriptText === true,
		rb.scriptText,
	);
	check(
		'script.innerHTML reads back what the page wrote',
		rb.scriptInnerHTML === true,
		rb.scriptInnerHTML,
	);
	check(
		'a script built from a text node reads back what the page wrote',
		rb.scriptTextNode === true && rb.scriptFirstChildData === true,
		[rb.scriptTextNode, rb.scriptFirstChildData],
	);
	check(
		'script.outerHTML serialises the source the page wrote',
		rb.scriptOuterHTML === true,
		rb.scriptOuterHTML,
	);
	check(
		'a script edited after it ran reads back the new text',
		rb.scriptEdited === true,
		rb.scriptEdited,
	);
	check(
		'the inserted scripts ran rewritten (spoofed top, real href)',
		Array.isArray(rb.scriptsRan) && rb.scriptsRan.every((v) => v === real),
		rb.scriptsRan,
	);
	check(
		'a parser-inserted script reads back its source',
		rb.parserScript === true,
		rb.parserScript,
	);

	// 1. performance entries
	check(
		'resource entries name the real URLs',
		Array.isArray(rb.resourceNames) &&
			rb.resourceNames.includes(rb.scriptURL) &&
			rb.resourceNames.includes(rb.fetchURL),
		rb.resourceNames,
	);
	check(
		'no entry leaks the route or the inject bundles',
		Array.isArray(rb.allNames) &&
			rb.allNames.length > 0 &&
			!rb.allNames.some(leaks) &&
			Array.isArray(rb.observed) &&
			!rb.observed.some(leaks),
		[rb.allNames, rb.observed],
	);
	check(
		'initiatorType is unchanged',
		rb.scriptInitiator === 'script',
		rb.scriptInitiator,
	);
	check(
		'getEntriesByName finds entries by their real URL',
		rb.byName === 1 && rb.byNameTyped === 1,
		[rb.byName, rb.byNameTyped],
	);
	check(
		'the navigation entry names the page',
		rb.navigationName === real,
		rb.navigationName,
	);
	check(
		'toJSON and JSON.stringify carry the real name',
		rb.toJSONName === rb.resourceNames?.[0] &&
			rb.entryJSON === rb.resourceNames?.[0] &&
			!leaks(rb.toJSONName),
		[rb.toJSONName, rb.entryJSON],
	);
	check(
		'PerformanceObserver lists report the real URLs',
		Array.isArray(rb.observed) &&
			rb.observed.includes(rb.scriptURL) &&
			rb.observed.includes(`type:${rb.scriptURL}`) &&
			rb.observed.includes(`name:${rb.scriptURL}`),
		rb.observed,
	);

	// 2. hashchange and the Navigation API
	check(
		'hashchange oldURL / newURL are the real URLs',
		rb.hashOld === real && rb.hashNew === `${real}#frag`,
		[rb.hashOld, rb.hashNew],
	);
	check(
		'navigation.currentEntry.url and entries() are the real URLs',
		rb.navEntryURL === `${real}#frag` &&
			Array.isArray(rb.navEntriesURLs) &&
			!rb.navEntriesURLs.some(leaks),
		[rb.navEntryURL, rb.navEntriesURLs],
	);
	check(
		'navigate event destination.url is the real URL',
		rb.navigateDestination === `${real}#frag`,
		rb.navigateDestination,
	);
	check(
		'location.href agrees after the hash change',
		rb.hrefAfterHash === `${real}#frag`,
		rb.hrefAfterHash,
	);
	// an about:srcdoc child reads "null" as its location origin; its entries
	// are routes of the parent's origin all the same
	check(
		'an srcdoc child sees real resource URLs and no inject bundle',
		Array.isArray(rb.srcdoc?.names) &&
			rb.srcdoc.names.includes(`${FIXTURE}pages/echo.json?sd`) &&
			!rb.srcdoc.names.some(leaks),
		rb.srcdoc,
	);
	console.log(
		`${mode}: measured stack descriptor=${rb.stackDescriptor} proto=${rb.stackProtoDescriptor} prepareStackTrace=${rb.prepareStackTraceType}`,
	);
}

// the fixture's external script throws on purpose (registerPaint)
await done(
	browser,
	pages.flatMap((p) => p.errors).filter((e) => !/registerPaint/.test(e)),
);
