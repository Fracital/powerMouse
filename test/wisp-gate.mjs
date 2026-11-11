// A wisp relay for the HTTP/3 suites that decides what becomes of each UDP
// stream, the way a production relay does per destination. It sits in front
// of a real wisp server (the demo's holyWisp) and reads the packets going
// through:
//
// - `gated`: names it will not relay UDP to, the way the production edges'
//   name gate refuses one: the CONNECT gets no answer (holyWisp opens the
//   stream), and the first datagram the client sends on it is answered with
//   CLOSE 0x03, because the edge's send() to that destination fails with
//   EPERM and holyWisp maps an errno it has no reason for to "network
//   error" (src/server/stream.c). Nothing of the stream reaches the server
//   behind the gate.
// - `udp = false`: a relay without UDP at all. Every UDP CONNECT is answered
//   with CLOSE 0x48, which is what holyWisp with `allow-udp = off` sends a
//   wisp v1 client (src/server/conn.c) and wisp-js with UDP streams off.
// - `resolve`: names whose UDP goes to an address of the suite's choosing
//   (`{ host, port }`), since the suites' names resolve nowhere.
// - `cut()` drops every connection, as a restarted edge or a port forward
//   does; the next one may find the gate set up differently.
//
// TCP streams and everything else pass through untouched. `seen` lists the
// UDP CONNECTs in order with the reason each was refused with (null for a
// stream that was relayed).
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const CONNECT = 0x01;
const DATA = 0x02;
const CLOSE = 0x04;
const UDP = 0x02;

/** `upstream`: the ws:// URL of the wisp server behind the gate */
export async function startWispGate(upstream) {
	const gate = {
		url: '',
		udp: true,
		gated: new Set(),
		resolve: new Map(),
		seen: [],
		connections: 0,
		cut() {
			for (const pair of pairs) for (const socket of pair) socket.terminate();
			pairs.clear();
		},
		close() {
			gate.cut();
			server.close();
		},
	};
	const pairs = new Set();
	const server = createServer();
	const wss = new WebSocketServer({
		server,
		handleProtocols: (protocols) => protocols.values().next().value ?? false,
	});
	wss.on('connection', (client, req) => {
		gate.connections++;
		const protocols = (req.headers['sec-websocket-protocol'] || '')
			.split(',')
			.map((token) => token.trim())
			.filter(Boolean);
		const behind = new WebSocket(
			upstream,
			protocols.length ? protocols.slice(0, 1) : undefined,
		);
		const pair = [client, behind];
		pairs.add(pair);
		const pending = [];
		const forward = (packet) => {
			if (behind.readyState === WebSocket.OPEN) behind.send(packet);
			else pending.push(packet);
		};
		behind.on('open', () => {
			for (const packet of pending.splice(0)) behind.send(packet);
		});
		// streams answered here (their `seen` entry, until they are closed):
		// what the client sends on them goes nowhere
		const refused = new Map();
		const close = (id, entry, reason) => {
			entry.refused = reason;
			refused.set(id, null);
			const packet = Buffer.alloc(6);
			packet[0] = CLOSE;
			packet.writeUInt32LE(id, 1);
			packet[5] = reason;
			client.send(packet);
		};
		client.on('message', (data) => {
			let packet = Buffer.from(data);
			const id = packet.length >= 5 ? packet.readUInt32LE(1) : 0;
			if (packet[0] === CONNECT && packet[5] === UDP) {
				const port = packet.readUInt16LE(6);
				const host = packet.toString('latin1', 8);
				const entry = { host, port, refused: null };
				gate.seen.push(entry);
				if (!gate.udp) return close(id, entry, 0x48);
				if (gate.gated.has(host)) return refused.set(id, entry);
				const to = gate.resolve.get(host);
				if (to) {
					const head = Buffer.alloc(8);
					packet.copy(head, 0, 0, 6);
					head.writeUInt16LE(to.port, 6);
					packet = Buffer.concat([head, Buffer.from(to.host, 'latin1')]);
				}
			} else if (refused.has(id)) {
				const entry = refused.get(id);
				if (packet[0] === DATA && entry) close(id, entry, 0x03);
				return;
			}
			forward(packet);
		});
		behind.on('message', (data) => {
			if (client.readyState === WebSocket.OPEN) client.send(data);
		});
		const end = () => {
			pairs.delete(pair);
			for (const socket of pair) socket.terminate();
		};
		for (const socket of pair) {
			socket.on('close', end);
			socket.on('error', end);
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	gate.url = `ws://127.0.0.1:${server.address().port}/`;
	return gate;
}
