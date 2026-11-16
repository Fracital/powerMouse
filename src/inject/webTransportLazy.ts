// What the inject's WebTransport module (modules/WebTransport.ts) hands the
// library that carries its sessions (webTransport.ts, the asset
// `webTransport`): the library is loaded the first time a realm's session
// starts its handshake, not with the bundle, so a realm that never makes a
// session carries none of it.

export type Settle = (value?: unknown) => void;
/**
 * `ready` or `closed`: a promise made when the page first reads it, as the
 * browser makes its own (one nobody read is never an unhandled rejection)
 */
export interface Property {
	promise?: Promise<unknown>;
	settle?: [Settle, Settle];
	done?: [fulfilled: boolean, value: unknown];
}

/** what a live session's members do (the library's) */
export interface Live {
	open(uni: boolean): Promise<unknown>;
	close(code: number, reason: string): void;
	datagram(bytes: Uint8Array): void;
	/** the page reads `datagrams.readable` */
	pull(): Promise<void>;
}

export interface Session {
	/** it connects no more: it failed, was closed, or the page's policy refused it */
	over: boolean;
	/** what it ended with, which its streams end with too (a refused one's streams stay as they were) */
	error?: unknown;
	ready: Property;
	closed: Property;
	/** the page's createBidirectionalStream and createUnidirectionalStream calls a session keeps while it connects (Chrome 155 on): settle, refuse, unidirectional */
	creations: [Settle, Settle, boolean][];
	datagrams?: object;
	streams: (ReadableStream | WritableStream | undefined)[];
	controllers: (
		| {
				error(reason: unknown): void;
				enqueue?(chunk: unknown): void;
				desiredSize?: number | null;
		  }
		| undefined
	)[];
	/** datagrams the page wrote that wait for the session: their bytes, settle, refuse */
	writes: [Uint8Array, Settle, Settle][];
	/** maxDatagramSize, then the ages and the buffer sizes the page set, as `Duplex` numbers them */
	numbers: (number | null)[];
	/** what the handshake asks for */
	url: string;
	protocols: string[];
	/** the page's own headers (Chrome 157 on) as they go out: checked, lower case, sorted by name */
	headers: [string, string][];
	hashes: ArrayBuffer[];
	/** the server's answer, once up */
	protocol?: string;
	live?: Live;
	/** a read of `datagrams.readable` that came before the session was up */
	pending?: () => void;
}

/** what the library asks of a realm's client */
export interface CarryClient {
	bare: {
		transport: {
			init(): Promise<void>;
			rpc: {
				call(
					method: string,
					args: unknown,
					transfer: Transferable[],
				): Promise<any>;
			};
		};
	};
	routedClient(): CarryClient | null;
	names: { client: string };
}

/** the library's context: one per realm, made with the realm's first session */
export interface Context {
	realm: Record<string, any>;
	/** this realm's client (src/inject/Client.ts), whose transport carries the session */
	client: CarryClient;
	/** the page's real origin */
	origin: string;
	ports: {
		privateChannel: () => [MessagePort, MessagePort];
		onPort: (
			port: MessagePort,
			type: 'message' | 'close',
			listener: (data: unknown) => void,
		) => void;
		post: (
			port: MessagePort,
			message: unknown,
			transfer?: Transferable[],
		) => void;
		closePort: (port: MessagePort) => void;
	};
	/** end a session as Chrome's WebTransport::Cleanup does, with a session error of `message` */
	end: (session: Session, message: string, error?: object) => void;
	settle: (property: Property, fulfilled: boolean, value: unknown) => void;
	/** the realm's own, taken when its first session was made */
	natives: {
		Promise: PromiseConstructor;
		Uint8Array: Uint8ArrayConstructor;
		RangeError: RangeErrorConstructor;
		TypeError: TypeErrorConstructor;
	};
	/** an ArrayBuffer or a view of any realm, and its bytes copied now */
	isBuffer: (value: unknown) => boolean;
	copy: (value: ArrayBuffer | ArrayBufferView) => Uint8Array;
	/** a WebTransportError whose `source` reads 'session' */
	sessionError: (message: string) => object;
	withStack: <T extends object>(error: T) => T;
	/** a browser function wrapped to answer for the objects of `table` */
	hook: (
		prototype: object,
		table: WeakMap<object, any>,
		impl: Record<string, Partial<Record<'get' | 'set' | 'value', Function>>>,
	) => void;
	/** one of a session's own streams (datagrams in and out, the server's streams), made now if it was not */
	stream: (session: Session, part: 0 | 1 | 2 | 3) => unknown;
	/** the browser's version: 155 on keeps streams asked for while connecting */
	modern: boolean;
	Reflect: typeof Reflect;
}
