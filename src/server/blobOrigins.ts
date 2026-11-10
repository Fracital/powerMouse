// The real origin of a client whose own URL names none: each blob: URL a
// proxied document minted, as the service worker verified it (the minting
// document's routed URL, decoded), and each inline document the worker
// served (`inline:<token>/...`, whose route names the document's referrer,
// not the document). A blob: worker's or an inline document's requests are
// judged by this origin.
//
// An entry outlives revocation: pages revoke right after `new Worker()`,
// and the worker's requests come later, which would then be judged as
// their target's own again (with its SameSite=Strict cookies). A blob:
// URL's entry goes when the document that minted it is gone (its dedicated
// workers went with it), an inline document's after a day, checked at most
// once a minute, and the oldest go first past KEPT.
//
// Entries are kept in IndexedDB too: Chrome stops an idle service worker,
// which empties its memory, while the blob: workers and inline documents
// live on. Their requests would then come from a client of no known origin,
// which the same-origin policy has to judge as an opaque one (every CORS
// request of a blob: worker to its own site refused).
import { IDBPDatabase, openDB } from 'idb';

declare const self: ServiceWorkerGlobalScope;

const KEPT = 1024;
const PRUNE_EVERY_MS = 60000;
/** how long an inline document's entry is kept (it has no minter to outlive) */
const INLINE_KEPT_MS = 24 * 60 * 60 * 1000;
interface Entry {
	origin: string;
	/** the client that minted a blob: URL; '' for an inline document */
	minter: string;
	at: number;
}
const origins = new Map<string, Entry>();
let pruned = 0;

let database: Promise<IDBPDatabase> | null = null;
function store(): Promise<IDBPDatabase> {
	database ??= openDB('stompClientOrigins', 1, {
		upgrade(db) {
			db.createObjectStore('origins');
		},
	});
	return database;
}

async function prune() {
	pruned = Date.now();
	let live: Set<string>;
	try {
		live = new Set(
			(
				await self.clients.matchAll({ includeUncontrolled: true, type: 'all' })
			).map((client) => client.id),
		);
	} catch (error) {
		return;
	}
	const gone = ({ minter, at }: Entry) =>
		minter ? !live.has(minter) : Date.now() - at > INLINE_KEPT_MS;
	for (const [url, entry] of origins) if (gone(entry)) origins.delete(url);
	try {
		const db = await store();
		const tx = db.transaction('origins', 'readwrite');
		let cursor = await tx.store.openCursor();
		let count = 0;
		while (cursor) {
			count++;
			if (gone(cursor.value as Entry)) await cursor.delete();
			cursor = await cursor.continue();
		}
		await tx.done;
		if (count > KEPT) {
			const keys = await db.getAllKeys('origins', null, count - KEPT);
			for (const key of keys) await db.delete('origins', key);
		}
	} catch (error) {
		// no store: memory only
	}
}

function record(url: string, entry: Entry) {
	origins.delete(url);
	origins.set(url, entry);
	if (origins.size > KEPT) origins.delete(origins.keys().next().value!);
	store()
		.then((db) => db.put('origins', entry, url))
		.catch(() => {});
	if (Date.now() - pruned > PRUNE_EVERY_MS) void prune();
}

/** record a blob: URL minted by the client `minter`, of real origin `origin` */
export function recordBlobOrigin(url: string, origin: string, minter: string) {
	record(url, { origin, minter, at: Date.now() });
}

/** record the URL an inline document is served at, of real origin `origin` */
export function recordInlineOrigin(url: string, origin: string) {
	record(url.split('#')[0], { origin, minter: '', at: Date.now() });
}

/**
 * The real origin of a client URL (a blob: URL, an inline document's
 * route), as a URL, when it is known: from memory, else from the store
 */
export async function knownOriginOf(url: string): Promise<URL | null> {
	// a client's URL may carry a fragment the blob: URL did not
	const key = url.split('#')[0];
	let entry = origins.get(key);
	if (!entry)
		try {
			entry = (await (await store()).get('origins', key)) as Entry | undefined;
			if (entry) origins.set(key, entry);
		} catch (error) {
			// no store: unknown
		}
	if (!entry) return null;
	// an opaque origin (a data: document's): a URL whose origin is "null"
	return entry.origin === 'null' ? new URL('data:,') : new URL(entry.origin);
}
