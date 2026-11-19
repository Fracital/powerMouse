// Passkeys through the proxy (docs/passkeys.md). WebAuthn cannot work for a
// proxied page: the browser checks a relying party id against the proxy's
// origin and signs that origin. With the controller's `passkeys` option
// STomp is the passkey provider (the service worker holds the keys, decides
// who asks and signs; the host's page asks the user), and this suite holds
// it to three things:
//
// - a real relying party accepts it: test/passkeys-rp.mjs verifies every
//   registration and every assertion as WebAuthn says a server must, by its
//   own steps and again with @simplewebauthn/server (client data, rpIdHash,
//   flags, the attested key, the signature under the key kept at
//   registration);
// - a page cannot tell it from Chrome: the same page runs natively against
//   Chrome's virtual authenticator and through the demo in both modes, and
//   what it reads is compared: the interfaces, the capability statics, the
//   order a request's members are read in, every malformed and refused
//   request (class, name, message, and whether it ended in the call's own
//   task or a later one), every field of a made credential and an
//   assertion, frames with and without the permissions policy, user
//   activation, related origins;
// - user verification is real or absent: the isolated demo (on localhost, a
//   domain) has a user-verifying platform authenticator (a virtual one on the
//   host's page) and verifies the user with it, and is compared with Chrome
//   with a user-verifying authenticator; the same-origin demo (on 127.0.0.1,
//   an address, where the host can verify nobody) is compared with Chrome
//   with an authenticator that cannot verify.
//
// What differs on purpose is listed where it is compared (BY_DESIGN, and
// the fields `normalize` leaves out): the signature counter (0, where the
// virtual authenticator counts), the AAGUID (zeros), a request that waits
// for the user where the virtual authenticator answers at once, and the
// message of a credential that cannot be cloned.
//
// The demo runs with `?passkeys=test`: timeouts are taken as given, as
// Chrome takes them with a virtual authenticator.
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
import { decodeCBOR, parseAuthData, startPasskeysRP } from '../passkeys-rp.mjs';

const rp = await startPasskeysRP();
const HOSTS = rp.hosts;
const errors = [];
const show = (value) => (JSON.stringify(value) ?? 'undefined').slice(0, 1500);

// --- driving a page of the relying party, natively or through the demo ---

const AUTHENTICATOR = {
	protocol: 'ctap2',
	ctap2Version: 'ctap2_1',
	transport: 'internal',
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	hasPrf: true,
	automaticPresenceSimulation: true,
};
/** an authenticator that cannot verify the user: the oracle where the host verifies nobody */
const NO_UV = {
	...AUTHENTICATOR,
	hasUserVerification: false,
	isUserVerified: false,
};
const ALLOW = 'publickey-credentials-get; publickey-credentials-create';

const run = (frame, name, ...args) =>
	frame.evaluate(([n, a]) => window.__pk[n](...a), [name, args]);
/** the frame of `page` whose harness is `id` */
async function frameOf(page, id) {
	for (let i = 0; i < 160; i++) {
		for (const frame of page.frames()) {
			const found = await frame
				.evaluate(() => window.__pk?.ready && window.__pk.id)
				.catch(() => null);
			if (found === id) return frame;
		}
		await sleep(250);
	}
	throw new Error(`no frame ${id}`);
}
/** what a call started with start() or arm() came to */
async function outcome(frame, id) {
	for (let i = 0; i < 300; i++) {
		const state = await frame.evaluate((n) => window.__pk.read(n), id);
		if (state?.done) return state.value;
		await sleep(100);
	}
	return { harness: 'never done' };
}
/** `name` run from a real click in the frame (a user activation) */
async function armed(frame, name, ...args) {
	const id = await frame.evaluate(
		([n, a]) => window.__pk.arm(n, ...a),
		[name, args],
	);
	await frame.click('#go');
	return outcome(frame, id);
}

let serial = 0;
const nativeBrowser = await launch(rp.nativeArgs);
/** the relying party's page natively, with a virtual authenticator (null: none) */
async function nativeOpen(
	host,
	query = '',
	authenticator = AUTHENTICATOR,
	quiet = false,
) {
	const context = await nativeBrowser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(`native: ${error.message}`));
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	if (authenticator)
		await cdp.send('WebAuthn.addVirtualAuthenticator', {
			options: authenticator,
		});
	const id = `n${++serial}`;
	await page.goto(`${rp.origin(host)}/pk/page?id=${id}${query}`);
	// (the top frame alone is asked: an evaluation is a user activation,
	// and a frame under test must not get one from here)
	if (!quiet)
		await page.waitForFunction(() => window.__pk?.ready === true, null, {
			timeout: 40000,
		});
	return { page, top: page.mainFrame(), close: () => context.close() };
}

const browser = await launch();
/**
 * The demo's page with passkeys on, and its prompts answered as `answers`
 * says: `accept` (Create, OK, the first account), `cancel` or `wait`
 */
async function demo(base, { flags = 'test', uv = false } = {}) {
	// a host that can verify the user has a platform authenticator of its
	// own before the demo starts (it asks as its controller starts)
	let hostAuthenticator = null;
	const page = await openDemo(
		browser,
		`${base}?passkeys=${flags}`,
		{},
		async (fresh) => {
			if (!uv) return;
			const cdp = await fresh.context().newCDPSession(fresh);
			await cdp.send('WebAuthn.enable');
			const { authenticatorId } = await cdp.send(
				'WebAuthn.addVirtualAuthenticator',
				{ options: AUTHENTICATOR },
			);
			hostAuthenticator = { cdp, authenticatorId };
		},
	);
	const recorder = await recordRequests(page.context());
	const answers = {
		mode: 'accept',
		seen: [],
		open: true,
		// an authenticator that holds nothing, as each native page's is
		reset: () => page.evaluate(() => window.controller.passkeys.clear()),
	};
	const clicker = (async () => {
		while (answers.open) {
			try {
				// (`idle`: the page is not touched at all)
				const box =
					answers.mode === 'idle' ? null : await page.$('#passkeyPrompt');
				if (box && answers.mode !== 'wait') {
					const text = await box.evaluate((element) => element.textContent);
					const button =
						answers.mode === 'accept'
							? ((await box.$('.btn-blu')) ?? (await box.$('.close')))
							: await box.$('.close');
					// (noted first: the page's promise settles with the click)
					answers.seen.push(text);
					await button.click();
				}
			} catch (error) {
				// the prompt went as it was looked at
			}
			await sleep(50);
		}
	})();
	return {
		page,
		recorder,
		answers,
		/** what the browser's own authenticator of the host's page holds: relying party ids */
		async browserHeld() {
			if (!hostAuthenticator) return [];
			const { credentials } = await hostAuthenticator.cdp.send(
				'WebAuthn.getCredentials',
				{ authenticatorId: hostAuthenticator.authenticatorId },
			);
			return credentials.map((credential) => credential.rpId);
		},
		/** a new tab on the relying party's page: its top frame */
		async open(host, query = '', quiet = false) {
			const id = `p${++serial}`;
			await submitLanding(page, `${rp.origin(host)}/pk/page?id=${id}${query}`);
			if (quiet) return page.mainFrame();
			// a proxied top is a frame of the demo's page itself; the frames
			// under it are not asked (an evaluation is a user activation)
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
const child = (host, id, extra = '') =>
	encodeURIComponent(
		`${rp.origin(host)}/pk/page?id=${id}&top=${encodeURIComponent(rp.origin(HOSTS.a))}${extra}`,
	);
const framed = (host, id, allow, extra = '') =>
	`&frame=${child(host, id, extra)}${allow ? `&allow=${encodeURIComponent(allow)}` : ''}`;

// --- what is compared ---

const b64 = (text) => Buffer.from(text, 'base64url');
const withoutGrease = (keys) =>
	keys.filter((key) => key !== 'other_keys_can_be_added_here');
/** the keys of a JSON value, in order, at every depth */
const keyTree = (value) =>
	value && typeof value === 'object' && !Array.isArray(value)
		? Object.entries(value).map(([key, item]) => [key, keyTree(item)])
		: Array.isArray(value)
			? 'array'
			: typeof value;
/** authenticator data without what an authenticator makes up: the counter, the AAGUID, the id and key bytes */
function authDataShape(bytes) {
	const parsed = parseAuthData(bytes);
	return {
		length: bytes.length,
		rpIdHash: parsed.rpIdHash.toString('hex'),
		flags: parsed.flags,
		attested: parsed.at
			? {
					credentialId: parsed.credentialId.length,
					cose: [...parsed.cose.entries()].map(([key, item]) => [
						key,
						Buffer.isBuffer(item) ? `bytes(${item.length})` : item,
					]),
				}
			: null,
		extensions: parsed.extensions ? [...parsed.extensions.keys()] : null,
	};
}
/**
 * A credential's dump with every byte an authenticator chooses taken out:
 * what is left is what a page reads of the shape, and must be Chrome's
 */
function normalize(dump) {
	if (!dump) return dump;
	const client = JSON.parse(dump.clientDataJSON);
	const out = {
		...dump,
		id: dump.id.length,
		rawId: dump.rawId.length,
		idIsRawId: dump.id === dump.rawId,
		clientDataJSON: {
			keys: withoutGrease(Object.keys(client)),
			type: client.type,
			origin: client.origin,
			crossOrigin: client.crossOrigin,
			topOrigin: client.topOrigin,
			// Chrome writes it without a space anywhere
			compact: !/[\s]/.test(dump.clientDataJSON.replace(/"[^"]*"/g, '""')),
		},
		authenticatorData: authDataShape(b64(dump.authenticatorData)),
		json: keyTree(JSON.parse(dump.json)),
		stringify: keyTree(JSON.parse(dump.stringify)),
		// the one brand a script-made object cannot have: a platform object's
		// own DataCloneError names the interface, a proxy's names the object
		brands: {
			...dump.brands,
			clone: /DataCloneError/.test(dump.brands.clone)
				? 'DataCloneError'
				: dump.brands.clone,
		},
	};
	if (dump.attestationObject) {
		const [attestation] = decodeCBOR(b64(dump.attestationObject));
		out.attestationObject = {
			keys: [...attestation.keys()],
			fmt: attestation.get('fmt'),
			attStmt: attestation.get('attStmt').size,
			authDataIsGetAuthenticatorData: attestation
				.get('authData')
				.equals(b64(dump.authenticatorData)),
		};
		// SubjectPublicKeyInfo of a P-256 key: 26 bytes of header, then the point
		const spki = b64(dump.publicKey);
		out.publicKey = [spki.length, spki.subarray(0, 27).toString('hex')];
	} else {
		const signature = b64(dump.signature);
		// ECDSA in DER: a sequence of two integers, 70 to 72 bytes
		out.signature = [
			signature[0],
			signature.length >= 68 && signature.length <= 72,
		];
		out.userHandle = dump.userHandle === null ? null : dump.userHandle.length;
	}
	return out;
}
/** a server verdict without the counter and the AAGUID */
function verdictShape(verdict) {
	if (!verdict) return verdict;
	const out = { ...verdict };
	delete out.signCount;
	delete out.aaguid;
	if (out.clientDataKeys)
		out.clientDataKeys = withoutGrease(out.clientDataKeys);
	// the PRF's outputs are each authenticator's own: their lengths are compared
	const results = out.clientExtensionResults?.prf?.results;
	if (results)
		out.clientExtensionResults = {
			...out.clientExtensionResults,
			prf: {
				...out.clientExtensionResults.prf,
				results: Object.fromEntries(
					Object.entries(results).map(([name, value]) => [name, value.length]),
				),
			},
		};
	return out;
}
/** a ceremony's result as it is compared: how it was refused, or the verdict and the shape */
const ceremony = (result) =>
	result?.dump
		? { verdict: verdictShape(result.verdict), dump: normalize(result.dump) }
		: {
				rejected: result?.rejected ?? null,
				phase: result?.phase,
				pending: result?.pending ?? false,
				harness: result?.harness,
			};
/** a batch of cases without their timings */
const untimed = (cases) =>
	Object.fromEntries(
		Object.entries(cases).map(([name, result]) => {
			const copy = { ...result };
			delete copy.ms;
			return [name, copy];
		}),
	);
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

const NOT_ALLOWED =
	'DOMException/DOMException/NotAllowedError: The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';

// What a proxied page reads that Chrome's virtual authenticator does not
// give, each for a stated reason; everything else must be equal.
const BY_DESIGN = {
	getRefused: {
		// the virtual authenticator has no autofill to wait in and refuses a
		// conditional request at once; a browser's waits for the user, and
		// so does this, until the page's signal ends it
		conditionalAllowAborted: {
			rejected:
				'DOMException/DOMException/AbortError: signal is aborted without reason',
			phase: 'task',
		},
		conditionalAbortReason: {
			rejected: 'Error/RangeError/RangeError: later',
			phase: 'task',
		},
	},
};

// --- the native side, once ---

const GROUPS = [
	'createShape',
	'getShape',
	'createRefused',
	'getRefused',
	'signals',
	'parsers',
];
const RELATED = [
	['a list that names the caller', () => HOSTS.b],
	['a list that names others', () => HOSTS.ga],
	['a list served as text', () => `text.${HOSTS.ga}`],
	['the caller after five other labels', () => `many.${HOSTS.ga}`],
	['the caller after five origins of one label', () => `same.${HOSTS.ga}`],
	['a redirect to a list that names the caller', () => `moved.${HOSTS.ga}`],
	['JSON that does not parse', () => `bad.${HOSTS.ga}`],
	['a string where the list goes', () => `shape.${HOSTS.ga}`],
	['no file', () => HOSTS.gb],
];

/**
 * Everything a page of the relying party does, in one order, for either
 * side. `open(host, query)` gives the top frame of a new page on a clean
 * authenticator; `answers` (the demo's) says how its prompts are answered.
 */
async function scenario(open, answers = { mode: 'accept', seen: [] }) {
	const out = {};
	{
		const top = await open(HOSTS.a);
		out.shapes = await run(top, 'shapes');
		out.statics = await run(top, 'statics');
		out.order = {
			create: await run(top, 'order', 'create'),
			get: await run(top, 'order', 'get'),
		};
		out.cases = {};
		out.caseMs = {};
		for (const group of GROUPS) {
			const cases = await run(top, 'cases', group);
			out.cases[group] = untimed(cases);
			out.caseMs[group] = Object.fromEntries(
				Object.entries(cases).map(([name, result]) => [name, result.ms]),
			);
		}
	}
	{
		// whole ceremonies, each verified by the relying party
		const top = await open(HOSTS.a);
		const flow = (out.flow = {});
		flow.register = await run(top, 'register', { server: { user: 'ada' } });
		flow.login = await run(top, 'login', {});
		flow.loginAllow = await run(top, 'login', { server: { user: 'ada' } });
		flow.registerAgain = await run(top, 'register', {
			server: { user: 'ada' },
		});
		flow.second = await run(top, 'register', { server: { user: 'bob' } });
		flow.discouraged = await run(top, 'login', {
			server: { user: 'ada', userVerification: 'discouraged' },
		});
		flow.required = await run(top, 'login', {
			server: { user: 'ada', userVerification: 'required' },
		});
		flow.nonResident = await run(top, 'register', {
			server: { user: 'dan', residentKey: 'discouraged' },
		});
		flow.nonResidentLogin = await run(top, 'login', {
			server: { user: 'dan' },
		});
		flow.unknownId = await run(top, 'login', {
			server: { user: 'nobody' },
			patch: { timeout: 1500 },
			allowIds: [Buffer.alloc(32).toString('base64url')],
		});
		flow.prf = await run(top, 'register', {
			server: { user: 'eve', extensions: { credProps: true, prf: {} } },
		});
		flow.prfLogin = await run(top, 'login', {
			server: {
				user: 'eve',
				extensions: { prf: { eval: { first: 'AQIDBA' } } },
			},
		});
	}
	{
		// a name under the site uses the site's id; another site's is refused,
		// unless that site's related origins name the caller
		const top = await open(HOSTS.sub);
		const ids = (out.ids = {});
		ids.parent = await run(top, 'register', {
			server: { user: 'sue', rp: HOSTS.a },
		});
		ids.parentLogin = await run(top, 'login', { server: { rp: HOSTS.a } });
		ids.own = await run(top, 'register', { server: { user: 'sue' } });
		const suffix = await open(HOSTS.ga);
		ids.privateSuffix = await run(suffix, 'register', {
			server: { user: 'git', rp: 'github.io' },
		});
		ids.underPrivateSuffix = await run(suffix, 'register', {
			server: { user: 'git' },
		});
	}
	{
		const top = await open(HOSTS.a);
		const related = (out.related = {});
		out.relatedRequests = {};
		for (const [label, host] of RELATED) {
			const before = rp.wellKnown.fetched;
			related[label] = await run(top, 'register', {
				server: { user: `rel ${label}`, rp: host() },
			});
			out.relatedRequests[label] = {
				fetches: rp.wellKnown.fetched - before,
				...rp.wellKnown.last,
			};
		}
		related.login = await run(top, 'login', { server: { rp: HOSTS.b } });
	}
	{
		// frames: the permissions policy, the origins in the client data, and
		// the user activation a frame of another origin needs to create
		const frames = (out.frames = {});
		const inFrame = async (host, allow, steps, extra = '') => {
			const id = `k${++serial}`;
			const top = await open(HOSTS.a, framed(host, id, allow, extra));
			const kid = await frameOf(top.page(), id);
			return steps(kid, top);
		};
		frames.crossSiteNoAllow = await inFrame(HOSTS.b, null, async (kid) => ({
			statics: await run(kid, 'statics'),
			register: await armed(kid, 'register', { server: { user: 'kid' } }),
			login: await run(kid, 'login', {}),
			shape: untimed(
				await run(kid, 'cases', 'createShape', ['publicKeyEmpty', 'noRp']),
			),
			aborted: untimed(await run(kid, 'cases', 'createRefused', ['aborted'])),
			signal: untimed(await run(kid, 'cases', 'signals', ['unknownOk'])),
		}));
		frames.crossSiteAllow = await inFrame(HOSTS.b, ALLOW, async (kid) => ({
			register: await armed(kid, 'register', { server: { user: 'kid' } }),
			login: await run(kid, 'login', {}),
		}));
		frames.crossSiteGetOnly = await inFrame(
			HOSTS.b,
			'publickey-credentials-get',
			async (kid) => ({
				register: await armed(kid, 'register', { server: { user: 'kid2' } }),
			}),
		);
		frames.sameSiteNoAllow = await inFrame(HOSTS.sub, null, async (kid) => ({
			register: await armed(kid, 'register', {
				server: { user: 'ss', rp: HOSTS.a },
			}),
			login: await run(kid, 'login', { server: { rp: HOSTS.a } }),
		}));
		frames.sameSiteAllow = await inFrame(HOSTS.sub, ALLOW, async (kid) => ({
			register: await armed(kid, 'register', {
				server: { user: 'ss', rp: HOSTS.a },
			}),
			login: await run(kid, 'login', { server: { rp: HOSTS.a } }),
		}));
		frames.sameOrigin = await inFrame(HOSTS.a, null, async (kid) => ({
			register: await run(kid, 'register', {
				server: { user: 'so', top: null },
			}),
			login: await run(kid, 'login', { server: { top: null } }),
		}));
		{
			// the site's own frame inside another site's: an ancestor of
			// another origin, so the client data says crossOrigin
			const id = `k${++serial}`;
			const middle = encodeURIComponent(
				`${rp.origin(HOSTS.b)}/pk/page?id=m${serial}&frame=${child(HOSTS.a, id)}&allow=${encodeURIComponent(ALLOW)}`,
			);
			const top = await open(
				HOSTS.a,
				`&frame=${middle}&allow=${encodeURIComponent(ALLOW)}`,
			);
			const kid = await frameOf(top.page(), id);
			frames.ownInsideAnother = {
				register: await armed(kid, 'register', { server: { user: 'aba' } }),
				login: await run(kid, 'login', {}),
			};
		}
		{
			// the page's own Permissions-Policy header turns both off
			const top = await open(
				HOSTS.a,
				`&pp=${encodeURIComponent('publickey-credentials-get=(), publickey-credentials-create=()')}`,
			);
			frames.headerOff = {
				register: await run(top, 'register', { server: { user: 'pp' } }),
				login: await run(top, 'login', {}),
				statics: await run(top, 'statics'),
			};
		}
		// a frame that asks as it loads, before any user activation: of
		// another site, of the same site, of the same origin
		frames.atLoad = {};
		for (const [label, host] of [
			['cross-site', HOSTS.b],
			['same-site', HOSTS.sub],
			['same-origin', HOSTS.a],
		])
			for (const name of ['register', 'login']) {
				const id = `k${++serial}`;
				const auto = `&auto=${name}&autoArgs=${encodeURIComponent(
					JSON.stringify([
						{
							server: {
								user: 'load',
								...(label === 'same-origin' ? { top: null } : {}),
							},
							patch: { timeout: 1500 },
						},
					]),
				)}`;
				// nothing is evaluated in the page before the frame has asked
				// (the relying party hears when): an evaluation is a user
				// activation, and the demo's own page shares its origin with
				// the proxied frames in the same-origin mode
				await answers.reset?.();
				answers.mode = 'idle';
				const top = await open(HOSTS.a, framed(host, id, ALLOW, auto), true);
				for (let i = 0; i < 400 && !rp.marks.has(id); i++) await sleep(100);
				answers.mode = 'accept';
				const kid = await frameOf(top.page(), id);
				frames.atLoad[`${label} ${name}`] = await outcome(
					kid,
					await kid.evaluate(() => window.__pk.auto),
				);
			}
	}
	answers.mode = 'accept';
	return out;
}

/** the capability statics as they are compared: STomp's own authenticator answers getClientCapabilities */
const staticsShape = (statics) => ({
	uvpaa: statics.uvpaa,
	conditional: statics.conditional,
	detached: statics.detached.uvpaa,
	phase: statics.capabilities.phase,
	names: Object.keys(statics.capabilities.value ?? {}),
});

/** a scenario's ceremonies, as they are compared */
function comparable(result) {
	const each = (group) =>
		Object.fromEntries(
			Object.entries(group).map(([name, value]) => [name, ceremony(value)]),
		);
	const frames = {};
	for (const [name, value] of Object.entries(result.frames)) {
		frames[name] = {};
		for (const [key, item] of Object.entries(value))
			frames[name][key] =
				key === 'statics'
					? staticsShape(item)
					: key === 'shape' || key === 'aborted' || key === 'signal'
						? item
						: ceremony(item);
	}
	return {
		flow: each(result.flow),
		ids: each(result.ids),
		related: each(result.related),
		frames,
	};
}

const native = await scenario(
	async (host, query, quiet) =>
		(await nativeOpen(host, query, AUTHENTICATOR, quiet)).top,
);
const nativeNoUV = await scenario(
	async (host, query, quiet) =>
		(await nativeOpen(host, query, NO_UV, quiet)).top,
);
ok(
	'natively an authenticator that cannot verify the user registers without UV, says it verifies nobody, and refuses a sign-in that requires a verification',
	nativeNoUV.flow.register.verdict?.ok === true &&
		nativeNoUV.flow.register.verdict?.uv === false &&
		nativeNoUV.statics.uvpaa.value === false &&
		nativeNoUV.flow.required.rejected === NOT_ALLOWED,
	show([
		nativeNoUV.flow.register.verdict,
		nativeNoUV.statics.uvpaa,
		nativeNoUV.flow.required.rejected,
	]),
);
/**
 * Chrome where nobody can be verified, as a provider that verifies nobody
 * answers: the verifying authenticator's run with the UV flag and the
 * verifying statics taken from the authenticator that cannot verify, and
 * its refusal of a sign-in that requires a verification. Chrome's virtual
 * authenticator without user verification is no model of a provider in the
 * rest: Chrome offers it no discoverable sign-in and says conditional
 * mediation is unavailable with it, where a provider (a password manager's,
 * Chrome's own) offers both whether or not it verifies.
 */
function unverified(verifying, cannot) {
	const walk = (value, other, key) => {
		if (key === 'uvpaa') return other;
		if (!value || typeof value !== 'object') return value;
		if (Array.isArray(value))
			return value.map((item, at) => walk(item, other?.[at], at));
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [
				name,
				walk(item, other?.[name], name),
			]),
		);
	};
	const out = walk(verifying, cannot, null);
	out.flow.required = cannot.flow.required;
	return out;
}
/** ceremonies as compared (comparable), with the UV flag no authenticator that cannot verify sets */
function withoutUV(value, key = null) {
	if (key === 'flags' && typeof value === 'number') return value & ~0x04;
	if (key === 'uv' && value === true) return false;
	if (!value || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((item) => withoutUV(item));
	return Object.fromEntries(
		Object.entries(value).map(([name, item]) => [name, withoutUV(item, name)]),
	);
}
const nativeUnverified = unverified(native, nativeNoUV);
ok(
	'natively the relying party verifies a registration and an assertion of the virtual authenticator',
	native.flow.register.verdict?.ok === true &&
		native.flow.login.verdict?.ok === true &&
		native.flow.loginAllow.verdict?.ok === true,
	show([native.flow.register.verdict, native.flow.login.verdict]),
);

// what Chrome does with a request nobody answers: the virtual authenticator
// without a user's presence, a timeout, an abort
const nativeUnanswered = await (async () => {
	const { top, close } = await nativeOpen(HOSTS.a, '', {
		...AUTHENTICATOR,
		automaticPresenceSimulation: false,
	});
	const out = {
		createTimeout: await run(top, 'register', {
			server: { user: 'tim' },
			patch: { timeout: 1200 },
		}),
		getTimeout: await run(top, 'login', { patch: { timeout: 1200 } }),
		createAbort: await run(top, 'register', {
			server: { user: 'tim' },
			abortAfter: 400,
		}),
		getAbort: await run(top, 'login', { abortAfter: 400 }),
	};
	await close();
	return out;
})();

// --- the proxied side, in both modes ---

// the same-origin demo is on an address: its host can verify nobody, and is
// compared with Chrome whose authenticator cannot verify; the isolated
// demo's host is on a domain with a user-verifying platform authenticator,
// and is compared with Chrome whose authenticator verifies
for (const [mode, base, uv] of [
	['same-origin', PROXY, false],
	['isolated', HOST, true],
]) {
	const host = await demo(base, { uv });
	const { page, answers, recorder } = host;
	const oracle = uv ? native : nativeUnverified;
	let proxied;
	try {
		proxied = await scenario(
			(site, query, quiet) => host.open(site, query, quiet),
			answers,
		);
	} catch (error) {
		ok(`${mode}: the scenario ran`, false, String(error?.stack ?? error));
		await host.close();
		continue;
	}

	// 1. the interfaces
	same(
		`${mode}: the WebAuthn interfaces read as Chrome's (own properties, descriptors, names, lengths, sources, illegal invocations)`,
		oracle.shapes,
		proxied.shapes,
	);

	// 2. the capability statics: answered for STomp's authenticator
	{
		const pick = staticsShape;
		same(
			`${mode}: the capability statics answer as Chrome's with ${uv ? 'a user-verifying authenticator' : 'an authenticator that cannot verify'}, in a later task, and list the same capabilities`,
			pick(oracle.statics),
			pick(proxied.statics),
		);
		const capable = Object.entries(proxied.statics.capabilities.value ?? {})
			.filter(([, value]) => value)
			.map(([name]) => name);
		ok(
			`${mode}: getClientCapabilities says what STomp's authenticator does, and no more (a user-verifying platform authenticator only where the host verifies)`,
			show(capable) ===
				show(
					[
						'conditionalGet',
						'extension:credProps',
						'extension:prf',
						'passkeyPlatformAuthenticator',
						'relatedOrigins',
						'signalAllAcceptedCredentials',
						'signalCurrentUserDetails',
						'signalUnknownCredential',
						'userVerifyingPlatformAuthenticator',
					].filter(
						(name) =>
							uv ||
							(name !== 'passkeyPlatformAuthenticator' &&
								name !== 'userVerifyingPlatformAuthenticator'),
					),
				),
			show(capable),
		);
	}

	// 3. the members of a request are read as Chrome reads them
	same(
		`${mode}: create() reads the same members in the same order, once each`,
		oracle.order.create,
		proxied.order.create,
	);
	same(
		`${mode}: get() reads the same members in the same order, once each`,
		oracle.order.get,
		proxied.order.get,
	);

	// 4. every malformed and refused request
	for (const group of GROUPS) {
		const expected = { ...oracle.cases[group], ...BY_DESIGN[group] };
		if (
			!same(
				`${mode}: ${group}: ${Object.keys(expected).length} requests end as in Chrome (class, name, message, the call's task or a later one)`,
				expected,
				proxied.cases[group],
			)
		)
			console.log(
				`   (how long each took, natively and through the demo: ${show(
					Object.keys(expected)
						.filter(
							(name) =>
								show(expected[name]) !== show(proxied.cases[group][name]),
						)
						.map((name) => [
							name,
							oracle.caseMs[group][name],
							proxied.caseMs[group][name],
						]),
				)})`,
			);
	}

	// 5. whole ceremonies
	const want = uv ? comparable(oracle) : withoutUV(comparable(oracle));
	const got = comparable(proxied);
	ok(
		`${mode}: the relying party verifies a registration, a sign-in with a discoverable passkey and one by its id`,
		proxied.flow.register.verdict?.ok === true &&
			proxied.flow.login.verdict?.ok === true &&
			proxied.flow.loginAllow.verdict?.ok === true &&
			proxied.flow.login.verdict.user === 'ada' &&
			proxied.flow.nonResidentLogin.verdict?.ok === true,
		show([
			proxied.flow.register.verdict,
			proxied.flow.login.verdict,
			proxied.flow.loginAllow.verdict,
		]),
	);
	ok(
		`${mode}: STomp's own marks: a zero signature counter, a zero AAGUID, none attestation, not backup eligible`,
		proxied.flow.register.verdict?.signCount === 0 &&
			proxied.flow.login.verdict?.signCount === 0 &&
			proxied.flow.register.verdict?.aaguid === '0'.repeat(32) &&
			proxied.flow.register.verdict?.fmt === 'none' &&
			proxied.flow.register.verdict?.be === false &&
			proxied.flow.register.verdict?.bs === false,
		show(proxied.flow.register.verdict),
	);
	for (const [name, label] of [
		['register', 'a registration'],
		['login', 'a sign-in with a discoverable passkey'],
		['loginAllow', 'a sign-in by credential id'],
		['registerAgain', 'a registration the exclude list refuses'],
		['second', "a second user's registration"],
		['discouraged', 'a sign-in with user verification discouraged'],
		['required', 'a sign-in with user verification required'],
		['nonResident', 'a registration that asks for no discoverable credential'],
		['nonResidentLogin', 'a sign-in with that credential'],
		['unknownId', 'a sign-in by an id nobody holds'],
		['prf', 'a registration with the PRF extension'],
		['prfLogin', 'a sign-in that evaluates the PRF'],
	])
		same(
			`${mode}: ${label}: every field a page reads and the server's verdict are Chrome's`,
			want.flow[name],
			got.flow[name],
		);
	for (const [name, label] of [
		['parent', "a name under the site registers under the site's id"],
		['parentLogin', 'and signs in under it'],
		['own', 'a name under the site registers under its own id'],
		['privateSuffix', 'a private suffix (github.io) is no relying party id'],
		['underPrivateSuffix', 'a site under a private suffix is one'],
	])
		same(`${mode}: ${label}, as in Chrome`, want.ids[name], got.ids[name]);

	// 6. related origins: asked through the proxy, as Chrome asks
	for (const [label] of RELATED) {
		same(
			`${mode}: another site's id with ${label}: as in Chrome`,
			want.related[label],
			got.related[label],
		);
		const pick = (request) => ({
			fetches: request.fetches,
			headers: request.headers,
			cookie: request.cookie,
			referer: request.referer,
			origin: request.origin,
			dest: request.dest,
			mode: request.mode,
			site: request.site,
		});
		same(
			`${mode}: ${label}: the /.well-known/webauthn request is Chrome's (headers in order, no cookie, referrer or origin)`,
			pick(oracle.relatedRequests[label]),
			pick(proxied.relatedRequests[label]),
		);
	}
	same(
		`${mode}: a sign-in under a related origin's id, as in Chrome`,
		want.related.login,
		got.related.login,
	);

	// 7. frames
	for (const [name, label] of [
		[
			'crossSiteNoAllow',
			"a frame of another site without allow: the policy's refusal, after the bindings' and an aborted signal's",
		],
		[
			'crossSiteAllow',
			'a frame of another site with allow: crossOrigin and topOrigin in the client data',
		],
		['crossSiteGetOnly', 'a frame allowed to get only may not create'],
		[
			'sameSiteNoAllow',
			'a frame of the same site and another origin without allow',
		],
		['sameSiteAllow', 'a frame of the same site and another origin with allow'],
		['sameOrigin', 'a frame of the same origin'],
		['ownInsideAnother', "the site's own frame inside another site's frame"],
		['headerOff', 'a page whose own Permissions-Policy turns WebAuthn off'],
		[
			'atLoad',
			'a frame that asks as it loads: another origin needs a user activation to create, none to get',
		],
	])
		same(
			`${mode}: ${label}: as in Chrome`,
			want.frames[name],
			got.frames[name],
		);

	// 8. the user's answer in the host's page
	{
		const top = await host.open(HOSTS.a);
		await run(top, 'register', { server: { user: 'una' } });
		const asked = answers.seen.at(-1) ?? '';
		ok(
			`${mode}: a registration asks in the host's page, naming the relying party id and the account`,
			asked.includes(`Create a passkey for ${HOSTS.a}`) &&
				asked.includes(`una@${HOSTS.a}`),
			asked,
		);
		await run(top, 'login', {});
		const chooser = answers.seen.at(-1) ?? '';
		ok(
			`${mode}: a sign-in shows the accounts that have a passkey for the site`,
			chooser.includes(`Use a saved passkey for ${HOSTS.a}`) &&
				chooser.includes(`una@${HOSTS.a}`),
			chooser,
		);
		ok(
			`${mode}: the prompt is the host page's: no proxied document has one`,
			(
				await Promise.all(
					page
						.frames()
						.filter((frame) => frame !== page.mainFrame())
						.map((frame) =>
							frame
								.evaluate(() => !!document.getElementById('passkeyPrompt'))
								.catch(() => false),
						),
				)
			).every((has) => !has),
		);

		answers.mode = 'cancel';
		const cancelled = {
			create: await run(top, 'register', { server: { user: 'vic' } }),
			get: await run(top, 'login', {}),
		};
		same(
			`${mode}: Cancel in the host's prompt ends a request as Chrome ends one nobody answered`,
			{
				create: nativeUnanswered.createTimeout.rejected,
				get: nativeUnanswered.getTimeout.rejected,
				phase: 'task',
			},
			{
				create: cancelled.create.rejected,
				get: cancelled.get.rejected,
				phase: cancelled.create.phase,
			},
		);

		// a request nobody answers: the page's timeout and its signal end it,
		// and the host's prompt goes with it
		answers.mode = 'wait';
		const timed = {
			createTimeout: await run(top, 'register', {
				server: { user: 'tim' },
				patch: { timeout: 1200 },
			}),
			getTimeout: await run(top, 'login', { patch: { timeout: 1200 } }),
			createAbort: await run(top, 'register', {
				server: { user: 'tim' },
				abortAfter: 400,
			}),
			getAbort: await run(top, 'login', { abortAfter: 400 }),
		};
		const pick = (results) =>
			Object.fromEntries(
				Object.entries(results).map(([name, result]) => [
					name,
					[result.rejected, result.phase],
				]),
			);
		same(
			`${mode}: a timeout and an abort end a waiting request as in Chrome`,
			pick(nativeUnanswered),
			pick(timed),
		);
		ok(
			`${mode}: they end when Chrome's do: at the page's timeout, at the abort`,
			Math.abs(timed.createTimeout.ms - 1200) < 400 &&
				Math.abs(timed.getTimeout.ms - 1200) < 400 &&
				Math.abs(timed.createAbort.ms - 400) < 300 &&
				Math.abs(timed.getAbort.ms - 400) < 300,
			show([
				timed.createTimeout.ms,
				timed.getTimeout.ms,
				timed.createAbort.ms,
				timed.getAbort.ms,
				nativeUnanswered.createTimeout.ms,
				nativeUnanswered.createAbort.ms,
			]),
		);
		await sleep(300);
		ok(
			`${mode}: the host's prompt closes with the request it asked about`,
			(await page.$('#passkeyPrompt')) === null,
		);
		// Chrome checks the focus for create() only: a get() while the focus
		// is in the host's address bar waits as one from the frame does (it
		// was refused at once, and so was one asked while the host's sheet of
		// the request before still held the focus: getAbort above and the
		// getRefused group's conditionalAllowAborted, now and then)
		await page.focus('#omni input');
		const unfocused = await run(top, 'login', { abortAfter: 400 });
		same(
			`${mode}: a get() while the focus is in the host's address bar waits for the user, as in Chrome`,
			pick({ getAbort: nativeUnanswered.getAbort }),
			pick({ getAbort: unfocused }),
		);
		ok(
			`${mode}: it ends at the abort`,
			Math.abs(unfocused.ms - 400) < 300,
			show(unfocused.ms),
		);
		answers.mode = 'accept';
	}

	// 9. conditional mediation: the site waits, the host offers, the user asks
	{
		const top = await host.open(HOSTS.a);
		await run(top, 'register', { server: { user: 'con' } });
		const id = await top.evaluate(() =>
			window.__pk.start('login', { mediation: 'conditional' }),
		);
		await sleep(1500);
		const waiting = await top.evaluate((n) => window.__pk.read(n), id);
		const offered = await page.$eval(
			'#toolPasskey',
			(button) => !button.hidden,
		);
		const dialog = await page.$('#passkeyPrompt');
		ok(
			`${mode}: a conditional request waits without a dialog; the address bar offers the passkey`,
			waiting?.done === false && offered && dialog === null,
			show([waiting, offered, dialog !== null]),
		);
		await page.click('#toolPasskey');
		const signedIn = await outcome(top, id);
		ok(
			`${mode}: choosing it there signs in, and the relying party verifies the assertion`,
			signedIn.verdict?.ok === true && signedIn.verdict.user === 'con',
			show(signedIn.verdict ?? signedIn),
		);
		ok(
			`${mode}: the offer goes once it is taken`,
			await page.$eval('#toolPasskey', (button) => button.hidden),
		);
		// a site with no passkey here waits too, and shows nothing
		const other = await host.open(HOSTS.gb);
		const none = await other.evaluate(() =>
			window.__pk.start('login', {
				mediation: 'conditional',
				abortAfter: 1200,
			}),
		);
		await sleep(600);
		const quiet =
			(await page.$eval('#toolPasskey', (button) => button.hidden)) &&
			(await page.$('#passkeyPrompt')) === null;
		const ended = await outcome(other, none);
		ok(
			`${mode}: a conditional request of a site with no passkey shows nothing and ends with the page's signal`,
			quiet && /AbortError/.test(ended.rejected ?? ''),
			show([quiet, ended]),
		);
	}

	// 10. two sites: a passkey is its relying party's and no other's
	{
		const list = () => page.evaluate(() => window.controller.passkeys.list());
		const a = await host.open(HOSTS.a);
		await run(a, 'register', { server: { user: 'iso' } });
		const b = await host.open(HOSTS.gb);
		answers.seen.length = 0;
		const foreign = await run(b, 'login', {});
		ok(
			`${mode}: another site is offered none of them: its sign-in finds no passkey`,
			foreign.rejected === NOT_ALLOWED &&
				answers.seen
					.at(-1)
					?.includes(`You don't have a passkey for ${HOSTS.gb} saved here`),
			show([foreign, answers.seen]),
		);
		// by id too: the id of a's passkey, asked for by b
		const held = (await list()).filter((entry) => entry.rpId === HOSTS.a);
		const byId = await run(b, 'login', { allowIds: [held[0].id] });
		ok(
			`${mode}: nor by its id: a passkey of one relying party answers no other`,
			held.length > 0 && byId.rejected === NOT_ALLOWED,
			show(byId),
		);

		// the host's view of the store, with a passkey of the other site in it
		await run(b, 'register', { server: { user: 'oth' } });
		const all = await list();
		const ofA = await page.evaluate(
			(rpId) => window.controller.passkeys.list(rpId),
			HOSTS.a,
		);
		ok(
			`${mode}: controller.passkeys.list() names every passkey with its relying party and account, and no key`,
			all.length > ofA.length &&
				ofA.length > 0 &&
				ofA.every((entry) => entry.rpId === HOSTS.a) &&
				all.every(
					(entry) =>
						Object.keys(entry).sort().join() ===
						'created,discoverable,id,lastUsed,rpId,userDisplayName,userHandle,userName',
				),
			show(all.slice(0, 2)),
		);

		// the signal API changes what is held, with no prompt
		const target = ofA.find((entry) => entry.userName === `iso@${HOSTS.a}`);
		answers.seen.length = 0;
		await a.evaluate(
			([rpId, userId]) =>
				PublicKeyCredential.signalCurrentUserDetails({
					rpId,
					userId,
					name: 'renamed',
					displayName: 'Renamed',
				}),
			[HOSTS.a, target.userHandle],
		);
		const renamed = (await list()).find((entry) => entry.id === target.id);
		await a.evaluate(
			([rpId, credentialId]) =>
				PublicKeyCredential.signalUnknownCredential({ rpId, credentialId }),
			[HOSTS.a, target.id],
		);
		const afterUnknown = await list();
		ok(
			`${mode}: signalCurrentUserDetails renames a passkey and signalUnknownCredential forgets it, without a prompt`,
			renamed?.userName === 'renamed' &&
				renamed.userDisplayName === 'Renamed' &&
				!afterUnknown.some((entry) => entry.id === target.id) &&
				answers.seen.length === 0,
			show([renamed, answers.seen]),
		);
		// another site's signal changes nothing of this one's
		const before = (await list()).length;
		const crossSignal = await b
			.evaluate(
				([rpId, credentialId]) =>
					PublicKeyCredential.signalUnknownCredential({
						rpId,
						credentialId,
					}).then(
						() => 'resolved',
						(error) => error.name,
					),
				[HOSTS.a, ofA[0].id],
			)
			.catch(String);
		ok(
			`${mode}: a site cannot signal for another's relying party id`,
			crossSignal === 'SecurityError' && (await list()).length === before,
			show([crossSignal, before]),
		);

		const first = (await list())[0];
		const deleted = await page.evaluate(
			(id) => window.controller.passkeys.delete(id),
			first.id,
		);
		const again = await page.evaluate(
			(id) => window.controller.passkeys.delete(id),
			first.id,
		);
		const afterDelete = await list();
		await page.evaluate(
			(rpId) => window.controller.passkeys.clear(rpId),
			HOSTS.a,
		);
		const afterClearOne = await list();
		await page.evaluate(() => window.controller.passkeys.clear());
		ok(
			`${mode}: controller.passkeys deletes one, clears a relying party's, clears all`,
			deleted === true &&
				again === false &&
				afterDelete.length === before - 1 &&
				!afterClearOne.some((entry) => entry.rpId === HOSTS.a) &&
				(await list()).length === 0,
			show([deleted, again, afterDelete.length, afterClearOne.length]),
		);
	}

	// 11. where the keys are: the worker's own database on the proxy origin,
	// which no hooked path of a proxied page reaches
	{
		const a = await host.open(HOSTS.a);
		await run(a, 'register', { server: { user: 'key' } });
		// the proxy origin itself, outside every inject: the host's page in
		// the same-origin mode, the controller frame in the isolated one (with
		// the site pool too: every slot's worker keeps the credentials there,
		// src/server/jarDB.ts)
		const own =
			mode === 'isolated'
				? page.frames().find((frame) => /controllerFrame/.test(frame.url()))
				: page.mainFrame();
		const names = (context) =>
			context
				.evaluate(async () =>
					(await indexedDB.databases()).map((database) => database.name),
				)
				.catch((error) => [String(error)]);
		const onOrigin = own ? await names(own) : [];
		const inPage = await names(a);
		// what a proxied page opens by the store's name is its own database
		const opened = await a.evaluate(
			() =>
				new Promise((resolve) => {
					const request = indexedDB.open('stompPasskeys');
					request.onsuccess = () => {
						resolve([...request.result.objectStoreNames]);
						request.result.close();
					};
					request.onerror = () => resolve(String(request.error));
				}),
		);
		ok(
			`${mode}: the keys are in the worker's stompPasskeys on the proxy origin, and a proxied page neither lists it nor opens it (it opens a database of its own by that name, empty)`,
			onOrigin.includes('stompPasskeys') &&
				!inPage.includes('stompPasskeys') &&
				Array.isArray(opened) &&
				opened.length === 0,
			show({ onOrigin, inPage, opened }),
		);
		const key = own
			? await own.evaluate(
					() =>
						new Promise((resolve) => {
							const request = indexedDB.open('stompPasskeys');
							request.onsuccess = () => {
								const all = request.result
									.transaction('credentials')
									.objectStore('credentials')
									.getAll();
								all.onsuccess = async () => {
									const held = all.result[0];
									if (!held) return resolve(null);
									resolve({
										type: held.privateKey.type,
										extractable: held.privateKey.extractable,
										exported: await crypto.subtle
											.exportKey('pkcs8', held.privateKey)
											.then(
												() => 'exported',
												(error) => error.name,
											),
									});
								};
							};
						}),
				)
			: null;
		ok(
			`${mode}: a private key is a CryptoKey that cannot be exported, even from the proxy origin outside the inject`,
			key?.type === 'private' &&
				key.extractable === false &&
				key.exported === 'InvalidAccessError',
			show(key),
		);
		// and the browser's own authenticator was never used for a proxied
		// site: what the host's holds is its own, for user verification
		const held = await host.browserHeld();
		ok(
			`${mode}: the browser's own authenticator holds nothing for a proxied site or the proxy origin`,
			held.every((rpId) => rpId === 'localhost') &&
				(uv ? held.length >= 1 : held.length === 0),
			show(held),
		);
	}

	// 12. nothing went past the proxy
	const raw = recorder.raw();
	ok(
		`${mode}: no request left the proxy (the browser's own WebAuthn, which asks a relying party directly, was never reached)`,
		raw.length === 0,
		show(raw.map((entry) => entry.url)),
	);
	await host.close();
}

// --- the option off: a page has what it had ---

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const host = await demo(base, { flags: 'off' });
	const top = await host.open(HOSTS.a);
	const statics = await run(top, 'statics');
	const refused = untimed(
		await run(top, 'cases', 'createRefused', ['rpIdOther']),
	);
	const flow = {
		register: await run(top, 'register', { server: { user: 'off' } }),
		login: await run(top, 'login', {}),
	};
	// the browser's own answer for the proxy origin: an address is no
	// relying party. An isolated frame has the page's WebAuthn policy, as a
	// top page has, so it gets the same answer
	const expected =
		'DOMException/DOMException/SecurityError: This is an invalid domain.';
	ok(
		`${mode}: without the option a page's requests end in the browser's own refusal, and no prompt shows`,
		flow.register.rejected === expected &&
			refused.rpIdOther.rejected === expected &&
			/^DOMException\/DOMException\/(SecurityError|NotAllowedError)/.test(
				flow.login.rejected ?? '',
			) &&
			host.answers.seen.length === 0,
		show([flow, refused, host.answers.seen]),
	);
	console.log(
		`${mode}: the capability statics without the option, recorded, not compared: ${show({ uvpaa: statics.uvpaa.value, conditional: statics.conditional.value })}`,
	);
	await host.close();
}

await nativeBrowser.close();
rp.close();
await done(browser, errors);
