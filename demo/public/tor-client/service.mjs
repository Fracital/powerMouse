// The in-browser Tor client (docs/tor-over-wisp.md): arti (tor-js) builds
// the circuits; the Wisp server is given nothing but TCP streams to Tor
// relays' ORPorts (an IP and a port from arti's signed directory or its
// compiled-in fallbacks), each carrying Tor's link TLS. A site's TLS is
// epoxy's, end to end, on a Tor stream (TorClient.connect, the Fracital
// build's stream API: deploy/tor-js), and the exit resolves its name.
// It runs in the SharedWorker every tab's transport shares (shared.mjs),
// or in a tab's own transport worker where there is none (transport.mjs).
import { FALLBACK_ADDRESSES } from './fallbacks.js';
import {
	ArtiSocket,
	Log,
	setWasmUrl,
	storage,
	TorClient,
} from './tor-js/entryPoints/wasm-file/index.js';

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
 * server resolves nothing for Tor mode. `links` hears how each link to a
 * relay went: `reached()` at its first bytes, `failed(code)` when it closed
 * before any (`code` the Wisp close reason, undefined when the WebSocket to
 * the Wisp server did not open).
 */
class WispConnection {
	#url;
	#links;
	#socket = null;
	#opening = null;
	#streams = new Map();
	#nextId = 1;
	#initialCredit = 0;
	#creditReady = null;

	constructor(url, links = {}) {
		this.#url = url;
		this.#links = links;
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
					stream.closed(
						`Wisp close reason 0x${payload[0]?.toString(16)}`,
						payload[0],
					);
				}
			};
		});
		return this.#opening;
	}

	async open(target) {
		const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(target);
		if (!match) throw new Error(`not an address: ${target}`);
		const [, host, port] = match;
		let socket;
		try {
			socket = await this.#connect();
		} catch (error) {
			this.#links.failed?.(undefined);
			throw error;
		}
		await this.#creditReady;
		const id = this.#nextId++;
		let controller;
		let credit = this.#initialCredit;
		let waiting = null;
		let finished = false;
		// bytes the relay sent: a link closed before any is a relay not reached
		let received = 0;
		let settle;
		const closed = new Promise((resolve) => (settle = resolve));
		const finish = (ok, reason, code) => {
			if (finished) return;
			finished = true;
			try {
				if (ok) controller.close();
				else controller.error(new Error(reason));
			} catch {
				// its reader cancelled it already
			}
			waiting?.();
			settle(ok ? { ok, received } : { ok, reason, code, received });
			if (!ok && !received) this.#links.failed?.(code);
		};
		const stream = {
			data: (bytes) => {
				if (!received) this.#links.reached?.();
				received += bytes.byteLength;
				if (!finished) controller.enqueue(new Uint8Array(bytes));
			},
			credit: (value) => {
				credit = value;
				waiting?.();
				waiting = null;
			},
			closed: (reason, code) => finish(false, reason, code),
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

/**
 * The relays a consensus lists, as `ip:port` of their ORPorts (the microdesc
 * flavour's `r` lines, and `a` lines for IPv6), the way arti names a link's
 * address. A value kept as JSON has its newlines escaped.
 */
function consensusRelays(text) {
	const relays = new Set();
	const lines = (
		text.includes('\n') ? text : text.replaceAll('\\n', '\n')
	).split('\n');
	for (const line of lines) {
		const r = /^r \S+ \S+ \S+ \S+ ((?:\d{1,3}\.){3}\d{1,3}) (\d+) \d+/.exec(
			line,
		);
		if (r) relays.add(`${r[1]}:${r[2]}`);
		const a = /^a (\[[0-9a-fA-F:]+\]:\d+)/.exec(line);
		if (a) relays.add(a[1].toLowerCase());
	}
	return relays;
}

const CONSENSUS_KEYS = 'dir:consensus:';
// how long a Tor stream may take to open on one circuit before it is tried
// on another (tor's stream attach timeouts are 10 and 15 s)
const STREAM_OPEN_MS = 20000;

/** whether the site key `site` is the host of `url` or a parent of it */
export function siteMatches(site, url) {
	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		return false;
	}
	let siteHost;
	try {
		siteHost = new URL(site).hostname;
	} catch {
		siteHost = site;
	}
	return host === siteHost || host.endsWith(`.${siteHost}`);
}

// Tor Browser's bootstrap phases (tor's BOOTSTRAP_STATUS), from what arti
// says as it goes; tor-js tells no progress of its own yet
const PHASES = [
	[/Looking for a consensus/, 10, 'Loading network status'],
	[/Downloading certificates/, 40, 'Loading authority certificates'],
	[/Downloading microdescriptors/, 50, 'Loading relay descriptors'],
	[/Loaded a good directory from cache/, 75, 'Loaded relay descriptors'],
	[/Marked consensus usable/, 75, 'Loaded relay descriptors'],
	[/Bootstrap complete/, 90, 'Establishing a Tor circuit'],
];

/** the phase a bootstrap event's progress is in (bootstrapEvents) */
function phaseAt(progress) {
	let summary = 'Connecting to a relay';
	for (const [, at, name] of PHASES) if (progress >= at) summary = name;
	return summary;
}

// What a link to a relay ended with, as the Wisp server said it (its close
// reasons, wisp-protocol): the blocker the page shows
const WISP_REASONS = new Map([
	[0x03, 'a network error'],
	[0x41, 'an invalid address'],
	[0x42, 'an unreachable host'],
	[0x43, 'a connection timeout'],
	[0x44, 'a refused connection'],
	[0x47, 'a stalled connection'],
	[0x49, 'throttling'],
]);
// links that failed, with none reached, before bootstrap is said to be blocked
const BLOCKED_AFTER = 2;
// arti's BlockageKind (arti-client status.rs), as bootstrapEvents names them
const BLOCKAGE_KINDS = new Set([
	'offline',
	'filtering',
	'cant-reach-tor',
	'clock-skewed',
	'cant-bootstrap',
]);

let wasmChosen = false;
/**
 * Where arti's wasm comes from, when not from beside tor-js's module
 * (`../../tor_js_bg.wasm`): a URL (a host that serves it under a name of
 * its own) or a compiled WebAssembly.Module (offline.html, whose worker
 * can fetch none of the page's blob: URLs). The first one given is kept:
 * the wasm is instantiated once per realm.
 */
export function useWasm(source) {
	if (wasmChosen || source === undefined || source === null) return;
	wasmChosen = true;
	setWasmUrl(source);
}

/** an id for this client, so the page can tell its tabs share one */
const instanceId = () => nonce();

export class TorService {
	#wisp;
	#client = null;
	#starting = null;
	#session = nonce();
	#siteNonces = new Map();
	#storageName;
	#storage = null;
	#listeners = new Set();
	#say;
	// where the Wisp streams may go: the fallback directories arti has
	// compiled in, and the relays of the newest consensus it kept
	#relays = new Set(FALLBACK_ADDRESSES);
	/**
	 * What bootstrap took and what it is doing, for the page and the smoke:
	 * `blocked` ({ kind, message }) says why it cannot go on, arti's own
	 * reason where tor-js tells it (bootstrapEvents), else what this client
	 * saw of its links to relays
	 */
	status = {
		state: 'starting',
		progress: 0,
		summary: 'Starting',
		instance: instanceId(),
	};
	/** links to relays in this bootstrap: reached, failed, and the last failure's reason */
	#links = { reached: 0, failed: 0, code: undefined };
	#linkBlocked = null;
	#artiBlocked = null;

	/**
	 * `say(level, text)`: the client's own console lines (its bootstrap, a
	 * refused link), the console's by default; `wasm`: where arti's wasm is
	 * (useWasm), when not beside tor-js's module
	 */
	constructor({
		wisp,
		storageName = 'stomp-tor-client',
		say = (level, text) => console[level](text),
		wasm,
	} = {}) {
		if (typeof wisp !== 'string') throw new TypeError('wisp: a URL');
		// the npm release has only fetch
		if (typeof TorClient.prototype.connect !== 'function')
			throw new Error(
				'this tor-js has no stream API (TorClient.connect): Tor mode needs the Fracital build (deploy/tor-js)',
			);
		useWasm(wasm);
		this.#wisp = new WispConnection(wisp, {
			reached: () => this.#linkReached(),
			failed: (code) => this.#linkFailed(code),
		});
		this.#storageName = storageName;
		this.#say = say;
	}

	/** `listener(status)` at each change; returns its removal */
	onStatus(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#phase(state, progress, summary, extra = {}) {
		if (state === 'bootstrapping' && progress <= (this.status.progress ?? 0))
			return;
		this.#tell({ state, progress, summary, ...extra });
	}

	#tell({ state, progress, summary, ...extra }) {
		const { instance, refused } = this.status;
		const blocked = state === 'ready' ? null : this.#blocked();
		this.status = {
			state,
			progress,
			summary,
			instance,
			refused,
			...(blocked && { blocked }),
			...extra,
		};
		for (const listener of this.#listeners) listener(this.status);
	}

	#blocked() {
		return this.#artiBlocked ?? this.#linkBlocked;
	}

	/** the status again, for a blocker that came or went */
	#retell() {
		if (this.status.state !== 'bootstrapping') return;
		const before = this.status.blocked?.message;
		if (before === this.#blocked()?.message) return;
		const { progress, summary } = this.status;
		this.#tell({ state: 'bootstrapping', progress, summary });
	}

	#linkReached() {
		this.#links.reached++;
		if (!this.#linkBlocked) return;
		this.#linkBlocked = null;
		this.#retell();
	}

	/**
	 * A link to a relay that never answered (`code` its Wisp close reason,
	 * undefined when the Wisp server itself could not be reached): with
	 * none reached, a few say what blocks bootstrap, rather than a phase
	 * that never moves or arti's generic error at the end
	 */
	#linkFailed(code) {
		if (this.status.state === 'ready') return;
		const links = this.#links;
		links.failed++;
		links.code = code;
		if (links.reached) return;
		if (code === undefined)
			this.#linkBlocked = {
				kind: 'offline',
				message: 'Cannot reach the Wisp server',
			};
		else if (code === 0x48)
			this.#linkBlocked = {
				kind: 'filtering',
				message: 'The Wisp server refuses links to Tor relays',
			};
		else if (links.failed >= BLOCKED_AFTER)
			this.#linkBlocked = {
				kind: 'cant-reach-tor',
				message: `No Tor relay answered through the Wisp server (${links.failed} links ended with ${WISP_REASONS.get(code) ?? `close reason 0x${code.toString(16)}`})`,
			};
		else return;
		this.#retell();
	}

	/**
	 * One of arti's bootstrap events, where tor-js tells them
	 * (`client.bootstrapEvents(listener)`, arti's bootstrap_events():
	 * `{ fraction, ready, blocked }`, `blocked` null or `{ kind, message }`
	 * with arti's BlockageKind). Its progress replaces what the log says.
	 */
	#bootstrapEvent(event) {
		if (!event || typeof event !== 'object') return;
		const fraction = Number(event.fraction);
		const blocked = event.blocked;
		this.#artiBlocked =
			blocked && typeof blocked === 'object'
				? {
						kind: BLOCKAGE_KINDS.has(blocked.kind) ? blocked.kind : 'other',
						message: String(blocked.message ?? blocked.kind).slice(0, 200),
					}
				: null;
		if (Number.isFinite(fraction) && !event.ready) {
			const progress = Math.max(5, Math.min(99, Math.round(fraction * 100)));
			if (progress > (this.status.progress ?? 0)) {
				this.#phase('bootstrapping', progress, phaseAt(progress));
				return;
			}
		}
		this.#retell();
	}

	#log(...args) {
		const text = args.map(String).join(' ');
		for (const [pattern, progress, summary] of PHASES)
			if (pattern.test(text)) this.#phase('bootstrapping', progress, summary);
	}

	/** the relays of the consensus the storage holds now */
	async #readConsensus() {
		const kept = await this.#storage.getAll(CONSENSUS_KEYS).catch(() => []);
		for (const [, value] of kept) this.#keepRelays(value);
	}

	#keepRelays(value) {
		if (typeof value !== 'string') return;
		const relays = consensusRelays(value);
		// a consensus lists thousands; anything less is not one
		if (relays.size < 100) return;
		this.#relays = new Set([...FALLBACK_ADDRESSES, ...relays]);
	}

	/**
	 * Refuse a link to anything that is not a Tor relay. arti only dials
	 * relays from its signed directory and its compiled-in fallbacks; this
	 * keeps a bug or a tampered module from using the Wisp server to reach
	 * anything else (a site directly, past Tor)
	 */
	async admit(target) {
		const address = target.toLowerCase();
		if (this.#relays.has(address)) return;
		// a consensus kept since the last look
		if (this.#storage) await this.#readConsensus();
		if (this.#relays.has(address)) return;
		this.status = {
			...this.status,
			refused: (this.status.refused ?? 0) + 1,
		};
		// the page hears of it: a refusal is arti asking for what Tor mode
		// never sends past Tor
		for (const listener of this.#listeners) listener(this.status);
		this.#say('warn', `[tor] refused a link to ${target}: not a Tor relay`);
		throw new Error(`${target} is not a Tor relay this client knows`);
	}

	init() {
		this.#starting ??= this.#start();
		return this.#starting;
	}

	async #start() {
		const wisp = this.#wisp;
		const started = performance.now();
		const kept = storage.addLocking(
			new storage.IndexedDBStorage(this.#storageName),
			this.#storageName,
		);
		// every consensus arti keeps names the relays it may dial next
		this.#storage = {
			...kept,
			get: (key) => kept.get(key),
			getAll: (prefix) => kept.getAll(prefix),
			keys: (prefix) => kept.keys(prefix),
			delete: (key) => kept.delete(key),
			tryLock: () => kept.tryLock(),
			unlock: () => kept.unlock(),
			set: async (key, value) => {
				if (key.startsWith(CONSENSUS_KEYS)) this.#keepRelays(value);
				return kept.set(key, value);
			},
		};
		await this.#readConsensus();
		this.#links = { reached: 0, failed: 0, code: undefined };
		this.#linkBlocked = null;
		this.#artiBlocked = null;
		this.#phase('bootstrapping', 5, 'Connecting to a relay');
		const client = new TorClient({
			socketProvider: {
				connect: async (target) => {
					await this.admit(target);
					return wisp.open(target);
				},
				gateway: null,
				close: () => wisp.close(),
			},
			// the client's guards and its directory cache, kept across
			// sessions and New Identity as Tor Browser keeps them
			storage: this.#storage,
			log: new Log({ rawLog: (_level, ...args) => this.#log(...args) }),
			logLevel: 'info',
		});
		this.#client = client;
		// arti's own progress and blocker, where this tor-js tells them
		const events =
			typeof client.bootstrapEvents === 'function'
				? client.bootstrapEvents((event) => this.#bootstrapEvent(event))
				: null;
		try {
			await client.ready();
		} catch (error) {
			// the blocker, where one is known, says more than arti's error
			const blocked = this.#blocked();
			this.#phase(
				'failed',
				0,
				blocked?.message ?? String(error?.message ?? error),
				{ error: String(error?.message ?? error) },
			);
			this.#starting = null;
			this.#client = null;
			// nothing of a failed client is used again (a retry makes another)
			try {
				client.close();
			} catch {
				// closed already
			}
			throw error;
		} finally {
			if (typeof events === 'function') events();
		}
		const bootstrapMs = Math.round(performance.now() - started);
		this.#phase('ready', 100, 'Done', { bootstrapMs });
		this.#say('info', `[tor] bootstrapped in ${bootstrapMs} ms`);
	}

	/** circuits apart for each first-party site, and for each new identity */
	#isolationKey(site) {
		let siteNonce = this.#siteNonces.get(site);
		if (!siteNonce) this.#siteNonces.set(site, (siteNonce = nonce()));
		return `${this.#session} ${siteNonce} ${site}`;
	}

	/** New circuit for this site: its next request builds one */
	newCircuit(site) {
		this.#siteNonces.delete(site);
	}

	/**
	 * New circuit for the site of `url` (the tab's address): every site key
	 * whose host is the URL's host or a parent of it
	 */
	newCircuitFor(url) {
		for (const site of [...this.#siteNonces.keys()])
			if (siteMatches(site, url)) this.newCircuit(site);
	}

	/** New Identity: no circuit of before is used again */
	newIdentity() {
		this.#session = nonce();
		this.#siteNonces.clear();
	}

	/** a Tor stream on the site's circuit, given up when it does not open in time */
	#connectOnce(host, port, site) {
		const opening = this.#client.connect(host, port, {
			isolationKey: this.#isolationKey(site),
		});
		let timer;
		return Promise.race([
			opening,
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error('no Tor stream in time'));
					// one that opens after all is not used
					opening.then(
						({ readable, writable }) => {
							readable.cancel().catch(() => {});
							writable.abort().catch(() => {});
						},
						() => {},
					);
				}, STREAM_OPEN_MS);
			}),
		]).finally(() => clearTimeout(timer));
	}

	/**
	 * A TCP stream to `host:port` through Tor on a circuit of `site`'s (the
	 * exit resolves `host`): `{ readable, writable }` of Uint8Array chunks.
	 * One that fails or does not open in time is tried once more on a new
	 * circuit for the site (nothing was sent on it yet).
	 */
	async connect(host, port, site) {
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new RangeError(`port ${port}`);
		await this.init();
		try {
			return await this.#connectOnce(host, port, site);
		} catch {
			this.newCircuit(site);
			return this.#connectOnce(host, port, site);
		}
	}
}
