// XMLHttpRequest reads back what the browser's does, case by case. The page
// (xhr-parity.html, battery in xhr-parity.js) runs the same requests in
// itself and in a dedicated worker: every responseType ('', text,
// arraybuffer, blob, json, document) over JSON, HTML, XML, SVG, XHTML, RSS,
// binary and malformed bodies with and without a charset, overrideMimeType,
// open() again after a request finished, synchronous requests (and the
// types and timeouts a document may not set on them, and a worker's timeout
// running out on a response five seconds away), and open()'s user and
// password and a URL's credentials against an HTTP Basic challenge. Each
// case's description (status, response, responseText, responseXML and its
// document's type, charset, URL and links, the readystatechange and event
// sequences, what threw) is compared with the native load of the same page,
// and so is the Authorization the fixture received for every auth request.
// Both modes.
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

/** the page's report, from whichever frame holds it */
async function report(page) {
	let state = null;
	for (let i = 0; i < 240 && !state?.done; i++) {
		await sleep(250);
		for (const frame of page.frames()) {
			const value = await frame
				?.evaluate(() => window.__xhrParity)
				.catch(() => null);
			if (value && Object.keys(value).length) state = value;
		}
	}
	return state;
}

// each load keys its auth requests; the key is not part of what is compared
const unkey = (value) =>
	JSON.stringify(value ?? null).replace(/k=[\w-]+/g, 'k=KEY');

const browser = await launch();

const nativePage = await browser.newPage();
// a challenge the request has no credentials for prompts the user, who
// dismisses it here: the page gets the 401 (headless Chrome would wait on
// the prompt forever). The proxy never prompts
const cdp = await nativePage.context().newCDPSession(nativePage);
cdp.on('Fetch.requestPaused', ({ requestId }) =>
	cdp.send('Fetch.continueRequest', { requestId }).catch(() => {}),
);
cdp.on('Fetch.authRequired', ({ requestId }) =>
	cdp
		.send('Fetch.continueWithAuth', {
			requestId,
			authChallengeResponse: { response: 'CancelAuth' },
		})
		.catch(() => {}),
);
await cdp.send('Fetch.enable', {
	handleAuthRequests: true,
	patterns: [{ urlPattern: '*/xhr-auth/*' }],
});
await nativePage.goto(`${FIXTURE}pages/xhr-parity.html?k=native`);
const native = await report(nativePage);
await nativePage.context().close();
const sides = ['page', 'worker'];
ok(
	'natively, the page and the worker ran every case',
	native?.done === true &&
		!native.fatal &&
		sides.every((side) => typeof native[side] === 'object'),
	JSON.stringify(
		native && { fatal: native.fatal, at: native.at, worker: native.worker },
	),
);
// what the battery relies on, so a change in the browser shows here first
ok(
	'natively, credentials answer the challenge and none go before it',
	native?.page?.['auth userpass']?.status === 200 &&
		native?.page?.['auth none']?.status === 401 &&
		unkey(native?.page?.['upstream authorization']?.userpass?.slice(0, 2)) ===
			unkey([null, `Basic ${btoa('user:pass')}`]),
	unkey(native?.page?.['upstream authorization']),
);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${FIXTURE}pages/xhr-parity.html?k=${mode}`);
	const state = await report(page);
	ok(
		`${mode}: the page and the worker ran every case`,
		state?.done === true &&
			!state.fatal &&
			sides.every((side) => typeof state[side] === 'object'),
		JSON.stringify(
			state && { fatal: state.fatal, at: state.at, worker: state.worker },
		),
	);
	for (const side of sides)
		for (const name of Object.keys(native?.[side] ?? {})) {
			const want = unkey(native[side][name]);
			const got = unkey(state?.[side]?.[name]);
			ok(
				`${mode}: ${side}: ${name} reads back as natively`,
				want === got,
				`\n      native  ${want}\n      proxied ${got}`,
			);
		}
	await page.context().close();
}

await done(browser);
