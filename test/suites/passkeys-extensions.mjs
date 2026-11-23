// What STomp's passkey provider (docs/passkeys.md) does beyond the
// passkeys suite's ceremonies, each natively against Chrome's virtual
// authenticator and through the demo in both modes, with the relying party
// of test/passkeys-rp.mjs verifying every registration and assertion by its
// own steps and with @simplewebauthn/server:
//
// - EdDSA (COSE -8, Ed25519): made when the site lists it before ES256 and
//   RS256, as Chrome's authenticator makes the first of the site's it can;
// - the largeBlob extension: `support` at creation, a blob written to and
//   read from one credential, an empty one, the 2 KiB a page may write, and
//   the user verification a write needs where the authenticator verifies;
// - the credBlob and getCredBlob extensions, with CTAP 2.1's 32 bytes;
// - a conditional create (`mediation: 'conditional'`): the site waits
//   silently until its timeout or signal ends it unless the user takes the
//   host's offer, which only the proxied side can show (Chrome's virtual
//   authenticator makes none without its password manager);
// - what getClientCapabilities says of all of them.
//
// What differs on purpose: Chrome's virtual authenticator adds credProtect
// to a discoverable credential's authenticator data when it supports
// credBlob, an authenticator's own choice that STomp's does not make (left
// out of what is compared), and it keeps large blobs in one array of 1024
// bytes after compression, where STomp keeps each credential's own up to
// the 2 KiB Chrome lets a page write (a random one of 1.5 KiB: checked
// through the demo only).
import {
	done,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { parseAuthData, startPasskeysRP } from '../passkeys-rp.mjs';

const rp = await startPasskeysRP();
const HOSTS = rp.hosts;
const errors = [];
const show = (value) => (JSON.stringify(value) ?? 'undefined').slice(0, 1500);

const BASE = {
	protocol: 'ctap2',
	ctap2Version: 'ctap2_1',
	transport: 'internal',
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	hasPrf: true,
	automaticPresenceSimulation: true,
};
/** the authenticator each group runs against, natively */
const AUTHENTICATORS = {
	plain: { ...BASE, hasLargeBlob: true },
	largeBlob: { ...BASE, hasLargeBlob: true },
	credBlob: { ...BASE, hasCredBlob: true },
};
const NO_UV = { hasUserVerification: false, isUserVerified: false };

const run = (frame, name, ...args) =>
	frame.evaluate(([n, a]) => window.__pk[n](...a), [name, args]);
async function outcome(frame, id) {
	for (let i = 0; i < 300; i++) {
		const state = await frame.evaluate((n) => window.__pk.read(n), id);
		if (state?.done) return state.value;
		await sleep(100);
	}
	return { harness: 'never done' };
}

const nativeBrowser = await launch(rp.nativeArgs);
let serial = 0;
/** the relying party's page natively, on a new virtual authenticator of `group`'s */
async function nativeOpen(group, verifies) {
	const context = await nativeBrowser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(`native: ${error.message}`));
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			...AUTHENTICATORS[group],
			...(verifies ? {} : NO_UV),
		},
	});
	await page.goto(`${rp.origin(HOSTS.a)}/pk/page?id=n${++serial}`);
	await page.waitForFunction(() => window.__pk?.ready === true, null, {
		timeout: 40000,
	});
	return page.mainFrame();
}

const browser = await launch();
/** the demo with passkeys on; its sheets answered (`accept`) or left (`wait`) */
async function demo(base, uv) {
	const page = await openDemo(
		browser,
		`${base}?passkeys=test`,
		{},
		async (fresh) => {
			if (!uv) return;
			// the host verifies users with a platform authenticator of its own
			const cdp = await fresh.context().newCDPSession(fresh);
			await cdp.send('WebAuthn.enable');
			await cdp.send('WebAuthn.addVirtualAuthenticator', { options: BASE });
		},
	);
	const answers = { mode: 'accept', seen: [], open: true };
	const clicker = (async () => {
		while (answers.open) {
			try {
				const box = await page.$('#passkeyPrompt');
				if (box && answers.mode === 'accept') {
					answers.seen.push(
						await box.evaluate((element) => element.textContent),
					);
					await ((await box.$('.btn-blu')) ?? (await box.$('.close'))).click();
				}
			} catch (error) {
				// the prompt went as it was looked at
			}
			await sleep(50);
		}
	})();
	return {
		page,
		answers,
		async open() {
			const id = `p${++serial}`;
			await submitLanding(page, `${rp.origin(HOSTS.a)}/pk/page?id=${id}`);
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
			answers.open = false;
			await clicker;
			errors.push(...page.errors.map((error) => `demo: ${error}`));
			await page.close();
		},
	};
}

// --- what is compared ---

const b64 = (text) => Buffer.from(text, 'base64url');
const bytes = (base64url) => ({ $bytes: base64url });
const fill = (length, byte) => ({ $fill: [length, byte] });
// each side's accounts are its own: the relying party lists every
// credential of an account in its allow list, and a large blob is written
// for the one credential a request names
let side = '';
const user = (name, more = {}) => ({
	server: { user: `${side}${name}`, ...more },
});
const register = (top, name, more = {}, params = {}) =>
	run(top, 'register', { ...user(name, more), ...params });
const login = (top, name, extensions, more = {}, params = {}) =>
	run(top, 'login', { ...user(name, more), extensions, ...params });

/**
 * A ceremony as a page and its server read it, without the bytes an
 * authenticator makes up (keys, signatures, counter, AAGUID) and without
 * the virtual authenticator's credProtect
 */
function shape(result) {
	if (!result?.dump)
		return {
			rejected: result?.rejected ?? null,
			phase: result?.phase,
			pending: result?.pending ?? false,
			harness: result?.harness,
		};
	const { verdict, dump } = result;
	const data = parseAuthData(b64(dump.authenticatorData));
	const extensions = [...(data.extensions ?? new Map())]
		.filter(([name]) => name !== 'credProtect')
		.map(([name, value]) => [
			name,
			Buffer.isBuffer(value) ? value.toString('base64url') : value,
		]);
	const signature = dump.signature ? b64(dump.signature) : null;
	return {
		ok: verdict?.ok,
		error: verdict?.error,
		up: verdict?.up,
		uv: verdict?.uv,
		// ED only for what is left: the extensions both write
		flags: (data.flags & ~0x80) | (extensions.length ? 0x80 : 0),
		extensions,
		algorithm: dump.publicKeyAlgorithm,
		publicKey: dump.publicKey
			? [
					b64(dump.publicKey).length,
					// the start of SubjectPublicKeyInfo, before any key byte
					b64(dump.publicKey).subarray(0, 12).toString('hex'),
				]
			: undefined,
		cose: data.cose
			? [...data.cose].map(([key, value]) => [
					key,
					Buffer.isBuffer(value) ? `bytes(${value.length})` : value,
				])
			: undefined,
		signature: signature
			? signature[0] === 0x30 &&
				signature.length >= 68 &&
				signature.length <= 72
				? 'DER'
				: signature.length
			: undefined,
		read: dump.extensionBytes,
		json: JSON.parse(dump.json).clientExtensionResults,
		server: verdict?.clientExtensionResults,
	};
}
/** where two values differ: each path with both values */
function differences(native, proxied, path = '', out = []) {
	if (JSON.stringify(native) === JSON.stringify(proxied)) return out;
	if (
		native &&
		proxied &&
		typeof native === 'object' &&
		typeof proxied === 'object' &&
		Array.isArray(native) === Array.isArray(proxied)
	) {
		for (const key of new Set([
			...Object.keys(native),
			...Object.keys(proxied),
		]))
			differences(native[key], proxied[key], `${path}.${key}`, out);
		return out;
	}
	out.push(
		`${path}: ${show(native).slice(0, 300)} -> ${show(proxied).slice(0, 300)}`,
	);
	return out;
}
const same = (name, native, proxied) =>
	ok(
		name,
		native !== undefined && differences(native, proxied).length === 0,
		differences(native, proxied).join('; ').slice(0, 3000),
	);

const CAPABILITIES = [
	'conditionalCreate',
	'conditionalGet',
	'extension:credBlob',
	'extension:getCredBlob',
	'extension:largeBlob',
];

/**
 * Everything a page of the relying party does, on either side, in the
 * groups named; `open(group)` gives a page on a clean authenticator
 */
async function scenario(
	open,
	groups = ['capabilities', 'eddsa', 'largeBlob', 'credBlob', 'conditional'],
) {
	const out = {};
	if (groups.includes('capabilities')) {
		const top = await open('plain');
		const { capabilities } = await run(top, 'statics');
		out.capabilities = Object.fromEntries(
			CAPABILITIES.map((name) => [name, capabilities.value?.[name]]),
		);
	}
	if (groups.includes('eddsa')) {
		let top = await open('plain');
		const eddsa = (out.eddsa = {});
		eddsa.register = await register(top, 'ed', { algs: [-8, -7, -257] });
		eddsa.login = await login(top, 'ed');
		eddsa.es256First = await register(top, 'es', { algs: [-7, -8] });
		eddsa.rs256First = await register(top, 'rs', { algs: [-257, -8] });
		eddsa.rs256Login = await login(top, 'rs');
		// (a new page: Chrome's virtual authenticator keeps three discoverable
		// credentials, and makes no fourth)
		top = await open('plain');
		eddsa.onlyEdDSA = await register(top, 'eo', { algs: [-8] });
		eddsa.onlyEdDSALogin = await login(top, 'eo');
		eddsa.fullySpecifiedFirst = await register(top, 'fs', { algs: [-19, -8] });
		eddsa.fullySpecifiedOnly = await register(
			top,
			'fo',
			{ algs: [-19] },
			{ patch: { timeout: 1500 } },
		);
	}
	if (groups.includes('largeBlob')) {
		let top = await open('largeBlob');
		const blob = (out.largeBlob = {});
		const read = { largeBlob: { read: true } };
		const write = (value) => ({ largeBlob: { write: value } });
		blob.register = await register(top, 'lb', {
			extensions: { largeBlob: { support: 'required' } },
		});
		blob.readNone = await login(top, 'lb', read);
		blob.write = await login(top, 'lb', write(bytes('AQID')));
		blob.read = await login(top, 'lb', read);
		blob.writeDiscouraged = await login(top, 'lb', write(bytes('BAUG')), {
			userVerification: 'discouraged',
		});
		blob.readAfterDiscouraged = await login(top, 'lb', read, {
			userVerification: 'discouraged',
		});
		blob.writeEmpty = await login(top, 'lb', write(fill(0, 0)));
		blob.readEmpty = await login(top, 'lb', read);
		blob.writeLargest = await login(top, 'lb', write(fill(2048, 0)));
		blob.readLargest = await login(top, 'lb', read);
		blob.readFalse = await login(top, 'lb', { largeBlob: { read: false } });
		blob.askedNothing = await login(top, 'lb', { largeBlob: {} });
		blob.preferredNotDiscoverable = await register(top, 'lbp', {
			residentKey: 'discouraged',
			extensions: { largeBlob: { support: 'preferred' } },
		});
		blob.requiredNotDiscoverable = await register(
			top,
			'lbr',
			{
				residentKey: 'discouraged',
				extensions: { largeBlob: { support: 'required' } },
			},
			{ patch: { timeout: 1500 } },
		);
		blob.noSupportNamed = await register(top, 'lbu', {
			extensions: { largeBlob: {} },
		});
		blob.madeUpSupport = await register(top, 'lbm', {
			extensions: { largeBlob: { support: 'made-up' } },
		});
		// (a new page: Chrome's virtual authenticator keeps three discoverable
		// credentials, and makes no fourth)
		top = await open('largeBlob');
		blob.without = await register(top, 'lbw');
		blob.withoutWrite = await login(top, 'lbw', write(bytes('AQID')));
		blob.withoutRead = await login(top, 'lbw', read);
	}
	if (groups.includes('credBlob')) {
		let top = await open('credBlob');
		const cred = (out.credBlob = {});
		const get = { getCredBlob: true };
		cred.register = await register(
			top,
			'cb',
			{},
			{
				extensions: { credBlob: fill(32, 7) },
			},
		);
		cred.get = await login(top, 'cb', get);
		cred.getFalse = await login(top, 'cb', { getCredBlob: false });
		cred.tooLong = await register(
			top,
			'cbl',
			{},
			{
				extensions: { credBlob: fill(33, 7) },
			},
		);
		cred.getTooLong = await login(top, 'cbl', get);
		cred.empty = await register(
			top,
			'cbe',
			{},
			{
				extensions: { credBlob: fill(0, 0) },
			},
		);
		cred.getEmpty = await login(top, 'cbe', get);
		// (a new page: Chrome's virtual authenticator keeps three discoverable
		// credentials, and makes no fourth)
		top = await open('credBlob');
		cred.none = await register(top, 'cbn');
		cred.getNone = await login(top, 'cbn', get);
		cred.notDiscoverable = await register(
			top,
			'cbr',
			{ residentKey: 'discouraged' },
			{ extensions: { credBlob: bytes('AQIDBA') } },
		);
		cred.getNotDiscoverable = await login(top, 'cbr', get);
	}
	if (groups.includes('conditional')) {
		const top = await open('plain');
		const later = (out.conditional = {});
		const conditional = { mediation: 'conditional' };
		later.timeout = await register(
			top,
			'cc',
			{},
			{
				...conditional,
				patch: { timeout: 1500 },
			},
		);
		later.abort = await register(
			top,
			'cc',
			{},
			{
				...conditional,
				abortAfter: 400,
			},
		);
		// an account that has a passkey here already is offered no other
		later.registered = await register(top, 'cx');
		later.excluded = await register(
			top,
			'cx',
			{},
			{
				...conditional,
				patch: { timeout: 1500 },
			},
		);
	}
	return out;
}

const timing = (result) => result?.ms;

/** a ceremony's shape as an authenticator that cannot verify gives it: no UV flag */
function withoutUV(value, key = null) {
	if (key === 'flags' && typeof value === 'number') return value & ~0x04;
	if (key === 'uv' && value === true) return false;
	if (!value || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((item) => withoutUV(item));
	return Object.fromEntries(
		Object.entries(value).map(([name, item]) => [name, withoutUV(item, name)]),
	);
}

side = 'nu';
const nativeUV = await scenario((group) => nativeOpen(group, true));
// Chrome's virtual authenticator without user verification is no model of
// a provider beyond what verification decides (as in the passkeys suite:
// Chrome says conditional mediation is unavailable with it, and it stops
// making or finding credentials after a few): it is the oracle of a large
// blob written without a verification only, and the rest of a host that
// verifies nobody is the verifying authenticator's without the UV flag
side = 'nn';
const nativeNone = await scenario(
	(group) => nativeOpen(group, false),
	['largeBlob'],
);
const native = { uv: nativeUV, none: nativeNone };
/** what verification decides: a write with it discouraged, and what it left */
const BY_VERIFICATION = {
	largeBlob: ['writeDiscouraged', 'readAfterDiscouraged'],
};
ok(
	'natively the relying party verifies an EdDSA registration and assertion of the virtual authenticator',
	native.uv.eddsa.register.verdict?.ok === true &&
		native.uv.eddsa.register.dump.publicKeyAlgorithm === -8 &&
		native.uv.eddsa.login.verdict?.ok === true,
	show([native.uv.eddsa.register.verdict, native.uv.eddsa.login.verdict]),
);

for (const [mode, base, uv] of [
	['same-origin', PROXY, false],
	['isolated', HOST, true],
]) {
	const oracle = native.uv;
	const against = uv
		? 'a user-verifying authenticator'
		: 'an authenticator that cannot verify';
	/** the native shape of `group`'s `name` that the host's mode answers as */
	const expected = (group, name) =>
		uv
			? shape(native.uv[group][name])
			: BY_VERIFICATION[group]?.includes(name)
				? shape(native.none[group][name])
				: withoutUV(shape(native.uv[group][name]));
	const host = await demo(base, uv);
	side = uv ? 'pi' : 'ps';
	let proxied;
	try {
		proxied = await scenario(() => host.open());
	} catch (error) {
		ok(`${mode}: the scenario ran`, false, String(error?.stack ?? error));
		await host.close();
		continue;
	}
	same(
		`${mode}: getClientCapabilities says what Chrome says of conditional create and the largeBlob and credBlob extensions`,
		oracle.capabilities,
		proxied.capabilities,
	);
	for (const [group, label] of [
		['eddsa', 'EdDSA'],
		['largeBlob', 'largeBlob'],
		['credBlob', 'credBlob'],
		['conditional', 'conditional create'],
	]) {
		for (const name of Object.keys(oracle[group]))
			same(
				`${mode}: ${label}: ${name}: what the page and the server read is Chrome's with ${against}`,
				expected(group, name),
				shape(proxied[group][name]),
			);
	}
	ok(
		`${mode}: the relying party verifies EdDSA, RS256, largeBlob and credBlob ceremonies (by its own steps and with @simplewebauthn/server)`,
		[
			proxied.eddsa.register,
			proxied.eddsa.login,
			proxied.eddsa.rs256Login,
			proxied.eddsa.onlyEdDSALogin,
			proxied.largeBlob.write,
			proxied.largeBlob.read,
			proxied.credBlob.register,
			proxied.credBlob.get,
		].every((result) => result?.verdict?.ok === true) &&
			proxied.eddsa.register.verdict.alg === -8,
		show([proxied.eddsa.register.verdict, proxied.credBlob.get.verdict]),
	);
	ok(
		`${mode}: a conditional create ends at the page's timeout, as Chrome's`,
		Math.abs(timing(proxied.conditional.timeout) - 1500) < 500 &&
			Math.abs(timing(proxied.conditional.abort) - 400) < 300,
		show([
			timing(proxied.conditional.timeout),
			timing(oracle.conditional.timeout),
			timing(proxied.conditional.abort),
		]),
	);

	// a large blob the size Chrome lets a page write, random: kept whole
	{
		const top = await host.open();
		await register(top, 'big', {
			extensions: { largeBlob: { support: 'required' } },
		});
		const blob = Buffer.alloc(2048);
		for (let i = 0; i < blob.length; i++) blob[i] = (i * 7919 + 13) % 251;
		const written = await login(top, 'big', {
			largeBlob: { write: bytes(blob.toString('base64url')) },
		});
		const read = await login(top, 'big', { largeBlob: { read: true } });
		ok(
			`${mode}: a large blob of 2 KiB that does not compress is written and read back whole`,
			written.verdict?.ok === true &&
				JSON.parse(written.dump.json).clientExtensionResults.largeBlob
					?.written === true &&
				JSON.parse(read.dump.json).clientExtensionResults.largeBlob?.blob ===
					blob.toString('base64url'),
			show([written.dump?.json, read.dump?.json?.length]),
		);
	}

	// a conditional create the user takes: the host's offer, not a dialog
	{
		const { page, answers } = host;
		const top = await host.open();
		const id = await top.evaluate(
			(name) =>
				window.__pk.start('register', {
					server: { user: name },
					mediation: 'conditional',
					patch: { timeout: 60000 },
				}),
			`${side}offer`,
		);
		await sleep(1500);
		const waiting = await top.evaluate((n) => window.__pk.read(n), id);
		const button = await page.$eval('#toolPasskey', (element) => ({
			shown: !element.hidden,
			label: element.getAttribute('aria-label'),
		}));
		const dialog = await page.$('#passkeyPrompt');
		ok(
			`${mode}: a conditional create waits without a dialog; the address bar offers to save a passkey`,
			waiting?.done === false &&
				button.shown &&
				button.label === 'Save a passkey' &&
				dialog === null,
			show([waiting, button, dialog !== null]),
		);
		answers.seen.length = 0;
		const made = button.shown
			? await page.click('#toolPasskey').then(() => outcome(top, id))
			: await outcome(top, id);
		ok(
			`${mode}: taking it asks in the host's sheet and makes a passkey the relying party verifies`,
			made.verdict?.ok === true &&
				made.verdict.user === `${side}offer` &&
				answers.seen.some((text) =>
					text.includes(`Create a passkey for ${HOSTS.a}`),
				),
			show([made.verdict ?? made, answers.seen]),
		);
		ok(
			`${mode}: the offer goes once it is taken`,
			await page.$eval('#toolPasskey', (element) => element.hidden),
		);
		const signedIn = await login(top, 'offer');
		ok(
			`${mode}: and the passkey signs in`,
			signedIn.verdict?.ok === true,
			show(signedIn.verdict ?? signedIn),
		);
	}
	await host.close();
}

await nativeBrowser.close();
rp.close();
await done(browser, errors);
