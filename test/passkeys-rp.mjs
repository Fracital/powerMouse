// A relying party for the passkeys suite: it makes the options a real
// site's server would, and verifies what comes back as WebAuthn says a
// relying party must (Level 3, 7.1 "Registering a new credential" and 7.2
// "Verifying an authentication assertion"), twice over: with Node's crypto
// by the steps below, and again with a maintained server library,
// @simplewebauthn/server, as a real site would. Nothing here trusts the
// page: a registration is kept only when both say its client data,
// authenticator data, attestation and key check, and a sign-in passes only
// when both verify the signature under the key kept then.
//
// One server on 127.0.0.1 answers for every name, in TLS with a self-signed
// certificate and in plain http on the same port, as test/private-sites.mjs
// does. A relying party id names no port, and Chrome asks a related
// origin's /.well-known/webauthn on the default one, so the sites are on
// their scheme's default port and the server's port is in their names
// (`P` below), as the visited suite's are: Chrome maps the names to the
// server (`nativeArgs`), the demo's test transport (STOMP_TEST_TRANSPORT=1,
// demo/public/test/mixed-transport.mjs) sends them there in plain http.
//
//   pkP-a.co.uk            a site; its relying party id is its own name
//   www.pkP-a.co.uk        a name under it, which may use pkP-a.co.uk
//   pkP-b.co.uk            another site, whose /.well-known/webauthn names
//                          pkP-a.co.uk's origin (related origins)
//   pkP-a.github.io, pkP-b.github.io
//                          two sites under a private suffix. The second has
//                          no /.well-known/webauthn; the first's names
//                          another origin only, and the names under it
//                          serve the list in the ways a client must refuse
//                          or take: `text.` as text/plain, `many.` after
//                          five other labels, `same.` after five origins of
//                          one label, `moved.` behind a redirect, `bad.`
//                          as JSON that does not parse, `shape.` with a
//                          string where the list goes
//
//   /pk/page                test/pages/passkeys.html (the harness);
//                           `pp=<policy>` sends it as Permissions-Policy
//   /pk/harness.js          test/pages/passkeys.js
//   /pk/mark?k=<id>         a page says it has made the request it makes
//                           as it loads (`marks`)
//   /pk/register/options    POST { k, rp, user, ... } -> creation options
//   /pk/register/verify     POST { k, credential } -> { ok, ... }
//   /pk/login/options       POST { k, rp, user?, ... } -> request options
//   /pk/login/verify        POST { k, credential } -> { ok, ... }
//   /.well-known/webauthn   on stomp-b.co.uk only
//
// `k` names a ceremony: the challenge made for it is taken once.
import {
	createHash,
	createPublicKey,
	randomBytes,
	verify,
	X509Certificate,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHTTP } from 'node:http';
import { createServer as createHTTPS } from 'node:https';
import { fileURLToPath } from 'node:url';
import {
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { certificate, tlsOrPlain } from './mixed-servers.mjs';

const PAGE = fileURLToPath(new URL('./pages/passkeys.html', import.meta.url));
const HARNESS = fileURLToPath(new URL('./pages/passkeys.js', import.meta.url));

/** the names of the relying party on `port` */
export const hostsOf = (port) => ({
	a: `pk${port}-a.co.uk`,
	sub: `www.pk${port}-a.co.uk`,
	b: `pk${port}-b.co.uk`,
	ga: `pk${port}-a.github.io`,
	gb: `pk${port}-b.github.io`,
});

const nativeArgs = (spki, port) => [
	`--ignore-certificate-errors-spki-list=${spki}`,
	`--host-resolver-rules=${['co.uk', 'github.io']
		.flatMap((suffix) => [
			`MAP pk${port}-a.${suffix} 127.0.0.1:${port}`,
			`MAP *.pk${port}-a.${suffix} 127.0.0.1:${port}`,
			`MAP pk${port}-b.${suffix} 127.0.0.1:${port}`,
		])
		.join(
			', ',
		)}, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1`,
];

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const unb64url = (text) => {
	if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text))
		throw new Error('not base64url');
	return Buffer.from(text, 'base64url');
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

/**
 * One CBOR item of `bytes` at `at` (RFC 8949, definite lengths only, as
 * CTAP2's canonical form has): [value, the offset after it]. A map is a
 * Map, so its keys keep their order and their types.
 */
export function decodeCBOR(bytes, at = 0) {
	const first = bytes[at];
	if (first === undefined) throw new Error('CBOR: out of bytes');
	const major = first >> 5;
	const info = first & 31;
	let offset = at + 1;
	let value;
	if (info < 24) value = info;
	else if (info === 24) value = bytes.readUInt8(offset++);
	else if (info === 25) {
		value = bytes.readUInt16BE(offset);
		offset += 2;
	} else if (info === 26) {
		value = bytes.readUInt32BE(offset);
		offset += 4;
	} else if (info === 27) {
		value = Number(bytes.readBigUInt64BE(offset));
		offset += 8;
	} else throw new Error(`CBOR: additional information ${info}`);
	if (major === 0) return [value, offset];
	if (major === 1) return [-1 - value, offset];
	if (major === 2 || major === 3) {
		const end = offset + value;
		if (end > bytes.length) throw new Error('CBOR: string past the end');
		const slice = bytes.subarray(offset, end);
		return [major === 2 ? Buffer.from(slice) : slice.toString('utf8'), end];
	}
	if (major === 4) {
		const list = [];
		for (let i = 0; i < value; i++) {
			const [item, next] = decodeCBOR(bytes, offset);
			list.push(item);
			offset = next;
		}
		return [list, offset];
	}
	if (major === 5) {
		const map = new Map();
		for (let i = 0; i < value; i++) {
			const [key, afterKey] = decodeCBOR(bytes, offset);
			const [item, next] = decodeCBOR(bytes, afterKey);
			if (map.has(key)) throw new Error('CBOR: a key twice');
			map.set(key, item);
			offset = next;
		}
		return [map, offset];
	}
	if (major === 7) {
		if (info === 20) return [false, offset];
		if (info === 21) return [true, offset];
		if (info === 22) return [null, offset];
	}
	throw new Error(`CBOR: major type ${major}, ${info}`);
}

/** authenticator data (6.1), taken apart; throws on anything out of place */
export function parseAuthData(data) {
	if (data.length < 37) throw new Error('authenticator data under 37 bytes');
	const flags = data[32];
	const out = {
		rpIdHash: data.subarray(0, 32),
		flags,
		up: !!(flags & 0x01),
		uv: !!(flags & 0x04),
		be: !!(flags & 0x08),
		bs: !!(flags & 0x10),
		at: !!(flags & 0x40),
		ed: !!(flags & 0x80),
		signCount: data.readUInt32BE(33),
	};
	if (flags & 0x22) throw new Error('reserved flag bits set');
	if (out.bs && !out.be) throw new Error('backed up but not eligible');
	let offset = 37;
	if (out.at) {
		if (data.length < offset + 18) throw new Error('no attested data');
		out.aaguid = data.subarray(offset, offset + 16).toString('hex');
		const length = data.readUInt16BE(offset + 16);
		offset += 18;
		if (length < 1 || length > 1023)
			throw new Error(`credential id of ${length} bytes`);
		out.credentialId = data.subarray(offset, offset + length);
		offset += length;
		const [key, next] = decodeCBOR(data, offset);
		out.coseBytes = data.subarray(offset, next);
		out.cose = key;
		offset = next;
	}
	if (out.ed) {
		const [extensions, next] = decodeCBOR(data, offset);
		if (!(extensions instanceof Map))
			throw new Error('extensions are not a map');
		out.extensions = extensions;
		offset = next;
	}
	if (offset !== data.length)
		throw new Error(
			`${data.length - offset} bytes after the authenticator data`,
		);
	return out;
}

/**
 * A COSE_Key (RFC 9052) as a Node public key: ES256 on P-256 (kty EC2),
 * EdDSA on Ed25519 (kty OKP, RFC 9053 7.2) or RS256 (kty RSA, RFC 8230),
 * with its members in CTAP2's canonical order (shorter first, then
 * bytewise). `jwk` is what the key's SubjectPublicKeyInfo must say too.
 */
function coseToKey(cose) {
	if (!(cose instanceof Map)) throw new Error('the key is not a map');
	const keys = [...cose.keys()].join();
	const alg = cose.get(3);
	const bytesOf = (label, length) => {
		const value = cose.get(label);
		if (!Buffer.isBuffer(value) || (length && value.length !== length))
			throw new Error(`COSE key member ${label} is not ${length} bytes`);
		return value;
	};
	let jwk;
	if (alg === -7) {
		if (keys !== '1,3,-1,-2,-3') throw new Error(`COSE key members ${keys}`);
		if (cose.get(1) !== 2) throw new Error(`kty ${cose.get(1)}`);
		if (cose.get(-1) !== 1) throw new Error(`crv ${cose.get(-1)}`);
		jwk = {
			kty: 'EC',
			crv: 'P-256',
			x: b64url(bytesOf(-2, 32)),
			y: b64url(bytesOf(-3, 32)),
		};
	} else if (alg === -8) {
		if (keys !== '1,3,-1,-2') throw new Error(`COSE key members ${keys}`);
		if (cose.get(1) !== 1) throw new Error(`kty ${cose.get(1)}`);
		if (cose.get(-1) !== 6) throw new Error(`crv ${cose.get(-1)}`);
		jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url(bytesOf(-2, 32)) };
	} else if (alg === -257) {
		if (keys !== '1,3,-1,-2') throw new Error(`COSE key members ${keys}`);
		if (cose.get(1) !== 3) throw new Error(`kty ${cose.get(1)}`);
		jwk = { kty: 'RSA', n: b64url(bytesOf(-1, 256)), e: b64url(bytesOf(-2)) };
	} else throw new Error(`alg ${alg}`);
	return { alg, jwk, key: createPublicKey({ key: jwk, format: 'jwk' }) };
}

function clientData(json, type, expected) {
	const text = unb64url(json).toString('utf8');
	const data = JSON.parse(text);
	if (data.type !== type) throw new Error(`type ${data.type}`);
	if (data.challenge !== expected.challenge)
		throw new Error('the challenge is not the one this ceremony was given');
	if (data.origin !== expected.origin)
		throw new Error(`origin ${data.origin}, expected ${expected.origin}`);
	if (expected.topOrigin === undefined) {
		if (data.crossOrigin !== false && data.crossOrigin !== undefined)
			throw new Error('crossOrigin in a top-level ceremony');
		if (data.topOrigin !== undefined)
			throw new Error('topOrigin in a top-level ceremony');
	} else {
		if (data.crossOrigin !== true) throw new Error('crossOrigin is not true');
		if (data.topOrigin !== expected.topOrigin)
			throw new Error(`topOrigin ${data.topOrigin}`);
	}
	if (data.tokenBinding !== undefined) throw new Error('token binding');
	return { text, keys: Object.keys(data), data };
}

/** 7.1: every step a relying party makes of a registration; throws or describes it */
export function verifyRegistration(credential, expected) {
	if (credential.type !== 'public-key') throw new Error('type');
	const response = credential.response;
	const client = clientData(
		response.clientDataJSON,
		'webauthn.create',
		expected,
	);
	const [attestation, end] = decodeCBOR(unb64url(response.attestationObject));
	if (end !== unb64url(response.attestationObject).length)
		throw new Error('bytes after the attestation object');
	if (!(attestation instanceof Map)) throw new Error('attestation object');
	const members = [...attestation.keys()];
	if ([...members].sort().join() !== 'attStmt,authData,fmt')
		throw new Error(`attestation object members ${members.join()}`);
	const authData = attestation.get('authData');
	if (!Buffer.isBuffer(authData)) throw new Error('authData is not bytes');
	const parsed = parseAuthData(authData);
	if (!parsed.rpIdHash.equals(sha256(expected.rpId)))
		throw new Error('rpIdHash is not the hash of the relying party id');
	if (!parsed.up) throw new Error('user not present');
	if (expected.userVerification === 'required' && !parsed.uv)
		throw new Error('user not verified');
	if (!parsed.at) throw new Error('no attested credential data');
	const key = coseToKey(parsed.cose);
	if (!expected.algs.includes(key.alg))
		throw new Error(`algorithm ${key.alg} was not asked for`);
	const fmt = attestation.get('fmt');
	const statement = attestation.get('attStmt');
	if (!(statement instanceof Map)) throw new Error('attStmt is not a map');
	if (fmt === 'none') {
		if (statement.size !== 0) throw new Error('none attestation with members');
	} else if (expected.attestation !== 'packed-self' || fmt !== 'packed') {
		throw new Error(`attestation format ${fmt}`);
	}
	// the JSON form says the same as the bytes
	if (credential.id !== b64url(parsed.credentialId))
		throw new Error('id is not the credential id');
	if (credential.rawId !== credential.id)
		throw new Error('rawId is not the id');
	if (response.authenticatorData !== b64url(authData))
		throw new Error('authenticatorData is not the attested one');
	if (response.publicKeyAlgorithm !== key.alg)
		throw new Error(`publicKeyAlgorithm ${response.publicKeyAlgorithm}`);
	const spki = createPublicKey({
		key: unb64url(response.publicKey),
		format: 'der',
		type: 'spki',
	}).export({ format: 'jwk' });
	for (const member of ['kty', 'crv', 'x', 'y', 'n', 'e'])
		if (spki[member] !== key.jwk[member])
			throw new Error('publicKey is not the attested key');
	if (
		!Array.isArray(response.transports) ||
		response.transports.some((transport) => typeof transport !== 'string')
	)
		throw new Error('transports');
	return {
		credentialId: parsed.credentialId,
		key: key.key,
		signCount: parsed.signCount,
		describe: {
			fmt,
			attestationMembers: members,
			clientDataKeys: client.keys,
			crossOrigin: client.data.crossOrigin ?? null,
			topOrigin: client.data.topOrigin ?? null,
			flags: parsed.flags,
			up: parsed.up,
			uv: parsed.uv,
			be: parsed.be,
			bs: parsed.bs,
			ed: parsed.ed,
			signCount: parsed.signCount,
			aaguid: parsed.aaguid,
			credentialIdLength: parsed.credentialId.length,
			coseLength: parsed.coseBytes.length,
			alg: key.alg,
			extensions: parsed.extensions ? [...parsed.extensions.keys()] : null,
			transports: response.transports,
			attachment: credential.authenticatorAttachment ?? null,
			clientExtensionResults: credential.clientExtensionResults ?? null,
		},
	};
}

/** 7.2: every step a relying party makes of an assertion; throws or describes it */
export function verifyAssertion(credential, expected, stored) {
	if (credential.type !== 'public-key') throw new Error('type');
	if (credential.rawId !== credential.id)
		throw new Error('rawId is not the id');
	const response = credential.response;
	const client = clientData(response.clientDataJSON, 'webauthn.get', expected);
	const authData = unb64url(response.authenticatorData);
	const parsed = parseAuthData(authData);
	if (!parsed.rpIdHash.equals(sha256(expected.rpId)))
		throw new Error('rpIdHash is not the hash of the relying party id');
	if (!parsed.up) throw new Error('user not present');
	if (expected.userVerification === 'required' && !parsed.uv)
		throw new Error('user not verified');
	if (parsed.at) throw new Error('attested data in an assertion');
	const signature = unb64url(response.signature);
	const signed = Buffer.concat([
		authData,
		sha256(unb64url(response.clientDataJSON)),
	]);
	// ES256 signatures are ASN.1 DER (6.5.5), which is what Node verifies;
	// EdDSA's hash nothing first
	if (
		!verify(
			stored.key.asymmetricKeyType === 'ed25519' ? null : 'sha256',
			signed,
			stored.key,
			signature,
		)
	)
		throw new Error('the signature does not verify under the kept key');
	if (
		(parsed.signCount !== 0 || stored.signCount !== 0) &&
		parsed.signCount <= stored.signCount
	)
		throw new Error(
			`signature counter ${parsed.signCount} after ${stored.signCount}`,
		);
	const handle = response.userHandle;
	if (expected.discoverable) {
		if (typeof handle !== 'string')
			throw new Error('no userHandle from a discoverable credential');
	}
	if (
		handle !== undefined &&
		handle !== null &&
		handle !== b64url(stored.userId)
	)
		throw new Error('userHandle is not the user the credential was made for');
	return {
		signCount: parsed.signCount,
		describe: {
			clientDataKeys: client.keys,
			crossOrigin: client.data.crossOrigin ?? null,
			topOrigin: client.data.topOrigin ?? null,
			flags: parsed.flags,
			up: parsed.up,
			uv: parsed.uv,
			be: parsed.be,
			bs: parsed.bs,
			ed: parsed.ed,
			signCount: parsed.signCount,
			extensions: parsed.extensions ? [...parsed.extensions.keys()] : null,
			signatureIsDER: signature[0] === 0x30,
			userHandle: typeof handle === 'string',
			attachment: credential.authenticatorAttachment ?? null,
			clientExtensionResults: credential.clientExtensionResults ?? null,
		},
	};
}

/**
 * Start the relying party on a free port. `hosts` are its names, `origin(host)`
 * a name's https origin, `nativeArgs` the Chrome flags that reach it natively,
 * `credentials` what it keeps (by relying party id, then credential id),
 * `marks` the pages that said they had asked,
 * `log` every verification as { k, kind, ok, error }.
 */
export async function startPasskeysRP() {
	/** rp id -> credential id (base64url) -> { key, signCount, userId, userName } */
	const credentials = new Map();
	/** k -> the ceremony the options were made for */
	const ceremonies = new Map();
	const log = [];
	const wellKnown = { fetched: 0 };
	/** the pages that said they had asked (`/pk/mark?k=<id>`) */
	const marks = new Set();
	let hosts = hostsOf(0);
	const originOf = (host) => `https://${host}`;

	const body = (req) =>
		new Promise((resolve, reject) => {
			const chunks = [];
			req.on('data', (chunk) => chunks.push(chunk));
			req.on('end', () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
				} catch (error) {
					reject(error);
				}
			});
			req.on('error', reject);
		});
	const send = (res, value, status = 200) => {
		res.writeHead(status, {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		});
		res.end(JSON.stringify(value));
	};

	const handler = async (req, res) => {
		const url = new URL(req.url, 'http://x');
		const query = url.searchParams;
		// the name the request was for: natively its Host, through the demo's
		// test transport the `pk-host` parameter it adds (epoxy's Host is
		// the address it connects to)
		const host =
			query.get('pk-host') ?? (req.headers.host ?? '').replace(/:\d+$/, '');
		try {
			if (url.pathname === '/pk/page') {
				res.setHeader('content-type', 'text/html; charset=utf-8');
				res.setHeader('cache-control', 'no-store');
				if (query.has('pp'))
					res.setHeader('permissions-policy', query.get('pp'));
				res.end(readFileSync(PAGE));
				return;
			}
			if (url.pathname === '/pk/mark') {
				marks.add(query.get('k'));
				return void res.writeHead(204).end();
			}
			if (url.pathname === '/pk/harness.js') {
				res.setHeader('content-type', 'text/javascript; charset=utf-8');
				res.setHeader('cache-control', 'no-store');
				res.end(readFileSync(HARNESS));
				return;
			}
			if (url.pathname === '/.well-known/webauthn') {
				wellKnown.fetched++;
				wellKnown.last = {
					host,
					headers: Object.keys(req.headers).filter(
						(name) => name !== 'host' && name !== 'connection',
					),
					cookie: req.headers.cookie ?? null,
					referer: req.headers.referer ?? null,
					origin: req.headers.origin ?? null,
					accept: req.headers.accept ?? null,
					dest: req.headers['sec-fetch-dest'] ?? null,
					mode: req.headers['sec-fetch-mode'] ?? null,
					site: req.headers['sec-fetch-site'] ?? null,
				};
				const mine = originOf(hosts.a);
				// the related origins of each name (5.11.1)
				if (host === hosts.b) return send(res, { origins: [mine] });
				// a list that names others only
				if (host === hosts.ga)
					return send(res, { origins: ['https://elsewhere.example'] });
				// the right list, served as text
				if (host === `text.${hosts.ga}`) {
					res.writeHead(200, { 'content-type': 'text/plain' });
					return void res.end(JSON.stringify({ origins: [mine] }));
				}
				// the caller's origin after five other registrable labels
				if (host === `many.${hosts.ga}`)
					return send(res, {
						origins: [
							...['one', 'two', 'three', 'four', 'five'].map(
								(label) => `https://${label}.example`,
							),
							mine,
						],
					});
				// and after five origins of one label
				if (host === `same.${hosts.ga}`)
					return send(res, {
						origins: [
							...['a', 'b', 'c', 'd', 'e'].map(
								(name) => `https://${name}.one.example`,
							),
							mine,
						],
					});
				// JSON that does not parse, and JSON that is not a list of origins
				if (host === `bad.${hosts.ga}`) {
					res.writeHead(200, { 'content-type': 'application/json' });
					return void res.end('{"origins": [');
				}
				if (host === `shape.${hosts.ga}`) return send(res, { origins: mine });
				// a redirect to the list that names the caller
				if (host === `moved.${hosts.ga}`) {
					res.writeHead(302, {
						location: `${originOf(hosts.b)}/.well-known/webauthn`,
					});
					return void res.end();
				}
				return void res.writeHead(404).end();
			}
			if (req.method !== 'POST') return void res.writeHead(404).end();
			const message = await body(req);
			const k = String(message.k);
			if (url.pathname === '/pk/register/options') {
				const rpId = message.rp ?? host;
				const user = message.user ?? 'ada';
				const userId = sha256(`${rpId} ${user}`).subarray(0, 16);
				const challenge = b64url(randomBytes(32));
				const algs = message.algs ?? [-7, -257];
				ceremonies.set(k, {
					kind: 'create',
					challenge,
					origin: originOf(host),
					topOrigin: message.top ?? undefined,
					rpId,
					userId,
					userName: user,
					algs,
					userVerification: message.userVerification,
				});
				const known = [...(credentials.get(rpId)?.entries() ?? [])]
					.filter(([, kept]) => kept.userId.equals(userId))
					.map(([id]) => ({ type: 'public-key', id }));
				return send(res, {
					rp: { name: 'STomp passkeys fixture', id: rpId },
					user: {
						id: b64url(userId),
						name: `${user}@${rpId}`,
						displayName: user[0].toUpperCase() + user.slice(1),
					},
					challenge,
					pubKeyCredParams: algs.map((alg) => ({ type: 'public-key', alg })),
					timeout: message.timeout ?? 60000,
					excludeCredentials: message.exclude === false ? [] : known,
					authenticatorSelection: {
						residentKey: message.residentKey ?? 'required',
						requireResidentKey:
							(message.residentKey ?? 'required') === 'required',
						userVerification: message.userVerification ?? 'preferred',
						...(message.attachment
							? { authenticatorAttachment: message.attachment }
							: {}),
					},
					attestation: message.attestation ?? 'none',
					extensions: message.extensions ?? { credProps: true },
				});
			}
			if (url.pathname === '/pk/login/options') {
				const rpId = message.rp ?? host;
				const challenge = b64url(randomBytes(32));
				let allow = [];
				let userId;
				if (message.user) {
					userId = sha256(`${rpId} ${message.user}`).subarray(0, 16);
					allow = [...(credentials.get(rpId)?.entries() ?? [])]
						.filter(([, kept]) => kept.userId.equals(userId))
						.map(([id]) => ({ type: 'public-key', id }));
				}
				ceremonies.set(k, {
					kind: 'get',
					challenge,
					origin: originOf(host),
					topOrigin: message.top ?? undefined,
					rpId,
					discoverable: !message.user,
					allow: message.user ? allow.map((entry) => entry.id) : null,
					userVerification: message.userVerification,
				});
				return send(res, {
					challenge,
					rpId,
					timeout: message.timeout ?? 60000,
					allowCredentials: allow,
					userVerification: message.userVerification ?? 'preferred',
					...(message.extensions ? { extensions: message.extensions } : {}),
				});
			}
			if (
				url.pathname === '/pk/register/verify' ||
				url.pathname === '/pk/login/verify'
			) {
				const ceremony = ceremonies.get(k);
				// a challenge is good for one answer
				ceremonies.delete(k);
				const kind = url.pathname === '/pk/register/verify' ? 'create' : 'get';
				let answer;
				try {
					if (!ceremony || ceremony.kind !== kind)
						throw new Error('no such ceremony');
					const credential = message.credential;
					const kept = credentials.get(ceremony.rpId) ?? new Map();
					if (kind === 'create') {
						const verified = verifyRegistration(credential, ceremony);
						// and as a maintained server library verifies it
						const library = await verifyRegistrationResponse({
							response: credential,
							expectedChallenge: ceremony.challenge,
							expectedOrigin: ceremony.origin,
							expectedRPID: ceremony.rpId,
							requireUserVerification: ceremony.userVerification === 'required',
							supportedAlgorithmIDs: ceremony.algs,
						});
						if (!library.verified)
							throw new Error(
								'@simplewebauthn/server refused the registration',
							);
						if (kept.has(credential.id))
							throw new Error('the credential id is registered already');
						kept.set(credential.id, {
							library: library.registrationInfo.credential,
							key: verified.key,
							signCount: verified.signCount,
							userId: ceremony.userId,
							userName: ceremony.userName,
						});
						credentials.set(ceremony.rpId, kept);
						answer = {
							ok: true,
							user: ceremony.userName,
							...verified.describe,
						};
					} else {
						const stored = kept.get(credential.id);
						if (!stored) throw new Error('unknown credential id');
						if (ceremony.allow && !ceremony.allow.includes(credential.id))
							throw new Error('a credential that was not allowed');
						const verified = verifyAssertion(credential, ceremony, stored);
						const library = await verifyAuthenticationResponse({
							response: credential,
							expectedChallenge: ceremony.challenge,
							expectedOrigin: ceremony.origin,
							expectedRPID: ceremony.rpId,
							...(ceremony.topOrigin !== undefined
								? { expectedTopOrigin: ceremony.topOrigin }
								: {}),
							credential: stored.library,
							requireUserVerification: ceremony.userVerification === 'required',
						});
						if (!library.verified)
							throw new Error('@simplewebauthn/server refused the assertion');
						stored.library = {
							...stored.library,
							counter: library.authenticationInfo.newCounter,
						};
						stored.signCount = verified.signCount;
						answer = { ok: true, user: stored.userName, ...verified.describe };
					}
				} catch (error) {
					answer = { ok: false, error: String(error?.message ?? error) };
				}
				log.push({ k, kind, ok: answer.ok, error: answer.error ?? null });
				return send(res, answer);
			}
			res.writeHead(404).end();
		} catch (error) {
			send(res, { ok: false, error: String(error?.message ?? error) }, 500);
		}
	};

	const pair = certificate('passkeys-rp.test');
	const spki = createHash('sha256')
		.update(
			new X509Certificate(pair.cert).publicKey.export({
				type: 'spki',
				format: 'der',
			}),
		)
		.digest('base64');
	const secure = createHTTPS(pair, handler);
	const plain = createHTTP(handler);
	const both = tlsOrPlain(secure, plain);
	const port = await new Promise((resolve) =>
		both.listen(0, '127.0.0.1', () => resolve(both.address().port)),
	);
	hosts = hostsOf(port);
	return {
		log,
		port,
		hosts,
		credentials,
		wellKnown,
		marks,
		nativeArgs: nativeArgs(spki, port),
		origin: originOf,
		close() {
			for (const server of [secure, plain]) server.closeAllConnections?.();
			both.close();
		},
	};
}
