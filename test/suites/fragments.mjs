// A document's fragment is sealed in its route (docs/codec.md), and what the
// page sees of it is what it sees natively. test/pages/fragments.html runs
// in a frame loaded natively and in a proxied frame of the same size, and
// every step below is compared between the two: a load at a fragment, the
// scroll to the element and `:target`, a closed <details> it opens, an
// `<a name>`, an empty and a non-ASCII fragment, location.hash read and
// written (the same fragment again: no navigation), a link clicked (again:
// a replace, no hashchange), location.replace, history.pushState, the
// Navigation API's navigate(), back and forward, a reload, a cross-document
// navigation and its referrer, text directives, and every event the page
// hears for each (navigate, currententrychange, navigatesuccess, popstate,
// hashchange, with their URLs, types and state) and its Navigation API
// entry. GET forms (with an action and without) land where they do
// natively, with the fields the page's own formdata listener saw.
//
// Through the proxy, no frame address, no host address and no request ever
// shows a fragment or a form field in clear.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
} from '../lib.mjs';

const PAGE = `${FIXTURE}pages/fragments.html`;
const SIZE =
	'position:fixed;top:0;left:0;z-index:2147483647;width:1000px;height:700px;border:0;background:white';
// fixture text that must never show in a proxy address
const SECRET =
	/frag-|%E6%97%A5|field-secret|value-secret|value-noaction|phrase|second=1/i;

const browser = await launch();

// natively: the fixture in a frame of a page of its own origin (its storage
// is its own, as the proxied frame's is)
const native = await browser.newPage();
await native.goto(`${FIXTURE}pages/hist-1.html`);
await native.setContent(
	`<iframe id="frame" style="${SIZE}" src="about:blank"></iframe>`,
);
// through the proxy: a frame of the demo's controller
const page = await openDemo(browser, PROXY);
const recorder = await recordRequests(page.context());
await page.evaluate((style) => {
	const element = document.createElement('iframe');
	element.id = 'frame';
	element.setAttribute('style', style);
	document.body.append(element);
	window.__frame = window.controller.createFrame(element);
}, SIZE);

const sides = {
	native: {
		page: native,
		go: (url) =>
			native.evaluate((url) => {
				document.getElementById('frame').src = url;
			}, url),
	},
	proxied: {
		page,
		go: (url) => page.evaluate((url) => window.__frame.go(url), url),
	},
};
const frameOf = async (side) =>
	(await sides[side].page.$('#frame')).contentFrame();

/** wait until the frame's document has the harness and has loaded */
async function loaded(side) {
	for (let i = 0; i < 150; i++) {
		const frame = await frameOf(side);
		const ready = await frame
			?.evaluate(() => document.readyState === 'complete' && !!window.__frag)
			.catch(() => false);
		if (ready) return frame;
		await sleep(100);
	}
	return null;
}

const addresses = new Set();
const noteAddresses = async () => {
	for (const frame of page.frames()) addresses.add(frame.url());
	addresses.add(await page.evaluate(() => location.href));
};

/** run `act` on both sides, then compare what the page saw */
async function step(name, act, { settle = 400, load = false } = {}) {
	const result = {};
	for (const side of ['native', 'proxied']) {
		let frame = await frameOf(side);
		let during;
		try {
			during = (await act(frame, side)) ?? null;
		} catch (error) {
			during = `threw ${error.message}`;
		}
		await sleep(settle);
		if (load) frame = await loaded(side);
		const seen = await frame
			?.evaluate(() => ({
				events: window.__frag.take(),
				...window.__frag.snap(),
			}))
			.catch((error) => ({ error: error.message }));
		result[side] = { during, ...seen };
		if (side === 'proxied') await noteAddresses();
	}
	return result;
}

/** an action of the page's own (test/pages/fragments.html) */
const act = (name, value) => (frame) =>
	frame.evaluate(
		([name, value]) => window.__frag.act(name, value),
		[name, value],
	);

const lengthBase = { native: 0, proxied: 0 };
const indexBase = { native: 0, proxied: 0 };
/** the two sides' views as compared: history.length from the run's start */
const view = (seen, side) => {
	if (!seen || seen.error) return seen;
	// the frame's first entry and its referrer are the harness's
	const { length, entryIndex, referrer, ...rest } = seen;
	return {
		...rest,
		length: length - lengthBase[side],
		entryIndex: entryIndex - indexBase[side],
		referrer: seen.marker === null && !seen.search ? '' : referrer,
	};
};
function same(name, result, keys = null) {
	const pick = (value) => {
		if (!keys || !value || typeof value !== 'object') return value;
		return Object.fromEntries(keys.map((key) => [key, value[key]]));
	};
	const a = JSON.stringify(pick(view(result.native, 'native')));
	const b = JSON.stringify(pick(view(result.proxied, 'proxied')));
	ok(
		`${name}: as natively`,
		a === b,
		a === b ? a : `native ${a}\nproxied ${b}`,
	);
}

// a load at a fragment
for (const side of ['native', 'proxied']) {
	await sides[side].go(`${PAGE}#frag-alpha`);
	await loaded(side);
	lengthBase[side] = await (await frameOf(side)).evaluate(() => history.length);
}
await sleep(500);
same('a load at #frag-alpha', await step('load', () => {}));

same(
	'location.hash = frag-beta, the scroll and :target as the setter returns',
	await step('hash', act('hash', 'frag-beta')),
);
same(
	'location.hash set to the fragment it is at: no navigation',
	await step('hash again', act('hash', '#frag-beta')),
);
same(
	'a link to #frag-alpha clicked',
	await step('click', (frame) => frame.click('#lalpha')),
);
same(
	'the same link clicked again: a replace, no hashchange',
	await step('click again', (frame) => frame.click('#lalpha')),
);
same('history.back()', await step('back', act('back'), { settle: 700 }));
same(
	'history.forward()',
	await step('forward', act('forward'), { settle: 700 }),
);
same(
	'location.replace to an <a name>',
	await step('replace', act('replace', '#frag-named')),
);
same(
	'history.pushState to a fragment: no scroll, no hashchange',
	await step('pushState', act('push', '#frag-pushed')),
);
same(
	'navigation.navigate into a closed <details>',
	await step('navigate', act('navigate', '#frag-inside')),
);
same(
	'a link to a non-ASCII fragment clicked',
	await step('wide', (frame) => frame.click('#lwide')),
);
same('location.hash emptied', await step('empty hash', act('hash', '')));
same(
	'a link to # clicked',
	await step('click #', (frame) => frame.click('#lempty')),
);
same(
	'a reload at a fragment',
	await step('reload', act('reload', 'frag-gamma'), {
		settle: 1200,
		load: true,
	}),
	['hash', 'href', 'url', 'target', 'entry', 'events'],
);
same(
	'a link to another document at a fragment: a new document, its referrer without the fragment',
	await step('other document', act('click', 'lother'), {
		settle: 1200,
		load: true,
	}),
);
same(
	'location.href to another document at a fragment',
	await step('href other', act('href', 'fragments.html?third=1#frag-beta'), {
		settle: 1200,
		load: true,
	}),
);

// text directives: the browser takes them out of the URL. What one
// highlights (and makes the target) is not applied through the proxy: the
// browser applies a directive to the document it navigates to, which is the
// shell, before the page is written into it (as before fragments were
// sealed)
for (const [label, fragment] of [
	['a text directive alone', ':~:text=phrase'],
	['a fragment and a text directive', 'frag-beta:~:text=Alpha'],
]) {
	for (const side of ['native', 'proxied']) {
		await sides[side].go(`${PAGE}#${fragment}`);
		await loaded(side);
	}
	await sleep(500);
	const result = await step(label, () => {});
	same(`a load at ${label}: the URL without it`, result, [
		'hash',
		'href',
		'url',
		'entry',
	]);
	console.log(
		`INFO ${label}: target natively ${result.native?.target}, through the proxy ${result.proxied?.target} (known: the directive is not applied)`,
	);
}

// GET forms
for (const side of ['native', 'proxied']) {
	await sides[side].go(PAGE);
	await loaded(side);
	await (await frameOf(side)).evaluate(() => sessionStorage.clear());
}
same(
	'a GET form submitted by its button',
	await step('form', (frame) => frame.click('#fsubmit'), {
		settle: 1200,
		load: true,
	}),
	['hash', 'href', 'url', 'search', 'entry', 'formdata', 'events'],
);
same(
	'a GET form without an action submitted by script',
	await step('form without action', act('submit', 'fnoaction'), {
		settle: 1200,
		load: true,
	}),
	['hash', 'href', 'url', 'search', 'entry', 'formdata', 'events'],
);

await noteAddresses();
const shown = [
	...addresses,
	...recorder.log
		.filter((entry) => entry.kind === 'worker' || entry.kind === 'proxy')
		.map((entry) => entry.url),
].filter((url) => /\/stomp\/|#/.test(url));
const leaks = shown.filter((url) => {
	try {
		return SECRET.test(decodeURIComponent(url));
	} catch (error) {
		return SECRET.test(url);
	}
});
ok(
	`no frame address, host address or request shows a fragment or a form field (${shown.length} addresses)`,
	shown.length > 10 && leaks.length === 0,
	leaks.slice(0, 10).join('\n'),
);

await native.close();
await done(browser);
