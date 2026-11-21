// When a proxied WebSocket's message has left (its `bufferedAmount`). A
// page's socket counts what it sent until the transport says the frame is
// gone, as Chrome counts it until its network stack wrote it to the socket:
// the WebSocket stand-in (src/inject/bareClient.ts) is told by
// RemoteTransport, which is told by the transport's side (serveTransport.ts,
// one `sent` message per frame, in order) once the transport's `send` has
// settled. epoxy's `EpoxyWebSocket.send` settles once the frame was written
// to its wisp stream and flushed, which it writes in packets within the
// stream's CONTINUE credit: the bytes are then the wisp server's, which
// grants more as it hands them on to the site. The epoxy-transport package
// drops that promise (its `connect` answers a send that settles once epoxy
// was called), so `settledSends` asks epoxy's socket itself.
//
// Each socket's frames go to epoxy one at a time, the next once the one
// before it settled: epoxy writes each behind a futures Mutex, which wakes
// the waiter in its first free slot, and a send polled first takes the lock
// from the one it woke, so frames sent faster than the wisp stream took
// them could leave in another order than the page sent them. One at a time
// costs nothing on the wire (a frame waits for the one before it anyway) and
// a Blob is read in its place in the line.
import type {
	ProxyTransport,
	WebSocketDataType,
} from '@mercuryworkshop/proxy-transports';

/** epoxy's socket, as epoxy-tls's wasm-bindgen glue makes it */
interface EpoxySocket {
	send(data: string | ArrayBuffer): Promise<void>;
	close(code: number, reason: string): Promise<void>;
}
/** what an epoxy-transport instance keeps its client under */
interface EpoxyHolder {
	client?: { connect_websocket?: (...args: unknown[]) => unknown };
}

type Transport = new (...args: any[]) => ProxyTransport;
type Calls = ReturnType<ProxyTransport['connect']>;
type Send = (data: WebSocketDataType) => unknown;

const ignore = () => {};

/**
 * `Transport` with sends that settle when epoxy's own do: its `connect`
 * still opens the socket (its handshake, its handlers), and what the page
 * sends and its close go to epoxy's socket in order, each send answering the
 * promise of epoxy's. A transport that is not epoxy's (no
 * `client.connect_websocket`, or one that answers no socket) is left as it is.
 */
export function settledSends<T extends Transport>(Base: T): T {
	// (ProxyTransport types connect as a property, epoxy's class has a method)
	const Plain = Base as unknown as new (...args: any[]) => {
		connect(...args: Parameters<ProxyTransport['connect']>): Calls;
	};
	return class extends Plain {
		connect(...args: Parameters<ProxyTransport['connect']>): Calls {
			const client = (this as EpoxyHolder).client;
			const open = client?.connect_websocket;
			if (!client || typeof open !== 'function') return super.connect(...args);
			// the socket epoxy-transport's connect asks epoxy for, in its own call
			let opening: unknown;
			const own = Object.getOwnPropertyDescriptor(client, 'connect_websocket');
			client.connect_websocket = function (this: unknown, ...given) {
				return (opening = Reflect.apply(open, this, given));
			};
			let calls: Calls;
			try {
				calls = super.connect(...args);
			} finally {
				if (own) Object.defineProperty(client, 'connect_websocket', own);
				else delete client.connect_websocket;
			}
			if (typeof (opening as Promise<unknown> | undefined)?.then !== 'function')
				return calls;
			const socket = opening as Promise<EpoxySocket>;
			// (a socket that never opened: the page's error event says so, and
			// its sends never settle, as nothing left)
			socket.catch(ignore);
			let line: Promise<unknown> = socket;
			const next = <R>(step: (ws: EpoxySocket) => Promise<R>): Promise<R> => {
				const settled = line.then(() => socket).then(step);
				line = settled.catch(ignore);
				return settled;
			};
			return [
				(data) =>
					next(async (ws) =>
						ws.send(data instanceof Blob ? await data.arrayBuffer() : data),
					),
				(code, reason) => {
					next((ws) => ws.close(code, reason || '')).catch(ignore);
				},
			];
		}
	} as unknown as T;
}

/**
 * The serving side of a socket's port: `send` (a transport's) called for each
 * frame as it comes, and `sent` told once per frame, in the order they came,
 * when the transport's send settled (at once for a transport whose send
 * answers nothing). A send that fails is told too: the socket's error or
 * close follows it.
 */
export function acknowledgedSends(send: Send, sent: () => void): Send {
	let told: Promise<unknown> = Promise.resolve();
	return (data) => {
		let settled: Promise<unknown>;
		try {
			settled = Promise.resolve(send(data)).catch(ignore);
		} catch {
			settled = told;
		}
		told = Promise.all([told, settled]).then(sent);
		return undefined;
	};
}
