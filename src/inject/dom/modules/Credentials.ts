import Module from '../../Module';
import ProxyModule, { memberName } from '../../modules/Proxy';
import { withStack } from '../../nativeErrors';
import type DocumentClient from '../Client';
import { deferred, passkeysPart } from '../deferred';
import type { DeferredParts } from '../deferredParts';
import {
	REALM,
	type PasskeysContext,
	type PasskeysInstalled,
} from '../passkeysLazy';
import { trustworthy } from './ServiceWorker';

/**
 * Chrome's own words for a create or get the user did not allow (the
 * authenticator declined, timed out, or there was none): what a request
 * that would reach the browser's real authenticator ends as instead
 */
export const DECLINED =
	'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.';

interface CredentialData {
	token: string;
	isAutoSelected: boolean;
	configURL: string;
	id: string;
	type: string;
}

/**
 * FedCM, emulated the way WebRTC is (the interfaces present and native-reading,
 * a working stack of STomp's own behind them). A real Chrome runs
 * `navigator.credentials.get({ identity })` from its own process: it fetches
 * the identity provider's config, accounts (with the user's IdP cookies),
 * client metadata and token endpoints itself, never through the service worker.
 * Those requests cannot be routed, so a page on the old behaviour got a
 * browser-without-FedCM (the globals gone, the call rejecting NotSupportedError)
 * - a fingerprint tell, since Chrome 157 ships FedCM on and CreepJS plus a
 * direct-vs-proxied enumeration showed exactly these five properties missing
 * only through the proxy: IdentityCredential, IdentityCredentialError,
 * IdentityProvider, NavigatorLogin and navigator.login.
 *
 * Here the globals stay, reading as the browser's (ProxyModule.standInClass),
 * and the protocol runs in the inject: every network step goes through the
 * routed fetch the page's own loads go through (loadGrants.loadFetch), with the
 * `webidentity` destination so the server synthesises Sec-Fetch-Dest:
 * webidentity (src/server/rewrites.ts). The steps the browser reads in its own
 * process with no CORS check (the well-known file, config, accounts) are read
 * by the service worker, which posts their bodies on the document's load
 * channel (../credentialFlows.ts idpRead). The account chooser the browser
 * draws as trusted chrome is drawn by the host's page over the document's
 * frame (src/controller/accountChooser.ts): nothing of it is in the page's
 * document.
 *
 * IdentityCredentialError is left as the browser's own: it is constructible,
 * reads no network and so cannot leak, and reads natively already.
 *
 * WebAuthn (docs/passkeys.md): when the host has a passkey provider (the
 * controller's `passkeys` option) a `publicKey` request never reaches the
 * browser, and STomp's own client (../passkeys.ts, a deferred statement
 * evaluated at the first call) reads it as Chrome does, for the service
 * worker's authenticator. Without one, the browser's own authenticator
 * still never acts for a proxied page (below).
 */
export default class CredentialsModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global as unknown as typeof globalThis &
			Record<string, any>;
		const container = global.CredentialsContainer?.prototype;
		if (typeof container?.get !== 'function') return;
		// FedCM lives only in a secure context; a realm without it (an old Chrome,
		// or one started with --disable-features=FedCm) has nothing to stand in for
		const NativeIdentityCredential = global.IdentityCredential as
			(Function & { prototype: object }) | undefined;
		const NativeIdentityProvider = global.IdentityProvider as
			Function | undefined;
		const NativeNavigatorLogin = global.NavigatorLogin as Function | undefined;
		const NativeCredential = global.Credential as
			(Function & { prototype: object }) | undefined;
		if (
			typeof NativeIdentityCredential !== 'function' ||
			typeof NativeIdentityProvider !== 'function' ||
			typeof NativeNavigatorLogin !== 'function' ||
			typeof NativeCredential !== 'function'
		)
			return;

		const proxyModule = client.getModule(ProxyModule)!;
		const PagePromise: PromiseConstructor = global.Promise;
		const PageTypeError: TypeErrorConstructor = global.TypeError;
		const PageDOMException: typeof DOMException = global.DOMException;
		const PageObject = global.Object as ObjectConstructor;
		const NativeIdentityCredentialError = global.IdentityCredentialError as
			(new (message?: string, options?: object) => object) | undefined;
		const reject = (error: unknown) =>
			Reflect.apply(PagePromise.reject, PagePromise, [error]);
		const domException = (message: string, name: string) =>
			withStack(new PageDOMException(message, name));
		const typeError = (message: string) =>
			withStack(new PageTypeError(message));

		// --- the aborted-signal reason ---

		const signalPrototype = global.AbortSignal?.prototype;
		const abortedGet = signalPrototype
			? Reflect.getOwnPropertyDescriptor(signalPrototype, 'aborted')?.get
			: undefined;
		const reasonGet = signalPrototype
			? Reflect.getOwnPropertyDescriptor(signalPrototype, 'reason')?.get
			: undefined;
		const abortReason = (signal: unknown): unknown => {
			if (!abortedGet || !reasonGet || signal === null || signal === undefined)
				return undefined;
			try {
				return Reflect.apply(abortedGet, signal, [])
					? Reflect.apply(reasonGet, signal, [])
					: undefined;
			} catch (error) {
				return undefined;
			}
		};

		// --- the stand-in interfaces, reading as the browser's ---

		const credentialData = new WeakMap<object, CredentialData>();
		const loginData = new WeakSet<object>();

		// a getter of a native prototype, wrapped so it reads as the browser's
		// (name, length, [native code]) and returns this document's own data for
		// an object it made, or throws the browser's Illegal invocation
		// (one call for all of them, which reads which member it is from the
		// native getter it wraps)
		const credentialGetter = (target: Function, that: object) => {
			const data = credentialData.get(that);
			if (!data) return Reflect.apply(target, that, []);
			return data[memberName(target) as keyof CredentialData];
		};
		const wrappedGetter = (
			nativePrototype: object,
			key: string,
		): PropertyDescriptor => {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				nativePrototype,
				key,
			)!;
			return {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get!, credentialGetter),
			};
		};
		const copyStringTag = (proto: object, nativeProto: object) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				nativeProto,
				Symbol.toStringTag,
			);
			if (descriptor)
				Reflect.defineProperty(proto, Symbol.toStringTag, descriptor);
		};
		const standInClass = (
			nativeClass: Function,
			prototype: object,
		): Function => {
			const Mock = function () {};
			Mock.prototype = prototype;
			return proxyModule.standInClass(Mock as any, nativeClass, true);
		};
		// a static of a stand-in overwritten with an implementation that reads as
		// the browser's method but routes/emulates, never the native path
		const overwriteStatic = (
			standIn: Function,
			nativeOwner: object,
			key: string,
			impl: (args: any[]) => unknown,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(nativeOwner, key)!;
			Reflect.defineProperty(standIn, key, {
				...descriptor,
				value: proxyModule.wrapFunction(
					descriptor.value,
					(target, that, args) => impl(args),
				),
			});
		};

		// IdentityCredential: its prototype reads token, isAutoSelected and
		// configURL from the credential this document resolved; the browser
		// constructs it (illegal). Its chain is IdentityCredential.prototype ->
		// Credential.prototype -> Object, and `id` and `type` are the base's,
		// as natively: Credential.prototype's own getters answer for a
		// credential of this document (and as ever for any other), so the
		// stand-in's prototype has the browser's keys and no more.
		const icPrototype = PageObject.create(NativeCredential.prototype);
		for (const key of ['token', 'isAutoSelected', 'configURL'] as const)
			Reflect.defineProperty(
				icPrototype,
				key,
				wrappedGetter(NativeIdentityCredential.prototype, key),
			);
		for (const key of ['id', 'type'] as const)
			Reflect.defineProperty(
				NativeCredential.prototype,
				key,
				wrappedGetter(NativeCredential.prototype, key),
			);
		copyStringTag(icPrototype, NativeIdentityCredential.prototype);
		const IdentityCredential = standInClass(
			NativeIdentityCredential,
			icPrototype,
		);

		const ipPrototype = PageObject.create(PageObject.prototype);
		copyStringTag(ipPrototype, NativeIdentityProvider.prototype);
		const IdentityProvider = standInClass(NativeIdentityProvider, ipPrototype);

		const nlPrototype = PageObject.create(PageObject.prototype);
		copyStringTag(nlPrototype, NativeNavigatorLogin.prototype);
		const NavigatorLogin = standInClass(NativeNavigatorLogin, nlPrototype);

		// --- FedCM's flows, made at a document's first call (../credentialFlows.ts) ---

		const makeCredential = (
			token: string,
			isAutoSelected: boolean,
			configURL: string,
		): object => {
			const credential = PageObject.create(icPrototype);
			credentialData.set(credential, {
				token,
				isAutoSelected,
				configURL,
				id: '',
				type: 'identity',
			});
			return credential;
		};

		let flows: ReturnType<DeferredParts['identityFlow']> | null = null;
		// what the flow reads its endpoints' bodies with, taken before any of
		// the page's script ran: an account list must reach no function of
		// the page's
		const parse = global.JSON.parse;
		const isArray = global.Array.isArray;
		const identityFlow = () =>
			(flows ??= deferred('identityFlow')({
				client,
				PagePromise,
				domException,
				typeError,
				abortReason,
				makeCredential,
				IdentityCredentialError: NativeIdentityCredentialError,
				parse,
				isArray,
			}));
		// both answer with a promise: a part that cannot be had (one of
		// another build, a failed load) is a rejection, never a throw
		const disconnect = (options: unknown) => {
			let flow: ReturnType<typeof identityFlow>;
			try {
				flow = identityFlow();
			} catch (error) {
				return reject(error);
			}
			return flow.disconnect(options);
		};
		const runIdentity = (
			identity: unknown,
			signal: unknown,
			mediation: unknown,
		) => {
			let flow: ReturnType<typeof identityFlow>;
			try {
				flow = identityFlow();
			} catch (error) {
				return reject(error);
			}
			return flow.runIdentity(identity, signal, mediation);
		};

		// preventSilentAccess(): Chrome answers a top-level document only
		// (a frame's is refused, measured), and every proxied document is a
		// frame to it; at a proxied top it resolves, and FedCM's next request
		// of the site asks the user (what the browser keeps of a site's
		// sign-ins is the worker's: src/server/identityStates.ts)
		if (typeof container.preventSilentAccess === 'function')
			container.preventSilentAccess = proxyModule.wrapFunction(
				container.preventSilentAccess,
				(target, that, args) => {
					if (that !== global.navigator.credentials)
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
				},
			);

		// --- the statics, each reading as the browser's and routing/emulating ---

		overwriteStatic(
			IdentityCredential,
			NativeIdentityCredential,
			'disconnect',
			(args) => disconnect(args[0]),
		);
		// only an iframe the IdP itself embeds may call getUserInfo; from any other
		// context the browser answers the generic network error, and emulating that
		// nested context is out of scope. Never the native path, so never a leak.
		overwriteStatic(
			IdentityProvider,
			NativeIdentityProvider,
			'getUserInfo',
			() => reject(domException('Error retrieving user info.', 'NetworkError')),
		);
		overwriteStatic(
			IdentityProvider,
			NativeIdentityProvider,
			'close',
			() => undefined,
		);
		// the IdP's own continuation page resolves a token; a normal page cannot
		overwriteStatic(IdentityProvider, NativeIdentityProvider, 'resolve', () =>
			reject(
				domException('Not allowed to provide a token.', 'NotAllowedError'),
			),
		);

		// setStatus on NavigatorLogin.prototype (navigator.login's method)
		{
			const descriptor = Reflect.getOwnPropertyDescriptor(
				NativeNavigatorLogin.prototype,
				'setStatus',
			)!;
			Reflect.defineProperty(nlPrototype, 'setStatus', {
				...descriptor,
				value: proxyModule.wrapFunction(
					descriptor.value,
					(target, that, args) => {
						// (the browser's own rejection for anything that is no
						// NavigatorLogin)
						if (!loginData.has(that)) return Reflect.apply(target, that, args);
						// the method answers with a promise, so what it refuses
						// is a rejection, never a throw (../credentialFlows.ts,
						// made at a document's first call)
						try {
							return deferred('loginStatus')(args, PagePromise, typeError);
						} catch (error) {
							return reject(error);
						}
					},
				),
			});
		}

		// each prototype lists its members where the browser's does (the
		// stand-in's `constructor` was its first key)
		proxyModule.orderLike(icPrototype, NativeIdentityCredential.prototype);
		proxyModule.orderLike(ipPrototype, NativeIdentityProvider.prototype);
		proxyModule.orderLike(nlPrototype, NativeNavigatorLogin.prototype);

		// --- navigator.login: a NavigatorLogin of this document ---

		const login = PageObject.create(nlPrototype);
		loginData.add(login);
		const navigatorPrototype = global.Navigator?.prototype;
		if (navigatorPrototype) {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				navigatorPrototype,
				'login',
			);
			if (descriptor?.get)
				Reflect.defineProperty(navigatorPrototype, 'login', {
					...descriptor,
					get: proxyModule.wrapFunction(descriptor.get, (target, that) =>
						that === global.navigator ? login : Reflect.apply(target, that, []),
					),
				});
		}

		// --- the globals take the browser's place ---

		const page = global as unknown as Record<string, unknown>;
		page.IdentityCredential = IdentityCredential;
		page.IdentityProvider = IdentityProvider;
		page.NavigatorLogin = NavigatorLogin;

		// --- WebAuthn: the browser's own authenticator never acts for a proxied page ---

		// (why, and the guard itself: ../credentialFlows.ts relyingPartyGuard,
		// made at a document's first WebAuthn call with options)
		const documentHost: string = global.location.hostname;
		const onDomain =
			documentHost !== '' &&
			!documentHost.startsWith('[') &&
			!/^\d+\.\d+\.\d+\.\d+$/.test(documentHost);
		let guard: ReturnType<DeferredParts['relyingPartyGuard']> | null = null;
		const withoutRelatedOrigins: PasskeysContext['guard'] = (
			call,
			args,
			path,
			kind,
		) =>
			!onDomain || !args.length
				? call(args)
				: (guard ??= deferred('relyingPartyGuard')({
						documentHost,
						PagePromise,
						PageDOMException,
						domException,
					}))(call, args, path, kind);
		// --- WebAuthn: STomp's own passkey provider, when the host has one ---

		// The hooks are in place before any page script, and the client is
		// evaluated at a document's first call (a deferred statement): a call never
		// reaches the browser's own WebAuthn in between. Where the site's
		// origin has no WebAuthn (not a secure context) neither has STomp.
		const NativePublicKeyCredential = global.PublicKeyCredential as
			Function | undefined;
		const nativeCreate = container.create;
		const nativeGet = container.get;
		let provider: (() => PasskeysInstalled | null) | null = null;
		if (
			client.passkeys &&
			NativePublicKeyCredential &&
			typeof nativeCreate === 'function' &&
			trustworthy(client.url.url)
		) {
			const context: PasskeysContext = {
				client,
				proxyModule,
				container: global.navigator.credentials as object,
				// the browser's own, for what is not a passkey's (a request
				// without `publicKey` reaches no authenticator), behind the guard
				guard: withoutRelatedOrigins,
				// a password or a federated sign-in alone is the site's own
				// store's (below), read from the request the provider made of
				// the page's (its own data properties: nothing the page runs)
				natives: [
					nativeCreate,
					function (this: unknown, ...args: unknown[]) {
						const asked = args[0];
						const member = (key: string) =>
							typeof asked === 'object' && asked
								? Reflect.getOwnPropertyDescriptor(asked, key)?.value
								: undefined;
						return member('identity') === undefined &&
							member('publicKey') === undefined &&
							(member('password') || member('federated') !== undefined)
							? ownStore()
							: Reflect.apply(nativeGet, this, args);
					},
				],
				PublicKeyCredential: NativePublicKeyCredential,
				realm: {
					Promise: PagePromise,
					TypeError: PageTypeError,
					DOMException: PageDOMException,
					Object: PageObject,
				} as PasskeysContext['realm'],
				signal: [
					abortedGet!,
					reasonGet!,
					global.EventTarget.prototype.addEventListener,
				],
				identity: runIdentity,
			};
			for (const name of REALM)
				(context.realm as Record<string, unknown>)[name] = global[name];
			let made: PasskeysInstalled | null | false = null;
			provider = () => {
				if (made === null)
					try {
						made = passkeysPart().passkeys(context);
					} catch (error) {
						// said once; every request then ends as one the user declined
						made = false;
						console.error(error);
					}
				return made || null;
			};
		}
		const declined = () => reject(domException(DECLINED, 'NotAllowedError'));

		if (typeof container.create === 'function')
			container.create = proxyModule.wrapFunction(
				container.create,
				(target, that, args) =>
					provider
						? (provider()?.create(that, args) ?? declined())
						: withoutRelatedOrigins(
								(called) => Reflect.apply(target, that, called),
								args,
								['publicKey', 'rp', 'id'],
								'create',
							),
			);
		// (one call for every static, which reads which one it is from the
		// native it wraps)
		const keyStatic = (target: Function, that: unknown, args: unknown[]) =>
			provider
				? (provider()?.statics(target.name, target, args) ?? declined())
				: withoutRelatedOrigins(
						(called) => Reflect.apply(target, that, called),
						args,
						['rpId'],
						'signal',
					);
		if (NativePublicKeyCredential)
			for (const name of [
				'signalUnknownCredential',
				'signalAllAcceptedCredentials',
				'signalCurrentUserDetails',
				// the authenticator a page asks about is STomp's
				...(provider
					? [
							'isUserVerifyingPlatformAuthenticatorAvailable',
							'isConditionalMediationAvailable',
							'getClientCapabilities',
						]
					: []),
			]) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					NativePublicKeyCredential,
					name,
				);
				if (typeof descriptor?.value !== 'function') continue;
				Reflect.defineProperty(NativePublicKeyCredential, name, {
					...descriptor,
					value: proxyModule.wrapFunction(
						descriptor.value as Function,
						keyStatic,
					),
				});
			}

		// --- the hook: FedCM for an identity request, the browser's get otherwise ---

		const browserGet = (target: Function, that: unknown, args: unknown[]) =>
			withoutRelatedOrigins(
				(called) => Reflect.apply(target, that, called),
				args,
				['publicKey', 'rpId'],
				'get',
			);
		// --- passwords and federated sign-ins: of the site's own store ---

		// The browser keeps them under the origin it sees, the proxy's, for
		// every proxied site alike, and answers only its own top-level
		// document: a proxied top, a frame to it, got the frames' error, and
		// a page that reached the store would read and write every site's.
		// Until STomp keeps a store of each site's own, a top finds none (null,
		// as a site with nothing saved) and keeps nothing; a frame gets
		// Chrome's errors, NotAllowedError when it is not same-origin with all
		// of its ancestors, else NotSupportedError (../credentialStore.ts)
		const ownStore = (): Promise<unknown> => {
			const refusal = deferred('ownStoreRefusal')(
				client.ancestorOrigins(),
				client.origin,
			);
			return refusal
				? reject(domException(...refusal))
				: Reflect.apply(PagePromise.resolve, PagePromise, [null]);
		};
		if (typeof container.store === 'function')
			container.store = proxyModule.wrapFunction(
				container.store,
				(target, that, args) => {
					const tag = Object.prototype.toString.call(args[0]);
					return tag === '[object PasswordCredential]' ||
						tag === '[object FederatedCredential]'
						? ownStore().then(() => undefined)
						: Reflect.apply(target, that, args);
				},
			);

		container.get = proxyModule.wrapFunction(
			container.get,
			(target, that, args) => {
				if (provider) return provider()?.get(that, args) ?? declined();
				const options = args[0];
				if (
					options === null ||
					(typeof options !== 'object' && typeof options !== 'function')
				)
					return browserGet(target, that, args);
				// the members are read once and pinned: a getter cannot hand the
				// browser a request this never saw. A password or a federated
				// sign-in alone is the site's own store's (above); a passkey
				// asked for with one is the passkey's alone
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
				const own =
					identity === undefined && (!!password || federated !== undefined);
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
			},
		);
	}
}
