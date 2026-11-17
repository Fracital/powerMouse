// What an IndexedDB database takes in Chrome's quota (./idbSize.ts has how
// it was measured): its figures, and where a bundle has the sizing of a
// record. The document bundle's is a deferred part (./dom/deferred.ts),
// evaluated with a realm's first navigator.storage.estimate(), and the
// worker bundle's is its own. Each bundle's entry says which
// (dom/document.ts, worker/entry.ts).
import type { recordSize } from './idbSize';

export const DATABASE_BYTES = 592;
export const STORE_BYTES = 352;
export const RECORD_BYTES = 210;

export const idbSizeParts: {
	recordSize?: () => typeof recordSize;
} = {};
