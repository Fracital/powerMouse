// A wisp relay with a WebTransport listener, as holyWisp's (its
// docs/webtransport.md, "Wisp on the session" and "Certificates"), in front
// of a real wisp server (the demo's holyWisp) for the webtransport-wisp
// suite. On one port number:
//
// - TCP: `GET /webtransport.json` answers `{ url, hashes }` (the current
//   certificate's hash and the previous one's, base64, CORS *, no-store),
//   and a WebSocket on any other path is relayed to the wisp server as it
//   is (the fallback: `ws` counts them);
// - UDP: test/wtserver.mjs's /bridge route. A session's first bidirectional
//   stream is its Wisp stream: packets after their u32 LE lengths, each
//   sent to the wisp server as one WebSocket message on a connection of the
//   session's own (with the first protocol the session offered as the
//   subprotocol: Wisp v2, as holyWisp answers `wt-protocol`). A DATA packet
//   of a UDP stream the wisp server sends goes back as one datagram when it
//   fits, on the stream otherwise; a datagram from the client is one whole
//   packet.
//
// `documentDelay` (ms) holds each document's answer back and `streamDelay`
// (ms) each Wisp stream's first packets (a session that comes late, each
// step within the client's time). `stats` counts the documents fetched,
// sessions (and those the client closed), WebSockets (and those that
// ended), and the UDP DATA packets each way by how they went. A session
// counts once the client opens its Wisp stream: Chrome 157 goes on with
// the handshake of a session the page closed while it was connecting (one
// past the client's timeout, with UDP dropped), and when UDP comes back it
// sends the session's CONNECT, seconds later, and closes it at once; such
// a stray, which no client rode, counts in `stray`. `document`
// (a function of the fetch's count, returning the JSON body or null for a 404) replaces the
// answer; `rotate()` restarts the WebTransport listener with a new
// certificate on the same port, the old hash listed as the previous;
// `cut()` closes every session and WebSocket, as a restarted relay does;
// `udpBlocked = true` drops every datagram that reaches the listener (a
// network that lets no UDP through); `drop()` ends every session the way a
// network that stops passing UDP does (no session close). `datagramMax`
// (bytes, 0 for the session's own) is the largest UDP DATA the relay sends
// as a datagram, a larger one going on the stream as holyWisp sends it;
// `datagramLoss` (0 to 1) is the share of the UDP DATA datagrams lost each
// way, evenly (at 0.1 every tenth; `datagramsLost` counts them), the stream
// untouched; `udpLost`
// loses every UDP DATA, by datagram or on the stream, either way (a path
// that stops carrying one UDP flow while the session lives). `pieces` (byte
// counts, used in turn) cuts what goes to a client on the Wisp stream into
// writes of those sizes, each on a later turn, so a packet and its length
// prefix reach the client across chunks of their own.
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { startWebTransportServer } from './wtserver.mjs';

const CONNECT = 0x01;
const DATA = 0x02;
const CLOSE = 0x04;
const UDP = 0x02;

const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const idOf = (packet) => packet.readUInt32LE(1);

/** `upstream`: the ws:// URL of the wisp server behind the relay */
export async function startWispWebTransport(upstream) {
	const http = createServer();
	await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
	const port = http.address().port;
	const stats = {
		documents: 0,
		sessions: 0,
		sessionsClosed: 0,
		ws: 0,
		wsClosed: 0,
		datagramsIn: 0,
		datagramsOut: 0,
		udpOnStreamIn: 0,
		udpOnStreamOut: 0,
		datagramsLost: 0,
		stray: 0,
		protocols: [],
	};
	const sockets = new Set();
	const sessions = new Map();
	// datagramLoss's share, added up per datagram: one is lost each time it
	// reaches a whole one, so a run loses its share and no test leans on chance
	let lossOwed = 0;
	const lose = () => {
		lossOwed += relay.datagramLoss;
		if (lossOwed < 1) return false;
		lossOwed -= 1;
		stats.datagramsLost++;
		return true;
	};
	let server;
	let previous = null;
	let api;

	const relay = {
		port,
		/** the wisp URL a controller is given */
		wisp: `ws://127.0.0.1:${port}/wisp/`,
		discovery: `http://127.0.0.1:${port}/webtransport.json`,
		url: `https://127.0.0.1:${port}/bridge`,
		stats,
		document: null,
		documentDelay: 0,
		streamDelay: 0,
		udpBlocked: false,
		datagramMax: 0,
		datagramLoss: 0,
		udpLost: false,
		pieces: [],
		/** the leaf's SPKI hash, for --ignore-certificate-errors-spki-list (a dial without hashes) */
		get spki() {
			return server.spki;
		},
		get hashes() {
			return [server.certHash, previous].filter(Boolean);
		},
		answer() {
			return {
				url: relay.url,
				hashes: relay.hashes.map((hex) => ({
					algorithm: 'sha-256',
					value: b64(hex),
				})),
			};
		},
		async rotate() {
			previous = server.certHash;
			relay.cut();
			// the session closes reach the clients before the listener goes
			await new Promise((resolve) => setTimeout(resolve, 100));
			await server.close();
			await listen();
		},
		cut() {
			for (const [id, session] of sessions) {
				session.ws?.terminate();
				api.close(id, 0, 'relay restarted');
			}
			sessions.clear();
			for (const socket of sockets) socket.terminate();
			sockets.clear();
		},
		/**
		 * the network loses UDP under the sessions: the listener goes away
		 * with a CONNECTION_CLOSE and no session close, and no datagram gets
		 * through after it
		 */
		async drop() {
			for (const session of sessions.values()) session.ws?.terminate();
			sessions.clear();
			await server.close();
			relay.udpBlocked = true;
		},
		async close() {
			relay.cut();
			wss.close();
			http.close();
			await server.close();
		},
	};

	http.on('request', async (req, res) => {
		if (req.url.split('?')[0] !== '/webtransport.json') {
			res.writeHead(404).end();
			return;
		}
		const count = ++stats.documents;
		if (relay.documentDelay)
			await new Promise((resolve) => setTimeout(resolve, relay.documentDelay));
		const body = relay.document ? relay.document(count) : relay.answer();
		if (!body) {
			res.writeHead(404, { 'access-control-allow-origin': '*' }).end();
			return;
		}
		res
			.writeHead(200, {
				'content-type': 'application/json',
				'access-control-allow-origin': '*',
				'cache-control': 'no-store',
			})
			.end(JSON.stringify(body));
	});

	const wss = new WebSocketServer({
		server: http,
		handleProtocols: (protocols) => protocols.values().next().value ?? false,
	});
	wss.on('connection', (client, req) => {
		stats.ws++;
		const protocols = (req.headers['sec-websocket-protocol'] || '')
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean);
		const up = new WebSocket(upstream, protocols);
		sockets.add(client).add(up);
		const queued = [];
		up.on('open', () => {
			for (const m of queued.splice(0)) up.send(m);
		});
		client.on('message', (m) =>
			up.readyState === WebSocket.OPEN ? up.send(m) : queued.push(m),
		);
		up.on('message', (m) => client.readyState === 1 && client.send(m));
		let ended = false;
		const end = () => {
			if (!ended) stats.wsClosed++;
			ended = true;
			client.terminate();
			up.terminate();
			sockets.delete(client);
			sockets.delete(up);
		};
		for (const s of [client, up]) {
			s.on('close', end);
			s.on('error', end);
		}
	});

	/** a packet from the wisp server to the session's client */
	function toClient(session, packet) {
		const type = packet[0];
		const id = packet.length >= 5 ? idOf(packet) : -1;
		if (type === CLOSE) session.udp.delete(id);
		if (type === DATA && session.udp.has(id)) {
			if (relay.udpLost) {
				stats.datagramsLost++;
				return;
			}
			const max = relay.datagramMax
				? Math.min(relay.datagramMax, api.maxDatagram(session.id))
				: api.maxDatagram(session.id);
			if (max >= packet.length && lose()) return;
			if (max >= packet.length && api.datagram(session.id, packet)) {
				stats.datagramsOut++;
				return;
			}
			stats.udpOnStreamOut++;
		}
		const framed = Buffer.alloc(4 + packet.length);
		framed.writeUInt32LE(packet.length, 0);
		packet.copy(framed, 4);
		if (session.stream && !session.holding) write(session, framed);
		else session.out.push(framed);
	}

	/** bytes on the session's Wisp stream, whole or in `pieces` */
	function write(session, framed) {
		if (!relay.pieces.length && !session.cut.length)
			return api.write(session.stream, framed);
		session.cut.push(framed);
		if (session.cut.length > 1) return;
		const next = () => {
			const head = session.cut[0];
			if (!head || !sessions.has(session.id)) return;
			const sizes = relay.pieces.length ? relay.pieces : [head.length];
			const n = sizes[session.piece++ % sizes.length];
			api.write(session.stream, head.subarray(0, n));
			if (n >= head.length) session.cut.shift();
			else session.cut[0] = head.subarray(n);
			if (session.cut.length) setImmediate(next);
		};
		setImmediate(next);
	}

	/** a packet from the client to the wisp server */
	function toServer(session, packet, datagram) {
		const type = packet[0];
		const id = packet.length >= 5 ? idOf(packet) : -1;
		if (type === CONNECT && packet[5] === UDP) session.udp.add(id);
		if (type === CLOSE) session.udp.delete(id);
		if (relay.udpLost && type === DATA && session.udp.has(id)) {
			stats.datagramsLost++;
			return;
		}
		if (datagram) {
			// holyWisp acts only on UDP DATA in a datagram
			if (type !== DATA || !session.udp.has(id)) return;
			if (lose()) return;
			stats.datagramsIn++;
		} else if (type === DATA && session.udp.has(id)) stats.udpOnStreamIn++;
		if (session.ws.readyState === WebSocket.OPEN) session.ws.send(packet);
		else session.queued.push(packet);
	}

	function handler(kind, id, value) {
		if (kind === 'session') {
			stats.protocols.push(value.protocol);
			const ws = new WebSocket(
				upstream,
				value.protocol ? [value.protocol] : [],
			);
			const session = {
				id,
				ws,
				stream: 0,
				held: Buffer.alloc(0),
				udp: new Set(),
				queued: [],
				out: [],
				cut: [],
				piece: 0,
			};
			sessions.set(id, session);
			ws.binaryType = 'nodebuffer';
			ws.on('open', () => {
				for (const p of session.queued.splice(0)) ws.send(p);
			});
			ws.on('message', (m) => toClient(session, Buffer.from(m)));
			const end = () => {
				if (!sessions.has(id)) return;
				sessions.delete(id);
				api.close(id, 0, '');
			};
			ws.on('close', end);
			ws.on('error', end);
		} else if (kind === 'bidi') {
			const session = sessions.get(value);
			// the first stream is the Wisp stream; holyWisp takes no other
			if (!session || session.stream) return api.reset(id, 0);
			session.stream = id;
			stats.sessions++;
			const flush = () => {
				session.holding = false;
				for (const framed of session.out.splice(0)) write(session, framed);
			};
			session.holding = relay.streamDelay > 0;
			if (session.holding) setTimeout(flush, relay.streamDelay);
			else flush();
		} else if (kind === 'data') {
			const session = [...sessions.values()].find((s) => s.stream === id);
			if (!session) return;
			let buffer = Buffer.concat([session.held, Buffer.from(value)]);
			while (buffer.length >= 4) {
				const n = buffer.readUInt32LE(0);
				if (buffer.length < 4 + n) break;
				toServer(session, buffer.subarray(4, 4 + n), false);
				buffer = buffer.subarray(4 + n);
			}
			session.held = Buffer.from(buffer);
		} else if (kind === 'datagram') {
			const session = sessions.get(id);
			if (session && value.length >= 5)
				toServer(session, Buffer.from(value), true);
		} else if (kind === 'closed') {
			const session = sessions.get(id);
			if (session?.stream) stats.sessionsClosed++;
			else if (session) stats.stray++;
			sessions.delete(id);
			session?.ws.close();
		}
	}

	// the UDP socket the listener is on, behind a gate that can drop it all
	async function listen() {
		server = await startWebTransportServer({ port: 0 });
		api = server.bridge(handler);
		gate.target = server.port;
	}
	const gate = createSocket('udp4');
	const peers = new Map();
	await new Promise((resolve) => gate.bind(port, '127.0.0.1', resolve));
	gate.on('error', () => {});
	gate.on('message', (message, from) => {
		if (relay.udpBlocked) return;
		const key = `${from.address}:${from.port}`;
		let inner = peers.get(key);
		if (!inner || inner.target !== gate.target) {
			inner?.socket.close();
			const socket = createSocket('udp4');
			socket.on('error', () => {});
			socket.on('message', (back) => {
				if (!relay.udpBlocked) gate.send(back, from.port, from.address);
			});
			inner = { socket, target: gate.target };
			peers.set(key, inner);
		}
		inner.socket.send(message, gate.target, '127.0.0.1');
	});
	await listen();
	const closeAll = relay.close;
	relay.close = async () => {
		await closeAll();
		for (const { socket } of peers.values()) socket.close();
		gate.close();
	};
	return relay;
}
