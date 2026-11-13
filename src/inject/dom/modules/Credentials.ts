import { routeXHR } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { scopePrefix } from '../../modules/Unroute';
import { withStack } from '../../nativeErrors';
import type DocumentClient from '../Client';
import { loadFetch } from '../loadGrants';

const GET_PREFIX = "Failed to execute 'get' on 'CredentialsContainer': ";
const IDENTITY_READ_PREFIX = `${GET_PREFIX}Failed to read the 'identity' property from 'CredentialRequestOptions': `;
const PROVIDERS_READ_PREFIX = `${IDENTITY_READ_PREFIX}Failed to read the 'providers' property from 'IdentityCredentialRequestOptions': `;

/** Chrome's generic FedCM failure, given for a dismissed chooser and most faults */
const GENERIC_TOKEN_ERROR = 'Error retrieving a token.';

interface CredentialData {
	token: string;
	isAutoSelected: boolean;
	configURL: string;
	id: string;
	type: string;
}

interface IdpAccount {
	id: string;
	name?: string;
	email?: string;
	given_name?: string;
	picture?: string;
	approved_clients?: string[];
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
 * webidentity (src/server/rewrites.ts). The account chooser the browser draws
 * as trusted chrome is, here, an in-page DOM overlay - the one compromise,
 * documented in FINDINGS: a hostile page can observe our overlay where it never
 * could the browser's. It is drawn in a shadow root, and the account list stays
 * in this module's scope, so the page reaches it only by scraping the overlay.
 *
 * IdentityCredentialError is left as the browser's own: it is constructible,
 * reads no network and so cannot leak, and reads natively already.
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

		// --- the routed fetch every FedCM step goes through ---

		const routeOf = (absolute: string): string =>
			new URL(routeXHR(new StompURL(absolute, client.url)), scopePrefix(client))
				.href;
		// a GET of an IdP endpoint, its JSON or null for any fault; `credentials`
		// is the step's (config and client metadata omit the IdP's cookies,
		// accounts include them). The load's `webidentity` destination makes the
		// server send Sec-Fetch-Dest: webidentity (src/server/rewrites.ts).
		const idpGet = async (
			absolute: string,
			credentials: RequestCredentials,
		): Promise<any | null> => {
			try {
				const response = await loadFetch(
					client,
					routeOf(absolute),
					'webidentity cors',
					{
						method: 'GET',
						credentials,
						headers: { accept: 'application/json' },
					},
				);
				if (!response.ok) return null;
				return JSON.parse(await response.text());
			} catch (error) {
				return null;
			}
		};
		// the credentialed POST of the id assertion (token) or disconnect endpoint
		const idpPost = async (
			absolute: string,
			body: Record<string, string>,
		): Promise<any | null> => {
			try {
				const response = await loadFetch(
					client,
					routeOf(absolute),
					'webidentity cors',
					{
						method: 'POST',
						credentials: 'include',
						headers: {
							accept: 'application/json',
							'content-type': 'application/x-www-form-urlencoded',
						},
						body: new URLSearchParams(body).toString(),
					},
				);
				if (!response.ok) return null;
				return JSON.parse(await response.text());
			} catch (error) {
				return null;
			}
		};

		// --- the stand-in interfaces, reading as the browser's ---

		const credentialData = new WeakMap<object, CredentialData>();
		const loginData = new WeakSet<object>();

		// a getter of a native prototype, wrapped so it reads as the browser's
		// (name, length, [native code]) and returns this document's own data for
		// an object it made, or throws the browser's Illegal invocation
		const wrappedGetter = (
			nativePrototype: object,
			key: string,
			table: WeakMap<object, any>,
		): PropertyDescriptor => {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				nativePrototype,
				key,
			)!;
			return {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get!, (target, that) => {
					const data = table.get(that);
					if (!data) return Reflect.apply(target, that, []);
					return data[key];
				}),
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
		// configURL (and the Credential base's id and type) from the credential
		// this document resolved; the browser constructs it (illegal). Its chain
		// is IdentityCredential.prototype -> Credential.prototype -> Object.
		const icPrototype = PageObject.create(NativeCredential.prototype);
		for (const [key, base] of [
			['token', NativeIdentityCredential.prototype],
			['isAutoSelected', NativeIdentityCredential.prototype],
			['configURL', NativeIdentityCredential.prototype],
			['id', NativeCredential.prototype],
			['type', NativeCredential.prototype],
		] as const)
			Reflect.defineProperty(
				icPrototype,
				key,
				wrappedGetter(base, key, credentialData),
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

		// --- IdentityCredential.disconnect: config, then the disconnect POST ---

		const disconnect = (options: unknown): Promise<undefined> => {
			const fail = () =>
				domException('Error disconnecting account.', 'NetworkError');
			return new PagePromise<undefined>((resolvePage, rejectPage) => {
				void (async () => {
					if (options === null || typeof options !== 'object') throw fail();
					const { configURL, clientId, accountHint } = options as Record<
						string,
						unknown
					>;
					if (
						typeof configURL !== 'string' ||
						typeof clientId !== 'string' ||
						typeof accountHint !== 'string'
					)
						throw fail();
					let configAbsolute: string;
					try {
						configAbsolute = new URL(configURL).href;
					} catch (error) {
						throw fail();
					}
					const config = await idpGet(configAbsolute, 'omit');
					if (typeof config?.disconnect_endpoint !== 'string') throw fail();
					const answer = await idpPost(
						new URL(config.disconnect_endpoint, configAbsolute).href,
						{ client_id: clientId, account_hint: accountHint },
					);
					if (answer === null) throw fail();
					return undefined;
				})().then(resolvePage, rejectPage);
			});
		};

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
						if (!loginData.has(that)) throw typeError('Illegal invocation');
						const status = String(args[0]);
						if (status !== 'logged-in' && status !== 'logged-out')
							throw typeError(
								`Failed to execute 'setStatus' on 'NavigatorLogin': The provided value '${status}' is not a valid enum value of type LoginStatus.`,
							);
						loginStatus = status;
						return Reflect.apply(PagePromise.resolve, PagePromise, [undefined]);
					},
				),
			});
		}

		// --- navigator.login: a NavigatorLogin of this document ---

		const login = PageObject.create(nlPrototype);
		loginData.add(login);
		/** this origin's declared login status (navigator.login.setStatus) */
		let loginStatus: 'logged-in' | 'logged-out' | null = null;
		void loginStatus;
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

		// --- the account chooser: an in-page overlay (the documented compromise) ---

		// resolves the chosen account, or null for a dismiss. Drawn in a shadow
		// root so the page's CSS and markup reach it as little as possible; open,
		// so the suites can drive it, which a page could use to read it too.
		const chooseAccount = (
			accounts: IdpAccount[],
		): Promise<IdpAccount | null> =>
			new Promise((resolveChoice) => {
				const doc = global.document;
				const host = doc.createElement('div');
				host.style.cssText =
					'position:fixed;inset:0;z-index:2147483647;pointer-events:auto';
				const root = host.attachShadow({ mode: 'open' });
				const settle = (account: IdpAccount | null) => {
					try {
						host.remove();
					} catch (error) {
						// already gone
					}
					resolveChoice(account);
				};
				const style = doc.createElement('style');
				style.textContent =
					'.b{position:fixed;inset:0;background:rgba(0,0,0,.3);display:flex;align-items:flex-start;justify-content:center}' +
					'.c{margin-top:16px;min-width:340px;max-width:90vw;background:#fff;color:#202124;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.3);font:14px system-ui,sans-serif;overflow:hidden}' +
					'.h{padding:14px 20px;border-bottom:1px solid #e0e0e0;font-weight:500}' +
					'.a{display:flex;flex-direction:column;align-items:flex-start;padding:12px 20px;width:100%;border:0;background:none;text-align:left;cursor:pointer;font:inherit}' +
					'.a:hover{background:#f1f3f4}.n{font-weight:500}.e{color:#5f6368;font-size:13px}' +
					'.f{padding:12px 20px;border-top:1px solid #e0e0e0;text-align:right}' +
					'.x{border:0;background:none;color:#1a73e8;cursor:pointer;font:inherit;padding:8px}';
				root.append(style);
				const backdrop = doc.createElement('div');
				backdrop.className = 'b';
				const card = doc.createElement('div');
				card.className = 'c';
				const header = doc.createElement('div');
				header.className = 'h';
				header.textContent = 'Sign in';
				card.append(header);
				for (const account of accounts) {
					const button = doc.createElement('button');
					button.className = 'a';
					button.type = 'button';
					const name = doc.createElement('div');
					name.className = 'n';
					name.textContent = account.name ?? account.email ?? account.id;
					const email = doc.createElement('div');
					email.className = 'e';
					email.textContent = account.email ?? '';
					button.append(name, email);
					button.addEventListener('click', () => settle(account));
					card.append(button);
				}
				const footer = doc.createElement('div');
				footer.className = 'f';
				const cancel = doc.createElement('button');
				cancel.className = 'x';
				cancel.type = 'button';
				cancel.textContent = 'Cancel';
				cancel.setAttribute('aria-label', 'Close');
				cancel.addEventListener('click', () => settle(null));
				footer.append(cancel);
				card.append(footer);
				backdrop.addEventListener('click', (event) => {
					if (event.target === backdrop) settle(null);
				});
				backdrop.append(card);
				root.append(backdrop);
				(doc.body ?? doc.documentElement).append(host);
			});

		// --- the FedCM protocol for one provider ---

		const DISMISSED = Symbol();

		const metadataRoute = async (
			config: any,
			configAbsolute: string,
			clientId: string,
		): Promise<void> => {
			// fetched for the UI's privacy-policy / terms links; its result is not
			// needed to mint a token, but the step is part of the flow and routes
			if (typeof config.client_metadata_endpoint !== 'string') return;
			const url = new URL(config.client_metadata_endpoint, configAbsolute);
			url.searchParams.set('client_id', clientId);
			await idpGet(url.href, 'omit');
		};

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

		// one provider through the protocol; the resolved credential, null for a
		// fault to try the next provider on, or DISMISSED for a user dismiss
		const attempt = async (
			provider: any,
			mediation: unknown,
		): Promise<object | null | typeof DISMISSED> => {
			const configAbsolute = new URL(provider.configURL).href;
			const config = await idpGet(configAbsolute, 'omit');
			if (
				!config ||
				typeof config.accounts_endpoint !== 'string' ||
				typeof config.id_assertion_endpoint !== 'string'
			)
				return null;
			const list = await idpGet(
				new URL(config.accounts_endpoint, configAbsolute).href,
				'include',
			);
			const accounts: IdpAccount[] = Array.isArray(list?.accounts)
				? list.accounts
				: [];
			if (accounts.length === 0) return null;

			const clientId: string = provider.clientId;
			const approved = (account: IdpAccount) =>
				Array.isArray(account.approved_clients) &&
				account.approved_clients.includes(clientId);
			// auto re-authentication: one returning account, not forced to choose
			const autoEligible =
				mediation !== 'required' &&
				accounts.length === 1 &&
				approved(accounts[0]);

			let chosen: IdpAccount;
			let isAutoSelected: boolean;
			if (autoEligible) {
				chosen = accounts[0];
				isAutoSelected = true;
			} else if (mediation === 'silent') {
				// silent mediation may not draw a chooser
				return null;
			} else {
				await metadataRoute(config, configAbsolute, clientId);
				const picked = await chooseAccount(accounts);
				if (picked === null) return DISMISSED;
				chosen = picked;
				isAutoSelected = false;
			}

			const answer = await idpPost(
				new URL(config.id_assertion_endpoint, configAbsolute).href,
				{
					client_id: clientId,
					nonce: typeof provider.nonce === 'string' ? provider.nonce : '',
					account_id: chosen.id,
					disclosure_text_shown: String(!approved(chosen)),
					is_auto_selected: String(isAutoSelected),
				},
			);
			if (answer && typeof answer.token === 'string')
				return makeCredential(answer.token, isAutoSelected, configAbsolute);
			if (answer && answer.error && NativeIdentityCredentialError) {
				const { code, url } = answer.error;
				throw withStack(
					new NativeIdentityCredentialError(GENERIC_TOKEN_ERROR, {
						error: typeof code === 'string' ? code : '',
						url: typeof url === 'string' ? url : '',
					}),
				);
			}
			return null;
		};

		/** the error Chrome rejects with for a malformed identity request, or null */
		const validateIdentity = (identity: unknown): object | null => {
			if (
				identity === null ||
				(typeof identity !== 'object' && typeof identity !== 'function')
			)
				return typeError(
					`${IDENTITY_READ_PREFIX}The provided value is not of type 'IdentityCredentialRequestOptions'.`,
				);
			let providers: unknown;
			try {
				providers = (identity as { providers: unknown }).providers;
			} catch (error) {
				return error as object;
			}
			if (providers === undefined)
				return typeError(
					`${PROVIDERS_READ_PREFIX}Required member is undefined.`,
				);
			let list: any[];
			try {
				list = Array.from(providers as Iterable<any>);
			} catch (error) {
				return error as object;
			}
			// IDL converts every provider before the algorithm runs: a missing
			// configURL is read as a required member
			for (const provider of list)
				if (
					provider === null ||
					typeof provider !== 'object' ||
					provider.configURL === undefined
				)
					return typeError(
						`${PROVIDERS_READ_PREFIX}Failed to read the 'configURL' property from 'IdentityProviderConfig': Required member is undefined.`,
					);
			if (list.length === 0)
				return typeError(`${GET_PREFIX}Need at least one identity provider.`);
			for (let i = 0; i < list.length; i++) {
				if (list[i].clientId === undefined)
					return typeError(`${GET_PREFIX}Missing the provider's clientId.`);
				try {
					// configURL must be an absolute URL; a relative one is incomplete
					new URL(list[i].configURL);
				} catch (error) {
					return domException(
						`Provider ${i + 1} information is incomplete.`,
						'InvalidStateError',
					);
				}
			}
			return null;
		};

		// the FedCM flow, returning a page-realm promise. Validation rejects with
		// Chrome's own messages (measured); then the protocol runs provider by
		// provider, resolving the first credential or rejecting the generic error.
		const runIdentity = (
			identity: unknown,
			signal: unknown,
			mediation: unknown,
		): Promise<object> =>
			new PagePromise<object>((resolvePage, rejectPage) => {
				const invalid = validateIdentity(identity);
				if (invalid) return rejectPage(invalid);
				const abort = abortReason(signal);
				if (abort !== undefined) return rejectPage(abort);
				const providers = (identity as { providers: any[] }).providers;
				void (async () => {
					for (const provider of providers) {
						const credential = await attempt(provider, mediation);
						if (credential === DISMISSED)
							return rejectPage(
								domException(GENERIC_TOKEN_ERROR, 'NetworkError'),
							);
						if (credential) return resolvePage(credential);
					}
					return rejectPage(domException(GENERIC_TOKEN_ERROR, 'NetworkError'));
				})().catch((error) => rejectPage(error));
			});

		// --- the hook: FedCM for an identity request, the browser's get otherwise ---

		container.get = proxyModule.wrapFunction(
			container.get,
			(target, that, args) => {
				const options = args[0];
				if (
					options === null ||
					(typeof options !== 'object' && typeof options !== 'function')
				)
					return Reflect.apply(target, that, args);
				let identity: unknown;
				try {
					identity = options.identity;
				} catch (error) {
					return reject(error);
				}
				// the member is read once and pinned: a getter cannot hand the
				// browser an identity request this never saw. No identity: the
				// browser's own get (password, federated, NotSupportedError).
				if (identity === undefined)
					return Reflect.apply(target, that, [
						{ __proto__: options, identity: undefined },
						...args.slice(1),
					]);
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
