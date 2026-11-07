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
// <object data="page.html"> is not proxied: Chrome never routes an object's
// (or embed's) load through a service worker, so the document would be fetched
// from the proxy origin directly; the hooks are in place for a browser that does
await done(browser, page.errors);
