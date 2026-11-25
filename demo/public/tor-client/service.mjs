// The in-browser Tor client (docs/tor-over-wisp.md): arti (tor-js) builds
// the circuits; the Wisp server is given nothing but TCP streams to Tor
// relays' ORPorts (an IP and a port from arti's signed directory or its
// compiled-in fallbacks), each carrying Tor's link TLS. A site's TLS is
// epoxy's, end to end, on a Tor stream (TorClient.connect, the Fracital
// build's stream API: deploy/tor-js), and the exit resolves its name.
// It runs in the SharedWorker every tab's transport shares (shared.mjs),
// or in a tab's own transport worker where there is none (transport.mjs).
import { FALLBACK_ADDRESSES } from './fallbacks.js';
import { CONSENSUS_KEYS, liveDirectory, rangedStorage } from './keptState.mjs';
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
	/** the socket opened last, open or opening */
	#current = null;
	#opening = null;
	#streams = new Map();
	#nextId = 1;
	#initialCredit = 0;
	#creditReady = null;
	/** `ip:port`: how many links to it are open now (openLinks) */
	#open = new Map();

	constructor(url, links = {}) {
		this.#url = url;
		this.#links = links;
	}

	#connect() {
		if (this.#opening) return this.#opening;
		const socket = new WebSocket(this.#url);
		this.#current = socket;
		// a socket close() let go says nothing more: the next one is another's
		const current = () => this.#current === socket;
		this.#opening = new Promise((resolve, reject) => {
			socket.binaryType = 'arraybuffer';
			let creditSeen;
			this.#creditReady = new Promise((done) => (creditSeen = done));
			socket.onopen = () => {
				if (!current()) return reject(new Error('the Wisp connection closed'));
				this.#socket = socket;
				resolve(socket);
			};
			socket.onerror = () => reject(new Error(`Wisp ${this.#url} failed`));
			socket.onclose = () => {
				reject(new Error('the Wisp connection closed'));
				if (current()) this.#drop();
			};
			socket.onmessage = ({ data }) => {
				if (!current()) return;
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

	/** the socket gone: its links end, and the next one opens another */
	#drop() {
		this.#current = null;
		this.#socket = null;
		this.#opening = null;
		for (const stream of this.#streams.values())
			stream.closed('the Wisp connection closed');
		this.#streams.clear();
	}

	/**
	 * The relays this connection has a link open to now (`ip:port`, as arti
	 * named them): a circuit's first hop is one of them
	 */
	openLinks() {
		return [...this.#open.keys()];
	}

	#linkOpened(target) {
		this.#open.set(target, (this.#open.get(target) ?? 0) + 1);
	}

	#linkEnded(target) {
		const left = (this.#open.get(target) ?? 1) - 1;
		if (left > 0) this.#open.set(target, left);
		else this.#open.delete(target);
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
			this.#linkEnded(target);
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
		this.#linkOpened(target);
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

	/**
	 * The socket opened now, before arti asks for its first link: the
	 * WebSocket's handshake (and its TLS, to a remote Wisp server) is then
	 * done while the client loads its state rather than after. A socket
	 * that fails says so at the first link, which opens another.
	 */
	warm() {
		this.#connect().catch(() => {});
	}

	/** every link ends now, and the next one opens a socket of its own */
	close() {
		const socket = this.#current;
		this.#drop();
		socket?.close();
	}
}

/** a random nonce, so a new identity's keys share no circuit with the old */
const nonce = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');

/** a relay's identity as a consensus writes it (base64, unpadded) in hex, as Tor writes a fingerprint */
function fingerprintOf(identity) {
	try {
		const bytes = atob(
			identity.padEnd(Math.ceil(identity.length / 4) * 4, '='),
		);
		return Array.from(bytes, (c) =>
			c.charCodeAt(0).toString(16).padStart(2, '0'),
		)
			.join('')
			.toUpperCase();
	} catch {
		return '';
	}
}

/**
 * The relays a consensus lists, as `ip:port` of their ORPorts (the microdesc
 * flavour's `r` lines, and `a` lines for IPv6), the way arti names a link's
 * address, each with its nickname and fingerprint (the circuit display). A
 * value kept as JSON has its newlines escaped.
 */
function consensusRelays(text) {
	const relays = new Map();
	const lines = (
		text.includes('\n') ? text : text.replaceAll('\\n', '\n')
	).split('\n');
	let relay = null;
	for (const line of lines) {
		const r = /^r (\S+) (\S+) \S+ \S+ ((?:\d{1,3}\.){3}\d{1,3}) (\d+) \d+/.exec(
			line,
		);
		if (r) {
			relay = { nickname: r[1], fingerprint: fingerprintOf(r[2]) };
			relays.set(`${r[3]}:${r[4]}`, relay);
		}
		const a = /^a (\[[0-9a-fA-F:]+\]:\d+)/.exec(line);
		if (a && relay) relays.set(a[1].toLowerCase(), relay);
	}
	return relays;
}

/**
 * The client's guards as arti keeps them (tor-guardmgr's GuardSets, under
 * a `state:` key of the storage: `default.guards`, each with its `id`, its
 * `ed25519` and its `rsa` in hex, and its `orports`, and
 * `default.confirmed`, the ids in the order arti prefers them), the
 * confirmed first in that order; none where no kept value reads as one
 */
function guardsOf(entries) {
	const rsa = (id) =>
		typeof id?.rsa === 'string' ? id.rsa.replace(/^\$/, '').toUpperCase() : '';
	for (const [, kept] of entries) {
		let value = kept;
		try {
			// (a JSON string of the JSON, where a storage wraps it once more)
			for (let i = 0; i < 2 && typeof value === 'string'; i++)
				value = JSON.parse(value);
		} catch {
			continue;
		}
		const set = value?.default;
		if (!Array.isArray(set?.guards)) continue;
		const confirmed = Array.isArray(set.confirmed) ? set.confirmed : [];
		const rank = (guard) => {
			const at = confirmed.findIndex(
				(id) =>
					(rsa(id) !== '' && rsa(id) === rsa(guard.id)) ||
					(typeof id?.ed25519 === 'string' && id.ed25519 === guard.id?.ed25519),
			);
			return at < 0 ? Infinity : at;
		};
		return set.guards
			.filter((guard) => guard && typeof guard === 'object' && !guard.disabled)
			.map((guard) => ({
				fingerprint: rsa(guard.id),
				orports: Array.isArray(guard.orports)
					? guard.orports.map((address) => String(address).toLowerCase())
					: [],
				rank: rank(guard),
			}))
			.sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1));
	}
	return [];
}

// where tor-js keeps arti's state manager's values, the guards among them
const STATE_KEYS = 'state:';
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
	/** site: since when its circuits are used and how many streams went on them */
	#siteUse = new Map();
	/** the page's token of the Tor session it began (newSession) */
	#sessionToken = '';
	#storageName;
	/** tor-js's IndexedDB store under the storage, for Forget Tor state */
	#inner = null;
	#storage = null;
	#listeners = new Set();
	#say;
	/** the client made by each start; a start of an older one keeps out of the status */
	#generation = 0;
	/** ends the start under way, for Forget Tor state */
	#supersede = null;
	/** the asks of Forget Tor state done (forgetState's tokens) */
	#forgetTokens = new Set();
	// where the Wisp streams may go: the fallback directories arti has
	// compiled in, and the relays of the newest consensus it kept
	#relays = new Set(FALLBACK_ADDRESSES);
	/** `ip:port`: the nickname and fingerprint the newest consensus gives it */
	#relayInfo = new Map();
	/**
	 * The newest consensus the client read back or kept, and its
	 * valid-after: its relays are read from it when a link or the circuit
	 * display first needs them (#relaysNow), not as arti hands it over,
	 * which a start does twice or more for the same one
	 */
	#consensus = null;
	#consensusAfter = -Infinity;
	#consensusRead = null;
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

	/** the relays of the live consensus the storage holds now */
	async #readConsensus() {
		// (liveDirectory hands each one to #keepConsensus)
		await this.#storage.getAll(CONSENSUS_KEYS).catch(() => []);
		this.#relaysNow();
	}

	/**
	 * A consensus arti read back or kept (liveDirectory; `newest` for one
	 * it keeps, the newest it has whatever its times say), `times` its own
	 */
	#keepConsensus(value, times, newest) {
		if (typeof value !== 'string') return;
		const after = times?.validAfter ?? (newest ? Infinity : -Infinity);
		if (!newest && after < this.#consensusAfter) return;
		this.#consensus = value;
		this.#consensusAfter = after;
	}

	/** the relays of the newest consensus, read once from it */
	#relaysNow() {
		const value = this.#consensus;
		if (value === null || value === this.#consensusRead) return;
		this.#consensusRead = value;
		const relays = consensusRelays(value);
		// a consensus lists thousands; anything less is not one
		if (relays.size < 100) return;
		this.#relays = new Set([...FALLBACK_ADDRESSES, ...relays.keys()]);
		this.#relayInfo = relays;
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
		// the consensus arti read or kept since the last look
		this.#relaysNow();
		if (this.#relays.has(address)) return;
		// one of the store's arti has not handed over (a client started
		// before it read its directory, or another tab's)
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

	/**
	 * The client's state, its store (`storageName`, tor-js's IndexedDB) made
	 * once for every start: a lock tor-js's wrapper took stays this one's,
	 * so a start after a failure or Forget Tor state writes to the store, not
	 * to the memory tor-js keeps for a wrapper that could not lock it
	 */
	#openStorage() {
		if (this.#storage) return this.#storage;
		this.#inner = new storage.IndexedDBStorage(this.#storageName);
		const kept = storage.addLocking(
			rangedStorage(this.#inner),
			this.#storageName,
		);
		// a kept consensus only until its valid-until; every consensus arti
		// reads back or keeps names the relays it may dial next
		this.#storage = liveDirectory(kept, {
			consensus: (value, times, newest) =>
				this.#keepConsensus(value, times, newest),
		});
		return this.#storage;
	}

	async #start() {
		const wisp = this.#wisp;
		const started = performance.now();
		const generation = this.#generation;
		const current = () => generation === this.#generation;
		const superseded = new Promise((_, reject) => {
			this.#supersede = () =>
				reject(new Error('the Tor client started again (Forget Tor state)'));
		});
		superseded.catch(() => {});
		// the client starts at once: the relays it may dial come with the
		// directory arti reads back (#keepConsensus), and are read from it
		// at its first link
		this.#openStorage();
		wisp.warm();
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
			// (a client Forget Tor state closed says nothing more)
			log: new Log({
				rawLog: (_level, ...args) => current() && this.#log(...args),
			}),
			logLevel: 'info',
		});
		this.#client = client;
		// arti's own progress and blocker, where this tor-js tells them
		const events =
			typeof client.bootstrapEvents === 'function'
				? client.bootstrapEvents(
						(event) => current() && this.#bootstrapEvent(event),
					)
				: null;
		try {
			await Promise.race([client.ready(), superseded]);
		} catch (error) {
			// nothing of a failed client is used again (a retry makes another)
			try {
				client.close();
			} catch {
				// closed already
			}
			if (!current()) throw error;
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
			throw error;
		} finally {
			if (typeof events === 'function') events();
		}
		if (!current()) throw new Error('the Tor client started again');
		const bootstrapMs = Math.round(performance.now() - started);
		this.#phase('ready', 100, 'Done', { bootstrapMs });
		this.#say('info', `[tor] bootstrapped in ${bootstrapMs} ms`);
	}

	/** circuits apart for each first-party site, and for each new identity */
	#isolationKey(site) {
		let siteNonce = this.#siteNonces.get(site);
		if (!siteNonce) {
			this.#siteNonces.set(site, (siteNonce = nonce()));
			this.#siteUse.set(site, { since: Date.now(), streams: 0 });
		}
		return `${this.#session} ${siteNonce} ${site}`;
	}

	/** New circuit for this site: its next request builds one */
	newCircuit(site) {
		this.#siteNonces.delete(site);
		this.#siteUse.delete(site);
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
		this.#siteUse.clear();
	}

	/**
	 * A page began a new Tor session (its profile forgotten, docs/tor.md
	 * "Profiles"): no circuit of the last session is used in it, though the
	 * client, which outlives its pages (extendedLifetime), is the same. Each
	 * transport the page makes says so with the page's `token`, the first
	 * one alone counts.
	 */
	newSession(token) {
		if (typeof token !== 'string' || !token || token === this.#sessionToken)
			return;
		this.#sessionToken = token;
		this.newIdentity();
	}

	/**
	 * What the client can tell of the circuits of the site of `url` (the
	 * tab's address), Tor Browser's "Circuit for this site": the site key
	 * and since when its circuits are used, and the guard, the first hop of
	 * every circuit. tor-js tells nothing of a circuit's middle and exit
	 * relays (docs/tor-over-wisp.md "Circuit display"). The guard is the
	 * first of arti's guards (its state's confirmed order) a link is open
	 * to now, as arti's exit circuits go through its first usable primary
	 * guard; where its state names none, the one relay a link is open to;
	 * with no link open, the guard arti tries first (`linked` false).
	 */
	async circuitFor(url) {
		this.#relaysNow();
		let site = null;
		for (const [key, use] of this.#siteUse)
			if (
				siteMatches(key, url) &&
				(!site || use.since > this.#siteUse.get(site).since)
			)
				site = key;
		const use = site ? this.#siteUse.get(site) : null;
		const links = this.#wisp.openLinks();
		const guards = this.#storage
			? guardsOf(await this.#storage.getAll(STATE_KEYS).catch(() => []))
			: [];
		const relay = (address, fingerprint = '') => {
			const known = this.#relayInfo.get(address);
			return {
				address,
				nickname: known?.nickname ?? '',
				fingerprint: fingerprint || known?.fingerprint || '',
			};
		};
		let guard = null;
		let from = '';
		for (const kept of guards) {
			const address = kept.orports.find((at) => links.includes(at));
			if (!address) continue;
			guard = { ...relay(address, kept.fingerprint), linked: true };
			from = 'state';
			break;
		}
		if (!guard && links.length === 1) {
			guard = { ...relay(links[0]), linked: true };
			from = 'link';
		}
		// no link open now (the connections went idle): the guard arti
		// tries first for the next circuit
		if (!guard && guards[0]?.orports.length) {
			guard = {
				...relay(guards[0].orports[0], guards[0].fingerprint),
				linked: false,
			};
			from = 'state';
		}
		return {
			state: this.status.state,
			site,
			since: use?.since ?? null,
			streams: use?.streams ?? 0,
			guard,
			guardFrom: from,
			guards: guards.length,
			links: links.length,
			// what tor-js does not tell
			middle: null,
			exit: null,
		};
	}

	/**
	 * Forget Tor state: the client's guards and directory gone from its
	 * store, and the client started again, so it samples new guards and
	 * downloads the directory anew (a new identity with it). Every tab of
	 * the shared client hears its status start over. `token` names the
	 * ask: one asked again (by another transport of the same page) does
	 * nothing and gives null.
	 */
	async forgetState(token = '') {
		if (token) {
			if (this.#forgetTokens.has(token)) return null;
			this.#forgetTokens.add(token);
		}
		this.#generation++;
		this.#supersede?.();
		this.#supersede = null;
		const client = this.#client;
		this.#client = null;
		this.#starting = null;
		try {
			client?.close();
		} catch {
			// closed already
		}
		// its links to relays (the guard's among them) end with it
		this.#wisp.close();
		const kept = this.#openStorage();
		const inner = this.#inner;
		// the store itself, and what tor-js's wrapper keeps in memory when
		// another holds the store's lock
		const keys = new Set([
			...(await inner.keys('').catch(() => [])),
			...(await kept.keys('').catch(() => [])),
		]);
		for (const key of keys) {
			await inner.delete(key).catch(() => {});
			await kept.delete(key).catch(() => {});
		}
		this.#relays = new Set(FALLBACK_ADDRESSES);
		this.#relayInfo = new Map();
		this.#consensus = null;
		this.#consensusAfter = -Infinity;
		this.#consensusRead = null;
		this.newIdentity();
		this.#links = { reached: 0, failed: 0, code: undefined };
		this.#linkBlocked = null;
		this.#artiBlocked = null;
		this.#tell({ state: 'starting', progress: 0, summary: 'Starting' });
		this.#say(
			'info',
			`[tor] forgot the client's state (${keys.size} entries): new guards from its next bootstrap`,
		);
		this.init().catch(() => {});
		return { forgotten: keys.size };
	}

	/** a Tor stream on the site's circuit, given up when it does not open in time */
	#connectOnce(host, port, site) {
		const client = this.#client;
		if (!client) throw new Error('the Tor client started again');
		const opening = client.connect(host, port, {
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
		let stream;
		try {
			stream = await this.#connectOnce(host, port, site);
		} catch {
			this.newCircuit(site);
			stream = await this.#connectOnce(host, port, site);
		}
		const use = this.#siteUse.get(site);
		if (use) use.streams++;
		return stream;
	}
}
