// Where epoxy's `ech_dns` answers (a name's ECH config list from its HTTPS
// record, or that it has none) are kept across a reload and between tabs:
// IndexedDB of the host's origin (`stomp-ech`), handed to EpoxyTransport as
// its `ech_cache` (deploy/epoxy, epoxy-transport 0060). Each answer is kept
// by the network partition that asked and the name, as Chrome 157's host
// cache keeps it (a name asked again for each top-level site and for a frame
// cross-site to its top), until its TTL ran out, and never past that: epoxy
// gives each entry the time it goes stale, a stale one is never given back,
// and it is deleted the next time the store is read. Without this every
// reload asked the DoH server again for the first site's record before its
// TLS handshake, a round trip through the relay.
//
// Chrome empties its host cache when the network changes; so does this
// store (`online`, a `navigator.connection` change). A transport whose
// module takes no `ech_cache` (another build, another transport) ignores it.

/** what epoxy-transport's EchCache keeps (its EchCacheEntry) */
export interface EchCacheEntry {
	key: string;
	ech: Uint8Array | null;
	until: number;
}

/** what epoxy-transport's `ech_cache` option takes */
export interface EchCache {
	load(): Promise<EchCacheEntry[]>;
	put(entry: EchCacheEntry): void;
}

const DB = 'stomp-ech';
const STORE = 'answers';
/** the most kept, the ones that go stale soonest dropped past it (Chrome's host cache keeps 1000) */
export const ECH_KEPT = 1000;

let opened: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
	return (opened ??= new Promise<IDBDatabase | null>((resolve) => {
		try {
			const request = indexedDB.open(DB, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	}));
}

/** settles when `request` does (undefined on an error) */
const settled = <T>(request: IDBRequest<T>): Promise<T | undefined> =>
	new Promise((resolve) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(undefined);
	});

/** what is kept and fresh; the stale entries, and the soonest past ECH_KEPT, are deleted */
async function load(): Promise<EchCacheEntry[]> {
	const database = await db();
	if (!database) return [];
	try {
		const store = database.transaction(STORE, 'readwrite').objectStore(STORE);
		const [keys, values] = await Promise.all([
			settled(store.getAllKeys()),
			settled(store.getAll()),
		]);
		if (!keys || !values) return [];
		const now = Date.now();
		const fresh: EchCacheEntry[] = [];
		keys.forEach((key, at) => {
			const value = values[at] as { ech?: unknown; until?: unknown };
			const ech = value?.ech;
			if (
				typeof key !== 'string' ||
				typeof value?.until !== 'number' ||
				!(ech === null || ech instanceof Uint8Array) ||
				value.until <= now
			) {
				store.delete(key);
				return;
			}
			fresh.push({ key, ech, until: value.until });
		});
		if (fresh.length > ECH_KEPT) {
			fresh.sort((a, b) => b.until - a.until);
			for (const { key } of fresh.splice(ECH_KEPT)) store.delete(key);
		}
		return fresh;
	} catch {
		return [];
	}
}

function put({ key, ech, until }: EchCacheEntry) {
	if (!(until > Date.now())) return;
	void db().then((database) => {
		try {
			database
				?.transaction(STORE, 'readwrite')
				.objectStore(STORE)
				.put({ ech: ech ? new Uint8Array(ech) : null, until }, key);
		} catch {
			// not kept: the next realm asks again
		}
	});
}

/** every kept answer forgotten (the network changed) */
function clear() {
	void db().then((database) => {
		try {
			database?.transaction(STORE, 'readwrite').objectStore(STORE).clear();
		} catch {
			// nothing kept to clear
		}
	});
}

let watching = false;

/** this realm's store, for EpoxyTransport's `ech_cache` */
export function echCache(): EchCache {
	if (!watching) {
		watching = true;
		globalThis.addEventListener?.('online', clear);
		(
			globalThis.navigator as Navigator & { connection?: EventTarget }
		)?.connection?.addEventListener?.('change', clear);
	}
	return { load, put };
}

/**
 * The descriptor's options with `ech_cache` added to the first, when it
 * asks for `ech_dns` and names no cache of its own (a descriptor crosses to
 * the transport worker as data, so the store is added where the transport
 * is made)
 */
export function withEchCache(options: unknown[]): unknown[] {
	const [first, ...rest] = options;
	const own = first as { ech_dns?: unknown; ech_cache?: unknown } | undefined;
	if (typeof own?.ech_dns !== 'string' || own.ech_cache !== undefined)
		return options;
	if (typeof indexedDB === 'undefined') return options;
	return [{ ...own, ech_cache: echCache() }, ...rest];
}
