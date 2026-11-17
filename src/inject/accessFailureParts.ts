// Where a bundle has the wording of the access API's errors
// (./accessFailures.ts): the document bundle's is a deferred part
// (./dom/deferred.ts), evaluated with a document's first such error, and
// the worker bundle's is its own. Each bundle's entry says which
// (dom/document.ts, worker/entry.ts).
import type { accessFailures } from './accessFailures';

export const accessFailureParts: {
	failures?: () => typeof accessFailures;
} = {};
