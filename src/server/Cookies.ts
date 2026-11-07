// The service worker's cookie jar. Storage and matching follow RFC 6265bis
// the way a browser does: a cookie set without Domain is host-only, Domain
// matches by label and never a public suffix, paths match on a boundary,
// Secure cookies go to secure URLs only and an insecure origin cannot touch
// them, the __Host- and __Secure- prefixes are enforced, oversize cookies and
// lines with a control character are refused, SameSite is evaluated against
// the request's site when the caller says what it is, and the Cookie header
// lists longer paths first, then earlier creations (a re-set with a new value
// is a new creation, as in Chrome). The matching functions are exported
// on their own so they can be checked in node (cookie-rules suite).
import { IDBPDatabase, openDB } from 'idb';
import parseSetCookie, { Cookie as ParserCookie } from 'set-cookie-parser';
import {
	CookieRecord,
	COOKIES_CHANGED,
	CookiesChange,
} from '../transport/messages';
import Router, { jsonAPI } from './Router';

export type SameSite = 'lax' | 'strict' | 'none';

/** a cookie as the jar stores it (and hands to the page through /cookies/get) */
export interface JarCookie {
	/** domain, path and name, so a re-set replaces */
	id: string;
	name: string;
	value: string;
	/** lowercase, no leading dot; the request host for a host-only cookie */
	domain: string;
	/** set without a Domain attribute: sent to exactly that host */
	hostOnly: boolean;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	sameSite: SameSite;
	/** ms since the epoch; a session cookie has none */
	expires?: number;
	/** ms since the epoch; kept across re-sets (RFC 6265 5.3 step 11) */
	created: number;
}

/** the name the inject bundle imports the stored shape under */
export type FloatingCookie = JarCookie;

/** who is setting the cookie: a script cannot set or replace HttpOnly ones */
export type CookieSource = 'http' | 'script';

/**
 * The public suffix of a host (tldts `getPublicSuffix` with the private list,
 * so github.io counts), or null for an IP. Passed in rather than imported:
 * the inject bundles share this module for `BrowserCookieArray`, and a
 * static tldts import would carry its 100 KB list into every worker.
 */
export type PublicSuffix = (host: string) => string | null;

export interface ParseOptions {
	source?: CookieSource;
	now?: number;
}

/** what the jar needs to know about a request to apply SameSite */
export interface CookieRequestContext {
	/**
	 * the request's sec-fetch-site. `none` (no initiator: the user typed the
	 * URL) counts as same-site, like a browser does. Default: same-site, so
	 * a caller that does not know gets every cookie, as before.
	 */
	site?: 'same-origin' | 'same-site' | 'cross-site' | 'none';
	/** a top-level navigation: a cross-site one with a safe method gets Lax cookies too */
	navigation?: boolean;
	method?: string;
}

const SAME_SITES: SameSite[] = ['lax', 'strict', 'none'];
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];
/** RFC 6265bis 5.6 step 3: name plus value */
const MAX_COOKIE_BYTES = 4096;
/** RFC 6265bis 5.6: a longer attribute value is ignored, not the cookie */
const MAX_ATTRIBUTE_BYTES = 1024;
/** RFC 6265bis 5.5: cookies live at most 400 days */
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const encoder = new TextEncoder();

/** a CTL character other than HTAB (RFC 6265bis 5.6 step 1) */
function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
	}
	return false;
}

function isIP(host: string): boolean {
	return IPV4.test(host) || host.startsWith('[');
}

/**
 * Whether cookies treat the URL as secure: https and wss, plus loopback over
 * http (localhost, *.localhost, 127.0.0.0/8, ::1), which Chrome calls
 * potentially trustworthy and lets set and receive Secure cookies.
 */
export function isSecureURL(url: URL): boolean {
	if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
	if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false;
	const host = url.hostname;
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		(IPV4.test(host) && host.startsWith('127.')) ||
		host === '[::1]'
	);
}

/** RFC 6265 5.1.3: `host` is `domain` or a subdomain of it by label */
export function domainMatches(host: string, domain: string): boolean {
	if (host === domain) return true;
	return host.endsWith(`.${domain}`) && !isIP(host);
}

/** RFC 6265 5.1.4: the directory of the request path */
export function defaultPath(pathname: string): string {
	if (!pathname.startsWith('/')) return '/';
	const slash = pathname.lastIndexOf('/');
	return slash === 0 ? '/' : pathname.slice(0, slash);
}

/** RFC 6265 5.1.4: `/foo` covers `/foo` and `/foo/bar`, not `/foobar` */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function cookieID(domain: string, path: string, name: string): string {
	return [domain, path, name].map((value) => JSON.stringify(value)).join('@@');
}

/** the stored cookie's domain covers `host` (RFC 6265bis 5.8.3 step 1) */
function coversHost(cookie: JarCookie, host: string): boolean {
	return cookie.hostOnly
		? cookie.domain === host
		: domainMatches(host, cookie.domain);
}

function sameSiteAllows(
	cookie: JarCookie,
	context: CookieRequestContext,
): boolean {
	if ((context.site ?? 'same-site') !== 'cross-site') return true;
	switch (cookie.sameSite) {
		case 'none':
			return true;
		case 'strict':
			return false;
		case 'lax':
			return (
				!!context.navigation &&
				SAFE_METHODS.includes((context.method ?? 'GET').toUpperCase())
			);
	}
}

/** RFC 6265bis 5.8.3: whether a stored cookie goes with a request to `url` */
export function cookieMatches(
	cookie: JarCookie,
	url: URL,
	context: CookieRequestContext = {},
): boolean {
	return (
		coversHost(cookie, url.hostname) &&
		pathMatches(url.pathname, cookie.path) &&
		(!cookie.secure || isSecureURL(url)) &&
		sameSiteAllows(cookie, context)
	);
}

/** RFC 6265 5.4 step 2: longer paths first, then earlier creation */
export function compareCookies(a: JarCookie, b: JarCookie): number {
	return b.path.length - a.path.length || a.created - b.created;
}

function expired(cookie: JarCookie, now: number): boolean {
	return cookie.expires !== undefined && cookie.expires <= now;
}

/**
 * RFC 6265bis 5.6, the part that needs no store: parse one Set-Cookie value
 * for a response from `url` and return the cookie to store, or null when a
 * browser would ignore it. `expires` at or before `now` means delete.
 */
export function parseCookie(
	header: string,
	url: URL,
	publicSuffix: PublicSuffix,
	{ source = 'http', now = Date.now() }: ParseOptions = {},
): JarCookie | null {
	// Chrome's HTTP parser ends a header at a bare CR or LF and reads a NUL
	// as a space (a transport hands the raw value over); anywhere else in the
	// line, a control character (in the name, the value or any attribute)
	// drops the whole cookie, not just the attribute
	if (source === 'http')
		header = header.split(/[\r\n]/, 1)[0].replaceAll('\0', ' ');
	if (hasControlCharacter(header)) return null;
	// an oversize attribute is skipped as if it were absent, so an earlier
	// Path or Domain of the same name still counts
	const [pair, ...attributes] = header.split(';');
	header = [
		pair,
		...attributes.filter((attribute) => {
			const eq = attribute.indexOf('=');
			return (
				eq < 0 ||
				encoder.encode(attribute.slice(eq + 1).trim()).length <=
					MAX_ATTRIBUTE_BYTES
			);
		}),
	].join(';');
	// one Set-Cookie value (or one document.cookie write) is one cookie: a
	// comma belongs to the value, it does not start another cookie
	const [parsed]: ParserCookie[] = parseSetCookie(header, {
		decodeValues: false,
		silent: true,
		split: false,
	});
	if (!parsed) return null;
	const { name, value } = parsed;
	if (name === '' && value === '') return null;
	if (
		encoder.encode(name).length + encoder.encode(value).length >
		MAX_COOKIE_BYTES
	)
		return null;

	const secure = !!parsed.secure;
	const httpOnly = !!parsed.httpOnly;
	if (secure && !isSecureURL(url)) return null;
	if (httpOnly && source === 'script') return null;

	const host = url.hostname;
	let domain = host;
	let hostOnly = true;
	const attribute = (parsed.domain ?? '').replace(/^\./, '').toLowerCase();
	if (attribute !== '') {
		// a cookie for a whole public suffix (com, co.uk, github.io) would be
		// a supercookie; one for the host itself is just host-only
		const suffix = isIP(attribute) ? null : publicSuffix(attribute);
		if (suffix === attribute) {
			if (attribute !== host) return null;
		} else {
			if (!domainMatches(host, attribute)) return null;
			domain = attribute;
			hostOnly = false;
		}
	}

	const path =
		parsed.path && parsed.path.startsWith('/')
			? parsed.path
			: defaultPath(url.pathname);

	const lowerName = name.toLowerCase();
	// a nameless cookie travels as its bare value, so one whose value starts
	// like a prefixed name would pass for that cookie (RFC 6265bis 5.7)
	if (name === '' && /^__(secure|host)-/i.test(value)) return null;
	if (lowerName.startsWith('__secure-') && !secure) return null;
	if (
		lowerName.startsWith('__host-') &&
		(!secure || !hostOnly || attribute !== '' || path !== '/')
	)
		return null;

	const sameSiteAttribute = parsed.sameSite?.toLowerCase();
	const sameSite: SameSite = SAME_SITES.includes(sameSiteAttribute as SameSite)
		? (sameSiteAttribute as SameSite)
		: 'lax';
	if (sameSite === 'none' && !secure) return null;

	let expires: number | undefined;
	if (typeof parsed.maxAge === 'number' && !Number.isNaN(parsed.maxAge)) {
		// seconds; zero or negative is a deletion
		expires = parsed.maxAge <= 0 ? 0 : now + parsed.maxAge * 1000;
	} else if (
		parsed.expires instanceof Date &&
		!Number.isNaN(parsed.expires.getTime())
	) {
		expires = Math.max(0, parsed.expires.getTime());
	}
	if (expires !== undefined && expires > now + MAX_AGE_MS)
		expires = now + MAX_AGE_MS;

	return {
		id: cookieID(domain, path, name),
		name,
		value,
		domain,
		hostOnly,
		path,
		secure,
		httpOnly,
		sameSite,
		expires,
		created: now,
	};
}

/** the domains a cookie for `host` can be stored under (the index keys to read) */
function candidateDomains(host: string): string[] {
	if (isIP(host)) return [host];
	const labels = host.split('.');
	return labels.map((_, i) => labels.slice(i).join('.'));
}

export class BrowserCookieArray extends Array<JarCookie> {
	toString() {
		const result: string[] = [];

		for (const cookie of this) {
			// a nameless cookie travels as its bare value, like in a browser
			result.push(
				cookie.name === '' ? cookie.value : `${cookie.name}=${cookie.value}`,
			);
		}

		return result.join('; ');
	}
}

const STORE = 'cookies';

export default class Cookies {
	private db: IDBPDatabase;
	#publicSuffix: PublicSuffix;
	/** called after the jar changed for a domain ('' for every host) */
	onChange?: (domain: string) => void;
	/** the last creation time handed out, so two sets in one ms keep their order */
	#lastCreated = 0;
	constructor(db: IDBPDatabase, publicSuffix: PublicSuffix) {
		this.db = db;
		this.#publicSuffix = publicSuffix;
	}
	/** the cookies a request to `url` carries, in Cookie header order */
	async get(
		url: string | URL,
		context: CookieRequestContext = {},
	): Promise<BrowserCookieArray> {
		url = new URL(url);
		const now = Date.now();
		const result = new BrowserCookieArray();

		for (const domain of candidateDomains(url.hostname))
			for (const cookie of (await this.db.getAllFromIndex(
				STORE,
				'domain',
				domain,
			)) as JarCookie[]) {
				if (expired(cookie, now)) {
					this.db.delete(STORE, cookie.id);
				} else if (cookieMatches(cookie, url, context)) {
					result.push(cookie);
				}
			}

		result.sort(compareCookies);
		return result;
	}
	/** every stored cookie, or those a page of `origin` could receive */
	async list(origin?: string): Promise<CookieRecord[]> {
		const host = origin ? new URL(origin).hostname : null;
		const records: CookieRecord[] = [];
		for (const cookie of (await this.db.getAll(STORE)) as JarCookie[]) {
			if (host !== null && !coversHost(cookie, host)) continue;
			records.push({
				name: cookie.name,
				value: cookie.value,
				domain: cookie.domain,
				path: cookie.path,
				expires:
					cookie.expires === undefined
						? null
						: new Date(cookie.expires).toISOString(),
				secure: cookie.secure,
				httpOnly: cookie.httpOnly,
				sameSite: cookie.sameSite,
				hostOnly: cookie.hostOnly,
			});
		}
		return records;
	}
	/** forget every cookie, or those a page of `origin` could receive */
	async clear(origin?: string): Promise<void> {
		if (!origin) {
			await this.db.clear(STORE);
			this.onChange?.('');
			return;
		}
		const host = new URL(origin).hostname;
		for (const cookie of (await this.db.getAll(STORE)) as JarCookie[])
			if (coversHost(cookie, host)) await this.db.delete(STORE, cookie.id);
		this.onChange?.(host);
	}
	/**
	 * Apply Set-Cookie values from a response (or a script, when `source` says
	 * so) for `url`, the way RFC 6265bis 5.6 stores them.
	 */
	async set(
		cookies: string | string[],
		url: URL | string,
		source: CookieSource = 'http',
	): Promise<void> {
		url = new URL(url);
		const now = Date.now();

		if (!Array.isArray(cookies)) {
			cookies = [cookies];
		}

		for (const header of cookies) {
			const cookie = parseCookie(header, url, this.#publicSuffix, {
				source,
				now,
			});
			if (!cookie) continue;

			// "leave secure cookies alone": an insecure origin cannot replace or
			// shadow a Secure cookie of the same name whose domain and path
			// would cover it (RFC 6265bis 5.6 step 21)
			if (!isSecureURL(url)) {
				const siblings = (await this.db.getAllFromIndex(
					STORE,
					'name',
					cookie.name,
				)) as JarCookie[];
				if (
					siblings.some(
						(existing) =>
							existing.secure &&
							(domainMatches(cookie.domain, existing.domain) ||
								domainMatches(existing.domain, cookie.domain)) &&
							pathMatches(cookie.path, existing.path),
					)
				)
					continue;
			}

			const existing = (await this.db.get(STORE, cookie.id)) as
				JarCookie | undefined;
			// a script neither replaces nor deletes an HttpOnly cookie
			if (existing?.httpOnly && source === 'script') continue;
			if (expired(cookie, now)) {
				// Max-Age=0 or a past Expires: the site is deleting it
				await this.db.delete(STORE, cookie.id);
				this.onChange?.(cookie.domain);
				continue;
			}
			// Chrome keeps the old creation time only when the value is
			// unchanged; a new value moves the cookie to the end of its path's
			// group in the Cookie header (RFC 6265bis 5.7 would always keep it)
			if (existing?.value === cookie.value) cookie.created = existing.created;
			else {
				cookie.created = Math.max(now, this.#lastCreated + 1);
				this.#lastCreated = cookie.created;
			}
			await this.db.put(STORE, cookie);
			this.onChange?.(cookie.domain);
		}
	}
}

declare const clients: Clients | undefined;

/**
 * Tell every window the jar changed for `domain`, so the documents it
 * covers drop their document.cookie cache. Sent before the response that
 * carried the Set-Cookie is answered, so the page's next read is fresh.
 */
async function broadcastChange(domain: string) {
	if (typeof clients === 'undefined') return;
	const windows = await clients.matchAll({
		type: 'window',
		includeUncontrolled: true,
	});
	const change: CookiesChange = { domain };
	for (const client of windows)
		client.postMessage({ [COOKIES_CHANGED]: change });
}

/**
 * A record of the version 1 jar (two stores, Date expiry, raw Domain
 * attribute, no hostOnly flag) brought to the current shape. Its domain
 * cannot tell host-only from a dotless Domain attribute, so it stays a
 * domain cookie, which is what the old matching did with it.
 */
function migrateLegacy(
	record: Record<string, unknown>,
	session: boolean,
	now: number,
): JarCookie {
	const domain = String(record.domain ?? '')
		.replace(/^\./, '')
		.toLowerCase();
	const expires = session
		? undefined
		: new Date(record.expires as string | number | Date).getTime();
	const sameSite = String(record.sameSite ?? '').toLowerCase() as SameSite;
	const name = String(record.name ?? '');
	const path = String(record.path ?? '/');
	return {
		id: cookieID(domain, path, name),
		name,
		value: String(record.value ?? ''),
		domain,
		hostOnly: false,
		path,
		secure: !!record.secure,
		httpOnly: !!record.httpOnly,
		sameSite: SAME_SITES.includes(sameSite) ? sameSite : 'lax',
		expires: Number.isNaN(expires) ? undefined : expires,
		created: now,
	};
}

/**
 * The jar, opened once per scope (createServer shares it between the
 * controllers of a scope: a controller is a tab, and tabs share cookies).
 */
export async function openCookies(): Promise<Cookies> {
	// loaded here, not at the top: see PublicSuffix
	const { getPublicSuffix } = await import('tldts');
	const db = await openDB('stompCookies', 2, {
		upgrade: async (db, oldVersion, _newVersion, tx) => {
			// nothing but the stores' own requests may be awaited in here (an
			// IndexedDB transaction commits during any foreign await)
			const legacy: JarCookie[] = [];
			const now = Date.now();
			if (oldVersion === 1) {
				for (const [name, session] of [
					['cookies', false],
					['sessionCookies', true],
				] as const)
					for (const record of await tx.objectStore(name).getAll())
						legacy.push(migrateLegacy(record, session, now));
				db.deleteObjectStore('cookies');
				db.deleteObjectStore('sessionCookies');
			}
			const store = db.createObjectStore(STORE, { keyPath: 'id' });
			// requests read the candidate domains of their host; an insecure
			// Set-Cookie looks up the Secure cookies of its name
			store.createIndex('domain', 'domain');
			store.createIndex('name', 'name');
			for (const cookie of legacy) await store.put(cookie);
		},
	});

	// session cookies (no expiry) stay until clear(): the service worker is
	// restarted whenever the browser idles it, which is not the end of the
	// user's session

	const cookies = new Cookies(db, (host) =>
		getPublicSuffix(host, { allowPrivateDomains: true }),
	);
	cookies.onChange = (domain) => {
		broadcastChange(domain);
	};

	return cookies;
}

/** the page-facing routes of a server, over the scope's jar */
export function registerCookies(router: Router, cookies: Cookies): Cookies {
	// what page script may see: the jar without its HttpOnly cookies (the
	// request path and the host's cookies API get the whole jar)
	router.routes.set(
		/^\/cookies\/get$/,
		jsonAPI(async (url: string, context?: CookieRequestContext) =>
			forScript(await cookies.get(url, context)),
		),
	);
	router.routes.set(/^\/cookies\/set$/, jsonAPI(cookies.set.bind(cookies)));

	return cookies;
}

/** the cookies page script may see: HttpOnly ones never reach it */
export function forScript<T extends { httpOnly: boolean }>(cookies: T[]): T[] {
	return cookies.filter((cookie) => !cookie.httpOnly);
}
