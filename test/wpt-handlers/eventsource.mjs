// The wptserve handlers of the vendored eventsource tests
// (eventsource/resources/*.py, the two `.event_stream` files, and the two
// handlers of other directories those tests call), ported from the python.
//
// One thing is ours: a cookie set on a cross-origin request carries
// `SameSite=None; Secure`. The tests' other origins (www2.localhost, the IDN
// subdomain) are same-site with the page on wptserve's domain and cross-site
// on the fixture, where a cookie without the attribute would never come back
// and the credentialed cases would fail natively for a reason that has
// nothing to do with EventSource.
import { existsSync, readFileSync } from 'node:fs';

/** percent-decoding to bytes, as wptserve's request.GET holds its values */
function decode(text) {
	const source = Buffer.from(text.replace(/\+/g, ' '), 'utf8');
	const bytes = [];
	for (let i = 0; i < source.length; i++) {
		const hex = source.toString('latin1', i + 1, i + 3);
		if (source[i] === 0x25 && /^[0-9a-f]{2}$/i.test(hex)) {
			bytes.push(parseInt(hex, 16));
			i += 2;
		} else bytes.push(source[i]);
	}
	return Buffer.from(bytes);
}

/** every value of the query parameter `name`, as bytes */
function params(url, name) {
	const values = [];
	for (const part of url.search.slice(1).split('&')) {
		if (!part) continue;
		const eq = part.indexOf('=');
		const key = eq < 0 ? part : part.slice(0, eq);
		if (decode(key).toString('latin1') === name)
			values.push(decode(eq < 0 ? '' : part.slice(eq + 1)));
	}
	return values;
}

const param = (url, name) => params(url, name)[0] ?? null;
const text = (url, name, fallback) =>
	param(url, name)?.toString('latin1') ?? fallback;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default ({ root, setHeaders, substitute, cookiePairs }) => {
	const crossOrigin = (req) => {
		try {
			return new URL(req.headers.origin).host !== req.headers.host;
		} catch {
			return false;
		}
	};
	/** wptserve's response.set_cookie / delete_cookie */
	const setCookie = (req, name, value) =>
		`${name}=${value ?? ''}; Path=/${
			value === null ? '; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''
		}${crossOrigin(req) ? '; SameSite=None; Secure' : ''}`;
	const cookieOf = (req, name) =>
		cookiePairs(req).find(([key]) => key === name)?.[1] ?? null;

	/** send what a python handler returned: status, headers, body */
	function send(res, { status = 200, reason, headers = [], body = '' }) {
		res.statusCode = status;
		if (reason) res.statusMessage = reason;
		setHeaders(res, headers);
		res.end(body);
	}

	// message.py: one message (or `message`), with any MIME type, after `sleep`
	async function message(req, url) {
		const body = Buffer.concat([
			param(url, 'message') ?? Buffer.from('data: data'),
			Buffer.from(text(url, 'newline', '') === 'none' ? '' : '\n\n'),
			Buffer.from('\n'),
		]);
		const wait = Number(text(url, 'sleep', '0')) || 0;
		if (wait) await sleep(wait);
		return {
			headers: [['Content-Type', text(url, 'mime', 'text/event-stream')]],
			body,
		};
	}

	// status-reconnect.py: the status asked for once (a cookie remembers),
	// then a 200 with the message
	function statusReconnect(req, url) {
		const statusCode = text(url, 'status', '204');
		const name = `request${text(url, 'id', statusCode)}`;
		const headers = [['Content-Type', 'text/event-stream']];
		if (cookieOf(req, name) === statusCode) {
			headers.push(['Set-Cookie', setCookie(req, name, null)]);
			return { headers, body: 'data: data\n\n' };
		}
		headers.push(['Set-Cookie', setCookie(req, name, statusCode)]);
		return {
			status: Number(statusCode),
			reason: 'TEST',
			headers,
			body: `retry: 2\n${params(url, 'ok_first').length ? 'data: ok\n\n' : ''}`,
		};
	}

	// common/redirect.py
	function redirect(req, url) {
		const status = Number(text(url, 'status', '302'));
		const headers = [['Location', text(url, 'location', '')]];
		if (params(url, 'enable-cors').length && req.headers.origin)
			headers.push(
				['Content-Type', 'text/plain'],
				['Access-Control-Allow-Origin', req.headers.origin],
				['Access-Control-Allow-Credentials', 'true'],
			);
		return { status: Number.isInteger(status) ? status : 302, headers };
	}

	/** an .event_stream file, its `{{...}}` filled in */
	const eventStream = (name, req, port) =>
		substitute(
			readFileSync(`${root}eventsource/resources/${name}`, 'utf8'),
			req,
			port,
		);

	return {
		handlers: {
			'/eventsource/resources/message.py': async (req, res, url) =>
				send(res, await message(req, url)),
			// message2.py: the same lines every two seconds until the client
			// goes away
			'/eventsource/resources/message2.py': (req, res) => {
				res.statusCode = 200;
				setHeaders(res, [
					['Content-Type', 'text/event-stream'],
					['Cache-Control', 'no-cache'],
				]);
				const write = () =>
					res.write(
						'data:msg\ndata: msg\n\n:\nfalsefield:msg\n\nfalsefield:msg\nData:data\n\ndata\n\ndata:end\n\n',
					);
				write();
				const timer = setInterval(write, 2000);
				res.on('close', () => clearInterval(timer));
			},
			'/eventsource/resources/last-event-id.py': (req, res, url) => {
				// header values reach node as latin1; the id goes back as the
				// bytes it came in
				const last = Buffer.from(req.headers['last-event-id'] ?? '', 'latin1');
				send(res, {
					headers: [['Content-Type', 'text/event-stream']],
					body: last.length
						? Buffer.concat([Buffer.from('data: '), last, Buffer.from('\n\n')])
						: Buffer.concat([
								Buffer.from('id: '),
								param(url, 'idvalue') ?? Buffer.from('\u2026', 'utf8'),
								Buffer.from('\nretry: 200\ndata: hello\n\n'),
							]),
				});
			},
			'/eventsource/resources/last-event-id2.py': (req, res, url) => {
				const type = Number(text(url, 'type', '1'));
				send(res, {
					headers: [['Content-Type', 'text/event-stream']],
					body:
						type === 2
							? 'id: 1\ndata: 1\n\nid:\ndata:2\n\ndata:3\n\n'
							: type === 3
								? 'id: 1\ndata: 1\n\nid\ndata:2\n\ndata:3\n\n'
								: type === 1 || !Number.isInteger(type)
									? 'id: 1\ndata: 1\n\ndata: 2\n\nid: 2\ndata:3\n\ndata:4\n\n'
									: 'data: invalid_test\n\n',
				});
			},
			'/eventsource/resources/status-error.py': (req, res, url) => {
				const status = text(url, 'status', '404');
				send(res, {
					status: Number(status),
					reason: 'HAHAHAHA',
					headers: [['Content-Type', 'text/event-stream']],
					body: status === '204' || status === '205' ? '' : 'data: data\n\n',
				});
			},
			'/eventsource/resources/status-reconnect.py': (req, res, url) =>
				send(res, statusReconnect(req, url)),
			// reconnect-fail.py: open, reconnect once, then a 204 that closes
			'/eventsource/resources/reconnect-fail.py': (req, res, url) => {
				const name = `recon_fail_${text(url, 'id', '')}`;
				const headers = [['Content-Type', 'text/event-stream']];
				const state = cookieOf(req, name);
				if (state === 'opened')
					return send(res, {
						reason: 'RECONNECT',
						headers: [
							...headers,
							['Set-Cookie', setCookie(req, name, 'reconnected')],
						],
						body: 'data: reconnected\n\n',
					});
				if (state === 'reconnected')
					return send(res, {
						status: 204,
						reason: 'NO CONTENT (CLOSE)',
						headers: [...headers, ['Set-Cookie', setCookie(req, name, null)]],
					});
				send(res, {
					reason: 'OPEN',
					headers: [...headers, ['Set-Cookie', setCookie(req, name, 'opened')]],
					body: 'retry: 2\ndata: opened\n\n',
				});
			},
			// cors.py: another handler's answer with the CORS headers asked for
			'/eventsource/resources/cors.py': async (req, res, url, port) => {
				const headers = [
					[
						'Access-Control-Allow-Origin',
						text(url, 'origin', req.headers.origin ?? ''),
					],
					[
						'Access-Control-Allow-Credentials',
						text(url, 'credentials', 'true'),
					],
				];
				const run = text(url, 'run', '');
				const answer =
					run === 'message'
						? await message(req, url)
						: run === 'status-reconnect'
							? statusReconnect(req, url)
							: run === 'redirect'
								? redirect(req, url)
								: run === 'cache-control'
									? {
											headers: [['Content-Type', 'text/event-stream']],
											body: eventStream(
												'cache-control.event_stream',
												req,
												port,
											),
										}
									: {};
				// a header the handler sets replaces the one of that name here
				const named = new Set(
					(answer.headers ?? []).map(([key]) => key.toLowerCase()),
				);
				send(res, {
					...answer,
					headers: [
						...headers.filter(([key]) => !named.has(key.toLowerCase())),
						...(answer.headers ?? []),
					],
				});
			},
			'/eventsource/resources/cors-cookie.py': (req, res, url) => {
				const last = req.headers['last-event-id'] ?? '';
				const ident = text(url, 'ident', 'test');
				const cookie = cookieOf(req, ident) === null ? 'NO_COOKIE' : 'COOKIE';
				const origin = text(url, 'origin', req.headers.origin ?? '');
				const credentials = text(url, 'credentials', 'true');
				const headers = [];
				if (origin !== 'none')
					headers.push(['Access-Control-Allow-Origin', origin]);
				if (credentials !== 'none')
					headers.push(['Access-Control-Allow-Credentials', credentials]);
				if (last === '') {
					headers.push(
						['Content-Type', 'text/event-stream'],
						['Set-Cookie', setCookie(req, ident, 'COOKIE')],
					);
					return send(res, {
						headers,
						body: `id: 1\nretry: 200\ndata: first ${cookie}\n\n`,
					});
				}
				if (last === '1') {
					headers.push(
						['Content-Type', 'text/event-stream'],
						[
							'Set-Cookie',
							`${ident}=COOKIE; Path=/; Expires=Fri, 27 Jul 2001 00:00:00 GMT${
								crossOrigin(req) ? '; SameSite=None; Secure' : ''
							}`,
						],
					);
					return send(res, {
						headers,
						body: `id: 2\ndata: second ${cookie}\n\n`,
					});
				}
				headers.push(['Content-Type', 'stop']);
				send(res, { headers, body: `data: ${last}${cookie}\n\n` });
			},
			'/common/redirect.py': (req, res, url) => send(res, redirect(req, url)),
			// xhr/resources/content-in-chunks.py: each hex `chunk` as a chunk of
			// its own, `ms` apart
			'/xhr/resources/content-in-chunks.py': async (req, res, url) => {
				const delay = Number(text(url, 'ms', '100'));
				res.statusCode = 200;
				res.setHeader('Content-Type', text(url, 'type', 'text/plain'));
				res.flushHeaders();
				for (const chunk of params(url, 'chunk')) {
					await sleep(delay);
					res.write(Buffer.from(chunk.toString('latin1'), 'hex'));
				}
				res.end();
			},
		},
		patterns: [
			// wptserve serves .event_stream as text/event-stream, a type the
			// fixture's table does not have; `?pipe=sub` is the only pipe the
			// tests put on one
			[
				/^\/eventsource\/resources\/[\w-]+\.event_stream$/,
				(req, res, url, port) => {
					const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
					if (!existsSync(`${root}eventsource/resources/${name}`)) {
						res.statusCode = 404;
						return res.end();
					}
					send(res, {
						headers: [['Content-Type', 'text/event-stream']],
						body: (url.searchParams.get('pipe') ?? '').includes('sub')
							? eventStream(name, req, port)
							: readFileSync(`${root}eventsource/resources/${name}`),
					});
				},
			],
		],
	};
};
