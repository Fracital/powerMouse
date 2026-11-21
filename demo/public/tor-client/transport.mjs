// The in-browser Tor client's transport (docs/tor-over-wisp.md), opt-in with
// `?tor=client` or STOMP_CONFIG.torClient. arti (tor-js) builds the circuits
// in the transport worker; the Wisp server is given nothing but TCP streams
// to Tor relays' ORPorts (an IP and a port from arti's signed directory or its
// compiled-in fallbacks), each carrying Tor's link TLS. A site's TLS is
// rustls in the same wasm, end to end, and the exit resolves its name.
//
// A prototype: requests go through tor-js's own fetch (it has no stream API
// yet, so epoxy cannot run on a Tor stream), and WebSockets are refused.
import {
	ArtiSocket,
	storage,
	TorClient,
} from './tor-js/entryPoints/wasm-file/index.js';

const NETWORK_PARTITION = '$stomp$network';

// Wisp v1 (https://github.com/MercuryWorkshop/wisp-protocol): the packets a
// TCP stream needs
const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const TCP = 0x01;
const CLOSE_VOLUNTARY = 0x02;
// a DATA packet under the edges' message bound (AGENTS.md "Transports")
const MAX_DATA = 64 * 1024;

function packet(type, id, payload) {
	const out = new Uint8Array(5 + payload.byteLength);
	const view = new DataView(out.buffer);
	view.setUint8(0, type);
	view.setUint32(1, id, true);
	out.set(payload, 5);
	return out;
}

/**
 * One Wisp connection; `open("ip:port")` is a TCP stream over it. Only
 * addresses arti hands it are ever opened, never a hostname, so the Wisp
 * server resolves nothing for Tor mode.
 */
class WispConnection {
	#url;
	#socket = null;
	#opening = null;
	#streams = new Map();
	#nextId = 1;
	#initialCredit = 0;
	#creditReady = null;

	constructor(url) {
		this.#url = url;
	}

	#connect() {
		if (this.#opening) return this.#opening;
		this.#opening = new Promise((resolve, reject) => {
			const socket = new WebSocket(this.#url);
			socket.binaryType = 'arraybuffer';
			let creditSeen;
			this.#creditReady = new Promise((done) => (creditSeen = done));
			socket.onopen = () => {
				this.#socket = socket;
				resolve(socket);
			};
			socket.onerror = () => reject(new Error(`Wisp ${this.#url} failed`));
			socket.onclose = () => {
				this.#socket = null;
				this.#opening = null;
				for (const stream of this.#streams.values())
					stream.closed('the Wisp connection closed');
				this.#streams.clear();
			};
			socket.onmessage = ({ data }) => {
				if (!(data instanceof ArrayBuffer) || data.byteLength < 5) return;
				const view = new DataView(data);
				const type = view.getUint8(0);
				const id = view.getUint32(1, true);
				const payload = new Uint8Array(data, 5);
				if (id === 0) {
					// the server's buffer for every stream, before any CONNECT
					if (type === CONTINUE) {
						this.#initialCredit = view.getUint32(5, true);
						creditSeen();
					}
					// a Wisp v2 server's INFO: a v1 client answers none
					return;
				}
				const stream = this.#streams.get(id);
				if (!stream) return;
				if (type === DATA) stream.data(payload);
				else if (type === CONTINUE) stream.credit(view.getUint32(5, true));
				else if (type === CLOSE) {
					this.#streams.delete(id);
					stream.closed(`Wisp close reason 0x${payload[0]?.toString(16)}`);
				}
			};
		});
		return this.#opening;
	}

	async open(target) {
		const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(target);
		if (!match) throw new Error(`not an address: ${target}`);
		const [, host, port] = match;
		const socket = await this.#connect();
		await this.#creditReady;
		const id = this.#nextId++;
		let controller;
		let credit = this.#initialCredit;
		let waiting = null;
		let finished = false;
		let settle;
		const closed = new Promise((resolve) => (settle = resolve));
		const finish = (ok, reason) => {
			if (finished) return;
			finished = true;
			try {
				if (ok) controller.close();
				else controller.error(new Error(reason));
			} catch {
				// its reader cancelled it already
			}
			waiting?.();
			settle(ok ? { ok } : { ok, reason });
		};
		const stream = {
			data: (bytes) => {
				if (!finished) controller.enqueue(new Uint8Array(bytes));
			},
			credit: (value) => {
				credit = value;
				waiting?.();
				waiting = null;
			},
			closed: (reason) => finish(false, reason),
		};
		this.#streams.set(id, stream);
		const name = new TextEncoder().encode(host);
		const head = new Uint8Array(3 + name.byteLength);
		head[0] = TCP;
		new DataView(head.buffer).setUint16(1, Number(port), true);
		head.set(name, 3);
		socket.send(packet(CONNECT, id, head));
		const close = () => {
			if (finished) return;
			this.#streams.delete(id);
			if (this.#socket === socket)
				socket.send(packet(CLOSE, id, new Uint8Array([CLOSE_VOLUNTARY])));
			finish(true);
		};
		return new ArtiSocket({
			readable: new ReadableStream({
				start: (c) => (controller = c),
				cancel: close,
			}),
			writable: new WritableStream({
				async write(chunk) {
					for (let at = 0; at < chunk.byteLength; at += MAX_DATA) {
						while (credit <= 0 && !finished)
							await new Promise((resolve) => (waiting = resolve));
						if (finished) throw new Error('the Tor link closed');
						credit--;
						socket.send(packet(DATA, id, chunk.subarray(at, at + MAX_DATA)));
					}
				},
				close,
				abort: close,
			}),
			closed,
			// Wisp has no half-close: arti closes a link whole
			closeWrite: async () => {},
			close,
		});
	}

	close() {
		this.#socket?.close();
	}
}

/** a random nonce, so a new identity's keys share no circuit with the old */
const nonce = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');

/** `body` as tor-js sends it */
async function sendable(body) {
	if (body === null || body === undefined) return undefined;
	if (typeof body === 'string' || body instanceof ReadableStream) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body))
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
	return new Uint8Array(await new Response(body).arrayBuffer());
}

export default class TorClientTransport {
	ready = false;
	// the service worker's top-level site for each request, the key of its
	// circuits (docs/tor-over-wisp.md "Per-site circuits"); never sent
	fieldSupport = { partition: NETWORK_PARTITION };
	#wisp;
	#client = null;
	#session = nonce();
	#siteNonces = new Map();
	#storageName;
	/** what bootstrap took and what it is doing, for the page and the smoke */
	status = { state: 'starting', since: Date.now() };

	constructor({ wisp, storageName = 'stomp-tor-client' } = {}) {
		if (typeof wisp !== 'string') throw new TypeError('wisp: a URL');
		this.#wisp = new WispConnection(wisp);
		this.#storageName = storageName;
	}

	async init() {
		if (this.#client) return;
		const wisp = this.#wisp;
		const started = performance.now();
		this.#client = new TorClient({
			socketProvider: {
				connect: (target) => wisp.open(target),
				gateway: null,
				close: () => wisp.close(),
			},
			// the client's guards and its directory cache, kept across
			// sessions and New Identity as Tor Browser keeps them
			storage: storage.addLocking(
				new storage.IndexedDBStorage(this.#storageName),
				this.#storageName,
			),
			logLevel: 'info',
		});
		try {
			await this.#client.ready();
		} catch (error) {
			this.status = { state: 'failed', error: String(error) };
			throw error;
		}
		this.status = {
			state: 'ready',
			bootstrapMs: Math.round(performance.now() - started),
		};
		this.ready = true;
		console.info(`[tor] bootstrapped in ${this.status.bootstrapMs} ms`);
	}

	/** circuits apart for each first-party site, and for each new identity */
	#isolationKey(partition) {
		const site = partition?.split(' ')[0] || 'opaque';
		let siteNonce = this.#siteNonces.get(site);
		if (!siteNonce) this.#siteNonces.set(site, (siteNonce = nonce()));
		return `${this.#session} ${siteNonce} ${site}`;
	}

	/** New circuit for this site: its next request builds one */
	newCircuit(site) {
		this.#siteNonces.delete(site);
	}

	/** New Identity: no circuit of before is used again */
	newIdentity() {
		this.#session = nonce();
		this.#siteNonces.clear();
	}

	async request(remote, method, body, headers, signal) {
		if (!this.ready) await this.init();
		let partition;
		const fields = {};
		for (const [name, value] of headers) {
			const lower = name.toLowerCase();
			if (lower === NETWORK_PARTITION) partition = value;
			else if (lower in fields)
				fields[lower] += `${lower === 'cookie' ? '; ' : ', '}${value}`;
			else fields[lower] = value;
		}
		const response = await this.#client.fetch(String(remote), {
			method,
			headers: fields,
			body: await sendable(body),
			signal,
			anonOptions: { isolationKey: this.#isolationKey(partition) },
		});
		const raw = [];
		for (const [name, value] of response.headers)
			if (name !== 'set-cookie') raw.push([name, value]);
		for (const cookie of response.headers.getSetCookie?.() ?? [])
			raw.push(['set-cookie', cookie]);
		return {
			body: response.body ?? new ArrayBuffer(0),
			headers: raw,
			status: response.status,
			statusText: response.statusText,
		};
	}

	// Tor mode refuses WebSockets for now (docs/tor-over-wisp.md "HTTPS, DNS
	// and what Tor mode refuses")
	connect(_url, _protocols, _headers, _onopen, _onmessage, onclose, onerror) {
		queueMicrotask(() => {
			onerror('WebSockets are not available in Tor mode');
			onclose(1006, '');
		});
		return [() => {}, () => {}];
	}
}
