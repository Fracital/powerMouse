import type { ProxyTransport, RawHeaders } from '@mercuryworkshop/proxy-transports';
/** the headers a WebSocket handshake goes out with, given the page's */
export type DecorateHandshake = (url: URL, headers: RawHeaders) => Promise<RawHeaders>;
/**
 * Serve a ProxyTransport to a `RemoteTransport` on the other end of `port`.
 * `getTransport` is a getter so the host can hot-swap transports. `decorate`
 * may add headers to a WebSocket handshake (the controller adds the cookie
 * jar's Cookie, HttpOnly included, which the page must never hold); a
 * Cookie the page sent itself is dropped first, and a hook that fails or
 * stalls leaves the handshake as it was.
 * Returns a function that closes the port.
 */
export default function serveTransport(port: MessagePort, getTransport: () => ProxyTransport, decorate?: DecorateHandshake): () => void;
