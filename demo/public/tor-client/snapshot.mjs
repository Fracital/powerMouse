// The fast-bootstrap snapshot (docs/tor-over-wisp.md "The fast-bootstrap
// snapshot"): the directory a first visit would download through a
// fallback relay (the microdesc consensus, the authorities' certificates,
// the microdescriptors), as one file from the app's own origin
// (scripts/tor-snapshot.mjs builds it, demo/server.js serves it). The
// server is trusted with none of it: arti loads it as its own cache and
// checks the consensus's signatures against the authorities' keys it has
// compiled in, each certificate's signature and expiry, and each
// microdescriptor by the digest the consensus lists. What this module adds
// is what arti does not refuse: a consensus past its valid-until (arti's
// clock tolerance takes one up to three days late), and a snapshot arti
// refused keeping it from starting at all (holdConsensus).

const MEMBERS = {
	consensus: 'bootstrap/consensus-microdesc.txt',
	certs: 'bootstrap/authority-certs.txt',
	microdescs: 'bootstrap/microdescs.txt',
};
// a snapshot is about 8 MB (3.4 MB of consensus, 4.6 MB of
// microdescriptors); anything far larger is not one, and would only fill
// the client's store
export const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The members of a zip of Stored members, as tor-js reads one (local
 * headers in order, up to the central directory): name to `[start, end)`
 * byte offsets. Throws where tor-js would refuse it.
 */
export function zipMembers(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const members = new Map();
	const names = new TextDecoder('utf-8', { fatal: true });
	let offset = 0;
	while (offset + 30 <= bytes.byteLength) {
		if (view.getUint32(offset, true) !== 0x04034b50) break;
		const method = view.getUint16(offset + 8, true);
		if (method !== 0)
			throw new Error(`a member is compressed (method ${method}), not Stored`);
		const size = view.getUint32(offset + 18, true);
		const nameLength = view.getUint16(offset + 26, true);
		const extraLength = view.getUint16(offset + 28, true);
		const start = offset + 30 + nameLength + extraLength;
		const end = start + size;
		if (end > bytes.byteLength) throw new Error('truncated');
		const name = names.decode(
			bytes.subarray(offset + 30, offset + 30 + nameLength),
		);
		members.set(name, [start, end]);
		offset = end;
	}
	return members;
}

/** the `valid-after`, `fresh-until` and `valid-until` of a consensus's text, in ms */
export function documentTimes(text) {
	const at = (name) => {
		const match = new RegExp(
			`^${name} (\\d{4}-\\d\\d-\\d\\d) (\\d\\d:\\d\\d:\\d\\d)$`,
			'm',
		).exec(text);
		return match ? Date.parse(`${match[1]}T${match[2]}Z`) : NaN;
	};
	return {
		validAfter: at('valid-after'),
		freshUntil: at('fresh-until'),
		validUntil: at('valid-until'),
	};
}

/**
 * The snapshot's consensus times if the client may hand it to arti now;
 * throws the reason it may not: not a snapshot (not a zip tor-js reads,
 * no consensus, not a microdesc consensus), or past its valid-until
 */
export function checkSnapshot(bytes, now = Date.now()) {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
		throw new Error('empty');
	if (bytes.byteLength > SNAPSHOT_MAX_BYTES)
		throw new Error(`${bytes.byteLength} bytes, more than a snapshot`);
	const members = zipMembers(bytes);
	const consensus = members.get(MEMBERS.consensus);
	if (!consensus) throw new Error(`no ${MEMBERS.consensus}`);
	// (the preamble: the times are in its first lines, before any relay)
	const head = new TextDecoder().decode(
		bytes.subarray(consensus[0], Math.min(consensus[1], consensus[0] + 2048)),
	);
	if (!/^network-status-version 3 microdesc\n/.test(head))
		throw new Error('not a microdesc consensus');
	if (!/^vote-status consensus$/m.test(head))
		throw new Error('not a consensus');
	const times = documentTimes(head);
	if (!Number.isFinite(times.validUntil) || !Number.isFinite(times.validAfter))
		throw new Error('its consensus has no times');
	if (now >= times.validUntil)
		throw new Error(
			`its consensus expired at ${new Date(times.validUntil).toISOString()}`,
		);
	return times;
}

/**
 * The snapshot at `url`, as tor-js's `bootstrap` option takes it: bytes
 * tor-js asks for only when its store holds no consensus (a first visit,
 * or the kept one expired), so a later visit fetches nothing. tor-js
 * returns the option from an async function, which reads it as a
 * thenable: `then` is when it is asked for. `start()` fetches it before
 * that, when the client can tell it will be (an empty store).
 *
 * `given` is true once arti has the bytes (a snapshot this module let
 * through); a fetch or a check that fails rejects, and tor-js then
 * downloads the directory as it would with no snapshot.
 */
export class Snapshot {
	#url;
	#say;
	#now;
	#fetch;
	#loading = null;
	#bytes = null;
	#consensus = null;
	given = false;
	times = null;
	/** for tor-js's log line, which names the size */
	byteLength = 0;

	constructor(
		url,
		{
			say = () => {},
			now = Date.now,
			// (called as a function of the global: a method of this object
			// would be an illegal invocation)
			fetch = (...args) => globalThis.fetch(...args),
		} = {},
	) {
		this.#url = url;
		this.#say = say;
		this.#now = now;
		this.#fetch = fetch;
	}

	start() {
		this.#loading ??= this.#load();
		this.#loading.catch(() => {});
		return this.#loading;
	}

	async #load() {
		const started = performance.now();
		try {
			// (revalidated each time: the server's copy changes every hour, and
			// a copy the HTTP cache kept past its valid-until is refused)
			const response = await this.#fetch(this.#url, {
				cache: 'no-cache',
				credentials: 'omit',
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const length = Number(response.headers.get('content-length'));
			if (length > SNAPSHOT_MAX_BYTES)
				throw new Error(`${length} bytes, more than a snapshot`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			this.times = checkSnapshot(bytes, this.#now());
			this.byteLength = bytes.byteLength;
			this.#bytes = bytes;
			this.#say(
				'info',
				`[tor] directory snapshot: ${bytes.byteLength} bytes in ${Math.round(performance.now() - started)} ms, its consensus valid until ${new Date(this.times.validUntil).toISOString()}`,
			);
			return bytes;
		} catch (error) {
			this.#say(
				'warn',
				`[tor] directory snapshot not used (${error?.message ?? error}): the client downloads the directory`,
			);
			throw error;
		}
	}

	/**
	 * Whether a store write is the snapshot's consensus, as tor-js keeps it
	 * (a JSON record whose `content` is the document)
	 */
	isConsensus = (key, value) => {
		if (!this.#bytes || typeof value !== 'string') return false;
		if (this.#consensus === null) {
			const [start, end] = zipMembers(this.#bytes).get(MEMBERS.consensus);
			this.#consensus = new TextDecoder().decode(
				this.#bytes.subarray(start, end),
			);
		}
		try {
			return JSON.parse(value)?.content === this.#consensus;
		} catch {
			return false;
		}
	};

	/** the bytes are arti's now (or not wanted): this copy is let go */
	release() {
		this.#bytes = null;
		this.#consensus = null;
		this.#loading = null;
	}

	then(resolve, reject) {
		return this.start().then((bytes) => {
			this.given = true;
			return resolve(bytes);
		}, reject);
	}
}

/**
 * `store` for one start of the client with a snapshot: every write of a
 * consensus key (`prefix`) is held back from the store once arti has the
 * snapshot, until `accept()` (arti loaded it as a good directory: its
 * signatures checked) writes them in order, or `refuse()` drops them.
 * tor-js writes the snapshot's consensus to the store before arti looks
 * at it, marked as one arti already checked; kept, a consensus arti then
 * refuses (a signature that does not verify) would make every later start
 * fail at its cache load, never download one. The relay check
 * (service.mjs admit) hears of a held consensus only when it is written,
 * so it never admits relays arti has not checked. Certificates and
 * microdescriptors pass: arti checks a certificate at every load, and
 * keys a microdescriptor by its own digest.
 */
export function holdConsensus(store, snapshot, prefix) {
	let held = [];
	let open = false;
	const holding = (key) =>
		!open &&
		snapshot.given &&
		typeof key === 'string' &&
		key.startsWith(prefix);
	return {
		storage: {
			get: (key) => store.get(key),
			getAll: (keyPrefix) => store.getAll(keyPrefix),
			keys: (keyPrefix) => store.keys(keyPrefix),
			set: (key, value) => {
				if (!holding(key)) return store.set(key, value);
				held.push(['set', key, value]);
				return Promise.resolve();
			},
			delete: (key) => {
				if (!holding(key)) return store.delete(key);
				held.push(['delete', key]);
				return Promise.resolve();
			},
			tryLock: () => store.tryLock(),
			unlock: () => store.unlock(),
		},
		get held() {
			return held.length;
		},
		/**
		 * arti took the snapshot: its writes go to the store, in order, but
		 * those `except(key, value)` names
		 */
		accept({ except } = {}) {
			if (open) return Promise.resolve();
			open = true;
			const writes = except
				? held.filter(([op, key, value]) => op !== 'set' || !except(key, value))
				: held;
			held = [];
			// (the first at once: the relay check hears of the consensus as
			// its write starts, before arti's first link to a relay of it)
			const run = (at) => {
				if (at >= writes.length) return Promise.resolve();
				const [op, key, value] = writes[at];
				return Promise.resolve(
					op === 'set' ? store.set(key, value) : store.delete(key),
				).then(() => run(at + 1));
			};
			return run(0);
		},
		/** arti refused it: nothing of its consensus is kept */
		refuse() {
			open = true;
			held = [];
		},
	};
}
