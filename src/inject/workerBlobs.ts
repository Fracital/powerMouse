import { LazyMap } from './ownCollections';

// The Blob behind each blob: URL this realm minted (the browser's form), as
// the URL registry holds it: recorded by createObjectURL, dropped by
// revokeObjectURL. The browser resolves a worker's blob: URL when the
// Worker is constructed, so a page may revoke it right after
// `new Worker(url)`. The proxy starts a blob: worker from a bootstrap of its
// own that imports the page's script a moment later, inside the worker: it
// imports a private URL of the same Blob instead (WorkerModule), and the
// page's revoke stays native and immediate.
//
// Each Blob is kept by the realm that minted its URL (its ObjectURL module's
// table), as the browser's registry drops a document's URLs when the
// document goes: an about:blank or srcdoc frame runs its creator's bundle,
// so the URLs it minted are recorded here too, and a Blob of the frame's
// realm held here kept the frame's whole realm for the page's life (an
// object keeps the realm that made it). Here each URL names its minter's
// table weakly, by a WeakRef of the bundle's own.
const NativeWeakRef = WeakRef;
const weakDeref = WeakRef.prototype.deref;
type BlobTable = LazyMap<string, Blob>;
const minters = new LazyMap<string, WeakRef<BlobTable>>();
// URLs recorded since the entries of gone minters were last dropped
let recorded = 0;

const tableOf = (ref: WeakRef<BlobTable>) =>
	Reflect.apply(weakDeref, ref, []) as BlobTable | undefined;

/** a realm's own table of the Blobs behind the URLs it minted, for `recordBlob` */
export function blobTable(): BlobTable {
	return new LazyMap<string, Blob>();
}

/** `url` was minted for `blob` by the realm whose table `minter` is */
export function recordBlob(url: string, blob: Blob, minter: BlobTable) {
	minter.set(url, blob);
	minters.set(url, new NativeWeakRef(minter));
	if (++recorded < 256) return;
	recorded = 0;
	for (const [key, ref] of minters.entries())
		if (!tableOf(ref)) minters.delete(key);
}

/** the Blob behind `url` (the browser's form), while its minter lives and it is not revoked */
export function blobOf(url: string): Blob | undefined {
	const ref = minters.get(url);
	return ref && tableOf(ref)?.get(url);
}

/** `url` was revoked */
export function forgetBlob(url: string) {
	const ref = minters.get(url);
	if (!ref) return;
	minters.delete(url);
	tableOf(ref)?.delete(url);
}

/** what a worker's bootstrap posts once it has imported its private URL (released then) */
export const WORKER_LOADED = '$stomp$workerLoaded';

/** how long a private URL is kept for a worker that never said it took it (its script threw first) */
export const PRIVATE_URL_MS = 60000;

/** whether `value` is a Blob (or File) of any realm */
export function isBlob(value: unknown): value is Blob {
	const tag = Object.prototype.toString.call(value);
	return tag === '[object Blob]' || tag === '[object File]';
}
