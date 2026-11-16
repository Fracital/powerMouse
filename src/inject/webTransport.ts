// What carries a realm's WebTransport sessions (docs/webtransport.md): in a
// document a deferred part of the bundle (./dom/deferred.ts), which the
// inject's WebTransport module (modules/WebTransport.ts) evaluates when a
// realm's first session starts its handshake, so a frame that never makes a
// session carries none of it; in a worker the worker bundle's own.
// A session is a port to the transport (src/transport/webTransportHost.ts,
// stomp-h3 over a wisp UDP stream); its streams are the page realm's own
// ReadableStream and WritableStream, each chunk read asked for and each one
// written answered once QUIC took it, so a slow reader on either side
// stalls the other as it does natively.
//
// It can be evaluated after the page's scripts ran: everything of the realm
// it uses comes in the context, taken before them.
import type { WebTransportMessage } from '../transport/messages';
import type { CarryClient, Context, Session } from './webTransportLazy';

type Message = WebTransportMessage;
type Controller = {
	enqueue(chunk: unknown): void;
	close(): void;
	error(reason: unknown): void;
	byobRequest?: {
		view: Uint8Array | null;
		respond(written: number): void;
	} | null;
};

// (made with the first session: a deferred part's top level reads no global)
/** a stream's two sides as the page holds them, by the page's object */
let bidirectional: WeakMap<object, [ReadableStream, WritableStream]>;
/** the realms whose WebTransportBidirectionalStream prototype answers from it */
let hooked: WeakSet<object>;

/** what each live session's streams wait for */
interface Stream {
	/** the page's readable's controller */
	readable?: Controller;
	/** the page's writable's controller, and its write or close that waits to be taken */
	writable?: { error(reason: unknown): void };
	taken?: [() => void, (reason: unknown) => void];
	/** the page's createBidirectionalStream or createUnidirectionalStream, until open */
	opened?: [(value: unknown) => void, (reason: unknown) => void, unknown];
}

// what the errors say (measured, docs/webtransport.md): a stream's are
// the peer's reset or stop-sending, with its code; a session's end every
// stream that is still open with the session's own error
const STREAM_RESET = 'Received RESET_STREAM.';
const STREAM_STOPPED = 'Received STOP_SENDING.';
const SESSION_CLOSED = 'The session is closed.';
const CONNECTION_LOST = 'Connection lost.';
const NOT_A_BUFFER =
	"Failed to execute 'write' on 'WritableStreamDefaultWriter': The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.";

/**
 * The transport of the realm's client, or of the document whose requests
 * it routes through: a frame's first window, an about:blank frame or a
 * popup has no service worker of its own yet (its parent's, or its
 * opener's, carries what it does)
 */
async function transportOf({ client, realm }: Context) {
	const clients = [client, client.routedClient()];
	try {
		const opener = realm.opener as Record<string, CarryClient> | null;
		clients.push(opener?.[client.names.client]?.routedClient() ?? null);
	} catch (error) {
		// an opener of another origin: not ours
	}
	let failure: unknown;
	for (const each of clients) {
		if (!each) continue;
		try {
			const { transport } = each.bare;
			await transport.init();
			return transport.rpc;
		} catch (error) {
			failure = error;
		}
	}
	throw failure;
}

export async function carry(ctx: Context, session: Session): Promise<boolean> {
	const { realm, ports, Reflect } = ctx;
	const { Promise, Uint8Array, RangeError, TypeError } = ctx.natives;
	const NativeError = realm.WebTransportError as new (init: {
		message: string;
		streamErrorCode?: number;
	}) => object;
	const [port, theirs] = ports.privateChannel();
	let answer: { result: string; protocol?: string; maxDatagramSize?: number };
	try {
		const rpc = await transportOf(ctx);
		answer = await rpc.call(
			'webtransport',
			{
				url: session.url,
				origin: ctx.origin,
				protocols: session.protocols,
				hashes: session.hashes,
				port: theirs,
			},
			[theirs],
		);
	} catch (error) {
		answer = { result: 'failure' };
	}
	if (session.over || answer.result !== 'success') {
		ports.closePort(port);
		ctx.end(session, 'Opening handshake failed.');
		return false;
	}

	const send = (message: Message, buffer?: ArrayBuffer) =>
		ports.post(port, message, buffer ? [buffer] : []);
	const streams = new Map<number, Stream>();
	let opened = 0;

	const streamError = (message: string, code: number) =>
		ctx.withStack(new NativeError({ message, streamErrorCode: code }));
	/** the WebTransport code a page's reason for a cancel or an abort carries: a WebTransportError's, else 0 */
	const streamCode = Reflect.getOwnPropertyDescriptor(
		NativeError.prototype,
		'streamErrorCode',
	)?.get;
	const codeOf = (reason: unknown) => {
		try {
			const code: unknown = Reflect.apply(streamCode!, reason, []);
			return typeof code === 'number' ? code : 0;
		} catch (error) {
			return 0;
		}
	};

	// ---- a stream's sides ----

	const readable = (id: number) => {
		const state = streams.get(id)!;
		return new realm.ReadableStream({
			type: 'bytes',
			start: (controller: Controller) => {
				state.readable = controller;
			},
			// what arrives is in the stream at once, as natively; a pull
			// says the reader took all of it
			pull: () => send({ t: 'p', id }),
			cancel: (reason: unknown) => {
				state.readable = undefined;
				send({ t: 's', id, code: codeOf(reason) });
			},
		}) as ReadableStream;
	};
	const writable = (id: number) => {
		const state = streams.get(id)!;
		/** a write or a close, answered once the transport took it */
		const taken = (message: Message, buffer?: ArrayBuffer) =>
			new Promise<void>((resolve, reject) => {
				state.taken = [resolve, reject];
				send(message, buffer);
			});
		return new realm.WritableStream(
			{
				start: (controller: { error(reason: unknown): void }) => {
					state.writable = controller;
				},
				write: (chunk: unknown) => {
					// (the browser tells the server nothing: the stream stays open
					// there until the session ends)
					if (!ctx.isBuffer(chunk)) {
						state.writable = undefined;
						throw ctx.withStack(new TypeError(NOT_A_BUFFER));
					}
					const bytes = ctx.copy(chunk as ArrayBuffer);
					return taken(
						{ t: 'w', id, b: bytes.buffer as ArrayBuffer },
						bytes.buffer as ArrayBuffer,
					);
				},
				close: () => taken({ t: 'f', id }),
				abort: (reason: unknown) => {
					state.writable = undefined;
					send({ t: 'r', id, code: codeOf(reason) });
				},
			},
			{ highWaterMark: 1 },
		) as WritableStream;
	};
	/** the page's object for a stream: a WebTransportBidirectionalStream, or the one side a unidirectional one has */
	const pageStream = (id: number, uni: boolean, incoming: boolean) => {
		if (!uni) {
			const made = Reflect.construct(
				realm.Object,
				[],
				realm.WebTransportBidirectionalStream,
			) as object;
			bidirectional.set(made, [readable(id), writable(id)]);
			return made;
		}
		return incoming ? readable(id) : writable(id);
	};

	if (!bidirectional) {
		bidirectional = new WeakMap();
		hooked = new WeakSet();
	}
	const Bidirectional = realm.WebTransportBidirectionalStream;
	if (Bidirectional && !hooked.has(Bidirectional.prototype)) {
		hooked.add(Bidirectional.prototype);
		ctx.hook(Bidirectional.prototype, bidirectional, {
			readable: { get: (sides: [ReadableStream]) => sides[0] },
			writable: { get: (sides: [unknown, WritableStream]) => sides[1] },
		});
	}

	// ---- the session ----

	/** datagrams that arrived while nobody read: the newest `incomingHighWaterMark` (Chrome drops the oldest) */
	const datagrams: Uint8Array[] = [];
	let datagramPull: (() => void) | undefined;
	const deliver = () => {
		const controller = session.controllers[0] as Controller | undefined;
		if (!datagramPull || !controller || !datagrams.length) return;
		const datagram = datagrams.shift()!;
		const request = controller.byobRequest;
		const view = request?.view;
		const pulled = datagramPull;
		datagramPull = undefined;
		if (request && view) {
			if (view.byteLength < datagram.byteLength) {
				controller.error(
					ctx.withStack(new RangeError('supplied view is not large enough.')),
				);
				return pulled();
			}
			view.set(datagram);
			request.respond(datagram.byteLength);
		} else controller.enqueue(datagram);
		pulled();
	};

	/**
	 * The session is over, in Chrome's order (measured): the datagrams' two
	 * streams, the streams' readables, their writables, then `closed`, then
	 * the two streams of incoming streams. A clean end (a close of the
	 * page's, or the server's capsule) fulfills `closed` and ends the
	 * incoming streams as done; a lost connection rejects them all.
	 */
	const over = (
		message: string,
		close?: { closeCode: number; reason: string },
	) => {
		if (session.over) return;
		const error = ctx.sessionError(message);
		const controllers = session.controllers as (Controller | undefined)[];
		controllers[0]?.error(error);
		controllers[1]?.error(error);
		for (const write of session.writes.splice(0)) write[2](error);
		datagramPull?.();
		const all = [...streams.values()];
		streams.clear();
		for (const state of all) state.readable?.error(error);
		for (const state of all) {
			state.writable?.error(error);
			state.taken?.[1](error);
			state.opened?.[1](error);
		}
		if (close) {
			ctx.settle(session.closed, true, close);
			controllers[2]?.close();
			controllers[3]?.close();
		}
		ctx.end(session, message, error);
		ports.closePort(port);
	};

	ports.onPort(port, 'message', (data) => {
		const message = data as Message;
		const state = 'id' in message ? streams.get(message.id) : undefined;
		switch (message.t) {
			case 'n': {
				// a stream the page asked for is open
				const asked = state?.opened;
				if (!state || !asked) return;
				state.opened = undefined;
				asked[0](asked[2]);
				return;
			}
			case 'a': {
				const taken = state?.taken;
				if (!state || !taken) return;
				state.taken = undefined;
				taken[0]();
				return;
			}
			case 'i': {
				// a stream the server opened
				streams.set(message.id, {});
				const made = pageStream(message.id, !!message.uni, true);
				session.controllers[message.uni ? 3 : 2]?.enqueue?.(made);
				return;
			}
			case 'b': {
				const controller = state?.readable;
				if (!state || !controller) return;
				if (message.b) controller.enqueue(new Uint8Array(message.b));
				else {
					state.readable = undefined;
					controller.close();
					controller.byobRequest?.respond(0);
				}
				return;
			}
			case 'e': {
				// (a stream of a session that is gone ends with the session)
				if (!state || message.code === undefined) return;
				const error = streamError(
					message.w ? STREAM_STOPPED : STREAM_RESET,
					message.code,
				);
				if (message.w) {
					state.writable?.error(error);
					state.writable = undefined;
					state.taken?.[1](error);
					state.taken = undefined;
					state.opened?.[1](error);
				} else {
					state.readable?.error(error);
					state.readable = undefined;
				}
				return;
			}
			case 'D': {
				datagrams.push(new Uint8Array(message.b));
				const keep = Math.max(1, Number(session.numbers[3]) || 1);
				if (datagrams.length > keep && !datagramPull)
					datagrams.splice(0, datagrams.length - keep);
				deliver();
				return;
			}
			case 'Z':
				over(SESSION_CLOSED, {
					closeCode: message.code,
					reason: message.reason,
				});
				return;
			case 'L':
				over(CONNECTION_LOST);
				return;
		}
	});
	// the transport is gone (its worker ended): so is the connection
	ports.onPort(port, 'close', () => over(CONNECTION_LOST));

	session.protocol = answer.protocol ?? '';
	// Chrome 155 on reads the connection's own number once it is up; before
	// it, 1024 stays
	if (ctx.modern && answer.maxDatagramSize)
		session.numbers[0] = answer.maxDatagramSize;
	session.live = {
		open: (uni) => {
			const id = ++opened;
			return new Promise((resolve, reject) => {
				streams.set(id, { opened: [resolve, reject, undefined] });
				streams.get(id)!.opened![2] = pageStream(id, uni, false);
				send({ t: 'o', id, ...(uni ? { uni } : {}) });
			});
		},
		close: (code, reason) => {
			// (the transport keeps the reason to the 1024 bytes a close carries)
			send({ t: 'c', code, reason });
			over(SESSION_CLOSED, { closeCode: code, reason });
		},
		datagram: (bytes) => {
			const buffer = bytes.buffer as ArrayBuffer;
			send({ t: 'd', b: buffer }, buffer);
		},
		pull: () =>
			new Promise<void>((resolve) => {
				datagramPull = resolve;
				deliver();
			}),
	};
	// every stream of the session exists from here: what arrives queues in it
	for (const part of [0, 1, 2, 3] as const) ctx.stream(session, part);
	// up: `ready`, then what the page asked of it while it connected
	ctx.settle(session.ready, true, undefined);
	for (const [resolve, , uni] of session.creations.splice(0))
		resolve(session.live.open(uni));
	for (const [bytes, resolve] of session.writes.splice(0)) {
		session.live.datagram(bytes);
		resolve();
	}
	session.pending?.();
	session.pending = undefined;
	return true;
}
