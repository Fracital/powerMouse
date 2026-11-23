// Passkeys through the proxy (docs/passkeys.md): what travels between a
// proxied page's inject, the service worker (STomp's authenticator, which
// holds the keys and signs), the controller and the host application, which
// asks the user, and what the host application sees.

/** WebAuthn's requirement words (userVerification, residentKey) */
export type Requirement = 'required' | 'preferred' | 'discouraged';

/** the PRF extension's inputs, as bytes */
export interface PrfValues {
	first: ArrayBuffer;
	second?: ArrayBuffer;
}

/** a page's `credentials.create({ publicKey })`, converted as Chrome converts it */
export interface PasskeyCreateOptions {
	/** `rp.id`; the worker fills in the page's own host when the page named none */
	rpId?: string;
	rpName: string;
	user: { id: ArrayBuffer; name: string; displayName: string };
	challenge: ArrayBuffer;
	/** the COSE algorithms the site takes for `public-key`, in its order */
	algs: number[];
	/** the ids of `excludeCredentials` */
	exclude: ArrayBuffer[];
	attachment?: string;
	residentKey: Requirement;
	userVerification: Requirement;
	/** the PRF extension was asked for (`eval` at creation is optional) */
	prf?: { eval?: PrfValues };
	/** the appidExclude extension's AppID: checked against the origin, as Chrome checks it, and used for nothing */
	appid?: string;
	/** the largeBlob extension was asked for, with its `support` (`preferred` when it named none) */
	largeBlob?: 'required' | 'preferred';
	/** the credBlob extension's blob, to keep with the credential when it fits */
	credBlob?: ArrayBuffer;
	/**
	 * `mediation: 'conditional'`: the site offers to save a passkey in the
	 * background; it is never told no, and waits for the user to take it
	 */
	conditional?: boolean;
}

/** a page's `credentials.get({ publicKey })`, converted as Chrome converts it */
export interface PasskeyGetOptions {
	rpId?: string;
	challenge: ArrayBuffer;
	/** the ids of `allowCredentials`; empty asks for a discoverable credential */
	allow: ArrayBuffer[];
	userVerification: Requirement;
	/** `mediation`: `conditional` waits for the user to ask, `silent` may show nothing */
	mediation?: string;
	prf?: { eval?: PrfValues; byCredential?: Record<string, PrfValues> };
	/** the appid extension's AppID: checked against the origin, and used for nothing */
	appid?: string;
	/** the largeBlob extension: read the chosen credential's blob, or write this one in its place */
	largeBlob?: { read: true } | { write: ArrayBuffer };
	/** the getCredBlob extension: the chosen credential's credBlob */
	getCredBlob?: boolean;
}

/** what a page asks of the signal API (PublicKeyCredential.signal*) */
export type PasskeySignal =
	| { kind: 'unknown'; rpId: string; credentialId: string }
	| { kind: 'accepted'; rpId: string; userId: string; ids: string[] }
	| {
			kind: 'details';
			rpId: string;
			userId: string;
			name: string;
			displayName: string;
	  };

/** a document's message to the worker (PASSKEY, src/transport/messages.ts) */
export type PasskeyOp =
	| {
			op: 'create';
			options: PasskeyCreateOptions;
			/** every ancestor of the document is of its origin, as the inject reads the frame tree */
			sameOriginWithAncestors: boolean;
	  }
	| {
			op: 'get';
			options: PasskeyGetOptions;
			sameOriginWithAncestors: boolean;
	  }
	| { op: 'signal'; signal: PasskeySignal };

/**
 * A ceremony the worker passes on: the page's request with what the worker
 * itself says of the document (never the page): its real origin, its top's,
 * and the relying party id once it is checked against them
 */
export type PasskeyCeremony = {
	/** the requesting document's real origin */
	origin: string;
	/** the proxied top's origin, when the document is not same-origin with every ancestor */
	topOrigin?: string;
	/** the relying party id, valid for `origin` */
	rpId: string;
	/** the requesting document's service worker client id */
	client?: string;
} & (
	| { type: 'create'; options: PasskeyCreateOptions }
	| { type: 'get'; options: PasskeyGetOptions }
	| { type: 'signal'; signal: PasskeySignal }
);

/** an error the page is given: a DOMException's name and message */
export type PasskeyFailure = { error: [name: string, message: string] };

/** a made credential, as bytes: the inject builds the page's objects from it */
export interface PasskeyAttestation {
	id: ArrayBuffer;
	clientDataJSON: ArrayBuffer;
	attestationObject: ArrayBuffer;
	authenticatorData: ArrayBuffer;
	/** the public key as SubjectPublicKeyInfo */
	publicKey: ArrayBuffer;
	algorithm: number;
	/** whether the credential is discoverable (credProps.rk) */
	discoverable: boolean;
	prf?: { enabled: boolean; results?: PrfValues };
	/** largeBlob: whether the credential can hold a large blob */
	largeBlob?: boolean;
	/** credBlob: whether the blob was kept */
	credBlob?: boolean;
}

/** an assertion, as bytes */
export interface PasskeyAssertion {
	id: ArrayBuffer;
	clientDataJSON: ArrayBuffer;
	authenticatorData: ArrayBuffer;
	signature: ArrayBuffer;
	userHandle: ArrayBuffer | null;
	prf?: { results?: PrfValues };
	/** largeBlob: the blob read (none when the credential holds none), or whether one was written */
	largeBlob?: { blob?: ArrayBuffer } | { written: boolean };
	/** getCredBlob: the credential's credBlob, empty when it has none */
	credBlob?: ArrayBuffer;
}

/** the answer on a ceremony's port */
export type PasskeyReply =
	| PasskeyFailure
	| { attestation: PasskeyAttestation }
	| { assertion: PasskeyAssertion }
	| { done: true };

/** the page's word on a ceremony's port: it gave up (its signal, its timeout) */
export const PASSKEY_CANCEL = 'cancel';

// --- the host application's side ---

/** a passkey STomp holds, as the host application sees it (no key material) */
export interface PasskeyInfo {
	/** the credential id, base64url */
	id: string;
	/** the relying party id it is bound to */
	rpId: string;
	/** the user handle the site gave, base64url */
	userHandle: string;
	userName: string;
	userDisplayName: string;
	/** a discoverable credential: offered when the site names none */
	discoverable: boolean;
	/** when it was made and last used, in milliseconds since the epoch */
	created: number;
	lastUsed: number | null;
}

/** a proxied site's passkey ceremony the host application is asked about */
export interface PasskeyRequest {
	/** `create`: the site registers a passkey; `get`: it asks for a sign-in */
	type: 'create' | 'get';
	/** the relying party id, checked against the page's real origin */
	rpId: string;
	/** the real origin of the document that asks */
	origin: string;
	/** the proxied top's origin, when the document is a frame of another origin */
	topOrigin?: string;
	/** `create`: the account the site names */
	user?: { name: string; displayName: string };
	/**
	 * `create`: a passkey held for this site is on the site's exclude list.
	 * The site is told so only after the user agrees (WebAuthn's rule), so
	 * the prompt still shows.
	 */
	excluded?: boolean;
	/** `get`: the held passkeys that may answer, newest use first; may be empty */
	credentials?: PasskeyInfo[];
	/**
	 * The site waits in the background (conditional mediation): show
	 * nothing modal. For `get`, for the user to pick a passkey (the
	 * browser's autofill); for `create`, for the user to save one (a site
	 * offering a passkey after a sign-in with a password). Resolving null
	 * leaves the site waiting, until its own timeout or signal ends it, and
	 * it is never told that nobody took the offer.
	 */
	conditional?: boolean;
	/** what the site asks of user verification */
	userVerification: Requirement;
	/** aborted when the page gives up (its signal, its timeout, its document going away) */
	signal: AbortSignal;
	/** the requesting document's service worker client id */
	client?: string;
}

/** a ceremony as the service worker sends it to the controller to ask the host: the request without its signal */
export type PasskeyPrompt = Omit<PasskeyRequest, 'signal'>;

/**
 * The host's answer: for `get`, the id of the passkey the user chose.
 * `userVerified` only when the host itself verified who the user is (a PIN,
 * the device's unlock), never for a click.
 */
export interface PasskeyAnswer {
	credential?: string;
	userVerified?: boolean;
}

/** the passkeys option of StompController and RemoteController, whose requests name a frame of theirs */
export interface PasskeysInit<Request extends PasskeyRequest = PasskeyRequest> {
	/**
	 * Called for every `create` and every `get` a proxied site makes: show
	 * the user who asks (`rpId`) and resolve an answer, or null (or throw)
	 * when the user declined. Nothing is made or signed without it.
	 */
	onRequest: (
		request: Request,
	) => PasskeyAnswer | null | Promise<PasskeyAnswer | null>;
	/**
	 * The host verifies the user itself (a real user-verifying ceremony of
	 * its own, such as the platform authenticator's on the host's origin)
	 * before it answers `userVerified`. Sites then read a user-verifying
	 * platform authenticator as available. Leave it off when the host cannot:
	 * sites then see none, and get no UV flag, as natively without one.
	 */
	userVerification?: boolean;
	/**
	 * For tests: take a page's timeout as given, as Chrome does with a
	 * virtual authenticator.
	 */
	testing?: boolean;
}

/** the host's view of the service worker's passkey store (StompController.passkeys, RemoteController.passkeys) */
export interface PasskeyManager {
	/** every held passkey, or those bound to `rpId` */
	list(rpId?: string): Promise<PasskeyInfo[]>;
	/** forget one, by id; false when there was none */
	delete(id: string): Promise<boolean>;
	/** forget every passkey, or those bound to `rpId` */
	clear(rpId?: string): Promise<void>;
}

/** what the controller asks of the service worker's store (SWbound `passkeys`) */
export type PasskeyCommand =
	| { op: 'list'; rpId?: string }
	| { op: 'delete'; id: string }
	| { op: 'clear'; rpId?: string };

/** what a page's config says of passkeys (Config.passkeys) */
export interface PasskeysConfig {
	/** the host verifies users (PasskeysInit.userVerification) */
	uv: boolean;
	/** PasskeysInit.testing */
	testing: boolean;
}
