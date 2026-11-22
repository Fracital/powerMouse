// tor-js's place for the suites that run Tor mode's own client code with
// no Tor network: offline.html's (scripts/build-offline.mjs --tor-stand-in,
// the offline-html suite: demo/offline/tor-worker.mjs, the page's port to
// it, the service's Wisp streams, its IndexedDB, epoxy on its streams in the
// page) and the served demo's (STOMP_TOR_CLIENT=stand-in-arti, which
// demo/server.js serves at /tor-client/tor-js/: transport.mjs, shared.mjs,
// remote.mjs and service.mjs as production runs them, for the
// demo-tor-fail-closed suite). A "Tor stream" here is the Wisp server's TCP
// stream to the exit's own resolution of every name, 127.0.0.1: the suite's
// fixture, through the run's holyWisp. The stream's address is first kept
// as the relays of a consensus, so the service's refusal of anything that is
// not a relay (service.mjs admit) lets it through as it lets a relay.
//
// What the client does can be broken on purpose, for the suites that check
// Tor mode fails closed: the origin's IndexedDB `tor-stand-in-control` (store
// `kv`, key `mode`), read at each bootstrap (ready()) and each stream
// (connect()), says how. With none, the client works.
//
//   hang         bootstrap never ends (arti waiting on a directory)
//   unreachable  every link to a relay fails at the Wisp server (a closed
//                port), then bootstrap gives up with arti's vague error
//   events       bootstrap tells its progress through bootstrapEvents (the
//                shape service.mjs reads; tor-js has no such call yet), is
//                blocked a while by a skewed clock, then completes
//   circuits     bootstrap completes, but no stream opens (a failed guard,
//                circuits that do not build)
//   direct       bootstrap completes, but each stream dials the site itself
//                instead of a relay (a tampered or broken arti): the
//                service's relay check must refuse it
let wasm = null;

/** as tor-js's: a URL or a compiled module, which the stand-in only checks it was given */
export function setWasmUrl(source) {
	wasm = source;
}

export class ArtiSocket {
	constructor(socket) {
		Object.assign(this, socket);
	}
}

export class Log {
	constructor({ rawLog }) {
		this.rawLog = rawLog;
	}
}

const request = (r) =>
	new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});

class IndexedDBStorage {
	#db;
	constructor(name) {
		const open = indexedDB.open(`${name}-stand-in`, 1);
		open.onupgradeneeded = () => open.result.createObjectStore('kv');
		this.#db = request(open);
	}
	async #store(mode) {
		return (await this.#db).transaction('kv', mode).objectStore('kv');
	}
	async get(key) {
		return (await request((await this.#store('readonly')).get(key))) ?? null;
	}
	async set(key, value) {
		await request((await this.#store('readwrite')).put(value, key));
	}
	async delete(key) {
		await request((await this.#store('readwrite')).delete(key));
	}
	async keys(prefix = '') {
		const all = await request((await this.#store('readonly')).getAllKeys());
		return all.filter((key) => String(key).startsWith(prefix));
	}
	async getAll(prefix = '') {
		const out = [];
		for (const key of await this.keys(prefix))
			out.push([key, await this.get(key)]);
		return out;
	}
}

export const storage = {
	IndexedDBStorage,
	addLocking: (kept) => ({
		get: (key) => kept.get(key),
		set: (key, value) => kept.set(key, value),
		delete: (key) => kept.delete(key),
		keys: (prefix) => kept.keys(prefix),
		getAll: (prefix) => kept.getAll(prefix),
		tryLock: async () => true,
		unlock: async () => {},
	}),
};

/** the suite's choice of how the client breaks ('' for none) */
async function controlMode() {
	try {
		const open = indexedDB.open('tor-stand-in-control', 1);
		open.onupgradeneeded = () => open.result.createObjectStore('kv');
		const db = await request(open);
		try {
			const store = db.transaction('kv', 'readonly').objectStore('kv');
			return String((await request(store.get('mode'))) ?? '');
		} finally {
			db.close();
		}
	} catch {
		// no IndexedDB here (a file: page that has none): the client works
		return '';
	}
}

/** a microdesc consensus's relay lines: `addresses` and enough others to read as one */
function consensus(...addresses) {
	const lines = addresses.map((address) => {
		const [ip, port] = address.split(':');
		return `r standin AAAA 2026-01-01 00:00:00 ${ip} ${port} 0`;
	});
	for (let i = 1; i <= 120; i++)
		lines.push(`r other${i} AAAA 2026-01-01 00:00:00 192.0.2.${i} 9001 0`);
	return lines.join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// a relay address the Wisp server cannot reach: a closed port of its own host
const DEAD_RELAY = '127.0.0.1:9';

export class TorClient {
	#options;
	#kept = new Set();
	#closed = false;
	#bootstrapListeners = new Set();
	constructor(options) {
		this.#options = options;
	}

	/**
	 * The bootstrap's events, as arti's bootstrap_events() would give them
	 * through tor-js (docs/tor-over-wisp.md "Bootstrap progress"):
	 * `listener({ fraction, ready, blocked })`, `blocked` null or
	 * `{ kind, message }`; returns its removal
	 */
	bootstrapEvents(listener) {
		this.#bootstrapListeners.add(listener);
		return () => this.#bootstrapListeners.delete(listener);
	}

	#event(fraction, blocked = null) {
		for (const listener of this.#bootstrapListeners)
			listener({ fraction, ready: fraction >= 1, blocked });
	}

	async ready() {
		const { log, socketProvider } = this.#options;
		if (!(wasm instanceof WebAssembly.Module) && typeof wasm !== 'string')
			throw new Error('the stand-in was given no wasm');
		const mode = await controlMode();
		log.rawLog('info', 'Looking for a consensus');
		await this.#options.storage.set(
			'stand-in:started',
			String(
				(Number(await this.#options.storage.get('stand-in:started')) || 0) + 1,
			),
		);
		if (mode === 'hang') {
			while (!this.#closed) await sleep(1000);
			throw new Error('closed');
		}
		if (mode === 'unreachable') {
			await this.#options.storage.set(
				'dir:consensus:stand-in-dead',
				consensus(DEAD_RELAY),
			);
			// arti tries its guards, each link closed by the Wisp server
			for (let i = 0; i < 3; i++) {
				const socket = await socketProvider.connect(DEAD_RELAY);
				await socket.closed;
			}
			throw new Error('Unable to bootstrap: tor-js error (bootstrap failed)');
		}
		if (mode === 'events') {
			this.#event(0.1);
			await sleep(300);
			this.#event(0.4);
			await sleep(300);
			this.#event(0.5, {
				kind: 'clock-skewed',
				message: 'Clock is skewed: 3 hours behind the network',
			});
			await sleep(4000);
			this.#event(0.9);
			await sleep(300);
			this.#event(1);
		}
		log.rawLog('info', 'Bootstrap complete');
	}

	async connect(host, port) {
		const mode = await controlMode();
		if (mode === 'circuits')
			throw new Error('Circuit build failed: guard unreachable');
		const address = `127.0.0.1:${port}`;
		if (mode !== 'direct' && !this.#kept.has(address)) {
			this.#kept.add(address);
			await this.#options.storage.set(
				`dir:consensus:stand-in-${port}`,
				consensus(address),
			);
		}
		const socket = await this.#options.socketProvider.connect(address);
		return { readable: socket.readable, writable: socket.writable };
	}

	close() {
		this.#closed = true;
	}
}
