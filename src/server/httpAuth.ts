// HTTP authentication for the real origins (Basic, and Digest as RFC 7616
// has it), done here because the browser's own never applies: every
// proxied request is the worker's fetch through the transport, so a 401
// reaches the page as it came and the browser's auth cache never sees the
// site. As Chrome's auth cache does it (measured, Chrome 159, the http-auth
// suite):
//
// - a request carries nothing until the site challenges, unless an earlier
//   answer of the origin was kept for a directory that encloses its path
//   (the longest): then that is sent ahead, a Digest one with the kept
//   challenge's nonce and the next nonce count. A request with credentials
//   of its own (open()'s user and password, or the URL's, which the inject
//   sends as CREDENTIALS_HEADER) sends nothing ahead.
// - a challenge is answered once with the request's own credentials, else
//   with those kept for the challenge's realm and scheme of the origin; of
//   several challenges, Digest's (MD5, MD5-sess, SHA-256, SHA-256-sess,
//   qop=auth or none) before Basic's. What succeeds is kept for the realm,
//   with the directory of the URL, and its nonce count starts again.
// - a Digest challenge with stale=true for the realm just answered is
//   answered again with the same credentials and the new nonce.
// - credentials the site refuses (the page's own Authorization header
//   included) forget what the realm kept, and the page gets the 401.
//
// Never anything of one origin to another: every entry is the origin's
// (scheme, host and port), a redirect's next hop answers with no credentials
// the page gave for the first (the worker drops them, rewrites.ts), and a
// site's cookies forgotten (by the host, or by its Clear-Site-Data) forget
// its entries (forgetAuthorizations).
// NTLM and Negotiate are not answered: their handshakes are bound to one
// connection, which the transport's requests do not hold. The entries live
// as long as the worker, like the browser's for a session.
import { md5 } from '../rtc/md5';
import { sha256Hex } from '../sha';

/** at most this many protection spaces are kept, the oldest dropped first */
const ENTRIES_KEPT = 64;
/** and this many directories of one, the oldest dropped first (as Chrome) */
const PATHS_KEPT = 10;
/** challenges answered for one request at most (a stale nonce, a new realm) */
const ROUNDS = 4;

export interface Identity {
	user: string;
	password: string;
}

interface Challenge {
	scheme: 'basic' | 'digest';
	realm: string;
	params: Map<string, string>;
}

interface Entry {
	origin: string;
	realm: string;
	scheme: Challenge['scheme'];
	identity: Identity;
	/** the challenge a Digest answer sent ahead is made from */
	challenge: Challenge;
	/** the nonce count the last Digest answer of this entry used */
	nonceCount: number;
	/** the directories sent ahead to, newest last */
	paths: string[];
}

/** what a request sent: an Authorization this module made, and from what */
export interface Sent {
	authorization: string;
	scheme: Challenge['scheme'];
	realm: string;
	identity: Identity;
	/** sent ahead from an entry (nothing new is kept when it succeeds) */
	ahead: boolean;
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
 * The credentials the inject sent with a request (CREDENTIALS_HEADER:
 * `user:password`, each part percent-encoded as a URL's userinfo, then a
 * space and the URL they are for), if they are for `url`: a redirect's next
 * hop gets none (natively, the URL it was redirected to has none)
 */
export function requestIdentity(
	header: string | null,
	url: URL,
): Identity | null {
	if (header === null) return null;
	const space = header.indexOf(' ');
	const credentials = space < 0 ? header : header.slice(0, space);
	if (space >= 0) {
		let target: URL;
		try {
			target = new URL(header.slice(space + 1));
		} catch (error) {
			return null;
		}
		// (the scheme aside: an upgrade to https keeps them, as natively)
		if (
			target.host !== url.host ||
			target.pathname !== url.pathname ||
			target.search !== url.search
		)
			return null;
	}
	const colon = credentials.indexOf(':');
	return {
		user: decode(colon < 0 ? credentials : credentials.slice(0, colon)),
		password: colon < 0 ? '' : decode(credentials.slice(colon + 1)),
	};
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** the Basic Authorization value for `identity`, as UTF-8 */
function basic({ user, password }: Identity): string {
	let binary = '';
	for (const byte of utf8(`${user}:${password}`))
		binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

/** the Digest algorithms Chrome answers, by their lowercase name */
const ALGORITHMS: Record<string, [string, (text: string) => string]> = {
	md5: ['MD5', (text) => hex(md5(utf8(text)))],
	'md5-sess': ['MD5-sess', (text) => hex(md5(utf8(text)))],
	'sha-256': ['SHA-256', sha256Hex],
	'sha-256-sess': ['SHA-256-sess', sha256Hex],
};

const hex = (bytes: Uint8Array) => {
	let text = '';
	for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
	return text;
};

const quote = (text: string) => `"${text.replace(/["\\]/g, '\\$&')}"`;

/** a Digest Authorization value for `identity`, as Chrome writes one */
function digest(
	{ user, password }: Identity,
	challenge: Challenge,
	method: string,
	url: URL,
	nonceCount: number,
): string {
	const { params, realm } = challenge;
	const named = params.get('algorithm')?.toLowerCase();
	const [algorithm, hash] = ALGORITHMS[named ?? 'md5'];
	const nonce = params.get('nonce') ?? '';
	const opaque = params.get('opaque') ?? '';
	const qop = qopAuth(params.get('qop'));
	const uri = `${url.pathname}${url.search}`;
	const cnonce = hex(crypto.getRandomValues(new Uint8Array(8)));
	const nc = nonceCount.toString(16).padStart(8, '0');
	let ha1 = hash(`${user}:${realm}:${password}`);
	if (algorithm.endsWith('-sess')) ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
	const ha2 = hash(`${method}:${uri}`);
	const response = qop
		? hash(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
		: hash(`${ha1}:${nonce}:${ha2}`);
	let value = `Digest username=${quote(user)}, realm=${quote(realm)}, nonce=${quote(nonce)}, uri=${quote(uri)}`;
	if (named !== undefined) value += `, algorithm=${algorithm}`;
	value += `, response="${response}"`;
	if (opaque) value += `, opaque=${quote(opaque)}`;
	if (qop) value += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
	return value;
}

/** whether a qop directive names auth (undefined: none was given) */
function qopAuth(qop: string | undefined): boolean {
	return (
		qop !== undefined &&
		qop.split(',').some((part) => part.trim().toLowerCase() === 'auth')
	);
}

/**
 * The challenges of WWW-Authenticate values (each value may hold several),
 * their schemes lowercase, their auth-params by lowercase name (the first
 * of a name), unquoted
 */
function parseChallenges(
	values: string[],
): { scheme: string; params: Map<string, string> }[] {
	const challenges: { scheme: string; params: Map<string, string> }[] = [];
	for (const value of values) {
		let current: { scheme: string; params: Map<string, string> } | null = null;
		let i = 0;
		const take = (pattern: RegExp) => {
			pattern.lastIndex = i;
			const match = pattern.exec(value);
			if (match) i = pattern.lastIndex;
			return match;
		};
		while (i < value.length) {
			take(/[\s,]*/y);
			const token = take(/[!#$%&'*+.^_`|~0-9A-Za-z-]+/y);
			if (!token) {
				if (i < value.length) i++;
				continue;
			}
			const after = i;
			take(/\s*/y);
			if (current && value[i] === '=' && value[i + 1] !== '=') {
				i++;
				take(/\s*/y);
				const quoted = take(/"((?:[^"\\]|\\.)*)"?/y);
				const text = quoted
					? quoted[1].replace(/\\(.)/g, '$1')
					: (take(/[^\s,]*/y)?.[0] ?? '');
				const name = token[0].toLowerCase();
				if (!current.params.has(name)) current.params.set(name, text);
				continue;
			}
			i = after;
			current = { scheme: token[0].toLowerCase(), params: new Map() };
			challenges.push(current);
			// a token68 (Negotiate's, NTLM's) is no auth-param
			take(/\s+[A-Za-z0-9\-._~+/]+=*\s*(?=,|$)/y);
		}
	}
	return challenges;
}

/** the challenge Chrome answers among a 401's WWW-Authenticate values: Digest's before Basic's */
function chooseChallenge(values: string[]): Challenge | null {
	let chosen: Challenge | null = null;
	for (const { scheme, params } of parseChallenges(values)) {
		if (scheme === 'digest') {
			const algorithm = params.get('algorithm')?.toLowerCase() ?? 'md5';
			const qop = params.get('qop');
			if (
				params.has('realm') &&
				params.has('nonce') &&
				ALGORITHMS[algorithm] &&
				(qop === undefined || qopAuth(qop))
			)
				return { scheme, realm: params.get('realm')!, params };
		} else if (scheme === 'basic' && !chosen)
			chosen = { scheme, realm: params.get('realm') ?? '', params };
	}
	return chosen;
}

const find = (origin: string, realm: string, scheme: Challenge['scheme']) =>
	entries.findIndex(
		(entry) =>
			entry.origin === origin &&
			entry.realm === realm &&
			entry.scheme === scheme,
	);

function answer(
	identity: Identity,
	challenge: Challenge,
	method: string,
	url: URL,
	nonceCount: number,
	ahead: boolean,
): Sent {
	return {
		authorization:
			challenge.scheme === 'basic'
				? basic(identity)
				: digest(identity, challenge, method, url, nonceCount),
		scheme: challenge.scheme,
		realm: challenge.realm,
		identity,
		ahead,
	};
}

/** what a request to `url` sends ahead of any challenge, or null */
export function authorizationAhead(url: URL, method: string): Sent | null {
	const directory = directoryOf(url);
	let found: Entry | null = null;
	let longest = -1;
	for (const entry of entries) {
		if (entry.origin !== url.origin) continue;
		for (const path of entry.paths)
			if (directory.startsWith(path) && path.length > longest) {
				found = entry;
				longest = path.length;
			}
	}
	if (!found) return null;
	if (found.scheme === 'digest') found.nonceCount++;
	return answer(
		found.identity,
		found.challenge,
		method,
		url,
		found.nonceCount,
		true,
	);
}

/** `sent` answered `url`'s challenge: keep it for its realm and the URL's directory */
function remember(url: URL, sent: Sent, challenge: Challenge) {
	const at = find(url.origin, sent.realm, sent.scheme);
	const entry: Entry =
		at >= 0
			? entries.splice(at, 1)[0]
			: {
					origin: url.origin,
					realm: sent.realm,
					scheme: sent.scheme,
					identity: sent.identity,
					challenge,
					nonceCount: 1,
					paths: [],
				};
	entry.identity = sent.identity;
	entry.challenge = challenge;
	entry.nonceCount = 1;
	const directory = directoryOf(url);
	if (!entry.paths.some((path) => directory.startsWith(path))) {
		entry.paths = entry.paths.filter((path) => !path.startsWith(directory));
		entry.paths.push(directory);
		if (entry.paths.length > PATHS_KEPT) entry.paths.shift();
	}
	entries.push(entry);
	if (entries.length > ENTRIES_KEPT) entries.shift();
}

/** forget what `url`'s origin kept for a realm whose credentials were refused */
function forget(url: URL, challenge: Challenge) {
	const at = find(url.origin, challenge.realm, challenge.scheme);
	if (at >= 0) entries.splice(at, 1);
}

interface Answered {
	status: number;
	headers: Headers;
	rawHeaders?: [string, string][];
	body?: ReadableStream | null;
}

const challengeValues = (response: Answered) =>
	response.rawHeaders
		? response.rawHeaders
				.filter(([name]) => name.toLowerCase() === 'www-authenticate')
				.map(([, value]) => value)
		: [response.headers.get('www-authenticate') ?? ''];

/**
 * Answer `response`'s challenges as the browser would, for a request to
 * `url` that may carry credentials and has no Authorization of the page's:
 * `sent` is what it sent ahead (authorizationAhead), `identity` the
 * credentials it brings (requestIdentity), and `send` makes the request
 * again with an Authorization. The last response is the page's.
 */
export async function authenticate<R extends Answered>(
	response: R,
	url: URL,
	method: string,
	sent: Sent | null,
	identity: Identity | null,
	send: (authorization: string) => Promise<R>,
): Promise<R> {
	let ownUsed = false;
	// the challenge `sent` answered (none for what went ahead)
	let answered: Challenge | null = null;
	for (let round = 0; ; round++) {
		if (response.status !== 401) {
			if (sent && !sent.ahead && answered) remember(url, sent, answered);
			return response;
		}
		const challenge = chooseChallenge(challengeValues(response));
		if (!challenge || round === ROUNDS) return response;
		let next: Sent;
		if (
			sent &&
			sent.scheme === challenge.scheme &&
			sent.realm === challenge.realm
		) {
			// a nonce that went stale: the same credentials, the new nonce
			if (
				challenge.scheme === 'digest' &&
				challenge.params.get('stale')?.toLowerCase() === 'true'
			) {
				if (sent.ahead) {
					const at = find(url.origin, challenge.realm, 'digest');
					if (at >= 0) {
						entries[at].challenge = challenge;
						entries[at].nonceCount = 1;
					}
				}
				next = answer(sent.identity, challenge, method, url, 1, sent.ahead);
			} else {
				// refused: what the realm kept goes, and the page has the 401
				forget(url, challenge);
				return response;
			}
		} else if (identity && !ownUsed) {
			ownUsed = true;
			next = answer(identity, challenge, method, url, 1, false);
		} else {
			const at = find(url.origin, challenge.realm, challenge.scheme);
			if (at < 0) return response;
			next = answer(entries[at].identity, challenge, method, url, 1, false);
		}
		await response.body?.cancel().catch(() => {});
		sent = next;
		answered = challenge;
		response = await send(next.authorization);
	}
}

/**
 * The site refused the Authorization the page set itself on a request that
 * may carry credentials: what the challenge's realm kept goes, as natively
 */
export function refused(response: Answered, url: URL) {
	if (response.status !== 401) return;
	const challenge = chooseChallenge(challengeValues(response));
	if (challenge) forget(url, challenge);
}

/**
 * The cookies of the hosts `matches` (every host, without it) were
 * forgotten, by the host or by a site's Clear-Site-Data: what their HTTP
 * authentication answered goes with them, as the browser's auth cache goes
 * with its cookies and other site data (Clear-Site-Data "cookies" clears it
 * too, measured in Chrome 159)
 */
export function forgetAuthorizations(matches?: (host: string) => boolean) {
	for (let i = entries.length - 1; i >= 0; i--)
		if (!matches || matches(new URL(entries[i].origin).hostname))
			entries.splice(i, 1);
}
