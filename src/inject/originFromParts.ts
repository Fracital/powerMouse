// Where a bundle has what Origin.from() answers a page (./originFrom.ts):
// the document bundle's is a deferred part (./dom/deferred.ts), evaluated
// at a realm's first call, and the worker bundle's is its own. Each
// bundle's entry says which (dom/document.ts, worker/entry.ts).
import type { originFrom } from './originFrom';

export const originFromParts: {
	answer?: () => typeof originFrom;
} = {};
