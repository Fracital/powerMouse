// What a proxied document's WebAuthn requests do (docs/passkeys.md): the
// client half of WebAuthn, which the browser runs for a page and cannot run
// for a proxied one (it would check and sign the proxy's origin). It reads
// a request as Chrome's bindings read it (the same members in the same
// order, the same TypeErrors), refuses what Chrome's renderer refuses, in
// its order and its words, and hands the rest to the service worker, which
// holds the keys, has the host application ask the user, and signs
// (src/passkeys/authenticator.ts). What comes back is given to the page as
// the browser's objects: on the browser's own prototypes, read through the
// browser's own getters, which answer for the objects made here.
//
// Every word and order here was measured against Chrome 152, 156 and 157
// with the virtual authenticator (test/suites/passkeys.mjs compares them
// again on every run). This file is a deferred statement of the document
// bundle's own (./passkeysPart.ts): the Credentials module installs the hooks before
// any page script runs and evaluates this with a document's first WebAuthn
// call. Its top level reads no global; what it needs of the realm it is
// handed (PasskeysContext.realm), taken before any page script ran.
import {
	PASSKEY_CANCEL,
	type PasskeyAssertion,
	type PasskeyAttestation,
	type PasskeyCreateOptions,
	type PasskeyGetOptions,
	type PasskeyOp,
	type PasskeyReply,
	type PasskeySignal,
	type PrfValues,
	type Requirement,
} from '../../passkeys/types';
import { PASSKEY, postToPort } from '../../transport/messages';
import { closePort, onPort, privateChannel } from '../../transport/ports';
import {
	bufferLength,
	cancel as clearTimeout,
	isView,
	later as setTimeout,
} from '../modules/WebTransport';
import { withStack } from '../nativeErrors';
import PermissionsModule from './modules/Permissions';
import type { PasskeysContext, PasskeysInstalled } from './passkeysLazy';

// what STomp's authenticator and client do, among the capabilities Chrome
// lists (PublicKeyCredential.getClientCapabilities); every other is false,
// and the two that say a user-verifying authenticator is here are the host's
const CAPABLE = [
	'conditionalGet',
	'extension:credProps',
	'extension:prf',
	'relatedOrigins',
	'signalAllAcceptedCredentials',
	'signalCurrentUserDetails',
	'signalUnknownCredential',
];
const VERIFYING = [
	'passkeyPlatformAuthenticator',
	'userVerifyingPlatformAuthenticator',
];

const NOT_ALLOWED =
	'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';
const policyRefusal = (feature: string) =>
	`The '${feature}' feature is not enabled in this document. Permissions Policy may be used to delegate Web Authentication capabilities to cross-origin child frames.`;

// How long a ceremony may take. A page's timeout is a hint (5.4, 5.5), and
// WebAuthn recommends a client keep it within these bounds (Level 3, 15.1
// "Recommended Range for Ceremony Timeouts"): 30 s to 3 min when user
// verification is discouraged (2 min when the page names none), 30 s to
// 10 min otherwise (5 min). Chrome's own bounds outside its testing API
// could not be measured: headless, its dialog holds a request that timed
// out until someone dismisses it. With `testing` the page's time is taken
// as it is, as Chrome takes it with a virtual authenticator.
const TIMEOUT_FLOOR = 30_000;
const TIMEOUT_CEILING = { discouraged: 180_000, other: 600_000 };
const TIMEOUT_DEFAULT = { discouraged: 120_000, other: 300_000 };

// --- the dictionaries, as Chrome reads them ---

type Type =
	| 'boolean'
	| 'string'
	| 'long'
	| 'ulong'
	| 'buffer'
	| { seq: Type }
	| { dict: Dict }
	| { record: Type };
/** a member: its name, its type, whether it is required, and the dictionary it is inherited from */
type Member = [name: string, type: Type, required?: boolean, owner?: string];
interface Dict {
	name: string;
	members: Member[];
}
/** a converted dictionary: its present members */
type Converted = Record<string, any>;

// members are in the order Chrome reads them: an inherited dictionary's
// first, then the dictionary's own by name
const DESCRIPTOR: Dict = {
	name: 'PublicKeyCredentialDescriptor',
	members: [
		['id', 'buffer', true],
		['transports', { seq: 'string' }],
		['type', 'string', true],
	],
};
const PRF_VALUES: Dict = {
	name: 'AuthenticationExtensionsPRFValues',
	members: [
		['first', 'buffer', true],
		['second', 'buffer'],
	],
};
const EXTENSIONS: Dict = {
	name: 'AuthenticationExtensionsClientInputs',
	members: [
		['appid', 'string'],
		['appidExclude', 'string'],
		['credBlob', 'buffer'],
		['credProps', 'boolean'],
		['credentialProtectionPolicy', 'string'],
		['enforceCredentialProtectionPolicy', 'boolean'],
		['getCredBlob', 'boolean'],
		['hmacCreateSecret', 'boolean'],
		[
			'largeBlob',
			{
				dict: {
					name: 'AuthenticationExtensionsLargeBlobInputs',
					members: [
						['read', 'boolean'],
						['support', 'string'],
						['write', 'buffer'],
					],
				},
			},
		],
		['minPinLength', 'boolean'],
		[
			'prf',
			{
				dict: {
					name: 'AuthenticationExtensionsPRFInputs',
					members: [
						['eval', { dict: PRF_VALUES }],
						['evalByCredential', { record: { dict: PRF_VALUES } }],
					],
				},
			},
		],
		['uvm', 'boolean'],
	],
};
const CREATION: Dict = {
	name: 'PublicKeyCredentialCreationOptions',
	members: [
		['attestation', 'string'],
		[
			'authenticatorSelection',
			{
				dict: {
					name: 'AuthenticatorSelectionCriteria',
					members: [
						['authenticatorAttachment', 'string'],
						['requireResidentKey', 'boolean'],
						['residentKey', 'string'],
						['userVerification', 'string'],
					],
				},
			},
		],
		['challenge', 'buffer', true],
		['excludeCredentials', { seq: { dict: DESCRIPTOR } }],
		['extensions', { dict: EXTENSIONS }],
		['hints', { seq: 'string' }],
		[
			'pubKeyCredParams',
			{
				seq: {
					dict: {
						name: 'PublicKeyCredentialParameters',
						members: [
							['alg', 'long', true],
							['type', 'string', true],
						],
					},
				},
			},
			true,
		],
		[
			'rp',
			{
				dict: {
					name: 'PublicKeyCredentialRpEntity',
					members: [
						['name', 'string', true, 'PublicKeyCredentialEntity'],
						['id', 'string'],
					],
				},
			},
			true,
		],
		['timeout', 'ulong'],
		[
			'user',
			{
				dict: {
					name: 'PublicKeyCredentialUserEntity',
					members: [
						['name', 'string', true, 'PublicKeyCredentialEntity'],
						['displayName', 'string', true],
						['id', 'buffer', true],
					],
				},
			},
			true,
		],
	],
};
const REQUEST: Dict = {
	name: 'PublicKeyCredentialRequestOptions',
	members: [
		['allowCredentials', { seq: { dict: DESCRIPTOR } }],
		['challenge', 'buffer', true],
		['extensions', { dict: EXTENSIONS }],
		['hints', { seq: 'string' }],
		['rpId', 'string'],
		['timeout', 'ulong'],
		['userVerification', 'string'],
	],
};
const SIGNALS: Record<string, Dict> = {
	signalUnknownCredential: {
		name: 'UnknownCredentialOptions',
		members: [
			['credentialId', 'string', true],
			['rpId', 'string', true],
		],
	},
	signalAllAcceptedCredentials: {
		name: 'AllAcceptedCredentialsOptions',
		members: [
			['allAcceptedCredentialIds', { seq: 'string' }, true],
			['rpId', 'string', true],
			['userId', 'string', true],
		],
	},
	signalCurrentUserDetails: {
		name: 'CurrentUserDetailsOptions',
		members: [
			['displayName', 'string', true],
			['name', 'string', true],
			['rpId', 'string', true],
			['userId', 'string', true],
		],
	},
};

/** CredentialMediationRequirement */
const MEDIATIONS = ['silent', 'optional', 'conditional', 'required'];
/** the top-level members of each call, when the browser's own cannot be asked */
const TOP_MEMBERS = {
	create: [
		'digital',
		'federated',
		'mediation',
		'password',
		'publicKey',
		'signal',
	],
	get: [
		'digital',
		'federated',
		'identity',
		'mediation',
		'otp',
		'password',
		'publicKey',
		'signal',
		'uiMode',
	],
};

const ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** the library, installed for one document */
export function passkeys(ctx: PasskeysContext): PasskeysInstalled {
	const { client, proxyModule } = ctx;
	const global = client.global as unknown as typeof globalThis &
		Record<string, any>;
	// the document's own, taken when it started (the Credentials module's),
	// before any page script could replace one
	const {
		Promise: PagePromise,
		TypeError: PageTypeError,
		DOMException: PageDOMException,
		Object: PageObject,
		Array: PageArray,
		ArrayBuffer: PageArrayBuffer,
		Uint8Array,
		Proxy,
		WeakMap,
		Symbol,
		String,
	} = ctx.realm;
	const [signalAborted, signalReason, listen] = ctx.signal;
	const [nativeCreate, nativeGet] = ctx.natives;
	const Promise = PagePromise;
	const passkeysConfig = client.passkeys!;

	function toBase64URL(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let text = '';
		for (let i = 0; i < bytes.length; i += 3) {
			const a = bytes[i];
			const b = bytes[i + 1];
			const c = bytes[i + 2];
			text += ALPHABET[a >> 2];
			text += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
			if (i + 1 < bytes.length)
				text += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
			if (i + 2 < bytes.length) text += ALPHABET[c & 63];
		}
		return text;
	}
	const indexOf = String.prototype.indexOf;
	/** base64url as Chrome's parser takes it: the alphabet, no padding, a length some bytes encode to */
	const isBase64URL = (text: string): boolean => {
		if (text.length % 4 === 1) return false;
		for (let i = 0; i < text.length; i++)
			if (Reflect.apply(indexOf, ALPHABET, [text[i]]) === -1) return false;
		return true;
	};
	const iteratorKey = Symbol.iterator;

	// an AbortSignal, read with the browser's own getters (taken before any
	// page script ran)
	const abort = {
		is: (value: unknown): boolean => {
			try {
				Reflect.apply(signalAborted, value, []);
				return true;
			} catch (error) {
				return false;
			}
		},
		aborted: (signal: object): boolean =>
			Reflect.apply(signalAborted, signal, []) === true,
		reason: (signal: object): unknown =>
			Reflect.apply(signalReason, signal, []),
		listen: (signal: object, listener: () => void) => {
			Reflect.apply(listen, signal, ['abort', listener, { once: true }]);
		},
	};
	/** whether the document's permissions policy lets it use `feature`, as the worker recorded it */
	const policy = (feature: string): boolean | Promise<boolean> =>
		client.getModule(PermissionsModule)?.documentPolicy?.(feature) ?? true;
	const routed = client.routedClient() as typeof client | null;
	/** post `message` and a port for its answer to the service worker; false when nothing controls the document */
	const toWorker = (message: object, port: MessagePort): boolean =>
		!!routed &&
		routed.postToWorker(
			{ [PASSKEY]: { directory: routed.directory, ...message } },
			[port],
		);

	const typeError = (message: string) => withStack(new PageTypeError(message));
	const domException = (message: string, name: string) =>
		withStack(new PageDOMException(message, name));
	const rejected = (error: unknown) =>
		Reflect.apply(PagePromise.reject, PagePromise, [error]) as Promise<never>;
	/** a promise of the page's realm for work of this one */
	const pagePromise = <T>(work: Promise<T>): Promise<T> =>
		new PagePromise<T>((resolve, reject) => {
			work.then(resolve, reject);
		});
	/** the browser's own process answers in a later task: so does what stands in for it */
	const task = () =>
		new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});

	// --- conversion ---

	const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
		(typeof value === 'object' && value !== null) ||
		typeof value === 'function';

	const toNumber = (value: unknown, prefix: string): number => {
		if (typeof value === 'symbol')
			throw typeError(`${prefix}Cannot convert a Symbol value to a number`);
		if (typeof value === 'bigint')
			throw typeError(`${prefix}Cannot convert a BigInt value to a number`);
		// an object's own conversion runs here, and what it throws is the page's
		return +(value as number);
	};
	const toText = (value: unknown, prefix: string): string => {
		if (typeof value === 'symbol')
			throw typeError(`${prefix}Cannot convert a Symbol value to a string`);
		return `${value as string}`;
	};
	/** the bytes of a BufferSource, copied now: the page may write to it after the call */
	const toBytes = (value: unknown, prefix: string): ArrayBuffer => {
		// a buffer or a view of any realm, told by the browser's own checks; a
		// detached one is taken as empty, as Chrome takes it
		let length = -1;
		let buffer: ArrayBuffer | null = null;
		let offset = 0;
		if (isObject(value)) {
			if (isView(value)) {
				const view = value as unknown as ArrayBufferView;
				length = view.byteLength;
				buffer = view.buffer as ArrayBuffer;
				offset = view.byteOffset;
			} else
				try {
					length = Reflect.apply(bufferLength, value, []) as number;
					buffer = value as unknown as ArrayBuffer;
				} catch (error) {
					length = -1;
				}
		}
		if (length < 0 || !buffer)
			throw typeError(
				`${prefix}The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.`,
			);
		const copy = new Uint8Array(length);
		if (length) copy.set(new Uint8Array(buffer, offset, length));
		return copy.buffer;
	};
	const toSequence = (
		value: unknown,
		type: Type,
		prefix: string,
	): unknown[] => {
		if (!isObject(value))
			throw typeError(
				`${prefix}The provided value cannot be converted to a sequence.`,
			);
		const method = value[iteratorKey];
		if (typeof method !== 'function')
			throw typeError(
				`${prefix}The object must have a callable @@iterator property.`,
			);
		const iterator = Reflect.apply(method, value, []) as Iterator<unknown>;
		const next = iterator.next;
		const out: unknown[] = [];
		for (;;) {
			const step = Reflect.apply(next, iterator, []) as IteratorResult<unknown>;
			if (step.done) break;
			out[out.length] = convert(step.value, type, prefix);
		}
		return out;
	};
	const toRecord = (
		value: unknown,
		type: Type,
		prefix: string,
	): Record<string, unknown> => {
		if (!isObject(value))
			throw typeError(`${prefix}The provided value is not of type 'record'.`);
		const out = PageObject.create(null) as Record<string, unknown>;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string') continue;
			if (!Reflect.getOwnPropertyDescriptor(value, key)?.enumerable) continue;
			out[key] = convert(value[key], type, prefix);
		}
		return out;
	};
	const toDictionary = (
		value: unknown,
		dict: Dict,
		prefix: string,
	): Converted => {
		const out = PageObject.create(null) as Converted;
		if (value === undefined || value === null) {
			// nothing given is the empty dictionary, unless a member is required
			for (const member of dict.members)
				if (member[2])
					throw typeError(
						`${prefix}The provided value is not of type '${dict.name}'.`,
					);
			return out;
		}
		if (!isObject(value))
			throw typeError(
				`${prefix}The provided value is not of type '${dict.name}'.`,
			);
		for (const [name, type, required, owner] of dict.members) {
			const read = `${prefix}Failed to read the '${name}' property from '${owner ?? dict.name}': `;
			const member = value[name];
			if (member === undefined) {
				if (required) throw typeError(`${read}Required member is undefined.`);
				continue;
			}
			out[name] = convert(member, type, read);
		}
		return out;
	};
	function convert(value: unknown, type: Type, prefix: string): unknown {
		if (type === 'boolean') return !!value;
		if (type === 'string') return toText(value, prefix);
		// WebIDL's long and unsigned long: modulo 2^32, NaN as 0
		if (type === 'long') return toNumber(value, prefix) | 0;
		if (type === 'ulong') return toNumber(value, prefix) >>> 0;
		if (type === 'buffer') return toBytes(value, prefix);
		if ('seq' in type) return toSequence(value, type.seq, prefix);
		if ('record' in type) return toRecord(value, type.record, prefix);
		return toDictionary(value, type.dict, prefix);
	}

	// --- the top-level dictionary: the members this Chrome reads, in its order ---

	// the browser's own, behind the Credentials module's guard
	const natives = {
		create: function (this: unknown, ...args: unknown[]) {
			return ctx.guard(
				(called) => Reflect.apply(nativeCreate, this, called),
				args,
				['publicKey', 'rp', 'id'],
				'create',
			);
		},
		get: function (this: unknown, ...args: unknown[]) {
			return ctx.guard(
				(called) => Reflect.apply(nativeGet, this, called),
				args,
				['publicKey', 'rpId'],
				'get',
			);
		},
	};
	const orders: { create?: string[]; get?: string[] } = {};
	/**
	 * The members of CredentialCreationOptions or CredentialRequestOptions,
	 * which differ between Chrome versions (156 reads `digital` on create):
	 * asked of the browser's own call once, with an object that answers
	 * every member with nothing and an aborted signal, so the call ends in
	 * its bindings or at the signal and reaches no authenticator
	 */
	const topMembers = (kind: 'create' | 'get'): string[] => {
		const known = orders[kind];
		if (known) return known;
		const seen: string[] = [];
		try {
			const probe = new Proxy(PageObject.create(null), {
				get: (_target, key) => {
					if (typeof key === 'string') seen[seen.length] = key;
					return undefined;
				},
			});
			const ended = Reflect.apply(natives[kind], ctx.container, [
				probe,
			]) as Promise<unknown>;
			ended.then(undefined, () => {});
		} catch (error) {
			seen.length = 0;
		}
		let found = false;
		for (const key of seen) if (key === 'publicKey') found = true;
		return (orders[kind] = found ? seen : TOP_MEMBERS[kind]);
	};

	interface Top {
		/** the members as read, for the browser's own call */
		snapshot: Record<string, unknown>;
		publicKey?: Converted;
		mediation?: string;
		signal?: object;
	}
	const readTop = (
		kind: 'create' | 'get',
		options: Record<PropertyKey, unknown>,
	): Top => {
		const call = `Failed to execute '${kind}' on 'CredentialsContainer': `;
		const dictionary =
			kind === 'create'
				? 'CredentialCreationOptions'
				: 'CredentialRequestOptions';
		const top: Top = { snapshot: PageObject.create(null) };
		for (const key of topMembers(kind)) {
			const value = options[key];
			if (value === undefined) continue;
			const read = `${call}Failed to read the '${key}' property from '${dictionary}': `;
			if (key === 'mediation') {
				const text = toText(value, read);
				let valid = false;
				for (const known of MEDIATIONS) if (known === text) valid = true;
				if (!valid)
					throw typeError(
						`${read}The provided value '${text}' is not a valid enum value of type CredentialMediationRequirement.`,
					);
				top.mediation = text;
			} else if (key === 'signal') {
				if (!abort.is(value))
					throw typeError(`${read}Failed to convert value to 'AbortSignal'.`);
				top.signal = value as object;
			} else if (key === 'publicKey')
				top.publicKey = toDictionary(
					value,
					kind === 'create' ? CREATION : REQUEST,
					read,
				);
			top.snapshot[key] = value;
		}
		return top;
	};

	// --- the page's objects ---

	interface ResponseData {
		clientDataJSON: ArrayBuffer;
		attestationObject?: ArrayBuffer;
		authenticatorData: ArrayBuffer;
		publicKey?: ArrayBuffer;
		algorithm?: number;
		signature?: ArrayBuffer;
		userHandle?: ArrayBuffer | null;
	}
	interface CredentialData {
		id: string;
		rawId: ArrayBuffer;
		response: object;
		extensions: ExtensionResults;
	}
	interface ExtensionResults {
		credProps?: { rk: boolean };
		largeBlob?: { supported?: boolean; written?: boolean };
		prf?: { enabled?: boolean; results?: PrfValues };
	}
	const credentials = new WeakMap<object, CredentialData>();
	const responses = new WeakMap<object, ResponseData>();

	/** a buffer of the page's realm with these bytes */
	const pageBuffer = (bytes: ArrayBuffer): ArrayBuffer => {
		const out = new PageArrayBuffer(bytes.byteLength);
		new Uint8Array(out).set(new Uint8Array(bytes));
		return out;
	};
	/** an object of the page's realm with these members, in this order */
	const pageObject = (members: [string, unknown][]): object => {
		const out = new PageObject() as object;
		for (const [key, value] of members)
			if (value !== undefined)
				Reflect.defineProperty(out, key, {
					value,
					writable: true,
					enumerable: true,
					configurable: true,
				});
		return out;
	};
	const pageArray = (items: unknown[]): unknown[] => {
		const out = new PageArray() as unknown[];
		for (let i = 0; i < items.length; i++)
			Reflect.defineProperty(out, i, {
				value: items[i],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		return out;
	};
	const prfObject = (values: PrfValues, json: boolean) =>
		pageObject([
			['first', json ? toBase64URL(values.first) : pageBuffer(values.first)],
			[
				'second',
				values.second
					? json
						? toBase64URL(values.second)
						: pageBuffer(values.second)
					: undefined,
			],
		]);
	/** getClientExtensionResults(), or its JSON form: a new object each time */
	const extensionResults = (results: ExtensionResults, json: boolean) =>
		pageObject([
			[
				'credProps',
				results.credProps && pageObject([['rk', results.credProps.rk]]),
			],
			[
				'largeBlob',
				results.largeBlob &&
					pageObject([
						['supported', results.largeBlob.supported],
						['written', results.largeBlob.written],
					]),
			],
			[
				'prf',
				results.prf &&
					pageObject([
						['enabled', results.prf.enabled],
						[
							'results',
							results.prf.results && prfObject(results.prf.results, json),
						],
					]),
			],
		]);
	const responseJSON = (data: ResponseData) =>
		data.attestationObject
			? pageObject([
					['attestationObject', toBase64URL(data.attestationObject)],
					['authenticatorData', toBase64URL(data.authenticatorData)],
					['clientDataJSON', toBase64URL(data.clientDataJSON)],
					['publicKey', toBase64URL(data.publicKey!)],
					['publicKeyAlgorithm', data.algorithm],
					['transports', pageArray(['internal'])],
				])
			: pageObject([
					['authenticatorData', toBase64URL(data.authenticatorData)],
					['clientDataJSON', toBase64URL(data.clientDataJSON)],
					['signature', toBase64URL(data.signature!)],
					[
						'userHandle',
						data.userHandle ? toBase64URL(data.userHandle) : undefined,
					],
				]);

	/**
	 * A member of one of the browser's prototypes, answering for the objects
	 * made here and as the browser's for any other (its Illegal invocation)
	 */
	const answerFor = <Data extends object>(
		holder: object | undefined,
		key: string,
		table: WeakMap<object, Data>,
		answer: (data: Data) => unknown,
	) => {
		const descriptor = holder && Reflect.getOwnPropertyDescriptor(holder, key);
		if (!descriptor) return;
		const native = (descriptor.get ?? descriptor.value) as Function;
		if (typeof native !== 'function') return;
		const wrapped = proxyModule.wrapFunction(
			native as () => unknown,
			(target, that, args) => {
				const data = isObject(that) ? table.get(that) : undefined;
				return data ? answer(data) : Reflect.apply(target, that, args);
			},
		);
		Reflect.defineProperty(
			holder,
			key,
			descriptor.get
				? { ...descriptor, get: wrapped }
				: { ...descriptor, value: wrapped },
		);
	};

	const credentialPrototype = global.PublicKeyCredential?.prototype as
		object | undefined;
	const attestationPrototype = global.AuthenticatorAttestationResponse
		?.prototype as object | undefined;
	const assertionPrototype = global.AuthenticatorAssertionResponse
		?.prototype as object | undefined;
	const responsePrototype = global.AuthenticatorResponse?.prototype as
		object | undefined;
	const basePrototype = global.Credential?.prototype as object | undefined;

	answerFor(basePrototype, 'id', credentials, (data) => data.id);
	answerFor(basePrototype, 'type', credentials, () => 'public-key');
	answerFor(credentialPrototype, 'rawId', credentials, (data) => data.rawId);
	answerFor(
		credentialPrototype,
		'response',
		credentials,
		(data) => data.response,
	);
	answerFor(
		credentialPrototype,
		'authenticatorAttachment',
		credentials,
		() => 'platform',
	);
	answerFor(
		credentialPrototype,
		'getClientExtensionResults',
		credentials,
		(data) => extensionResults(data.extensions, false),
	);
	answerFor(credentialPrototype, 'toJSON', credentials, (data) =>
		pageObject([
			['authenticatorAttachment', 'platform'],
			['clientExtensionResults', extensionResults(data.extensions, true)],
			['id', data.id],
			['rawId', data.id],
			['response', responseJSON(responses.get(data.response)!)],
			['type', 'public-key'],
		]),
	);
	answerFor(
		responsePrototype,
		'clientDataJSON',
		responses,
		(data) => data.clientDataJSON,
	);
	answerFor(
		attestationPrototype,
		'attestationObject',
		responses,
		(data) => data.attestationObject,
	);
	answerFor(
		attestationPrototype,
		'getAuthenticatorData',
		responses,
		(data) => data.authenticatorData,
	);
	answerFor(
		attestationPrototype,
		'getPublicKey',
		responses,
		(data) => data.publicKey,
	);
	answerFor(
		attestationPrototype,
		'getPublicKeyAlgorithm',
		responses,
		(data) => data.algorithm,
	);
	answerFor(attestationPrototype, 'getTransports', responses, () =>
		pageArray(['internal']),
	);
	answerFor(
		assertionPrototype,
		'authenticatorData',
		responses,
		(data) => data.authenticatorData,
	);
	answerFor(
		assertionPrototype,
		'signature',
		responses,
		(data) => data.signature,
	);
	answerFor(
		assertionPrototype,
		'userHandle',
		responses,
		(data) => data.userHandle,
	);

	/**
	 * An object on one of the browser's prototypes. Behind a proxy with no
	 * traps, which changes nothing a script reads of it and makes it, like
	 * the browser's, an object that cannot be cloned or posted.
	 */
	const platformObject = (prototype: object): object =>
		new Proxy(PageObject.create(prototype) as object, {});

	const makeCredential = (
		id: ArrayBuffer,
		prototype: object,
		response: ResponseData,
		extensions: ExtensionResults,
	): object => {
		const responseObject = platformObject(prototype);
		responses.set(responseObject, response);
		const credential = platformObject(credentialPrototype!);
		credentials.set(credential, {
			id: toBase64URL(id),
			rawId: pageBuffer(id),
			response: responseObject,
			extensions,
		});
		return credential;
	};
	const attested = (
		made: PasskeyAttestation,
		extensions: ExtensionResults,
	): object =>
		makeCredential(
			made.id,
			attestationPrototype!,
			{
				clientDataJSON: pageBuffer(made.clientDataJSON),
				attestationObject: pageBuffer(made.attestationObject),
				authenticatorData: pageBuffer(made.authenticatorData),
				publicKey: pageBuffer(made.publicKey),
				algorithm: made.algorithm,
			},
			extensions,
		);
	const asserted = (
		made: PasskeyAssertion,
		extensions: ExtensionResults,
	): object =>
		makeCredential(
			made.id,
			assertionPrototype!,
			{
				clientDataJSON: pageBuffer(made.clientDataJSON),
				authenticatorData: pageBuffer(made.authenticatorData),
				signature: pageBuffer(made.signature),
				userHandle: made.userHandle ? pageBuffer(made.userHandle) : null,
			},
			extensions,
		);

	// --- a ceremony: to the worker, and its answer or its end ---

	/** a request is open: Chrome takes one at a time from a document */
	let pending = false;

	const sameOriginWithAncestors = (): boolean => {
		const own = client.origin;
		for (const origin of client.ancestorOrigins())
			if (origin !== own) return false;
		return true;
	};
	const policyAllows = async (feature: string): Promise<void> => {
		const allowed = policy(feature);
		if (allowed === true) return;
		if (allowed === false || !(await allowed))
			throw domException(policyRefusal(feature), 'NotAllowedError');
	};
	const requirement = (value: unknown): Requirement =>
		value === 'required' || value === 'discouraged' ? value : 'preferred';
	/** how long the ceremony may take: the page's time within the bounds, the default without one */
	const timeoutOf = (
		asked: number | undefined,
		verification: Requirement,
	): number | undefined => {
		if (passkeysConfig.testing) return asked;
		const kind = verification === 'discouraged' ? 'discouraged' : 'other';
		if (asked === undefined) return TIMEOUT_DEFAULT[kind];
		return asked < TIMEOUT_FLOOR
			? TIMEOUT_FLOOR
			: asked > TIMEOUT_CEILING[kind]
				? TIMEOUT_CEILING[kind]
				: asked;
	};

	const exchange = (
		op: PasskeyOp,
		signal: object | undefined,
		timeout: number | undefined,
	): Promise<PasskeyReply> =>
		new Promise<PasskeyReply>((resolve, reject) => {
			const [port, theirs] = privateChannel();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let open = true;
			const end = (cancel: boolean) => {
				if (!open) return false;
				open = false;
				if (timer !== undefined) clearTimeout(timer);
				if (cancel)
					try {
						postToPort(port, PASSKEY_CANCEL);
					} catch (error) {
						// nobody to tell
					}
				closePort(port);
				return true;
			};
			onPort(port, 'message', (data) => {
				if (end(false)) resolve(data as PasskeyReply);
			});
			// whoever held the other end went away without an answer
			onPort(port, 'close', () => {
				if (end(false)) resolve({ error: ['NotAllowedError', NOT_ALLOWED] });
			});
			if (signal)
				abort.listen(signal, () => {
					if (end(true)) reject(abort.reason(signal));
				});
			if (timeout !== undefined)
				timer = setTimeout(
					() => {
						if (end(true)) resolve({ error: ['NotAllowedError', NOT_ALLOWED] });
					},
					// a timer takes no more than 2^31 - 1 ms (an unsigned long may be more)
					timeout > 0x7fffffff ? 0x7fffffff : timeout,
				);
			if (!toWorker(op, theirs) && end(false))
				resolve({ error: ['NotAllowedError', NOT_ALLOWED] });
		});

	const failure = (reply: PasskeyReply): never => {
		const [name, message] =
			'error' in reply ? reply.error : ['NotAllowedError', NOT_ALLOWED];
		throw domException(message, name);
	};

	const create = async (top: Top): Promise<object> => {
		const publicKey = top.publicKey!;
		if (
			top.snapshot.password !== undefined ||
			top.snapshot.federated !== undefined
		)
			throw domException(
				"Only exactly one of 'password', 'federated', and 'publicKey' credential types are currently supported.",
				'NotSupportedError',
			);
		if (top.signal && abort.aborted(top.signal)) throw abort.reason(top.signal);
		await policyAllows('publickey-credentials-create');
		const sameOrigin = sameOriginWithAncestors();
		if (!sameOrigin && client.historyActivation?.transient() !== true)
			throw domException(
				'A user activation is required to create a credential in a cross-origin iframe.',
				'NotAllowedError',
			);
		if ((publicKey.user.id as ArrayBuffer).byteLength > 64)
			throw typeError('User handle exceeds 64 bytes.');
		const params = publicKey.pubKeyCredParams as {
			alg: number;
			type: string;
		}[];
		let algs: number[] = [];
		for (const param of params)
			if (param.type === 'public-key') algs[algs.length] = param.alg;
		if (params.length && !algs.length)
			throw domException(
				'Required parameters missing in `options.publicKey`.',
				'NotSupportedError',
			);
		// none named: ES256 and RS256, in that order (5.4, pubKeyCredParams)
		if (!params.length) algs = [-7, -257];
		const extensions = (publicKey.extensions ?? {}) as Converted;
		if (extensions.prf?.evalByCredential !== undefined)
			throw domException(
				"The 'evalByCredential' field cannot be set when creating a credential.",
				'NotSupportedError',
			);
		for (const member of ['read', 'write'])
			if (extensions.largeBlob?.[member] !== undefined)
				throw domException(
					`The 'largeBlob' extension's '${member}' parameter is only valid when requesting an assertion`,
					'NotSupportedError',
				);

		const busy = pending;
		pending = true;
		try {
			await task();
			if (busy)
				throw domException('A request is already pending.', 'OperationError');
			// a credential made without the user being asked is one this
			// authenticator never makes; a large blob is one it cannot keep
			if (
				top.mediation === 'conditional' ||
				extensions.largeBlob?.support === 'required'
			)
				throw domException(NOT_ALLOWED, 'NotAllowedError');
			const selection = (publicKey.authenticatorSelection ?? {}) as Converted;
			const exclude: ArrayBuffer[] = [];
			for (const entry of (publicKey.excludeCredentials ?? []) as Converted[])
				if (entry.type === 'public-key') exclude[exclude.length] = entry.id;
			const options: PasskeyCreateOptions = {
				...(publicKey.rp.id !== undefined ? { rpId: publicKey.rp.id } : {}),
				rpName: publicKey.rp.name,
				user: {
					id: publicKey.user.id,
					name: publicKey.user.name,
					displayName: publicKey.user.displayName,
				},
				challenge: publicKey.challenge,
				algs,
				exclude,
				...(selection.authenticatorAttachment !== undefined
					? { attachment: selection.authenticatorAttachment }
					: {}),
				// residentKey decides; without it the older requireResidentKey does
				residentKey:
					selection.residentKey === 'required' ||
					selection.residentKey === 'preferred' ||
					selection.residentKey === 'discouraged'
						? selection.residentKey
						: selection.requireResidentKey
							? 'required'
							: 'discouraged',
				userVerification: requirement(selection.userVerification),
				...(extensions.prf
					? {
							prf: extensions.prf.eval ? { eval: extensions.prf.eval } : {},
						}
					: {}),
				...(extensions.appidExclude !== undefined
					? { appid: extensions.appidExclude }
					: {}),
			};
			const reply = await exchange(
				{ op: 'create', options, sameOriginWithAncestors: sameOrigin },
				top.signal,
				timeoutOf(publicKey.timeout, options.userVerification),
			);
			if (!('attestation' in reply)) return failure(reply);
			const made = reply.attestation;
			return attested(made, {
				...(extensions.credProps
					? { credProps: { rk: made.discoverable } }
					: {}),
				...(extensions.largeBlob ? { largeBlob: { supported: false } } : {}),
				...(made.prf ? { prf: made.prf } : {}),
			});
		} finally {
			if (!busy) pending = false;
		}
	};

	const get = async (top: Top): Promise<object> => {
		const publicKey = top.publicKey!;
		if (top.signal && abort.aborted(top.signal)) throw abort.reason(top.signal);
		await policyAllows('publickey-credentials-get');
		const extensions = (publicKey.extensions ?? {}) as Converted;
		if (extensions.largeBlob?.support !== undefined)
			throw domException(
				"The 'largeBlob' extension's 'support' parameter is only valid when creating a credential",
				'NotSupportedError',
			);
		const allow: ArrayBuffer[] = [];
		for (const entry of (publicKey.allowCredentials ?? []) as Converted[])
			if (entry.type === 'public-key') allow[allow.length] = entry.id;
		const byCredential = extensions.prf?.evalByCredential as
			Record<string, PrfValues> | undefined;
		if (byCredential) {
			const keys = Reflect.ownKeys(byCredential) as string[];
			if (keys.length && !allow.length)
				throw domException(
					"'prf' extension has 'evalByCredential' with an empty allow list",
					'NotSupportedError',
				);
			for (const key of keys) {
				if (!isBase64URL(key) || key === '')
					throw domException(
						"'prf' extension contains invalid base64url data in 'evalByCredential'",
						'SyntaxError',
					);
				let named = false;
				for (const id of allow) if (toBase64URL(id) === key) named = true;
				if (!named)
					throw domException(
						"'prf' extension contains 'evalByCredential' key that doesn't match any in allowedCredentials",
						'SyntaxError',
					);
			}
		}

		// a conditional request waits beside any other, as the browser's
		// autofill does; any other is the document's one open request
		const conditional = top.mediation === 'conditional';
		const busy = pending;
		if (!conditional) pending = true;
		try {
			await task();
			if (busy && !conditional)
				throw domException('A request is already pending.', 'OperationError');
			if (
				extensions.largeBlob?.read !== undefined &&
				extensions.largeBlob.write !== undefined
			)
				throw domException(
					"Only one of the 'largeBlob' extension's 'read' and 'write' parameters is allowed at a time",
					'NotSupportedError',
				);
			const options: PasskeyGetOptions = {
				...(publicKey.rpId !== undefined ? { rpId: publicKey.rpId } : {}),
				challenge: publicKey.challenge,
				allow,
				userVerification: requirement(publicKey.userVerification),
				...(top.mediation !== undefined ? { mediation: top.mediation } : {}),
				...(extensions.prf
					? {
							prf: {
								...(extensions.prf.eval ? { eval: extensions.prf.eval } : {}),
								...(byCredential ? { byCredential: { ...byCredential } } : {}),
							},
						}
					: {}),
				...(extensions.appid !== undefined ? { appid: extensions.appid } : {}),
			};
			const reply = await exchange(
				{
					op: 'get',
					options,
					sameOriginWithAncestors: sameOriginWithAncestors(),
				},
				top.signal,
				// the browser's autofill has no time limit
				conditional
					? undefined
					: timeoutOf(publicKey.timeout, options.userVerification),
			);
			if (!('assertion' in reply)) return failure(reply);
			const made = reply.assertion;
			return asserted(made, {
				// no large blob is kept: none read, none written
				...(extensions.largeBlob
					? {
							largeBlob:
								extensions.largeBlob.write !== undefined
									? { written: false }
									: {},
						}
					: {}),
				...(made.prf ? { prf: made.prf } : {}),
			});
		} finally {
			if (!busy && !conditional) pending = false;
		}
	};

	const run = (kind: 'create' | 'get', that: unknown, args: unknown[]) => {
		const native = natives[kind];
		const options = args[0];
		// another document's container, or nothing a dictionary is read
		// from: the browser's own answer
		if (that !== ctx.container || !isObject(options))
			return Reflect.apply(native, that, args);
		let top: Top;
		try {
			top = readTop(kind, options);
		} catch (error) {
			return rejected(error);
		}
		if (top.publicKey)
			return pagePromise(kind === 'create' ? create(top) : get(top));
		// FedCM (the Credentials module's own flow)
		if (kind === 'get' && top.snapshot.identity !== undefined)
			return ctx.identity(top.snapshot.identity, top.signal, top.mediation);
		// the members as they were read: the browser reads them again from
		// here, and the page's own getters run once
		return Reflect.apply(native, that, [top.snapshot]);
	};

	// --- the signal API ---

	const signal = async (
		method: string,
		args: unknown[],
	): Promise<undefined> => {
		const call = `Failed to execute '${method}' on 'PublicKeyCredential': `;
		if (args.length < 1)
			throw typeError(`${call}1 argument required, but only 0 present.`);
		const told = toDictionary(args[0], SIGNALS[method], call);
		const check = (member: string, value: string) => {
			if (!isBase64URL(value))
				throw typeError(`${call}Invalid base64url string for ${member}.`);
		};
		let message: PasskeySignal;
		if (method === 'signalUnknownCredential') {
			check('credentialId', told.credentialId);
			message = {
				kind: 'unknown',
				rpId: told.rpId,
				credentialId: told.credentialId,
			};
		} else if (method === 'signalAllAcceptedCredentials') {
			check('userId', told.userId);
			for (const id of told.allAcceptedCredentialIds as string[])
				check('allAcceptedCredentialIds', id);
			message = {
				kind: 'accepted',
				rpId: told.rpId,
				userId: told.userId,
				ids: told.allAcceptedCredentialIds,
			};
		} else {
			check('userId', told.userId);
			message = {
				kind: 'details',
				rpId: told.rpId,
				userId: told.userId,
				name: told.name,
				displayName: told.displayName,
			};
		}
		const reply = await exchange(
			{ op: 'signal', signal: message },
			undefined,
			undefined,
		);
		if ('error' in reply && reply.error[0] === 'SecurityError')
			return failure(reply);
		// the site learns nothing of what was held
		return undefined;
	};

	// --- the capability statics: STomp's authenticator is the one a page asks about ---

	/** Chrome answers these from another process, in a later task: so do these */
	const later = <T>(value: T): Promise<T> =>
		new PagePromise<T>((resolvePage) => {
			setTimeout(() => resolvePage(value), 0);
		});
	const uv = passkeysConfig.uv;
	/** getClientCapabilities: the names this Chrome lists, in its order, answered for STomp */
	const capabilities = (target: Function): Promise<object> =>
		new PagePromise<object>((resolvePage) => {
			const answer = (native: object | null) => {
				const out = new PageObject() as Record<string, boolean>;
				const names = native
					? Reflect.ownKeys(native)
					: [...CAPABLE, ...VERIFYING].sort();
				for (const name of names)
					if (typeof name === 'string')
						Reflect.defineProperty(out, name, {
							value: VERIFYING.includes(name) ? uv : CAPABLE.includes(name),
							writable: true,
							enumerable: true,
							configurable: true,
						});
				resolvePage(out);
			};
			// its own answer asks nothing of the network or of an authenticator
			try {
				(
					Reflect.apply(target, ctx.PublicKeyCredential, []) as Promise<object>
				).then(answer, () => answer(null));
			} catch (error) {
				setTimeout(() => answer(null), 0);
			}
		});

	return {
		create: (that, args) => run('create', that, args),
		get: (that, args) => run('get', that, args),
		statics: (name, target, args) =>
			name === 'isUserVerifyingPlatformAuthenticatorAvailable'
				? later(uv)
				: name === 'isConditionalMediationAvailable'
					? later(true)
					: name === 'getClientCapabilities'
						? capabilities(target)
						: pagePromise(signal(name, args)),
	};
}
