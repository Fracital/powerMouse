import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';

// the globals Chrome exposes only with FedCM on (measured on 152 against
// --disable-features=FedCm, which leaves the rest of the Credential
// Management API as it is)
const FEDCM_GLOBALS = [
	'IdentityCredential',
	'IdentityCredentialError',
	'IdentityProvider',
	'NavigatorLogin',
];

const PREFIX =
	"Failed to execute 'get' on 'CredentialsContainer': Failed to read the 'identity' property from 'CredentialRequestOptions': ";

/**
 * FedCM (Google One Tap): `navigator.credentials.get({ identity })` makes the
 * browser itself fetch the identity provider's well-known file, config,
 * accounts (with the user's real cookies for the IdP), client metadata and
 * token endpoints, from its own process, never through the service worker,
 * and the IdP learns the site from the client id. Those requests cannot be
 * routed, so a page gets what a browser without FedCM gives: the FedCM
 * globals and `navigator.login` are gone and an identity request rejects
 * with the NotSupportedError Chrome gives with FedCM off. Sign-in libraries
 * then use their iframe or popup flow, which goes through the proxy.
 */
export default class CredentialsModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global as unknown as Record<string, any>;
		for (const name of FEDCM_GLOBALS) Reflect.deleteProperty(global, name);
		const navigatorPrototype = global.Navigator?.prototype;
		if (navigatorPrototype) Reflect.deleteProperty(navigatorPrototype, 'login');

		const container = global.CredentialsContainer?.prototype;
		if (typeof container?.get !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		// a rejection of the page's realm, whatever the page later does to
		// its Promise
		const PagePromise: PromiseConstructor = global.Promise;
		const promiseReject = PagePromise.reject;
		const reject = (error: unknown) =>
			Reflect.apply(promiseReject, PagePromise, [error]);
		const PageTypeError: TypeErrorConstructor = global.TypeError;
		const PageDOMException: typeof DOMException = global.DOMException;
		const signalPrototype = global.AbortSignal?.prototype;
		const aborted = signalPrototype
			? Reflect.getOwnPropertyDescriptor(signalPrototype, 'aborted')?.get
			: undefined;
		const reason = signalPrototype
			? Reflect.getOwnPropertyDescriptor(signalPrototype, 'reason')?.get
			: undefined;
		// the reason of an aborted AbortSignal, or undefined for anything else
		const abortReason = (signal: unknown): unknown => {
			if (!aborted || !reason || signal === null || signal === undefined)
				return undefined;
			try {
				return Reflect.apply(aborted, signal, [])
					? Reflect.apply(reason, signal, [])
					: undefined;
			} catch (error) {
				return undefined;
			}
		};

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
				// the member read once and pinned: a getter cannot hand the
				// browser an identity request this check did not see
				if (identity === undefined)
					return Reflect.apply(target, that, [
						{ __proto__: options, identity: undefined },
						...args.slice(1),
					]);
				// what Chrome with FedCM off answers: the dictionary is still
				// converted, an aborted signal still wins, and then the request
				// is refused
				try {
					if (
						identity === null ||
						(typeof identity !== 'object' && typeof identity !== 'function')
					)
						return reject(
							new PageTypeError(
								`${PREFIX}The provided value is not of type 'IdentityCredentialRequestOptions'.`,
							),
						);
					if ((identity as { providers?: unknown }).providers === undefined)
						return reject(
							new PageTypeError(
								`${PREFIX}Failed to read the 'providers' property from 'IdentityCredentialRequestOptions': Required member is undefined.`,
							),
						);
					const abort = abortReason(options.signal);
					if (abort !== undefined) return reject(abort);
				} catch (error) {
					return reject(error);
				}
				return reject(
					new PageDOMException('FedCM is not supported.', 'NotSupportedError'),
				);
			},
		);
	}
}
