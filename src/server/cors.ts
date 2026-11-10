// The browser's CORS protocol, applied by the service worker to the real
// origins. Every proxied site shares the proxy's one real origin, so to the
// browser every proxied request is same-origin: it never preflights, never
// checks Access-Control-Allow-Origin and hands the page every response whole.
// The worker knows the request's mode, credentials mode and real initiator,
// so it does what the browser would have done between the real origins
// (https://fetch.spec.whatwg.org/#http-cors-protocol), the way Chrome does it.

/** CORS-safelisted methods: never preflighted */
const SIMPLE_METHODS = ['GET', 'HEAD', 'POST'];

/** CORS-safelisted response header names: what a cors response always exposes */
const SAFELISTED_RESPONSE = [
	'cache-control',
	'content-language',
	'content-length',
	'content-type',
	'expires',
	'last-modified',
	'pragma',
];

const SAFELISTED_CONTENT_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
];

// bytes no safelisted request header value may hold
// (https://fetch.spec.whatwg.org/#cors-unsafe-request-header-byte)
// eslint-disable-next-line no-control-regex
const UNSAFE_BYTES = /[\x00-\x08\x0a-\x1f"():<>?@[\\\]{}\x7f]/;

/**
 * Whether one request header is CORS-safelisted
 * (https://fetch.spec.whatwg.org/#cors-safelisted-request-header)
 */
function safelisted(name: string, value: string): boolean {
	if (value.length > 128) return false;
	switch (name) {
		case 'accept':
			return !UNSAFE_BYTES.test(value);
		case 'accept-language':
		case 'content-language':
			return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
		case 'content-type': {
			if (UNSAFE_BYTES.test(value)) return false;
			const essence = value.split(';')[0].trim().toLowerCase();
			return SAFELISTED_CONTENT_TYPES.includes(essence);
		}
		case 'range':
			return /^bytes=\d+-\d*$/.test(value);
		default:
			return false;
	}
}

/**
 * The page's request headers that are not CORS-safelisted, lowercase and
 * sorted (the Access-Control-Request-Headers of a preflight); `ignore` names
 * headers that are not the page's (the proxy's own, the browser's)
 */
export function unsafeHeaderNames(
	headers: Headers,
	ignore: (name: string) => boolean,
): string[] {
	const unsafe = new Set<string>();
	let safelistedLength = 0;
	for (const [name, value] of headers) {
		if (ignore(name)) continue;
		if (safelisted(name, value)) safelistedLength += value.length;
		else unsafe.add(name);
	}
	// past 1024 bytes of safelisted values, each of them needs the preflight
	if (safelistedLength > 1024)
		for (const [name] of headers) if (!ignore(name)) unsafe.add(name);
	return [...unsafe].sort();
}

/** whether a request needs a preflight before it is sent */
export function needsPreflight(method: string, unsafe: string[]): boolean {
	return !SIMPLE_METHODS.includes(method) || unsafe.length > 0;
}

/**
 * The CORS check (https://fetch.spec.whatwg.org/#cors-check): whether a
 * response of another origin lets `origin` read it. A request with
 * credentials needs its own origin named and Allow-Credentials true; `*` is
 * not taken there. More than one value is no value
 */
export function corsCheck(
	headers: Headers,
	origin: string,
	credentials: boolean,
): boolean {
	const allowOrigin = headers.get('access-control-allow-origin');
	if (allowOrigin === null) return false;
	if (allowOrigin === '*' && !credentials) return true;
	if (allowOrigin !== origin) return false;
	if (!credentials) return true;
	return headers.get('access-control-allow-credentials') === 'true';
}

/** a comma list header as its trimmed, non-empty items */
function list(value: string | null): string[] {
	if (value === null) return [];
	return value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '');
}

/**
 * The headers of a cors response the page may read: the safelisted ones and
 * those Access-Control-Expose-Headers names (`*`, without credentials,
 * exposes all). Set-Cookie never reaches a page
 */
export function exposedHeaders(headers: Headers, credentials: boolean): Headers {
	const expose = list(headers.get('access-control-expose-headers')).map(
		(name) => name.toLowerCase(),
	);
	const all = !credentials && expose.includes('*');
	const result = new Headers();
	for (const [name, value] of headers) {
		if (name === 'set-cookie' || name === 'set-cookie2') continue;
		if (all || SAFELISTED_RESPONSE.includes(name) || expose.includes(name))
			result.append(name, value);
	}
	return result;
}

interface PreflightEntry {
	expires: number;
	methods: Set<string>;
	anyMethod: boolean;
	headers: Set<string>;
	anyHeader: boolean;
}

/** Chrome's default and ceiling for Access-Control-Max-Age, in seconds */
const DEFAULT_MAX_AGE = 5;
const MAX_MAX_AGE = 7200;
const PREFLIGHT_KEPT = 1024;
/** what earlier preflights allowed, by origin, URL and credentials */
const preflights = new Map<string, PreflightEntry>();

const preflightKey = (origin: string, url: string, credentials: boolean) =>
	`${origin}\n${credentials ? 1 : 0}\n${url}`;

/** whether an earlier preflight still covers this request */
export function preflightCached(
	origin: string,
	url: string,
	credentials: boolean,
	method: string,
	unsafe: string[],
): boolean {
	const key = preflightKey(origin, url, credentials);
	const entry = preflights.get(key);
	if (!entry) return false;
	if (entry.expires <= Date.now()) {
		preflights.delete(key);
		return false;
	}
	return (
		(SIMPLE_METHODS.includes(method) ||
			entry.methods.has(method) ||
			(entry.anyMethod && !credentials)) &&
		unsafe.every(
			(name) =>
				entry.headers.has(name) ||
				(entry.anyHeader && !credentials && name !== 'authorization'),
		)
	);
}

/**
 * Whether a preflight's answer allows the request, and if it does, its
 * allowance is kept for its max-age
 * (https://fetch.spec.whatwg.org/#cors-preflight-fetch)
 */
export function preflightAllows(
	response: { status: number; headers: Headers },
	origin: string,
	url: string,
	credentials: boolean,
	method: string,
	unsafe: string[],
): boolean {
	if (response.status < 200 || response.status > 299) return false;
	if (!corsCheck(response.headers, origin, credentials)) return false;
	const methods = list(response.headers.get('access-control-allow-methods'));
	const names = list(response.headers.get('access-control-allow-headers')).map(
		(name) => name.toLowerCase(),
	);
	const anyMethod = methods.includes('*');
	const anyHeader = names.includes('*');
	if (
		!SIMPLE_METHODS.includes(method) &&
		!methods.includes(method) &&
		!(anyMethod && !credentials)
	)
		return false;
	for (const name of unsafe)
		if (
			!names.includes(name) &&
			!(anyHeader && !credentials && name !== 'authorization')
		)
			return false;
	const maxAge = Number(
		response.headers.get('access-control-max-age') ?? DEFAULT_MAX_AGE,
	);
	const seconds = Number.isFinite(maxAge)
		? Math.min(Math.max(maxAge, 0), MAX_MAX_AGE)
		: DEFAULT_MAX_AGE;
	if (seconds > 0) {
		if (preflights.size >= PREFLIGHT_KEPT)
			preflights.delete(preflights.keys().next().value!);
		const key = preflightKey(origin, url, credentials);
		const entry = preflights.get(key);
		preflights.set(key, {
			expires: Date.now() + seconds * 1000,
			methods: new Set([...(entry?.methods ?? []), ...methods]),
			anyMethod: anyMethod || !!entry?.anyMethod,
			headers: new Set([...(entry?.headers ?? []), ...names]),
			anyHeader: anyHeader || !!entry?.anyHeader,
		});
	}
	return true;
}

/**
 * Whether Cross-Origin-Resource-Policy refuses a no-cors response to a
 * request of `origin` (https://fetch.spec.whatwg.org/#cross-origin-resource-policy-check).
 * `sameSite` says whether the two are the same site
 */
export function corpBlocks(
	headers: Headers,
	origin: string,
	target: URL,
	sameSite: boolean,
): boolean {
	const policy = headers.get('cross-origin-resource-policy')?.trim();
	if (policy === 'same-origin') return origin !== target.origin;
	if (policy === 'same-site')
		return (
			origin === 'null' ||
			!sameSite ||
			// a secure page's resource is not the same site to an insecure one
			(target.protocol === 'https:' && !origin.startsWith('https:'))
		);
	return false;
}
