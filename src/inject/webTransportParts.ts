// Where a bundle has what carries WebTransport sessions (../webTransport.ts):
// the document bundle's is one of its deferred parts (./dom/deferred.ts),
// evaluated with a realm's first session, and the worker bundle's is its
// own. Each bundle's entry says which (dom/document.ts, worker/entry.ts).
import type { carry } from './webTransport';

export const webTransportParts: { carry?: () => typeof carry } = {};
