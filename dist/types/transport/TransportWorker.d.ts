import { TransportModule } from './messages';
import type { DecorateHandshake } from './serveTransport';
/**
 * The controller's handle on its transport worker (dist/transportWorker.js,
 * src/transport/worker.ts): a dedicated Worker that imports and constructs
 * the transport and serves it on every port handed over. `decorate` answers
 * the worker's handshake-header requests (the cookie jar stays with the
 * controller).
 */
export default class TransportWorker {
    #private;
    constructor(url: URL, decorate: DecorateHandshake);
    /**
     * Import the module and construct the transport in the worker. Rejects
     * when the worker cannot start, the module cannot be imported there, the
     * constructor throws, or nothing answers within BOOT_TIMEOUT_MS.
     */
    init(descriptor: TransportModule): Promise<void>;
    /** replace the transport; in-flight requests finish on the old one */
    setTransport(descriptor: TransportModule): Promise<void>;
    /** hand the worker a port to serve the transport on (the other end holds a RemoteTransport) */
    servePort(port: MessagePort): void;
    /** a new port the worker serves, for a RemoteTransport on this side */
    serve(): MessagePort;
    terminate(): void;
}
