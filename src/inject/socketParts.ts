// Where a bundle has what the WebSocket and WebSocketStream stand-ins do
// once a page constructs one (./bareClient.ts socketStandIns): the
// document bundle's is a deferred part (./dom/deferred.ts), evaluated with
// the client a document opens its first WebSocket with, and the worker
// bundle's is its own. Each bundle's entry says which (dom/document.ts,
// worker/entry.ts).
import type { socketStandIns } from './bareClient';

export const socketParts: {
	standIns?: () => typeof socketStandIns;
} = {};
