// FedCM, emulated (src/inject/dom/modules/Credentials.ts). A real Chrome ships
// FedCM on and runs navigator.credentials.get({ identity }) from its own
// process, so the old build deleted the five FedCM properties and rejected the
// call - a fingerprint tell. Now the interfaces stay, reading as the browser's,
// and the protocol runs in the inject through the proxy: this suite drives a
// whole flow against the mock identity provider in test/fixture.mjs and checks
// the interfaces read natively, a token completes through the proxy (with every
// step labelled Sec-Fetch-Dest: webidentity and the right credentials), the
// chooser selects and dismisses correctly, malformed input matches Chrome, the
// IdP-side statics answer as Chrome does, and no request escapes the proxy.
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
const sameOrigin = fixture.origin;
const crossOrigin = `http://localhost:${fixture.port}`;
const configOf = (origin, run, extra = '') =>
	`${origin}/pages/fedcm-config.json?k=${run}${extra}`;
const absoluteConfig = `${sameOrigin}/pages/fedcm-config.json`;

// input that rejects before any network or chooser, so it settles the same way
// natively and through the proxy
const VALIDATION = [
	'noProviders',
	'identityNull',
	'providersUndefined',
	'nothing',
	'identityUndefined',
	'badConfig',
	'badClientId',
	'relativeConfig',
	'aborted',
];
const STATICS = [
	'getUserInfo',
	'close',
	'resolve',
	'setStatus',
	'setStatusBad',
];

const logOf = (run) =>
	fetch(`${FIXTURE}pages/fedcm-log?k=${run}`)
		.then((r) => r.json())
		.catch(() => ({}));

/** the newest proxied document of the page (its frame), once its harness is ready */
async function proxiedFrame(page) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		const frame = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		const ready = await frame
			?.evaluate(() => window.__fedcm?.ready === true)
			.catch(() => false);
		if (ready) return frame;
	}
	return null;
}

const runScenario = (frame, name, params = {}) =>
	frame.evaluate((a) => window.runScenario(a.name, a.params), { name, params });
const callStatic = (frame, name, arg) =>
	frame.evaluate((a) => window.callStatic(a.name, a.arg), { name, arg });

// collect the reference: the page loaded natively, FedCM on
async function reference() {
	const browser = await launch();
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(target);
	await page.waitForFunction(() => window.__fedcm?.ready === true, null, {
		timeout: 20000,
	});
	const detect = await page.evaluate(() => window.__fedcm.detect);
	const validation = {};
	for (const name of VALIDATION)
		validation[name] = await page.evaluate(
			(a) => window.runScenario(a.name, a.params),
			{ name, params: { configURL: absoluteConfig } },
		);
	const statics = {};
	for (const name of STATICS)
		statics[name] = await page.evaluate(
			(a) => window.callStatic(a.name, a.arg),
			{
				name: name === 'setStatusBad' ? 'setStatus' : name,
				arg:
					name === 'setStatus'
						? 'logged-in'
						: name === 'setStatusBad'
							? 'bogus'
							: { configURL: absoluteConfig, clientId: 'stomp-rp' },
			},
		);
	await browser.close();
	return { detect, validation, statics, errors };
}

const ref = await reference();
ok(
	'natively FedCM is on: the five properties are present',
	ref.detect.IdentityCredential.present &&
		ref.detect.IdentityProvider.present &&
		ref.detect.NavigatorLogin.present &&
		ref.detect.IdentityCredentialError?.present &&
		ref.detect.login.inNavigator,
	JSON.stringify(ref.detect),
);

const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const page = await openDemo(browser, base);
	const recorder = await recordRequests(page.context());
	await submitLanding(page, target);
	const frame = await proxiedFrame(page);
	if (!frame) {
		ok(`${mode}: the proxied FedCM harness loads`, false, 'no ready frame');
		await page.close();
		continue;
	}

	// 1. the interfaces read as the browser's
	const detect = await frame.evaluate(() => window.__fedcm.detect);
	ok(
		`${mode}: the FedCM interfaces read as a real FedCM-on Chrome`,
		JSON.stringify(detect) === JSON.stringify(ref.detect),
		JSON.stringify({ proxied: detect, native: ref.detect }).slice(0, 2000),
	);

	// 2. malformed input rejects with Chrome's own errors
	const validation = {};
	for (const name of VALIDATION)
		validation[name] = await runScenario(frame, name, {
			configURL: absoluteConfig,
		});
	ok(
		`${mode}: malformed identity requests match Chrome`,
		JSON.stringify(validation) === JSON.stringify(ref.validation),
		JSON.stringify({ proxied: validation, native: ref.validation }).slice(
			0,
			2000,
		),
	);

	// 3. the IdP-side statics answer as Chrome does
	const statics = {};
	for (const name of STATICS)
		statics[name] = await callStatic(
			frame,
			name === 'setStatusBad' ? 'setStatus' : name,
			name === 'setStatus'
				? 'logged-in'
				: name === 'setStatusBad'
					? 'bogus'
					: { configURL: absoluteConfig, clientId: 'stomp-rp' },
		);
	ok(
		`${mode}: the IdP-side statics answer as Chrome does`,
		JSON.stringify(statics) === JSON.stringify(ref.statics),
		JSON.stringify({ proxied: statics, native: ref.statics }),
	);

	// 4. a whole flow completes and resolves a token through the proxy, auto-
	//    selecting the one returning account; every step went to the IdP
	//    labelled webidentity, config without the IdP cookie, accounts with it
	for (const [label, origin] of [
		['same-site IdP', sameOrigin],
		['cross-site IdP', crossOrigin],
	]) {
		const run = `auto-${mode}-${label.replace(/\W/g, '')}-${Date.now()}`;
		await frame.evaluate((o) => window.signIn(o), origin);
		const got = await runScenario(frame, 'flow', {
			configURL: configOf(origin, run),
			mediation: 'optional',
		});
		const log = await logOf(run);
		ok(
			`${mode}: ${label}: get({identity}) resolves an IdentityCredential token through the proxy`,
			got.kind === 'token' &&
				got.token === 'idtok.acct-1.true.n0' &&
				got.isAutoSelected === true &&
				got.type === 'identity' &&
				got.id === '' &&
				got.ctor === 'IdentityCredential' &&
				got.instanceOf === true &&
				got.toStringTag === '[object IdentityCredential]',
			JSON.stringify(got),
		);
		ok(
			`${mode}: ${label}: every step reached the IdP as Sec-Fetch-Dest: webidentity`,
			log.config?.dest === 'webidentity' &&
				log.accounts?.dest === 'webidentity' &&
				log.token?.dest === 'webidentity' &&
				log.token?.accountId === 'acct-1' &&
				log.token?.isAutoSelected === 'true' &&
				log.token?.nonce === 'n0',
			JSON.stringify(log),
		);
		ok(
			`${mode}: ${label}: steps carry Accept: application/json and the token POST is form-urlencoded`,
			/application\/json/.test(log.config?.accept ?? '') &&
				/application\/json/.test(log.accounts?.accept ?? '') &&
				log.token?.method === 'POST' &&
				/application\/x-www-form-urlencoded/.test(log.token?.contentType ?? ''),
			JSON.stringify({
				config: log.config?.accept,
				accounts: log.accounts?.accept,
				token: log.token?.contentType,
			}),
		);
		ok(
			`${mode}: ${label}: accounts carried the IdP cookie, config did not`,
			/fedcm_sid=yes/.test(log.accounts?.cookie ?? '') &&
				!/fedcm_sid/.test(log.config?.cookie ?? ''),
			JSON.stringify({
				config: log.config?.cookie,
				accounts: log.accounts?.cookie,
			}),
		);
	}

	// 5. the chooser: a forced prompt selects an account and mints a token
	{
		const run = `pick-${mode}-${Date.now()}`;
		await frame.evaluate((a) => window.startScenario('flow', a), {
			configURL: configOf(sameOrigin, run),
			mediation: 'required',
		});
		const account = frame.getByRole('button', { name: /Ada Proxy/ });
		await account.waitFor({ timeout: 10000 });
		await account.click();
		const got = await frame.evaluate(() => window.readPending());
		ok(
			`${mode}: choosing an account in the overlay mints a token (not auto-selected)`,
			got.kind === 'token' &&
				got.token === 'idtok.acct-1.false.n0' &&
				got.isAutoSelected === false,
			JSON.stringify(got),
		);
	}

	// 6. the chooser dismissed: Chrome's generic network error
	{
		const run = `dismiss-${mode}-${Date.now()}`;
		await frame.evaluate((a) => window.startScenario('flow', a), {
			configURL: configOf(sameOrigin, run),
			mediation: 'required',
		});
		const cancel = frame.getByRole('button', { name: 'Close' });
		await cancel.waitFor({ timeout: 10000 });
		await cancel.click();
		const got = await frame.evaluate(() => window.readPending());
		ok(
			`${mode}: dismissing the chooser rejects with Chrome's generic error`,
			got.kind === 'error' &&
				got.error === 'NetworkError: Error retrieving a token.',
			JSON.stringify(got),
		);
	}

	// 7. IdentityCredential.disconnect routes and resolves through the proxy
	{
		const run = `disc-${mode}-${Date.now()}`;
		const disc = await callStatic(frame, 'disconnect', {
			configURL: configOf(sameOrigin, run),
			clientId: 'stomp-rp',
			accountHint: 'acct-1',
		});
		const log = await logOf(run);
		ok(
			`${mode}: IdentityCredential.disconnect routes through the proxy and resolves`,
			disc === 'undefined' && log.disconnect?.dest === 'webidentity',
			JSON.stringify({ disc, log: log.disconnect }),
		);
	}

	// 8. nothing escaped the proxy: no raw request, no proxy-origin IdP request
	await sleep(1000);
	const outside = recorder.log.filter(
		(entry) =>
			entry.kind === 'raw' || (entry.kind === 'proxy' && idp(entry.url)),
	);
	ok(
		`${mode}: no FedCM request left past the service worker`,
		outside.length === 0,
		JSON.stringify(outside.map((entry) => [entry.kind, entry.url])).slice(
			0,
			2000,
		),
	);

	ok(
		`${mode}: the page raised no uncaught error`,
		page.errors.length === 0,
		JSON.stringify(page.errors),
	);
	await page.close();
}
await done(browser, ref.errors);
