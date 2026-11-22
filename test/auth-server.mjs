// The HTTP authentication side of the fixture (http-auth suite): protection
// spaces that challenge with Basic, Digest (RFC 7616: MD5, MD5-sess, SHA-256
// and SHA-256-sess, qop=auth, a stale nonce answered with a fresh one) or
// NTLM, and a log of the Authorization every request brought, so a page
// loaded natively and through the proxy can be compared request by request.
//
//   /auth/<scheme>/<dir>/<file>?k=<key>&c=<case>[&...]
//     scheme    basic | md5 | md5-sess | sha256 | sha256-sess
//               | both (a Basic and an MD5 Digest challenge, in two headers)
//               | ntlm (challenges with NTLM and never accepts: what a
//               browser sends to one is logged)
//     dir       the directory; the realm is its name unless realm= says
//     realm=<r> the realm of the challenge
//     stale=1   the first request of this URL makes the key's nonce for the
//               realm stale: a Digest answer with the old one gets a 401
//               with stale=true and a new nonce
//     to=<url>  once authorized (or with none asked, open=1), a 302 there
//     open=1    no challenge: 200 to anyone (or the redirect)
//     html=1    the 200 is a small document (a frame's)
//   The credentials are `user` and `pass`. A 200 answers JSON with the
//   Authorization it got. Every answer allows CORS for the asking origin with
//   credentials and exposes WWW-Authenticate.
//   /auth/csd?k=<key>&c=<case>&types=<value>
//                        a 200 with Clear-Site-Data: <value>
//   /auth/log?k=<key>    every request under k, by case: which origin (A for
//                        127.0.0.1, B for localhost), the Authorization with
//                        its nonces numbered in the order the key got them
//                        and its cnonce and response reduced to their shape
//                        (a response that checked out is "ok"), and status
//
// test/fixture.mjs calls `httpAuth(req, res)` and serves the rest.
import { createHash, randomBytes } from 'node:crypto';

const USER = 'user';
const PASS = 'pass';
const ALGORITHMS = {
	md5: ['MD5', 'md5'],
	'md5-sess': ['MD5-sess', 'md5'],
	sha256: ['SHA-256', 'sha256'],
	'sha256-sess': ['SHA-256-sess', 'sha256'],
};

/** per key: { log: {case: entries}, nonces: [nonce], current: {realm: nonce}, staled: Set<url> } */
const keys = new Map();
const stateOf = (key) => {
	let state = keys.get(key);
	if (!state) {
		state = { log: {}, nonces: [], current: {}, staled: new Set() };
		keys.set(key, state);
	}
	return state;
};

const hash = (name, text) => createHash(name).update(text).digest('hex');

/** a Digest credentials value's params in order, unquoted */
function parseParams(text) {
	const params = [];
	const re = /\s*([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))\s*(?:,|$)/gy;
	let match;
	while (re.lastIndex < text.length && (match = re.exec(text))) {
		const quoted = match[2] !== undefined;
		params.push({
			name: match[1].toLowerCase(),
			raw: match[1],
			value: quoted ? match[2].replace(/\\(.)/g, '$1') : match[3],
			quoted,
		});
		if (match[0] === '') break;
	}
	return params;
}

/** whether `params` answer a Digest challenge of `realm` for this request */
function digestValid(params, scheme, realm, method, uri, nonce) {
	const get = (name) => params.find((param) => param.name === name)?.value;
	const [algorithm, name] = ALGORITHMS[scheme];
	if (get('username') !== USER || get('realm') !== realm) return false;
	if (get('uri') !== uri || get('nonce') !== nonce) return false;
	if ((get('algorithm') ?? 'MD5').toLowerCase() !== algorithm.toLowerCase())
		return false;
	const cnonce = get('cnonce') ?? '';
	let ha1 = hash(name, `${USER}:${realm}:${PASS}`);
	if (algorithm.endsWith('-sess'))
		ha1 = hash(name, `${ha1}:${nonce}:${cnonce}`);
	const ha2 = hash(name, `${method}:${uri}`);
	const expected =
		get('qop') === 'auth'
			? hash(name, `${ha1}:${nonce}:${get('nc')}:${cnonce}:auth:${ha2}`)
			: hash(name, `${ha1}:${nonce}:${ha2}`);
	return get('response') === expected;
}

/** the Authorization as the log shows it (see the top of the file) */
function describe(header, state, valid) {
	if (!header) return null;
	const space = header.indexOf(' ');
	const scheme = space < 0 ? header : header.slice(0, space);
	if (scheme.toLowerCase() === 'basic')
		return `Basic ${Buffer.from(header.slice(space + 1), 'base64').toString()}`;
	if (scheme.toLowerCase() === 'ntlm') {
		const bytes = Buffer.from(header.slice(space + 1), 'base64');
		return `NTLM type ${bytes.length >= 12 ? bytes.readUInt32LE(8) : '?'}`;
	}
	if (scheme.toLowerCase() !== 'digest') return header;
	const parts = parseParams(header.slice(space + 1)).map((param) => {
		let value = param.value;
		if (param.name === 'nonce') {
			const index = state.nonces.indexOf(value);
			value = index < 0 ? 'unknown' : `N${index + 1}`;
		} else if (param.name === 'cnonce')
			value = /^[0-9a-f]+$/.test(value) ? `hex${value.length}` : 'other';
		else if (param.name === 'response') value = valid ? 'ok' : 'wrong';
		else if (param.name === 'uri') value = value.replace(/k=[\w-]+/, 'k=KEY');
		return `${param.raw}=${param.quoted ? `"${value}"` : value}`;
	});
	return `${scheme} ${parts.join(', ')}`;
}

function cors(req, res) {
	res.setHeader('access-control-allow-origin', req.headers.origin || '*');
	res.setHeader('access-control-allow-credentials', 'true');
	res.setHeader('access-control-expose-headers', 'WWW-Authenticate');
	res.setHeader('cache-control', 'no-store');
}

export function httpAuth(req, res) {
	const url = new URL(req.url, 'http://x');
	if (!url.pathname.startsWith('/auth/')) return false;
	const query = url.searchParams;
	cors(req, res);
	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.setHeader(
			'access-control-allow-headers',
			req.headers['access-control-request-headers'] || '*',
		);
		res.setHeader('access-control-allow-methods', 'GET, POST, PUT');
		res.end();
		return true;
	}
	const state = stateOf(query.get('k'));
	if (url.pathname === '/auth/log') {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify(state.log));
		return true;
	}
	if (url.pathname === '/auth/csd') {
		(state.log[query.get('c')] ??= []).push({ csd: query.get('types') });
		res.setHeader('clear-site-data', query.get('types'));
		res.setHeader('content-type', 'application/json');
		res.end('{}');
		return true;
	}
	const match = /^\/auth\/([\w-]+)\/([\w-]+)\//.exec(url.pathname);
	if (!match) return false;
	const [, scheme, dir] = match;
	const realm = query.get('realm') ?? dir;
	const header = req.headers.authorization ?? null;
	const space = header?.indexOf(' ') ?? -1;
	const given = header === null ? '' : header.slice(0, space).toLowerCase();
	const nonceFor = () =>
		(state.current[`${scheme}:${realm}`] ??= (() => {
			const nonce = randomBytes(16).toString('hex');
			state.nonces.push(nonce);
			return nonce;
		})());
	if (query.has('stale') && !state.staled.has(req.url)) {
		state.staled.add(req.url);
		nonceFor();
		delete state.current[`${scheme}:${realm}`];
	}
	let authorized = query.has('open');
	let valid = false;
	let stale = false;
	if (!authorized && header !== null) {
		if (given === 'basic' && (scheme === 'basic' || scheme === 'both'))
			authorized = valid =
				header.slice(space + 1) ===
				Buffer.from(`${USER}:${PASS}`).toString('base64');
		else if (given === 'digest' && scheme !== 'basic' && scheme !== 'ntlm') {
			const params = parseParams(header.slice(space + 1));
			const nonce = params.find((param) => param.name === 'nonce')?.value;
			const digestScheme = scheme === 'both' ? 'md5' : scheme;
			valid =
				!!nonce &&
				state.nonces.includes(nonce) &&
				digestValid(params, digestScheme, realm, req.method, req.url, nonce);
			authorized = valid && nonce === nonceFor();
			stale = valid && !authorized;
		}
	}
	const entry = {
		origin: /^localhost(:|$)/.test(req.headers.host ?? '') ? 'B' : 'A',
		method: req.method,
		auth: describe(header, state, valid),
		status: 0,
	};
	(state.log[query.get('c')] ??= []).push(entry);
	if (!authorized) {
		const challenges = [];
		if (scheme === 'basic' || scheme === 'both')
			challenges.push(`Basic realm="${realm}"`);
		if (scheme === 'ntlm') challenges.push('NTLM');
		else if (scheme !== 'basic') {
			const algorithm = ALGORITHMS[scheme === 'both' ? 'md5' : scheme][0];
			challenges.push(
				`Digest realm="${realm}", qop="auth", algorithm=${algorithm}, nonce="${nonceFor()}", opaque="op-${realm}"${stale ? ', stale=true' : ''}`,
			);
		}
		entry.status = 401;
		res.statusCode = 401;
		res.setHeader('www-authenticate', challenges);
		res.setHeader('content-type', 'application/json');
		res.end('{"denied":true}');
		return true;
	}
	if (query.has('to')) {
		entry.status = 302;
		res.statusCode = 302;
		res.setHeader('location', query.get('to'));
		res.end();
		return true;
	}
	entry.status = 200;
	if (query.has('html')) {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end('<!doctype html><title>authorized</title><p>authorized</p>');
		return true;
	}
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ authorization: header }));
	return true;
}
