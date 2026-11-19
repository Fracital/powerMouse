// A wisp relay with a WebTransport listener, as holyWisp's (its
// docs/webtransport.md, "Wisp on the session" and "Certificates"), in front
// of a real wisp server (the demo's holyWisp) for the webtransport-wisp
// suite. On one port number:
//
// - TCP: `GET /webtransport.json` answers `{ url, hashes }` (the current
//   certificate's hash and the previous one's, base64, CORS *, no-store),
//   and a WebSocket on any other path is relayed to the wisp server as it
//   is (the fallback: `ws` counts them);
// - UDP: test/wtserver.mjs's /bridge route. A session's Wisp packets go
//   after their u32 LE lengths on its lanes, each sent to the wisp server as
//   one WebSocket message on a connection of the session's own (with the
//   protocol the session chose as the subprotocol: Wisp v2, as holyWisp
//   answers `wt-protocol`). A DATA packet of a UDP stream the wisp server
//   sends goes back as one datagram when it fits, on its lane otherwise; a
//   datagram from the client is one whole packet.
//
// The two extensions of ~/.claude/stomp-work/wisp-lanes/SPEC.md, as holyWisp
// builds them:
// - the server-opened Wisp stream: with `serverStream` (on by default, as
//   holyWisp's is) a session that offers `wisp-v2-server-stream` is answered
//   with it, and lane 0 is a stream the relay opens. The wisp server behind
//   it sends its CONTINUE only after the client's INFO, so the relay sends
//   the early CONTINUE itself (with the window the wisp server's v1 opening
//   gives, asked once at start) and drops the wisp server's when it comes.
//   A client whose first packet there is not INFO is sent CLOSE 0x04 and the
//   session ends. Without it (or a client that does not offer the token)
//   the client's first stream is lane 0, as before;
// - lanes: `lanes` (holyWisp's webtransport-lanes, 8 by default, 0 or 1 for
//   none) is added to the wisp server's INFO as extension 0xE1. A client
//   stream that starts with a LANE packet (type 0xE1, index u8) is that
//   lane; a bad or repeated index (or one from `refuseLanesFrom` on, a
//   relay that offers more than it takes; `refuseDelay` ms later, what it
//   carried meanwhile dropped) is reset with LANE_REFUSED (1), any other
//   client stream once lane 0 is taken with STREAM_UNWANTED (2). A Wisp
//   stream's packets go back on the lane its CONNECT came on. What a lane
//   sends before the client's INFO is held until it came. A lane that ends
//   ends the session. `highWater` (bytes) is the per-lane pause mark: the
//   bytes QUIC has not taken yet on all lanes together are capped at lanes x
//   highWater, past which the wisp server's WebSocket is not read (every
//   remote pauses); one lane's backlog holds up only that lane, as QUIC's
//   streams are independent.
//
// `documentDelay` (ms) holds each document's answer back and `streamDelay`
// (ms) each lane 0's first packets (a session that comes late, each
// step within the client's time). `stats` counts the documents fetched,
// sessions (and those the client closed), WebSockets (and those that
// ended), the UDP DATA packets each way by how they went, the lanes
// (`lanes`, `laneRefused`, `unwanted`, `serverStreams`, and by lane index
// the CONNECTs, `connectsByLane`, and the bytes sent, `bytesByLane`; each
// CONNECT's lane and port, `connects`).
// `document` (a function of the fetch's count, returning the JSON body or
// null for a 404) replaces the answer; `rotate()` restarts the WebTransport
// listener with a new certificate on the same port, the old hash listed as
// the previous; `cut()` closes every session and WebSocket, as a restarted
// relay does; `udpBlocked = true` drops every datagram that reaches the
// listener (a network that lets no UDP through); `drop()` ends every
// session the way a network that stops passing UDP does (no session
// close). `delayMs` holds every datagram through the listener's gate that
// long each way (an RTT of twice it), and `lossRate` (0 to 1) loses that
// share of them each way, at random from a fixed seed (`stats.gateLost`).
// `datagramMax` (bytes, 0 for the session's own) is the largest UDP DATA
// the relay sends as a datagram, a larger one going on the stream as
// holyWisp sends it; `datagramLoss` (0 to 1) is the share of the UDP DATA
// datagrams lost each way, evenly (at 0.1 every tenth; `datagramsLost`
// counts them), the stream untouched; `udpLost` loses every UDP DATA, by
// datagram or on the stream, either way (a path that stops carrying one UDP
// flow while the session lives). `pieces` (byte counts, used in turn) cuts
// what goes to a client on a lane into writes of those sizes, each on a
// later turn, so a packet and its length prefix reach the client across
// chunks of their own. `stall(index)` holds back everything sent on that
// lane of every session until `unstall()`.
// A session counts once the client uses its Wisp stream: it opens lane 0,
// or writes its first packet on the relay's. Chrome 157 goes on with the
// handshake of a session the page closed while it was connecting (one
// past the client's timeout, with UDP dropped), and when UDP comes back it
// sends the session's CONNECT, seconds later, and closes it at once; such
// a stray, which no client rode, counts in `stray`. `maxStreams` (0 for
// none) is the most streams a session has open, as holyWisp's
// `max-streams-per-conn`: a CONNECT past it is closed with 0x49 on its
// lane and never reaches the wisp server (`stats.refused` counts them,
// `stats.mostOpen` the most a session had open).
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { startWebTransportServer } from './wtserver.mjs';

const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const INFO = 0x05;
const LANE = 0xe1;
const LANES_EXTENSION = 0xe1;
const UDP = 0x02;
const SERVER_STREAM = 'wisp-v2-server-stream';
const LANE_REFUSED = 1;
const STREAM_UNWANTED = 2;
const INCOMPATIBLE = 0x04;
/** holyWisp's CLOSE reason for a CONNECT past the session's stream limit */
const THROTTLED = 0x49;

const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const idOf = (packet) => packet.readUInt32LE(1);

/** mulberry32: the gate's losses, the same on every run */
function seeded(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** the window the wisp server's v1 opening gives (its CONTINUE for stream 0) */
function windowOf(upstream) {
	return new Promise((resolve) => {
		const ws = new WebSocket(upstream);
		const done = (value) => {
			ws.terminate();
			resolve(value);
		};
		const timer = setTimeout(() => done(128), 5000);
		ws.on('message', (m) => {
			clearTimeout(timer);
			const p = Buffer.from(m);
			done(p[0] === CONTINUE && p.length >= 9 ? p.readUInt32LE(5) : 128);
		});
		ws.on('error', () => done(128));
	});
}

const framed = (packet) => {
	const out = Buffer.alloc(4 + packet.length);
	out.writeUInt32LE(packet.length, 0);
	packet.copy(out, 4);
	return out;
};

/** `upstream`: the ws:// URL of the wisp server behind the relay */
export async function startWispWebTransport(upstream) {
	const http = createServer();
	await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
	const port = http.address().port;
	const window = await windowOf(upstream);
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
		refused: 0,
		mostOpen: 0,
		stray: 0,
		protocols: [],
		offered: [],
		serverStreams: 0,
		lanes: 0,
		laneRefused: 0,
		/** packets a lane refused late (`refuseDelay`) carried after its LANE, dropped */
		refusedPackets: 0,
		unwanted: 0,
		incompatible: 0,
		connectsByLane: [],
		/** each CONNECT on a stream: its lane and the port it asks for */
		connects: [],
		bytesByLane: [],
		gateLost: 0,
		paused: 0,
	};
	const sockets = new Set();
	const sessions = new Map();
	/** a stream's handle: its session and lane (null until its first packet says) */
	const streams = new Map();
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
	let stalled = -1;
	let writesReported = false;

	const relay = {
		port,
		/** the wisp URL a controller is given */
		wisp: `ws://127.0.0.1:${port}/wisp/`,
		discovery: `http://127.0.0.1:${port}/webtransport.json`,
		url: `https://127.0.0.1:${port}/bridge`,
		stats,
		/** the window the early CONTINUE gives (the wisp server's own) */
		window,
		document: null,
		documentDelay: 0,
		streamDelay: 0,
		udpBlocked: false,
		datagramMax: 0,
		datagramLoss: 0,
		udpLost: false,
		pieces: [],
		serverStream: true,
		lanes: 8,
		/** lanes from this index on are refused (LANE_REFUSED) though offered: 0 for none */
		refuseLanesFrom: 0,
		/** how long such a refusal waits (ms), what the lane carries meanwhile dropped */
		refuseDelay: 0,
		highWater: 4 * 1024 * 1024,
		delayMs: 0,
		lossRate: 0,
		random: seeded(1),
		maxStreams: 0,
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
		/** holds back what every session sends on lane `index` */
		stall(index) {
			stalled = index;
		},
		unstall() {
			const was = stalled;
			stalled = -1;
			for (const session of sessions.values()) {
				const lane = session.lanes[was];
				if (lane) for (const bytes of lane.held.splice(0)) write(lane, bytes);
			}
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

	/** the wisp server's INFO with 0xE1 added (when `lanes` says) */
	function withLanes(session, packet) {
		const lanes = Math.min(255, relay.lanes | 0);
		if (lanes < 2) return packet;
		session.advertised = lanes;
		return Buffer.concat([
			packet,
			Buffer.from([LANES_EXTENSION, 1, 0, 0, 0, lanes]),
		]);
	}

	/** a packet from the wisp server to the session's client */
	function toClient(session, packet) {
		const type = packet[0];
		const id = packet.length >= 5 ? idOf(packet) : -1;
		if (type === CLOSE) {
			session.udp.delete(id);
			session.open.delete(id);
		}
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
		if (id === 0 && type === INFO && !session.opened) {
			packet = withLanes(session, packet);
			if (session.serverOpened) {
				// the early CONTINUE: the wisp server sends its own only after
				// the client's INFO, which this one does not wait for
				const early = Buffer.alloc(9);
				early[0] = CONTINUE;
				early.writeUInt32LE(relay.window, 5);
				session.early = true;
				send(session, session.lanes[0], packet);
				send(session, session.lanes[0], early);
				return;
			}
		}
		if (id === 0 && type === CONTINUE && session.early && !session.opened) {
			session.opened = true;
			return;
		}
		if (id === 0 && type === CONTINUE) session.opened = true;
		const lane =
			id > 0 ? (session.laneOf.get(id) ?? session.lanes[0]) : session.lanes[0];
		send(session, lane, packet);
	}

	/** a packet to the client on `lane` (lane 0 may not be open yet) */
	function send(session, lane, packet) {
		const bytes = framed(packet);
		if (!lane || session.holding) {
			session.out.push(bytes);
			return;
		}
		if (lane.index === stalled) {
			lane.held.push(bytes);
			return;
		}
		write(lane, bytes);
	}

	/** bytes on a lane, whole or in `pieces`, counted until QUIC took them */
	function write(lane, bytes) {
		const session = lane.session;
		stats.bytesByLane[lane.index] =
			(stats.bytesByLane[lane.index] ?? 0) + bytes.length;
		lane.unsent += bytes.length;
		session.unsent += bytes.length;
		backpressure(session);
		if (!relay.pieces.length && !lane.cut.length)
			return api.write(lane.stream, bytes);
		lane.cut.push(bytes);
		if (lane.cut.length > 1) return;
		const next = () => {
			const head = lane.cut[0];
			if (!head || !sessions.has(session.id)) return;
			const sizes = relay.pieces.length ? relay.pieces : [head.length];
			const n = sizes[lane.piece++ % sizes.length];
			api.write(lane.stream, head.subarray(0, n));
			if (n >= head.length) lane.cut.shift();
			else lane.cut[0] = head.subarray(n);
			if (lane.cut.length) setImmediate(next);
		};
		setImmediate(next);
	}

	/** past lanes x highWater unsent, the wisp server is not read */
	function backpressure(session) {
		const cap =
			Math.max(1, session.lanes.filter(Boolean).length) * relay.highWater;
		// a wtserver.wasm that reports no `written` cannot say what QUIC holds
		if (!writesReported || session.ws.readyState !== WebSocket.OPEN) return;
		if (session.unsent > cap && !session.paused) {
			session.paused = true;
			stats.paused++;
			session.ws.pause();
		} else if (session.unsent <= cap && session.paused) {
			session.paused = false;
			session.ws.resume();
		}
	}

	/** a packet from the client to the wisp server, from `lane` (null: a datagram) */
	function toServer(session, packet, lane) {
		const datagram = !lane;
		const type = packet[0];
		const id = packet.length >= 5 ? idOf(packet) : -1;
		if (lane?.index === 0 && !session.clientSpoke) {
			session.clientSpoke = true;
			count(session);
			if (session.serverOpened && !(type === INFO && id === 0)) {
				// the first packet on a server-opened lane 0 must be INFO
				stats.incompatible++;
				const close = Buffer.alloc(6);
				close[0] = CLOSE;
				close[5] = INCOMPATIBLE;
				api.write(lane.stream, framed(close));
				setTimeout(() => end(session), 50);
				return;
			}
		}
		if (!datagram && type === INFO && id === 0) {
			session.infoSent = true;
			forward(session, packet);
			for (const held of session.heldLanes.splice(0)) forward(session, held);
			return;
		}
		if (type === CONNECT && lane) {
			session.laneOf.set(id, lane);
			if (packet.length >= 8)
				stats.connects.push({ lane: lane.index, port: packet.readUInt16LE(6) });
			stats.connectsByLane[lane.index] =
				(stats.connectsByLane[lane.index] ?? 0) + 1;
		}
		if (type === CONNECT) {
			session.refused.delete(id);
			if (relay.maxStreams && session.open.size >= relay.maxStreams) {
				// refused: the client hears a CLOSE, the server nothing
				stats.refused++;
				session.refused.add(id);
				const close = Buffer.alloc(6);
				close[0] = CLOSE;
				close.writeUInt32LE(id, 1);
				close[5] = THROTTLED;
				toClient(session, close);
				return;
			}
			session.open.add(id);
			stats.mostOpen = Math.max(stats.mostOpen, session.open.size);
		}
		if (session.refused.has(id)) {
			if (type === CLOSE) session.refused.delete(id);
			return;
		}
		if (type === CONNECT && packet[5] === UDP) session.udp.add(id);
		if (type === CLOSE) {
			session.udp.delete(id);
			session.open.delete(id);
		}
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
		// a lane's packets wait for the client's INFO (SPEC.md 3.4)
		if (lane && lane.index > 0 && session.v2 && !session.infoSent) {
			session.heldLanes.push(packet);
			return;
		}
		forward(session, packet);
	}

	function forward(session, packet) {
		if (session.ws.readyState === WebSocket.OPEN) session.ws.send(packet);
		else session.queued.push(packet);
	}

	function end(session) {
		if (!sessions.has(session.id)) return;
		sessions.delete(session.id);
		session.ws.terminate();
		api.close(session.id, 0, '');
	}

	/** `stream` is lane `index` of `session` */
	function addLane(session, stream, index) {
		const lane = {
			session,
			stream,
			index,
			held: [],
			cut: [],
			piece: 0,
			unsent: 0,
			buffer: Buffer.alloc(0),
		};
		session.lanes[index] = lane;
		streams.set(stream, lane);
		if (index > 0) stats.lanes++;
		return lane;
	}

	/** lane 0 is up: what waited for it goes out, after `streamDelay` */
	/** the client uses the session's Wisp stream: the session counts */
	function count(session) {
		if (session.counted) return;
		session.counted = true;
		stats.sessions++;
	}

	function laneZero(session, stream) {
		const lane = addLane(session, stream, 0);
		const flush = () => {
			session.holding = false;
			for (const bytes of session.out.splice(0)) write(lane, bytes);
		};
		session.holding = relay.streamDelay > 0;
		if (session.holding) setTimeout(flush, relay.streamDelay);
		else flush();
	}

	/** a client stream's first packet, when lane 0 is taken: a LANE, or it is reset */
	function claim(entry, packet) {
		const { session, stream } = entry;
		const index = packet.length >= 6 ? packet[5] : -1;
		if (packet[0] !== LANE || idOf(packet) !== 0) {
			stats.unwanted++;
			api.reset(stream, STREAM_UNWANTED);
			streams.delete(stream);
			return null;
		}
		const past = relay.refuseLanesFrom > 0 && index >= relay.refuseLanesFrom;
		if (
			!session.advertised ||
			index < 1 ||
			index >= session.advertised ||
			past ||
			session.lanes[index]
		) {
			const refuse = () => {
				stats.laneRefused++;
				api.reset(stream, LANE_REFUSED);
				streams.delete(stream);
			};
			if (!past || !relay.refuseDelay) {
				refuse();
				return null;
			}
			setTimeout(refuse, relay.refuseDelay);
			return { ...entry, pending: false, refusing: true };
		}
		return addLane(session, stream, index);
	}

	function handler(kind, id, value) {
		if (kind === 'protocol') {
			return relay.serverStream && value.includes(SERVER_STREAM)
				? SERVER_STREAM
				: undefined;
		}
		if (kind === 'session') {
			stats.protocols.push(value.protocol);
			stats.offered.push(value.offered);
			const ws = new WebSocket(
				upstream,
				value.protocol ? [value.protocol] : [],
			);
			const session = {
				id,
				ws,
				v2: Boolean(value.protocol),
				lanes: [],
				laneOf: new Map(),
				udp: new Set(),
				open: new Set(),
				refused: new Set(),
				queued: [],
				out: [],
				heldLanes: [],
				unsent: 0,
			};
			sessions.set(id, session);
			if (value.protocol === SERVER_STREAM) {
				const stream = api.openBidi(id);
				if (stream >= 0) {
					session.serverOpened = true;
					stats.serverStreams++;
					laneZero(session, stream);
				}
			}
			ws.binaryType = 'nodebuffer';
			ws.on('open', () => {
				for (const p of session.queued.splice(0)) ws.send(p);
			});
			ws.on('message', (m) => toClient(session, Buffer.from(m)));
			const close = () => end(session);
			ws.on('close', close);
			ws.on('error', close);
		} else if (kind === 'bidi') {
			const session = sessions.get(value);
			if (!session) return api.reset(id, 0);
			// the client's first stream is lane 0 when the relay opened none;
			// any other is a lane or is reset, as its first packet says
			if (!session.lanes[0] && !session.serverOpened) {
				count(session);
				laneZero(session, id);
			} else
				streams.set(id, {
					session,
					stream: id,
					pending: true,
					buffer: Buffer.alloc(0),
				});
		} else if (kind === 'written') {
			writesReported = true;
			const lane = streams.get(id);
			if (!lane || lane.pending) return;
			lane.unsent -= value;
			lane.session.unsent -= value;
			backpressure(lane.session);
		} else if (kind === 'data') {
			let entry = streams.get(id);
			if (!entry || !sessions.has(entry.session.id)) return;
			let buffer = Buffer.concat([entry.buffer, Buffer.from(value)]);
			while (buffer.length >= 4) {
				const n = buffer.readUInt32LE(0);
				if (buffer.length < 4 + n) break;
				const packet = buffer.subarray(4, 4 + n);
				buffer = buffer.subarray(4 + n);
				if (entry.pending) {
					entry = claim(entry, packet);
					if (!entry) return;
					if (entry.refusing) streams.set(id, entry);
					continue;
				}
				if (entry.refusing) {
					stats.refusedPackets++;
					continue;
				}
				toServer(entry.session, Buffer.from(packet), entry);
			}
			entry.buffer = Buffer.from(buffer);
		} else if (kind === 'fin' || kind === 'reset') {
			// a lane that ends ends the session (SPEC.md 3.5)
			const entry = streams.get(id);
			streams.delete(id);
			if (entry && !entry.pending) end(entry.session);
		} else if (kind === 'datagram') {
			const session = sessions.get(id);
			if (session && value.length >= 5)
				toServer(session, Buffer.from(value), null);
		} else if (kind === 'closed') {
			const session = sessions.get(id);
			if (session?.counted) stats.sessionsClosed++;
			else if (session) stats.stray++;
			sessions.delete(id);
			session?.ws.close();
		}
	}

	// the UDP socket the listener is on, behind a gate that can drop it all,
	// and delay or lose each datagram (delayMs, lossRate)
	async function listen() {
		server = await startWebTransportServer({ port: 0 });
		api = server.bridge(handler);
		gate.target = server.port;
	}
	// buffers as large as the kernel lets, so a burst of QUIC packets is not
	// lost in the gate (at loopback rates the default 208 KiB drops)
	const udpSocket = () =>
		createSocket({
			type: 'udp4',
			recvBufferSize: 4 * 1024 * 1024,
			sendBufferSize: 4 * 1024 * 1024,
		});
	const gate = udpSocket();
	const peers = new Map();
	/** datagrams held for delayMs, in order (one delay for all keeps them in order) */
	const delayed = [];
	let timer = null;
	const drain = () => {
		timer = null;
		const now = performance.now();
		while (delayed.length && delayed[0].at <= now) delayed.shift().go();
		if (delayed.length)
			timer = setTimeout(drain, Math.max(0, delayed[0].at - now));
	};
	const pass = (go) => {
		if (relay.lossRate && relay.random() < relay.lossRate) {
			stats.gateLost++;
			return;
		}
		if (!relay.delayMs) return go();
		delayed.push({ at: performance.now() + relay.delayMs, go });
		timer ??= setTimeout(drain, relay.delayMs);
	};
	await new Promise((resolve) => gate.bind(port, '127.0.0.1', resolve));
	gate.on('error', () => {});
	gate.on('message', (message, from) => {
		if (relay.udpBlocked) return;
		const key = `${from.address}:${from.port}`;
		let inner = peers.get(key);
		if (!inner || inner.target !== gate.target) {
			inner?.socket.close();
			const socket = udpSocket();
			socket.on('error', () => {});
			socket.on('message', (back) => {
				if (!relay.udpBlocked)
					pass(() => gate.send(back, from.port, from.address));
			});
			inner = { socket, target: gate.target };
			peers.set(key, inner);
		}
		const to = inner;
		pass(() => to.socket.send(message, gate.target, '127.0.0.1'));
	});
	await listen();
	const closeAll = relay.close;
	relay.close = async () => {
		await closeAll();
		clearTimeout(timer);
		for (const { socket } of peers.values()) socket.close();
		gate.close();
	};
	return relay;
}
