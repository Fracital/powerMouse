// Where a bundle has what a page's Cache API calls do past their hooks'
// checks (./cacheCalls.ts): the document bundle's is a deferred part
// (./dom/deferred.ts), evaluated at a realm's first add(), addAll() or
// caches.match(), and the worker bundle's is its own. Each bundle's entry
// says which (dom/document.ts, worker/entry.ts).
import type { cacheCalls } from './cacheCalls';

export const cacheCallParts: {
	calls?: () => typeof cacheCalls;
} = {};
