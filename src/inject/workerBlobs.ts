// The Blob behind each blob: URL this realm minted (the browser's form), as
// the URL registry holds it: recorded by createObjectURL, dropped by
// revokeObjectURL. The browser resolves a worker's blob: URL when the
// Worker is constructed, so a page may revoke it right after
// `new Worker(url)`. The proxy starts a blob: worker from a bootstrap of its
// own that imports the page's script a moment later, inside the worker: it
// imports a private URL of the same Blob instead (WorkerModule), and the
// page's revoke stays native and immediate.
export const blobsByURL = new Map<string, Blob>();

/** what a worker's bootstrap posts once it has imported its private URL (released then) */
export const WORKER_LOADED = '$stomp$workerLoaded';

/** how long a private URL is kept for a worker that never said it took it (its script threw first) */
export const PRIVATE_URL_MS = 60000;

/** whether `value` is a Blob (or File) of any realm */
export function isBlob(value: unknown): value is Blob {
	const tag = Object.prototype.toString.call(value);
	return tag === '[object Blob]' || tag === '[object File]';
}
