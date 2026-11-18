// The pywebsocket handlers of websockets/handlers/ that the vendored
// websockets tests connect to (`<name>_wsh.py` there is the endpoint
// `/<name>`), on the fixture's own port, and the two python handlers the
// tests fetch over http.
//
// What pywebsocket does around a handler is kept: a handler that returns
// closes with 1000, the permessage-deflate extension is accepted unless the
// handler turns extensions off, and no subprotocol is chosen unless the
// handler picks one. One difference: a client's Close is answered with its
// own code and reason by every endpoint (the `ws` package's way, and what
// echo_wsh.py asks for), where pywebsocket's default answer is 1000.
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (req) =>
	createHash('sha1')
		.update(`${req.headers['sec-websocket-key'] ?? ''}${GUID}`)
		.digest('base64');

/** a Close frame from the server: code and reason, unmasked */
function closeFrame(code, reason = '') {
	const text = Buffer.from(reason, 'utf8');
	const frame = Buffer.alloc(4 + text.length);
	frame[0] = 0x88;
	frame[1] = 2 + text.length;
	frame.writeUInt16BE(code, 2);
	text.copy(frame, 4);
	return frame;
}

export default () => {
	/**
	 * An endpoint: `protocol(req)` is the subprotocol to answer with (none
	 * when it returns nothing), `extensions: false` refuses every extension,
	 * `before(req)` runs ahead of the handshake, `run(ws, req, url, socket)`
	 * is the handler's transfer_data. When `run` settles the server closes
	 * with 1000, as pywebsocket does when a handler returns.
	 */
	const endpoint = ({ protocol, extensions = true, before, run }) => {
		const server = new WebSocketServer({
			noServer: true,
			perMessageDeflate: extensions,
			// only what the handler picks: `ws` would take the first one offered
			handleProtocols: () => false,
		});
		return async (req, socket, head, url) => {
			if (before) await before(req);
			if (socket.destroyed) return;
			const chosen = protocol?.(req);
			const addProtocol = (headers) => {
				if (chosen) headers.push(`Sec-WebSocket-Protocol: ${chosen}`);
			};
			server.once('headers', addProtocol);
			server.handleUpgrade(req, socket, head, async (ws) => {
				ws.on('error', () => {});
				// from the first frame: a handler's receive() reads them in order
				inboxOf(ws);
				try {
					await run?.(ws, req, url, socket);
				} catch (error) {
					console.error(`wpt websocket ${url.pathname}: ${error.stack}`);
				}
				if (ws.readyState === ws.OPEN) ws.close(1000);
			});
			server.off('headers', addProtocol);
		};
	};

	/**
	 * The socket's messages in the order they came, read one at a time as
	 * pywebsocket's receive_message() reads them: `ws` emits every frame of
	 * one TCP read at once, so a listener added again after an await missed
	 * all but the first of a burst (a client that offers no
	 * permessage-deflate, whose inflating spaces them out, sends one)
	 */
	const inboxes = new WeakMap();
	const inboxOf = (ws) => {
		let inbox = inboxes.get(ws);
		if (inbox) return inbox;
		inbox = { messages: [], waiting: [], closed: false };
		inboxes.set(ws, inbox);
		ws.on('message', (data, binary) => {
			const waiter = inbox.waiting.shift();
			if (waiter) waiter({ data, binary });
			else inbox.messages.push({ data, binary });
		});
		ws.once('close', () => {
			inbox.closed = true;
			for (const waiter of inbox.waiting.splice(0)) waiter(null);
		});
		return inbox;
	};
	/** the next message, null once the socket closes */
	const receive = (ws) => {
		const inbox = inboxOf(ws);
		if (inbox.messages.length) return Promise.resolve(inbox.messages.shift());
		if (inbox.closed || ws.readyState === ws.CLOSED)
			return Promise.resolve(null);
		return new Promise((resolve) => inbox.waiting.push(resolve));
	};
	/** until the client closes or the handler's loop ends */
	const closed = (ws) =>
		new Promise((resolve) => {
			if (ws.readyState === ws.CLOSED) resolve();
			else ws.once('close', resolve);
		});
	/**
	 * Take the answer to the client's Close away from `ws` (its receiver
	 * answers at once with the same code): `answer(code, reason)` decides.
	 */
	const onClientClose = (ws, answer) => {
		ws._receiver.removeAllListeners('conclude');
		ws._receiver.on('conclude', (code, reason) => {
			ws._closeFrameReceived = true;
			ws._closeCode = code;
			ws._closeMessage = reason;
			answer(code, reason);
		});
	};

	/** send one text message and return (the server then closes) */
	const say = (text) => endpoint({ run: (ws, req) => ws.send(text(req)) });

	const echo = async (ws, { reply = true } = {}) => {
		for (;;) {
			const message = await receive(ws);
			if (message === null) return;
			if (message.binary) {
				if (reply) ws.send(message.data, { binary: true });
				continue;
			}
			const line = message.data.toString('utf8');
			if (reply) ws.send(line);
			if (line === 'Goodbye') return;
		}
	};

	const upgrades = {
		'/echo': endpoint({
			protocol: (req) =>
				(req.headers['sec-websocket-protocol'] ?? '')
					.split(',')
					.map((name) => name.trim())
					.includes('echo')
					? 'echo'
					: undefined,
			run: (ws) => echo(ws),
		}),
		'/echo_exit': endpoint({ run: (ws) => echo(ws, { reply: false }) }),
		'/echo_close_data': endpoint({ run: (ws) => echo(ws, { reply: false }) }),
		// every message goes back as raw bytes on the connection: the test
		// writes its own frames
		'/echo_raw': endpoint({
			run: async (ws, req, url, socket) => {
				for (;;) {
					const message = await receive(ws);
					if (message === null) return;
					if (message.data.toString('latin1') === 'exit') return;
					socket.write(message.data);
				}
			},
		}),
		'/echo-query': say((req) => req.url.split('?')[1] ?? ''),
		'/echo-query_v13': say((req) => req.url.split('?')[1] ?? ''),
		'/empty-message': endpoint({
			run: async (ws) => {
				const message = await receive(ws);
				if (message === null) return;
				ws.send(!message.binary && message.data.length === 0 ? 'pass' : 'fail');
			},
		}),
		'/origin': say((req) => req.headers.origin ?? ''),
		'/referrer': say((req) => req.headers.referer ?? 'MISSING AS PER FETCH'),
		'/protocol': endpoint({
			protocol: (req) => req.headers['sec-websocket-protocol'],
			run: (ws, req) => ws.send(req.headers['sec-websocket-protocol'] ?? ''),
		}),
		'/protocol_array': endpoint({
			protocol: (req) =>
				(req.headers['sec-websocket-protocol'] ?? '').split(',')[0],
			run: (ws, req) =>
				ws.send((req.headers['sec-websocket-protocol'] ?? '').split(',')[0]),
		}),
		'/handshake_protocol': endpoint({ protocol: () => 'foobar' }),
		'/handshake_no_protocol': endpoint({}),
		'/handshake_no_extensions': endpoint({ extensions: false }),
		'/handshake_sleep_2': endpoint({ before: () => sleep(2000) }),
		'/sleep_10_v13': endpoint({
			before: () => sleep(10000),
			run: (ws) => echo(ws),
		}),
		'/basic_auth': endpoint({}),
		'/remote-close': endpoint({
			run: async (ws, req, url, socket) => {
				const query = url.searchParams;
				if (query.has('abrupt')) {
					ws.ping('ping');
					await sleep(20);
					return socket.destroy();
				}
				if (query.has('code'))
					ws.close(Number(query.get('code')), query.get('reason') ?? '');
				else ws.close();
			},
		}),
		// the client's Close is answered a second late
		'/delayed-passive-close': endpoint({
			run: async (ws) => {
				onClientClose(ws, async (code, reason) => {
					await sleep(1000);
					if (code === 1005) ws.close();
					else ws.close(code, reason);
				});
				await closed(ws);
			},
		}),
		// the client's Close is answered by dropping the connection
		'/passive-close-abort': endpoint({
			run: async (ws, req, url, socket) => {
				onClientClose(ws, () => socket.destroy());
				await closed(ws);
			},
		}),
		// not a handshake at all
		'/invalid': (req, socket) => {
			socket.write('FOO BAR BAZ\r\n\r\n');
			socket.end();
		},
		// a hand-written 101 (with a cookie and a status line that ends in a
		// colon) and a Close frame in the same packet
		'/simple_handshake': (req, socket) => {
			socket.write(
				Buffer.concat([
					Buffer.from(
						`HTTP/1.1 101 Switching Protocols:\r\nConnection: Upgrade\r\nUpgrade: WebSocket\r\nSet-Cookie: ws_test=test\r\nSec-WebSocket-Origin: ${req.headers.origin ?? ''}\r\nSec-WebSocket-Accept: ${acceptKey(req)}\r\n\r\n`,
					),
					closeFrame(1001, 'PASS'),
				]),
			);
			// the client's answering Close, then the connection goes
			socket.once('data', () => socket.destroy());
			socket.on('error', () => {});
		},
		'/wrong_accept_key': (req, socket) => {
			socket.write(
				`HTTP/1.1 101 Switching Protocols:\r\nConnection: Upgrade\r\nUpgrade: WebSocket\r\nSec-WebSocket-Origin: ${req.headers.origin ?? ''}\r\nSec-WebSocket-Accept: thisisawrongacceptkey\r\n\r\n`,
			);
			socket.on('error', () => {});
		},
		// opening-handshake/resources/redirect_response.py asked for as a
		// socket: a 301, which a WebSocket must not follow
		'/websockets/opening-handshake/resources/redirect_response.py': (
			req,
			socket,
		) => {
			socket.write(
				'HTTP/1.1 301 moved\r\nLocation: /echo\r\nContent-Length: 0\r\n\r\n',
			);
			socket.end();
		},
	};
	// basic_auth_wsh.py: 401 unless the credentials are foo:bar
	const authorized = upgrades['/basic_auth'];
	upgrades['/basic_auth'] = (req, socket, head, url, port) => {
		if (req.headers.authorization === 'Basic Zm9vOmJhcg==')
			return authorized(req, socket, head, url, port);
		socket.write(
			'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nWWW-Authenticate: Basic realm="camelot"\r\n\r\n',
		);
		socket.end();
	};

	return {
		upgrades,
		handlers: {
			// security/check.py: a plain request must not carry the key
			'/websockets/security/check.py': (req, res) => {
				res.statusCode = 200;
				res.end('sec-websocket-key' in req.headers ? 'FAIL' : 'PASS');
			},
			'/websockets/opening-handshake/resources/redirect_response.py': (
				req,
				res,
			) => {
				res.statusCode = 301;
				res.statusMessage = 'moved';
				res.setHeader('Location', '/echo');
				res.end();
			},
		},
	};
};
