// The Cookie Store API's four methods over the proxy's jar, as Chrome
// answers them (results, dictionaries and errors), for a document's
// cookieStore (dom/modules/CookieStore.ts) and an emulated service worker's
// (worker/modules/ServiceWorkerGlobal.ts). What differs between the two is
// passed in: which `url` a call may name, and how the jar is reached.
import {
	domainMatches,
	isIP,
	malformedPart,
	type CookieStoreWrite,
	type JarCookie,
	type SameSite,
} from '../server/Cookies';

export type CookieStoreMethod = 'get' | 'getAll' | 'set' | 'delete';

const SAME_SITES: SameSite[] = ['strict', 'lax', 'none'];
/** RFC 6265bis 5.6 step 3: name plus value */
const MAX_COOKIE_BYTES = 4096;
/** RFC 6265bis 5.6: a longer attribute is refused */
const MAX_ATTRIBUTE_BYTES = 1024;
const MALFORMED =
	'Cookie was malformed and could not be stored, due to problem(s) while parsing.';
const encoder = new TextEncoder();

export interface CookieStoreContext {
	global: typeof globalThis;
	/** what a `url` resolves against */
	base(): string;
	/** the reason a call may not name `url` (null: it may), or for one that does not parse */
	refuseURL(url: URL | null): string | null;
	/** the host a `domain` must domain-match */
	host(): string;
	/** the cookies this realm may see (no HttpOnly ones) */
	jar(): Promise<JarCookie[]>;
	/** a write, done when the jar has it */
	store(write: CookieStoreWrite): Promise<void>;
	/** a refusal of the whole API (an opaque origin's), or null */
	refused(method: CookieStoreMethod): Error | null;
	/** before a call reads or writes (a document starts its change record) */
	look(): Promise<void>;
}

export interface CookieStoreMethods {
	methods: Record<CookieStoreMethod, (args: unknown[]) => Promise<unknown>>;
	/** a cookie as the API lists it */
	item(cookie: JarCookie): object;
	/** a deleted cookie as a change event lists it: no value or expiry */
	deletedItem(cookie: JarCookie): object;
}

export function cookieStoreMethods(
	context: CookieStoreContext,
): CookieStoreMethods {
	const { global } = context;
	const fail = (method: CookieStoreMethod, message: string) =>
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
	// a dictionary the browser makes is an object of the realm
	const own = <T extends object>(object: T): T => {
		Reflect.setPrototypeOf(object, global.Object.prototype);
		return object;
	};

	const item = (cookie: JarCookie) =>
		own({
			domain: cookie.hostOnly || isIP(cookie.domain) ? null : cookie.domain,
			expires: cookie.expires ?? null,
			name: cookie.name,
			partitioned: !!cookie.partitioned,
			path: cookie.path,
			sameSite: cookie.sameSite,
			secure: cookie.secure,
			value: cookie.value,
		});
	const deletedItem = (cookie: JarCookie) =>
		own({
			domain: cookie.hostOnly || isIP(cookie.domain) ? null : cookie.domain,
			name: cookie.name,
			partitioned: !!cookie.partitioned,
			path: cookie.path,
			...(cookie.sameSiteDefault ? {} : { sameSite: cookie.sameSite }),
			secure: cookie.secure,
		});

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
	const matching = async (method: CookieStoreMethod, args: unknown[]) => {
		const refused = context.refused(method);
		if (refused) throw refused;
		const { name, url } = getOptions(args);
		if (method === 'get' && name === undefined && url === undefined)
			throw fail(method, 'CookieStoreGetOptions must not be empty');
		if (url !== undefined) {
			let parsed: URL | null = null;
			try {
				parsed = new URL(url, context.base());
			} catch (error) {
				// as one that does not match
			}
			const reason = context.refuseURL(parsed);
			if (reason) throw fail(method, reason);
		}
		await context.look();
		const list = await context.jar();
		return name === undefined
			? list
			: list.filter((cookie) => cookie.name === name);
	};

	/** `path` checked and given its trailing slash, as Chrome does */
	const checkPath = (method: CookieStoreMethod, path: string) => {
		if (!path.startsWith('/'))
			throw fail(method, 'Cookie path must start with "/"');
		return path.endsWith('/') ? path : `${path}/`;
	};
	const checkDomain = (method: CookieStoreMethod, domain: string | null) => {
		if (domain === null) return null;
		if (domain.startsWith('.'))
			throw fail(method, 'Cookie domain cannot start with "."');
		if (!domainMatches(context.host(), domain.toLowerCase()))
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
				throw fail('set', `${member('value')}: Required member is undefined.`);
			write = {
				name: named,
				value: toUSV(value),
				domain: domain === undefined || domain === null ? null : toUSV(domain),
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
			throw fail('set', "Cookie value cannot contain '=' if the name is empty");
		if (name.includes('=')) throw fail('set', "Cookie name cannot contain '='");
		const domain = checkDomain('set', write.domain);
		const path = checkPath('set', write.path);
		if (/^__host-/i.test(name)) {
			if (domain !== null)
				throw fail('set', 'Cookies with "__Host-" prefix cannot have a domain');
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
		if (arg !== undefined && arg !== null && !isObject(arg)) name = toUSV(arg);
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
	const write = async (
		method: CookieStoreMethod,
		make: () => CookieStoreWrite,
	) => {
		const refused = context.refused(method);
		if (refused) throw refused;
		const cookie = make();
		await context.look();
		await context.store(cookie);
	};

	return {
		item,
		deletedItem,
		methods: {
			get: async (args) => {
				const [first] = await matching('get', args);
				return first ? item(first) : null;
			},
			getAll: async (args) =>
				global.Array.from(await matching('getAll', args), item),
			set: (args) => write('set', () => setWrite(args)),
			delete: (args) => write('delete', () => deleteWrite(args)),
		},
	};
}
