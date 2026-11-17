// The browser's own WebAuthn never acts for a proxied page (docs/passkeys.md).
// Every proxied site shares the proxy's one real origin, so a credential the
// browser's own authenticator made or asserted for a proxied page would be
// scoped to that shared origin: one proxied site could then use what another
// made, and the relying party would reject it anyway (the browser signs the
// proxy's origin). The rule this suite proves is that no proxied page creates,
// lists or asserts a credential on that origin, with STomp's own passkey
// provider and without it:
//
// - without a provider (the host gave the controller no `passkeys` option,
//   `?passkeys=off` in the demo), a relying party id the browser would accept
//   (the proxy origin's own host or a suffix) is handed the browser empty,
//   which it refuses before reaching any authenticator, and the refusal is
//   reshaped into the native decline that a create or get ends as, and the
//   no-op a signal is (src/inject/dom/modules/Credentials.ts);
// - with STomp's provider (the demo's default), a publicKey request never
//   reaches the browser: the service worker judges it from the page's own
//   origin (here an address, as the fixture is on 127.0.0.1), so the proxy
//   origin's host is refused as natively for a page on an address, and the
//   browser's authenticator is never asked.
//
// The oracle is a real Chrome with a virtual authenticator (CDP WebAuthn): a
// page natively on a domain makes and asserts a passkey, and the authenticator
// holds it, which is the hole this closes on purpose; and a page natively on
// the fixture's address gives Chrome's words for what an address may ask.
// Through the demo on a domain (demo.localhost, the same-origin controller,
// every proxied page on one origin as a RemoteController's proxy origin is)
// the same calls are refused with Chrome's own words, the authenticator stays
// empty, and a second proxied page gets no assertion from what a first one
// tried to make.
//
// A domain is required (an address is no relying party): the suite runs on
// demo.localhost, as webauthn-related-origins does.
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	sleep,
	submitLanding,
} from '../lib.mjs';

const fixture = new URL(FIXTURE);
// the demo under a name of its own: a domain, not an address
const DEMO = `http://demo.localhost:${new URL(HOST).port}/?passkeys=off`;
const DEMO_PROVIDER = `http://demo.localhost:${new URL(HOST).port}/?passkeys=test`;
const probe = (site) => `${FIXTURE}pages/passkeys-probe.html?site=${site}`;
const nativeProbe = (site) =>
	`http://wk.localhost:${fixture.port}/pages/passkeys-probe.html?site=${site}`;

const RP_UNFETCHED =
	'The relying party ID is not a registrable domain suffix of, nor equal to the current domain. Subsequently, an attempt to fetch the .well-known/webauthn resource of the claimed RP ID failed.';

const VIRTUAL = {
	options: {
		protocol: 'ctap2',
		transport: 'internal',
		hasResidentKey: true,
		hasUserVerification: true,
		isUserVerified: true,
		isUserConsenting: true,
		automaticPresenceSimulation: true,
	},
};

// the ceremonies, as functions a frame or page evaluates
const createCall = async (rpId) => {
	try {
		const cred = await navigator.credentials.create({
			publicKey: {
				rp: { id: rpId, name: 'probe' },
				user: {
					id: new Uint8Array([1, 2, 3, 4]),
					name: 'u',
					displayName: 'User',
				},
				challenge: new Uint8Array(16),
				pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
				authenticatorSelection: {
					residentKey: 'required',
					userVerification: 'preferred',
				},
				timeout: 5000,
			},
		});
		return { ok: true, type: cred?.constructor?.name ?? null, id: cred?.id };
	} catch (error) {
		return { ok: false, name: error.name, message: error.message };
	}
};
const getCall = async (rpId) => {
	try {
		const assertion = await navigator.credentials.get({
			publicKey: {
				rpId,
				challenge: new Uint8Array(16),
				userVerification: 'preferred',
				timeout: 5000,
			},
		});
		return {
			ok: true,
			type: assertion?.constructor?.name ?? null,
			userHandle: !!assertion?.response?.userHandle,
		};
	} catch (error) {
		return { ok: false, name: error.name, message: error.message };
	}
};
const getBogus = async (rpId) => {
	try {
		await navigator.credentials.get({
			publicKey: {
				rpId,
				challenge: new Uint8Array(16),
				allowCredentials: [{ type: 'public-key', id: new Uint8Array(32) }],
				timeout: 5000,
			},
		});
		return { ok: true };
	} catch (error) {
		return { ok: false, name: error.name, message: error.message };
	}
};
const signalCall = async (rpId) => {
	try {
		const result = await PublicKeyCredential.signalUnknownCredential({
			rpId,
			credentialId: 'AAAA',
		});
		return {
			ok: true,
			value: result === undefined ? 'undefined' : String(result),
		};
	} catch (error) {
		return { ok: false, name: error.name, message: error.message };
	}
};

const getDefaultCall = async () => {
	try {
		await navigator.credentials.get({
			publicKey: { challenge: new Uint8Array(16), timeout: 5000 },
		});
		return { ok: true };
	} catch (error) {
		return { ok: false, name: error.name, message: error.message };
	}
};

const credentialCount = async (cdp, authenticatorId) =>
	(await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials
		.length;

async function proxiedFrame(page, site) {
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		const found = page
			.frames()
			.findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		if (
			(await found
				?.evaluate(() => window.__pkProbe?.ready && window.__pkProbe.site)
				.catch(() => null)) === site
		)
			return found;
	}
	return null;
}

// --- the oracle: a page natively on a domain, with a virtual authenticator ---
const nativeBrowser = await launch();
const nativePage = await nativeBrowser.newPage();
const nativeCdp = await nativePage.context().newCDPSession(nativePage);
await nativeCdp.send('WebAuthn.enable');
const nativeAuth = (
	await nativeCdp.send('WebAuthn.addVirtualAuthenticator', VIRTUAL)
).authenticatorId;
await nativePage.goto(nativeProbe('a'));
const nativeCreate = await nativePage.evaluate(createCall, 'wk.localhost');
const nativePlanted = await credentialCount(nativeCdp, nativeAuth);
const nativeGet = await nativePage.evaluate(getCall, 'wk.localhost');
// Chrome's own words for a ceremony the authenticator did not answer
const nativeDecline = await nativePage.evaluate(getBogus, 'wk.localhost');
// and for a page on an address (the fixture's, as the proxied pages' are)
// asking for a domain's id, or for its own
await nativePage.goto(probe('a'));
const nativeAddress = {
	create: await nativePage.evaluate(createCall, 'demo.localhost'),
	get: await nativePage.evaluate(getCall, 'demo.localhost'),
	getDefault: await nativePage.evaluate(getDefaultCall),
	signal: await nativePage.evaluate(signalCall, 'demo.localhost'),
};
const nativeAddressPlanted = await credentialCount(nativeCdp, nativeAuth);
await nativeBrowser.close();

// --- through the demo on a domain: every proxied page on one real origin ---
const browser = await launch();
const page = await openDemo(browser, DEMO);
const cdp = await page.context().newCDPSession(page);
await cdp.send('WebAuthn.enable');
const auth = (await cdp.send('WebAuthn.addVirtualAuthenticator', VIRTUAL))
	.authenticatorId;

await submitLanding(page, probe('a'));
const frameA = await proxiedFrame(page, 'a');
const proxiedCreate = frameA
	? await frameA.evaluate(createCall, 'demo.localhost')
	: { ok: null };
const plantedAfterCreate = await credentialCount(cdp, auth);
const proxiedGet = frameA
	? await frameA.evaluate(getCall, 'demo.localhost')
	: { ok: null };
// an omitted relying party id defaults to the document's own domain, which is
// the shared proxy origin: it must be refused too, not reach the authenticator
const proxiedGetDefault = frameA
	? await frameA.evaluate(getDefaultCall)
	: { ok: null };
// a relying party id of another site still ends as the related-origins refusal
// (no regression of the leak fix on master)
const proxiedOther = frameA
	? await frameA.evaluate(createCall, 'wk.localhost')
	: { ok: null };

// a second proxied page (another site to the user, the same real origin): it
// gets no assertion from what the first tried to make, and the signal statics
// change nothing
await submitLanding(page, probe('b'));
const frameB = await proxiedFrame(page, 'b');
const proxiedGetB = frameB
	? await frameB.evaluate(getCall, 'demo.localhost')
	: { ok: null };
const proxiedSignal = frameB
	? await frameB.evaluate(signalCall, 'demo.localhost')
	: { ok: null };
const plantedEnd = await credentialCount(cdp, auth);

const errors = page.errors.slice();
await page.close();

// --- the same with STomp's provider: the browser's authenticator is never asked ---
const providerPage = await openDemo(browser, DEMO_PROVIDER);
const providerCdp = await providerPage.context().newCDPSession(providerPage);
await providerCdp.send('WebAuthn.enable');
const providerAuth = (
	await providerCdp.send('WebAuthn.addVirtualAuthenticator', VIRTUAL)
).authenticatorId;
await submitLanding(providerPage, probe('a'));
const providerFrame = await proxiedFrame(providerPage, 'a');
const provider = providerFrame
	? {
			create: await providerFrame.evaluate(createCall, 'demo.localhost'),
			get: await providerFrame.evaluate(getCall, 'demo.localhost'),
			getDefault: await providerFrame.evaluate(getDefaultCall),
			signal: await providerFrame.evaluate(signalCall, 'demo.localhost'),
		}
	: null;
const providerPlanted = await credentialCount(providerCdp, providerAuth);
const providerHeld = await providerPage.evaluate(() =>
	window.controller.passkeys.list(),
);
const providerPrompt = await providerPage.$('#passkeyPrompt');
errors.push(...providerPage.errors);

// the oracle holds: WebAuthn works natively on a domain, which is the hole
ok(
	'natively a page on a domain makes a passkey its authenticator holds (the oracle works)',
	nativeCreate.ok === true && nativePlanted === 1,
	JSON.stringify({ nativeCreate, nativePlanted }),
);
ok(
	'natively that passkey asserts',
	nativeGet.ok === true && nativeGet.userHandle === true,
	JSON.stringify(nativeGet),
);
ok(
	'the native decline has a NotAllowedError (its words are the oracle for the refusal)',
	nativeDecline.ok === false && nativeDecline.name === 'NotAllowedError',
	JSON.stringify(nativeDecline),
);

ok('the demo on a domain opens site a', !!frameA, '');
ok(
	'a proxied create is refused as the native decline, and nothing is held',
	proxiedCreate.ok === false &&
		proxiedCreate.name === 'NotAllowedError' &&
		proxiedCreate.message === nativeDecline.message &&
		plantedAfterCreate === 0,
	JSON.stringify({ proxiedCreate, plantedAfterCreate, nativeDecline }),
);
ok(
	'a proxied get is refused as the native decline',
	proxiedGet.ok === false &&
		proxiedGet.name === 'NotAllowedError' &&
		proxiedGet.message === nativeDecline.message,
	JSON.stringify(proxiedGet),
);
ok(
	'a proxied get with no relying party id (the shared proxy origin) is refused too',
	proxiedGetDefault.ok === false &&
		proxiedGetDefault.name === 'NotAllowedError' &&
		proxiedGetDefault.message === nativeDecline.message,
	JSON.stringify(proxiedGetDefault),
);
ok(
	"a proxied create for another site's relying party id still ends as the related-origins refusal",
	proxiedOther.ok === false &&
		proxiedOther.name === 'SecurityError' &&
		proxiedOther.message === RP_UNFETCHED,
	JSON.stringify(proxiedOther),
);
ok('the demo opens site b', !!frameB, '');
ok(
	'a second proxied site gets no assertion, and the authenticator is still empty',
	proxiedGetB.ok === false &&
		proxiedGetB.name === 'NotAllowedError' &&
		plantedEnd === 0,
	JSON.stringify({ proxiedGetB, plantedEnd }),
);
ok(
	'a proxied signal is the native no-op (it resolves undefined and holds nothing)',
	proxiedSignal.ok === true &&
		proxiedSignal.value === 'undefined' &&
		plantedEnd === 0,
	JSON.stringify({ proxiedSignal, plantedEnd }),
);

ok('with the provider, the demo on a domain opens site a', !!providerFrame, '');
const shape = (result) => [result?.ok, result?.name, result?.message];
ok(
	"with STomp's provider, a proxied page on an address asking for the proxy origin's host, or for its own default, ends as Chrome ends it for a page on an address",
	!!provider &&
		JSON.stringify(Object.values(provider).map(shape)) ===
			JSON.stringify(Object.values(nativeAddress).map(shape)),
	JSON.stringify({ provider, nativeAddress }),
);
ok(
	"with STomp's provider the browser's authenticator is never asked: it holds nothing, STomp holds nothing, and no sheet showed",
	providerPlanted === 0 &&
		nativeAddressPlanted === 1 &&
		providerHeld.length === 0 &&
		providerPrompt === null,
	JSON.stringify({ providerPlanted, providerHeld, prompt: !!providerPrompt }),
);

await done(browser, errors);
