// Where a bundle has the methods behind navigator.storageBuckets' hooks
// (./storageBucketMethods.ts): the document bundle's are a deferred part
// (./dom/deferredParts.ts), the worker bundle's are its own. Each bundle's
// entry says which (dom/document.ts, worker/entry.ts).
import type { bucketMethods } from './storageBucketMethods';

export const storageBucketParts: {
	methods?: () => typeof bucketMethods;
} = {};
