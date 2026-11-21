// tor-js's place in the offline-html suite's offline.html
// (scripts/build-offline.mjs --tor-stand-in): Tor mode's client as the
// file runs it (demo/offline/tor-worker.mjs, the page's port to it, the
// service's Wisp streams, its IndexedDB, epoxy on its streams in the page),
// with no Tor network. A "Tor stream" here is the Wisp server's TCP stream
// to the exit's own resolution of every name, 127.0.0.1: the suite's
// fixture, through the run's holyWisp. The stream's address is first kept
// as the relays of a consensus, so the service's refusal of anything that is
// not a relay (service.mjs admit) lets it through as it lets a relay.
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

/** a microdesc consensus's relay lines: `address` and enough others to read as one */
function consensus(address) {
	const [ip, port] = address.split(':');
	const lines = [`r standin AAAA 2026-01-01 00:00:00 ${ip} ${port} 0`];
	for (let i = 1; i <= 120; i++)
		lines.push(`r other${i} AAAA 2026-01-01 00:00:00 192.0.2.${i} 9001 0`);
	return lines.join('\n');
}

export class TorClient {
	#options;
	#kept = new Set();
	constructor(options) {
		this.#options = options;
	}

	async ready() {
		const { log } = this.#options;
		if (!(wasm instanceof WebAssembly.Module) && typeof wasm !== 'string')
			throw new Error('the stand-in was given no wasm');
		log.rawLog('info', 'Looking for a consensus');
		await this.#options.storage.set(
			'stand-in:started',
			String(
				(Number(await this.#options.storage.get('stand-in:started')) || 0) + 1,
			),
		);
		log.rawLog('info', 'Bootstrap complete');
	}

	async connect(_host, port) {
		const address = `127.0.0.1:${port}`;
		if (!this.#kept.has(address)) {
			this.#kept.add(address);
			await this.#options.storage.set(
				`dir:consensus:stand-in-${port}`,
				consensus(address),
			);
		}
		const socket = await this.#options.socketProvider.connect(address);
		return { readable: socket.readable, writable: socket.writable };
	}

	close() {}
}
