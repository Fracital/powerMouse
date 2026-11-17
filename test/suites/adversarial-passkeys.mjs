// STomp as the passkey provider of proxied sites (docs/passkeys.md), against
// a page that stays inside the inject's hooks and tries to get a credential
// made or asserted for a relying party it is not, to make the host's sheet
// name a site it is not, or to learn what it would not learn natively. Every
// case runs through the demo in both modes (same-origin controller on
// 127.0.0.1, isolated host on localhost) and, wherever Chrome has an answer,
// natively against Chrome's virtual authenticator (CDP WebAuthn) with the
// same relying party (test/passkeys-rp.mjs), whose words are the oracle.
//
//   1. another site's relying party id: pkP-b.co.uk asks for pkP-a.co.uk's
//      in create(), get() and each signal static
//   2. registrable-suffix tricks: a public suffix, a private one, a trailing
//      dot, the own host in capitals, a port, an address, an origin
//   3. a cross-site frame: the policy's refusal, the activation's refusal
//      (B, the embedding page, has one, the frame none: every proxied frame
//      is of one real origin, and Chrome shows an activation to the frames
//      of the activated one's origin; and with the page's own
//      userActivation replaced), and a real click,
//      whose sheet names the frame's site and its top, and whose client
//      data the relying party verifies as crossOrigin with B's topOrigin
//   4. forged messages: what the inject posts to the service worker, and
//      what the controller's RPC looks like, posted through every path a
//      hooked page reaches; and a page of B whose document claims to be A
//   5. replay: an assertion and an attestation of A submitted again to A,
//      or to B's endpoints (a phishing relay of B's challenge)
//   6. enumeration: whether a credential is held must not show in the
//      error, the time a request takes before the user acts, or the
//      capability statics
//
// Every refusal is checked three ways: the page's error is Chrome's, no
// sheet showed in the host's page (the demo's #passkeyPrompt, recorded as it
// is added), and the store (controller.passkeys.list() from the demo's page)
// is unchanged. A sheet that shows when it must not is answered with Create
// or the first account, so a hole ends in a credential the checks see.
// Nothing passes vacuously: each group has a legitimate control that must
// show the sheet and that the relying party verifies.
//
// What would have to change for these to fail (none can be shown without a
// build, which this suite never does):
// - case 1 and 2: src/server/passkeys.ts passkeyCeremony returning the
//   ceremony without `if ('error' in party) return party;` after
//   relyingPartyOf, or src/passkeys/rpId.ts relyingPartyOf taking `claimed`
//   without its checks; the inject's own checks are not the boundary
// - case 3: the worker's `allowed` (doc.allFeatures) for the policy, the
//   inject's userActivation check (src/inject/dom/passkeys.ts create) for the
//   activation, `topOrigin` in passkeyCeremony for the sheet's line
// - case 4: the worker's `source?.url.startsWith(...)` and
//   `ready.realURL(source.url)` in the PASSKEY handler of
//   src/server/serviceWorker.ts (taking the origin from the message would
//   fail the escape-world control `claims A`), and the controllers' RPC
//   listeners taking messages from any window
// - case 5: the authenticator's clientData origin and rpIdHash
//   (src/passkeys/authenticator.ts)
// - case 6: runCeremony's ask() before any refusal that depends on what is
//   held (an early `refused()` for an unknown id would answer before the
//   user acts)
//
// The gate's rule (test/adversarial.mjs): a check listed in KNOWN_OPEN that
// fails passes as known open, one that passes again fails (the entry is
// stale), and an unlisted failure fails the suite.
import { createHash, randomBytes } from 'node:crypto';
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	recordRequests,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { startPasskeysRP } from '../passkeys-rp.mjs';

// The checks that fail on purpose, keyed by the check's name after
// `<mode>: `, each with its reason (or `{ why, modes }`): none.
const KNOWN_OPEN = {};

const rp = await startPasskeysRP();
const H = rp.hosts;
const ORIGIN = Object.fromEntries(
	Object.entries(H).map(([key, host]) => [key, rp.origin(host)]),
);
const errors = [];
const show = (value) => (JSON.stringify(value) ?? 'undefined').slice(0, 1500);
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];
const ALLOW = 'publickey-credentials-get; publickey-credentials-create';
const NOT_ALLOWED =
	'NotAllowedError: The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (text) => createHash('sha256').update(text).digest();
/** a credential id nobody holds */
const RANDOM_ID = b64url(randomBytes(32));

// --- the gate ---

const entries = Object.fromEntries(
	Object.entries(KNOWN_OPEN).map(([key, entry]) => [
		key,
		typeof entry === 'string' ? { why: entry } : entry,
	]),
);
const checked = new Set();
/** one check of the corpus: `key` is its name without the mode */
function check(mode, key, condition, detail = '') {
	checked.add(key);
	const name = `${mode}: ${key}`;
	const entry = entries[key];
	if (!entry || (entry.modes && !entry.modes.includes(mode)))
		return ok(name, condition, detail);
	return ok(
		`${name} (known open: ${entry.why})`,
		!condition,
		condition
			? `passes now: the known-open entry is stale and goes - ${detail}`
			: detail,
	);
}
/** where two values differ: each path with both values */
function differences(want, got, path = '', out = []) {
	if (JSON.stringify(want) === JSON.stringify(got)) return out;
	if (
		want &&
		got &&
		typeof want === 'object' &&
		typeof got === 'object' &&
		Array.isArray(want) === Array.isArray(got)
	) {
		for (const key of new Set([...Object.keys(want), ...Object.keys(got)]))
			differences(want[key], got[key], `${path}.${key}`, out);
		return out;
	}
	out.push(
		`${path}: ${show(want).slice(0, 300)} -> ${show(got).slice(0, 300)}`,
	);
	return out;
}
const same = (mode, key, want, got) =>
	check(
		mode,
		key,
		want !== undefined && differences(want, got).length === 0,
		differences(want, got).join('; ').slice(0, 3000) || show(got).slice(0, 300),
	);

// --- in the page: one WebAuthn call a spec names, and how it ended ---

/** installs window.__adv in a page (natively or proxied): start(spec) and read(run) */
function kit() {
	if (window.__adv) return true;
	const describe = (error) =>
		error !== null && typeof error === 'object'
			? `${error.name}: ${error.message}`
			: `thrown ${String(error)}`;
	const unb64 = (text) =>
		Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
			c.charCodeAt(0),
		);
	const random = (length) => crypto.getRandomValues(new Uint8Array(length));
	const ids = (list) =>
		(list ?? []).map((id) => ({ type: 'public-key', id: unb64(id) }));
	const call = (spec) => {
		const timeout = spec.timeout ?? 4000;
		if (spec.op === 'create')
			return navigator.credentials.create({
				publicKey: {
					rp: {
						name: 'Adversary',
						...(spec.rpId !== undefined ? { id: spec.rpId } : {}),
					},
					user: {
						id: spec.userId ? unb64(spec.userId) : random(16),
						name: spec.user ?? 'mallory',
						displayName: 'Mallory',
					},
					challenge: random(32),
					pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
					timeout,
					excludeCredentials: ids(spec.exclude),
					authenticatorSelection: {
						residentKey: 'required',
						requireResidentKey: true,
						userVerification: 'preferred',
					},
				},
			});
		if (spec.op === 'get')
			return navigator.credentials.get({
				...(spec.mediation ? { mediation: spec.mediation } : {}),
				publicKey: {
					...(spec.rpId !== undefined ? { rpId: spec.rpId } : {}),
					challenge: random(32),
					timeout,
					allowCredentials: ids(spec.allow),
					userVerification: 'preferred',
				},
			});
		if (spec.op === 'unknown')
			return PublicKeyCredential.signalUnknownCredential({
				rpId: spec.rpId,
				credentialId: spec.credentialId,
			});
		if (spec.op === 'accepted')
			return PublicKeyCredential.signalAllAcceptedCredentials({
				rpId: spec.rpId,
				userId: spec.userHandle,
				allAcceptedCredentialIds: spec.ids ?? [],
			});
		if (spec.op === 'details')
			return PublicKeyCredential.signalCurrentUserDetails({
				rpId: spec.rpId,
				userId: spec.userHandle,
				name: 'renamed',
				displayName: 'Renamed',
			});
		throw new Error(`no op ${spec.op}`);
	};
	const runs = [];
	const start = (spec) => {
		const run = { done: false };
		runs.push(run);
		const started = performance.now();
		const end = (value) =>
			Object.assign(run, {
				done: true,
				value,
				ms: Math.round(performance.now() - started),
			});
		let promise;
		try {
			promise = call(spec);
		} catch (error) {
			end({ threw: describe(error) });
			return runs.length - 1;
		}
		promise.then(
			(value) =>
				end(
					value && typeof value === 'object' && 'rawId' in value
						? {
								resolved: 'credential',
								id: value.id,
								clientData: JSON.parse(
									new TextDecoder().decode(value.response.clientDataJSON),
								),
							}
						: { resolved: String(value) },
				),
			(error) => end({ rejected: describe(error) }),
		);
		return runs.length - 1;
	};
	window.__adv = {
		start,
		read: (run) => ({ ...runs[run] }),
		statics: async () => {
			const settle = (promise) =>
				promise.then(
					(value) => JSON.stringify(value),
					(error) => describe(error),
				);
			return {
				uvpaa: await settle(
					PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
				),
				conditional: await settle(
					PublicKeyCredential.isConditionalMediationAvailable(),
				),
				capabilities: await settle(PublicKeyCredential.getClientCapabilities()),
			};
		},
	};
	return true;
}

// Code run in a page as the page's own: through the page's Function
// constructor, which the inject hooks and whose body it rewrites, as it
// rewrites every script of the page. An evaluation's own source is not
// rewritten, so a bare `top`, `location` or `eval` in it would read what
// the rewriter keeps from a page (the real top, the proxy's URL): code the
// browser runs unrewritten has escaped the inject, which is not this suite's
// attacker.
const asPage = (fn) => `new Function(${JSON.stringify(`return (${fn})`)})()`;
/** `fn(arg)` in `frame` as the page's own code (a Playwright evaluation: a user activation) */
const inPage = (frame, fn, arg) =>
	frame.evaluate(
		([source, value]) => new Function(`return (${source})`)()(value),
		[String(fn), arg ?? null],
	);

// A frame's main world without a user activation: Playwright's evaluate is
// one (Runtime.callFunctionOn with userGesture), a plain Runtime.evaluate is
// not. `world: 'escaped'` evaluates in an isolated world of the same
// document instead, which has the browser's own natives: what an escaped
// page holds, used here only for the controls of case 4.
const worlds = new Map();
async function worldOf(frame, world = 'main') {
	const key = `${world} ${frame.url()}`;
	const cached = worlds.get(key);
	if (cached?.frame === frame && !frame.isDetached()) return cached;
	const context = frame.page().context();
	let session = null;
	// the frame's own target when it is out of process, else its parent's
	for (let f = frame; f && !session; f = f.parentFrame())
		session = await context
			.newCDPSession(f.parentFrame() ? f : f.page())
			.catch(() => null);
	const contexts = [];
	session.on('Runtime.executionContextCreated', (event) =>
		contexts.push(event.context),
	);
	await session.send('Runtime.enable');
	const { frameTree } = await session.send('Page.getFrameTree');
	const found = [];
	const walk = (tree) => {
		if (tree.frame.url === frame.url()) found.push(tree.frame.id);
		for (const childTree of tree.childFrames ?? []) walk(childTree);
	};
	walk(frameTree);
	let contextId;
	if (world === 'escaped')
		({ executionContextId: contextId } = await session.send(
			'Page.createIsolatedWorld',
			{ frameId: found[0], worldName: 'escaped' },
		));
	else
		contextId = contexts.find(
			(item) =>
				found.includes(item.auxData?.frameId) && item.auxData?.isDefault,
		)?.id;
	if (contextId === undefined) throw new Error(`no context for ${frame.url()}`);
	const entry = {
		frame,
		async run(fn, arg) {
			const result = await session.send('Runtime.evaluate', {
				contextId,
				expression: `${world === 'escaped' ? `(${fn})` : asPage(fn)}(${JSON.stringify(arg ?? null)})`,
				awaitPromise: true,
				returnByValue: true,
				userGesture: false,
			});
			if (result.exceptionDetails)
				throw new Error(
					result.exceptionDetails.exception?.description ??
						result.exceptionDetails.text,
				);
			return result.result.value;
		},
	};
	worlds.set(key, entry);
	return entry;
}
/** `fn(arg)` in the frame's page, with no user activation */
const quiet = async (frame, fn, arg) => (await worldOf(frame)).run(fn, arg);

/** a spec's call in `frame`, waited for up to `guard` ms */
async function ask(frame, spec, { guard = 9000, silent = false } = {}) {
	const evaluate = silent
		? (fn, arg) => quiet(frame, fn, arg)
		: (fn, arg) => inPage(frame, fn, arg);
	await evaluate(kit);
	const run = await evaluate((s) => window.__adv.start(s), spec);
	const started = Date.now();
	while (Date.now() - started < guard) {
		const state = await evaluate((n) => window.__adv.read(n), run);
		if (state?.done) return state.value;
		await sleep(100);
	}
	return { pending: true };
}
/** start a spec's call; `read()` has its state later */
async function begin(frame, spec, silent = false) {
	const evaluate = silent
		? (fn, arg) => quiet(frame, fn, arg)
		: (fn, arg) => inPage(frame, fn, arg);
	await evaluate(kit);
	const run = await evaluate((s) => window.__adv.start(s), spec);
	return {
		read: () => evaluate((n) => window.__adv.read(n), run),
		async end(guard = 9000) {
			for (const started = Date.now(); Date.now() - started < guard;) {
				const state = await evaluate((n) => window.__adv.read(n), run);
				if (state?.done) return state.value;
				await sleep(100);
			}
			return { pending: true };
		},
	};
}
/** how a call ended, as compared: the error's words, or what was made */
const outcome = (value) =>
	value?.rejected ??
	value?.threw ??
	(value?.resolved === 'credential'
		? 'made a credential'
		: value?.resolved
			? `resolved ${value.resolved}`
			: value?.pending
				? 'pending'
				: show(value));

/** a harness ceremony's result (test/pages/passkeys.js), as compared */
const ceremony = (result) =>
	result?.verdict
		? {
				ok: result.verdict.ok,
				error: result.verdict.error ?? null,
				crossOrigin: result.verdict.crossOrigin ?? null,
				topOrigin: result.verdict.topOrigin ?? null,
			}
		: { rejected: result?.rejected ?? result?.harness ?? show(result) };

/** the relying party's endpoints, asked as `host` */
async function rpPost(host, path, body) {
	const response = await fetch(
		`http://127.0.0.1:${rp.port}${path}?pk-host=${host}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
	);
	return response.json();
}

// --- the two sides ---

const AUTHENTICATOR = {
	protocol: 'ctap2',
	ctap2Version: 'ctap2_1',
	transport: 'internal',
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	automaticPresenceSimulation: true,
};
let serial = 0;
const nativeBrowser = await launch(rp.nativeArgs);
/** the relying party's page natively, on a virtual authenticator of its own */
async function nativeOpen(host, query = '') {
	const context = await nativeBrowser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(`native: ${error.message}`));
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send(
		'WebAuthn.addVirtualAuthenticator',
		{ options: AUTHENTICATOR },
	);
	const id = `n${++serial}`;
	await page.goto(`${rp.origin(host)}/pk/page?id=${id}${query}`);
	await page.waitForFunction(() => window.__pk?.ready === true, null, {
		timeout: 40000,
	});
	return {
		top: page.mainFrame(),
		presence: (enabled) =>
			cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
				authenticatorId,
				enabled,
			}),
		close: () => context.close(),
	};
}

const browser = await launch();
/**
 * The demo with passkeys for a test (`?passkeys=test`: timeouts as given),
 * every sheet it shows recorded as it is added, and answered as `mode`
 * says: `accept` (Create, OK or the first account), `cancel`, or `wait`
 */
async function demo(base) {
	const page = await openDemo(browser, `${base}?passkeys=test`);
	const recorder = await recordRequests(page.context());
	await page.evaluate(() => {
		window.__sheets = [];
		new MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes)
					if (node.id === 'passkeyPrompt')
						window.__sheets.push({
							title: node.querySelector('.title')?.textContent ?? '',
							text: node.textContent,
							at: Math.round(performance.now()),
						});
		}).observe(document.body, { childList: true });
	});
	const state = { mode: 'accept', open: true };
	const clicker = (async () => {
		while (state.open) {
			try {
				const box =
					state.mode === 'wait' ? null : await page.$('#passkeyPrompt');
				if (box) {
					const button =
						state.mode === 'accept'
							? ((await box.$('.btn-blu, .account')) ?? (await box.$('.close')))
							: await box.$('.close');
					await button?.click({ timeout: 5000 });
				}
			} catch (error) {
				// the sheet went as it was looked at
			}
			await sleep(50);
		}
	})();
	const sheets = () => page.evaluate(() => window.__sheets);
	return {
		page,
		recorder,
		set mode(mode) {
			state.mode = mode;
		},
		sheets,
		/** the sheets shown since `mark` (a count) */
		since: async (mark) => (await sheets()).slice(mark),
		count: async () => (await sheets()).length,
		/** the store, as the host's page reads it */
		list: () =>
			page.evaluate(async () =>
				(await window.controller.passkeys.list()).map((entry) => ({
					id: entry.id,
					rpId: entry.rpId,
					userName: entry.userName,
					userDisplayName: entry.userDisplayName,
					userHandle: entry.userHandle,
				})),
			),
		clear: () => page.evaluate(() => window.controller.passkeys.clear()),
		/** the open sheet's Cancel or Close, clicked once its guard has passed */
		async cancel() {
			const button = await page.waitForSelector('#passkeyPrompt .close', {
				timeout: 15000,
			});
			await button.click({ timeout: 5000 });
		},
		/** a new tab on the relying party's page: its top frame */
		async open(host, query = '') {
			const id = `p${++serial}`;
			await submitLanding(page, `${rp.origin(host)}/pk/page?id=${id}${query}`);
			for (let i = 0; i < 160; i++) {
				for (const frame of page.mainFrame().childFrames()) {
					const found = await frame
						.evaluate(() => window.__pk?.ready && window.__pk.id)
						.catch(() => null);
					if (found === id) return frame;
				}
				await sleep(250);
			}
			throw new Error(`no proxied page ${id}`);
		},
		async close() {
			state.open = false;
			await clicker;
			errors.push(...page.errors.map((error) => `demo: ${error}`));
			await page.close();
		},
	};
}

/** the frame `top` puts in itself (its harness's ?frame=), asked nothing that activates it */
async function childOf(top) {
	for (let i = 0; i < 160; i++) {
		const [kid] = top.childFrames();
		if (kid) {
			const ready = await quiet(kid, () => window.__pk?.ready === true).catch(
				() => false,
			);
			if (ready) return kid;
		}
		await sleep(250);
	}
	throw new Error(`no frame in ${top.url()}`);
}
/** a frame of A in a page of B, with `allow` or none */
const framedA = (allow) =>
	`&frame=${encodeURIComponent(
		`${ORIGIN.a}/pk/page?id=k${++serial}&top=${encodeURIComponent(ORIGIN.b)}`,
	)}${allow ? `&allow=${encodeURIComponent(allow)}` : ''}`;
/** a harness function run from a real click of the frame's #go */
async function armed(frame, name, ...args) {
	const id = await quiet(frame, ([n, a]) => window.__pk.arm(n, ...a), [
		name,
		args,
	]);
	await frame.click('#go');
	for (let i = 0; i < 400; i++) {
		const state = await quiet(frame, (n) => window.__pk.read(n), id);
		if (state?.done) return state.value;
		await sleep(100);
	}
	return { harness: 'never done' };
}
/** a harness function run with no user activation */
async function quietly(frame, name, ...args) {
	const id = await quiet(frame, ([n, a]) => window.__pk.start(n, ...a), [
		name,
		args,
	]);
	for (let i = 0; i < 400; i++) {
		const state = await quiet(frame, (n) => window.__pk.read(n), id);
		if (state?.done) return state.value;
		await sleep(100);
	}
	return { harness: 'never done' };
}

// --- the cases, as specs ---

/** case 1: what B asks for A's relying party id (`held`: A's credential) */
const crossSite = (held) => ({
	create: { op: 'create', rpId: H.a },
	get: { op: 'get', rpId: H.a },
	'get by its id': { op: 'get', rpId: H.a, allow: [held.id] },
	'conditional get': {
		op: 'get',
		rpId: H.a,
		mediation: 'conditional',
		timeout: 3000,
	},
	signalUnknownCredential: {
		op: 'unknown',
		rpId: H.a,
		credentialId: held.id,
	},
	signalAllAcceptedCredentials: {
		op: 'accepted',
		rpId: H.a,
		userHandle: held.userHandle,
		ids: [],
	},
	signalCurrentUserDetails: {
		op: 'details',
		rpId: H.a,
		userHandle: held.userHandle,
	},
});
/** case 2: relying party ids no page may claim, by the page's host */
const SUFFIXES = [
	[H.a, 'co.uk'],
	[H.a, 'uk'],
	[H.a, 'com'],
	[H.a, `${H.a}.`],
	[H.a, H.a.toUpperCase()],
	[H.a, `${H.a}:443`],
	[H.a, '127.0.0.1'],
	[H.a, '[::1]'],
	[H.a, ORIGIN.a],
	[H.a, ''],
	[H.sub, 'co.uk'],
	[H.ga, 'github.io'],
	[H.ga, 'io'],
	[H.ga, `${H.ga}.`],
];
const SUFFIX_OPS = (rpId) => ({
	create: { op: 'create', rpId },
	get: { op: 'get', rpId },
	signalUnknownCredential: { op: 'unknown', rpId, credentialId: RANDOM_ID },
});
// the ids the store must never hold (a suffix, or a name no page owns)
const NEVER_HELD = new Set(
	SUFFIXES.map(([, id]) => id).filter((id) => id !== H.a.toUpperCase()),
);

/** case 4: a page of B claims A's routes: history, and the documents it makes */
async function claimA({ A, aOrigin }) {
	const describe = (error) => `${error.name}: ${error.message}`;
	const asks = (win) =>
		win.navigator.credentials
			.get({
				publicKey: {
					rpId: A,
					challenge: new Uint8Array(32),
					timeout: 3000,
				},
			})
			.then(() => 'got', describe);
	const out = {};
	try {
		history.replaceState(null, '', `${aOrigin}/pk/page`);
		out.replaceState = 'replaced';
	} catch (error) {
		out.replaceState = describe(error);
	}
	try {
		// (absolute: for a relative URL the inject's refusal quotes the URL as
		// given where Chrome quotes it resolved, src/inject/dom/modules/History.ts,
		// a divergence of its own outside passkeys)
		history.pushState(null, '', `${aOrigin}/pk/page?claim`);
		out.pushState = 'pushed';
	} catch (error) {
		out.pushState = describe(error);
	}
	out.origin = location.origin;
	out.get = await asks(window);
	const blank = document.createElement('iframe');
	document.body.append(blank);
	out.aboutBlank = await asks(blank.contentWindow);
	const srcdoc = document.createElement('iframe');
	srcdoc.srcdoc = '<p>claim</p>';
	const loaded = new Promise((resolve) => {
		srcdoc.onload = resolve;
	});
	document.body.append(srcdoc);
	await loaded;
	out.srcdoc = await asks(srcdoc.contentWindow);
	return out;
}

/**
 * case 4: the inject's message to the worker (`$stomp$passkey`) and the
 * controller's RPC (`stomp-remote` passkeyPrompt), each with a port, through
 * every path a hooked page reaches; what any port heard, and what the page
 * itself heard
 */
async function forge({ directory, rpId, claimed, wait }) {
	const seen = [];
	addEventListener('message', (event) => {
		const data = event.data;
		seen.push(
			data && typeof data === 'object'
				? Object.keys(data).join(',')
				: typeof data,
		);
	});
	const answers = {};
	const summary = (data) =>
		data && typeof data === 'object'
			? 'assertion' in data
				? 'ASSERTION'
				: 'attestation' in data
					? 'ATTESTATION'
					: 'error' in data
						? `error ${data.error}`
						: Object.keys(data).join(',')
			: String(data);
	const port = (label) => {
		const { port1, port2 } = new MessageChannel();
		answers[label] = [];
		port1.onmessage = (event) => answers[label].push(summary(event.data));
		return port2;
	};
	const challenge = () => crypto.getRandomValues(new Uint8Array(32)).buffer;
	const ops = {
		get: () => ({
			op: 'get',
			options: {
				rpId,
				challenge: challenge(),
				allow: [],
				userVerification: 'preferred',
			},
			sameOriginWithAncestors: true,
		}),
		create: () => ({
			op: 'create',
			options: {
				rpId,
				rpName: 'Forged',
				user: {
					id: new Uint8Array([7, 7, 7, 7]).buffer,
					name: 'mallory',
					displayName: 'Mallory',
				},
				challenge: challenge(),
				algs: [-7],
				exclude: [],
				residentKey: 'required',
				userVerification: 'preferred',
			},
			sameOriginWithAncestors: true,
		}),
	};
	// what a sender might claim of itself: the worker must read none of it
	const claims = {
		origin: claimed,
		url: `${claimed}/pk/page`,
		top: claimed,
		real: `${claimed}/pk/page`,
	};
	const message = (op, reply) => ({
		$stomp$passkey: { directory, ...ops[op](), ...claims },
		reply,
	});
	const rpc = (op, reply) => ({
		'stomp-remote': {
			$type: 'request',
			$method: 'passkeyPrompt',
			$args: {
				request: {
					type: op,
					rpId,
					origin: claimed,
					user: { name: 'mallory', displayName: 'Mallory' },
					credentials: [],
					userVerification: 'preferred',
				},
				port: reply,
			},
			$token: 0,
		},
	});
	const container = navigator.serviceWorker;
	const paths = {
		parent: (data, reply) => parent.postMessage(data, '*', [reply]),
		top: (data, reply) => top.postMessage(data, '*', [reply]),
		opener: (data, reply) =>
			opener ? opener.postMessage(data, '*', [reply]) : 'no opener',
		self: (data, reply) => postMessage(data, '*', [reply]),
		controller: (data, reply) =>
			container?.controller
				? container.controller.postMessage(data, [reply])
				: 'no controller',
		ready: (data, reply) => {
			container?.ready.then((registration) =>
				registration.active?.postMessage(data, [reply]),
			);
			return 'asked';
		},
	};
	const outcomes = {};
	for (const op of ['get', 'create'])
		for (const [name, path] of Object.entries(paths))
			for (const [shape, make] of [
				['message', message],
				['rpc', rpc],
			]) {
				const label = `${shape} ${op} via ${name}`;
				const reply = port(label);
				try {
					outcomes[label] = String(path(make(op, reply), reply) ?? 'posted');
				} catch (error) {
					outcomes[label] = `threw ${error.name}: ${error.message}`;
				}
			}
	// a BroadcastChannel carries no port: the names the inject or a
	// controller could be listening on
	for (const [label, name] of [
		['$stomp$passkey', '$stomp$passkey'],
		['stomp-remote', 'stomp-remote'],
		['the directory', directory],
		['stomp', 'stomp'],
	]) {
		try {
			const channel = new BroadcastChannel(name);
			channel.postMessage({ $stomp$passkey: { directory, ...ops.get() } });
			channel.postMessage(rpc('get', null));
			channel.close();
			outcomes[`broadcast ${label}`] = 'posted';
		} catch (error) {
			outcomes[`broadcast ${label}`] = `threw ${error.name}: ${error.message}`;
		}
	}
	const ready = await Promise.race([
		container ? container.ready.then(() => 'ready') : 'no container',
		new Promise((resolve) => setTimeout(() => resolve('pending'), wait)),
	]);
	await new Promise((resolve) => setTimeout(resolve, wait));
	return {
		outcomes,
		answers,
		seen,
		controller: container?.controller === null ? null : 'a controller',
		ready,
	};
}

/** case 4's controls: the inject's own message, from an escaped world of the page, on the worker itself */
async function onWorker({ rpId, claimed, wait }) {
	const directory = location.pathname.match(/^\/[^/]+\/[^/]+\//)[0];
	const { port1, port2 } = new MessageChannel();
	const heard = [];
	port1.onmessage = (event) => {
		const data = event.data;
		heard.push(
			data && typeof data === 'object'
				? 'assertion' in data
					? 'ASSERTION'
					: 'error' in data
						? `error ${data.error.join(': ')}`
						: Object.keys(data).join(',')
				: String(data),
		);
	};
	navigator.serviceWorker.controller.postMessage(
		{
			$stomp$passkey: {
				directory,
				op: 'get',
				options: {
					rpId,
					challenge: crypto.getRandomValues(new Uint8Array(32)).buffer,
					allow: [],
					userVerification: 'preferred',
				},
				sameOriginWithAncestors: true,
				...(claimed
					? {
							origin: claimed,
							url: `${claimed}/pk/page`,
							top: claimed,
							real: `${claimed}/pk/page`,
						}
					: {}),
			},
		},
		[port2],
	);
	for (let i = 0; i < wait / 100 && !heard.length; i++)
		await new Promise((resolve) => setTimeout(resolve, 100));
	return heard;
}

/** case 5: a relying party's options answered in the page; `override` names the rp id used */
async function answer({ kind, json, rpId }) {
	try {
		if (kind === 'create') {
			const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON({
				...json,
				rp: { ...json.rp, id: rpId },
			});
			return {
				credential: (
					await navigator.credentials.create({ publicKey })
				).toJSON(),
			};
		}
		const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON({
			...json,
			rpId,
		});
		return {
			credential: (await navigator.credentials.get({ publicKey })).toJSON(),
		};
	} catch (error) {
		return { rejected: `${error.name}: ${error.message}` };
	}
}
/**
 * case 5 on one side: `top` a page of A; what the relying party said at
 * each step. The fixture looks a credential id up before it reads the
 * client data, so an assertion relayed to B ends at its id, and a
 * registration (no signature with `none` attestation) is what reaches the
 * origin and rpIdHash checks.
 */
async function replay(top) {
	const out = {};
	const k = (label) => `replay-${label}-${++serial}`;
	const answered = async (kind, json) => {
		await top.focus('#user').catch(() => {});
		return inPage(top, answer, { kind, json, rpId: H.a });
	};
	const withClientData = (credential, data) => ({
		...credential,
		response: {
			...credential.response,
			clientDataJSON: b64url(JSON.stringify(data)),
		},
	});
	// a sign-in with A's passkey, verified
	const k1 = k('get');
	const assertion = await answered(
		'get',
		await rpPost(H.a, '/pk/login/options', { k: k1 }),
	);
	out.verified = await rpPost(H.a, '/pk/login/verify', {
		k: k1,
		credential: assertion.credential,
	});
	out.rpIdHashIsA = assertion.credential
		? Buffer.from(assertion.credential.response.authenticatorData, 'base64url')
				.subarray(0, 32)
				.equals(sha256(H.a))
		: null;
	// the same assertion again, to the same ceremony and to a new one
	out.sameCeremony = await rpPost(H.a, '/pk/login/verify', {
		k: k1,
		credential: assertion.credential,
	});
	const k2 = k('get');
	await rpPost(H.a, '/pk/login/options', { k: k2 });
	out.newCeremony = await rpPost(H.a, '/pk/login/verify', {
		k: k2,
		credential: assertion.credential,
	});
	// and with its client data rewritten to a new challenge: the signature
	// is over the old
	const k3 = k('get');
	const third = await rpPost(H.a, '/pk/login/options', { k: k3 });
	out.rewrittenClientData = assertion.credential
		? await rpPost(H.a, '/pk/login/verify', {
				k: k3,
				credential: withClientData(assertion.credential, {
					type: 'webauthn.get',
					challenge: third.challenge,
					origin: ORIGIN.a,
					crossOrigin: false,
				}),
			})
		: assertion;
	// B's challenge relayed to A's page and answered with A's passkey
	const k4 = k('get');
	const relayed = await answered(
		'get',
		await rpPost(H.b, '/pk/login/options', { k: k4 }),
	);
	out.relayedToB = relayed.credential
		? await rpPost(H.b, '/pk/login/verify', {
				k: k4,
				credential: relayed.credential,
			})
		: relayed;
	// a registration: verified once, then again
	const k5 = k('create');
	const made = await answered(
		'create',
		await rpPost(H.a, '/pk/register/options', {
			k: k5,
			user: `replay${serial}`,
		}),
	);
	out.registered = await rpPost(H.a, '/pk/register/verify', {
		k: k5,
		credential: made.credential,
	});
	out.registeredAgain = await rpPost(H.a, '/pk/register/verify', {
		k: k5,
		credential: made.credential,
	});
	// B's registration challenge relayed to A's page: A's origin in it
	const k6 = k('create');
	const relayedMade = await answered(
		'create',
		await rpPost(H.b, '/pk/register/options', {
			k: k6,
			user: `relay${serial}`,
		}),
	);
	out.relayedRegistrationToB = relayedMade.credential
		? await rpPost(H.b, '/pk/register/verify', {
				k: k6,
				credential: relayedMade.credential,
			})
		: relayedMade;
	// and with its client data rewritten to B's origin and a fresh
	// challenge of B's: the authenticator data still names A
	const k7 = k('create');
	const fresh = await rpPost(H.b, '/pk/register/options', {
		k: k7,
		user: `relay${serial}`,
	});
	out.rewrittenRegistrationForB = relayedMade.credential
		? await rpPost(H.b, '/pk/register/verify', {
				k: k7,
				credential: withClientData(relayedMade.credential, {
					type: 'webauthn.create',
					challenge: fresh.challenge,
					origin: ORIGIN.b,
					crossOrigin: false,
				}),
			})
		: relayedMade;
	return out;
}
/** a verdict as compared: ok, or the relying party's reason */
const verdict = (value) =>
	value?.ok === true ? 'ok' : (value?.error ?? value?.rejected ?? show(value));

// --- natively ---

const native = {};
// whose users the relying party keeps apart (it lists a user's passkeys to exclude)
let side = 'native';
{
	// a page of A holds a passkey; B's page asks for A's id
	const a = await nativeOpen(H.a);
	const held = await a.top.evaluate(() =>
		window.__pk.register({ server: { user: 'ada' } }),
	);
	check(
		'native',
		'the relying party verifies a registration of the virtual authenticator',
		held.verdict?.ok === true,
		show(held.verdict),
	);
	await inPage(a.top, kit);
	native.statics = {};
	native.statics.aHeld = await a.top.evaluate(() => window.__adv.statics());
	const b = await nativeOpen(H.b);
	await inPage(b.top, kit);
	native.statics.b = await b.top.evaluate(() => window.__adv.statics());
	native.cross = {};
	for (const [label, spec] of Object.entries(
		crossSite({ id: held.dump.rawId, userHandle: b64url([1, 2, 3, 4]) }),
	))
		native.cross[label] = outcome(await ask(b.top, spec));
	native.forge = await inPage(b.top, forge, {
		directory: '/stomp/x/',
		rpId: H.a,
		claimed: ORIGIN.a,
		wait: 1500,
	});
	native.claim = await inPage(b.top, claimA, { A: H.a, aOrigin: ORIGIN.a });
	await b.close();

	// case 6: what A's page reads with a credential held and with none,
	// nobody answering (no user presence)
	await a.presence(false);
	native.enumeration = {};
	for (const [label, spec] of [
		['get by a held id', { op: 'get', allow: [held.dump.rawId] }],
		['get by an unknown id', { op: 'get', allow: [RANDOM_ID] }],
		[
			'create excluding a held id',
			{ op: 'create', exclude: [held.dump.rawId] },
		],
		['create excluding an unknown id', { op: 'create', exclude: [RANDOM_ID] }],
	]) {
		const call = await begin(a.top, { ...spec, timeout: 3000 });
		await sleep(1500);
		const early = await call.read();
		native.enumeration[label] = {
			before: early.done ? outcome(early.value) : 'pending',
			ended: outcome(await call.end()),
		};
	}
	await a.presence(true);
	native.excludedAgreed = outcome(
		await ask(a.top, { op: 'create', exclude: [held.dump.rawId] }),
	);
	native.replay = await replay(a.top);
	await a.close();

	// a fresh A (nothing held) for the empty statics
	const empty = await nativeOpen(H.a);
	await inPage(empty.top, kit);
	native.statics.a = await empty.top.evaluate(() => window.__adv.statics());
	await empty.close();

	native.suffixes = {};
	for (const host of new Set(SUFFIXES.map(([site]) => site))) {
		const page = await nativeOpen(host);
		for (const [site, id] of SUFFIXES.filter(([site]) => site === host))
			for (const [op, spec] of Object.entries(SUFFIX_OPS(id)))
				native.suffixes[`${site} ${JSON.stringify(id)} ${op}`] = outcome(
					await ask(page.top, spec),
				);
		await page.close();
	}
	// the controls: the own id named, and a parent's from a name under it
	{
		const a2 = await nativeOpen(H.a);
		native.suffixControl = {
			own: outcome(await ask(a2.top, { op: 'create', rpId: H.a })),
		};
		await a2.close();
		const sub = await nativeOpen(H.sub);
		native.suffixControl.parent = outcome(
			await ask(sub.top, { op: 'create', rpId: H.a }),
		);
		await sub.close();
	}

	// case 3: A in a frame of B
	native.frames = {};
	{
		const top = await nativeOpen(H.b, framedA(null));
		const kid = await childOf(top.top);
		native.frames.noAllow = {
			register: ceremony(
				await armed(kid, 'register', {
					server: { user: `kid-${side}-noallow` },
				}),
			),
			login: ceremony(await quietly(kid, 'login', {})),
		};
		await top.close();
	}
	{
		const top = await nativeOpen(H.b, framedA(ALLOW));
		const kid = await childOf(top.top);
		native.frames.noActivation = ceremony(
			await quietly(kid, 'register', { server: { user: `kid-${side}-quiet` } }),
		);
		native.kidForge = await quiet(kid, forge, {
			directory: '/stomp/x/',
			rpId: H.a,
			claimed: ORIGIN.a,
			wait: 1500,
		});
		await top.close();
	}
	{
		const top = await nativeOpen(H.b, framedA(ALLOW));
		const kid = await childOf(top.top);
		await quiet(kid, spoofActivation);
		native.frames.spoofedActivation = ceremony(
			await quietly(kid, 'register', {
				server: { user: `kid-${side}-spoofed` },
			}),
		);
		await top.close();
	}
	{
		const top = await nativeOpen(H.b, framedA(ALLOW));
		const kid = await childOf(top.top);
		native.frames.clicked = {
			register: ceremony(
				await armed(kid, 'register', { server: { user: `kid-${side}-click` } }),
			),
			login: ceremony(await quietly(kid, 'login', {})),
		};
		await top.close();
	}
}
check(
	'native',
	"another site's relying party id is refused natively, with Chrome's words for a file that could not be fetched",
	Object.values(native.cross).every((text) =>
		/^SecurityError: The relying party ID is not a registrable domain suffix of, nor equal to the current domain\. Subsequently, an attempt to fetch/.test(
			text,
		),
	),
	show(native.cross),
);
check(
	'native',
	'6: the statics answer the same on A and B, held or not',
	new Set(Object.values(native.statics).map(show)).size === 1,
	show(native.statics),
);
check(
	'native',
	'a frame of B with allow and a click makes and signs in, crossOrigin with B as its top',
	native.frames.clicked.register.ok === true &&
		native.frames.clicked.register.crossOrigin === true &&
		native.frames.clicked.register.topOrigin === ORIGIN.b &&
		native.frames.clicked.login.ok === true,
	show(native.frames.clicked),
);

/**
 * The page's own userActivation made to say "active": the getter on the
 * prototype, the instance's, and the navigator's own property. A page can
 * do all of this; Chrome checks the activation in the browser
 */
function spoofActivation() {
	const active = { isActive: true, hasBeenActive: true };
	try {
		Object.defineProperty(UserActivation.prototype, 'isActive', {
			get: () => true,
			configurable: true,
		});
		Object.defineProperty(UserActivation.prototype, 'hasBeenActive', {
			get: () => true,
			configurable: true,
		});
	} catch (error) {
		// kept as it was
	}
	try {
		Object.defineProperty(Navigator.prototype, 'userActivation', {
			get: () => active,
			configurable: true,
		});
	} catch (error) {
		// kept as it was
	}
	try {
		Object.defineProperty(navigator, 'userActivation', {
			value: active,
			configurable: true,
		});
	} catch (error) {
		// kept as it was
	}
	return navigator.userActivation.isActive;
}

// --- through the demo, in both modes ---

for (const [mode, base] of MODES) {
	side = mode;
	const host = await demo(base);
	try {
		await host.clear();
		host.mode = 'accept';

		// the statics, before anything is held
		const statics = {};
		{
			const a = await host.open(H.a);
			await inPage(a, kit);
			statics.a = await a.evaluate(() => window.__adv.statics());
			const b = await host.open(H.b);
			await inPage(b, kit);
			statics.b = await b.evaluate(() => window.__adv.statics());
		}

		// the control: A's own registration and sign-in, asked in the
		// host's sheet and verified by the relying party
		let held;
		{
			const a = await host.open(H.a);
			const mark = await host.count();
			await a.focus('#user');
			const made = await a.evaluate(() =>
				window.__pk.register({ server: { user: 'ada' } }),
			);
			const login = await a.evaluate(() => window.__pk.login({}));
			const shown = await host.since(mark);
			check(
				mode,
				"control: A's registration and sign-in ask in the host's sheet, naming A, and the relying party verifies both",
				made.verdict?.ok === true &&
					login.verdict?.ok === true &&
					login.verdict.user === 'ada' &&
					shown.length === 2 &&
					shown[0].title === `Create a passkey for ${H.a}` &&
					shown[1].title === `Use a saved passkey for ${H.a}`,
				show([made.verdict, login.verdict, shown.map((sheet) => sheet.title)]),
			);
			[held] = (await host.list()).filter((entry) => entry.rpId === H.a);
			if (!held) throw new Error('A holds no passkey');
			await inPage(a, kit);
			statics.aHeld = await a.evaluate(() => window.__adv.statics());
		}
		{
			const b = await host.open(H.b);
			await inPage(b, kit);
			statics.bHeld = await b.evaluate(() => window.__adv.statics());
			// B's own sign-in shows B's sheet: the sheets of B's page are seen
			const mark = await host.count();
			const own = await ask(b, { op: 'get' });
			const shown = await host.since(mark);
			check(
				mode,
				"control: B's own sign-in shows B's sheet (it holds none) and ends as one the user closed",
				shown.length === 1 &&
					shown[0].title === `You don't have a passkey for ${H.b} saved here` &&
					outcome(own) === NOT_ALLOWED,
				show([own, shown]),
			);
		}

		// 1. B asks for A's relying party id
		{
			const b = await host.open(H.b);
			const before = await host.list();
			const mark = await host.count();
			const got = {};
			for (const [label, spec] of Object.entries(crossSite(held)))
				got[label] = outcome(await ask(b, spec));
			same(
				mode,
				"1: B asking for A's relying party id (create, get, get by A's id, conditional get, each signal) ends as natively",
				native.cross,
				got,
			);
			const shown = await host.since(mark);
			check(
				mode,
				"1: no sheet shows for B's requests for A's id",
				shown.length === 0,
				show(shown),
			);
			same(mode, "1: A's passkeys are unchanged", before, await host.list());
		}

		// 2. registrable-suffix tricks
		{
			const before = await host.list();
			const mark = await host.count();
			const got = {};
			for (const site of new Set(SUFFIXES.map(([name]) => name))) {
				const page = await host.open(site);
				for (const [name, id] of SUFFIXES.filter(([name]) => name === site))
					for (const [op, spec] of Object.entries(SUFFIX_OPS(id)))
						got[`${name} ${JSON.stringify(id)} ${op}`] = outcome(
							await ask(page, spec),
						);
			}
			// (an address apart: Chrome refuses one before it asks for a
			// /.well-known/webauthn, a check of its own)
			const address = / "(127\.0\.0\.1|\[::1\])" /;
			const part = (all, addresses) =>
				Object.fromEntries(
					Object.entries(all).filter(
						([key]) => address.test(key) === addresses,
					),
				);
			same(
				mode,
				'2: a public suffix, a private one, a trailing dot, capitals, a port, an origin, an empty id: each ends as natively',
				part(native.suffixes, false),
				part(got, false),
			);
			same(
				mode,
				"2: an address as the id (127.0.0.1, [::1]) ends as natively: refused at once, in Chrome's words for no suffix, with no related origins request",
				part(native.suffixes, true),
				part(got, true),
			);
			const shown = await host.since(mark);
			check(
				mode,
				'2: no sheet shows for any of them',
				shown.length === 0,
				show(shown),
			);
			const after = await host.list();
			same(mode, '2: the store is unchanged', before, after);
			// the controls: the own id named, and a parent's from a name under it
			const a = await host.open(H.a);
			const controlMark = await host.count();
			const control = {
				own: outcome(await ask(a, { op: 'create', rpId: H.a })),
			};
			const sub = await host.open(H.sub);
			control.parent = outcome(await ask(sub, { op: 'create', rpId: H.a }));
			const controlShown = await host.since(controlMark);
			check(
				mode,
				"2: control: A naming its own id, and a name under A naming A's, make a passkey as natively, after a sheet that names A",
				differences(native.suffixControl, control).length === 0 &&
					control.own === 'made a credential' &&
					controlShown.length === 2 &&
					controlShown.every(
						(sheet) => sheet.title === `Create a passkey for ${H.a}`,
					),
				show([native.suffixControl, control, controlShown]),
			);
			check(
				mode,
				'2: no passkey is held for a suffix or any id no page owns',
				(await host.list()).every((entry) => !NEVER_HELD.has(entry.rpId)),
				show((await host.list()).map((entry) => entry.rpId)),
			);
		}

		// 3. A in a frame of B
		{
			const frames = {};
			const before = await host.list();
			let mark = await host.count();
			{
				const top = await host.open(H.b, framedA(null));
				const kid = await childOf(top);
				frames.noAllow = {
					register: ceremony(
						await armed(kid, 'register', {
							server: { user: `kid-${side}-noallow` },
						}),
					),
					login: ceremony(await quietly(kid, 'login', {})),
				};
			}
			same(
				mode,
				"3: a frame of A in B without allow: the policy's refusal, as natively",
				native.frames.noAllow,
				frames.noAllow,
			);
			{
				const top = await host.open(H.b, framedA(ALLOW));
				const kid = await childOf(top);
				frames.noActivation = ceremony(
					await quietly(kid, 'register', {
						server: { user: `kid-${side}-quiet` },
					}),
				);
			}
			same(
				mode,
				"3: a frame of A in B with allow, a user activation in B (the embedding page) and none in the frame: create gets the activation's refusal, as natively",
				native.frames.noActivation,
				frames.noActivation,
			);
			{
				const top = await host.open(H.b, framedA(ALLOW));
				const kid = await childOf(top);
				await quiet(kid, spoofActivation);
				frames.spoofedActivation = ceremony(
					await quietly(kid, 'register', {
						server: { user: `kid-${side}-spoofed` },
					}),
				);
			}
			same(
				mode,
				"3: that frame with its own userActivation made to say active: still the activation's refusal, as natively",
				native.frames.spoofedActivation,
				frames.spoofedActivation,
			);
			const refusedShown = await host.since(mark);
			check(
				mode,
				'3: no sheet shows for the refused frames',
				refusedShown.length === 0,
				show(refusedShown),
			);
			same(
				mode,
				'3: the refused frames made no passkey',
				before,
				await host.list(),
			);
			mark = await host.count();
			{
				const top = await host.open(H.b, framedA(ALLOW));
				const kid = await childOf(top);
				const register = ceremony(
					await armed(kid, 'register', {
						server: { user: `kid-${side}-click` },
					}),
				);
				await kid.focus('#user');
				frames.clicked = {
					register,
					login: ceremony(await quietly(kid, 'login', {})),
				};
			}
			same(
				mode,
				'3: a frame of A in B with allow and a click: made and signed in, crossOrigin with B as topOrigin in the verified client data, as natively',
				native.frames.clicked,
				frames.clicked,
			);
			const shown = await host.since(mark);
			check(
				mode,
				'3: its sheets name A and say it asked in a frame on B',
				shown.length === 2 &&
					shown[0].title === `Create a passkey for ${H.a}` &&
					shown[1].title === `Use a saved passkey for ${H.a}` &&
					shown.every((sheet) =>
						sheet.text.includes(`Asked in a frame on ${H.b}.`),
					),
				show(shown),
			);
		}

		// 4. forged messages
		{
			const before = await host.list();
			const mark = await host.count();
			const forged = {};
			const directory = (frame) =>
				/^https?:\/\/[^/]+(\/[^/]+\/[^/]+\/)/.exec(frame.url())?.[1];
			const b = await host.open(H.b);
			forged['B claiming A'] = await inPage(b, forge, {
				directory: directory(b),
				rpId: H.a,
				claimed: ORIGIN.a,
				wait: 1500,
			});
			const a = await host.open(H.a);
			forged['A for itself'] = await inPage(a, forge, {
				directory: directory(a),
				rpId: H.a,
				claimed: ORIGIN.a,
				wait: 1500,
			});
			const top = await host.open(H.b, framedA(ALLOW));
			const kid = await childOf(top);
			forged['a frame of A in B, no activation'] = await quiet(kid, forge, {
				directory: directory(kid),
				rpId: H.a,
				claimed: ORIGIN.a,
				wait: 1500,
			});
			await sleep(1000);
			const shown = await host.since(mark);
			check(
				mode,
				'4: no sheet shows for any forged message, on any path',
				shown.length === 0,
				show(shown),
			);
			const heard = Object.fromEntries(
				Object.entries(forged).map(([who, result]) => [
					who,
					Object.fromEntries(
						Object.entries(result.answers).filter(([, got]) => got.length),
					),
				]),
			);
			check(
				mode,
				'4: no port of a forged message hears anything (no assertion, no attestation, no answer at all)',
				Object.values(heard).every((ports) => !Object.keys(ports).length),
				show(heard),
			);
			same(mode, '4: the store is unchanged', before, await host.list());
			// what the page itself reads of the paths (what each post did, the
			// messages it heard itself, no service worker of its own, so no
			// controller and a ready that does not settle): as natively
			const reads = (result) => ({
				outcomes: result.outcomes,
				seen: result.seen,
				controller: result.controller,
				ready: result.ready,
			});
			same(
				mode,
				'4: what a top page of B reads of every path it posted on is what it reads natively',
				reads(native.forge),
				reads(forged['B claiming A']),
			);
			same(
				mode,
				'4: and what the frame of A in B reads',
				reads(native.kidForge),
				reads(forged['a frame of A in B, no activation']),
			);

			// a page of B claims A's routes: history, its own blank and srcdoc
			// documents
			const claimer = await host.open(H.b);
			const claimMark = await host.count();
			const claimed = await inPage(claimer, claimA, {
				A: H.a,
				aOrigin: ORIGIN.a,
			});
			same(
				mode,
				"4: a page of B that pushes A's URL and asks from its blank and srcdoc frames is refused as natively",
				// (Chrome's messages name the document's URL, whose id differs)
				JSON.parse(JSON.stringify(native.claim).replace(/\?id=n\d+/g, '?id=X')),
				JSON.parse(JSON.stringify(claimed).replace(/\?id=p\d+/g, '?id=X')),
			);
			check(
				mode,
				"4: no sheet shows for B's claims",
				(await host.since(claimMark)).length === 0,
				show(await host.since(claimMark)),
			);

			// the controls, from an escaped world of B's page (the browser's
			// own natives in the same document): the inject's message, on the
			// worker itself
			host.mode = 'cancel';
			const escaped = await worldOf(await host.open(H.b), 'escaped');
			const controlMark = await host.count();
			const ownId = await escaped.run(onWorker, { rpId: H.b, wait: 8000 });
			const ownShown = await host.since(controlMark);
			check(
				mode,
				"4: control: that message from B's document, for B's own id, on the worker itself, is heard: B's sheet shows and the user's Close ends it",
				ownShown.length === 1 &&
					ownShown[0].title ===
						`You don't have a passkey for ${H.b} saved here` &&
					ownId.join() === `error ${NOT_ALLOWED}`,
				show([ownId, ownShown]),
			);
			const claimMark2 = await host.count();
			const claimsA = await escaped.run(onWorker, {
				rpId: H.a,
				claimed: ORIGIN.a,
				wait: 8000,
			});
			const claimShown = await host.since(claimMark2);
			check(
				mode,
				"4: control: from B's document for A's id, the message claiming A's origin, URL and top, the worker reads the sender and refuses with Chrome's SecurityError, and no sheet shows",
				claimShown.length === 0 &&
					claimsA.length === 1 &&
					claimsA[0] === `error ${native.cross.get}`,
				show([claimsA, claimShown]),
			);
			host.mode = 'accept';
			same(
				mode,
				'4: the controls changed no passkey',
				before,
				await host.list(),
			);
		}

		// 5. replay
		{
			const a = await host.open(H.a);
			const got = await replay(a);
			const want = Object.fromEntries(
				Object.entries(native.replay).map(([key, value]) => [
					key,
					typeof value === 'boolean' ? value : verdict(value),
				]),
			);
			const seen = Object.fromEntries(
				Object.entries(got).map(([key, value]) => [
					key,
					typeof value === 'boolean' ? value : verdict(value),
				]),
			);
			same(
				mode,
				"5: an assertion and an attestation of A are verified once; again, to a new ceremony, or relayed to B's endpoints they are refused, as natively",
				want,
				seen,
			);
			check(
				mode,
				"5: control: A's sign-in and registration verify, and the authenticator data names A's relying party id",
				seen.verified === 'ok' &&
					seen.registered === 'ok' &&
					seen.rpIdHashIsA === true &&
					seen.relayedRegistrationToB ===
						`origin ${ORIGIN.a}, expected ${ORIGIN.b}` &&
					/^rpIdHash is not/.test(seen.rewrittenRegistrationForB) &&
					/^the signature does not verify/.test(seen.rewrittenClientData),
				show(seen),
			);
		}

		// 6. enumeration
		{
			host.mode = 'wait';
			const timing = {};
			const run = async (page, spec) => {
				await page.focus('#user');
				const mark = await host.count();
				const call = await begin(page, { ...spec, timeout: 60000 });
				await sleep(1500);
				const early = await call.read();
				const shown = await host.since(mark);
				await host.cancel();
				return {
					before: early.done ? outcome(early.value) : 'pending',
					ended: outcome(await call.end()),
					sheet: shown.map((sheet) => sheet.title),
				};
			};
			const b = await host.open(H.b);
			timing["B by A's id"] = await run(b, { op: 'get', allow: [held.id] });
			timing['B by an unknown id'] = await run(b, {
				op: 'get',
				allow: [RANDOM_ID],
			});
			const a = await host.open(H.a);
			timing['get by a held id'] = await run(a, {
				op: 'get',
				allow: [held.id],
			});
			timing['get by an unknown id'] = await run(a, {
				op: 'get',
				allow: [RANDOM_ID],
			});
			timing['create excluding a held id'] = await run(a, {
				op: 'create',
				exclude: [held.id],
			});
			timing['create excluding an unknown id'] = await run(a, {
				op: 'create',
				exclude: [RANDOM_ID],
			});
			host.mode = 'accept';
			const pick = (labels) =>
				labels.map((label) => [timing[label].before, timing[label].ended]);
			check(
				mode,
				"6: from B, a get by A's credential id and by an unknown one: the same sheet, both waiting for the user, the same error after Cancel",
				show(timing["B by A's id"]) === show(timing['B by an unknown id']) &&
					timing["B by A's id"].before === 'pending' &&
					timing["B by A's id"].ended === NOT_ALLOWED &&
					timing["B by A's id"].sheet.join() ===
						`You don't have a passkey for ${H.b} saved here`,
				show(timing),
			);
			check(
				mode,
				'6: from A, a get by a held id and by an unknown one, and a create excluding a held id and an unknown one: all wait for the user, and Cancel ends each with the same error',
				pick([
					'get by a held id',
					'get by an unknown id',
					'create excluding a held id',
					'create excluding an unknown id',
				]).every(
					([before, ended]) => before === 'pending' && ended === NOT_ALLOWED,
				),
				show(timing),
			);
			same(
				mode,
				"6: and natively the same four read the same: waiting at 1.5 s, then the same error (Chrome's at the timeout)",
				Object.fromEntries(
					Object.entries(native.enumeration).map(([label, value]) => [
						label,
						value,
					]),
				),
				Object.fromEntries(
					Object.keys(native.enumeration).map((label) => [
						label,
						{ before: timing[label].before, ended: timing[label].ended },
					]),
				),
			);
			// the sheets differ, as they do for a user natively: the user is
			// shown what is held, the page is told nothing of it
			check(
				mode,
				'6: the user is shown what is held (the chooser for a held id, none for an unknown one; "already saved" for an excluded one)',
				timing['get by a held id'].sheet.join() ===
					`Use a saved passkey for ${H.a}` &&
					timing['get by an unknown id'].sheet.join() ===
						`You don't have a passkey for ${H.a} saved here` &&
					timing['create excluding a held id'].sheet.join() ===
						`A passkey for ${H.a} is already saved here` &&
					timing['create excluding an unknown id'].sheet.join() ===
						`Create a passkey for ${H.a}`,
				show(timing),
			);
			// told only once the user agreed (6.3.2 step 3)
			await a.focus('#user');
			const agreed = outcome(
				await ask(a, { op: 'create', exclude: [held.id] }),
			);
			check(
				mode,
				"6: control: a create excluding a held id that the user agrees to is told InvalidStateError, in Chrome's words",
				agreed === native.excludedAgreed && /^InvalidStateError/.test(agreed),
				show([native.excludedAgreed, agreed]),
			);
			const later = {
				a: statics.a,
				b: statics.b,
				aHeld: statics.aHeld,
				bHeld: statics.bHeld,
			};
			check(
				mode,
				'6: isUserVerifyingPlatformAuthenticatorAvailable, isConditionalMediationAvailable and getClientCapabilities answer the same on A and B, with passkeys held and without',
				new Set(Object.values(later).map(show)).size === 1 &&
					!/Error/.test(show(later.a)),
				show(later),
			);
		}

		// nothing left the proxy
		const raw = host.recorder.raw();
		check(
			mode,
			'no request left the proxy',
			raw.length === 0,
			show(raw.map((entry) => entry.url)),
		);
	} catch (error) {
		check(mode, 'the cases ran', false, String(error?.stack ?? error));
	}
	await host.close();
}

const strays = Object.keys(entries).filter((key) => !checked.has(key));
ok(
	'adversarial-passkeys: every known-open entry names a check',
	strays.length === 0,
	JSON.stringify(strays),
);
await nativeBrowser.close();
rp.close();
await done(browser, errors);
