// A Wisp v1 server in the transport worker, for epoxy's function transport
// (its `wisp` a function that hands it a ReadableStream and a WritableStream
// of Wisp packets): each CONNECT is a Tor stream, `open(host, port)`, so
// epoxy runs its TLS, HTTP/1.1, HTTP/2 and WebSockets on Tor streams as on
// a Wisp server's TCP. UDP is refused: Tor carries none.

const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const TCP = 0x01;
const CLOSE_VOLUNTARY = 0x02;
const CLOSE_NETWORK = 0x03;
const CLOSE_UNREACHABLE = 0x42;
const CLOSE_BLOCKED = 0x48;
// packets a stream may send before it hears CONTINUE, and how many of them
// are written to the circuit before it is told again
const BUFFER = 128;
// a DATA packet under the edges' message bound (AGENTS.md "Transports")
const MAX_DATA = 64 * 1024;
// packets for epoxy to read before a stream's reading waits
const QUEUE = 64;

function packet(type, id, payload) {
	const out = new Uint8Array(5 + payload.byteLength);
	const view = new DataView(out.buffer);
	view.setUint8(0, type);
	view.setUint32(1, id, true);
	out.set(payload, 5);
	return out;
}

function u32(value) {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value, true);
	return out;
}

/**
 * `wisp` for epoxy: each call is a new Wisp connection whose streams
 * `open(host, port)` (a Promise of `{ readable, writable }`) opens.
 * `close()` ends every connection it made.
 */
export function wispServer(open) {
	const connections = new Set();
	const wisp = () => {
		const streams = new Map();
		let toEpoxy;
		let ended = false;
		const pulled = [];
		const send = (type, id, payload) => {
			// epoxy takes each packet as an ArrayBuffer
			if (!ended) toEpoxy.enqueue(packet(type, id, payload).buffer);
		};
		const close = (id, reason) => {
			const stream = streams.get(id);
			if (!stream) return;
			streams.delete(id);
			stream.closed = true;
			stream.writer?.abort().catch(() => {});
			stream.reader?.cancel().catch(() => {});
			if (reason !== undefined) send(CLOSE, id, new Uint8Array([reason]));
		};
		const end = () => {
			for (const id of [...streams.keys()]) close(id);
			if (!ended) {
				ended = true;
				try {
					toEpoxy.close();
				} catch {
					// already closed
				}
			}
			while (pulled.length) pulled.shift()();
			connections.delete(connection);
		};
		const write = (id, stream, chunk) => {
			stream.writes = stream.writes
				.then(() => stream.writer.write(chunk))
				.then(
					() => {
						if (stream.closed) return;
						if (++stream.written % (BUFFER / 2) === 0)
							send(CONTINUE, id, u32(BUFFER));
					},
					() => close(id, CLOSE_NETWORK),
				);
		};
		const pump = async (id, stream) => {
			try {
				for (;;) {
					const { done, value } = await stream.reader.read();
					if (stream.closed) return;
					if (done) {
						close(id, CLOSE_VOLUNTARY);
						return;
					}
					for (let at = 0; at < value.byteLength; at += MAX_DATA)
						send(DATA, id, value.subarray(at, at + MAX_DATA));
					while (!ended && toEpoxy.desiredSize <= 0)
						await new Promise((resolve) => pulled.push(resolve));
				}
			} catch {
				close(id, CLOSE_NETWORK);
			}
		};
		const connect = (id, payload) => {
			const view = new DataView(
				payload.buffer,
				payload.byteOffset,
				payload.byteLength,
			);
			if (payload.byteLength < 3 || payload[0] !== TCP) {
				send(CLOSE, id, new Uint8Array([CLOSE_BLOCKED]));
				return;
			}
			const port = view.getUint16(1, true);
			const host = new TextDecoder().decode(payload.subarray(3));
			const stream = {
				closed: false,
				pending: [],
				writer: null,
				reader: null,
				writes: Promise.resolve(),
				written: 0,
			};
			streams.set(id, stream);
			open(host, port).then(
				({ readable, writable }) => {
					if (stream.closed) {
						readable.cancel().catch(() => {});
						writable.abort().catch(() => {});
						return;
					}
					stream.writer = writable.getWriter();
					stream.reader = readable.getReader();
					for (const chunk of stream.pending.splice(0))
						write(id, stream, chunk);
					pump(id, stream);
				},
				() => close(id, CLOSE_UNREACHABLE),
			);
		};
		const read = new ReadableStream(
			{
				start: (controller) => {
					toEpoxy = controller;
					send(CONTINUE, 0, u32(BUFFER));
				},
				pull: () => {
					while (pulled.length) pulled.shift()();
				},
				cancel: end,
			},
			{ highWaterMark: QUEUE },
		);
		const writable = new WritableStream({
			write(chunk) {
				const bytes =
					chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
				if (bytes.byteLength < 5) return;
				const id = new DataView(
					bytes.buffer,
					bytes.byteOffset,
					bytes.byteLength,
				).getUint32(1, true);
				const payload = bytes.subarray(5);
				if (bytes[0] === CONNECT) connect(id, payload);
				else if (bytes[0] === DATA) {
					const stream = streams.get(id);
					if (!stream) return;
					const chunk = payload.slice();
					if (stream.writer) write(id, stream, chunk);
					else stream.pending.push(chunk);
				} else if (bytes[0] === CLOSE) close(id);
			},
			close: end,
			abort: end,
		});
		const connection = { end };
		connections.add(connection);
		return Promise.resolve({ read, write: writable });
	};
	wisp.close = () => {
		for (const connection of [...connections]) connection.end();
	};
	return wisp;
}
