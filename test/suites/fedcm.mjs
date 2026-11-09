// FedCM (Google One Tap's `navigator.credentials.get({ identity })`) makes
// the browser itself fetch the identity provider's well-known file, config,
// accounts (with the user's real IdP cookies), client metadata and token
// endpoints, from its own process and never through the service worker, so
// through the proxy they went straight to the IdP and named the real site.
// The proxy cannot route them; a proxied page gets the API a browser
// without FedCM has (Chrome with --disable-features=FedCm, measured), so a
// sign-in library falls back to its iframe or popup flow, which the proxy
// carries. Checked against fedcm.html in both demo modes: no request leaves
// past the service worker; the feature detection and the identity calls
// read as in a FedCM-less browser's top-level page (the page believes it is
// top-level); every other credentials call answers as natively in a frame
// shaped like the mode's (same-origin with the top in same-origin mode,
// cross-origin in isolated mode), where Chrome already answers differently
// from a top-level page.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';

const fixture = new URL(FIXTURE);
const target = `${FIXTURE}pages/fedcm.html`;
const idp = (url) => /\/\.well-known\/web-identity|\/pages\/fedcm-/.test(url);
const FEDCM_GLOBALS = [
	'IdentityCredential',
	'IdentityCredentialError',
	'IdentityProvider',
	'NavigatorLogin',
];
// the calls the proxy leaves to the browser
const PASSED = ['password', 'federated', 'preventSilentAccess', 'conditional'];
const pick = (calls, names) =>
	Object.fromEntries(names.map((name) => [name, calls?.[name]]));

// fedcm.html natively, at top level or in a frame of a page on `top`
async function loadNative(args, top) {
	const browser = await launch(args);
	const context = await browser.newContext();
	const fetched = [];
	context.on('request', (request) => {
		if (idp(request.url())) fetched.push(request.url());
	});
	const page = await context.newPage();
	if (top) {
		await page.goto(`${top}/landed`);
		await page.evaluate((src) => {
			const frame = document.createElement('iframe');
			frame.src = src;
			document.body.append(frame);
		}, target);
	} else await page.goto(target);
	let value = null;
	for (let i = 0; i < 120 && !value?.done; i++) {
		await sleep(250);
		const frame = page.frames().findLast((f) => f.url() === target);
		value = await frame?.evaluate(() => window.__fedcm).catch(() => null);
	}
	await browser.close();
	return { value: value ?? {}, fetched };
}

const framedSame = await loadNative([], fixture.origin);
const framedCross = await loadNative([], `http://localhost:${fixture.port}`);
ok(
	'natively, FedCM makes the browser fetch the IdP well-known file and config',
	framedSame.fetched.some((url) => url.includes('/.well-known/web-identity')) &&
		framedSame.fetched.some((url) => url.includes('/pages/fedcm-config.json')),
	JSON.stringify(framedSame.fetched),
);
// the reference: a top-level page with FedCM off. Should a later Chrome
// drop the flag, the answers it gave on Chrome 152 stand in
const flagOff = await loadNative(['--disable-features=FedCm']);
const reference = flagOff.value.detect?.IdentityCredential
	? {
			detect: {
				...framedSame.value.detect,
				IdentityCredential: false,
				IdentityProvider: false,
				IdentityCredentialError: false,
				NavigatorLogin: false,
				login: false,
				protoLogin: false,
				typeofLogin: 'undefined',
				globals: framedSame.value.detect.globals.filter(
					(name) => !FEDCM_GLOBALS.includes(name),
				),
			},
			calls: {
				crossSite: 'NotSupportedError: FedCM is not supported.',
				sameSite: 'NotSupportedError: FedCM is not supported.',
				noProviders: 'NotSupportedError: FedCM is not supported.',
				withPassword: 'NotSupportedError: FedCM is not supported.',
				identityUndefined:
					'NotSupportedError: No credential type was specified in the request.',
				nothing:
					'NotSupportedError: No credential type was specified in the request.',
				aborted: 'AbortError: signal is aborted without reason',
				getUserInfo: 'ReferenceError: IdentityProvider is not defined',
				close: 'ReferenceError: IdentityProvider is not defined',
				disconnect: 'ReferenceError: IdentityCredential is not defined',
				setStatus:
					"TypeError: Cannot read properties of undefined (reading 'setStatus')",
			},
		}
	: flagOff.value;
ok(
	'with FedCM off the browser fetches nothing from the IdP',
	flagOff.fetched.length === 0 && flagOff.value.done === true,
	JSON.stringify(flagOff.fetched),
);
const identityCalls = Object.keys(reference.calls ?? {}).filter(
	(name) => !PASSED.includes(name),
);

const browser = await launch();
for (const [mode, base, framed] of [
	['same-origin', PROXY, framedSame],
	['isolated', HOST, framedCross],
]) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	await submitLanding(page, target);
	let proxied = null;
	for (let i = 0; i < 120 && !proxied?.done; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		proxied = await frame?.evaluate(() => window.__fedcm).catch(() => null);
	}
	proxied ||= {};
	// give a request the browser started late the time to show
	await sleep(1000);
	const outside = recorder.log.filter(
		(entry) =>
			entry.kind === 'raw' || (entry.kind === 'proxy' && idp(entry.url)),
	);
	ok(
		`${mode}: no request leaves past the service worker`,
		proxied.done === true && outside.length === 0,
		JSON.stringify(outside.map((entry) => [entry.kind, entry.url])),
	);
	ok(
		`${mode}: feature detection reads as a browser without FedCM`,
		JSON.stringify(proxied.detect) === JSON.stringify(reference.detect),
		JSON.stringify({ proxied: proxied.detect, reference: reference.detect }),
	);
	const expected = pick(reference.calls, identityCalls);
	const got = pick(proxied.calls, identityCalls);
	ok(
		`${mode}: every identity call answers as without FedCM`,
		proxied.done === true && JSON.stringify(got) === JSON.stringify(expected),
		JSON.stringify({ proxied: got, reference: expected }),
	);
	const passedNative = pick(framed.value.calls, PASSED);
	const passed = pick(proxied.calls, PASSED);
	ok(
		`${mode}: the rest of the Credential Management API answers as natively`,
		framed.value.done === true &&
			JSON.stringify(passed) === JSON.stringify(passedNative),
		JSON.stringify({ proxied: passed, native: passedNative }),
	);
	await page.close();
}
await done(browser);
