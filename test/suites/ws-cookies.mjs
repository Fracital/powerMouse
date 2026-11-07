// A WebSocket handshake carries the jar's cookies, HttpOnly ones included,
// under the SameSite rules of the page's site, while page script never sees
// an HttpOnly cookie (not through document.cookie, not through the sync
// route behind it); the Cookie Store API is gone; a WebSocket URL may be
// relative or http(s), as in a browser.
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
const record = async (key, timeout = 20000) => {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		for (const f of page.frames()) {
			if (!/\/stomp\/[\w-]+\/html\//.test(f.url())) continue;
			try {
				const value = await f.evaluate((k) => window[k], key);
				if (value?.done) return value;
			} catch (error) {
				// still navigating
			}
		}
		await sleep(300);
	}
	return {};
};
const names = (header) =>
	(header || '')
		.split(';')
		.map((c) => c.trim().split('=')[0])
		.filter(Boolean);
const has = (header, name) => names(header).includes(name);

// the cookies: cookie-rules sets http=1 (HttpOnly), strict, lax, none on
// 127.0.0.1
await submitLanding(page, `${FIXTURE}pages/cookie-rules.html`);
await record('__cr');

await submitLanding(page, `${FIXTURE}pages/ws-cookies.html`);
const same = await record('__ws');
ok(
	'a same-site handshake carries HttpOnly, Strict and Lax cookies',
	has(same.absolute?.cookie, 'http') &&
		has(same.absolute?.cookie, 'strict') &&
		has(same.absolute?.cookie, 'lax') &&
		has(same.absolute?.cookie, 'js'),
	JSON.stringify(same.absolute),
);
ok(
	'document.cookie never shows the HttpOnly cookie',
	typeof same.document === 'string' &&
		has(same.document, 'js') &&
		!has(same.document, 'http'),
	JSON.stringify(same.document),
);
ok(
	'a relative WebSocket URL resolves against the page',
	same.relative?.cookie === same.absolute?.cookie,
	JSON.stringify(same.relative),
);
ok(
	'an http(s) WebSocket URL means ws(s)',
	same.http?.cookie === same.absolute?.cookie,
	JSON.stringify(same.http),
);
ok(
	'the Cookie Store API is not exposed',
	same.cookieStore === false,
	JSON.stringify(same.cookieStore),
);

// the other site: a cross-site handshake gets SameSite=None cookies only
const other = FIXTURE.replace('127.0.0.1', 'localhost');
await submitLanding(page, `${other}pages/ws-cookies.html?cross`);
const cross = await record('__wsx');
ok(
	'a cross-site handshake carries SameSite=None cookies only',
	has(cross.absolute?.cookie, 'none') &&
		!has(cross.absolute?.cookie, 'strict') &&
		!has(cross.absolute?.cookie, 'lax') &&
		!has(cross.absolute?.cookie, 'http'),
	JSON.stringify(cross.absolute),
);
await done(browser);
