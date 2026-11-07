// SameSite follows the request: the cookie-rules page on 127.0.0.1 sets
// Strict, Lax and None cookies (its Set-Cookie sidecar); a page on localhost,
// another site, then fetches 127.0.0.1 with credentials (None only; a default
// fetch gets nothing) and embeds it as a nested frame (None only: a browser
// judges it by the top-level page), while 127.0.0.1's own request carries all
// three.
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
// the page's record, whichever proxied frame holds it (the pages embed
// frames of their own, so the newest frame is not always the page)
const result = async (key, timeout = 20000) => {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		for (const f of page.frames()) {
			if (!f.url().includes('/stomp/html')) continue;
			try {
				const value = await f.evaluate((k) => window[k], key);
				if (value?.done) return value;
			} catch (error) {
				// the frame is still navigating
			}
		}
		await sleep(300);
	}
	return { frames: page.frames().map((f) => f.url().slice(0, 60)) };
};

// the cookies, set on the 127.0.0.1 site, and its own request
await submitLanding(page, `${FIXTURE}pages/cookie-rules.html`);
const own = await result('__cr');
const names = (header) =>
	(header || '')
		.split(';')
		.map((c) => c.trim().split('=')[0])
		.filter(Boolean);
const has = (header, name) => names(header).includes(name);
ok(
	'a same-site request carries Strict, Lax and None cookies',
	has(own.sent, 'strict') && has(own.sent, 'lax') && has(own.sent, 'none'),
	JSON.stringify(own.sent),
);

// the other site: a credentialed subresource (credentials include, as an
// <img> or <script> is) gets the None cookies; a default fetch() (credentials
// same-origin) gets none, as the browser's own jar would give it
const other = FIXTURE.replace('127.0.0.1', 'localhost');
await submitLanding(page, `${other}pages/samesite.html`);
const cross = await result('__ss');
ok(
	'a cross-site credentialed subresource carries SameSite=None only',
	cross.done === true &&
		has(cross.subresource, 'none') &&
		!has(cross.subresource, 'lax') &&
		!has(cross.subresource, 'strict'),
	JSON.stringify(cross),
);
ok(
	'a default fetch() to another site carries no cookie at all',
	cross.done === true && cross.plain === '',
	JSON.stringify(cross.plain),
);
// the embedded frame's document is the echoed headers
let framed = null;
for (let i = 0; i < 30 && framed === null; i++) {
	for (const f of page.frames()) {
		if (!f.url().includes('/stomp/html')) continue;
		try {
			const text = await f.evaluate(() => document.body?.textContent || '');
			if (text.startsWith('{')) framed = JSON.parse(text).cookie || '';
		} catch (error) {
			// not readable yet
		}
	}
	if (framed === null) await sleep(500);
}
// the embedded frame is a nested document: judged by the top-level page,
// so no Lax either (the nested-cookies suite has the top-level navigation)
ok(
	'a nested cross-site frame carries SameSite=None only',
	framed !== null &&
		has(framed, 'none') &&
		!has(framed, 'lax') &&
		!has(framed, 'strict'),
	JSON.stringify(framed),
);
await done(browser);
