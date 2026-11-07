// The documents a page embeds beyond <iframe> are reached the same way: a
// frameset's <frame> gives the page an injected contentWindow /
// contentDocument (a proxied child reads its real URL and title; markup
// written into an about:blank <frame> goes through the child's own hooks, so
// its links route and read back as written).
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
const result = async (key, marker) => {
	let out = {};
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))) {
			const value = await frame
				.evaluate((key) => window[key], key)
				.catch(() => null);
			if (value && value[marker]) out = value;
		}
		if (out.done) break;
	}
	return out;
};
await submitLanding(page, `${FIXTURE}pages/frameset.html`);
const fs = await result('__fs', 'done');
ok(
	'a frameset frame with a proxied page reads its real URL and title',
	fs.aHref === `${FIXTURE}pages/nested-child.html` &&
		fs.aTitle === 'NESTED CHILD',
	JSON.stringify([fs.aHref, fs.aTitle, fs.error]),
);
ok(
	'markup written into an about:blank frame goes through the child hooks',
	fs.bAttr === '/fb' &&
		fs.bHref === `${new URL(FIXTURE).origin}/fb` &&
		JSON.stringify(fs.bNames) === JSON.stringify(['id', 'href']),
	JSON.stringify([fs.bAttr, fs.bHref, fs.bNames, fs.error]),
);
// <object data> and <embed src>: Chrome never routes their loads through a
// service worker, so the inject fetches them through the proxy and hands the
// element a blob: URL; their documents run injected (top is the page) and
// post back, an object made while the page parses as well as one made after
// load, and the attribute reads back as written
await page.evaluate(async (fixture) => {
	const element = document.createElement('iframe');
	document.body.append(element);
	await window.controller
		.createFrame(element)
		.go(`${fixture}pages/object-load.html`);
}, FIXTURE);
let objects = null;
for (let i = 0; i < 30 && !objects?.done; i++) {
	await sleep(250);
	for (const frame of page.frames()) {
		const value = await frame
			.evaluate(() => window.__objects)
			.catch(() => null);
		if (value?.done) objects = value;
	}
}
const seen = (id) =>
	objects?.messages?.find((message) => message.id === id) ?? null;
ok(
	'<object> and <embed> documents load through the proxy and run injected',
	['early', 'late', 'embed'].every(
		(id) =>
			seen(id)?.top === true &&
			seen(id)?.href === `${FIXTURE}pages/object-doc.html?${id}`,
	) &&
		JSON.stringify(objects?.readback) ===
			JSON.stringify([
				`${FIXTURE}pages/object-doc.html?early`,
				'object-doc.html?early',
			]),
	JSON.stringify(objects),
);
await done(browser, page.errors);
