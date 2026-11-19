// The Credentials module's flows (modules/Credentials.ts) that only a call
// runs: FedCM's protocol with its account chooser, navigator.login's
// setStatus(), and the guard of the browser's own WebAuthn calls. Deferred parts (./deferredParts.ts), made at
// a document's first identity request, disconnect or WebAuthn call: most
// documents make none. The module hands them what it took when it applied,
// before any page script ran, and their own top level reads no global.
import { registrableDomain, siteOf } from '../../partition';
import { routeXHR } from '../../routeURL';
import StompURL from '../../StompURL';
import {
	IDENTITY_CLOSED,
	IDENTITY_GONE,
	LOAD_HEADER,
	OPAQUE_HEADER,
	PERMISSION,
	type IdentityChooserAccount,
	type PermissionOp,
} from '../../transport/messages';
import { closePort, onPort, privateChannel } from '../../transport/ports';
import { requiredArgumentsMessage } from '../modules/Proxy';
import { scopePrefix } from '../modules/Unroute';
import { later, now, random } from '../modules/WebTransport';
import { withStack } from '../nativeErrors';
import { getPublicSuffix } from '../rewriter';
import type DocumentClient from './Client';
import { loadFetch, loadSource } from './loadGrants';
import { DECLINED } from './modules/Credentials';

const GET_PREFIX = "Failed to execute 'get' on 'CredentialsContainer': ";
const IDENTITY_READ_PREFIX = `${GET_PREFIX}Failed to read the 'identity' property from 'CredentialRequestOptions': `;
const PROVIDERS_READ_PREFIX = `${IDENTITY_READ_PREFIX}Failed to read the 'providers' property from 'IdentityCredentialRequestOptions': `;

/** Chrome's generic FedCM failure, given for a dismissed chooser and most faults */
const GENERIC_TOKEN_ERROR = 'Error retrieving a token.';

/** an account of a provider's list, as the flow keeps it (no prototype) */
interface Account {
	id: string;
	name: string | undefined;
	email: string | undefined;
	/** its approved_clients name the relying party, or the browser signed in with it before */
	returning: boolean;
	/** where Chrome lists it: by its latest sign-in, then as the provider listed it */
	rank: number;
}

/** what the browser keeps of the site's sign-ins with a provider (IdentityState, no prototype) */
interface State {
	accounts: string[];
	quiet: boolean;
	cooldown: boolean;
	testing: boolean;
}

/**
 * navigator.login.setStatus() of a document's NavigatorLogin (`args` the
 * page's): a promise of the page's, rejected with Chrome's TypeError for no
 * status or one that is no LoginStatus. The status declares nothing STomp
 * reads.
 */
export function loginStatus(
	args: unknown[],
	PagePromise: PromiseConstructor,
	typeError: (message: string) => TypeError,
): Promise<unknown> {
	const reject = (message: string) =>
		Reflect.apply(PagePromise.reject, PagePromise, [typeError(message)]);
	if (!args.length)
		return reject(
			requiredArgumentsMessage(0, 1, 'NavigatorLogin', 'setStatus'),
		);
	const status = String(args[0]);
	if (status !== 'logged-in' && status !== 'logged-out')
		return reject(
			`Failed to execute 'setStatus' on 'NavigatorLogin': The provided value '${status}' is not a valid enum value of type LoginStatus.`,
		);
	return Reflect.apply(PagePromise.resolve, PagePromise, [undefined]);
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
	/** JSON.parse and Array.isArray, taken before any of the page's script ran */
	parse: (text: string) => unknown;
	isArray: (value: unknown) => boolean;
}

/** how long a read waits for its body once its request was answered */
const READ_GRACE_MS = 2_000;

/** how long Chrome holds a token after its request went out (measured: 3 s) */
const TOKEN_HOLD_MS = 3_000;
/** a rank after every account signed in with before (Account.rank) */
const UNRANKED = 1 << 20;

/**
 * How long Chrome holds a failure that came before its UI (a silent
 * request with no account to sign in, a config refused, a site in its
 * cooldown): random, measured over 73 failures in Chrome 157 as log-normal
 * in seconds (mu 1.72, sigma 1.28, so a median of 5.6 s) and never past
 * 60 s.
 * Chrome's own UI calls nothing of the page's, and a page that replaced
 * Math's members would see each call (and choose the delay: a NaN is none
 * at all), so nothing of the realm's Math is read: `random` is the
 * browser's, taken before any page script ran, the normal is the sum of
 * twelve uniforms less six, and e is a literal raised by `**`.
 */
const rejectionDelay = (): number => {
	let normal = -6;
	for (let i = 0; i < 12; i++) normal += random();
	const delay = 1000 * 2.718281828459045 ** (1.72 + 1.28 * normal);
	return delay < 60_000 ? delay : 60_000;
};

/** `value` at `index` of `list`, defined: a setter of an index the page put on Array.prototype is never handed it */
const put = (list: unknown[], index: number, value: unknown) =>
	Reflect.defineProperty(list, index, {
		__proto__: null,
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	} as PropertyDescriptor);

/**
 * An own data property of a parsed JSON value. Its prototypes are the
 * page's: a getter the page put there would be handed the object (an
 * account list, for one), so nothing else of it is ever read
 */
const own = (value: unknown, key: PropertyKey): unknown => {
	if (value === null || typeof value !== 'object') return undefined;
	const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
	return descriptor ? descriptor.value : undefined;
};
const ownString = (value: unknown, key: string): string | undefined => {
	const member = own(value, key);
	return typeof member === 'string' ? member : undefined;
};

/** an endpoint of a FedCM config, absolute, or null when it is none */
const endpointOf = (value: unknown, base: string): string | null => {
	if (typeof value !== 'string') return null;
	try {
		return new URL(value, base).href;
	} catch (error) {
		return null;
	}
};
const originOf = (url: string): string => new URL(url).origin;

/**
 * FedCM for one document (see modules/Credentials.ts): the get() of an
 * identity request and IdentityCredential.disconnect, each answering with a
 * promise of the page's.
 *
 * The steps go as Chrome 157's own requests do (measured, the fedcm suite):
 * the well-known file, the config and the accounts list no-cors, with no
 * Origin, no Referer and no CORS check (the browser reads them in its own
 * process: an identity provider sends no Access-Control-Allow-Origin for
 * them, Google's does not), the well-known file and config also without
 * credentials and as from an opaque origin (Sec-Fetch-Site: cross-site);
 * the client metadata only when the list has a new account, the same way
 * but with the relying party's Origin; the token and disconnect POSTs as
 * CORS requests of the relying party's origin, which the provider must
 * allow. Whether the user is asked at all goes by the mediation and what
 * the browser keeps of the site's sign-ins (src/server/identityStates.ts),
 * and the chooser is the host's page's, never the document's
 * (src/controller/accountChooser.ts).
 * The worker reads the no-cors steps' bodies and posts them on this
 * document's load channel (IDENTITY_READ): what a provider tells the
 * browser alone (the user's accounts) is never in a Response, a promise or
 * a function of the page's, and the page sees only what Chrome shows it.
 */
export function identityFlow({
	client,
	PagePromise,
	domException,
	typeError,
	abortReason,
	makeCredential,
	IdentityCredentialError: NativeIdentityCredentialError,
	parse,
	isArray,
}: IdentityContext) {
	const rpSite = siteOf(client.url.url, getPublicSuffix);
	const siteOfURL = (url: string) => siteOf(new URL(url), getPublicSuffix);

	// --- the routed requests every FedCM step goes through ---

	const routeOf = (absolute: string): string =>
		new URL(routeXHR(new StompURL(absolute, client.url)), scopePrefix(client))
			.href;

	/**
	 * A no-cors step's body, as the worker read it, handed to `heard` (the
	 * promise resolves with nothing: page code that reaches it, through a
	 * getter of its prototype's `constructor`, learns nothing).
	 * `credentials` is the step's (the accounts list includes the
	 * provider's cookies, the rest omit them); `opaque` sends it as from an
	 * opaque origin, as the browser sends the well-known file and config
	 * (`rp`: with the relying party's Origin all the same, as the client
	 * metadata).
	 * The load's `webidentity` destination makes the worker send
	 * Sec-Fetch-Dest: webidentity (src/server/rewrites.ts).
	 */
	const idpRead = (
		absolute: string,
		credentials: RequestCredentials,
		opaque: boolean | 'rp',
		heard: (status: number, body: string | null) => void,
	): Promise<void> =>
		new PagePromise<void>((done) => {
			const from = loadSource();
			const routed = routeOf(absolute);
			const token = from ? from.announce(routed, 'webidentity no-cors') : null;
			if (!from || token === null) return done(undefined);
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				from.expect(token, null);
				done(undefined);
			};
			from.expect(token, (status, body) => {
				if (settled) return;
				heard(status, body);
				finish();
			});
			// (records of no prototype: the browser reads every member of an
			// init, and a getter of the page's would be handed this one)
			const headers = {
				__proto__: null,
				accept: 'application/json',
				[LOAD_HEADER]: token,
				...(opaque ? { [OPAQUE_HEADER]: opaque === 'rp' ? 'rp' : '1' } : {}),
			} as unknown as Record<string, string>;
			try {
				// (its answer has no body: the body comes on the channel, which
				// may trail it a little)
				const answered = from.client.nativeFetch(routed, {
					__proto__: null,
					method: 'GET',
					credentials,
					headers,
					referrer: '',
				} as RequestInit);
				// (the browser's setTimeout: a page's own would see the call)
				Reflect.apply(PagePromise.prototype.then, answered, [
					() => later(finish, READ_GRACE_MS),
					finish,
				]);
			} catch (error) {
				finish();
			}
		});
	/** a no-cors step's JSON, handed to `use` unless it is a fault (a 2xx only) */
	const idpJSON = (
		absolute: string,
		credentials: RequestCredentials,
		opaque: boolean | 'rp',
		use: (json: unknown) => void,
	): Promise<void> =>
		idpRead(absolute, credentials, opaque, (status, body) => {
			if (status < 200 || status > 299 || body === null) return;
			try {
				use(parse(body));
			} catch (error) {
				// not JSON: a fault
			}
		});

	// the credentialed CORS POST of the id assertion (token) or disconnect
	// endpoint: its status and JSON (null when it is none), or null for a
	// network error (a provider that does not allow the relying party)
	const idpPost = async (
		absolute: string,
		body: Record<string, string>,
	): Promise<{ status: number; json: unknown } | null> => {
		// (what it sends and answers is the relying party's to know: the
		// provider allows it the answer, and the token is the page's)
		let response: Response;
		try {
			response = await loadFetch(
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
					referrer: '',
				},
			);
		} catch (error) {
			return null;
		}
		let json: unknown = null;
		try {
			json = parse(await response.text());
		} catch (error) {
			// no JSON
		}
		return { __proto__: null, status: response.status, json } as {
			status: number;
			json: unknown;
		};
	};

	/**
	 * Whether the well-known file `file` of the provider of `configAbsolute`
	 * lists it, as Chrome requires of a provider of another site than the
	 * relying party's (one of the same site needs none, measured): the file
	 * at the root of its registrable domain names it as its one provider
	 * URL, or names the config's own accounts endpoint and login URL
	 */
	const listed = (
		configAbsolute: string,
		file: unknown,
		config: unknown,
	): boolean => {
		if (file === undefined) return false;
		const accounts = ownString(file, 'accounts_endpoint');
		const login = ownString(file, 'login_url');
		if (accounts !== undefined && login !== undefined)
			return (
				endpointOf(accounts, configAbsolute) ===
					endpointOf(own(config, 'accounts_endpoint'), configAbsolute) &&
				endpointOf(login, configAbsolute) ===
					endpointOf(own(config, 'login_url'), configAbsolute)
			);
		const providers = own(file, 'provider_urls');
		if (!isArray(providers) || own(providers, 'length') !== 1) return false;
		return endpointOf(own(providers, 0), configAbsolute) === configAbsolute;
	};
	/**
	 * The config of `configAbsolute` (its parsed JSON), handed to `use`
	 * unless it is not readable, or is of another site than the relying
	 * party's and not listed in its provider's well-known file (Chrome asks
	 * for the two at once)
	 */
	const readConfig = async (
		configAbsolute: string,
		use: (config: unknown) => void,
	): Promise<void> => {
		let config: unknown;
		let file: unknown;
		let wellKnown: Promise<void> | null = null;
		if (siteOfURL(configAbsolute) !== rpSite) {
			const at = new URL(configAbsolute);
			const root = `${at.protocol}//${registrableDomain(at.hostname, getPublicSuffix)}${at.port ? `:${at.port}` : ''}`;
			wellKnown = idpJSON(
				`${root}/.well-known/web-identity`,
				'omit',
				true,
				(json) => (file = json),
			);
		}
		await idpJSON(configAbsolute, 'omit', true, (json) => (config = json));
		if (wellKnown) {
			await wellKnown;
			if (!listed(configAbsolute, file, config)) return;
		}
		if (config !== undefined) use(config);
	};

	// --- what the browser keeps of the site's sign-ins (src/server/identityStates.ts) ---

	const routed = client.routedClient();
	/**
	 * Ask the service worker `message`, the answer handed to `heard` (the
	 * promise resolves with nothing: what the browser keeps of the user's
	 * sign-ins is never a value of a promise the page could be handed)
	 */
	const ask = (
		message: PermissionOp,
		heard: (answer: unknown) => void = () => {},
	): Promise<void> =>
		new PagePromise<void>((done) => {
			if (!routed) return done(undefined);
			const [port, theirs] = privateChannel();
			onPort(port, 'message', (data) => {
				closePort(port);
				heard(data);
				done(undefined);
			});
			if (
				!routed.postToWorker(
					{ [PERMISSION]: { directory: routed.directory, ...message } },
					[theirs],
				)
			)
				done(undefined);
		});
	/** the state of the provider of `configAbsolute`, as the worker keeps it */
	const stateOf = async (configAbsolute: string): Promise<State> => {
		const state: State = {
			__proto__: null,
			accounts: [],
			quiet: false,
			cooldown: false,
			testing: false,
		} as State;
		await ask({ op: 'identity', idp: originOf(configAbsolute) }, (answer) => {
			const accounts = own(answer, 'accounts');
			if (isArray(accounts)) {
				const length = own(accounts, 'length') as number;
				for (let i = 0; i < length; i++) {
					const id = own(accounts, i);
					if (typeof id === 'string')
						put(state.accounts, state.accounts.length, id);
				}
			}
			state.quiet = own(answer, 'quiet') === true;
			state.cooldown = own(answer, 'cooldown') === true;
			state.testing = own(answer, 'testing') === true;
		});
		return state;
	};
	const done = (
		configAbsolute: string,
		how: 'chosen' | 'auto' | 'closed' | 'prevent' | 'disconnected',
		account?: string,
	) =>
		ask({
			op: 'identityDone',
			idp: originOf(configAbsolute),
			how,
			...(account === undefined ? {} : { account }),
		});

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
				let config: unknown;
				await readConfig(configAbsolute, (json) => (config = json));
				const endpoint = endpointOf(
					own(config, 'disconnect_endpoint'),
					configAbsolute,
				);
				// (another origin's is refused, as natively)
				if (
					endpoint === null ||
					originOf(endpoint) !== originOf(configAbsolute)
				)
					throw fail();
				const answer = await idpPost(endpoint, {
					client_id: clientId,
					account_hint: accountHint,
				});
				if (answer === null || answer.status < 200 || answer.status > 299)
					throw fail();
				// the account the provider disconnected is no returning one of
				// the browser's any more
				const account = ownString(answer.json, 'account_id');
				if (account !== undefined)
					await done(configAbsolute, 'disconnected', account);
				return undefined;
			})().then(resolvePage, rejectPage);
		});
	};

	// --- the FedCM protocol for one provider ---

	// (objects of the bundle's: no global the page could have replaced)
	/** the user closed the chooser, or the document went away while it showed */
	const DISMISSED = {};

	/** a token request's failure, as Chrome rejects it (measured) */
	const tokenError = (code: string, url: string): object =>
		NativeIdentityCredentialError
			? withStack(
					new NativeIdentityCredentialError(GENERIC_TOKEN_ERROR, {
						error: code,
						url,
					}),
				)
			: domException(GENERIC_TOKEN_ERROR, 'NetworkError');

	/** Config.fedcmTesting, as the worker said: no delays */
	let testing = false;

	// one provider through the protocol; the resolved credential, null for a
	// fault to try the next provider on, DISMISSED for a user's dismiss
	const attempt = async (
		provider: any,
		mediation: unknown,
	): Promise<object | null | typeof DISMISSED> => {
		const configAbsolute = new URL(provider.configURL).href;
		const state = await stateOf(configAbsolute);
		if (state.testing) testing = true;
		// (measured: a site in its cooldown, and a silent request while the
		// site may not sign in automatically, fail before any request)
		if (state.cooldown || (mediation === 'silent' && state.quiet)) return null;
		let config: unknown;
		await readConfig(configAbsolute, (json) => (config = json));
		const configOrigin = originOf(configAbsolute);
		const sameOrigin = (url: string | null): url is string =>
			url !== null && originOf(url) === configOrigin;
		const accountsURL = endpointOf(
			own(config, 'accounts_endpoint'),
			configAbsolute,
		);
		const tokenURL = endpointOf(
			own(config, 'id_assertion_endpoint'),
			configAbsolute,
		);
		// the accounts and token endpoints are the config's origin's, and a
		// login URL is named (Chrome refuses the config otherwise)
		if (
			!sameOrigin(accountsURL) ||
			!sameOrigin(tokenURL) ||
			endpointOf(own(config, 'login_url'), configAbsolute) === null
		)
			return null;
		// the list, copied as it is read into objects of no prototype (none of
		// it is ever handed to anything of the page's)
		const accounts: Account[] = [];
		const clientId: string = provider.clientId;
		await idpJSON(accountsURL, 'include', false, (json) => {
			const list = own(json, 'accounts');
			if (!isArray(list)) return;
			const length = own(list, 'length') as number;
			for (let i = 0; i < length; i++) {
				const entry = own(list, i);
				const id = ownString(entry, 'id');
				if (id === undefined) continue;
				const approvedList = own(entry, 'approved_clients');
				let approved = false;
				if (isArray(approvedList)) {
					const count = own(approvedList, 'length') as number;
					for (let j = 0; j < count && !approved; j++)
						approved = own(approvedList, j) === clientId;
				}
				// the latest sign-in first, as Chrome lists them
				let rank = -1;
				for (let j = 0; j < state.accounts.length && rank === -1; j++)
					if (state.accounts[j] === id) rank = j;
				// (defined, not set: a setter of an index the page put on
				// Array.prototype would be handed the account)
				put(accounts, accounts.length, {
					__proto__: null,
					id,
					name: ownString(entry, 'name'),
					email: ownString(entry, 'email'),
					returning: approved || rank !== -1,
					rank: rank === -1 ? UNRANKED + i : rank,
				} as Account);
			}
		});
		if (accounts.length === 0) return null;

		// a new account (not returning) is signed up, with the site's privacy
		// policy and terms: only then is the client metadata asked for, with
		// its query replaced by the client id, as from an opaque origin but
		// with the relying party's Origin (measured)
		let privacyPolicy: string | undefined;
		let termsOfService: string | undefined;
		let returning = 0;
		for (let i = 0; i < accounts.length; i++)
			if (accounts[i].returning) returning++;
		if (returning < accounts.length) {
			const metadata = endpointOf(
				own(config, 'client_metadata_endpoint'),
				configAbsolute,
			);
			if (sameOrigin(metadata)) {
				const url = new URL(metadata);
				url.search = '';
				url.searchParams.set('client_id', clientId);
				await idpJSON(url.href, 'omit', 'rp', (json) => {
					privacyPolicy = ownString(json, 'privacy_policy_url');
					termsOfService = ownString(json, 'terms_of_service_url');
				});
			}
		}

		// automatic re-authentication: exactly one returning account, the
		// user not asked to choose, and none made lately
		let chosen: Account | undefined;
		if (mediation !== 'required' && returning === 1 && !state.quiet)
			for (let i = 0; i < accounts.length && !chosen; i++)
				if (accounts[i].returning) chosen = accounts[i];
		const isAutoSelected = chosen !== undefined;
		if (!chosen) {
			// silent mediation may not show the chooser
			if (mediation === 'silent') return null;
			// the browser's chooser, which the host's page draws
			// (src/controller/accountChooser.ts): the accounts it signed in
			// with first, the latest first, then the others as listed
			const shown: Account[] = [];
			for (let i = 0; i < accounts.length; i++) {
				let at = shown.length;
				while (at > 0 && shown[at - 1].rank > accounts[i].rank) at--;
				for (let j = shown.length; j > at; j--) put(shown, j, shown[j - 1]);
				put(shown, at, accounts[i]);
			}
			const listed: IdentityChooserAccount[] = [];
			for (let i = 0; i < shown.length; i++) {
				const { id, name, email } = shown[i];
				put(listed, i, {
					name: name ?? email ?? id,
					email: email ?? '',
					signUp: !shown[i].returning,
					...(privacyPolicy === undefined ? {} : { privacyPolicy }),
					...(termsOfService === undefined ? {} : { termsOfService }),
				});
			}
			let picked: unknown = IDENTITY_GONE;
			await ask(
				{
					op: 'identityChooser',
					idp: configOrigin,
					accounts: listed,
				},
				(answer) => (picked = answer),
			);
			if (typeof picked !== 'number' || !shown[picked]) {
				// the close button starts the site's cooldown, as Chrome's does
				if (picked === IDENTITY_CLOSED) await done(configAbsolute, 'closed');
				return DISMISSED;
			}
			chosen = shown[picked];
		}

		const posted = now();
		const answer = await idpPost(tokenURL, {
			client_id: clientId,
			nonce: typeof provider.nonce === 'string' ? provider.nonce : '',
			account_id: chosen.id,
			disclosure_text_shown: String(!chosen.returning),
			is_auto_selected: String(isAutoSelected),
		});
		// a network error (a provider that does not allow the relying party's
		// origin) or an HTTP error rejects at once, as natively: 500 and 503
		// say what they are, anything else nothing
		if (answer === null) throw tokenError('', '');
		if (answer.status < 200 || answer.status > 299)
			throw tokenError(
				answer.status === 500
					? 'server_error'
					: answer.status === 503
						? 'temporarily_unavailable'
						: '',
				'',
			);
		const token = ownString(answer.json, 'token');
		if (token !== undefined) {
			// the account is a returning one from now on; an automatic sign-in
			// keeps the site from another for a while, a pick lets it again
			await done(configAbsolute, isAutoSelected ? 'auto' : 'chosen', chosen.id);
			// Chrome holds the token three seconds after its request (measured:
			// a pick, or an automatic sign-in, resolves three seconds later)
			const left = testing ? 0 : posted + TOKEN_HOLD_MS - now();
			if (left > 0) await new PagePromise<void>((wake) => later(wake, left));
			return makeCredential(token, isAutoSelected, configAbsolute);
		}
		const error = own(answer.json, 'error');
		const code = ownString(error, 'code');
		// an error URL is the config's site's, or none
		const errorURL = endpointOf(own(error, 'url'), configAbsolute);
		throw tokenError(
			code ?? '',
			errorURL !== null && siteOfURL(errorURL) === siteOfURL(configAbsolute)
				? errorURL
				: '',
		);
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
			// (measured: at once, before any request)
			if (mediation === 'conditional')
				return rejectPage(
					domException(
						'Conditional mediation is not supported for this credential type',
						'NotSupportedError',
					),
				);
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
				// a failure before the chooser showed is held a while, so the
				// page cannot tell one with no account from one the user turned
				// down (measured, below)
				later(
					() => rejectPage(domException(GENERIC_TOKEN_ERROR, 'NetworkError')),
					testing ? 0 : rejectionDelay(),
				);
			})().catch((error) => rejectPage(error));
		});

	// preventSilentAccess(): the site's next request asks the user, until a
	// pick in the chooser (src/server/identityStates.ts)
	const preventSilent = () =>
		void ask({ op: 'identityDone', idp: '', how: 'prevent' });

	return { runIdentity, disconnect, preventSilent };
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
