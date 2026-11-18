// The service worker keeps what it read of the cookie jar between requests
// (KeptJar, src/server/Cookies.ts) and forgets it on every write. Each step
// here writes the jar one way and reads it back with the very next request,
// natively and through the proxy, and the Cookie header the fixture saw
// must be the same: a response's Set-Cookie, a document.cookie write, a
// cookie whose Max-Age ran out while it was kept, a deletion by Max-Age=0,
// and the host's cookies API (set, clear). Then a cookie written by script
// must be on every request of a burst the page starts in the same task.
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
const origin = new URL(FIXTURE).origin;

/** in a page: the Cookie header the fixture saw on a credentialed fetch */
const echo = () =>
	fetch(`/echo-headers?${Math.random()}`, {
		credentials: 'include',
		cache: 'no-store',
	})
		.then((response) => response.json())
		.then((headers) => headers.cookie ?? '');
const load = (path) =>
	fetch(`${path}?${Math.random()}`, {
		credentials: 'include',
		cache: 'no-store',
	}).then((response) => response.text());

/** what the jar sends after each step, in a page `frame` */
async function steps(frame, api) {
	const seen = {};
	const run = async (name, step) => {
		await step();
		const cookie = await frame.evaluate(echo);
		seen[name] = cookie.split('; ').filter(Boolean).sort().join('; ');
	};
	await run('start', async () => {});
	await run('set-cookie', () =>
		frame.evaluate(load, '/pages/jar-kept-set.txt'),
	);
	await run('document.cookie', () =>
		frame.evaluate(() => {
			document.cookie = 'jd=2; path=/';
		}),
	);
	await run('max-age', () => frame.evaluate(load, '/pages/jar-kept-short.txt'));
	await run('max-age ran out', () => sleep(1600));
	await run('deleted', () => frame.evaluate(load, '/pages/jar-kept-del.txt'));
	if (api) {
		await run('api set', () =>
			api('set', [`${FIXTURE}pages/x`, 'jh=3; Path=/']),
		);
		await run('api clear', () => api('clear', [origin]));
	}
	return seen;
}

const nativePage = await browser.newPage();
await nativePage.goto(`${FIXTURE}pages/jar-kept.html`);
const native = await steps(nativePage.mainFrame(), null);
await nativePage.close();
ok(
	'natively, each write is on the next request',
	native.start === '' &&
		native['set-cookie'] === 'jk=1' &&
		native['document.cookie'] === 'jd=2; jk=1' &&
		native['max-age'] === 'jd=2; jk=1; js=1' &&
		native['max-age ran out'] === 'jd=2; jk=1' &&
		native.deleted === 'jd=2',
	JSON.stringify(native),
);

// in a page: a cookie written by script, then a burst of requests with
// credentials in the same task, each one's Cookie
const burst = async () => {
	document.cookie = 'b=1; path=/';
	return Promise.all(
		Array.from({ length: 60 }, (_, i) =>
			fetch(`/echo-headers?b${i}-${Math.random()}`, {
				credentials: 'include',
				cache: 'no-store',
			})
				.then((response) => response.json())
				.then((headers) => headers.cookie ?? ''),
		),
	);
};
const burstPage = await browser.newPage();
await burstPage.goto(`${FIXTURE}pages/jar-kept.html?burst`);
await burstPage.evaluate(() => {
	for (const name of ['jd', 'jk', 'js'])
		document.cookie = `${name}=; path=/; max-age=0`;
});
const nativeBurst = await burstPage.evaluate(burst);
await burstPage.close();

const page = await openDemo(browser, PROXY);
const api = (op, args) =>
	page.evaluate(
		([op, args]) => window.controller.cookies[op](...args),
		[op, args],
	);
await api('clear', []);
await submitLanding(page, `${FIXTURE}pages/jar-kept.html`);
let frame = null;
for (let i = 0; i < 160 && !frame; i++) {
	const found = page
		.frames()
		.findLast((f) => /\/stomp\/[\w-]+\/html[:/]/.test(f.url()));
	if (
		(await found?.evaluate(() => document.title).catch(() => null)) ===
		'jar-kept'
	)
		frame = found;
	else await sleep(250);
}
ok('the proxied page loads', !!frame);
if (frame) {
	const proxied = await steps(frame, api);
	for (const [step, value] of Object.entries(native))
		ok(
			`proxied, after ${step} the next request sends what it does natively`,
			proxied[step] === value,
			`native ${JSON.stringify(value)}, proxied ${JSON.stringify(proxied[step])}`,
		);
	ok(
		"proxied, a cookie the host's cookies API set is on the next request",
		proxied['api set'] === 'jd=2; jh=3',
		JSON.stringify(proxied['api set']),
	);
	ok(
		"proxied, the host's clear(origin) leaves nothing for the next request",
		proxied['api clear'] === '',
		JSON.stringify(proxied['api clear']),
	);
}

// a host of four labels (its fixture is on the loopback under any name of
// *.localhost): every request of a burst reads the cookie of the site's
// registrable domain
if (frame) {
	const proxied = await frame.evaluate(burst);
	ok(
		'every request of a burst right after a write sends the cookie, as natively',
		proxied.every((cookie) => cookie === nativeBurst[0]) &&
			nativeBurst.every((cookie) => cookie === nativeBurst[0]) &&
			nativeBurst[0] === 'b=1',
		`native ${JSON.stringify([...new Set(nativeBurst)])}, proxied ${JSON.stringify([...new Set(proxied)])}`,
	);
}
await api('clear', []);

await done(browser);
