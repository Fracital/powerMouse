// Where a bundle has the WebTransport stand-in (./webTransportStandIn.ts)
// and what carries its sessions (./webTransport.ts): the document bundle's
// are deferred parts (./dom/deferred.ts), evaluated with a realm's first
// session, and the worker bundle's are its own. Each bundle's entry says
// which (dom/document.ts, worker/entry.ts).
import type { carry } from './webTransport';
import type { standIn } from './webTransportStandIn';

export const webTransportParts: {
	standIn?: () => typeof standIn;
	carry?: () => typeof carry;
} = {};
