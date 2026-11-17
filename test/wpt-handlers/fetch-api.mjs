// The wptserve python handlers the fetch/api tests call (test/wpt/fetch/api),
// ported from the files of the same name under fetch/api/resources/ (and the
// few they borrow from xhr/, common/ and fetch/connection-pool/).
//
// wptserve hands a handler bytes: a query value is percent-decoded to bytes
// and a header value is the bytes that arrived. Here a "byte string" is a
// JavaScript string whose code units are the bytes (latin1), which is how
// node reads and writes header values too, so a Location or an echoed header
// keeps the bytes a test put in the query.
//
// wptserve's stash is per path: `stash.take(token)` in preflight.py and in
// redirect.py do not see each other's value for the same token. The keys
// here carry the path for the same reason (a test hands one token to both).

import { readFileSync } from 'node:fs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** percent-decode to a byte string, `+` as a space (python's parse_qsl) */
function unquote(text) {
	return text
		.replace(/\+/g, ' ')
		.replace(/%([0-9a-fA-F]{2})/g, (_, hex) =>
			String.fromCharCode(parseInt(hex, 16)),
		);
}

/** python's quote_plus over the UTF-8 bytes of a string */
function quotePlus(text) {
	let out = '';
	for (const byte of Buffer.from(text, 'utf8')) {
		const char = String.fromCharCode(byte);
		if (/[A-Za-z0-9_.~-]/.test(char)) out += char;
		else if (char === ' ') out += '+';
		else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
	}
	return out;
}

/** request.GET: every value of every name, as byte strings, in order */
class Query {
	constructor(search) {
		this.pairs = [];
		for (const part of search.replace(/^\?/, '').split('&')) {
			if (!part) continue;
			const eq = part.indexOf('=');
			this.pairs.push(
				eq < 0
					? [unquote(part), '']
					: [unquote(part.slice(0, eq)), unquote(part.slice(eq + 1))],
			);
		}
	}
	has(name) {
		return this.pairs.some(([key]) => key === name);
	}
	/** the first value, or `fallback` (python's `first(name, default)`) */
	first(name, fallback) {
		const pair = this.pairs.find(([key]) => key === name);
		if (pair) return pair[1];
		// `first` without a default raises, and wptserve answers 500
		if (fallback === undefined) throw new Error(`no ${name} in the query`);
		return fallback;
	}
	all(name) {
		return this.pairs.filter(([key]) => key === name).map(([, value]) => value);
	}
}

export default ({ root, stash, setHeaders, readBodyBytes, substitute }) => {
	const bytes = (body) =>
		typeof body === 'string' ? Buffer.from(body, 'latin1') : body;

	/**
	 * The whole response written to the socket, for what node's response
	 * object refuses or changes: a header value with a control character, a
	 * reason phrase of the test's, a body after a 204.
	 */
	function rawResponse(req, res, status, reason, headers, body) {
		const lines = [`HTTP/1.1 ${status} ${reason}`];
		for (const [name, value] of headers) lines.push(`${name}: ${value}`);
		const content = bytes(body);
		lines.push('Connection: close', `Content-Length: ${content.length}`);
		res.socket.write(
			Buffer.concat([
				Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
				req.method === 'HEAD' ? Buffer.alloc(0) : content,
			]),
		);
		res.socket.end();
		res.detachSocket(res.socket);
	}

	/** a handler's `return status, headers, content` */
	function respond(req, res, status, headers, body = '') {
		try {
			setHeaders(res, headers);
		} catch (error) {
			if (error.code !== 'ERR_INVALID_CHAR') throw error;
			for (const name of res.getHeaderNames()) res.removeHeader(name);
			return rawResponse(req, res, status, 'OK', headers, body);
		}
		res.statusCode = status;
		res.end(bytes(body));
	}

	/** a response without Content-Length that ends when the connection does */
	function untilClose(res, status, headers) {
		setHeaders(res, headers);
		res.statusCode = status;
		res.shouldKeepAlive = false;
		res.useChunkedEncodingByDefault = false;
		res.flushHeaders();
	}

	const header = (req, name) => req.headers[name.toLowerCase()];
	/** the names of the request's headers, each once, in arrival order */
	const headerNames = (req) => [
		...new Set(
			req.rawHeaders
				.filter((_, index) => index % 2 === 0)
				.map((name) => name.toLowerCase()),
		),
	];
	const stashKey = (url, key) => `${url.pathname}|${key}`;
	const dirKey = (url, key) =>
		`${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}|${key}`;
	function take(key) {
		const value = stash.get(key);
		stash.delete(key);
		return value;
	}

	function inspectHeaders(req, res, url) {
		const query = new Query(url.search);
		const headers = [];
		const checked = query.has('headers')
			? query.first('headers').split('|')
			: null;
		for (const name of checked ?? [])
			if (header(req, name) !== undefined)
				headers.push([`x-request-${name}`, header(req, name)]);
		if (query.has('cors')) {
			headers.push(
				['Access-Control-Allow-Origin', req.headers.origin ?? '*'],
				['Access-Control-Allow-Credentials', 'true'],
				['Access-Control-Allow-Methods', 'GET, POST, HEAD'],
				[
					'Access-Control-Expose-Headers',
					// the python reads `checked_headers` unbound without ?headers
					checked.map((name) => `x-request-${name}`).join(', '),
				],
				[
					'Access-Control-Allow-Headers',
					query.has('allow_headers')
						? query.first('allow_headers')
						: headerNames(req).join(', '),
				],
			);
		}
		headers.push(['content-type', 'text/plain']);
		respond(req, res, 200, headers);
	}

	async function redirect(req, res, url) {
		const query = new Query(url.search);
		let stashed = { count: 0, preflight: '0' };
		let status = 302;
		const headers = [
			['Content-Type', 'text/plain'],
			['Cache-Control', 'no-cache'],
			['Pragma', 'no-cache'],
		];
		if (req.headers.origin !== undefined)
			headers.push(
				['Access-Control-Allow-Origin', req.headers.origin],
				['Access-Control-Allow-Credentials', 'true'],
			);
		else headers.push(['Access-Control-Allow-Origin', '*']);
		const token = query.has('token') ? query.first('token') : null;
		const key = stashKey(url, token);
		if (token !== null) stashed = take(key) ?? stashed;
		if (req.method === 'OPTIONS') {
			if (query.has('allow_headers'))
				headers.push([
					'Access-Control-Allow-Headers',
					query.first('allow_headers'),
				]);
			stashed.preflight = '1';
			// the preflight is not redirected: 200
			if (!query.has('redirect_preflight')) {
				if (token !== null) stash.set(key, stashed);
				return respond(req, res, 200, headers);
			}
		}
		if (query.has('redirect_status'))
			status = Number(query.first('redirect_status'));
		else if (req.method === 'POST') {
			const form = new Query((await readBodyBytes(req)).toString('latin1'));
			if (form.has('redirect_status'))
				status = Number(form.first('redirect_status'));
		}
		stashed.count += 1;
		if (query.has('location')) {
			let location = query.first('location');
			if (!query.has('simple')) {
				const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(location)?.[1] ?? '';
				if (['', 'http', 'https'].includes(scheme.toLowerCase())) {
					// keep the url parameters in the location, and make sure the
					// location changes during a redirection loop
					const parameters = new Map();
					for (const [name, value] of query.pairs)
						if (!parameters.has(name)) parameters.set(name, value);
					location += location.includes('?') ? '&' : '?';
					location += [...parameters]
						.map(([name, value]) => `${quotePlus(name)}=${quotePlus(value)}`)
						.join('&');
					location += `&count=${stashed.count}`;
				}
			}
			headers.push(['Location', location]);
		}
		if (query.has('redirect_referrerpolicy'))
			headers.push(['Referrer-Policy', query.first('redirect_referrerpolicy')]);
		if (query.has('delay')) await sleep(Number(query.first('delay')) || 0);
		if (token !== null) {
			stash.set(key, stashed);
			// stop redirecting and return the count (the last request is not a
			// redirection); the python returns only a body here, no headers
			if (
				query.has('max_count') &&
				stashed.count > Number(query.first('max_count'))
			)
				return respond(req, res, 200, [], String(stashed.count - 1));
		}
		respond(req, res, status, headers);
	}

	function preflight(req, res, url) {
		const query = new Query(url.search);
		const headers = [['Content-Type', 'text/plain']];
		let stashed = {
			controlRequestHeaders: '',
			preflight: '0',
			preflightReferrer: '',
			preflightUserAgent: '',
			optionsCount: 0,
			failNext: false,
		};
		const token = query.has('token') ? query.first('token') : null;
		const key = stashKey(url, token);
		if (token) stashed = take(key) ?? stashed;
		const shouldFail = req.method !== 'OPTIONS' && stashed.failNext;
		if (shouldFail) stashed.failNext = false;
		else if (query.has('origin'))
			for (const origin of query.first('origin').split(', '))
				headers.push(['Access-Control-Allow-Origin', origin]);
		else headers.push(['Access-Control-Allow-Origin', '*']);
		// the stash was taken above; "1" when a preflight was ever recorded
		if (query.has('clear-stash'))
			return respond(req, res, 200, headers, stashed.preflight);
		if (query.has('options-count')) {
			if (token) stash.set(key, stashed);
			return respond(req, res, 200, headers, String(stashed.optionsCount));
		}
		if (query.has('fail-next')) {
			stashed.failNext = true;
			if (token) stash.set(key, stashed);
			return respond(req, res, 200, headers, '1');
		}
		if (query.has('credentials'))
			headers.push(['Access-Control-Allow-Credentials', 'true']);
		if (req.method === 'OPTIONS') {
			if (req.headers['access-control-request-method'] === undefined)
				return respond(
					req,
					res,
					400,
					headers,
					'ERROR: No access-control-request-method in preflight!',
				);
			if ((req.headers.accept ?? '') !== '*/*')
				return respond(
					req,
					res,
					400,
					headers,
					'ERROR: Invalid access in preflight!',
				);
			if (query.has('control_request_headers'))
				stashed.controlRequestHeaders =
					req.headers['access-control-request-headers'] ?? null;
			if (query.has('max_age'))
				headers.push(['Access-Control-Max-Age', query.first('max_age')]);
			if (query.has('allow_headers'))
				headers.push([
					'Access-Control-Allow-Headers',
					query.first('allow_headers'),
				]);
			if (query.has('allow_methods'))
				headers.push([
					'Access-Control-Allow-Methods',
					query.first('allow_methods'),
				]);
			const status = query.has('preflight_status')
				? Number(query.first('preflight_status'))
				: 200;
			stashed.preflight = '1';
			stashed.preflightReferrer = req.headers.referer ?? '';
			stashed.preflightUserAgent = req.headers['user-agent'] ?? '';
			stashed.optionsCount += 1;
			if (token) stash.set(key, stashed);
			return respond(req, res, status, headers);
		}
		if (
			query.has('checkUserAgentHeaderInPreflight') &&
			req.headers['user-agent'] !== stashed.preflightUserAgent
		)
			return respond(
				req,
				res,
				400,
				headers,
				'ERROR: No user-agent header in preflight',
			);
		// x-* headers carry the values of a response without a body
		headers.push(
			[
				'Access-Control-Expose-Headers',
				'x-did-preflight, x-control-request-headers, x-referrer, x-preflight-referrer, x-origin',
			],
			['x-did-preflight', stashed.preflight],
		);
		if (stashed.controlRequestHeaders !== null)
			headers.push([
				'x-control-request-headers',
				stashed.controlRequestHeaders,
			]);
		headers.push(
			['x-preflight-referrer', stashed.preflightReferrer],
			['x-referrer', req.headers.referer ?? ''],
			['x-origin', req.headers.origin ?? ''],
		);
		if (token) stash.set(key, stashed);
		respond(req, res, 200, headers);
	}

	async function method(req, res, url) {
		const query = new Query(url.search);
		const headers = [];
		if (query.has('cors'))
			headers.push(
				['Access-Control-Allow-Origin', '*'],
				['Access-Control-Allow-Credentials', 'true'],
				['Access-Control-Allow-Methods', 'GET, POST, PUT, FOO'],
				['Access-Control-Allow-Headers', 'x-test, x-foo'],
				['Access-Control-Expose-Headers', 'x-request-method'],
			);
		headers.push(
			['x-request-method', req.method],
			['x-request-content-type', req.headers['content-type'] ?? 'NO'],
			['x-request-content-length', req.headers['content-length'] ?? 'NO'],
			['x-request-content-encoding', req.headers['content-encoding'] ?? 'NO'],
			['x-request-content-language', req.headers['content-language'] ?? 'NO'],
			['x-request-content-location', req.headers['content-location'] ?? 'NO'],
		);
		respond(req, res, 200, headers, await readBodyBytes(req));
	}

	// status.py: the status line, the type and the content of the query. Written
	// to the socket: the reason phrase is the test's, and a 204 keeps its body
	async function status(req, res, url) {
		const query = new Query(url.search);
		await readBodyBytes(req);
		rawResponse(
			req,
			res,
			Number(query.first('code', '200')),
			query.first('text', 'OMG'),
			[
				['Content-Type', query.first('type', '')],
				['X-Request-Method', req.method],
			],
			query.first('content', ''),
		);
	}

	async function echoContent(req, res) {
		respond(
			req,
			res,
			200,
			[
				['X-Request-Method', req.method],
				['X-Request-Content-Length', req.headers['content-length'] ?? 'NO'],
				['X-Request-Content-Type', req.headers['content-type'] ?? 'NO'],
				// no content sniffing on the response
				['Content-Type', 'text/plain'],
			],
			await readBodyBytes(req),
		);
	}

	async function trickle(req, res, url) {
		const query = new Query(url.search);
		const delay = Number(query.first('ms', '500'));
		const count = Number(query.first('count', '50'));
		await readBodyBytes(req);
		await sleep(delay);
		untilClose(
			res,
			200,
			query.has('notype') ? [] : [['Content-type', 'text/plain']],
		);
		await sleep(delay);
		for (let i = 0; i < count && !res.destroyed; i++) {
			res.write('TEST_TRICKLE\n');
			await sleep(delay);
		}
		res.end();
	}

	function authentication(req, res, url) {
		const query = new Query(url.search);
		const [scheme, data] = (req.headers.authorization ?? '').split(' ', 2);
		const [user, ...password] =
			scheme === 'Basic'
				? Buffer.from(data ?? '', 'base64')
						.toString('latin1')
						.split(':')
				: [];
		if (user === 'user' && password.join(':') === 'password')
			return respond(req, res, 200, [], 'Authentication done');
		respond(
			req,
			res,
			401,
			[['WWW-Authenticate', `Basic realm="${query.first('realm', 'test')}"`]],
			"Please login with credentials 'user' and 'password'",
		);
	}

	function dumpAuthorizationHeader(req, res, url) {
		const query = new Query(url.search);
		const headers = [
			['Content-Type', 'text/html'],
			['Cache-Control', 'no-cache'],
		];
		// no Authorization header in a preflight after a cross-origin redirect
		if (
			query.first('strip_auth_header', '') &&
			req.method === 'OPTIONS' &&
			(req.headers['access-control-request-headers'] ?? '')
				.toLowerCase()
				.includes('authorization')
		)
			return respond(req, res, 500, headers, 'fail');
		if (req.headers.origin !== undefined)
			headers.push(
				['Access-Control-Allow-Origin', req.headers.origin],
				['Access-Control-Allow-Credentials', 'true'],
			);
		else headers.push(['Access-Control-Allow-Origin', '*']);
		headers.push(['Access-Control-Allow-Headers', 'Authorization']);
		respond(req, res, 200, headers, req.headers.authorization ?? 'none');
	}

	// resources/cache.py: one entity with an ETag, 304 for its If-None-Match
	function conditional(req, res) {
		const etag = '"123abc"';
		if (req.headers['if-none-match'] === etag)
			return respond(req, res, 304, [['X-HTTP-STATUS', '304']]);
		respond(
			req,
			res,
			200,
			[
				['ETag', etag],
				['Content-Type', 'text/plain'],
			],
			'lorem ipsum dolor sit amet',
		);
	}

	// request/resources/cache.py: logs the validation and no-cache headers of
	// each request under the token, answers with the caching headers asked for
	function requestCache(req, res, url) {
		const query = new Query(url.search);
		const key = stashKey(url, query.first('token', ''));
		if (query.has('querystate'))
			return respond(
				req,
				res,
				200,
				[['Content-Type', 'text/plain']],
				JSON.stringify(take(key) ?? null),
			);
		const tag = query.first('tag', '') && `"${query.first('tag', '')}"`;
		const date = query.first('date', '');
		const inm = req.headers['if-none-match'];
		const ims = req.headers['if-modified-since'];
		const state = {};
		if (!query.has('ignore')) {
			if (inm) state['If-None-Match'] = inm;
			if (ims) state['If-Modified-Since'] = ims;
			if (req.headers.pragma) state.Pragma = req.headers.pragma;
			if (req.headers['cache-control'])
				state['Cache-Control'] = req.headers['cache-control'];
		}
		stash.set(key, [...(take(key) ?? []), state]);
		const headers = [];
		if (tag) headers.push(['ETag', tag]);
		else if (date) headers.push(['Last-Modified', date]);
		for (const [name, parameter] of [
			['Expires', 'expires'],
			['Vary', 'vary'],
			['Cache-Control', 'cache_control'],
		])
			if (query.first(parameter, ''))
				headers.push([name, query.first(parameter)]);
		// the only-if-cached redirect tests want CORS to be okay
		headers.push(['Access-Control-Allow-Origin', '*']);
		if (query.first('redirect', '')) {
			headers.push(['Location', query.first('redirect')]);
			return respond(req, res, 302, headers);
		}
		if (
			(inm !== undefined && tag && inm === tag) ||
			(ims !== undefined && date && ims === date)
		)
			return respond(req, res, 304, headers);
		headers.push(['Content-Type', 'text/plain']);
		respond(req, res, 200, headers, query.first('content', ''));
	}

	// bad-chunk-encoding.py: chunks, then bytes that are no chunk
	async function badChunkEncoding(req, res, url) {
		const query = new Query(url.search);
		const delay = Number(query.first('ms', '1000'));
		const count = Number(query.first('count', '50'));
		const socket = res.socket;
		await sleep(delay);
		socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
		await sleep(delay);
		for (let i = 0; i < count && !socket.destroyed; i++) {
			socket.write('a\r\nTEST_CHUNK\r\n');
			await sleep(delay);
		}
		socket.write('garbage');
		socket.end();
		res.detachSocket(socket);
	}

	// infinite-slow-response.py: a body that never ends; `stateKey` says in the
	// stash whether the connection is open, `abortKey` ends it from another
	// request
	function infiniteSlowResponse(req, res, url) {
		const query = new Query(url.search);
		const stateKey = query.first('stateKey', '');
		const abortKey = query.first('abortKey', '');
		if (stateKey) stash.set(dirKey(url, stateKey), 'open');
		untilClose(res, 200, [['Content-type', 'text/plain']]);
		// an initial 2k so the browser realises it is there
		res.write('.'.repeat(2048));
		const stop = () => {
			clearInterval(timer);
			if (stateKey) stash.set(dirKey(url, stateKey), 'closed');
			if (!res.destroyed) res.end();
		};
		const timer = setInterval(() => {
			if (res.destroyed || req.socket.destroyed) return stop();
			res.write('.');
			if (abortKey && take(dirKey(url, abortKey)) !== undefined) stop();
		}, 10);
		res.on('close', stop);
	}

	function stashPut(req, res, url) {
		const query = new Query(url.search);
		if (req.method === 'OPTIONS')
			return respond(
				req,
				res,
				200,
				[
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Allow-Methods', '*'],
					['Access-Control-Allow-Headers', '*'],
				],
				'done',
			);
		const headers = [];
		if (!query.has('disallow_cross_origin'))
			headers.push(['Access-Control-Allow-Origin', '*']);
		// the python tells a same-origin request by its mode, and its check of
		// the frame's origin never passes (it looks for a key with a space)
		else if (query.first('mode') !== 'no-cors')
			throw new Error('stash-put.py: no frame_origin');
		stash.set(dirKey(url, query.first('key')), query.first('value'));
		respond(req, res, 200, headers, 'done');
	}

	function stashTake(req, res, url) {
		const query = new Query(url.search);
		respond(
			req,
			res,
			200,
			[
				['Access-Control-Allow-Origin', '*'],
				['Content-Type', 'application/json'],
			],
			JSON.stringify(take(dirKey(url, query.first('key'))) ?? null),
		);
	}

	async function stashedChunk(req, res) {
		untilClose(res, 200, [
			['Content-Type', 'application/octet-stream'],
			['Cache-Control', 'no-store'],
		]);
		for (const [letter, wait] of [
			['A', 100],
			['B', 100],
			['C', 5000],
		]) {
			if (res.destroyed) return;
			res.write(letter.repeat(4096));
			await sleep(wait);
		}
		res.end();
	}

	// preflight-unterminated-body.py: a preflight whose body never ends
	function preflightUnterminatedBody(req, res) {
		const headers = [
			['Access-Control-Allow-Origin', req.headers.origin ?? '*'],
			['Access-Control-Allow-Methods', 'GET'],
			['Access-Control-Allow-Headers', 'x-preflight-test'],
			['Access-Control-Max-Age', '0'],
			['Content-Type', 'text/plain'],
		];
		if (req.method !== 'OPTIONS')
			return respond(req, res, 200, headers, 'actual request');
		untilClose(res, 200, headers);
		const timer = setInterval(() => {
			if (res.destroyed) clearInterval(timer);
			else res.write('.'.repeat(1024));
		}, 10);
		res.on('close', () => clearInterval(timer));
	}

	// xhr/resources/content-in-chunks.py: each hex `chunk` of the query as a
	// chunk of its own, `ms` apart
	async function contentInChunks(req, res, url) {
		const query = new Query(url.search);
		const delay = Number(query.first('ms', '100'));
		const socket = res.socket;
		socket.write(
			`HTTP/1.1 200 OK\r\nContent-Type: ${query.first('type', 'text/plain')}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
		);
		for (const chunk of query.all('chunk')) {
			await sleep(delay);
			if (socket.destroyed) return;
			const content = Buffer.from(chunk, 'hex');
			socket.write(
				Buffer.concat([
					Buffer.from(`${content.length.toString(16)}\r\n`),
					content,
					Buffer.from('\r\n'),
				]),
			);
		}
		socket.write('0\r\n\r\n');
		socket.end();
		res.detachSocket(socket);
	}

	// fetch/connection-pool/resources/network-partition-key.py, the part the
	// status tests use: how many requests and connections a uuid has seen
	async function networkPartitionKey(req, res, url) {
		const query = new Query(url.search);
		const headers = [['Cache-Control', 'no-store']];
		const uuid = query.first('uuid', '');
		const dispatch = query.first('dispatch', '');
		const partition = query.first('partition_id', '');
		await readBodyBytes(req);
		const plain = (status, body) =>
			respond(
				req,
				res,
				status,
				[...headers, ['Content-Type', 'text/plain']],
				body,
			);
		if (!uuid || !dispatch || !partition)
			return plain(404, 'Invalid query parameters');
		const key = stashKey(url, uuid);
		const state = take(key) ?? {
			failed: false,
			requests: 0,
			connections: new Map(),
		};
		const address = `${req.socket.remoteAddress}|${req.socket.remotePort}`;
		state.requests += 1;
		if (state.connections.has(address)) {
			if (state.connections.get(address) !== partition) state.failed = true;
		}
		state.connections.set(address, partition);
		stash.set(key, state);
		if (req.headers.origin !== undefined)
			headers.push(
				['Access-Control-Allow-Origin', req.headers.origin],
				['Access-Control-Allow-Credentials', 'true'],
			);
		if (req.method === 'OPTIONS')
			return respond(
				req,
				res,
				200,
				[
					...headers,
					['Access-Control-Allow-Methods', 'GET'],
					['Access-Control-Allow-Headers', 'header-to-force-cors'],
					['Access-Control-Max-Age', '86400'],
				],
				'Preflight request',
			);
		if (dispatch === 'check_partition') {
			if (state.failed)
				return plain(
					Number(query.first('status', '200')),
					'Multiple partition IDs used on a socket',
				);
			return plain(
				Number(query.first('status', '200')),
				query.first('addcounter', '')
					? `ok. Request was sent ${state.requests} times. ${state.connections.size} connections were created.`
					: 'ok',
			);
		}
		if (dispatch === 'clean_up') {
			take(key);
			return plain(
				200,
				state.failed
					? 'Test failed, but cleanup completed.'
					: 'cleanup complete',
			);
		}
		plain(404, `Unrecognized dispatch parameter: ${dispatch}`);
	}

	// The tests whose only cross-origin URL is the page's host on wptserve's
	// second http port. The fixture has one port, where that URL is the page's
	// own origin; a third host stands in for it (see `patches` below), put in
	// before the substitutions, which the patches of wpt-server.mjs come after
	const secondPort = (req, res, url, port) =>
		respond(
			req,
			res,
			200,
			[['Content-Type', 'text/javascript; charset=utf-8']],
			Buffer.from(
				substitute(
					readFileSync(root + url.pathname.slice(1), 'utf8').replaceAll(
						'http://{{host}}:{{ports[http][1]}}',
						'http://{{domains[www2]}}:{{ports[http][0]}}',
					),
					req,
					port,
				),
				'utf8',
			),
		);
	// get_host_info()'s origin on the second port, as the tests name it
	const otherOrigin = [['HTTP_ORIGIN_WITH_DIFFERENT_PORT', 'OTHER_ORIGIN']];

	return {
		handlers: {
			'/fetch/api/basic/integrity.sub.any.js': secondPort,
			'/fetch/api/basic/mode-no-cors.sub.any.js': secondPort,
			'/fetch/api/cors/cors-expose-star.sub.any.js': secondPort,
			'/fetch/api/cors/cors-filtering.sub.any.js': secondPort,
			'/fetch/api/cors/cors-multiple-origins.sub.any.js': secondPort,
			'/fetch/api/resources/inspect-headers.py': inspectHeaders,
			// replaces the short one of test/wpt-server.mjs (a Location and
			// nothing else): the redirect tests need the count, the stash, the
			// preflight answer and the parameters carried into the location
			'/fetch/api/resources/redirect.py': redirect,
			'/fetch/api/resources/preflight.py': preflight,
			// its stash is its own path's, which nothing writes: always "0"
			'/fetch/api/resources/clean-stash.py': (req, res, url) =>
				respond(
					req,
					res,
					200,
					[],
					take(stashKey(url, new Query(url.search).first('token'))) ===
						undefined
						? '0'
						: '1',
				),
			'/fetch/api/resources/method.py': method,
			'/fetch/api/resources/status.py': status,
			'/xhr/resources/status.py': status,
			'/fetch/api/resources/echo-content.py': echoContent,
			'/fetch/api/resources/trickle.py': trickle,
			'/fetch/api/resources/authentication.py': authentication,
			'/fetch/api/resources/dump-authorization-header.py':
				dumpAuthorizationHeader,
			'/fetch/api/resources/cache.py': conditional,
			'/fetch/api/request/resources/cache.py': requestCache,
			'/fetch/api/resources/bad-chunk-encoding.py': badChunkEncoding,
			'/fetch/api/resources/infinite-slow-response.py': infiniteSlowResponse,
			'/fetch/api/resources/stash-put.py': stashPut,
			'/fetch/api/resources/stash-take.py': stashTake,
			'/fetch/api/resources/stashed-chunk.py': stashedChunk,
			'/fetch/api/resources/preflight-unterminated-body.py':
				preflightUnterminatedBody,
			'/fetch/api/resources/script-with-header.py': (req, res, url) => {
				const query = new Query(url.search);
				respond(
					req,
					res,
					200,
					[['Content-type', query.first('mime')]],
					query.first('content', '') === 'empty'
						? ''
						: "console.log('Script loaded')",
				);
			},
			'/fetch/api/resources/redirect-empty-location.py': (req, res, url) =>
				respond(
					req,
					res,
					Number(new Query(url.search).first('status', '302')),
					[['Location', '']],
				),
			'/fetch/api/resources/echo-header-bytes.py': (req, res, url) =>
				respond(
					req,
					res,
					200,
					[['content-type', 'text/plain']],
					new Query(url.search)
						.first('headers')
						.split('|')
						.map(
							(name) =>
								`${name}: ${Buffer.from(header(req, name) ?? '', 'latin1').toString('hex')}`,
						)
						.join('\n'),
				),
			// the request's header lines as they arrived
			'/xhr/resources/echo-headers.py': (req, res) => {
				let content = '';
				for (let i = 0; i < req.rawHeaders.length; i += 2)
					content += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\n`;
				rawResponse(
					req,
					res,
					200,
					'OK',
					[['Content-Type', 'text/plain']],
					`${content}\n`,
				);
			},
			'/xhr/resources/parse-headers.py': (req, res, url) => {
				const query = new Query(url.search);
				respond(
					req,
					res,
					200,
					query.has('my-custom-header')
						? [['My-Custom-Header', query.first('my-custom-header')]]
						: [],
				);
			},
			'/xhr/resources/content-in-chunks.py': contentInChunks,
			'/common/redirect.py': (req, res, url) => {
				const query = new Query(url.search);
				const headers = [['Location', query.first('location')]];
				if (query.has('enable-cors') && req.headers.origin !== undefined)
					headers.push(
						['Content-Type', 'text/plain'],
						['Access-Control-Allow-Origin', req.headers.origin],
						['Access-Control-Allow-Credentials', 'true'],
					);
				respond(req, res, Number(query.first('status', '302')) || 302, headers);
			},
			'/fetch/connection-pool/resources/network-partition-key.py':
				networkPartitionKey,
		},
		patches: {
			// the fixture has no https origin: the same two hosts over http keep
			// what the test is about (a same-origin and a cross-origin redirect)
			'/fetch/api/credentials/authentication-redirection.any.js': [
				['HTTPS_REMOTE_ORIGIN', 'HTTP_REMOTE_ORIGIN'],
				['HTTPS_ORIGIN', 'HTTP_ORIGIN'],
			],
			// no second port: the same-host origin on another port is a third
			// host here (www2.localhost), cross-origin to the page and to the
			// remote host like the one the tests mean
			'/fetch/api/cors/cors-basic.any.js': otherOrigin,
			'/fetch/api/cors/cors-cookies-redirect.any.js': otherOrigin,
			'/fetch/api/cors/cors-no-preflight.any.js': otherOrigin,
			'/fetch/api/cors/cors-origin.any.js': otherOrigin,
			'/fetch/api/cors/cors-preflight-cache-tainted.any.js': otherOrigin,
			'/fetch/api/cors/cors-redirect.any.js': otherOrigin,
			'/fetch/api/cors/cors-redirect-credentials.any.js': otherOrigin,
			'/fetch/api/cors/cors-redirect-preflight.any.js': otherOrigin,
		},
	};
};
