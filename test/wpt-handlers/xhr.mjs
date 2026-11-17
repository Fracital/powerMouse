// The wptserve python handlers of xhr/resources/ that the vendored xhr
// tests call, ported one for one (the .py files in a web-platform-tests
// checkout are the reference), plus the two of fetch/api/resources/ those
// tests borrow.
//
// Python handlers work on bytes; here every string is "isomorphic" (one
// char per byte, latin1), which is what Node hands over for header values,
// so a body or a header a test sends as raw bytes comes back as it was.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { deflateSync, gzipSync } from 'node:zlib';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SERVER = 'BaseHTTP/0.6 Python/3.12';
const bytes = (text) => Buffer.from(String(text), 'latin1');

/** percent-decoding to bytes, `+` as a space (wptserve's request.GET) */
function decode(text) {
	const out = [];
	for (let i = 0; i < text.length; i++) {
		const hex = text[i] === '%' ? text.slice(i + 1, i + 3) : '';
		if (/^[0-9a-fA-F]{2}$/.test(hex)) {
			out.push(parseInt(hex, 16));
			i += 2;
		} else if (text[i] === '+') out.push(0x20);
		else out.push(...Buffer.from(text[i], 'utf8'));
	}
	return Buffer.from(out).toString('latin1');
}

/** a query string or urlencoded body as wptserve's MultiDict */
function params(text) {
	const map = new Map();
	for (const part of text.split('&')) {
		if (!part) continue;
		const eq = part.indexOf('=');
		const name = decode(eq < 0 ? part : part.slice(0, eq));
		const value = eq < 0 ? '' : decode(part.slice(eq + 1));
		if (!map.has(name)) map.set(name, []);
		map.get(name).push(value);
	}
	return {
		has: (name) => map.has(name),
		first: (name, fallback = null) => map.get(name)?.[0] ?? fallback,
		list: (name) => map.get(name) ?? [],
	};
}

const queryOf = (url) => params(url.search.slice(1));
/** the raw query string, "NO" when there is none (X-Request-Query) */
const rawQuery = (url) => (url.search.length > 1 ? url.search.slice(1) : 'NO');

/** wptserve's request.auth: the Basic credentials, null when none came */
function auth(req) {
	const header = req.headers.authorization || '';
	if (!/^basic /i.test(header)) return { username: null, password: null };
	const pair = Buffer.from(header.slice(6), 'base64').toString('latin1');
	const colon = pair.indexOf(':');
	return colon < 0
		? { username: pair, password: null }
		: { username: pair.slice(0, colon), password: pair.slice(colon + 1) };
}

/** a multipart/form-data or urlencoded body as fields and files */
function form(req, body) {
	const type = req.headers['content-type'] || '';
	const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
	const fields = [];
	const files = [];
	if (!boundary) {
		const parsed = new Map();
		for (const part of body.split('&')) {
			if (!part) continue;
			const eq = part.indexOf('=');
			const name = decode(eq < 0 ? part : part.slice(0, eq));
			if (!parsed.has(name))
				parsed.set(name, eq < 0 ? '' : decode(part.slice(eq + 1)));
		}
		for (const [name, value] of parsed) fields.push({ name, value });
		return { fields, files };
	}
	const mark = `--${boundary[1] ?? boundary[2]}`;
	for (const part of body.split(mark).slice(1)) {
		if (part.startsWith('--')) break;
		const split = part.indexOf('\r\n\r\n');
		if (split < 0) continue;
		const head = part.slice(0, split);
		const value = part.slice(split + 4).replace(/\r\n$/, '');
		const name = /name="((?:[^"\\]|\\.)*)"/i.exec(head)?.[1] ?? '';
		const filename = /filename="((?:[^"\\]|\\.)*)"/i.exec(head);
		if (filename)
			files.push({
				name,
				filename: filename[1],
				type: /content-type: *([^\r\n]*)/i.exec(head)?.[1] ?? null,
				size: value.length,
			});
		else fields.push({ name, value });
	}
	return { fields, files };
}

export default ({ root, stash, raw, readBodyBytes, cookiePairs }) => {
	/** the request body, isomorphic */
	const bodyOf = async (req) => (await readBodyBytes(req)).toString('latin1');

	/**
	 * Answer like a python handler's return value: headers as [name, value]
	 * pairs (a missing value drops the header), the body isomorphic.
	 */
	function send(res, { status = 200, text, headers = [], body = '' }) {
		res.statusCode = status;
		if (text !== undefined) res.statusMessage = text;
		const grouped = new Map();
		for (const [name, value] of headers) {
			if (value === null || value === undefined) continue;
			const key = name.toLowerCase();
			if (!grouped.has(key)) grouped.set(key, [name, []]);
			grouped.get(key)[1].push(String(value));
		}
		// wptserve names itself on every response
		if (!grouped.has('server')) grouped.set('server', ['Server', [SERVER]]);
		try {
			for (const [name, values] of grouped.values())
				res.setHeader(name, values.length === 1 ? values[0] : values);
		} catch (error) {
			// a value Node refuses (a NUL a test asked for) goes out as written
			if (error.code !== 'ERR_INVALID_CHAR') throw error;
			for (const name of res.getHeaderNames()) res.removeHeader(name);
			return raw(
				res,
				status,
				[...grouped.values()].flatMap(([name, values]) =>
					values.map((value) => [name, value]),
				),
				String(body),
			);
		}
		res.end(bytes(body));
	}

	/** a response written to the socket byte for byte, then the connection closed */
	function socketWrite(res, chunks, { wait = 0 } = {}) {
		const socket = res.socket;
		res.detachSocket(socket);
		return (async () => {
			for (const chunk of chunks) {
				if (socket.destroyed) return;
				socket.write(bytes(chunk));
				if (wait) await sleep(wait);
			}
			socket.end();
		})();
	}

	// wptserve's stash is keyed by the handler's path and the token
	const stashKey = (url, token) => `${url.pathname}|${token}`;
	const take = (url, token) => {
		const key = stashKey(url, token);
		const value = stash.get(key);
		stash.delete(key);
		return value;
	};
	const put = (url, token, value) => stash.set(stashKey(url, token), value);
	const takeState = (url, token) => take(url, token) || 'Uninitialized';

	/** response.set_cookie(name, value, expires=timedelta(days)) */
	const setCookie = (name, value, { days = null, secure = false } = {}) => {
		let cookie = `${name}=${value}`;
		if (days !== null)
			cookie += `; expires=${new Date(Date.now() + days * 86400000).toUTCString()}`;
		cookie += '; Path=/';
		if (secure) cookie += '; Secure';
		return ['Set-Cookie', cookie];
	};

	/** the X-Request-* headers content.py and its siblings echo */
	const requestEcho = (req, url) => [
		['X-Request-Method', req.method],
		['X-Request-Query', rawQuery(url)],
		['X-Request-Content-Length', req.headers['content-length'] ?? 'NO'],
		['X-Request-Content-Type', req.headers['content-type'] ?? 'NO'],
	];

	const origin = (req) => req.headers.origin;

	/** authentication.py, which every auth<n>/auth.py and corsenabled.py loads */
	function authentication(req, res, url, headers = []) {
		const { username, password } = auth(req);
		const token = req.headers['x-user'] ?? null;
		if (username === null && password === null) {
			if (token !== null && take(url, token) !== undefined)
				return send(res, { headers, body: 'FAIL (did not authorize)' });
			if (token !== null) put(url, token, '1');
			return send(res, {
				status: 401,
				text: 'Unauthorized',
				headers: [...headers, ['WWW-Authenticate', 'Basic realm="test"']],
				body: 'FAIL (should be transparent)',
			});
		}
		const challenge = take(url, token) === '1' ? 'DID' : 'DID-NOT';
		send(res, {
			headers: [
				...headers,
				['XHR-USER', token],
				['SES-USER', username],
				['X-challenge', challenge],
			],
			body: `${username}\n${password}`,
		});
	}

	/** auth5/auth.py and auth6/auth.py: one fixed pair of credentials */
	function fixedAuth(req, res) {
		const { username, password } = auth(req);
		if (username === 'usr' && password === 'secret')
			return send(res, {
				headers: [['Content-type', 'text/plain']],
				body: `${username}\n${password}`,
			});
		send(res, {
			status: 401,
			headers: [
				['Status', '401 Authorization required'],
				['WWW-Authenticate', 'Basic realm="test"'],
			],
			body: `User name/password wrong or not given: ${username ?? ''}\n${password ?? ''}`,
		});
	}

	const corsAuth = (allowed) => (req, res, url) => {
		const headers = [
			['Access-Control-Allow-Origin', origin(req)],
			['Access-Control-Allow-Credentials', 'true'],
			['Access-Control-Allow-Methods', 'GET'],
			['Access-Control-Allow-Headers', allowed],
			['Access-Control-Expose-Headers', 'x-challenge, xhr-user, ses-user'],
		];
		if (req.method === 'OPTIONS') return send(res, { headers });
		authentication(req, res, url, headers);
	};

	/** a fixed body under a fixed Content-Type */
	const fixed = (type, body) => (req, res) =>
		send(res, { headers: [['Content-type', type]], body });

	/** the three preflight-cache handlers: a state machine kept in the stash */
	const preflightCache = (step, failStatus) => (req, res, url) => {
		const token = queryOf(url).first('token');
		const state = takeState(url, token);
		const out = {
			status: 200,
			headers: [
				['Access-Control-Allow-Origin', origin(req)],
				['Access-Control-Allow-Credentials', 'true'],
			],
			body: '',
		};
		const fail = (message) => {
			out.body = `FAIL ${req.method}: ${message}`;
			if (failStatus) out.status = failStatus;
		};
		step({
			state,
			method: req.method,
			out,
			fail,
			set: (next) => put(url, token, next),
		});
		send(res, out);
	};

	const dir = '/xhr/resources/';
	const handlers = {
		'content.py': async (req, res, url) => {
			const query = queryOf(url);
			const label = query.first('response_charset_label');
			send(res, {
				headers: [
					[
						'Content-type',
						`text/plain${label === null ? '' : `;charset=${label}`}`,
					],
					...requestEcho(req, url),
				],
				body: query.has('content') ? query.first('content') : await bodyOf(req),
			});
		},
		'status.py': (req, res, url) => {
			const query = queryOf(url);
			send(res, {
				status: Number(query.first('code', '200')),
				text: query.first('text', 'OMG'),
				headers: [
					['Content-Type', query.first('type', '')],
					['X-Request-Method', req.method],
				],
				body: query.first('content', ''),
			});
		},
		'redirect.py': async (req, res, url) => {
			const query = queryOf(url);
			const code = Number(query.first('code', '302'));
			let location = query.first('location', `${url.pathname}?followed`);
			if (location) {
				// the python decodes the value a second time (parse_qs)
				location = decode(location);
				if (location.startsWith('redirect.py')) location += `&code=${code}`;
			}
			if (query.has('delay')) await sleep(Number(query.first('delay')));
			if (query.has('followed')) {
				// the python's header name is "Content:Type", which arrives as a
				// header called Content
				return send(res, {
					headers: [['Content', 'Type: text/plain']],
					body: 'MAGIC HAPPENED',
				});
			}
			send(res, {
				status: code,
				text: 'WEBSRT MARKETING',
				headers: [['Location', location]],
				body: 'TEST',
			});
		},
		'inspect-headers.py': (req, res, url) => {
			const query = queryOf(url);
			const headers = [];
			if (query.has('cors'))
				headers.push(
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Allow-Credentials', 'true'],
					['Access-Control-Allow-Methods', 'GET, POST, PUT, FOO'],
					['Access-Control-Allow-Headers', 'x-test, x-foo'],
					[
						'Access-Control-Expose-Headers',
						'x-request-method, x-request-content-type, x-request-query, x-request-content-length',
					],
				);
			headers.push(['content-type', 'text/plain']);
			const filterValue = query.first('filter_value', '');
			const filterName = query.first('filter_name', '').toLowerCase();
			let body = '';
			for (let i = 0; i < req.rawHeaders.length; i += 2) {
				const name = req.rawHeaders[i];
				const value = req.rawHeaders[i + 1];
				if (filterValue) {
					if (value === filterValue) body += `${name},`;
				} else if (name.toLowerCase() === filterName)
					body += `${name}: ${value}\n`;
			}
			send(res, { headers, body });
		},
		'delay.py': async (req, res, url) => {
			await sleep(Number(queryOf(url).first('ms', '500')));
			send(res, {
				headers: [
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Allow-Methods', 'YO'],
					['Content-type', 'text/plain'],
				],
				body: 'TEST_DELAY',
			});
		},
		'trickle.py': async (req, res, url) => {
			const query = queryOf(url);
			const chunk = 'TEST_TRICKLE\n';
			const delay = Number(query.first('ms', '500'));
			const count = Number(query.first('count', '50'));
			await sleep(delay);
			if (query.has('specifylength'))
				res.setHeader('Content-Length', count * chunk.length);
			res.setHeader('Content-type', 'text/plain');
			res.writeHead(200);
			res.flushHeaders();
			await sleep(delay);
			for (let i = 0; i < count; i++) {
				if (res.destroyed) return;
				res.write(chunk);
				await sleep(delay);
			}
			res.end();
		},
		'headers.py': (req, res) =>
			send(res, {
				headers: [
					['Content-Type', 'text/plain'],
					['X-Custom-Header', 'test'],
					['Set-Cookie', 'test'],
					['Set-Cookie2', 'test'],
					['X-Custom-Header-Empty', ''],
					['X-Custom-Header-Comma', '1'],
					['X-Custom-Header-Comma', '2'],
					// U+2026 as its UTF-8 bytes
					['X-Custom-Header-Bytes', '\xe2\x80\xa6'],
				],
				body: 'TEST',
			}),
		'echo-headers.py': (req, res) => {
			let content = '';
			for (let i = 0; i < req.rawHeaders.length; i += 2)
				content += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\n`;
			content += '\n';
			send(res, {
				headers: [
					['Content-Type', 'text/plain'],
					['Connection', 'close'],
				],
				body: content,
			});
		},
		// headers and body in one packet, so a client that keeps the body of
		// a HEAD response is caught (the line ends are the python's)
		'echo-method.py': (req, res) =>
			socketWrite(res, [
				`HTTP/1.1 200 OK\nContent-type: text/plain\nContent-Length: ${req.method.length}\n\n${req.method}`,
			]),
		'echo-content-type.py': (req, res) =>
			send(res, {
				headers: [
					['Content-Type', 'text/plain'],
					['Connection', 'close'],
				],
				body: req.headers['content-type'] ?? '',
			}),
		'upload.py': async (req, res) => {
			const { fields, files } = form(req, await bodyOf(req));
			const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
			const seen = new Set();
			const first = (list) =>
				list
					.filter((item) => !seen.has(item.name) && seen.add(item.name))
					.sort(byName);
			let content = '';
			for (const { name, value } of first(fields))
				content += `${name}=${value},`;
			content += '\n';
			seen.clear();
			for (const file of first(files))
				content += `${file.name}=${file.filename}:${file.type ?? 'None'}:${file.size},`;
			send(res, { body: content });
		},
		'form.py': async (req, res) => {
			const { fields } = form(req, await bodyOf(req));
			const first = (name) =>
				fields.find((field) => field.name === name)?.value ?? '';
			send(res, { body: `id:${first('id')};value:${first('value')};` });
		},
		'accept.py': (req, res) =>
			send(res, {
				headers: [['Content-Type', 'text/plain']],
				body: req.headers.accept ?? 'NO',
			}),
		'accept-language.py': (req, res) =>
			send(res, {
				headers: [['Content-Type', 'text/plain']],
				body: req.headers['accept-language'] ?? 'NO',
			}),
		'parse-headers.py': (req, res, url) => {
			const query = queryOf(url);
			send(res, {
				headers: query.has('my-custom-header')
					? [['My-Custom-Header', query.first('my-custom-header')]]
					: [],
			});
		},
		'corsenabled.py': async (req, res, url) => {
			const query = queryOf(url);
			const headers = [
				['Access-Control-Allow-Origin', '*'],
				['Access-Control-Allow-Credentials', 'true'],
				['Access-Control-Allow-Methods', 'GET, POST, PUT, FOO'],
				['Access-Control-Allow-Headers', 'x-test, x-foo'],
				[
					'Access-Control-Expose-Headers',
					'x-request-method, x-request-content-type, x-request-query, x-request-content-length, x-request-data',
				],
			];
			if (query.has('delay')) await sleep(Number(query.first('delay')) * 1000);
			if (query.has('safelist_content_type'))
				headers.push(['Access-Control-Allow-Headers', 'content-type']);
			headers.push(...requestEcho(req, url), [
				'X-Request-Data',
				await bodyOf(req),
			]);
			send(res, { headers, body: 'Test' });
		},
		'chunked.py': (req, res) => {
			res.writeHead(200, {
				'Transfer-Encoding': 'chunked',
				Trailer: 'X-Test-Me',
				'Content-Type': 'text/plain',
			});
			for (const chunk of [
				'First chunk\r\n',
				'Second chunk\r\n',
				'Yet another (third) chunk\r\n',
				'Yet another (fourth) chunk\r\n',
			])
				res.write(chunk);
			res.addTrailers({ 'X-Test-Me': 'Trailer header value' });
			res.end();
		},
		'content-in-chunks.py': async (req, res, url) => {
			const query = queryOf(url);
			const delay = Number(query.first('ms', '100'));
			res.writeHead(200, {
				'Content-Type': query.first('type', 'text/plain'),
				'Transfer-Encoding': 'chunked',
			});
			res.flushHeaders();
			for (const chunk of query.list('chunk')) {
				await sleep(delay);
				res.write(Buffer.from(chunk, 'hex'));
			}
			res.end();
		},
		// five good chunks, then bytes that are no chunk
		'bad-chunk-encoding.py': async (req, res) => {
			await sleep(100);
			await socketWrite(
				res,
				[
					'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n',
					...Array.from({ length: 5 }, () => 'a\r\nTEST_CHUNK\r\n'),
					'garbage',
				],
				{ wait: 100 },
			);
		},
		'gzip.py': async (req, res, url) => {
			const query = queryOf(url);
			const output = gzipSync(
				bytes(
					query.has('content') ? query.first('content') : await bodyOf(req),
				),
			);
			res.statusCode = 200;
			for (const [name, value] of [
				['Content-type', 'text/plain'],
				['Content-Encoding', 'gzip'],
				...requestEcho(req, url),
				['Content-Length', output.length],
			])
				res.setHeader(name, value);
			res.end(output);
		},
		'zlib.py': async (req, res, url) => {
			const query = queryOf(url);
			const output = deflateSync(
				bytes(
					query.has('content') ? query.first('content') : await bodyOf(req),
				),
				{ level: 9 },
			);
			res.statusCode = 200;
			for (const [name, value] of [
				['Content-type', 'text/plain'],
				['Content-Encoding', 'deflate'],
				...requestEcho(req, url),
				['Content-Length', output.length],
			])
				res.setHeader(name, value);
			res.end(output);
		},
		'requri.py': (req, res, url) =>
			send(res, {
				body: queryOf(url).has('full')
					? `http://${req.headers.host}${req.url}`
					: req.url,
			}),
		'reset-token.py': (req, res, url) => {
			put(url, queryOf(url).first('token'), '');
			send(res, {
				headers: [['Access-Control-Allow-Origin', origin(req)]],
				body: 'PASS',
			});
		},
		'infinite-redirects.py': (req, res, url) => {
			const query = queryOf(url);
			const page =
				query.first('page') === 'alternate' ? 'default' : 'alternate';
			let type = query.first('type') === '301' ? 301 : 302;
			let mix = 0;
			if (query.first('mix') === '1') {
				mix = 1;
				type = type === 301 ? 302 : 301;
			}
			const location = `http://${req.headers.host}${url.pathname}?page=${page}&type=${type}&mix=${mix}`;
			send(res, {
				status: 301,
				headers: [
					['Cache-Control', 'no-cache'],
					['Pragma', 'no-cache'],
					['Location', location],
				],
				body: `Hello guest. You have been redirected to ${location}`,
			});
		},
		'redirect-cors.py': (req, res, url) => {
			const query = queryOf(url);
			const location = query.first('location');
			const out = { status: 200, headers: [] };
			if (req.method === 'OPTIONS') {
				if (query.has('redirect_preflight')) {
					out.status = 302;
					out.headers.push(['Location', location]);
				}
				out.headers.push(
					['Access-Control-Allow-Methods', 'GET'],
					['Access-Control-Max-Age', '1'],
				);
			} else if (req.method === 'GET') {
				out.status = 302;
				out.headers.push(['Location', location]);
			}
			if (query.has('allow_origin'))
				out.headers.push(['Access-Control-Allow-Origin', origin(req)]);
			if (query.has('allow_header'))
				out.headers.push([
					'Access-Control-Allow-Headers',
					query.first('allow_header'),
				]);
			send(res, out);
		},
		'empty-div-utf8-html.py': fixed(
			'text/html;charset=utf-8',
			'<!DOCTYPE html><div></div>',
		),
		'img-utf8-html.py': fixed('text/html;charset=utf-8', '<img>foo'),
		'invalid-utf8-html.py': fixed('text/html;charset=utf-8', '\xff'),
		'invalid-utf8.py': fixed('application/json', '{"key":"\xff"}'),
		'json-with-bom.py': fixed(
			'application/json',
			'\xef\xbb\xbf{"key":"value"}',
		),
		// the python returns chr(0xff) as text, which wptserve writes as UTF-8
		'win-1252-html.py': fixed('text/html;charset=windows-1252', '\xc3\xbf'),
		'win-1252-xml.py': fixed('application/xml;charset=windows-1252', '<\xff/>'),
		'shift-jis-html.py': fixed(
			'text/html;charset=shift-jis',
			'\x83\x65\x83\x58\x83\x67',
		),
		'last-modified.py': (req, res) => {
			const file = `${root}xhr/resources/well-formed.xml`;
			send(res, {
				headers: [
					['Last-Modified', statSync(file).mtime.toUTCString()],
					['Content-Type', 'application/xml'],
				],
				body: readFileSync(file, 'latin1'),
			});
		},
		'get-set-cookie.py': (req, res, url) => {
			const days = queryOf(url).first('clear') ? -1 : null;
			send(res, {
				headers: [
					['Content-type', 'text/plain'],
					setCookie('WK-test', '1', { days }),
					setCookie('WK-test-secure', '1', { days, secure: true }),
				],
				body: cookiePairs(req)
					.map(([name, value]) => ` ${name}=${value}`)
					.join(''),
			});
		},
		'conditional.py': (req, res, url) => {
			const query = queryOf(url);
			const tag = query.first('tag');
			const date = query.first('date', '');
			const cors = query.first('cors');
			const match = req.headers['if-none-match'] ?? null;
			const modified = req.headers['if-modified-since'] ?? null;
			if (req.method === 'OPTIONS')
				return send(res, {
					headers: [
						['Access-Control-Allow-Origin', '*'],
						['Access-Control-Allow-Headers', 'IF-NONE-MATCH'],
					],
				});
			const headers = [];
			if (tag) headers.push(['ETag', `"${tag}"`]);
			else if (date) headers.push(['Last-Modified', date]);
			if (cors) headers.push(['Access-Control-Allow-Origin', '*']);
			if (
				(match !== null && match === tag) ||
				(modified !== null && modified === date)
			)
				return send(res, { status: 304, text: 'SUPERCOOL', headers });
			if (!cors) headers.push(['Access-Control-Allow-Origin', '*']);
			headers.push(['Content-Type', 'text/plain']);
			send(res, { headers, body: 'MAYBE NOT' });
		},
		'header-user-agent.py': (req, res) => {
			const out = {
				status: 200,
				headers: [
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Max-Age', '0'],
					['Access-Control-Allow-Headers', 'x-test'],
				],
				body: '',
			};
			const agent = req.headers['user-agent'];
			if (req.method === 'OPTIONS') {
				if (!agent) {
					out.body = 'FAIL: User-Agent header missing in preflight request.';
					out.status = 400;
				}
			} else if (agent) out.body = 'PASS';
			else {
				out.body = 'FAIL: User-Agent header missing in request';
				out.status = 400;
			}
			send(res, out);
		},
		'echo-content-cors.py': async (req, res, url) => {
			const query = queryOf(url);
			const headers = [
				['X-Request-Method', req.method],
				['X-Request-Content-Length', req.headers['content-length'] ?? 'NO'],
				['X-Request-Content-Type', req.headers['content-type'] ?? 'NO'],
				['Access-Control-Allow-Credentials', 'true'],
				['Content-Type', 'text/plain'],
			];
			// the python reads all three from ?origin first
			const allowOrigin = query.first('origin', origin(req));
			headers.push(['Access-Control-Allow-Origin', allowOrigin]);
			headers.push([
				'Access-Control-Allow-Headers',
				query.first('origin', req.headers['access-control-request-headers']),
			]);
			const method = query.first(
				'origin',
				req.headers['access-control-request-method'],
			);
			if (method !== null && method !== undefined)
				headers.push(['Access-Control-Allow-Methods', `OPTIONS, ${method}`]);
			send(res, { headers, body: await bodyOf(req) });
		},
		'cors-upload-listener-timing.py': async (req, res, url) => {
			const query = queryOf(url);
			const key = query.first('id');
			const headers = [['Cache-Control', 'no-store']];
			if (query.has('read')) {
				headers.push(
					['Access-Control-Allow-Origin', '*'],
					['Content-Type', 'application/json'],
				);
				return send(res, {
					headers,
					body: JSON.stringify(take(url, key) || []),
				});
			}
			put(url, key, [...(take(url, key) || []), req.method]);
			if (query.first('cors') === 'allow')
				headers.push(
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Allow-Methods', 'POST'],
					['Access-Control-Max-Age', '0'],
				);
			headers.push(['Content-Type', 'text/plain']);
			send(res, {
				headers,
				body: req.method === 'OPTIONS' ? '' : await bodyOf(req),
			});
		},
		'no-custom-header-on-preflight.py': (req, res, url) => {
			const token = queryOf(url).first('token');
			const out = {
				status: 200,
				headers: [
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Allow-Headers', 'x-test'],
					['Access-Control-Max-Age', '0'],
				],
				body: '',
			};
			if (req.method === 'OPTIONS') {
				if (req.headers['x-test']) {
					out.body = 'FAIL: Invalid header in preflight request.';
					out.status = 400;
				} else put(url, token, 'PASS');
			} else if (req.headers['x-test']) out.body = takeState(url, token);
			else {
				out.body = 'FAIL: X-Test header missing in request';
				out.status = 400;
			}
			send(res, out);
		},
		'access-control-allow-lists.py': (req, res, url) => {
			const query = queryOf(url);
			const headers = [];
			if (query.has('origin'))
				headers.push(['Access-Control-Allow-Origin', query.first('origin')]);
			if (query.has('headers'))
				headers.push(['Access-Control-Allow-Headers', query.first('headers')]);
			if (query.has('methods'))
				headers.push(['Access-Control-Allow-Methods', query.first('methods')]);
			const first = {};
			for (const [name, values] of Object.entries(req.headersDistinct))
				first[name] = values[0];
			send(res, { headers, body: JSON.stringify(first) });
		},
		'access-control-allow-with-body.py': (req, res) =>
			send(res, {
				headers: [
					['Cache-Control', 'no-store'],
					['Access-Control-Allow-Headers', 'X-Requested-With'],
					['Access-Control-Max-Age', '0'],
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Allow-Methods', '*'],
					['Vary', 'Accept-Encoding'],
					['Content-Type', 'text/plain'],
				],
				body: 'PASS',
			}),
		'access-control-auth-basic.py': (req, res, url) => {
			const headers = [
				['Cache-Control', 'no-store'],
				['Access-Control-Allow-Origin', origin(req)],
				['Access-Control-Allow-Credentials', 'true'],
			];
			if (req.method === 'OPTIONS') {
				headers.push(['Access-Control-Allow-Methods', 'PUT']);
				return send(res, { headers });
			}
			const { username, password } = auth(req);
			if (!username || username !== queryOf(url).first('uid')) {
				headers.push([
					'WWW-Authenticate',
					"Basic realm='Test Realm/Cross Origin'",
				]);
				return send(res, {
					status: 401,
					headers,
					body: 'Authentication cancelled',
				});
			}
			send(res, {
				headers,
				body: `User: ${username}, Password: ${password}`,
			});
		},
		'access-control-basic-allow.py': (req, res) =>
			send(res, {
				headers: [
					['Content-Type', 'text/plain'],
					['Access-Control-Allow-Credentials', 'true'],
					['Access-Control-Allow-Origin', origin(req)],
				],
				body: 'PASS: Cross-domain access allowed.',
			}),
		'access-control-basic-allow-no-credentials.py': (req, res) =>
			send(res, {
				headers: [
					['Content-Type', 'text/plain'],
					['Access-Control-Allow-Origin', origin(req)],
				],
				body: 'PASS: Cross-domain access allowed.',
			}),
		'access-control-basic-allow-star.py': (req, res) =>
			send(res, {
				headers: [
					['Content-Type', 'text/plain'],
					['Access-Control-Allow-Origin', '*'],
				],
				body: 'PASS: Cross-domain access allowed.',
			}),
		// the python sets `response.text`, which is no body
		'access-control-basic-denied.py': (req, res) =>
			send(res, {
				headers: [
					['Cache-Control', 'no-store'],
					['Content-Type', 'text/plain'],
				],
			}),
		'access-control-basic-options-not-supported.py': (req, res) => {
			const headers = [['Cache-Control', 'no-store']];
			if (req.method === 'OPTIONS') return send(res, { status: 400, headers });
			if (origin(req) === undefined) return send(res, { status: 500, headers });
			headers.push(
				['Access-Control-Allow-Credentials', 'true'],
				['Access-Control-Allow-Origin', origin(req)],
			);
			send(res, { headers });
		},
		'access-control-basic-put-allow.py': async (req, res) => {
			const headers = [['Content-Type', 'text/plain']];
			if (req.method === 'OPTIONS' || req.method === 'PUT')
				headers.push(['Access-Control-Allow-Credentials', 'true']);
			if (req.method === 'OPTIONS')
				headers.push(['Access-Control-Allow-Methods', 'PUT']);
			if (req.method === 'OPTIONS' || req.method === 'PUT')
				headers.push(['Access-Control-Allow-Origin', origin(req)]);
			send(res, {
				headers,
				body:
					req.method === 'OPTIONS'
						? ''
						: req.method === 'PUT'
							? `PASS: Cross-domain access allowed.\n${await bodyOf(req)}`
							: `Wrong method: ${req.method}`,
			});
		},
		'access-control-basic-cors-safelisted-request-headers.py': (req, res) => {
			const headers = [['Cache-Control', 'no-store']];
			if (req.method !== 'POST') return send(res, { status: 400, headers });
			headers.push(
				['Access-Control-Allow-Credentials', 'true'],
				['Access-Control-Allow-Origin', origin(req)],
			);
			let body = '';
			for (const name of [
				'Accept',
				'Accept-Language',
				'Content-Language',
				'Content-Type',
			])
				body += `${name}: ${req.headers[name.toLowerCase()] || '<None>'}\n`;
			send(res, { headers, body });
		},
		'access-control-basic-cors-safelisted-response-headers.py': (req, res) =>
			send(res, {
				headers: [
					['content-type', 'text/plain'],
					['cache-control', 'no cache'],
					['content-language', 'en'],
					['expires', 'Fri, 30 Oct 1998 14:19:41 GMT'],
					['last-modified', 'Tue, 15 Nov 1994 12:45:26 GMT'],
					['pragma', 'no-cache'],
					['x-test', 'foobar'],
					['Access-Control-Allow-Origin', '*'],
				],
				body: 'PASS: Cross-domain access allowed.',
			}),
		'access-control-cookie.py': (req, res, url) => {
			const name = queryOf(url).first('cookie_name', '');
			const headers = [
				['Cache-Control', 'no-store'],
				['Access-Control-Allow-Origin', origin(req)],
				['Access-Control-Allow-Credentials', 'true'],
			];
			for (const [cookie] of cookiePairs(req))
				headers.push(setCookie(cookie, 'deleted', { days: -1 }));
			if (name) headers.push(setCookie(name, 'COOKIE', { days: 1 }));
			send(res, { headers });
		},
		'access-control-origin-header.py': (req, res) =>
			send(res, {
				headers: [
					['Content-Type', 'text/plain'],
					['Cache-Control', 'no-cache, no-store'],
					['Access-Control-Allow-External', 'true'],
					['Access-Control-Allow-Origin', '*'],
				],
				body: `PASS: Cross-domain access allowed.\nHTTP_ORIGIN: ${origin(req)}`,
			}),
		'access-control-basic-preflight-cache.py': preflightCache(
			({ state, method, out, fail, set }) => {
				if (state === 'Uninitialized') {
					if (method !== 'OPTIONS') return fail(state);
					out.headers.push(
						['Access-Control-Allow-Methods', 'PUT'],
						['Access-Control-Max-Age', '10'],
					);
					set('OPTIONSSent');
				} else if (state === 'OPTIONSSent') {
					if (method !== 'PUT') return fail(state);
					out.body = 'PASS: First PUT request.';
					set('FirstPUTSent');
				} else if (state === 'FirstPUTSent') {
					if (method === 'PUT')
						out.body = 'PASS: Second PUT request. Preflight worked.';
					else if (method === 'OPTIONS') {
						out.headers.push(['Access-Control-Allow-Methods', 'PUT']);
						set('FAILSecondOPTIONSSent');
					} else fail(state);
				} else if (state === 'FAILSecondOPTIONSSent' && method === 'PUT')
					fail('Second OPTIONS request was sent. Preflight failed.');
				else fail(state);
			},
			400,
		),
		'access-control-basic-preflight-cache-invalidation.py': preflightCache(
			({ state, method, out, fail, set }) => {
				if (state === 'Uninitialized') {
					if (method !== 'OPTIONS') return fail(state);
					out.headers.push(
						['Access-Control-Allow-Methods', 'PUT'],
						['Access-Control-Max-Age', '10'],
					);
					set('OPTIONSSent');
				} else if (state === 'OPTIONSSent') {
					if (method !== 'PUT') return fail(state);
					out.body = 'PASS: First PUT request.';
					set('FirstPUTSent');
				} else if (state === 'FirstPUTSent') {
					if (method === 'OPTIONS') {
						out.headers.push(
							['Access-Control-Allow-Methods', 'PUT, XMETHOD'],
							['Access-Control-Allow-Headers', 'x-test'],
						);
						set('SecondOPTIONSSent');
					} else if (method === 'PUT')
						fail('Second PUT request sent without preflight');
					else fail(state);
				} else if (
					state === 'SecondOPTIONSSent' &&
					(method === 'PUT' || method === 'XMETHOD')
				)
					out.body = 'PASS: Second OPTIONS request was sent.';
				else fail(state);
			},
		),
		'access-control-basic-preflight-cache-timeout.py': preflightCache(
			({ state, method, out, fail, set }) => {
				if (state === 'Uninitialized') {
					if (method !== 'OPTIONS') return fail(state);
					out.headers.push(
						['Access-Control-Allow-Methods', 'PUT'],
						['Access-Control-Allow-Headers', 'x-test'],
						['Access-Control-Max-Age', '1'],
					);
					set('OPTIONSSent');
				} else if (state === 'OPTIONSSent') {
					if (method !== 'PUT') return fail(state);
					out.body = 'PASS: First PUT request.';
					set('FirstPUTSent');
				} else if (state === 'FirstPUTSent') {
					if (method === 'OPTIONS') {
						out.headers.push(
							['Access-Control-Allow-Methods', 'PUT'],
							['Access-Control-Allow-Headers', 'x-test'],
						);
						set('SecondOPTIONSSent');
					} else if (method === 'PUT')
						fail('Second PUT request sent without preflight');
					else fail(state);
				} else if (state === 'SecondOPTIONSSent' && method === 'PUT')
					out.body = 'PASS: Second OPTIONS request was sent.';
				else fail(state);
			},
		),
		'access-control-preflight-denied.py': (req, res, url) => {
			const query = queryOf(url);
			const token = query.first('token');
			const command = query.first('command');
			const state = takeState(url, token);
			const out = {
				status: 200,
				headers: [
					['Cache-Control', 'no-store'],
					['Access-Control-Allow-Origin', origin(req)],
					['Access-Control-Max-Age', '1'],
				],
				body: '',
			};
			const fail = (message) => {
				out.body = `FAIL: ${message}`;
				out.status = 400;
			};
			const set = (next) => put(url, token, next);
			if (command === 'reset') {
				if (req.method === 'GET') {
					set('');
					out.body = 'Server state reset';
				} else fail('Invalid Method.');
			} else if (state === 'Uninitialized') {
				if (req.method === 'OPTIONS') {
					out.body = 'This request should not be displayed.';
					set('Denied');
				} else fail(state);
			} else if (state === 'Denied') {
				if (req.method === 'GET' && command === 'complete') {
					set('');
					out.body = 'Request successfully blocked.';
				} else {
					set('Deny Ignored');
					fail('The request was not denied.');
				}
			} else if (state === 'Deny Ignored') {
				set('');
				fail(state);
			} else {
				set('');
				fail('Unknown Error.');
			}
			send(res, out);
		},
		'access-control-preflight-request-allow-headers-returns-star.py': (
			req,
			res,
		) => {
			if (req.method === 'OPTIONS')
				return send(res, {
					headers: [
						['Access-Control-Allow-Origin', '*'],
						['Access-Control-Allow-Headers', '*'],
					],
				});
			const headers = [['Access-Control-Allow-Origin', '*']];
			if (req.method !== 'GET') return send(res, {});
			if (!req.headers['x-test']) return send(res, { status: 400, headers });
			headers.push(['Content-Type', 'text/plain']);
			send(res, { headers, body: 'PASS' });
		},
		'access-control-preflight-request-header-returns-origin.py': (req, res) => {
			if (req.method === 'OPTIONS')
				return send(res, {
					headers: [
						['Access-Control-Allow-Origin', origin(req)],
						['Access-Control-Allow-Headers', 'X-Test'],
					],
				});
			const headers = [['Access-Control-Allow-Origin', '*']];
			if (req.method !== 'GET') return send(res, {});
			if (!req.headers['x-test']) return send(res, { status: 400, headers });
			headers.push(['Content-Type', 'text/plain']);
			send(res, { headers, body: 'PASS' });
		},
		'access-control-preflight-request-headers-origin.py': (req, res) => {
			const headers = [
				['Cache-Control', 'no-store'],
				['Access-Control-Allow-Origin', '*'],
			];
			if (req.method !== 'OPTIONS')
				return send(res, { headers, body: req.headers['x-pass'] ?? '' });
			if (
				(req.headers['access-control-request-headers'] ?? '')
					.toLowerCase()
					.includes('origin')
			)
				return send(res, {
					status: 400,
					headers,
					body: "Error: 'origin' included in Access-Control-Request-Headers",
				});
			headers.push(['Access-Control-Allow-Headers', 'x-pass']);
			send(res, { headers });
		},
		'access-control-preflight-request-header-lowercase.py': (req, res) => {
			const out = {
				status: 200,
				headers: [
					['Cache-Control', 'no-store'],
					['Access-Control-Allow-Origin', '*'],
					['Access-Control-Max-Age', '0'],
				],
				body: '',
			};
			if (req.method === 'OPTIONS') {
				// case-sensitive on purpose: the names must arrive in lower case
				if (
					(req.headers['access-control-request-headers'] ?? '')
						.split(',')
						.map((name) => name.replace(/^ +| +$/g, ''))
						.includes('x-test')
				)
					out.headers.push(['Access-Control-Allow-Headers', 'X-Test']);
				else out.status = 400;
			} else if (req.method === 'GET') {
				if (req.headers['x-test']) out.body = 'PASS';
				else out.status = 400;
			}
			send(res, out);
		},
		'access-control-preflight-request-header-sorted.py': (req, res) => {
			const wanted =
				'x-custom-s,x-custom-test,x-custom-u,x-custom-ua,x-custom-v';
			const out = {
				status: 200,
				headers: [
					['Cache-Control', 'no-store'],
					['Access-Control-Allow-Origin', origin(req)],
				],
				body: '',
			};
			if (req.method === 'OPTIONS') {
				out.headers.push(
					['Access-Control-Max-Age', '0'],
					['Access-Control-Allow-Headers', wanted],
				);
				if (req.headers['access-control-request-headers'] !== wanted)
					out.status = 400;
			} else if (req.headers['x-custom-s']) out.body = 'PASS';
			else {
				out.status = 400;
				out.body = 'FAIL';
			}
			send(res, out);
		},
		'access-control-preflight-request-invalid-status.py': (req, res, url) => {
			const code = Number(queryOf(url).first('code')) || 0;
			const out = { status: 200, headers: [] };
			if (req.method === 'OPTIONS') {
				if (code) out.status = code;
				out.headers.push(
					['Access-Control-Max-Age', '1'],
					['Access-Control-Allow-Headers', 'x-pass'],
				);
			}
			out.headers.push(
				['Cache-Control', 'no-store'],
				['Access-Control-Allow-Origin', origin(req)],
			);
			send(res, out);
		},
		'access-control-preflight-request-must-not-contain-cookie.py': (
			req,
			res,
		) => {
			const foo = cookiePairs(req).find(([name]) => name === 'foo')?.[1];
			if (req.method === 'OPTIONS' && foo) return send(res, { status: 400 });
			send(res, {
				headers: [
					['Cache-Control', 'no-store'],
					['Access-Control-Allow-Origin', origin(req)],
					['Access-Control-Allow-Credentials', 'true'],
					['Access-Control-Allow-Headers', 'X-Proprietary-Header'],
					['Connection', 'close'],
				],
				body: foo || '',
			});
		},
		'authentication.py': (req, res, url) => authentication(req, res, url),
		'auth5/auth.py': fixedAuth,
		'auth6/auth.py': fixedAuth,
		'auth1/corsenabled.py': corsAuth('authorization, x-user, x-pass'),
		'auth2/corsenabled.py': corsAuth('authorization, x-user, x-pass'),
		'auth7/corsenabled.py': corsAuth('authorization, x-user, x-pass'),
		'auth8/corsenabled-no-authorize.py': corsAuth('x-user, x-pass'),
	};
	for (const n of [1, 2, 3, 4, 9, 10, 11])
		handlers[`auth${n}/auth.py`] = (req, res, url) =>
			authentication(req, res, url);

	const keyed = {};
	for (const [name, handler] of Object.entries(handlers))
		keyed[dir + name] = handler;

	// the two of fetch/api/resources/ the xhr tests borrow
	keyed['/fetch/api/resources/dump-authorization-header.py'] = (
		req,
		res,
		url,
	) => {
		const headers = [
			['Content-Type', 'text/html'],
			['Cache-Control', 'no-cache'],
		];
		if (
			queryOf(url).first('strip_auth_header') &&
			req.method === 'OPTIONS' &&
			(req.headers['access-control-request-headers'] ?? '')
				.toLowerCase()
				.includes('authorization')
		)
			return send(res, { status: 500, headers, body: 'fail' });
		if (origin(req) !== undefined)
			headers.push(
				['Access-Control-Allow-Origin', origin(req)],
				['Access-Control-Allow-Credentials', 'true'],
			);
		else headers.push(['Access-Control-Allow-Origin', '*']);
		headers.push(['Access-Control-Allow-Headers', 'Authorization']);
		send(res, { headers, body: req.headers.authorization ?? 'none' });
	};
	keyed['/fetch/api/resources/bad-chunk-encoding.py'] = async (
		req,
		res,
		url,
	) => {
		const query = queryOf(url);
		const delay = Number(query.first('ms', '1000'));
		const count = Number(query.first('count', '50'));
		await sleep(delay);
		await socketWrite(
			res,
			[
				'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
				...Array.from({ length: count }, () => 'a\r\nTEST_CHUNK\r\n'),
				'garbage',
			],
			{ wait: delay },
		);
	};

	return {
		handlers: keyed,
		patches: {
			// a variant with a space in it (xmlhttprequest-timeout-*.html) is
			// reported percent-encoded and the suite asks for it as written
			'/resources/testharnessreport.js': [
				['search: location.search,', 'search: decodeURI(location.search),'],
			],
			// these name their subtests after a URL with the fixture's port, which
			// is another one every run: the expected list needs a name that stays
			...Object.fromEntries(
				[
					'/xhr/event-upload-progress.any.js',
					'/xhr/event-upload-progress-crossorigin.any.js',
				].map((path) => [
					path,
					[
						[
							'"Upload events registered too late (" + url + ")"',
							'"Upload events registered too late (" + url.replace(/:\\d+/, ":PORT") + ")"',
						],
					],
				]),
			),
		},
		patterns: [
			// 1.16 MB of "abcd", written here instead of vendored
			[
				/^\/xhr\/resources\/over-1-meg\.txt$/,
				(req, res) =>
					send(res, {
						headers: [['Content-Type', 'text/plain; charset=utf-8']],
						body: 'abcd'.repeat(290000),
					}),
			],
			// a .py nobody ported must not be served as a file or hang
			[
				/^\/xhr\/resources\/.*\.py$/,
				(req, res, url) => {
					const known = existsSync(`${root}${url.pathname.slice(1)}`);
					send(res, {
						status: 404,
						headers: [['Content-Type', 'text/plain']],
						body: `no handler: ${url.pathname}${known ? ' (vendored)' : ''}`,
					});
				},
			],
		],
	};
};
