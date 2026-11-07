import type { ProxyTransport, RawHeaders, TransferrableResponse, WebSocketDataType } from '@mercuryworkshop/proxy-transports';
/**
 * A ProxyTransport whose implementation lives on the other end of a MessagePort.
 * The other end is served by `serveTransport()`.
 */
export default class RemoteTransport implements ProxyTransport {
    ready: boolean;
    private readyPromise;
    private readyResolve;
    private rpc;
    private port;
    constructor(port: MessagePort | Promise<MessagePort>);
    /** fail every pending and later call with `reason` and close the port (the host side replaced it) */
    close(reason: string): void;
    init(): Promise<void>;
    request(remote: URL, method: string, body: BodyInit | null, headers: RawHeaders, _signal: AbortSignal | undefined): Promise<TransferrableResponse>;
    connect(url: URL, protocols: string[], requestHeaders: RawHeaders, onopen: (protocol: string, extensions: string) => void, onmessage: (data: WebSocketDataType) => void, onclose: (code: number, reason: string) => void, onerror: (error: string) => void): [
        (data: WebSocketDataType) => void,
        (code: number, reason: string) => void
    ];
}
