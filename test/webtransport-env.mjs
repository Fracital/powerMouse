// What the WebTransport suites' expectations depend on outside STomp itself.
//
// - `webTransportClient`: whether the stomp-h3 the demo serves (epoxy-
//   transport's dist/h3/) has a WebTransport client. One released before it
//   has none, and a proxied session then fails as the stand-in alone does
//   (docs/webtransport.md): webtransport-live has nothing to run, and the
//   webtransport suite holds the stand-in to that.
// - `wispReportsRefusal(wispURL)`: whether the wisp server answers a UDP
//   stream to a closed port at once, the way the browser hears its port
//   unreachable. holyWisp 0.5.2 drops the error when a later datagram's
//   send collects it before the read side sees it (a QUIC Initial goes out
//   two datagrams at a time), so such a stream closes on a later
//   retransmit or never, and the session fails when the handshake gives up.
// - `writesSettleAsSent`: whether that stomp-h3's stream writes settle once
//   the session's datagrams carried the bytes (deploy/epoxy/h3/src/wt.rs,
//   `until_sent`) rather than once quinn took them; its glue carries the
//   write's doc comment, which names `UNSENT_AHEAD`. webtransport-buffered
//   holds an older build's early settling as known.
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

// where demo/server.js serves /epoxy/ from
const epoxy = dirname(
	fileURLToPath(import.meta.resolve('@mercuryworkshop/epoxy-transport')),
);
export const STOMP_H3 = `${epoxy}/h3/stomp_h3.js`;
export const webTransportClient = (() => {
	try {
		return /export (?:async )?function connect_webtransport\b/.test(
			readFileSync(STOMP_H3, 'utf8'),
		);
	} catch {
		return false;
	}
})();

export const writesSettleAsSent = (() => {
	try {
		return /UNSENT_AHEAD/.test(readFileSync(STOMP_H3, 'utf8'));
	} catch {
		return false;
	}
})();

/** a UDP port nothing listens on: taken, then let go */
async function closedUdpPort() {
	const socket = createSocket('udp4');
	await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
	const { port } = socket.address();
	await new Promise((resolve) => socket.close(resolve));
	return port;
}

const frame = (type, id, payload) => {
	const out = Buffer.alloc(5 + payload.length);
	out[0] = type;
	out.writeUInt32LE(id, 1);
	payload.copy(out, 5);
	return out;
};

/**
 * How long the wisp server at `wispURL` takes to close each of `rounds` UDP
 * streams to a closed port that are sent two datagrams at once (null: not
 * within `timeout` ms), and whether every one closed within `prompt` ms
 */
export async function wispReportsRefusal(
	wispURL,
	{ rounds = 6, prompt = 100, timeout = 1500 } = {},
) {
	const ws = new WebSocket(wispURL);
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	const closes = new Map();
	ws.on('message', (data) => {
		if (data[0] === 0x04) closes.get(data.readUInt32LE(1))?.(data[5]);
	});
	const ms = [];
	for (let id = 1; id <= rounds; id++) {
		const port = await closedUdpPort();
		const host = Buffer.from('127.0.0.1');
		const head = Buffer.alloc(3 + host.length);
		head[0] = 0x02;
		head.writeUInt16LE(port, 1);
		host.copy(head, 3);
		const closed = new Promise((resolve) => {
			closes.set(id, resolve);
			setTimeout(() => resolve(null), timeout);
		});
		const start = performance.now();
		ws.send(frame(0x01, id, head));
		for (let i = 0; i < 2; i++) ws.send(frame(0x02, id, Buffer.alloc(1200)));
		const reason = await closed;
		ms.push(reason === null ? null : Math.round(performance.now() - start));
	}
	ws.close();
	return {
		prompt: ms.every((value) => value !== null && value <= prompt),
		ms,
	};
}
