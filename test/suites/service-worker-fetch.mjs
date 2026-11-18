// Emulated service workers answer a page's subresource requests
// (docs/service-workers.md). sw-fetch.html registers a worker that claims
// it, then fetches through it: a body it makes (headers, status, URL), a URL
// outside its scope and one of another origin (a controlled page's requests
// all go to its worker), a script (rewritten like the origin's: it reads
// the page's real location), Response.redirect with a relative URL, a
// stream, streams whose chunks the worker keeps (one chunk, several, a
// response whose clone it reads later: the proxy copies them as the browser
// does, and never takes their buffers from the worker), fetch(event.request)
// passed through, a request it leaves alone, a
// network error, a value that is no Response, a POST it echoes, an image;
// and the mode, destination, credentials, redirect and referrer each request
// showed the worker. Then every service worker is stopped, and the next
// requests start the worker again. All of it against the same page
// natively, both demo modes. sw-slow.html then has a worker that never
// settles a respondWith, which is a network error once the answer's time is
// up (Chrome's fetch event limit, 5 minutes, scaled down by `?sw=1000` to
// 6 s), and one that blocks, whose requests go to the network once its time
// to say is up (1 s), instead of hanging the page.
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

const target = `${FIXTURE}pages/deep/swf/sw-fetch.html`;
const slow = `${FIXTURE}pages/deep/sws/sw-slow.html`;
const ROUTED = /\/stomp\/[\w-]+\/html\//;

async function wait(find, key, tries = 200) {
	let value = null;
	for (let i = 0; i < tries && !value?.[key]; i++) {
		await sleep(250);
		value = await find()
			?.evaluate(() => window.__sw)
			.catch(() => null);
	}
	return value ?? { log: [] };
}

/** the fixture through `find`, with every service worker stopped midway */
async function run(page, find) {
	await wait(find, 'readyForRestart');
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	await cdp.send('ServiceWorker.stopAllWorkers');
	await cdp.detach();
	await find()?.evaluate(() => (window.__sw.restarted = true));
	return (await wait(find, 'done')).log;
}

const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
await nativePage.goto(target);
const native = await run(nativePage, () => nativePage.mainFrame());
await nativeBrowser.close();
ok(
	'natively, the fetch fixture runs to its end',
	native.length > 10 && !native.some((line) => line.startsWith('fail')),
	JSON.stringify(native),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, `${base}?sw`);
	await submitLanding(page, target);
	const find = () =>
		page.frames().findLast((frame) => ROUTED.test(frame.url()));
	const proxied = await run(page, find);
	const differences = [];
	for (let i = 0; i < Math.max(native.length, proxied.length); i++)
		if (native[i] !== proxied[i])
			differences.push({ native: native[i], proxied: proxied[i] });
	ok(
		`${mode}: every request the worker answers, passes or leaves alone reads as natively`,
		differences.length === 0,
		JSON.stringify(differences),
	);
	ok(
		`${mode}: no proxied page error`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();

	const slowPage = await openDemo(browser, `${base}?sw=1000`);
	await submitLanding(slowPage, slow);
	const log = (
		await wait(
			() => slowPage.frames().findLast((frame) => ROUTED.test(frame.url())),
			'done',
			160,
		)
	).log;
	const answered = (name, within) => {
		const line = log.find((entry) => entry.startsWith(`${name} `));
		const ms = Number(line?.split(' ').pop());
		return !!line?.includes('target from the network') && ms < within;
	};
	// (Chrome fails such a request once its fetch event limit, 5 minutes,
	// is up, and never asks the network: measured on 157 at 310 s)
	const neverLine = log.find((entry) => entry.startsWith('never answers '));
	ok(
		`${mode}: a respondWith that never settles is a network error once the answer's time (6 s) is up, as natively at Chrome's limit`,
		!!neverLine?.includes('TypeError: Failed to fetch') &&
			Number(neverLine.split(' ').pop()) < 15000,
		JSON.stringify(log),
	);
	ok(
		`${mode}: a worker that blocks goes to the network once its time to say (1 s) is up, and so does the next request`,
		answered('busy', 8000) && answered('still busy', 8000),
		JSON.stringify(log),
	);
	await slowPage.close();
}
await done(browser);
