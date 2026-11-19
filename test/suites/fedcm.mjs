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
//
// A provider's well-known file, config, accounts list and client metadata are
// read by the browser in its own process, with no CORS check (Google sends no
// Access-Control-Allow-Origin for them); only the token and disconnect POSTs
// are CORS requests of the relying party's origin. The `nocors` scenarios run
// natively (Chrome's own chooser, driven over CDP) and through the proxy
// against endpoints that send no CORS header, and compare the two: what
// succeeds, what fails and how, what each request carried, and that page
// code sees nothing of the accounts the provider listed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
	CHROME,
	done,
	FIXTURE,
	frameTarget,
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
const crossHost = `localhost:${fixture.port}`;
const configOf = (origin, run, extra = '') =>
	`${origin}/pages/fedcm-config.json?k=${run}${extra}`;
const absoluteConfig = `${sameOrigin}/pages/fedcm-config.json`;
/** an account's address the provider lists: natively no page code ever sees it */
const NEEDLE = 'ada@idp.test';

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
	'preventSilentAccess',
];

const logOf = (run) =>
	fetch(`${FIXTURE}pages/fedcm-log?k=${run}`)
		.then((r) => r.json())
		.catch(() => ({}));
const wellKnownLog = () =>
	fetch(`${FIXTURE}pages/fedcm-log?wk`)
		.then((r) => r.json())
		.catch(() => []);
/** what the cross-site provider's well-known file answers: a body, a status, or the default (null) */
const setWellKnown = (body) =>
	fetch(
		`${FIXTURE}pages/fedcm-wellknown?host=${crossHost}` +
			(body === null
				? ''
				: typeof body === 'number'
					? `&status=${body}`
					: `&body=${encodeURIComponent(JSON.stringify(body))}`),
	).then((r) => r.json());

/**
 * The scenarios run natively and through the proxy against the cross-site
 * provider. `nocors` lists the endpoints that answer with no CORS header;
 * `wellKnown` is what its well-known file says (`listed`: it names the
 * config); `pick`: the chooser is shown, and its first account picked
 */
const CORS_SCENARIOS = [
	{
		name: 'the well-known file, config, accounts and client metadata need no CORS',
		nocors: 'config,accounts,client',
		wellKnown: 'listed',
		pick: true,
	},
	{
		name: 'the token POST still needs CORS',
		nocors: 'config,accounts,client,token',
		wellKnown: 'listed',
		pick: true,
	},
	{
		name: 'a token answer of 503 says so',
		nocors: 'config,accounts,client',
		extra: '&status=503',
		wellKnown: 'listed',
		pick: true,
	},
	{
		name: 'a provider of another site whose well-known file is missing is refused',
		nocors: 'config,accounts,client',
		wellKnown: 404,
	},
	{
		name: 'a well-known file that does not name the config is refused',
		nocors: 'config,accounts,client',
		wellKnown: null,
	},
	{
		name: 'a config whose accounts endpoint is of another origin is refused',
		nocors: 'config,accounts,client',
		extra: `&xo=${encodeURIComponent(sameOrigin)}`,
		wellKnown: 'listed',
	},
	{
		name: 'disconnect reads the config with no CORS',
		nocors: 'config',
		wellKnown: 'listed',
		disconnect: true,
	},
	{
		name: 'disconnect still needs CORS',
		nocors: 'config,disconnect',
		wellKnown: 'listed',
		disconnect: true,
	},
];
const scenarioConfig = (scenario, run) =>
	configOf(
		crossOrigin,
		run,
		`&nocors=${scenario.nocors}${scenario.extra ?? ''}`,
	);
const prepare = async (scenario, configURL) =>
	setWellKnown(
		scenario.wellKnown === 'listed'
			? { provider_urls: [configURL] }
			: scenario.wellKnown,
	);

/**
 * Whether the user is asked at all, in order: natively in a regular
 * profile's first visit (Chrome 157 measured: an incognito profile never
 * signs in automatically, and nothing tells STomp which it is), proxied
 * after the steps above, which leave the site free to sign in
 * automatically (their last sign-in was a pick). Each step against the
 * cross-site provider with no CORS: its mediation, `extra` for its config
 * (`multi`: a second, new account), `act` in the chooser if one shows
 * (`pick` the `index`th account, `close` it), `prevent`: the page calls
 * preventSilentAccess() first
 */
const MEDIATION = [
	{
		name: 'a silent request signs the one returning account in automatically',
		mediation: 'silent',
	},
	{
		name: 'right after an automatic sign-in an optional request shows the chooser',
		mediation: 'optional',
		act: 'pick',
	},
	{
		name: 'after a pick a silent request signs in automatically again',
		mediation: 'silent',
	},
	{
		name: 'right after an automatic sign-in a silent request fails before any request',
		mediation: 'silent',
	},
	{ name: 'conditional mediation is not supported', mediation: 'conditional' },
	{
		name: 'a required request always shows the chooser',
		mediation: 'required',
		act: 'pick',
	},
	{
		name: 'after preventSilentAccess() a silent request fails before any request',
		mediation: 'silent',
		prevent: true,
	},
	{
		name: 'after preventSilentAccess() an optional request shows the chooser',
		mediation: 'optional',
		act: 'pick',
	},
	{
		name: 'a pick ends preventSilentAccess(): an optional request signs in automatically',
		mediation: 'optional',
	},
	{
		name: 'a new account beside a returning one: the client metadata is asked for, and a pick of it shows the disclosure',
		mediation: 'required',
		extra: '&multi',
		act: 'pick',
		index: 1,
	},
	{
		name: 'two returning accounts: the chooser, the latest signed in with first',
		mediation: 'optional',
		extra: '&multi',
		act: 'pick',
	},
	{
		name: 'two returning accounts: a silent request fails after the accounts',
		mediation: 'silent',
		extra: '&multi',
	},
	{
		name: 'the user closes the chooser: the request fails at once',
		mediation: 'required',
		act: 'close',
	},
	{
		name: 'after the user closed the chooser every request of the site fails before any request',
		mediation: 'required',
		act: 'pick',
	},
];
const fedcmAll = () =>
	fetch(`${FIXTURE}pages/fedcm-log?all`)
		.then((r) => r.json())
		.catch(() => []);

/**
 * One MEDIATION step in `frame` (`host`: the host's page, whose chooser is
 * pressed; null natively, where `native` is the reference's CDP state):
 * how it ended, the chooser shown (each account's name and whether it is
 * new), the endpoints the provider saw, the client metadata requests
 */
async function mediationStep(frame, step, host, native = null) {
	const run = `med-${host ? 'proxied' : 'native'}-${Math.random().toString(36).slice(2)}`;
	const configURL = configOf(
		crossOrigin,
		run,
		`&nocors=config,accounts,client${step.extra ?? ''}`,
	);
	await setWellKnown({ provider_urls: [configURL] });
	const prevented = step.prevent
		? await callStatic(frame, 'preventSilentAccess')
		: null;
	const before = (await fedcmAll()).length;
	let chooser = null;
	let result;
	if (native) {
		native.step = step;
		native.dialogs = [];
		result = await runScenario(frame, 'flow', {
			configURL,
			mediation: step.mediation,
		});
		chooser = native.dialogs[0] ?? null;
	} else {
		await frame.evaluate((a) => window.startScenario('flow', a), {
			configURL,
			mediation: step.mediation,
		});
		for (const end = Date.now() + 15000; Date.now() < end; await sleep(150)) {
			result = await frame.evaluate(() => window.readDone()).catch(() => null);
			if (result) break;
			const shown = await hostChooser(host);
			if (!shown) continue;
			chooser = shown.accounts.map(
				(account) =>
					`${account.label.split(',')[0]}${account.state === 'sign-up' ? ' (new)' : ''}`,
			);
			await press({
				session: shown.session,
				frameId: shown.frameId,
				backendNodeId:
					step.act === 'pick'
						? shown.accounts[step.index ?? 0].backendNodeId
						: shown.close,
			});
			result = await frame.evaluate(() => window.readPending());
			break;
		}
		result ??= { kind: 'error', error: 'no answer' };
	}
	await setWellKnown(null);
	const log = await logOf(run);
	const client = (await fedcmAll())
		.slice(before)
		.filter((entry) => entry.url.includes('fedcm-client'))
		.map((entry) => ({
			query: new URL(entry.url, 'http://x').search,
			dest: entry.dest,
			mode: entry.mode,
			site: entry.site,
			origin: entry.origin,
			referer: entry.referer,
			cookie: /fedcm_sid/.test(entry.cookie ?? ''),
		}));
	return {
		result:
			result.kind === 'token'
				? `token ${result.token} auto=${result.isAutoSelected}`
				: result.error,
		chooser,
		steps: Object.keys(log),
		disclosure: log.token?.disclosureTextShown ?? null,
		client,
		prevented,
	};
}

/** what of a step's request is compared natively and through the proxy */
const shapeOf = (step) =>
	step && {
		dest: step.dest,
		mode: step.mode,
		site: step.site,
		origin: step.origin,
		referer: step.referer,
		cookie: /fedcm_sid=yes/.test(step.cookie ?? ''),
	};

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

const attribute = (node, name) => {
	const list = node.attributes ?? [];
	for (let i = 0; i + 1 < list.length; i += 2)
		if (list[i] === name) return list[i + 1];
	return null;
};
/** the buttons under `node` (shadow roots included), in order */
const buttonsOf = (node, out = []) => {
	if (node.nodeName === 'BUTTON') out.push(node);
	for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])])
		buttonsOf(child, out);
	return out;
};
/** the buttons of the shadow root under `node` that has a Close button (the chooser's) */
const chooserButtonsOf = (node) => {
	if (node.nodeName === '#document-fragment') {
		const buttons = buttonsOf(node);
		if (buttons.some((button) => attribute(button, 'aria-label') === 'Close'))
			return buttons;
	}
	for (const child of [
		...(node.children ?? []),
		...(node.shadowRoots ?? []),
		// (a frame of the page's process too: wherever the chooser is drawn)
		...(node.contentDocument ? [node.contentDocument] : []),
	]) {
		const found = chooserButtonsOf(child);
		if (found) return found;
	}
	return null;
};
/**
 * The proxied chooser, which the host's page draws (src/controller/
 * accountChooser.ts), read over CDP wherever it is (its shadow root is
 * closed: no Playwright locator reaches it): its account buttons
 * (accessible name, `sign-in` or `sign-up`) and its close button, or null
 * when it is not shown
 */
async function hostChooser(page) {
	const { session, frameId } = await frameTarget(page.mainFrame());
	try {
		const { root } = await session.send('DOM.getDocument', {
			depth: -1,
			pierce: true,
		});
		const buttons = chooserButtonsOf(root) ?? [];
		const accounts = buttons
			.filter((node) => attribute(node, 'aria-label') !== 'Close')
			.map((node) => ({
				label: attribute(node, 'aria-label'),
				state: attribute(node, 'data-state') ?? 'sign-in',
				backendNodeId: node.backendNodeId,
			}));
		const close = buttons.find(
			(node) => attribute(node, 'aria-label') === 'Close',
		);
		if (!accounts.length || !close) {
			await session.detach().catch(() => {});
			return null;
		}
		return { session, frameId, accounts, close: close.backendNodeId };
	} catch (error) {
		await session.detach().catch(() => {});
		return null;
	}
}
/**
 * A button of the proxied chooser whose accessible name matches `label`
 * (hostChooser), or null when none shows in time
 */
async function chooserButton(page, label, timeout = 10000) {
	for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) {
		const chooser = await hostChooser(page);
		if (!chooser) continue;
		const node = label.test('Close')
			? chooser.close
			: chooser.accounts.find((account) => label.test(account.label))
					?.backendNodeId;
		if (node)
			return {
				session: chooser.session,
				frameId: chooser.frameId,
				backendNodeId: node,
			};
		await chooser.session.detach().catch(() => {});
	}
	return null;
}
/** click a chooser button chooserButton found, from a world of its own */
async function press(button) {
	const { session, frameId, backendNodeId } = button;
	try {
		const { executionContextId } = await session.send(
			'Page.createIsolatedWorld',
			{ frameId, worldName: 'fedcm-chooser' },
		);
		const { object } = await session.send('DOM.resolveNode', {
			backendNodeId,
			executionContextId,
		});
		await session.send('Runtime.callFunctionOn', {
			objectId: object.objectId,
			functionDeclaration: 'function () { this.click(); }',
		});
		return true;
	} catch (error) {
		return false;
	} finally {
		await session.detach().catch(() => {});
	}
}
async function pressChooser(page, label) {
	const button = await chooserButton(page, label);
	return button ? press(button) : false;
}

const runScenario = (frame, name, params = {}) =>
	frame.evaluate((a) => window.runScenario(a.name, a.params), { name, params });
const callStatic = (frame, name, arg) =>
	frame.evaluate((a) => window.callStatic(a.name, a.arg), { name, arg });

/**
 * One CORS scenario in `frame`, natively (`chooser` null: the browser's
 * own chooser, which the reference's CDP session picks from) or through the
 * proxy (`chooser`: the overlay is pressed): its result, and what each step
 * of it carried
 */
async function corsScenario(frame, scenario, native, host = null) {
	const run = `cors-${native ? 'native' : 'proxied'}-${Math.random().toString(36).slice(2)}`;
	const configURL = scenarioConfig(scenario, run);
	await prepare(scenario, configURL);
	await frame.evaluate((o) => window.signIn(o), crossOrigin);
	const before = (await wellKnownLog()).length;
	let result;
	if (scenario.disconnect)
		result = await callStatic(frame, 'disconnect', {
			configURL,
			clientId: 'stomp-rp',
			accountHint: 'acct-1',
		});
	else if (!native) {
		await frame.evaluate((a) => window.startScenario('flow', a), {
			configURL,
			mediation: 'required',
		});
		if (scenario.pick) {
			const pressed = await pressChooser(host, /Ada Proxy/);
			result = pressed
				? await frame.evaluate(() => window.readPending())
				: { kind: 'error', error: 'no chooser' };
		} else {
			// (a chooser that should not have been shown is closed)
			result = await frame.evaluate(() =>
				Promise.race([
					window.readPending(),
					new Promise((resolve) =>
						setTimeout(
							() => resolve({ kind: 'error', error: 'a chooser was shown' }),
							15000,
						),
					),
				]),
			);
			if (result.error === 'a chooser was shown')
				await pressChooser(host, /^Close$/);
		}
	} else
		result = await runScenario(frame, 'flow', {
			configURL,
			mediation: 'required',
		});
	await setWellKnown(null);
	const log = await logOf(run);
	const wellKnown = (await wellKnownLog())
		.slice(before)
		.filter((entry) => entry.host === crossHost);
	return {
		result:
			typeof result === 'string'
				? result
				: result.kind === 'token'
					? `token ${result.token}`
					: `${result.error}${'code' in result ? ` [${result.code}|${result.url}]` : ''}`,
		shapes: {
			wellKnown: shapeOf(wellKnown.at(-1)),
			config: shapeOf(log.config),
			accounts: shapeOf(log.accounts),
			token: shapeOf(log.token),
			disconnect: shapeOf(log.disconnect),
		},
	};
}

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
	// the browser's own chooser picks its first account (CDP), and its error
	// dialog is closed
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('FedCm.enable', { disableRejectionDelay: true });
	// (`held`: the next chooser stays open until the suite picks)
	let held = null;
	cdp.on('FedCm.dialogShown', ({ dialogId, dialogType }) => {
		if (held && dialogType === 'AccountChooser') return held(dialogId);
		(dialogType === 'AccountChooser'
			? cdp.send('FedCm.selectAccount', { dialogId, accountIndex: 0 })
			: cdp.send('FedCm.dismissDialog', { dialogId })
		).catch(() => {});
	});
	const cors = [];
	for (const scenario of CORS_SCENARIOS)
		cors.push(await corsScenario(page.mainFrame(), scenario, true));
	// and with the page watching all it can be handed
	const spiedRun = `spied-native-${Date.now()}`;
	const spiedConfig = scenarioConfig(CORS_SCENARIOS[0], spiedRun);
	await prepare(CORS_SCENARIOS[0], spiedConfig);
	await page.evaluate((o) => window.signIn(o), crossOrigin);
	const spied = await page.evaluate(
		(a) => window.runSpied('flow', a.params, a.needle),
		{
			params: { configURL: spiedConfig, mediation: 'required' },
			needle: NEEDLE,
		},
	);
	await setWellKnown(null);
	// what page code can tell while the browser's chooser shows
	const seenRun = `seen-native-${Date.now()}`;
	const seenConfig = scenarioConfig(CORS_SCENARIOS[0], seenRun);
	await prepare(CORS_SCENARIOS[0], seenConfig);
	await page.evaluate(() => window.watchPage());
	const shown = new Promise((resolve) => (held = resolve));
	await page.evaluate((a) => window.startScenario('flow', a), {
		configURL: seenConfig,
		mediation: 'required',
	});
	const dialogId = await Promise.race([shown, sleep(15000)]);
	held = null;
	const seen = dialogId
		? await page.evaluate(() => window.pageSeen())
		: 'no chooser';
	if (dialogId)
		await cdp.send('FedCm.selectAccount', { dialogId, accountIndex: 0 });
	await page.evaluate(() => window.readPending());
	await setWellKnown(null);
	// a page that replaced Math and the timers sees none of them called
	const watched = await watchedRuns(page.mainFrame(), null);
	await browser.close();
	const mediation = await mediationReference();
	return {
		detect,
		validation,
		statics,
		cors,
		spied,
		seen,
		watched,
		mediation,
		errors,
	};
}

/** the settled result of what `frame` started (startWatched), or a timeout */
const settled = (frame, ms = 15000) =>
	frame.evaluate((ms) => window.readPendingWithin(ms), ms);

/**
 * Requests made by a page that replaced Math's members and its timers
 * (startWatched): one whose chooser is picked from (natively the
 * reference's CDP session picks; through the proxy `host`'s chooser is
 * pressed), and one whose config is missing (a failure before the
 * chooser, held for Chrome's delay unless `?fedcm=test` or CDP drops it)
 */
async function watchedRuns(frame, host, ms = 15000) {
	await frame.evaluate((a) => window.startWatched('flow', a), {
		configURL: configOf(sameOrigin, `watched-${Date.now()}`),
		mediation: 'required',
	});
	if (host) await pressChooser(host, /Ada Proxy/);
	const picked = await settled(frame);
	await frame.evaluate((a) => window.startWatched('flow', a), {
		configURL: `${sameOrigin}/pages/fedcm-missing.json`,
		mediation: 'required',
	});
	const failed = await settled(frame, ms);
	return { picked, failed };
}

/**
 * MEDIATION natively, in a regular profile of its own (an incognito one,
 * every context Playwright makes but a persistent one, never signs in
 * automatically); a chooser is picked from or closed (Chrome's close
 * button, which starts the site's cooldown) as each step says
 */
async function mediationReference() {
	const profile = mkdtempSync(join(tmpdir(), 'stomp-fedcm-'));
	const context = await chromium.launchPersistentContext(profile, {
		executablePath: CHROME,
		headless: true,
		args: [
			'--no-sandbox',
			'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1',
		],
	});
	try {
		const page = await context.newPage();
		await page.goto(target);
		await page.waitForFunction(() => window.__fedcm?.ready === true, null, {
			timeout: 20000,
		});
		const cdp = await context.newCDPSession(page);
		await cdp.send('FedCm.enable', { disableRejectionDelay: true });
		const native = { step: null, dialogs: [] };
		cdp.on('FedCm.dialogShown', ({ dialogId, dialogType, accounts }) => {
			if (dialogType !== 'AccountChooser')
				return cdp.send('FedCm.dismissDialog', { dialogId }).catch(() => {});
			native.dialogs.push(
				accounts.map(
					(account) =>
						`${account.name}${account.loginState === 'SignUp' ? ' (new)' : ''}`,
				),
			);
			(native.step?.act === 'pick'
				? cdp.send('FedCm.selectAccount', {
						dialogId,
						accountIndex: native.step.index ?? 0,
					})
				: cdp.send('FedCm.dismissDialog', { dialogId, triggerCooldown: true })
			).catch(() => {});
		});
		await page.evaluate((o) => window.signIn(o), crossOrigin);
		const steps = [];
		for (const step of MEDIATION)
			steps.push(await mediationStep(page.mainFrame(), step, null, native));
		return steps;
	} finally {
		await context.close();
		rmSync(profile, { recursive: true, force: true });
	}
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
// what Chrome does (measured in Chrome 157): the reference itself, so a
// Chrome that changed shows here and not as a proxy failure
ok(
	'natively a provider of another site with no CORS on its config, accounts and metadata signs in; its token still needs CORS',
	ref.cors[0].result === 'token idtok.acct-1.false.n0' &&
		ref.cors[1].result ===
			'IdentityCredentialError: Error retrieving a token. [|]' &&
		ref.cors[2].result ===
			'IdentityCredentialError: Error retrieving a token. [temporarily_unavailable|]' &&
		ref.cors[6].result === 'undefined' &&
		ref.cors[7].result === 'NetworkError: Error disconnecting account.',
	JSON.stringify(ref.cors.map((entry) => entry.result)),
);
ok(
	'natively the no-cors steps carry no Origin and no Referer, the token POST the relying party origin',
	ref.cors[0].shapes.config?.mode === 'no-cors' &&
		ref.cors[0].shapes.config?.origin === null &&
		ref.cors[0].shapes.accounts?.mode === 'no-cors' &&
		ref.cors[0].shapes.accounts?.cookie === true &&
		ref.cors[0].shapes.token?.mode === 'cors' &&
		ref.cors[0].shapes.token?.origin === sameOrigin,
	JSON.stringify(ref.cors[0].shapes),
);
ok(
	'natively page code sees nothing of the accounts the provider listed',
	ref.spied.result?.kind === 'token' && ref.spied.leaked === false,
	JSON.stringify(ref.spied),
);
ok(
	'natively page code cannot tell the chooser is shown',
	JSON.stringify(ref.seen) ===
		JSON.stringify({
			mutations: 0,
			focus: 0,
			resized: 0,
			count: 0,
			hits: true,
			active: true,
			focused: true,
		}),
	JSON.stringify(ref.seen),
);
// what Chrome 157 did when this was written (a regular profile)
{
	const m = ref.mediation;
	ok(
		'natively a returning account signs in automatically, then not again until a pick; preventSilentAccess() the same; conditional is refused; a closed chooser cools the site down',
		m[0].result === 'token idtok.acct-1.true.n0 auto=true' &&
			m[0].chooser === null &&
			m[1].result === 'token idtok.acct-1.false.n0 auto=false' &&
			m[1].chooser !== null &&
			m[2].result === 'token idtok.acct-1.true.n0 auto=true' &&
			m[3].steps.length === 0 &&
			/^NotSupportedError/.test(m[4].result) &&
			m[6].steps.length === 0 &&
			m[7].chooser !== null &&
			m[8].result === 'token idtok.acct-1.true.n0 auto=true' &&
			m[12].result === 'NetworkError: Error retrieving a token.' &&
			m[13].steps.length === 0 &&
			m[13].chooser === null,
		JSON.stringify(m.map((step) => [step.result, step.chooser, step.steps])),
	);
	ok(
		'natively the client metadata is asked for only with a new account, by the client id alone, with the relying party Origin',
		m.every((step, i) =>
			i === 9 ? step.client.length === 1 : !step.client.length,
		) &&
			m[9].client[0]?.query === '?client_id=stomp-rp' &&
			m[9].client[0]?.origin === sameOrigin &&
			m[9].disclosure === 'true' &&
			JSON.stringify(m[10].chooser) ===
				JSON.stringify(['Bo Guest', 'Ada Proxy']),
		JSON.stringify(
			m.map((step) => [step.client, step.disclosure, step.chooser]),
		),
	);
}
ok(
	'natively a page that replaced Math and its timers sees none of them called by a FedCM request',
	ref.watched.picked.result === 'token idtok.acct-1.false.n0' &&
		JSON.stringify(ref.watched.picked.calls) === '{}' &&
		ref.watched.failed.result === 'NetworkError: Error retrieving a token.' &&
		JSON.stringify(ref.watched.failed.calls) === '{}',
	JSON.stringify(ref.watched),
);
const browser = await launch();
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	// (`?fedcm=test`: no delays, as the reference has none)
	const page = await openDemo(browser, `${base}?fedcm=test`);
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

	// 1b. the page's first identity request, made after it replaced Symbol:
	//     the flow (made at that request) keeps none of the page's globals,
	//     so a provider that fails quietly still hands on to the next
	{
		const run = `own-symbol-${mode}-${Date.now()}`;
		await frame.evaluate((o) => window.signIn(o), sameOrigin);
		const got = await frame.evaluate(
			(a) => window.runWithOwnSymbol('secondProvider', a),
			{
				configURL: configOf(sameOrigin, run),
				missing: `${sameOrigin}/pages/fedcm-missing.json`,
				mediation: 'optional',
			},
		);
		ok(
			`${mode}: a first identity request after the page replaced Symbol passes a failed provider on to the next`,
			got.kind === 'token' && got.token === 'idtok.acct-1.true.n0',
			JSON.stringify(got),
		);
	}

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

	// 4. a whole flow completes and resolves a token through the proxy, the
	//    account picked in the chooser (1b signed in automatically: the
	//    site may not again for a while, see 9); every step went to the IdP
	//    labelled webidentity, config without the IdP cookie, accounts with it
	//    (a provider of another site lists the config in its well-known file)
	for (const [label, origin] of [
		['same-site IdP', sameOrigin],
		['cross-site IdP', crossOrigin],
	]) {
		const run = `auto-${mode}-${label.replace(/\W/g, '')}-${Date.now()}`;
		await frame.evaluate((o) => window.signIn(o), origin);
		if (origin === crossOrigin)
			await setWellKnown({ provider_urls: [configOf(origin, run)] });
		await frame.evaluate((a) => window.startScenario('flow', a), {
			configURL: configOf(origin, run),
			mediation: 'required',
		});
		const got = (await pressChooser(page, /Ada Proxy/))
			? await frame.evaluate(() => window.readPending())
			: { kind: 'no chooser' };
		await setWellKnown(null);
		const log = await logOf(run);
		ok(
			`${mode}: ${label}: get({identity}) resolves an IdentityCredential token through the proxy`,
			got.kind === 'token' &&
				got.token === 'idtok.acct-1.false.n0' &&
				got.isAutoSelected === false &&
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
				log.token?.isAutoSelected === 'false' &&
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

	// 4b. endpoints that send no CORS header, as a real provider's: the flow
	//     ends as it does natively, every step carried what Chrome's did
	{
		const cors = [];
		for (const scenario of CORS_SCENARIOS)
			cors.push(await corsScenario(frame, scenario, false, page));
		CORS_SCENARIOS.forEach((scenario, i) =>
			ok(
				`${mode}: ${scenario.name}, as natively`,
				cors[i].result === ref.cors[i].result,
				JSON.stringify({ proxied: cors[i].result, native: ref.cors[i].result }),
			),
		);
		ok(
			`${mode}: each step of a sign-in with no CORS carried what Chrome's did (mode, site, Origin, Referer, cookie)`,
			JSON.stringify(cors[0].shapes) === JSON.stringify(ref.cors[0].shapes),
			JSON.stringify({ proxied: cors[0].shapes, native: ref.cors[0].shapes }),
		);
	}

	// 4c. page code sees nothing of the accounts the provider listed: not in
	//     anything a script of its own is handed during the flow, nor in the
	//     chooser, whose shadow root it cannot reach
	{
		const run = `spied-${mode}-${Date.now()}`;
		const configURL = scenarioConfig(CORS_SCENARIOS[0], run);
		await prepare(CORS_SCENARIOS[0], configURL);
		await frame.evaluate((o) => window.signIn(o), crossOrigin);
		await frame.evaluate(() => window.watchPage());
		await frame.evaluate((a) => window.startSpied('flow', a.params, a.needle), {
			params: { configURL, mediation: 'required' },
			needle: NEEDLE,
		});
		const button = await chooserButton(page, /Ada Proxy/);
		const peeked = button
			? await frame.evaluate(() => window.peekChooser())
			: null;
		const seen = button ? await frame.evaluate(() => window.pageSeen()) : null;
		const pressed = button ? await press(button) : false;
		const spied = pressed
			? await frame.evaluate(() => window.readPending())
			: null;
		await setWellKnown(null);
		ok(
			`${mode}: page code sees nothing of the accounts the provider listed`,
			spied?.result?.kind === 'token' && spied.leaked === false,
			JSON.stringify(spied),
		);
		ok(
			`${mode}: the account chooser is out of page code's reach (no shadow root, window.find, text or serialization shows it)`,
			peeked !== null &&
				peeked.shadowRoots === 0 &&
				!peeked.find &&
				!peeked.text &&
				!peeked.html,
			JSON.stringify(peeked),
		);
		// natively the chooser is the browser's: the page's document, its
		// layout, what is hit where and the focus change in no way while it
		// shows (the host's page draws it here, over the frame)
		ok(
			`${mode}: page code cannot tell the chooser is shown (no change to its document, layout, hit testing or focus), as natively`,
			seen !== null && JSON.stringify(seen) === JSON.stringify(ref.seen),
			JSON.stringify({ proxied: seen, native: ref.seen }),
		);
	}

	// 5. the chooser: a forced prompt selects an account and mints a token
	{
		const run = `pick-${mode}-${Date.now()}`;
		await frame.evaluate((a) => window.startScenario('flow', a), {
			configURL: configOf(sameOrigin, run),
			mediation: 'required',
		});
		const pressed = await pressChooser(page, /Ada Proxy/);
		const got = pressed
			? await frame.evaluate(() => window.readPending())
			: { kind: 'no chooser' };
		ok(
			`${mode}: choosing an account in the chooser mints a token (not auto-selected)`,
			got.kind === 'token' &&
				got.token === 'idtok.acct-1.false.n0' &&
				got.isAutoSelected === false,
			JSON.stringify(got),
		);
	}

	// 5b. a page that replaced Math's members and its timers before asking
	//     sees none of them called, as natively (the browser's own UI runs
	//     nothing of the page's); `?fedcm=test` drops the delays here, so
	//     8b runs the held failure in a tab without it
	{
		const watched = await watchedRuns(frame, page);
		ok(
			`${mode}: a FedCM request calls none of the page's Math members, setTimeout, setInterval or Date.now, as natively`,
			JSON.stringify(watched) === JSON.stringify(ref.watched),
			JSON.stringify({ proxied: watched, native: ref.watched }),
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

	// 8b. without the suites' flag, a token is held three seconds after its
	//     request, as Chrome holds it (another tab of the demo: another
	//     controller, the same worker and sign-ins)
	if (mode === 'same-origin') {
		const plain = await openDemo(browser, base);
		await submitLanding(plain, target);
		const plainFrame = await proxiedFrame(plain);
		const run = `hold-${Date.now()}`;
		await plainFrame?.evaluate((a) => window.startScenario('flow', a), {
			configURL: configOf(sameOrigin, run),
			mediation: 'required',
		});
		const pressed = plainFrame ? await pressChooser(plain, /Ada Proxy/) : false;
		const at = Date.now();
		const got = pressed
			? await plainFrame.evaluate(() => window.readPending())
			: { kind: 'no chooser' };
		const held = Date.now() - at;
		ok(
			`${mode}: a token resolves three seconds after its request, as Chrome holds it`,
			got.kind === 'token' && held >= 2700 && held < 6000,
			JSON.stringify({ got: got.kind, held }),
		);
		// (5b with Chrome's delays: the token held, a failure before the
		// chooser held at random, never past 60 s, and the page's Math.random
		// answering NaN chooses nothing)
		const watched = plainFrame
			? await watchedRuns(plainFrame, plain, 70000)
			: null;
		ok(
			`${mode}: with Chrome's delays a FedCM request calls none of the page's Math members or timers, as natively`,
			JSON.stringify(watched) === JSON.stringify(ref.watched),
			JSON.stringify({ proxied: watched, native: ref.watched }),
		);
		await plain.close();
	}

	// 9. when the user is asked at all, by mediation and by what the browser
	//    keeps of the site's sign-ins, step by step as natively (MEDIATION)
	{
		const steps = [];
		for (const step of MEDIATION)
			steps.push(await mediationStep(frame, step, page));
		MEDIATION.forEach((step, i) =>
			ok(
				`${mode}: ${step.name}, as natively`,
				JSON.stringify(steps[i]) === JSON.stringify(ref.mediation[i]),
				JSON.stringify({ proxied: steps[i], native: ref.mediation[i] }),
			),
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
