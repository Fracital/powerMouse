// The service worker's cookie jar. Storage and matching follow RFC 6265bis
// the way a browser does: a cookie set without Domain is host-only, Domain
// matches by label and never a public suffix, paths match on a boundary,
// Secure cookies go to secure URLs only and an insecure origin cannot touch
// them, the __Host-, __Secure-, __Http- and __Host-Http- prefixes are
// enforced, oversize cookies and lines with a control character are
// refused, SameSite is evaluated against the request's site when the
// caller says what it is, and the Cookie header lists longer paths first,
// then earlier creations (a re-set with a new value is a new creation, as
// in Chrome). The matching functions are exported on their own so they can
// be checked in node (cookie-rules suite).
import { openDB, type IDBPDatabase } from 'idb';
import { pastASCII, utf8Bytes, utf8Text } from '../byteString';
import { JAR_TURN_COOKIE } from '../encodeCookie';
import { ephemeralKey, registrableDomain } from '../partition';
import {
	CookieRecord,
	COOKIES_CHANGED,
	CookiesChange,
	JAR_WRITES,
} from '../transport/messages';
import { JAR_DATABASE, JAR_STORE, type JarDB, type RemoteJar } from './jarDB';
import Router, { json, jsonAPI } from './Router';
import { windowURL } from './windowURLs';

export type SameSite = 'lax' | 'strict' | 'none';

/** how an emulated service worker's writes name their sender (src/inject/worker/modules/ServiceWorkerGlobal.ts) */
const WORKER_SENDER = 'sw-';

/** a new value of JAR_TURN_COOKIE, in the real jar of the proxy origin */
async function turnJar(): Promise<void> {
	if (typeof cookieStore === 'undefined') return;
	try {
		// as the bridge's answers are set: a frame of the proxy origin in
		// isolation mode is a cross-site embed, which sees no other
		await cookieStore.set({
			name: JAR_TURN_COOKIE,
			value: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			expires: Date.now() + 10 * 60e3,
			path: '/',
			sameSite: 'none',
		});
	} catch (error) {
		// no real jar to tell: documents hear of it by message, as before
	}
}

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
	/**
	 * set without a SameSite attribute (`sameSite` is then lax): the Cookie
	 * Store API reports no sameSite for it once it is deleted
	 */
	sameSiteDefault?: boolean;
	/**
	 * set with Partitioned (CHIPS): kept apart from the unpartitioned cookie
	 * of the same name, and per top-level site (see partitionKey)
	 */
	partitioned?: boolean;
	/**
	 * A Partitioned cookie's top-level site when it was set in a context
	 * whose top-level site is not the cookie URL's own (a site framed by
	 * another, or a top-level page's request to another site); none when it
	 * is that site (src/partition.ts). The jar of every STomp before this
	 * one has none on any cookie, which reads as set first-party, as it was.
	 */
	partitionKey?: string;
	/** ms since the epoch; a session cookie has none */
	expires?: number;
	/** ms since the epoch; kept across re-sets (RFC 6265 5.3 step 11) */
	created: number;
	/**
	 * Set by a Set-Cookie whose bytes are not UTF-8: `name` and `value` are
	 * those bytes, a character each, where any other cookie's are text (a
	 * script's, or a response's bytes decoded as UTF-8, as Chrome reads
	 * them). Chrome shows no document.cookie at all while one is among the
	 * cookies it would show, and an empty name or value for the part the
	 * Cookie Store API cannot read as text
	 */
	bytes?: boolean;
}

/**
 * A Cookie Store API write (`cookieStore.set`, or `delete` with an expiry
 * in the past) the inject validated with the browser's messages: always
 * Secure, a null domain for a host-only cookie
 */
export interface CookieStoreWrite {
	name: string;
	value: string;
	domain: string | null;
	path: string;
	sameSite: SameSite;
	partitioned: boolean;
	/** ms since the epoch, or null for a session cookie */
	expires: number | null;
}

/** the name the inject bundle imports the stored shape under */
export type FloatingCookie = JarCookie;

/** who is setting the cookie: a script cannot set or replace HttpOnly ones */
export type CookieSource = 'http' | 'script';

/**
 * The public suffix of a host (tldts `getPublicSuffix` with the private list,
 * so github.io counts), or null for an IP. Passed in rather than imported:
 * the inject bundles share this module for `BrowserCookieArray`, and a
 * static import of src/suffix.ts would carry tldts and its 100 KB list into
 * every worker.
 */
export type PublicSuffix = (host: string) => string | null;

export interface ParseOptions {
	source?: CookieSource;
	now?: number;
	/** the context's partition key (CookieRequestContext.partitionKey) */
	partitionKey?: string;
	/**
	 * The response is to a request whose site for cookies is another site
	 * and that is not a top-level navigation (a subresource or a frame's
	 * document under another site's page): Chrome keeps no SameSite=Lax or
	 * Strict cookie it sets
	 */
	crossSite?: boolean;
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
	/**
	 * The request's top-level site when it is not the site of the URL
	 * (src/partition.ts siteOf): the partition whose Partitioned cookies the
	 * request carries. None (a first-party context, or a caller that does
	 * not know) carries those set first-party.
	 */
	partitionKey?: string;
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

/**
 * a part of a Cookie Store API cookie Chrome refuses as malformed: one with a
 * CTL character (a tab included) or a `;`
 */
export function malformedPart(text: string): boolean {
	return hasControlCharacter(text) || text.includes('\t') || text.includes(';');
}

export function isIP(host: string): boolean {
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

function cookieID(
	domain: string,
	path: string,
	name: string,
	partitioned = false,
	partitionKey?: string,
): string {
	const id = [domain, path, name]
		.map((value) => JSON.stringify(value))
		.join('@@');
	if (!partitioned) return id;
	// a first-party partition keeps the id every earlier jar gave it
	return partitionKey === undefined
		? `${id}@@partitioned`
		: `${id}@@partitioned@@${JSON.stringify(partitionKey)}`;
}

/**
 * A Partitioned cookie is sent in its own partition only, and so is every
 * cookie of a credentialless frame's partition (partition.ts ephemeralKey),
 * which is sent no other cookie
 */
function partitionAllows(
	cookie: JarCookie,
	context: CookieRequestContext,
): boolean {
	return cookie.partitioned ||
		ephemeralKey(cookie.partitionKey) ||
		ephemeralKey(context.partitionKey)
		? cookie.partitionKey === context.partitionKey
		: true;
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
		sameSiteAllows(cookie, context) &&
		partitionAllows(cookie, context)
	);
}

/** RFC 6265 5.4 step 2: longer paths first, then earlier creation */
export function compareCookies(a: JarCookie, b: JarCookie): number {
	return b.path.length - a.path.length || a.created - b.created;
}

function expired(cookie: JarCookie, now: number): boolean {
	return cookie.expires !== undefined && cookie.expires <= now;
}

/** one Set-Cookie value's parts, as parseSetCookie reads them */
interface ParsedCookie {
	name: string;
	value: string;
	expires?: Date;
	maxAge?: number;
	domain?: string;
	path?: string;
	secure?: true;
	httpOnly?: true;
	sameSite?: string;
	partitioned?: true;
}

/** a string without the spaces and tabs at its ends (RFC 6265 WSP) */
function trimWsp(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && (text[start] === ' ' || text[start] === '\t')) start++;
	while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t'))
		end--;
	return text.slice(start, end);
}

/**
 * One Set-Cookie value's name, value and the attributes the jar reads, as
 * set-cookie-parser 3 read them with `decodeValues: false` (which the jar
 * used until this): the pair is what comes before the first `;` (none when
 * it is empty or white space), split at its first `=` (a pair without one is
 * a value with no name) and trimmed of spaces and tabs; an attribute's name
 * is what comes before its first `=`, trimmed and in lower case, its value
 * the rest, trimmed; the last of a name counts, but an Expires that is no
 * date and a Max-Age that is not an integer are skipped. Unlike that
 * parser, a cookie named as one of Object.prototype's members (constructor,
 * toString, __proto__) is kept, as Chrome keeps it.
 */
function parseSetCookie(header: string): ParsedCookie | null {
	const [pair, ...attributes] = header.split(';');
	if (!pair.trim()) return null;
	const eq = pair.indexOf('=');
	const cookie: ParsedCookie = {
		name: eq < 0 ? '' : trimWsp(pair.slice(0, eq)),
		value: trimWsp(eq < 0 ? pair : pair.slice(eq + 1)),
	};
	for (const attribute of attributes) {
		const at = attribute.indexOf('=');
		const key = (at < 0 ? attribute : attribute.slice(0, at))
			.trim()
			.toLowerCase();
		const value = at < 0 ? '' : attribute.slice(at + 1).trim();
		if (key === 'expires') {
			const expires = new Date(value);
			if (!Number.isNaN(expires.getTime())) cookie.expires = expires;
		} else if (key === 'max-age') {
			if (/^-?\d+$/.test(value)) cookie.maxAge = parseInt(value, 10);
		} else if (key === 'secure') cookie.secure = true;
		else if (key === 'httponly') cookie.httpOnly = true;
		else if (key === 'samesite') cookie.sameSite = value;
		else if (key === 'partitioned') cookie.partitioned = true;
		else if (key === 'domain') cookie.domain = value;
		else if (key === 'path') cookie.path = value;
	}
	return cookie;
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
	{
		source = 'http',
		now = Date.now(),
		partitionKey,
		crossSite = false,
	}: ParseOptions = {},
): JarCookie | null {
	// Chrome's HTTP parser ends a header at a bare CR or LF and reads a NUL
	// as a space (a transport hands the raw value over); anywhere else in the
	// line, a control character (in the name, the value or any attribute)
	// drops the whole cookie, not just the attribute
	// and a cookie is its bytes there, which a script reads as UTF-8 text:
	// the transport hands them over a byte a character
	let bytes = false;
	if (source === 'http') {
		header = header.split(/[\r\n]/, 1)[0].replaceAll('\0', ' ');
		if (/[\x80-\xff]/.test(header)) {
			const text = utf8Text(header);
			if (text === null) bytes = true;
			else header = text;
		}
	}
	if (hasControlCharacter(header)) return null;
	// the limits count bytes
	const size = (text: string) =>
		bytes ? text.length : encoder.encode(text).length;
	// an oversize attribute is skipped as if it were absent, so an earlier
	// Path or Domain of the same name still counts
	const [pair, ...attributes] = header.split(';');
	header = [
		pair,
		...attributes.filter((attribute) => {
			const eq = attribute.indexOf('=');
			return (
				eq < 0 || size(attribute.slice(eq + 1).trim()) <= MAX_ATTRIBUTE_BYTES
			);
		}),
	].join(';');
	// one Set-Cookie value (or one document.cookie write) is one cookie: a
	// comma belongs to the value, it does not start another cookie
	const parsed = parseSetCookie(header);
	if (!parsed) return null;
	const { name, value } = parsed;
	if (name === '' && value === '') return null;
	if (size(name) + size(value) > MAX_COOKIE_BYTES) return null;

	const secure = !!parsed.secure;
	const httpOnly = !!parsed.httpOnly;
	if (secure && !isSecureURL(url)) return null;
	if (httpOnly && source === 'script') return null;

	const host = url.hostname;
	let domain = host;
	let hostOnly = true;
	const attribute = (parsed.domain ?? '').replace(/^\./, '').toLowerCase();
	if (attribute !== '') {
		// a domain that is neither the host nor a name above it is refused
		// whatever the list says of it, so the list is asked only about the
		// host's own names (which a document's shell answers:
		// src/inject/sites.ts)
		if (!domainMatches(host, attribute)) return null;
		// a cookie for a whole public suffix (com, co.uk, github.io) would be
		// a supercookie; one for the host itself is just host-only
		const suffix = isIP(attribute) ? null : publicSuffix(attribute);
		if (suffix === attribute) {
			if (attribute !== host) return null;
		} else {
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
	if (name === '' && /^__(secure|host|http)-/i.test(value)) return null;
	if (lowerName.startsWith('__secure-') && !secure) return null;
	// (a Domain that names the IP address the cookie is for is no domain:
	// Chrome keeps a __Host- cookie with one, measured)
	const ipHost = isIP(host) && attribute === host;
	if (
		lowerName.startsWith('__host-') &&
		(!secure ||
			(!hostOnly && !ipHost) ||
			(attribute !== '' && !ipHost) ||
			path !== '/')
	)
		return null;
	// __Http- and __Host-Http-: only a response's HttpOnly cookie (Chrome
	// 157, measured: a script's write and one without HttpOnly are dropped)
	if (/^__(host-)?http-/.test(lowerName) && (!secure || !httpOnly)) return null;

	const sameSiteAttribute = parsed.sameSite?.toLowerCase();
	const sameSiteDefault = !SAME_SITES.includes(sameSiteAttribute as SameSite);
	const sameSite: SameSite = sameSiteDefault
		? 'lax'
		: (sameSiteAttribute as SameSite);
	if (sameSite === 'none' && !secure) return null;
	// a document in a partition is under another site's page or frame, and
	// Chrome keeps no SameSite=Lax or Strict cookie its script writes there,
	// nor one a response sets in a cross-site context
	if (
		sameSite !== 'none' &&
		(crossSite || (source === 'script' && partitionKey !== undefined))
	)
		return null;
	// Chrome refuses a Partitioned cookie that is not Secure
	const partitioned = !!parsed.partitioned;
	if (partitioned && !secure) return null;
	if (!partitioned && !ephemeralKey(partitionKey)) partitionKey = undefined;

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
		id: cookieID(
			domain,
			path,
			name,
			partitioned || partitionKey !== undefined,
			partitionKey,
		),
		name,
		value,
		domain,
		hostOnly,
		path,
		secure,
		httpOnly,
		sameSite,
		...(sameSiteDefault ? { sameSiteDefault } : {}),
		...(partitioned ? { partitioned } : {}),
		...(partitionKey !== undefined ? { partitionKey } : {}),
		expires,
		created: now,
		...(bytes ? { bytes } : {}),
	};
}

/**
 * The cookie a Cookie Store API write stores for a document at `url`, or
 * null when a browser would refuse it. The inject refuses everything below
 * first, with the browser's errors; this is the jar's own guard.
 */
export function storeCookie(
	write: CookieStoreWrite,
	url: URL,
	publicSuffix: PublicSuffix,
	now = Date.now(),
	partitionKey?: string,
): JarCookie | null {
	if (typeof write !== 'object' || write === null || !isSecureURL(url))
		return null;
	const { name, value, path, sameSite } = write;
	let expires: number | undefined;
	if (write.expires !== null) {
		expires = Number(write.expires);
		if (!Number.isFinite(expires)) return null;
		expires = Math.min(Math.max(0, expires), now + MAX_AGE_MS);
	}
	if (
		typeof name !== 'string' ||
		typeof value !== 'string' ||
		typeof path !== 'string' ||
		!SAME_SITES.includes(sameSite) ||
		// a deletion names the cookie only
		(name === '' &&
			value === '' &&
			!(expires !== undefined && expires <= now)) ||
		name.includes('=') ||
		malformedPart(name + value + path) ||
		!path.startsWith('/') ||
		encoder.encode(name).length + encoder.encode(value).length >
			MAX_COOKIE_BYTES ||
		encoder.encode(path).length > MAX_ATTRIBUTE_BYTES
	)
		return null;
	const host = url.hostname;
	let domain = host;
	let hostOnly = true;
	if (write.domain !== null) {
		const attribute = String(write.domain).toLowerCase();
		if (
			attribute.startsWith('.') ||
			!domainMatches(host, attribute) ||
			(!isIP(attribute) && publicSuffix(attribute) === attribute)
		)
			return null;
		domain = attribute;
		hostOnly = false;
	}
	if (/^__host-/i.test(name) && (!hostOnly || path !== '/')) return null;
	// a script's cookie is never HttpOnly, which these need
	if (/^__(host-)?http-/i.test(name)) return null;
	// in a partition, as for a script's Set-Cookie string (parseCookie)
	if (partitionKey !== undefined && sameSite !== 'none') return null;
	const partitioned = !!write.partitioned;
	const key =
		partitioned || ephemeralKey(partitionKey) ? partitionKey : undefined;
	return {
		id: cookieID(domain, path, name, key !== undefined || partitioned, key),
		name,
		value,
		domain,
		hostOnly,
		path,
		secure: true,
		httpOnly: false,
		sameSite,
		...(partitioned ? { partitioned } : {}),
		...(key !== undefined ? { partitionKey: key } : {}),
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
			// Chrome reads the whole line as UTF-8, and has none when one
			// cookie's bytes are not
			if (cookie.bytes) return '';
			// a nameless cookie travels as its bare value, like in a browser
			result.push(
				cookie.name === '' ? cookie.value : `${cookie.name}=${cookie.value}`,
			);
		}

		return result.join('; ');
	}

	/**
	 * The Cookie header's value, as its bytes, a character each: a cookie's
	 * text goes as its UTF-8, as the browser sends it, and one that is bytes
	 * already as it is. (Headers holds no character past U+00FF: as text,
	 * one a script wrote failed every request of its site.) The transport
	 * worker hands the bytes to the transport as it takes them
	 * (src/transport/serveTransport.ts fitHeaders)
	 */
	header() {
		const result: string[] = [];
		for (const cookie of this) {
			const text =
				cookie.name === '' ? cookie.value : `${cookie.name}=${cookie.value}`;
			result.push(cookie.bytes || !pastASCII(text) ? text : utf8Bytes(text));
		}
		return result.join('; ');
	}
}

const STORE = JAR_STORE;

/**
 * How long a document's script write sent asynchronously waits for the one
 * it made before (whose request may have failed), and how long a read of the
 * jar waits for the asynchronous writes the worker heard of. A cookie write
 * is small, so either is long only when a request was lost.
 */
const ORDER_WAIT_MS = 3e3;
const SETTLE_WAIT_MS = 3e3;
/** how long a document's place in its asynchronous writes is kept when idle */
const TURNS_KEPT_MS = 5 * 60e3;

interface Turns {
	next: number;
	waiting: Map<number, () => void>;
	active: number;
	idle: number | null;
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** a partition key a page sent: a site string, or none */
function partitionKeyOf(key: unknown): string | undefined {
	return typeof key === 'string' && key !== '' ? key : undefined;
}

export default class Cookies {
	private db: JarDB;
	#publicSuffix: PublicSuffix;
	/** called after the jar changed for a domain ('' for every host) */
	onChange?: (domain: string) => void;
	/** the last creation time handed out, so two sets in one ms keep their order */
	#lastCreated = 0;
	/** each document's next asynchronous script write */
	#turns = new Map<string, Turns>();
	/** the asynchronous script writes the worker heard of and has not done */
	#heard = new Set<Promise<void>>();
	constructor(db: JarDB, publicSuffix: PublicSuffix) {
		this.db = db;
		this.#publicSuffix = publicSuffix;
	}
	/**
	 * A document.cookie write the synchronous bridge could not carry (its
	 * beacon was refused: the page's own beacons held the quota), sent with
	 * fetch instead. Its sender, number and the oldest the sender has in
	 * flight (`base`) ride in the URL and its arguments in the body: every
	 * read of the jar waits for it from the moment its request arrives, so a
	 * request the page makes after the write carries it, and a document's
	 * writes are applied in the order it made them.
	 */
	async ordered(request: Request): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const sender = params.get('sender');
		const seq = Number(params.get('seq'));
		const base = Number(params.get('base'));
		if (sender === null || !Number.isInteger(seq) || !Number.isInteger(base))
			return json(400, 'not an ordered cookie write');
		const body = request.json() as Promise<
			[string | CookieStoreWrite, string, string | undefined]
		>;
		body.catch(() => {});
		const finished = this.#inTurn(sender, seq, base, async () => {
			const [value, url, partitionKey] = await body;
			// a Cookie Store API write, or a document.cookie string
			if (typeof value === 'object' && value !== null)
				await this.store(value, String(url), partitionKey);
			else await this.set(String(value), String(url), 'script', partitionKey);
		});
		this.#heard.add(finished);
		const forget = () => this.#heard.delete(finished);
		finished.then(forget, forget);
		try {
			await finished;
			// an emulated service worker's write: every document reads the jar
			// again at its next document.cookie, even one spinning on the
			// bridge (JAR_TURN_COOKIE)
			if (sender.startsWith(WORKER_SENDER)) await turnJar();
			return json(200, null);
		} catch (error) {
			return json(500, String(error));
		}
	}
	async #inTurn(
		sender: string,
		seq: number,
		base: number,
		apply: () => Promise<void>,
	): Promise<void> {
		const now = Date.now();
		for (const [other, turns] of this.#turns)
			if (turns.idle !== null && now - turns.idle > TURNS_KEPT_MS)
				this.#turns.delete(other);
		let turns = this.#turns.get(sender);
		if (!turns) {
			turns = { next: base, waiting: new Map(), active: 0, idle: null };
			this.#turns.set(sender, turns);
		}
		const own = turns;
		own.next = Math.max(own.next, base);
		own.active++;
		own.idle = null;
		try {
			if (seq > own.next)
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						own.waiting.delete(seq);
						resolve();
					}, ORDER_WAIT_MS);
					own.waiting.set(seq, () => {
						clearTimeout(timer);
						resolve();
					});
				});
			await apply();
		} finally {
			own.next = Math.max(own.next, seq + 1);
			const wake = own.waiting.get(own.next);
			own.waiting.delete(own.next);
			wake?.();
			if (!--own.active) own.idle = Date.now();
		}
	}
	/** the asynchronous script writes the worker heard of are done, or late */
	async #settled(): Promise<void> {
		if (!this.#heard.size) return;
		await Promise.race([
			Promise.allSettled([...this.#heard]),
			sleep(SETTLE_WAIT_MS),
		]);
	}
	/** the cookies a request to `url` carries, in Cookie header order */
	async get(
		url: string | URL,
		context: CookieRequestContext = {},
	): Promise<BrowserCookieArray> {
		url = new URL(url);
		await this.#settled();
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
		await this.#settled();
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
	 * Clear-Site-Data "cookies" in a response of `url`: the cookies of its
	 * site (its registrable domain and every host under it), unpartitioned
	 * or in the partition of the context that got the response
	 * (`partitionKey`, none for a first-party one)
	 */
	async clearSite(url: URL, partitionKey?: string): Promise<void> {
		const site = registrableDomain(url.hostname, this.#publicSuffix);
		let changed = false;
		for (const cookie of (await this.db.getAll(STORE)) as JarCookie[]) {
			if (cookie.domain !== site && !cookie.domain.endsWith(`.${site}`))
				continue;
			if (
				(cookie.partitioned || cookie.partitionKey !== undefined) &&
				cookie.partitionKey !== partitionKey
			)
				continue;
			await this.db.delete(STORE, cookie.id);
			changed = true;
		}
		if (changed) this.onChange?.(site);
	}
	/** apply a Cookie Store API write of a document at `url` (in `partitionKey`'s partition) */
	async store(
		write: CookieStoreWrite,
		url: URL | string,
		partitionKey?: string,
	): Promise<void> {
		url = new URL(url);
		const now = Date.now();
		const cookie = storeCookie(
			write,
			url,
			this.#publicSuffix,
			now,
			partitionKeyOf(partitionKey),
		);
		if (cookie) await this.#put(cookie, 'script', now);
	}
	/**
	 * Apply Set-Cookie values from a response (or a script, when `source` says
	 * so) for `url`, the way RFC 6265bis 5.6 stores them; a Partitioned one in
	 * `partitionKey`'s partition (CookieRequestContext.partitionKey), and a
	 * response in a cross-site context sets no SameSite=Lax or Strict one
	 * (ParseOptions.crossSite).
	 */
	async set(
		cookies: string | string[],
		url: URL | string,
		source: CookieSource = 'http',
		partitionKey?: string,
		crossSite = false,
		// what each cookie did to the jar: its id and the cookie as stored,
		// or null when it deleted one (none for a cookie the jar refused)
		outcomes?: [string, JarCookie | null][],
	): Promise<void> {
		partitionKey = partitionKeyOf(partitionKey);
		url = new URL(url);
		const now = Date.now();

		if (!Array.isArray(cookies)) {
			cookies = [cookies];
		}

		for (const header of cookies) {
			const cookie = parseCookie(header, url, this.#publicSuffix, {
				source,
				now,
				partitionKey,
				crossSite,
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

			const stored = await this.#put(cookie, source, now);
			if (stored !== undefined) outcomes?.push([cookie.id, stored]);
		}
	}
	/**
	 * store `cookie`, or delete it when it is expired: the cookie as stored,
	 * null for a deletion, undefined when nothing changed
	 */
	async #put(
		cookie: JarCookie,
		source: CookieSource,
		now: number,
	): Promise<JarCookie | null | undefined> {
		const existing = (await this.db.get(STORE, cookie.id)) as
			JarCookie | undefined;
		// a script neither replaces nor deletes an HttpOnly cookie
		if (existing?.httpOnly && source === 'script') return;
		if (expired(cookie, now)) {
			// Max-Age=0 or a past Expires: the site is deleting it
			await this.db.delete(STORE, cookie.id);
			this.onChange?.(cookie.domain);
			return null;
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
		return cookie;
	}
}

declare const clients: Clients | undefined;

const jarListeners = new Set<(domain: string) => void>();
/** hear every change of the jar (the emulated service workers' cookie change subscriptions) */
export function onJarChange(listener: (domain: string) => void) {
	jarListeners.add(listener);
}

/** the broadcasts of changes not yet posted to every window (changesTold) */
const telling = new Set<Promise<void>>();

/**
 * Tell the windows the jar changed for `domain`, so the documents it
 * covers drop their document.cookie cache. Started before the response
 * that carried the Set-Cookie is answered, and a navigation's answer waits
 * until it is posted (changesTold), so the page's next read is fresh.
 * A window whose document is of a host the cookies of `domain` are not for
 * is not told (the page's Cookies module would drop the message): see
 * windowURL.
 */
function broadcastChange(domain: string) {
	if (typeof clients === 'undefined') return;
	const told = postChange(domain).catch(() => {});
	telling.add(told);
	void told.finally(() => telling.delete(told));
}

/**
 * Settles once every change of the jar so far is posted to the windows, or
 * after `ms`. A navigation whose response changed the jar is answered then:
 * natively the jar has the cookies before the document is seen, and a
 * sibling frame that reads document.cookie at the frame's load must read
 * them (cookie-cache). The new document tells no other of the change (a
 * fetch's inject does, JAR_MARKER), so the message is their only word of
 * it, and it reached them after the frame had loaded when the answer went
 * out first.
 */
export function changesTold(ms: number): Promise<void> {
	if (!telling.size) return Promise.resolve();
	return Promise.race([
		Promise.all(telling).then(() => {}),
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
	]);
}

async function postChange(domain: string) {
	if (typeof clients === 'undefined') return;
	const windows = await clients.matchAll({
		type: 'window',
		includeUncontrolled: true,
	});
	const change: CookiesChange = { domain };
	for (const client of windows) {
		const host = domain === '' ? null : windowURL(client.url)?.hostname;
		if (host && host !== domain && !host.endsWith(`.${domain}`)) continue;
		client.postMessage({ [COOKIES_CHANGED]: change });
	}
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

/** the most domains a KeptJar keeps the cookies of */
const KEPT_DOMAINS = 4096;

/**
 * The scope's jar database, with each domain's cookies kept as it last
 * answered them until a write. Every request with credentials reads its
 * host's candidate domains (four for img.cdn.example.com), each a round
 * trip to the browser's IndexedDB backend: about a millisecond before the
 * request could leave, and tens of milliseconds behind each other while a
 * page loads hundreds of resources. A write of a cookie forgets what was
 * kept of the cookie's domain (the key of the index the reads go by), and
 * a read that a write of its domain overlapped is not kept, so what is kept
 * of a domain is never older than the last write of it this jar did or
 * heard of. It forgot every domain at every write: an ad-heavy page sets
 * the ad networks' cookies all the time (apnews.com: 2,900 writes in 40 s),
 * so 6,750 of 8,580 reads went to IndexedDB, 3,100 of them overlapped by a
 * write of some other domain. A write of the whole jar (clear) forgets
 * everything. Writers it does not do itself post on JAR_WRITES once they
 * are done, with the domain when they name it (another scope's worker, a
 * worker of the version before this one, which names none, the site
 * pool's jar server); with the site pool on nothing is kept
 * (jarWrittenElsewhere), since a slot's write must be read by the next
 * request whichever worker answers it.
 */
class KeptJar implements JarDB {
	#db: JarDB;
	#kept = new Map<string, unknown[]>();
	/** moves on at the start and the end of every write of the whole jar */
	#generation = 0;
	/** the same for each domain a write of one cookie was of */
	#written = new Map<string, number>();
	#channel: BroadcastChannel | null = null;
	constructor(db: JarDB) {
		this.#db = db;
		try {
			this.#channel = new BroadcastChannel(JAR_WRITES);
			// a writer that names the domain (a KeptJar) or one that does not
			this.#channel.onmessage = ({ data }) =>
				this.#forget(
					data !== null &&
						typeof data === 'object' &&
						typeof data.domain === 'string'
						? data.domain
						: undefined,
				);
		} catch (error) {
			// no BroadcastChannel: nothing that writes elsewhere can be heard
			keepsJar = false;
		}
	}
	/** what is kept of `domain`, or of every domain */
	#forget(domain?: string) {
		if (domain === undefined || this.#written.size >= KEPT_DOMAINS) {
			this.#kept.clear();
			this.#written.clear();
			this.#generation++;
			return;
		}
		this.#kept.delete(domain);
		this.#written.set(domain, (this.#written.get(domain) ?? 0) + 1);
	}
	async #write<T>(
		domain: string | undefined,
		write: () => Promise<T>,
	): Promise<T> {
		this.#forget(domain);
		try {
			return await write();
		} finally {
			this.#forget(domain);
			this.#channel?.postMessage(domain === undefined ? null : { domain });
		}
	}
	async getAllFromIndex(
		store: string,
		index: string,
		key: string,
	): Promise<unknown[]> {
		if (!keepsJar || store !== STORE || index !== 'domain')
			return this.#db.getAllFromIndex(store, index, key);
		const kept = this.#kept.get(key);
		if (kept) return kept;
		const generation = this.#generation;
		const written = this.#written.get(key);
		const found = await this.#db.getAllFromIndex(store, index, key);
		if (
			generation === this.#generation &&
			written === this.#written.get(key) &&
			keepsJar
		) {
			if (this.#kept.size >= KEPT_DOMAINS) this.#kept.clear();
			this.#kept.set(key, found);
		}
		return found;
	}
	getAll(store: string) {
		return this.#db.getAll(store);
	}
	getAllKeys(store: string) {
		return this.#db.getAllKeys(store);
	}
	get(store: string, key: string) {
		return this.#db.get(store, key);
	}
	put(store: string, value: unknown, key?: string) {
		// a cookie (the store's key path is its id)
		return this.#write(
			store === STORE && key === undefined
				? (value as JarCookie).domain
				: undefined,
			() => this.#db.put(store, value, key),
		);
	}
	delete(store: string, key: string) {
		return this.#write(store === STORE ? domainOfID(key) : undefined, () =>
			this.#db.delete(store, key),
		);
	}
	clear(store: string) {
		return this.#write(undefined, () => this.#db.clear(store));
	}
}

/** the domain a cookie's id names (cookieID), or undefined */
function domainOfID(id: string): string | undefined {
	try {
		const domain: unknown = JSON.parse(id.slice(0, id.indexOf('@@')));
		return typeof domain === 'string' ? domain : undefined;
	} catch (error) {
		return undefined;
	}
}

/** whether a service worker's jar keeps what it read (KeptJar) */
let keepsJar = true;

/**
 * The site pool is on for this worker (it is the hub's, or a slot's): the
 * jar is written by other origins' workers through the jar server, and a
 * write of theirs must be seen by the very next request, so nothing read
 * is kept from now on
 */
export function jarWrittenElsewhere() {
	keepsJar = false;
}

let jarDB: Promise<IDBPDatabase<unknown>> | undefined;

/**
 * This origin's jar database, opened once for every scope's jar (and from
 * the handshake's start, while the codec's transaction runs: createServer)
 */
export function openJarDB(): Promise<IDBPDatabase<unknown>> {
	jarDB ??= openDB(JAR_DATABASE, 2, {
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
	jarDB.catch(() => (jarDB = undefined));
	return jarDB;
}

/**
 * The jar, opened once per scope (createServer shares it between the
 * controllers of a scope: a controller is a tab, and tabs share cookies).
 * With `remote` it is the host origin's jar, asked over the host's port
 * (the site pool: a slot's worker, src/server/jarDB.ts), and a change is
 * told to the other slots' workers and heard from them.
 */
export async function openCookies(
	// passed in, not imported (see PublicSuffix): a dynamic import here made
	// esbuild wrap every module of the inject bundles, which share this file,
	// in a lazy initializer that each module called at its start
	publicSuffix: PublicSuffix,
	remote?: RemoteJar,
): Promise<Cookies> {
	if (remote) {
		const cookies = new Cookies(remote, publicSuffix);
		const heard = (domain: string) => {
			broadcastChange(domain);
			for (const listener of jarListeners) listener(domain);
		};
		cookies.onChange = (domain) => {
			heard(domain);
			remote.changed(domain);
		};
		remote.onChanged = heard;
		return cookies;
	}
	const db = await openJarDB();

	// session cookies (no expiry) stay until clear(): the service worker is
	// restarted whenever the browser idles it, which is not the end of the
	// user's session

	const cookies = new Cookies(
		new KeptJar(db as unknown as JarDB),
		publicSuffix,
	);
	cookies.onChange = (domain) => {
		broadcastChange(domain);
		for (const listener of jarListeners) listener(domain);
	};

	return cookies;
}

/** the page-facing routes of a server, over the scope's jar */
export function registerCookies(router: Router, cookies: Cookies): Cookies {
	// what page script may see: the jar without its HttpOnly cookies (the
	// request path and the host's cookies API get the whole jar)
	router.routes.set(
		/^\/cookies\/get$/,
		jsonAPI(async (url: string, context?: CookieRequestContext | null) =>
			forScript(await cookies.get(url, context ?? {})),
		),
	);
	router.routes.set(
		/^\/cookies\/set$/,
		jsonAPI(
			async (
				value: string | string[],
				url: string,
				source?: CookieSource,
				partitionKey?: string | null,
				// a document's own write: what it did to the jar, which the
				// document applies to what it knows, so its next read of
				// document.cookie needs no round trip of its own
				outcomes?: boolean,
			) => {
				const done: [string, JarCookie | null][] | undefined = outcomes
					? []
					: undefined;
				await cookies.set(
					value,
					url,
					source,
					partitionKey ?? undefined,
					false,
					done,
				);
				return done;
			},
		),
	);
	router.routes.set(/^\/cookies\/ordered$/, (request) =>
		cookies.ordered(request),
	);

	return cookies;
}

/** the cookies page script may see: HttpOnly ones never reach it */
export function forScript<T extends { httpOnly: boolean }>(cookies: T[]): T[] {
	return cookies.filter((cookie) => !cookie.httpOnly);
}
