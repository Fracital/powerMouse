// The Credentials module's flows (modules/Credentials.ts) that only a call
// runs: FedCM's protocol with its account chooser, and the guard of the
// browser's own WebAuthn calls. Deferred parts (./deferredParts.ts), made at
// a document's first identity request, disconnect or WebAuthn call: most
// documents make none. The module hands them what it took when it applied,
// before any page script ran, and their own top level reads no global.
import { routeXHR } from '../../routeURL';
import StompURL from '../../StompURL';
import { scopePrefix } from '../modules/Unroute';
import { withStack } from '../nativeErrors';
import type DocumentClient from './Client';
import { loadFetch } from './loadGrants';
import { DECLINED } from './modules/Credentials';

const GET_PREFIX = "Failed to execute 'get' on 'CredentialsContainer': ";
const IDENTITY_READ_PREFIX = `${GET_PREFIX}Failed to read the 'identity' property from 'CredentialRequestOptions': `;
const PROVIDERS_READ_PREFIX = `${IDENTITY_READ_PREFIX}Failed to read the 'providers' property from 'IdentityCredentialRequestOptions': `;

/** Chrome's generic FedCM failure, given for a dismissed chooser and most faults */
const GENERIC_TOKEN_ERROR = 'Error retrieving a token.';

interface IdpAccount {
	id: string;
	name?: string;
	email?: string;
	given_name?: string;
	picture?: string;
	approved_clients?: string[];
}

/** what the Credentials module hands the FedCM flow */
export interface IdentityContext {
	client: DocumentClient;
	/** the document's Promise */
	PagePromise: PromiseConstructor;
	domException: (message: string, name: string) => DOMException;
	typeError: (message: string) => TypeError;
	/** an AbortSignal's reason when it is aborted, else undefined */
	abortReason: (signal: unknown) => unknown;
	/** an IdentityCredential of the document's for a resolved token */
	makeCredential: (
		token: string,
		isAutoSelected: boolean,
		configURL: string,
	) => object;
	/** the browser's own IdentityCredentialError, where it has one */
	IdentityCredentialError:
		(new (message?: string, options?: object) => object) | undefined;
}

/**
 * FedCM for one document (see modules/Credentials.ts): the get() of an
 * identity request and IdentityCredential.disconnect, each answering with a
 * promise of the page's
 */
export function identityFlow({
	client,
	PagePromise,
	domException,
	typeError,
	abortReason,
	makeCredential,
	IdentityCredentialError: NativeIdentityCredentialError,
}: IdentityContext) {
	const global = client.global as unknown as typeof globalThis &
		Record<string, any>;

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

	// --- the account chooser: an in-page overlay (the documented compromise) ---

	// resolves the chosen account, or null for a dismiss. Drawn in a shadow
	// root so the page's CSS and markup reach it as little as possible; open,
	// so the suites can drive it, which a page could use to read it too.
	const chooseAccount = (accounts: IdpAccount[]): Promise<IdpAccount | null> =>
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

	// (an object of the bundle's: no global the page could have replaced)
	const DISMISSED = {};

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
			return typeError(`${PROVIDERS_READ_PREFIX}Required member is undefined.`);
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

	return { runIdentity, disconnect };
}

/** what the Credentials module hands the guard of the browser's WebAuthn calls */
export interface GuardContext {
	/** the document's host, a domain (a document on an address needs no guard) */
	documentHost: string;
	PagePromise: PromiseConstructor;
	PageDOMException: typeof DOMException;
	domException: (message: string, name: string) => DOMException;
}

/**
 * The guard of the browser's own WebAuthn calls for one document on a
 * domain (see modules/Credentials.ts): a call with its relying party id kept
 * from the network and from the browser's own authenticator
 */
export function relyingPartyGuard({
	documentHost,
	PagePromise,
	PageDOMException,
	domException,
}: GuardContext) {
	// WebAuthn cannot work through an origin-rewriting proxy: the browser
	// checks a request's relying party id against the proxy's one real
	// origin and would sign that origin, which every proxied site shares,
	// into the credential. STomp does not stand in as an authenticator
	// either (docs/passkeys.md, "Threat model": a page that escaped the
	// inject could then get an assertion for any site, and nothing in the
	// single proxy origin can stop it). So no proxied page may create, list
	// or assert a credential on that origin, by two routes handled here.
	//
	// A relying party id that is neither the document's host nor a suffix
	// of it makes Chrome fetch https://<id>/.well-known/webauthn from its
	// own process (WebAuthn's related origins, 5.11.1), with nothing of the
	// proxy in the way: on a proxy origin that is a domain, any proxied page
	// could make the browser reach any host directly, and a site's own id,
	// the usual case, reaches the real site from the user's own address.
	// No such file lists the proxy's origin, so the answer is known without
	// asking: the browser is handed an id it refuses without a fetch (the
	// empty one), after every check of its own, and its refusal is given the
	// words of a file that could not be fetched. A document on an address
	// is refused before any fetch (an address is no relying party).
	//
	// A relying party id the browser would accept (its own host or a
	// suffix) is the one that reaches the browser's real authenticator and
	// makes or asserts a credential on the shared proxy origin. It is handed
	// the browser empty the same way, which it refuses before any
	// authenticator, and the refusal is reshaped into the native decline (a
	// create or get) or the native no-op (a signal): see validRpId below.

	/** an id Chrome would ask the network about for this document */
	const asksNetwork = (id: string): boolean => {
		if (
			id === documentHost ||
			// a suffix of the host (a public suffix too: one the proxy's own
			// name has, never a page's choice; a lone label is a top-level
			// domain, which Chrome asks about)
			(id.includes('.') && documentHost.endsWith(`.${id}`))
		)
			return false;
		try {
			// a name of a host alone: an address with a port, a URL or a
			// name with a space is refused without a fetch
			return new URL(`https://${id}/`).host === id.toLowerCase();
		} catch (error) {
			return false;
		}
	};
	const RP_REFUSED =
		'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.';
	const RP_UNFETCHED = `${RP_REFUSED} Subsequently, an attempt to fetch the .well-known/webauthn resource of the claimed RP ID failed.`;
	/**
	 * A relying party id the browser would accept for this document: its
	 * own host or a registrable suffix of it. These, and only these, make
	 * the browser's own authenticator create or assert a credential, and
	 * that credential is scoped to the proxy's one real origin, which every
	 * proxied site shares. STomp does not hold passkeys (docs/passkeys.md),
	 * so no proxied page may make or use one on that origin: the id is
	 * handed the browser empty (below), which it refuses before reaching any
	 * authenticator, and the refusal is reshaped into the native decline.
	 */
	const validRpId = (id: string): boolean => {
		const low = id.toLowerCase();
		if (low === documentHost) return true;
		return low.includes('.') && documentHost.endsWith(`.${low}`);
	};
	/**
	 * `value` with the member at `path` read through `pin`: the page's
	 * object, read where and when the browser reads it, once
	 */
	const through = (
		value: unknown,
		path: string[],
		pin: (member: unknown) => unknown,
	): unknown => {
		if (
			!path.length ||
			value === null ||
			(typeof value !== 'object' && typeof value !== 'function')
		)
			return path.length ? value : pin(value);
		const [key, ...rest] = path;
		return new Proxy(value as object, {
			get: (target, name) => {
				const member: unknown = Reflect.get(target, name, target);
				return name === key ? through(member, rest, pin) : member;
			},
		});
	};
	/**
	 * The browser's own WebAuthn call `call`, with the relying party id at
	 * `path` of its options kept from asking the network, and kept from
	 * reaching the browser's own authenticator when it is one the proxy
	 * origin shares (validRpId). `kind` is which call it is: a create or a
	 * get that is refused ends as the native decline, a signal ends as the
	 * native no-op. An omitted id defaults to the document's own domain for
	 * a create or a get (a valid, shared id), but a signal requires one.
	 */
	const withoutRelatedOrigins = (
		call: (args: unknown[]) => unknown,
		args: unknown[],
		path: string[],
		kind: 'create' | 'get' | 'signal',
	): unknown => {
		const defaultValid = kind !== 'signal';
		let keptNetwork = false;
		let keptValid = false;
		const pin = (id: unknown) => {
			if (typeof id === 'symbol') return id;
			// an omitted id: create and get default it to the document's own
			// domain, which the proxy origin shares; a signal requires one
			if (id === undefined) {
				if (!defaultValid) return id;
				keptValid = true;
				return '';
			}
			// converted here, once, as the browser would (a toString is the page's)
			const text = String(id);
			if (validRpId(text)) {
				keptValid = true;
				return '';
			}
			if (asksNetwork(text)) {
				keptNetwork = true;
				return '';
			}
			return text;
		};
		const result = call([through(args[0], path, pin), ...args.slice(1)]);
		// (the browser reads the options during the call)
		if ((!keptValid && !keptNetwork) || !(result instanceof PagePromise))
			return result;
		return Reflect.apply(PagePromise.prototype.then, result, [
			undefined,
			(error: unknown) => {
				const refused =
					error instanceof PageDOMException &&
					error.name === 'SecurityError' &&
					error.message === RP_REFUSED;
				if (refused && keptValid)
					// never a credential on the shared proxy origin: a create or
					// get ends as one the user declined, a signal as the no-op it
					// is natively (it changes nothing, since STomp holds nothing)
					return kind === 'signal'
						? undefined
						: (() => {
								throw domException(DECLINED, 'NotAllowedError');
							})();
				if (refused && keptNetwork)
					throw domException(RP_UNFETCHED, 'SecurityError');
				throw error;
			},
		]) as unknown;
	};
	return withoutRelatedOrigins;
}
