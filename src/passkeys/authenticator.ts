// STomp's own WebAuthn authenticator (docs/passkeys.md), which runs in the
// service worker and nowhere else. A proxied page cannot use the browser's:
// the browser checks a relying party id against the document's real origin,
// the proxy's, and signs that origin into what the site's server verifies.
// So STomp is the passkey provider for proxied sites, the way a password
// manager is: a key pair per credential, made by WebCrypto with a private
// key that cannot be exported, kept in the worker's own IndexedDB database
// (stompPasskeys, a name no proxied page's IndexedDB reaches: the inject
// suffixes every name a page opens with its storage key, as it does for
// the cookie jar's; with the site pool, the host origin's one, which every
// slot's worker asks over the jar's port), bound to the site's real
// relying party id, and used only after the host application asked the
// user (PasskeysInit.onRequest). The worker decides who asks (the sender's own
// routed URL, src/server/passkeys.ts) and signs; the host only confirms, and
// never holds a key.
//
// What it writes is WebAuthn Level 3's: authenticator data (6.1), a `none`
// attestation object (6.5.5, 8.7), client data (5.8.1) serialized as Chrome
// serializes it, and ES256 signatures in ASN.1 DER (EdDSA or RS256 when the
// site lists one of them first), with the largeBlob and credBlob
// extensions as CTAP 2.1 keeps them. The signature counter is always 0 and
// the AAGUID all zeros, as a software provider without a registered model
// has them; the credentials are neither backup eligible nor backed up (BE
// and BS are 0), which is true: they live in this browser's storage and
// nowhere else.
import { closeOnDelete, storeName } from '../profile';
import { PASSKEYS_DATABASE, PASSKEYS_STORE, type JarDB } from '../server/jarDB';
import { concat, encodeCBOR, type CBORValue } from './cbor';
import {
	PASSKEY_CANCEL,
	type PasskeyAnswer,
	type PasskeyAssertion,
	type PasskeyCeremony,
	type PasskeyCommand,
	type PasskeyCreateOptions,
	type PasskeyGetOptions,
	type PasskeyInfo,
	type PasskeyPrompt,
	type PasskeyReply,
	type PasskeysConfig,
	type PasskeySignal,
	type PrfValues,
	type Requirement,
} from './types';

/**
 * COSE's names for ECDSA with SHA-256 on P-256, EdDSA (on Ed25519, the one
 * curve WebAuthn and Chrome's authenticators take it on) and
 * RSASSA-PKCS1-v1_5 with SHA-256. Chrome's virtual authenticator (159)
 * makes these three and no other (not the fully specified Ed25519, -19),
 * the first of them the site lists, whatever the order.
 */
const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;
const ALGORITHMS: Record<
	number,
	RsaHashedKeyGenParams | EcKeyGenParams | Algorithm
> = {
	[ES256]: { name: 'ECDSA', namedCurve: 'P-256' },
	[EDDSA]: { name: 'Ed25519' },
	[RS256]: {
		name: 'RSASSA-PKCS1-v1_5',
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: 'SHA-256',
	},
};

/**
 * Whether this browser's WebCrypto makes keys of `algorithm`: Ed25519 is
 * there in Chrome from 137, Firefox from 129 and Safari from 17; where it
 * is not, a site that lists EdDSA first gets the next it lists, as from an
 * authenticator without it
 */
let ed25519: Promise<boolean> | null = null;
function makes(algorithm: number): Promise<boolean> {
	if (algorithm !== EDDSA) return Promise.resolve(algorithm in ALGORITHMS);
	ed25519 ??= crypto.subtle
		.generateKey(ALGORITHMS[EDDSA], false, ['sign'])
		.then(
			() => true,
			() => false,
		);
	return ed25519;
}

/**
 * The most a credential's credBlob holds: CTAP 2.1's least
 * maxCredBlobLength, which Chrome's virtual authenticator has (a longer one
 * is not kept, and the site is told so)
 */
const MAX_CRED_BLOB = 32;

// Chrome's words (measured against its virtual authenticator, 152 and 156)
const NOT_ALLOWED =
	'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';
const NOT_FOCUSED =
	'The operation is not allowed at this time because the page does not have focus.';
const EXCLUDED =
	'The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.';

const refused = (): PasskeyReply => ({
	error: ['NotAllowedError', NOT_ALLOWED],
});

/** a credential as the store keeps it */
interface Held {
	/** the credential id, base64url */
	id: string;
	rpId: string;
	userHandle: ArrayBuffer;
	userName: string;
	userDisplayName: string;
	discoverable: boolean;
	created: number;
	lastUsed: number | null;
	/** not extractable: no script, STomp's included, can read it */
	privateKey: CryptoKey;
	/** the COSE algorithm (ES256 for a record that names none) */
	algorithm?: number;
	/** the public key, as SubjectPublicKeyInfo */
	publicKey: ArrayBuffer;
	/** the PRF extension's keys, without and with user verification; not extractable */
	prf?: [CryptoKey, CryptoKey];
	/** made with the largeBlob extension: it may hold a large blob (CTAP 2.1's largeBlobKey) */
	largeBlobSupported?: boolean;
	/** its large blob, as the site last wrote it; none when it wrote an empty one */
	largeBlob?: ArrayBuffer;
	/** the credBlob extension's blob, kept as it was made */
	credBlob?: ArrayBuffer;
}

const bytes = (value: ArrayBuffer | Uint8Array): Uint8Array =>
	value instanceof Uint8Array ? value : new Uint8Array(value);

export function toBase64URL(value: ArrayBuffer | Uint8Array): string {
	let text = '';
	for (const byte of bytes(value)) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64URL(text: string): Uint8Array {
	return Uint8Array.from(
		atob(text.replace(/-/g, '+').replace(/_/g, '/')),
		(character) => character.charCodeAt(0),
	);
}

/** the buffer of exactly these bytes */
const buffer = (value: Uint8Array): ArrayBuffer =>
	value.buffer.slice(
		value.byteOffset,
		value.byteOffset + value.byteLength,
	) as ArrayBuffer;

const sha256 = async (value: Uint8Array | string): Promise<Uint8Array> =>
	new Uint8Array(
		await crypto.subtle.digest(
			'SHA-256',
			(typeof value === 'string'
				? new TextEncoder().encode(value)
				: value) as BufferSource,
		),
	);

// --- the store: one database of the worker's origin ---

const DATABASE = PASSKEYS_DATABASE;
const STORE = PASSKEYS_STORE;

/**
 * the site pool: a slot's worker keeps the credentials in the host origin's
 * one database (src/server/jarDB.ts), which every slot's worker asks, so a
 * site's passkeys are where they were whichever slot shows it
 */
let remote: JarDB | null = null;

/** the site pool: ask the host's passkey database, over the jar's port */
export function usePasskeysRemote(db: JarDB) {
	remote = db;
}

let database: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
	database ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(storeName(DATABASE), 1);
		request.onupgradeneeded = () => {
			const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
			store.createIndex('rpId', 'rpId');
		};
		request.onsuccess = () => {
			closeOnDelete(request.result, () => (database = null));
			resolve(request.result);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('passkey store blocked'));
	});
	// a failure is not kept: the next ceremony tries again
	database.catch(() => {
		database = null;
	});
	return database;
}

async function store<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
	const db = await open();
	return new Promise<T | undefined>((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const request = run(tx.objectStore(STORE));
		tx.oncomplete = () => resolve(request?.result);
		tx.onabort = tx.onerror = () => reject(tx.error);
	});
}

const heldFor = async (rpId: string): Promise<Held[]> =>
	((remote
		? await remote.getAllFromIndex(STORE, 'rpId', rpId)
		: await store('readonly', (credentials) =>
				credentials.index('rpId').getAll(rpId),
			)) as Held[] | undefined) ?? [];
const allHeld = async (): Promise<Held[]> =>
	((remote
		? await remote.getAll(STORE)
		: await store('readonly', (credentials) => credentials.getAll())) as
		Held[] | undefined) ?? [];
const keep = async (held: Held): Promise<void> => {
	if (remote) await remote.put(STORE, held);
	else await store('readwrite', (credentials) => credentials.put(held));
};
const drop = async (id: string): Promise<void> => {
	if (remote) await remote.delete(STORE, id);
	else await store('readwrite', (credentials) => credentials.delete(id));
};

const describe = (held: Held): PasskeyInfo => ({
	id: held.id,
	rpId: held.rpId,
	userHandle: toBase64URL(held.userHandle),
	userName: held.userName,
	userDisplayName: held.userDisplayName,
	discoverable: held.discoverable,
	created: held.created,
	lastUsed: held.lastUsed,
});

/** the host's view of the store (SWbound `passkeys`), no key material in it */
export async function passkeyCommand(
	command: PasskeyCommand,
): Promise<PasskeyInfo[] | boolean | null> {
	if (command.op === 'list') {
		const all =
			typeof command.rpId === 'string'
				? await heldFor(command.rpId)
				: await allHeld();
		return all.map(describe);
	}
	if (command.op === 'delete') {
		const id = String(command.id);
		const found = remote
			? await remote.get(STORE, id)
			: await store('readonly', (credentials) => credentials.getKey(id));
		if (found === undefined) return false;
		await drop(id);
		return true;
	}
	if (typeof command.rpId !== 'string') {
		if (remote) await remote.clear(STORE);
		else await store('readwrite', (credentials) => credentials.clear());
		return null;
	}
	for (const held of await heldFor(command.rpId)) await drop(held.id);
	return null;
}

/**
 * Forget the passkeys a site's data holds, as its storage is forgotten:
 * every one whose relying party id `host` could claim (the host itself or a
 * suffix of it)
 */
export async function forgetPasskeysOf(host: string): Promise<void> {
	for (const held of await allHeld())
		if (held.rpId === host || host.endsWith(`.${held.rpId}`))
			await drop(held.id);
}

// --- what an authenticator writes ---

/**
 * Client data (5.8.1.2's serialization, in Chrome's member order, which
 * puts topOrigin after crossOrigin). Chrome adds a member of its own to one
 * in five, so that no verifier compares against a template; so does this.
 */
function clientData(
	type: 'webauthn.create' | 'webauthn.get',
	challenge: ArrayBuffer,
	ceremony: PasskeyCeremony,
): Uint8Array {
	const cross = ceremony.topOrigin !== undefined;
	let json = `{"type":${JSON.stringify(type)},"challenge":${JSON.stringify(
		toBase64URL(challenge),
	)},"origin":${JSON.stringify(ceremony.origin)},"crossOrigin":${String(cross)}`;
	if (cross) json += `,"topOrigin":${JSON.stringify(ceremony.topOrigin)}`;
	const dice = new Uint8Array(1);
	crypto.getRandomValues(dice);
	if (dice[0] < 51)
		json +=
			',"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"';
	return new TextEncoder().encode(`${json}}`);
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;
const ED = 0x80;

/**
 * authenticator data (6.1): the rp id's hash, the flags, a zero counter,
 * what is attested, and the authenticator's extension outputs (ED), a
 * CBOR map, when there are any
 */
async function authenticatorData(
	rpId: string,
	flags: number,
	attested?: Uint8Array,
	extensions?: Map<string, CBORValue>,
): Promise<Uint8Array> {
	const outputs = extensions?.size ? encodeCBOR(extensions) : null;
	return concat([
		await sha256(rpId),
		[flags | (outputs ? ED : 0)],
		// the signature counter: always 0, as a credential that is not kept
		// on one device alone has it (6.1.1: the site then skips the check)
		[0, 0, 0, 0],
		attested ?? [],
		outputs ?? [],
	]);
}

/**
 * The COSE_Key of a public key (RFC 9053 7.1.1 and 7.2, RFC 8230 4): for
 * ES256 kty EC2, alg, crv P-256, x, y; for EdDSA kty OKP, alg, crv
 * Ed25519, x; for RS256 kty RSA, alg, n, e
 */
async function coseKey(
	key: CryptoKey,
	algorithm: number,
): Promise<Map<number, number | Uint8Array>> {
	if (algorithm === EDDSA)
		return new Map<number, number | Uint8Array>([
			[1, 1],
			[3, EDDSA],
			[-1, 6],
			[-2, new Uint8Array(await crypto.subtle.exportKey('raw', key))],
		]);
	if (algorithm === RS256) {
		const jwk = await crypto.subtle.exportKey('jwk', key);
		return new Map<number, number | Uint8Array>([
			[1, 3],
			[3, RS256],
			[-1, fromBase64URL(jwk.n!)],
			[-2, fromBase64URL(jwk.e!)],
		]);
	}
	const point = new Uint8Array(await crypto.subtle.exportKey('raw', key));
	return new Map<number, number | Uint8Array>([
		[1, 2],
		[3, ES256],
		[-1, 1],
		[-2, point.subarray(1, 33)],
		[-3, point.subarray(33, 65)],
	]);
}

/** an ECDSA signature as WebCrypto gives it (r then s), in ASN.1 DER */
function derSignature(raw: Uint8Array): Uint8Array {
	const integer = (value: Uint8Array): number[] => {
		let start = 0;
		while (start < value.length - 1 && value[start] === 0) start++;
		const body = [...value.subarray(start)];
		if (body[0] & 0x80) body.unshift(0);
		return [0x02, body.length, ...body];
	};
	const half = raw.length / 2;
	const body = [
		...integer(raw.subarray(0, half)),
		...integer(raw.subarray(half)),
	];
	return new Uint8Array([0x30, body.length, ...body]);
}

/**
 * A signature over `signed` with a held key, as WebAuthn encodes each
 * algorithm's (6.5.5): ECDSA's in ASN.1 DER, EdDSA's and RSA's as they are
 */
async function signWith(held: Held, signed: BufferSource): Promise<Uint8Array> {
	const algorithm = held.algorithm ?? ES256;
	if (algorithm === RS256)
		return new Uint8Array(
			await crypto.subtle.sign('RSASSA-PKCS1-v1_5', held.privateKey, signed),
		);
	if (algorithm === EDDSA)
		return new Uint8Array(
			await crypto.subtle.sign('Ed25519', held.privateKey, signed),
		);
	return derSignature(
		new Uint8Array(
			await crypto.subtle.sign(
				{ name: 'ECDSA', hash: 'SHA-256' },
				held.privateKey,
				signed,
			),
		),
	);
}

/** the PRF extension's output for one input (10.1.4: the salt is a hash of the input under a fixed prefix) */
async function prfOutput(
	key: CryptoKey,
	input: ArrayBuffer,
): Promise<ArrayBuffer> {
	const salt = await sha256(
		concat([new TextEncoder().encode('WebAuthn PRF'), [0], bytes(input)]),
	);
	return crypto.subtle.sign('HMAC', key, salt as BufferSource);
}

async function prfResults(
	held: Held,
	verified: boolean,
	values: PrfValues | undefined,
): Promise<PrfValues | undefined> {
	if (!held.prf || !values) return undefined;
	const key = held.prf[verified ? 1 : 0];
	return {
		first: await prfOutput(key, values.first),
		...(values.second ? { second: await prfOutput(key, values.second) } : {}),
	};
}

/** what a ceremony needs of the worker around it */
export interface CeremonyHost {
	/** the controller's passkeys (Config.passkeys): whether its host verifies users */
	config: PasskeysConfig;
	/**
	 * Ask the host application (through the controller) and resolve its
	 * answer, or null when the user declined or nobody could be asked. The
	 * port's other end hears PASSKEY_CANCEL when the page gives up.
	 */
	prompt(request: PasskeyPrompt, cancel: MessagePort): Promise<unknown>;
	/** whether the requesting document's page is in front now */
	focused(): Promise<boolean>;
}

/** a host's answer, member by member: nothing else it sent is read */
function answerOf(value: unknown): PasskeyAnswer | null {
	if (value === null || typeof value !== 'object') return null;
	const { credential, userVerified } = value as Record<string, unknown>;
	return {
		...(typeof credential === 'string' ? { credential } : {}),
		...(userVerified === true ? { userVerified: true } : {}),
	};
}

/**
 * One ceremony, from the worker's word of who asks to the answer on the
 * page's port. The page's end may say PASSKEY_CANCEL or close at any time.
 * Resolves once the host has been asked (or the ceremony ended without),
 * which is as long as the message's event needs to live: the user may take
 * minutes, which the controller's keepalive covers.
 */
export function runCeremony(
	host: CeremonyHost,
	ceremony: PasskeyCeremony,
	port: MessagePort,
): Promise<void> {
	const abort = new AbortController();
	let settled = false;
	let asked: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const reply = (answer: PasskeyReply) => {
		asked();
		if (settled) return;
		settled = true;
		try {
			port.postMessage(answer);
		} catch (error) {
			// the page is gone
		}
		port.close();
	};
	const cancel = () => {
		if (settled) return;
		settled = true;
		abort.abort();
		port.close();
	};
	port.addEventListener('message', (event) => {
		if (event.data === PASSKEY_CANCEL) cancel();
	});
	// the page's document went away with the ceremony open
	port.addEventListener('close', cancel);
	port.start();

	const ask = async (
		request: Omit<PasskeyPrompt, 'rpId' | 'origin'>,
	): Promise<PasskeyAnswer | null> => {
		if (abort.signal.aborted) return null;
		const channel = new MessageChannel();
		const tell = () => {
			try {
				channel.port1.postMessage(PASSKEY_CANCEL);
			} catch (error) {
				// the host's end is gone
			}
			channel.port1.close();
		};
		abort.signal.addEventListener('abort', tell, { once: true });
		try {
			const answering = host.prompt(
				{
					...request,
					rpId: ceremony.rpId,
					origin: ceremony.origin,
					...(ceremony.topOrigin !== undefined
						? { topOrigin: ceremony.topOrigin }
						: {}),
					...(ceremony.client ? { client: ceremony.client } : {}),
				},
				channel.port2,
			);
			asked();
			return answerOf(await answering);
		} catch (error) {
			return null;
		} finally {
			abort.signal.removeEventListener('abort', tell);
			channel.port1.close();
		}
	};
	/**
	 * Whether the ceremony says the user was verified: only a host that says
	 * it verifies users is believed, and a site that discourages verification
	 * is told of none (as Chrome's authenticators answer it)
	 */
	const verifiedBy = (answer: PasskeyAnswer, asked: Requirement) =>
		host.config.uv === true &&
		answer.userVerified === true &&
		asked !== 'discouraged';
	// a refusal a conditional request never hears: it waits for the user,
	// until the page's own timeout or signal ends it
	const waits = (): Promise<PasskeyReply> =>
		new Promise<PasskeyReply>(() => {});

	const create = async (
		options: PasskeyCreateOptions,
	): Promise<PasskeyReply> => {
		// A conditional create (a site offering a passkey in the background,
		// 5.1.3) is never refused where the site could tell: Chrome lets it
		// wait, silently, until the page's timeout, unless the user takes it
		const conditional = options.conditional === true;
		const no = (): Promise<PasskeyReply> | PasskeyReply =>
			conditional ? waits() : refused();
		// Chrome asks no authenticator for a page that is not in front (a
		// conditional request shows nothing that needs the focus)
		if (!conditional && !(await host.focused()))
			return { error: ['NotAllowedError', NOT_FOCUSED] };
		// the first algorithm of the site's that this authenticator makes
		let algorithm: number | undefined;
		for (const alg of options.algs)
			if (await makes(alg)) {
				algorithm = alg;
				break;
			}
		// a platform authenticator makes every credential discoverable unless
		// the site asked for one that is not
		const discoverable = options.residentKey !== 'discouraged';
		// none, a security key asked for by name, a verification this host
		// cannot make, or a large blob required of a credential that cannot
		// hold one (CTAP 2.1 keeps them for discoverable credentials only):
		// the browser would find no authenticator to offer
		if (
			algorithm === undefined ||
			options.attachment === 'cross-platform' ||
			(options.userVerification === 'required' && host.config.uv !== true) ||
			(options.largeBlob === 'required' && !discoverable)
		)
			return no();
		const held = await heldFor(ceremony.rpId);
		const excluded = options.exclude.some((id) =>
			held.some((credential) => credential.id === toBase64URL(id)),
		);
		// nothing to offer in the background: a passkey of the account is here
		if (excluded && conditional) return waits();
		const answer = await ask({
			type: 'create',
			user: {
				name: options.user.name,
				displayName: options.user.displayName,
			},
			...(excluded ? { excluded: true } : {}),
			...(conditional ? { conditional: true } : {}),
			userVerification: options.userVerification,
		});
		if (abort.signal.aborted) return refused();
		if (!answer) return no();
		// said only now, to a user who agreed (6.3.2 step 3)
		if (excluded) return { error: ['InvalidStateError', EXCLUDED] };
		const verified = verifiedBy(answer, options.userVerification);
		if (options.userVerification === 'required' && !verified) return no();

		const pair = (await crypto.subtle.generateKey(
			ALGORITHMS[algorithm],
			// the private key never leaves WebCrypto; a public key always may
			false,
			['sign'],
		)) as CryptoKeyPair;
		const id = new Uint8Array(32);
		crypto.getRandomValues(id);
		const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey);
		const prfKey = () =>
			crypto.subtle.generateKey(
				{ name: 'HMAC', hash: 'SHA-256', length: 256 },
				false,
				['sign'],
			);
		const credBlob =
			options.credBlob !== undefined &&
			options.credBlob.byteLength <= MAX_CRED_BLOB
				? options.credBlob
				: undefined;
		const credential: Held = {
			id: toBase64URL(id),
			rpId: ceremony.rpId,
			userHandle: options.user.id,
			userName: options.user.name,
			userDisplayName: options.user.displayName,
			discoverable,
			created: Date.now(),
			lastUsed: null,
			privateKey: pair.privateKey,
			algorithm,
			publicKey,
			...(options.prf ? { prf: [await prfKey(), await prfKey()] } : {}),
			...(options.largeBlob && discoverable
				? { largeBlobSupported: true }
				: {}),
			...(credBlob ? { credBlob } : {}),
		};
		// one credential per user handle and relying party: a new one takes
		// the place of the old (6.3.2 step 7.4 for a discoverable one)
		for (const old of held)
			if (
				old.discoverable &&
				discoverable &&
				toBase64URL(old.userHandle) === toBase64URL(options.user.id)
			)
				await drop(old.id);
		await keep(credential);

		const cose = encodeCBOR(await coseKey(pair.publicKey, algorithm));
		const authData = await authenticatorData(
			ceremony.rpId,
			UP | (verified ? UV : 0) | AT,
			concat([
				// the AAGUID: zeros, with `none` attestation
				new Uint8Array(16),
				[id.length >> 8, id.length & 0xff],
				id,
				cose,
			]),
			// the credBlob extension's output (CTAP 2.1, 12.2): said when kept
			credBlob ? new Map([['credBlob', true]]) : undefined,
		);
		const attestationObject = encodeCBOR(
			new Map<string, CBORValue>([
				['fmt', 'none'],
				['attStmt', new Map<string, CBORValue>()],
				['authData', authData],
			]),
		);
		const results = await prfResults(credential, verified, options.prf?.eval);
		return {
			attestation: {
				id: buffer(id),
				clientDataJSON: buffer(
					clientData('webauthn.create', options.challenge, ceremony),
				),
				attestationObject: buffer(attestationObject),
				authenticatorData: buffer(authData),
				publicKey,
				algorithm,
				discoverable,
				...(options.prf
					? { prf: { enabled: true, ...(results ? { results } : {}) } }
					: {}),
				...(options.largeBlob
					? { largeBlob: credential.largeBlobSupported === true }
					: {}),
				...(options.credBlob !== undefined ? { credBlob: !!credBlob } : {}),
			},
		};
	};

	const get = async (options: PasskeyGetOptions): Promise<PasskeyReply> => {
		const conditional = options.mediation === 'conditional';
		// (no focus check: Chrome makes one for create() only, at its start
		// and its end, and a get() of a page that is not in front waits for
		// the user like any other)
		if (
			options.mediation === 'silent' ||
			(options.userVerification === 'required' && host.config.uv !== true)
		)
			return refused();
		const allowed = options.allow.map(toBase64URL);
		const candidates = (await heldFor(ceremony.rpId))
			.filter((credential) =>
				allowed.length
					? allowed.includes(credential.id)
					: credential.discoverable,
			)
			.sort((a, b) => (b.lastUsed ?? b.created) - (a.lastUsed ?? a.created));
		const answer = await ask({
			type: 'get',
			credentials: candidates.map(describe),
			...(conditional ? { conditional: true } : {}),
			userVerification: options.userVerification,
		});
		if (abort.signal.aborted) return refused();
		if (!answer) return conditional ? waits() : refused();
		const chosen = candidates.find(
			(credential) => credential.id === answer.credential,
		);
		if (!chosen) return conditional ? waits() : refused();
		const verified = verifiedBy(answer, options.userVerification);
		if (options.userVerification === 'required' && !verified) return refused();

		// the largeBlob extension: the credential's blob read, or a new one
		// written in its place. A write needs the user verified where the
		// authenticator can verify (CTAP 2.1's largeBlobWrite permission, as
		// Chrome's virtual authenticator has it): not when the site
		// discouraged a verification; a host that verifies nobody writes
		// without one, as an authenticator that cannot verify does
		let largeBlob: PasskeyAssertion['largeBlob'];
		if (options.largeBlob && 'write' in options.largeBlob) {
			const written =
				chosen.largeBlobSupported === true &&
				(host.config.uv !== true || verified);
			if (written) {
				if (options.largeBlob.write.byteLength)
					chosen.largeBlob = options.largeBlob.write;
				else delete chosen.largeBlob;
			}
			largeBlob = { written };
		} else if (options.largeBlob)
			largeBlob = chosen.largeBlob ? { blob: chosen.largeBlob } : {};
		const credBlob = options.getCredBlob
			? (chosen.credBlob ?? new ArrayBuffer(0))
			: undefined;

		const data = clientData('webauthn.get', options.challenge, ceremony);
		const authData = await authenticatorData(
			ceremony.rpId,
			UP | (verified ? UV : 0),
			undefined,
			// getCredBlob's output (CTAP 2.1, 12.2): the blob, empty without one
			credBlob ? new Map([['credBlob', new Uint8Array(credBlob)]]) : undefined,
		);
		const signature = await signWith(
			chosen,
			concat([authData, await sha256(data)]) as BufferSource,
		);
		chosen.lastUsed = Date.now();
		await keep(chosen);
		const results = await prfResults(
			chosen,
			verified,
			options.prf?.byCredential?.[chosen.id] ?? options.prf?.eval,
		);
		return {
			assertion: {
				id: buffer(fromBase64URL(chosen.id)),
				clientDataJSON: buffer(data),
				authenticatorData: buffer(authData),
				signature: buffer(signature),
				// a discoverable credential names its user (6.3.3 step 13)
				userHandle: chosen.discoverable ? chosen.userHandle : null,
				...(options.prf ? { prf: results ? { results } : {} } : {}),
				...(largeBlob ? { largeBlob } : {}),
				...(credBlob ? { credBlob } : {}),
			},
		};
	};

	/** the signal API (5.1.10): the site's word on what it still accepts, taken without a prompt */
	const signal = async (told: PasskeySignal): Promise<PasskeyReply> => {
		const held = await heldFor(ceremony.rpId);
		if (told.kind === 'unknown') {
			if (held.some((credential) => credential.id === told.credentialId))
				await drop(told.credentialId);
			return { done: true };
		}
		for (const credential of held) {
			if (toBase64URL(credential.userHandle) !== told.userId) continue;
			if (told.kind === 'accepted') {
				if (!told.ids.includes(credential.id)) await drop(credential.id);
			} else {
				credential.userName = told.name;
				credential.userDisplayName = told.displayName;
				await keep(credential);
			}
		}
		return { done: true };
	};

	const work =
		ceremony.type === 'create'
			? create(ceremony.options)
			: ceremony.type === 'get'
				? get(ceremony.options)
				: signal(ceremony.signal);
	work.then(reply, () => reply(refused()));
	return started;
}
