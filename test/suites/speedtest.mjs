// A speed test as wisp.baby is one (test/pages/speedtest.html), natively
// and through the proxy. wisp.baby read 0 Mbps through STomp: its app is a
// module that imports its own livestats.js, which a generic EasyPrivacy rule
// blocks (`/livestats.js`), so the module graph failed, the app never ran
// and the page kept the 0 of its markup. The demo's shields are in standard
// mode, as Brave's are by default, and Brave's standard mode asks its
// default lists nothing of a request to the site of the tab's page: the
// lists block third-party trackers only, and the user's own filters judge
// every request. Aggressive mode blocks first-party requests too.
//
// The cases, with the run's list (test/pages/adblock-run.txt, which carries
// EasyPrivacy's rule) and the site's shields set from the host's page:
//
// - natively: the app runs, the copy of livestats.js on another site
//   (www.localhost) loads, and the download and upload measure;
// - standard mode: the app runs and its own livestats.js loads, the
//   other site's copy is blocked, the download measures a speed near the
//   native one (the suite's server sends at a set rate) and the upload a
//   speed that is not 0; and with a custom filter for livestats.js, the
//   user's own rule blocks the first-party module as Brave's does;
// - aggressive mode: the first-party module is blocked, the app never
//   runs and the page reads 0.
import { WebSocketServer } from 'ws';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

/** what the suite's server sends and reads, at the rate it sends (Mbit/s) */
const MIB = 8;
const RATE = 80;

const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => sockets.once('listening', resolve));
sockets.on('connection', (ws, req) => {
	const url = new URL(req.url, 'http://x/');
	const bytes = Number(url.searchParams.get('bytes'));
	ws.on('error', () => {});
	if (url.pathname === '/down') {
		// 64 KiB messages at RATE, as the far server's link would send them
		const chunk = Buffer.alloc(65536, 7);
		const perMs = (RATE * 1e6) / 8 / 1000;
		const start = Date.now();
		let sent = 0;
		const pump = () => {
			while (sent < bytes && sent <= (Date.now() - start) * perMs) {
				const n = Math.min(chunk.length, bytes - sent);
				ws.send(n === chunk.length ? chunk : chunk.subarray(0, n));
				sent += n;
			}
			if (sent < bytes) setTimeout(pump, 2);
			else ws.close();
		};
		pump();
	} else if (url.pathname === '/up') {
		let got = 0;
		let start = 0;
		ws.on('message', (data) => {
			start ||= Date.now();
			got += data.length;
			if (got >= bytes) ws.send(JSON.stringify({ ms: Date.now() - start }));
		});
	}
});

const fixture = new URL(FIXTURE);
const search = new URLSearchParams({
	ws: String(sockets.address().port),
	mib: String(MIB),
	third: `http://www.localhost:${fixture.port}/pages/livestats.js?third`,
});
const target = `${FIXTURE}pages/speedtest.html?${search}`;

const browser = await launch();

/** the page's report once it is done, or once it has had time to start */
async function report(frame, timeout = 30000) {
	const start = Date.now();
	let last = null;
	while (Date.now() - start < timeout) {
		last = await (
			await frame()
		)
			?.evaluate(() => ({
				...window.__speed,
				shown: document.getElementById('speed')?.textContent,
			}))
			.catch(() => null);
		if (last?.done || last?.moduleError) break;
		await sleep(200);
	}
	return last;
}

const native = await (async () => {
	const tab = await browser.newPage();
	await tab.goto(target);
	const result = await report(() => tab.mainFrame());
	await tab.close();
	return result;
})();
ok(
	'natively the app runs, both copies of livestats.js load and both directions measure',
	native?.ran === true &&
		native.livestats === true &&
		native.third === 'loaded' &&
		native.down?.bytes === MIB * 1048576 &&
		native.down.mbps > 0 &&
		native.up?.mbps > 0,
	JSON.stringify(native),
);

const page = await openDemo(browser);
const host = fixture.hostname;
/** the site's shields, as the demo's panel sets them */
const shields = (patch) =>
	page.evaluate(
		([host, patch]) => {
			window.controller.shields.set(host, patch);
		},
		[host, { httpsUpgrade: 'off', cookies: 'allow', ...patch }],
	);
const proxiedFrame = () =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

await shields({ enabled: true, mode: 'standard' });
await sleep(300);
await submitLanding(page, target);
const standard = await report(proxiedFrame);
ok(
	"standard mode: the page's own livestats.js loads and the app runs",
	standard?.ran === true &&
		standard.livestats === true &&
		!standard.moduleError &&
		standard.done === true &&
		!standard.error,
	JSON.stringify(standard),
);
ok(
	"standard mode: another site's livestats.js is still blocked",
	standard?.third === 'failed',
	JSON.stringify(standard?.third),
);
ok(
	'standard mode: the download measures every byte at a speed near the native one',
	standard?.down?.bytes === MIB * 1048576 &&
		standard.down.mbps > native.down.mbps * 0.5 &&
		standard.down.mbps < native.down.mbps * 1.5 &&
		Number(standard.shown) > 0,
	JSON.stringify({ native: native?.down, proxied: standard?.down }),
);
ok(
	'standard mode: the upload measures a speed that is not 0',
	standard?.up?.mbps > 0 && standard.up.serverMs >= 0,
	JSON.stringify({ native: native?.up, proxied: standard?.up }),
);

// the user's own filter for it (the demo's custom-filters editor, an inline
// list): Brave's standard mode asks the user's filters of every request
const lists = await page.evaluate(() => window.controller.getAdblockLists());
const applied = await page.evaluate(
	(lists) =>
		window.controller.setAdblockLists([
			...lists,
			{
				url: 'stomp-filters:my-filters',
				filters: '/livestats.js\n',
				trusted: false,
			},
		]),
	lists,
);
let custom = null;
for (let i = 0; i < 5; i++) {
	await submitOmni(page, `${target}&custom=${i}`);
	await sleep(1000);
	custom = await report(proxiedFrame, 15000);
	if (custom?.moduleError) break;
}
ok(
	"standard mode: the user's own filter blocks the first-party livestats.js",
	applied?.applied === 'live' &&
		custom?.moduleError === true &&
		custom.ran === false,
	JSON.stringify({ applied, custom }),
);
await page.evaluate((lists) => window.controller.setAdblockLists(lists), lists);

await shields({ enabled: true, mode: 'aggressive' });
await sleep(300);
let aggressive = null;
for (let i = 0; i < 5; i++) {
	await submitOmni(page, `${target}&aggressive=${i}`);
	await sleep(1000);
	aggressive = await report(proxiedFrame, 15000);
	if (aggressive?.moduleError) break;
}
ok(
	'aggressive mode: the first-party livestats.js is blocked and the page reads 0',
	aggressive?.moduleError === true &&
		aggressive.ran === false &&
		aggressive.shown === '0',
	JSON.stringify(aggressive),
);

await done(browser, page.errors);
sockets.close();
