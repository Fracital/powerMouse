// The host's view of the cookie jar: controller.cookies.set() applies a
// Set-Cookie for an origin, get() reads what the proxy would send, the page
// of that origin sends and sees it, clear(origin) removes that origin's
// cookies and leaves another origin's alone.
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

await done(
	browser,
	page.errors.filter((e) => !/max cycles/.test(e)),
);
