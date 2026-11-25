// What navigator.credentials.get() (where STomp is no passkey provider),
// store() and preventSilentAccess() do past their hooks
// (modules/Credentials.ts), deferred parts of the document bundle
// (./deferredParts.ts) made at a document's first call of one: most
// documents make none.
import type DocumentClient from './Client';
import type { identityFlow } from './credentialFlows';

/** what the module hands the calls, made before any page script ran */
export interface CredentialCallContext {
	client: DocumentClient;
	PagePromise: PromiseConstructor;
	/** a DOMException of the page's realm */
	domException(message: string, name: string): DOMException;
	/** FedCM's flows, made at the first call that needs them */
	identityFlow(): ReturnType<typeof identityFlow>;
	/** the browser's own get, behind the related origins guard */
	browserGet(target: Function, that: unknown, args: unknown[]): unknown;
	/** the site's own store's answer (a password or a federated sign-in) */
	ownStore(): Promise<unknown>;
	/** FedCM's flow for an identity request */
	runIdentity(identity: unknown, signal: unknown, mediation: unknown): unknown;
	/** a rejection of the page's realm */
	reject(error: unknown): Promise<never>;
}

/** `get(...args)` of `that`, `target` the browser's */
export function credentialGet(
	{ browserGet, ownStore, runIdentity, reject }: CredentialCallContext,
	target: Function,
	that: unknown,
	args: unknown[],
): unknown {
	const options = args[0] as Record<string, unknown> | null;
	if (
		options === null ||
		(typeof options !== 'object' && typeof options !== 'function')
	)
		return browserGet(target, that, args);
	// the members are read once and pinned: a getter cannot hand the
	// browser a request this never saw. A password or a federated
	// sign-in alone is the site's own store's; a passkey asked for with
	// one is the passkey's alone
	let identity: unknown;
	let password: unknown;
	let federated: unknown;
	let publicKey: unknown;
	try {
		federated = options.federated;
		identity = options.identity;
		password = options.password;
		publicKey = options.publicKey;
	} catch (error) {
		return reject(error);
	}
	const own = identity === undefined && (!!password || federated !== undefined);
	if (own && publicKey === undefined) return ownStore();
	const pinned = [
		{
			__proto__: options,
			identity,
			publicKey,
			...(own
				? { password: false, federated: undefined }
				: { password, federated }),
		},
		...args.slice(1),
	];
	const asked = (): unknown => browserGet(target, that, pinned);
	if (own) return ownStore().then(asked);
	// no identity: the browser's own get (a passkey, NotSupportedError)
	if (identity === undefined) return asked();
	let signal: unknown;
	let mediation: unknown;
	try {
		signal = options.signal;
		mediation = options.mediation;
	} catch (error) {
		return reject(error);
	}
	return runIdentity(identity, signal, mediation);
}

/** `store(...args)` of `that`, `target` the browser's */
export function credentialStore(
	{ ownStore }: CredentialCallContext,
	target: Function,
	that: unknown,
	args: unknown[],
): unknown {
	const tag = Object.prototype.toString.call(args[0]);
	return tag === '[object PasswordCredential]' ||
		tag === '[object FederatedCredential]'
		? ownStore().then(() => undefined)
		: Reflect.apply(target, that, args);
}

/**
 * `preventSilentAccess()` of `that`, `target` the browser's: Chrome answers
 * a top-level document only (a frame's is refused, measured), and every
 * proxied document is a frame to it; at a proxied top it resolves, and
 * FedCM's next request of the site asks the user (what the browser keeps
 * of a site's sign-ins is the worker's: src/server/identityStates.ts)
 */
export function preventSilentAccess(
	{
		client,
		PagePromise,
		domException,
		identityFlow,
		reject,
	}: CredentialCallContext,
	target: Function,
	that: unknown,
	args: unknown[],
): unknown {
	if (that !== client.global.navigator.credentials)
		return Reflect.apply(target, that, args);
	if (client.ancestorOrigins().length)
		return reject(
			domException(
				'Error connecting to Credential Management service.',
				'NotSupportedError',
			),
		);
	try {
		identityFlow().preventSilent();
	} catch (error) {
		return reject(error);
	}
	return Reflect.apply(PagePromise.resolve, PagePromise, [undefined]);
}
