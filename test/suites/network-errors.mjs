// A request whose connection fails is a network error for the page: fetch
// rejects with a TypeError and an XHR fires `error` with status 0, as on the
// real site, never a response the proxy made up (the worker answered a
// failed subresource with a 500 JSON body, so a page saw a fetch resolve,
// and the WPT cookie pages that allow a refused response failed).
// network-error.html aims both at a port nothing listens on. Compared with
// the same page loaded natively; both demo modes.
import { createServer } from 'node:net';
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

/** a port that was free a moment ago and has nothing listening on it */
const deadPort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

async function reportOf(page) {
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__netError)
				.catch(() => null);
			if (value?.done) return value;
		}
	}
	return null;
}

const url = `${FIXTURE}pages/network-error.html?port=${await deadPort()}`;
const browser = await launch();
const nativePage = await browser.newPage();
await nativePage.goto(url);
const native = await reportOf(nativePage);
await nativePage.close();
ok(
	'natively, a fetch to a closed port rejects and an XHR fires error',
	native?.fetch === 'rejected TypeError' && native?.xhr === 'error 0',
	JSON.stringify(native),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, url);
	const proxied = await reportOf(page);
	ok(
		`${mode}: a fetch to a closed port rejects as it does natively`,
		proxied?.fetch === native?.fetch,
		JSON.stringify({ native: native?.fetch, proxied: proxied?.fetch }),
	);
	ok(
		`${mode}: an XHR to a closed port fires error as it does natively`,
		proxied?.xhr === native?.xhr,
		JSON.stringify({ native: native?.xhr, proxied: proxied?.xhr }),
	);
	await page.close();
}
await done(browser);
