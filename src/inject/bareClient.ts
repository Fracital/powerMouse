// The Bare-compatible client a realm opens its WebSockets (and carries its
// WebTransport sessions) with, over the controller's transport. Most
// documents open none: this file, the transport and the client library are
// deferred parts of the document bundles (src/inject/dom/deferredParts.ts,
// build.js DEFERRED_FILES), about 6 KB of each, evaluated at a document's
// first WebSocket. A worker's bundle carries them itself.
import { BareCompatibleClient } from '@mercuryworkshop/proxy-transports';
import RemoteTransport from '../transport/RemoteTransport';

export function bareClient(
	port: MessagePort | Promise<MessagePort>,
): BareCompatibleClient {
	return new BareCompatibleClient(new RemoteTransport(port));
}
