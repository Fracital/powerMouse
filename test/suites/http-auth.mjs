// HTTP authentication as Chrome does it, compared request by request. The
// page (http-auth.html, battery in http-auth.js) runs on 127.0.0.1 (A) with
// localhost (B) as another site, against test/auth-server.mjs's protection
// spaces: Basic and Digest (RFC 7616: MD5, MD5-sess, SHA-256, SHA-256-sess,
// qop=auth, a stale nonce) answered with XMLHttpRequest's user and password
// or a URL's credentials, in the page and a dedicated worker; what the auth
// cache sends ahead under a directory (a Digest one with its nonce count
// going up) and answers a challenge of a kept realm with; credentials the
// site refuses (open()'s, or the page's own Authorization) forgetting the
// realm; fetch() with and without credentials or with its own
// Authorization; a frame's navigation; and Clear-Site-Data, whose "cookies"
// clears the site's auth cache (Chrome's console says it does not: it
// does). For each case the status the page reads and the Authorization the
// server got for every request (nonces numbered, cnonce and response
// reduced to their shape) are compared with the native load. Both modes.
//
// The security invariant, checked on its own as well: no request to B ever
// carries A's credentials, sent ahead, to answer a challenge of the same
// realm, after a redirect from A (A's kept credentials, open()'s with and
// without withCredentials, or a URL's), or from a document of B framed in
// A; and the controller's `cookies.clear(origin)` forgets what the site's
// auth answered, and only that site's.
//
// Natively a challenge the browser has no credentials for prompts the user,
// who dismisses it here (the DevTools protocol's Fetch.continueWithAuth):
// the page gets the 401. The proxy never prompts. NTLM is not supported
// through the proxy (a connection-based handshake, which the transport's
// requests cannot hold to one connection): what Chrome sends to an NTLM
// challenge is printed, not compared.
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

const A = FIXTURE.replace(/\/$/, '');
const B = A.replace('127.0.0.1', 'localhost');
/** the cases whose log is reported, not compared */
const UNSUPPORTED = new Set(['ntlm userpass']);

/** the frame that runs the battery, and its report once done */
async function report(page) {
	for (let i = 0; i < 360; i++) {
		for (const frame of page.frames()) {
			const value = await frame
				.evaluate(() => window.__httpAuth)
				.catch(() => null);
			if (value?.done) return { frame, value };
		}
		await sleep(250);
	}
	return { frame: null, value: null };
}

// each load keys its requests; the key is not part of what is compared
const unkey = (value) =>
	JSON.stringify(value ?? null).replace(/k(=|%3D)[\w-]+/g, 'k$1KEY');

/** every request of the log that reached B with an Authorization */
const leaks = (log) =>
	Object.entries(log ?? {}).flatMap(([name, entries]) =>
		entries
			.filter((entry) => entry.origin === 'B' && entry.auth !== null)
			.map((entry) => `${name}: ${entry.auth}`),
	);

// natively, a frame of B runs in the page's process, so the page's
// DevTools session sees (and dismisses) its prompts too
const nativeBrowser = await launch([
	'--disable-site-isolation-trials',
	'--disable-features=IsolateOrigins,site-per-process',
]);
const nativeContext = await nativeBrowser.newContext();
const nativePage = await nativeContext.newPage();
const cdp = await nativeContext.newCDPSession(nativePage);
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
	patterns: [{ urlPattern: '*/auth/*' }],
});
await nativePage.goto(`${A}/pages/http-auth.html?k=native`);
const native = (await report(nativePage)).value;
await nativeBrowser.close();
console.log('native', JSON.stringify(native?.results));
console.log('native log', unkey(native?.log));
ok(
	'natively, the battery ran every case',
	native?.done === true,
	JSON.stringify(native?.at),
);
// what the battery relies on, so a change in the browser shows here first
ok(
	'natively, Basic and Digest (MD5 and SHA-256) answer with open()s credentials and go ahead under the directory',
	['basic userpass', 'basic ahead', 'md5 userpass', 'md5 ahead']
		.concat(['sha256 userpass', 'sha256 ahead', 'md5 stale'])
		.every((name) => native?.results?.[name]?.status === 200) &&
		native?.results?.['basic none']?.status === 401,
	JSON.stringify(native?.results),
);
ok(
	'natively, no request to the other origin carried credentials (of A, or any the page gave)',
	native && !leaks(native.log).length,
	leaks(native?.log).join('; '),
);
console.log(
	'native NTLM (not supported through the proxy):',
	unkey(native?.log?.['ntlm userpass']),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	await submitLanding(page, `${A}/pages/http-auth.html?k=${mode}`);
	const { frame, value: state } = await report(page);
	ok(
		`${mode}: the battery ran every case`,
		state?.done === true,
		JSON.stringify(state?.at),
	);
	for (const name of Object.keys(native?.results ?? {})) {
		const want = unkey(native.results[name]);
		const got = unkey(state?.results?.[name]);
		ok(
			`${mode}: ${name}: the page reads what it reads natively`,
			want === got,
			`\n      native  ${want}\n      proxied ${got}`,
		);
		if (UNSUPPORTED.has(name)) continue;
		const wantLog = unkey(native.log?.[name]);
		const gotLog = unkey(state?.log?.[name]);
		ok(
			`${mode}: ${name}: the site got the Authorization it gets natively`,
			wantLog === gotLog,
			`\n      native  ${wantLog}\n      proxied ${gotLog}`,
		);
	}
	ok(
		`${mode}: no request to the other origin carried credentials (of A, or any the page gave)`,
		state && !leaks(state.log).length,
		leaks(state?.log).join('; '),
	);

	// the host forgets a site's cookies: what its auth answered goes with
	// them (as the browser's "cookies and other site data" clears its auth
	// cache), another site's forgetting leaves it
	const ask = (file, user) =>
		frame.evaluate(
			([url, user]) =>
				new Promise((resolve) => {
					const request = new XMLHttpRequest();
					if (user) request.open('GET', url, true, user, 'pass');
					else request.open('GET', url);
					request.onloadend = () => resolve(request.status);
					request.send();
				}),
			[`${A}/auth/basic/c1/${file}?k=${mode}-clear&c=${file}`, user],
		);
	const clearStatuses = {
		first: await ask('first', 'user'),
		ahead: await ask('ahead'),
	};
	await page.evaluate((origin) => window.controller.cookies.clear(origin), B);
	clearStatuses.otherCleared = await ask('other-cleared');
	await page.evaluate((origin) => window.controller.cookies.clear(origin), A);
	clearStatuses.cleared = await ask('cleared');
	const clearLog = await (await fetch(`${A}/auth/log?k=${mode}-clear`)).json();
	ok(
		`${mode}: cookies.clear(origin) forgets the site's kept credentials, and another site's leaves them`,
		JSON.stringify(clearStatuses) ===
			JSON.stringify({
				first: 200,
				ahead: 200,
				otherCleared: 200,
				cleared: 401,
			}) && clearLog.cleared?.[0]?.auth === null,
		JSON.stringify({ clearStatuses, clearLog }),
	);
	await page.context().close();
}

await done(browser);
