// A cookie write never throws, even once the page's own beacons fill Chrome's
// beacon quota (cookie-beacons.html). weather.com showed "synchronous bridge
// cannot carry ... cookies/set (beacon refused)": through the proxy a cookie
// write was a synchronous beacon to the service worker, the page's own
// sendBeacon calls share the quota (64 KiB in flight per document), and
// document.cookie = x threw QuotaExceededError. The page reads its cookies,
// fills the quota, writes, overwrites and deletes cookies in one task, reads
// them back and fetches a URL that echoes its Cookie header, then reloads and
// reads and fetches again. Every result is compared with the page loaded
// natively, in both demo modes.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/cookie-beacons.html`;
const read = () => (window.__cb?.done ? window.__cb : null);

const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(target);
let native = null;
for (let i = 0; i < 80 && !native; i++) {
	await sleep(250);
	native = await nativePage.evaluate(read).catch(() => null);
}
await nativePage.close();
const n = native?.written;
ok(
	'natively, the page fills the beacon quota and no cookie write throws',
	n?.filled === true && n.threw.length === 0,
	JSON.stringify(n),
);
ok(
	'natively, the page reads its writes back and its fetch carries them',
	n?.read === 'seed=1; cb2=two; cb1=uno' && n.fetched === n.read,
	JSON.stringify(n),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	let proxied = null;
	let written;
	for (let i = 0; i < 120 && !proxied; i++) {
		await sleep(250);
		for (const frame of page
			.frames()
			.filter((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()))) {
			const fragment = frame.url().split('#read:')[1];
			if (fragment) written ??= JSON.parse(decodeURIComponent(fragment));
			proxied ??= await frame.evaluate(read).catch(() => null);
		}
	}
	ok(`${mode}: the page writes, reloads and reads back`, !!proxied);
	const p = proxied?.written ?? written;
	const same = (name, a, b) => {
		const x = JSON.stringify(a);
		const y = JSON.stringify(b);
		ok(`${mode}: ${name} as natively`, x === y, `native ${x} proxied ${y}`);
	};
	same('the beacon quota fills', n?.filled, p?.filled);
	same('the cookie writes throw', n?.threw, p?.threw);
	same('the first read is', n?.first, p?.first);
	same('the read between the writes is', n?.between, p?.between);
	same('the read after the writes is', n?.read, p?.read);
	same(
		'a fetch made in the task of the writes carries',
		n?.fetched,
		p?.fetched,
	);
	same(
		'after the reload, document.cookie reads',
		native?.reloaded?.read,
		proxied?.reloaded?.read,
	);
	same(
		'after the reload, a fetch carries',
		native?.reloaded?.fetched,
		proxied?.reloaded?.fetched,
	);
	ok(
		`${mode}: no error reached the page`,
		page.errors.length === 0,
		page.errors.join(' | '),
	);
	await page.close();
}
await done(browser);
