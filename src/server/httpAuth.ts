// HTTP Basic authentication for the real origins, done here because the
// browser's own never applies: every proxied request is the worker's fetch
// through the transport, so a 401 reaches the page as it came and the
// browser's auth cache never sees the site. As Chrome does it: a request
// carries no credentials until the site challenges; then the credentials
// the page gave (open()'s user and password, or the URL's, which the inject
// sends as CREDENTIALS_HEADER) answer once, and on success they are kept
// for the realm and sent ahead with every later request under the same
// directory of the origin (that one is not challenged first). Only Basic:
// a Digest or other challenge reaches the page as its 401. The entries live
// as long as the worker, like the browser's for a session.

/** at most this many protection spaces are kept, the oldest dropped first */
const ENTRIES_KEPT = 64;

interface Entry {
	origin: string;
	/** the path prefix sent ahead to: the authenticated URL's directory */
	directory: string;
	realm: string;
	authorization: string;
}

const entries: Entry[] = [];

const directoryOf = (url: URL) =>
	url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);

const decode = (part: string) => {
	try {
		return decodeURIComponent(part);
	} catch (error) {
		return part;
	}
};

/**
 * The Authorization value for `credentials`: the URL's userinfo as the inject
 * sends it (`user:password`, each part percent-encoded), as UTF-8
 */
export function basicAuthorization(credentials: string): string {
	const colon = credentials.indexOf(':');
	const user = decode(colon < 0 ? credentials : credentials.slice(0, colon));
	const password = colon < 0 ? '' : decode(credentials.slice(colon + 1));
	let binary = '';
	for (const byte of new TextEncoder().encode(`${user}:${password}`))
		binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

/**
 * The realm of a Basic challenge in a WWW-Authenticate value (an empty one
 * when it names none), or null when it holds none
 */
export function basicRealm(header: string | null): string | null {
	if (header === null) return null;
	// the scheme, then its auth-params up to the realm (other params may
	// come first)
	const match =
		/(?:^|,)\s*basic(?=\s|,|$)(?:\s+(?:[\w!#$%&'*+.^`|~-]+\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^\s,]*)\s*,\s*)*?realm\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*)))?/i.exec(
			header,
		);
	if (!match) return null;
	return (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1');
}

/** what a request to `url` sends ahead of any challenge, or null */
export function authorizationAhead(url: URL): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.origin === url.origin && url.pathname.startsWith(entry.directory))
			return entry.authorization;
	}
	return null;
}

/** the kept credentials for `realm` of `url`'s origin, or null */
export function authorizationForRealm(url: URL, realm: string): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.origin === url.origin && entry.realm === realm)
			return entry.authorization;
	}
	return null;
}

/** `authorization` answered `realm`'s challenge for `url`: keep it */
export function rememberAuthorization(
	url: URL,
	realm: string,
	authorization: string,
) {
	const directory = directoryOf(url);
	const at = entries.findIndex(
		(entry) =>
			entry.origin === url.origin &&
			entry.realm === realm &&
			entry.directory === directory,
	);
	if (at >= 0) entries.splice(at, 1);
	entries.push({ origin: url.origin, directory, realm, authorization });
	if (entries.length > ENTRIES_KEPT) entries.shift();
}
