// Where a bundle has what a Worker or SharedWorker construction does once
// the page's script passed its checks (./workerStart.ts): the document
// bundle's is a deferred part (./dom/deferred.ts), evaluated with a
// document's first worker, and the worker bundle's is its own. Each
// bundle's entry says which (dom/document.ts, worker/entry.ts).
import type * as workerStart from './workerStart';

export const workerStartParts: {
	start?: () => WorkerStartPart;
} = {};

/** the part's functions, as one */
export type WorkerStartPart = Pick<
	typeof workerStart,
	'workerURL' | 'releaseOnLoad' | 'watchErrors'
>;
