import {
	domainMatches,
	isIP,
	isSecureURL,
	malformedPart,
	type CookieStoreWrite,
	type JarCookie,
	type SameSite,
} from '../../../server/Cookies';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';
import { CookiesModule } from './Cookies';

const SAME_SITES: SameSite[] = ['strict', 'lax', 'none'];
/** RFC 6265bis 5.6 step 3: name plus value */
const MAX_COOKIE_BYTES = 4096;
/** RFC 6265bis 5.6: a longer attribute is refused */
const MAX_ATTRIBUTE_BYTES = 1024;
const MALFORMED =
	'Cookie was malformed and could not be stored, due to problem(s) while parsing.';
const encoder = new TextEncoder();

type Method = 'get' | 'getAll' | 'set' | 'delete';

/**
 * The Cookie Store API over the proxy's jar, the one document.cookie reads
 * and writes. The page's `cookieStore` is the browser's own CookieStore (its
 * identity, prototype, `onchange` and event methods are native); its four
 * methods answer from the jar instead of the proxy origin's real cookies,
 * with the browser's results and errors (a call on anything else is the
 * native method's), and the change events are the jar's: the browser's own
 * (about the proxy origin's cookies, which the sync bridge writes) never
 * reach the page, and a change of the jar this document can see (its own
 * writes, a response's Set-Cookie, another document's write, all of which
 * the worker broadcasts) is dispatched as a CookieChangeEvent, one per
 * cookie. A script cannot make an event trusted, so `isTrusted` is false
 * where natively it is true. The API exists only in a secure context: a
 * document whose real URL is not secure has none of it, as natively.
 */
export default class CookieStoreModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global as typeof globalThis &
			Record<string, any>;
		const getter = Reflect.getOwnPropertyDescriptor(global, 'cookieStore');
		const CookieStore = global.CookieStore as Function | undefined;
		const CookieChangeEvent = global.CookieChangeEvent as
			(new (type: string, init: object) => Event) | undefined;
		if (
			!getter?.get ||
			typeof CookieStore !== 'function' ||
			typeof CookieChangeEvent !== 'function'
		)
			return;
		if (!isSecureURL(this.client.url.url)) {
			for (const name of ['cookieStore', 'CookieStore', 'CookieChangeEvent'])
				Reflect.deleteProperty(global, name);
			return;
		}

		const proxyModule = this.client.getModule(ProxyModule)!;
		const cookies = this.client.getModule(CookiesModule)!;
		const store = Reflect.apply(getter.get, global, []) as EventTarget;
		const prototype = CookieStore.prototype as Record<Method, Function>;
		const nativeAdd = global.EventTarget.prototype.addEventListener;
		const nativeDispatch = global.EventTarget.prototype.dispatchEvent;
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;

		// the browser's events are about the proxy origin's cookies (the sync
		// bridge's answers ride in them): dropped before any page listener
		Reflect.apply(nativeAdd, store, [
			'change',
			(event: Event) => {
				if (event.isTrusted) Reflect.apply(stopImmediate, event, []);
			},
		]);

		const fail = (method: Method, message: string) =>
			new global.TypeError(
				`Failed to execute '${method}' on 'CookieStore': ${message}`,
			);
		// WebIDL's USVString: a lone surrogate is U+FFFD
		const toUSV = (value: unknown): string => {
			const text = String(value);
			const wellFormed = (
				String.prototype as { toWellFormed?: (this: string) => string }
			).toWellFormed;
			return wellFormed ? Reflect.apply(wellFormed, text, []) : text;
		};
		const isObject = (value: unknown): value is Record<string, unknown> =>
			(typeof value === 'object' && value !== null) ||
			typeof value === 'function';
		// a dictionary the browser makes is an object of the page's realm
		const page = <T extends object>(object: T): T => {
			Reflect.setPrototypeOf(object, global.Object.prototype);
			return object;
		};
		const host = () => this.client.url.url.hostname;
		const withoutHash = (url: URL) => url.href.replace(/#[^]*$/, '');

		/** a cookie as the API lists it: the dictionary's members in order */
		const item = (cookie: JarCookie) =>
			page({
				domain: cookie.hostOnly || isIP(cookie.domain) ? null : cookie.domain,
				expires: cookie.expires ?? null,
				name: cookie.name,
				partitioned: !!cookie.partitioned,
				path: cookie.path,
				sameSite: cookie.sameSite,
				secure: cookie.secure,
				value: cookie.value,
			});
		/** a deleted cookie as a change event lists it: no value or expiry */
		const deletedItem = (cookie: JarCookie) =>
			page({
				domain: cookie.hostOnly || isIP(cookie.domain) ? null : cookie.domain,
				name: cookie.name,
				partitioned: !!cookie.partitioned,
				path: cookie.path,
				...(cookie.sameSiteDefault ? {} : { sameSite: cookie.sameSite }),
				secure: cookie.secure,
			});

		// what the page has seen of the jar, from its first look at the API
		let seen: Map<string, JarCookie> | null = null;
		let watching: Promise<void> | null = null;
		let refreshing = false;
		let again = false;
		const watch = () =>
			(watching ??= cookies.jarCookies().then(
				(list) => {
					seen = new Map(list.map((cookie) => [cookie.id, cookie]));
				},
				() => {
					// the jar did not answer: the next look asks again, and
					// nothing is reported until it has
					watching = null;
				},
			));
		const differs = (a: JarCookie, b: JarCookie) =>
			a.value !== b.value ||
			a.expires !== b.expires ||
			a.secure !== b.secure ||
			a.sameSite !== b.sameSite ||
			a.hostOnly !== b.hostOnly;
		const dispatch = (changed: object[], deleted: object[]) =>
			Reflect.apply(nativeDispatch, store, [
				new CookieChangeEvent('change', { changed, deleted }),
			]);
		const refresh = async () => {
			if (!watching) return;
			if (refreshing) {
				again = true;
				return;
			}
			refreshing = true;
			try {
				await watching;
				do {
					again = false;
					if (!seen) return;
					const list = await cookies.jarCookies();
					const before: Map<string, JarCookie> = seen;
					const now = new Map(list.map((cookie) => [cookie.id, cookie]));
					seen = now;
					for (const [id, cookie] of before)
						if (!now.has(id)) dispatch([], [deletedItem(cookie)]);
					for (const cookie of list) {
						const old = before.get(cookie.id);
						if (!old || differs(old, cookie)) dispatch([item(cookie)], []);
					}
				} while (again);
			} catch (error) {
				// the jar did not answer: the next change reads it again
			} finally {
				refreshing = false;
			}
		};
		cookies.changeListeners.add(() => void refresh());

		/** a refusal of an opaque origin, as natively */
		const opaque = (method: Method) =>
			this.client.sandboxedOpaque
				? new global.DOMException(
						`Failed to execute '${method}' on 'CookieStore': Access to the CookieStore API is denied in this context.`,
						'SecurityError',
					)
				: null;

		/** get's and getAll's argument: a name, or CookieStoreGetOptions */
		const getOptions = (args: unknown[]) => {
			const [arg] = args;
			if (args.length && arg !== undefined && arg !== null && !isObject(arg))
				return { name: toUSV(arg), url: undefined };
			const options = (arg ?? {}) as Record<string, unknown>;
			const name = options.name;
			const url = options.url;
			return {
				name: name === undefined ? undefined : toUSV(name),
				url: url === undefined ? undefined : toUSV(url),
			};
		};
		const matching = async (method: Method, args: unknown[]) => {
			const refused = opaque(method);
			if (refused) throw refused;
			const { name, url } = getOptions(args);
			if (method === 'get' && name === undefined && url === undefined)
				throw fail(method, 'CookieStoreGetOptions must not be empty');
			if (url !== undefined) {
				let parsed: URL | null = null;
				try {
					parsed = new URL(url, this.client.url.toString());
				} catch (error) {
					// as one that does not match
				}
				if (!parsed || withoutHash(parsed) !== withoutHash(this.client.url.url))
					throw fail(method, 'URL must match the document URL');
			}
			await watch();
			const list = await cookies.jarCookies();
			return name === undefined
				? list
				: list.filter((cookie) => cookie.name === name);
		};

		/** `path` checked and given its trailing slash, as Chrome does */
		const checkPath = (method: Method, path: string) => {
			if (!path.startsWith('/'))
				throw fail(method, 'Cookie path must start with "/"');
			return path.endsWith('/') ? path : `${path}/`;
		};
		const checkDomain = (method: Method, domain: string | null) => {
			if (domain === null) return null;
			if (domain.startsWith('.'))
				throw fail(method, 'Cookie domain cannot start with "."');
			if (!domainMatches(host(), domain.toLowerCase()))
				throw fail(method, 'Cookie domain must domain-match current host');
			return domain;
		};

		/** set's arguments as a write, refused with the browser's errors */
		const setWrite = (args: unknown[]): CookieStoreWrite => {
			if (!args.length)
				throw fail('set', '1 argument required, but only 0 present.');
			let write: CookieStoreWrite;
			if (args.length >= 2) {
				write = {
					name: toUSV(args[0]),
					value: toUSV(args[1]),
					domain: null,
					expires: null,
					partitioned: false,
					path: '/',
					sameSite: 'strict',
				};
			} else {
				const [arg] = args;
				if (arg !== undefined && arg !== null && !isObject(arg))
					throw fail('set', "The provided value is not of type 'CookieInit'.");
				const init = (arg ?? {}) as Record<string, unknown>;
				const member = (key: string) =>
					`Failed to read the '${key}' property from 'CookieInit'`;
				// read in the dictionary's order, each converted as it is read
				const domain = init.domain;
				const expires = init.expires;
				let expiry: number | null = null;
				if (expires !== undefined && expires !== null) {
					expiry = Number(expires);
					if (!Number.isFinite(expiry))
						throw fail(
							'set',
							`${member('expires')}: The provided double value is non-finite.`,
						);
				}
				const name = init.name;
				if (name === undefined)
					throw fail('set', `${member('name')}: Required member is undefined.`);
				const named = toUSV(name);
				const partitioned = !!init.partitioned;
				const path = init.path === undefined ? '/' : toUSV(init.path);
				const sameSite =
					init.sameSite === undefined ? 'strict' : String(init.sameSite);
				if (!SAME_SITES.includes(sameSite as SameSite))
					throw fail(
						'set',
						`${member('sameSite')}: The provided value '${sameSite}' is not a valid enum value of type CookieSameSite.`,
					);
				const value = init.value;
				if (value === undefined)
					throw fail(
						'set',
						`${member('value')}: Required member is undefined.`,
					);
				write = {
					name: named,
					value: toUSV(value),
					domain:
						domain === undefined || domain === null ? null : toUSV(domain),
					expires: expiry,
					partitioned,
					path,
					sameSite: sameSite as SameSite,
				};
			}
			// what Chrome refuses before it makes the cookie, in its order
			const name = write.name.replace(/^[ \t]+|[ \t]+$/g, '');
			const value = write.value.replace(/^[ \t]+|[ \t]+$/g, '');
			if (name === '' && value === '')
				throw fail('set', 'Cookie name and value both cannot be empty');
			if (name === '' && value.includes('='))
				throw fail(
					'set',
					"Cookie value cannot contain '=' if the name is empty",
				);
			if (name.includes('='))
				throw fail('set', "Cookie name cannot contain '='");
			const domain = checkDomain('set', write.domain);
			const path = checkPath('set', write.path);
			if (/^__host-/i.test(name)) {
				if (domain !== null)
					throw fail(
						'set',
						'Cookies with "__Host-" prefix cannot have a domain',
					);
				if (path !== '/')
					throw fail(
						'set',
						'Cookies with "__Host-" prefix cannot have a non-"/" path',
					);
			}
			if (
				malformedPart(name + value + path) ||
				encoder.encode(name).length + encoder.encode(value).length >
					MAX_COOKIE_BYTES ||
				encoder.encode(path).length > MAX_ATTRIBUTE_BYTES
			)
				throw fail('set', MALFORMED);
			return { ...write, name, value, domain, path };
		};

		/** delete's argument as a write that expires the cookie */
		const deleteWrite = (args: unknown[]): CookieStoreWrite => {
			if (!args.length)
				throw fail('delete', '1 argument required, but only 0 present.');
			const [arg] = args;
			let domain: string | null = null;
			let name: string;
			let partitioned = false;
			let path = '/';
			if (arg !== undefined && arg !== null && !isObject(arg))
				name = toUSV(arg);
			else {
				const options = (arg ?? {}) as Record<string, unknown>;
				if (options.domain !== undefined && options.domain !== null)
					domain = toUSV(options.domain);
				if (options.name === undefined)
					throw fail(
						'delete',
						"Failed to read the 'name' property from 'CookieStoreDeleteOptions': Required member is undefined.",
					);
				name = toUSV(options.name);
				partitioned = !!options.partitioned;
				if (options.path !== undefined) path = toUSV(options.path);
			}
			return {
				name,
				value: '',
				domain: checkDomain('delete', domain),
				path: checkPath('delete', path),
				sameSite: 'strict',
				partitioned,
				expires: 0,
			};
		};
		const write = async (method: Method, make: () => CookieStoreWrite) => {
			const refused = opaque(method);
			if (refused) throw refused;
			const cookie = make();
			await watch();
			await cookies.store(cookie);
		};

		const methods: Record<Method, (args: unknown[]) => Promise<unknown>> = {
			get: async (args) => {
				const [first] = await matching('get', args);
				return first ? item(first) : null;
			},
			getAll: async (args) =>
				global.Array.from(await matching('getAll', args), item),
			set: (args) => write('set', () => setWrite(args)),
			delete: (args) => write('delete', () => deleteWrite(args)),
		};
		for (const [method, own] of Object.entries(methods) as [
			Method,
			(args: unknown[]) => Promise<unknown>,
		][])
			if (typeof prototype[method] === 'function')
				prototype[method] = proxyModule.wrapFunction(
					prototype[method],
					(target, that, args) =>
						that === store ? own(args) : Reflect.apply(target, that, args),
				);

		// the page's first look at the API starts the record of what it has
		// seen, so a change after it is reported
		Reflect.defineProperty(global, 'cookieStore', {
			...getter,
			get: proxyModule.wrapFunction(getter.get, (target, that, args) => {
				const result = Reflect.apply(target, that, args);
				if (result === store) watch();
				return result;
			}),
		});
	}
}
