// A nested cross-site frame is not a top-level navigation: it gets
// SameSite=None cookies only, as a browser does, and so does a link followed
// inside it; a top-level cross-site navigation of the page itself still
// carries Lax. The cookie-rules page on 127.0.0.1 sets strict/lax/none; the
// page on localhost (the fixture's other host name) embeds 127.0.0.1.
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, PROXY);
const names = (header) =>
	(header || '')
		.split(';')
		.map((c) => c.trim().split('=')[0])
		.filter(Boolean);
const has = (header, name) => names(header).includes(name);
const settled = async (key, timeout = 20000) => {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		for (const f of page.frames()) {
			if (!f.url().includes('/stomp/html/')) continue;
			try {
				const value = await f.evaluate((k) => window[k], key);
				if (value?.done) return value;
			} catch (error) {
				// navigating
			}
		}
		await sleep(300);
	}
	return {};
};
// the JSON a frame shows when it is the fixture's /echo-headers
const echoed = async (predicate, timeout = 15000) => {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		for (const f of page.frames()) {
			if (!f.url().includes('/stomp/html')) continue;
			try {
				const text = await f.evaluate(() =>
					(document.body?.textContent || '').trim(),
				);
				if (text.startsWith('{')) {
					const parsed = JSON.parse(text);
					if (predicate(parsed, f)) return parsed.cookie || '';
				}
			} catch (error) {
				// not readable yet
			}
		}
		await sleep(400);
	}
	return null;
};

await submitLanding(page, `${FIXTURE}pages/cookie-rules.html`);
await settled('__cr');

const other = FIXTURE.replace('127.0.0.1', 'localhost');
await submitLanding(page, `${other}pages/nested.html`);
await sleep(3000);
// the page's frame holds the two nested ones; the echo frame is the nested
// one whose parent is the page (depth two under the host)
const depth = (f) => {
	let d = 0;
	for (let p = f.parentFrame(); p; p = p.parentFrame()) d++;
	return d;
};
const nested = await echoed((parsed, f) => depth(f) === 2);
ok(
	'a nested cross-site frame gets SameSite=None cookies only',
	nested !== null &&
		has(nested, 'none') &&
		!has(nested, 'lax') &&
		!has(nested, 'strict'),
	JSON.stringify(nested),
);

// a link followed inside the nested frame stays nested: the child frame
// navigates to the echo, a second echo at depth two
const byTitle = async (title, wantDepth) => {
	for (const f of page.frames()) {
		if (depth(f) !== wantDepth || !f.url().includes('/stomp/html')) continue;
		try {
			if ((await f.evaluate(() => document.title)) === title) return f;
		} catch (error) {
			// navigating
		}
	}
	return null;
};
const child = await byTitle('NESTED CHILD', 2);
let inside = {};
if (child)
	for (let i = 0; i < 20 && !inside.done; i++) {
		await sleep(300);
		try {
			inside = (await child.evaluate(() => window.__child)) || {};
		} catch (error) {
			inside = {};
		}
	}
ok(
	"a nested cross-site frame's own fetch is cross-site: None only, Sec-Fetch-Site cross-site",
	inside.done === true &&
		has(inside.cookie, 'none') &&
		!has(inside.cookie, 'lax') &&
		!has(inside.cookie, 'strict') &&
		inside.site === 'cross-site',
	JSON.stringify(inside),
);
let followed = null;
if (child) {
	// the child frame object stays the same across its navigation
	await child.evaluate(() => document.getElementById('go').click());
	await sleep(2500);
	followed = await echoed((parsed, f) => f === child);
}
ok(
	'a link followed inside a nested cross-site frame still gets None only',
	followed !== null &&
		has(followed, 'none') &&
		!has(followed, 'lax') &&
		!has(followed, 'strict'),
	JSON.stringify(followed),
);

// a top-level cross-site navigation of the page itself carries Lax
const pageFrame = await byTitle('NESTED', 1);
let topLevel = null;
if (pageFrame) {
	await pageFrame.evaluate(() => document.getElementById('toplink').click());
	await sleep(2500);
	topLevel = await echoed((parsed, f) => f === pageFrame);
}
ok(
	'a top-level cross-site navigation carries Lax and None but not Strict',
	topLevel !== null &&
		has(topLevel, 'lax') &&
		has(topLevel, 'none') &&
		!has(topLevel, 'strict'),
	JSON.stringify(topLevel),
);
await done(browser);
