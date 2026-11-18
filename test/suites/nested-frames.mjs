// What a frame nested in a proxied page learns about its framing, and what the
// parent learns about the frame from its messages, follow the real origins:
// a same-origin child sees its own iframe element in `frameElement` and the
// parent gets the child's real window as `event.source`; a cross-origin child
// (the fixture's other host name) sees `frameElement` null and the parent gets
// a restricted window that can be posted to but not read. The host's own
// frame stays invisible (isolation suite).
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
await submitLanding(page, `${FIXTURE}pages/nested-same.html`);
let nest = {};
for (let i = 0; i < 60; i++) {
	await sleep(250);
	for (const frame of page
		.frames()
		.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))) {
		const value = await frame.evaluate(() => window.__nest).catch(() => null);
		if (value) nest = value;
	}
	if (nest.done) break;
}
const same = nest.messages?.same;
const cross = nest.messages?.cross;
ok(
	'a same-origin nested frame sees its iframe element and is the real source of its message',
	same?.frameElement === 'IFRAME#same' &&
		same?.document === 'reachable' &&
		same?.sourceIsFrame === true,
	JSON.stringify(same),
);
ok(
	'a cross-origin nested frame sees no frameElement and is a restricted source',
	cross?.frameElement === null &&
		cross?.document !== 'reachable' &&
		cross?.postMessage === 'function',
	JSON.stringify(cross),
);

// A navigation another window starts in a window whose document has just
// committed and is still loading lands, as natively: a frame sending its
// parent's fresh frame on as the frame's src commits (a replace() of its
// location, a write of its frame element's src, a link, a form and an
// open() aiming at its name), a frame sending a popup its parent opened on
// (a replace() of its location, of its document's, a write of its
// location, a replace() once it has told what the popup's location reads,
// a link, a GET and a POST form and an open() aiming at its name), and a
// page sending on a frame whose first document had loaded, as the next one
// commits (pages/late-navigation.html). The document committed is a tiny
// one, so the proxied navigation starts just before the proxy writes its
// page in (a navigation started then was aborted, and a popup's was made
// raw, leaving the proxy). Each case three times natively and proxied:
// where it lands, its Referer and Sec-Fetch-Site, and the landed
// document's referrer. The links, forms and open() calls are aimed once
// more at a window whose document has loaded: the host frames the proxied
// top sandboxed, so the browser navigates no sibling frame for a frame,
// and a name no frame of the page had went to the host as a new tab.
const fixtureJSON = async (path) => (await fetch(`${FIXTURE}${path}`)).json();
async function lateNavigation(open, c, round) {
	const k = `late-${Date.now().toString(36)}-${c}-${round}`;
	const pageOf = await open(
		`${FIXTURE}pages/late-navigation.html?${new URLSearchParams({ c, k })}`,
	);
	let landed = null;
	let log = {};
	for (let i = 0; i < 40 && !landed; i++) {
		await sleep(250);
		log = (await fixtureJSON(`echo-post/log?k=${k}`)) ?? {};
		if (log.landed)
			landed = JSON.parse(Buffer.from(log.landed.bodyHex, 'hex').toString());
	}
	const headers = await fixtureJSON(`echo-headers/recorded?k=${k}`);
	await pageOf.context().close();
	// (`popup-read`: what the popup's location read as its document
	// committed, the fixture's port named for what it is)
	const read = log.read
		? JSON.parse(
				Buffer.from(log.read.bodyHex, 'hex')
					.toString()
					.replaceAll(new URL(FIXTURE).port, 'PORT'),
			)
		: undefined;
	return {
		...(read && { read }),
		landed: !!landed,
		top: landed?.top ?? null,
		referrer: landed?.referrer?.replace(k, 'K') ?? null,
		referer: headers?.referer?.replace(k, 'K') ?? null,
		site: headers?.['sec-fetch-site'] ?? null,
	};
}
const openNative = async (url) => {
	const tab = await (await browser.newContext()).newPage();
	await tab.goto(url);
	return tab;
};
const openProxied = async (url) => {
	const tab = await openDemo(browser);
	await submitLanding(tab, url);
	return tab;
};
for (const c of [
	'sibling',
	'sibling-src',
	'sibling-link',
	'sibling-form',
	'sibling-open',
	'popup',
	'popup-document',
	'popup-assign',
	'popup-read',
	'popup-link',
	'popup-form',
	'popup-post',
	'popup-open',
	'loaded',
	// (the same aimed at a window whose next document has loaded: once)
	'sibling-link+',
	'sibling-form+',
	'sibling-open+',
	'popup-link+',
	'popup-open+',
])
	for (let round = 0; round < (c.endsWith('+') ? 1 : 3); round++) {
		const native = JSON.stringify(await lateNavigation(openNative, c, round));
		const proxied = JSON.stringify(await lateNavigation(openProxied, c, round));
		ok(
			c.endsWith('+')
				? `a ${c.slice(0, -1)} navigation of a window that has loaded lands as natively`
				: `a ${c} late navigation lands as natively (round ${round + 1})`,
			native === proxied && JSON.parse(native).landed,
			`native ${native} proxied ${proxied}`,
		);
	}
await done(browser, page.errors);
