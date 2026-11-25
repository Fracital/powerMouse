// The Tor client's kept state (docs/tor-over-wisp.md "Guard persistence"
// and "Bootstrap from the kept state"): tor-js's TorStorage in IndexedDB,
// arti's guards under `state:` keys and its directory under `dir:` keys,
// read back by the next client so a later visit loads the directory
// instead of downloading it, as tor does from its data directory.

export const CONSENSUS_KEYS = 'dir:consensus:';

/** the smallest string after every string that starts with `prefix` */
function pastPrefix(prefix) {
	const last = prefix.charCodeAt(prefix.length - 1);
	return last < 0xffff
		? `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`
		: null;
}

/**
 * tor-js's IndexedDBStorage with `keys(prefix)` and `getAll(prefix)` read
 * by a key range. Its own read every key and value of the store and keep
 * the prefix's: a client's start asks for its two `state:` values and got
 * them by reading the whole directory too (a consensus and some 9,500
 * microdescriptors, 8 MB, 120 ms in Chrome), and the relay check's read of
 * the consensus did the same. A storage that is not tor-js's (no `getDB`)
 * is used as it is.
 */
export function rangedStorage(inner) {
	if (
		typeof inner?.getDB !== 'function' ||
		typeof inner.storeName !== 'string' ||
		typeof IDBKeyRange !== 'function'
	)
		return inner;
	const range = (prefix) => {
		if (!prefix) return undefined;
		const past = pastPrefix(prefix);
		return past === null
			? IDBKeyRange.lowerBound(prefix)
			: IDBKeyRange.bound(prefix, past, false, true);
	};
	const read = async (prefix, withValues) => {
		const db = await inner.getDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(inner.storeName, 'readonly');
			const store = tx.objectStore(inner.storeName);
			const keys = store.getAllKeys(range(prefix));
			const values = withValues ? store.getAll(range(prefix)) : null;
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
			tx.oncomplete = () => {
				const out = [];
				keys.result.forEach((key, at) => {
					if (typeof key === 'string' && key.startsWith(prefix))
						out.push(withValues ? [key, values.result[at]] : key);
				});
				resolve(out);
			};
		});
	};
	return {
		get: (key) => inner.get(key),
		set: (key, value) => inner.set(key, value),
		delete: (key) => inner.delete(key),
		keys: (prefix = '') => read(prefix, false),
		getAll: (prefix = '') => read(prefix, true),
	};
}

/**
 * The times of a consensus as tor-js keeps it (a JSON record that starts
 * with `valid_after_secs`, `fresh_until_secs` and `valid_until_secs`, then
 * the signed document as `content`), in ms; null where they do not read
 */
export function consensusTimes(value) {
	if (typeof value !== 'string') return null;
	const head = value.slice(0, 400);
	const at = (name) => {
		const match = new RegExp(`"${name}_secs":(\\d+)`).exec(head);
		return match ? Number(match[1]) * 1000 : null;
	};
	const validUntil = at('valid_until');
	if (validUntil === null) return null;
	return {
		validAfter: at('valid_after'),
		freshUntil: at('fresh_until'),
		validUntil,
	};
}

/**
 * The kept state as the client may use it: a kept consensus only until
 * its valid-until. arti reads a cached one's times from the signed
 * document, and its tolerance for clocks that are off (DirTolerance) can
 * take one after its valid-until, building paths over relays the network
 * may have dropped since; a later visit instead downloads a new consensus
 * and keeps the rest (the microdescriptors it names are checked against
 * it by digest, the authorities' certificates by their own expiry, the
 * guards by arti's guard rules). Between fresh-until and valid-until arti uses the kept one
 * and fetches the next, as tor does. One whose valid-until does not read
 * is not used either (left in place: its format is not this code's to
 * judge); an expired one is deleted.
 *
 * `consensus(value, times, newest)` hears each consensus the client reads
 * back or keeps (`newest` true for one arti keeps: the newest it has),
 * `times` null where they do not read, for the relay check (service.mjs
 * admit).
 */
export function liveDirectory(store, { now = Date.now, consensus } = {}) {
	const expired = new Set();
	const usable = (key, value) => {
		if (typeof key !== 'string' || !key.startsWith(CONSENSUS_KEYS)) return true;
		const times = consensusTimes(value);
		if (times && now() < times.validUntil) {
			consensus?.(value, times);
			return true;
		}
		if (times && !expired.has(key)) {
			expired.add(key);
			store.delete(key).catch(() => {});
		}
		return false;
	};
	return {
		get: async (key) => {
			const value = await store.get(key);
			return value === null || value === undefined || usable(key, value)
				? value
				: null;
		},
		getAll: async (prefix) =>
			(await store.getAll(prefix)).filter(([key, value]) => usable(key, value)),
		keys: async (prefix) =>
			(await store.keys(prefix)).filter((key) => !expired.has(key)),
		set: async (key, value) => {
			if (key.startsWith(CONSENSUS_KEYS)) {
				expired.delete(key);
				consensus?.(value, consensusTimes(value), true);
			}
			return store.set(key, value);
		},
		delete: (key) => store.delete(key),
		tryLock: () => store.tryLock(),
		unlock: () => store.unlock(),
	};
}
