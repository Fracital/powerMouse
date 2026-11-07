// The host's view of the cookie jar: controller.cookies.set() applies a
// Set-Cookie for an origin, get() reads what the proxy would send, the page
// of that origin sends and sees it, clear(origin) removes that origin's
// cookies and leaves another origin's alone. The jar's parsing rules that
// the web-platform-tests cookie suite caught (control characters, nameless
// cookie order, commas) are checked through set() too.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const browser = await launch();
const page = await openDemo(browser, HOST);
const other = FIXTURE.replace('127.0.0.1', 'localhost');
const origin = new URL(FIXTURE).origin;

const api = (op, args) =>
	page.evaluate(
		([op, args]) => window.controller.cookies[op](...args),
		[op, args],
	);

await api('set', [`${FIXTURE}pages/cookie-page.html`, 'host=1; Path=/']);
await api('set', [`${other}pages/cookie-page.html`, 'otherhost=1; Path=/']);
ok(
	'get() returns the cookie set for the origin',
	(await api('get', [`${FIXTURE}pages/x`])) === 'host=1',
	JSON.stringify(await api('get', [`${FIXTURE}pages/x`])),
);

async function visit(base) {
	await page.click('#home');
	await submitLanding(page, `${base}pages/cookie-page.html`);
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		try {
			const value = await frame.evaluate(() => window.__cp);
			if (value?.done) return value;
		} catch (error) {
			// navigating
		}
	}
	return null;
}
const seen = await visit(FIXTURE);
ok(
	'the page of that origin sends the cookie',
	seen?.sent === 'host=1',
	JSON.stringify(seen?.sent),
);
ok(
	'the page of that origin sees it in document.cookie',
	seen?.document === 'host=1',
	JSON.stringify(seen?.document),
);

await api('clear', [origin]);
ok(
	'clear(origin) empties that origin',
	(await api('get', [`${FIXTURE}pages/x`])) === '',
	JSON.stringify(await api('get', [`${FIXTURE}pages/x`])),
);
ok(
	'clear(origin) leaves another origin alone',
	(await api('get', [`${other}pages/x`])) === 'otherhost=1',
	JSON.stringify(await api('get', [`${other}pages/x`])),
);
await api('clear', []);
ok(
	'clear() empties everything',
	(await api('get', [`${other}pages/x`])) === '',
	JSON.stringify(await api('get', [`${other}pages/x`])),
);

// a control character anywhere in the line (an attribute included) drops the
// whole cookie, as in Chrome; HTAB is not one of them
const jarURL = `${FIXTURE}pages/jar/x`;
await api('set', [
	jarURL,
	[
		'ctlname\x01=1',
		'ctlvalue=1\x7f',
		'ctlpath=1; Path=/pa\x02th; Path=/',
		'ctldomain=1; Domain=127.0.0.1\x1f',
		'ctlsecure=1; Sec\x0bure',
		'tab=1; SameSite=La\tx; SameSite=Lax',
	],
]);
ok(
	'a control character in the name, the value or an attribute drops the cookie',
	(await api('get', [jarURL])) === 'tab=1',
	JSON.stringify(await api('get', [jarURL])),
);
await api('clear', []);

// a nameless cookie keeps its place among its path's cookies, and a re-set
// with a new value is a new creation (a re-set with the same value is not)
await api('set', [jarURL, ['=stale', 'a=1', '=fresh', 'b=1', 'a=1']]);
ok(
	'a nameless cookie set again with a new value is listed after older cookies',
	(await api('get', [jarURL])) === 'a=1; fresh; b=1',
	JSON.stringify(await api('get', [jarURL])),
);
// what Chrome's HTTP parser does to a header before the jar sees it: a NUL
// reads as a space, a bare CR or LF ends the value
await api('set', [jarURL, ['nul\0name=1', 'lf=1\nZYX']]);
// an attribute value over 1024 bytes is skipped, the Path before it stays
await api('set', [jarURL, `long=1; Path=/; Path=/${'a'.repeat(1100)}`]);
ok(
	'a response header is read like Chrome reads it, oversize attributes skipped',
	(await api('get', [jarURL])) === 'a=1; fresh; b=1; nul name=1; lf=1; long=1',
	JSON.stringify(await api('get', [jarURL])),
);
// one Set-Cookie value is one cookie, commas and all
await api('set', [jarURL, 'comma=1, other=2']);
ok(
	'a comma in a Set-Cookie value stays in the value',
	(await api('get', [jarURL])) ===
		'a=1; fresh; b=1; nul name=1; lf=1; comma=1, other=2; long=1',
	JSON.stringify(await api('get', [jarURL])),
);
await api('clear', []);

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
