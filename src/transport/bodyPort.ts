// A response body crosses from the transport (its worker, or the host page)
// to the service worker or a page on a MessagePort of its own, pushed as it
// arrives, instead of as a transferred ReadableStream.
//
// A transferred stream moves one chunk per round trip: the receiving side
// asks for the next chunk only once the last one reached its reader, so a
// body costs as many round trips between the two threads as it has chunks.
// epoxy hands out 16 KiB chunks (Discord's 12 MB bundle is about 800 of
// them), and while a page fans out hundreds of requests the service worker's
// task queue is long: each round trip waited behind the other requests'
// tasks, and the bundle took 1.4 s to read where the transport had all of it
// in 0.4 s.
//
// Here the sender reads the body as fast as the transport gives it, sends
// what arrived within one task as one message (the chunks' buffers
// transferred, not copied, nor joined into a new buffer, which would be one
// more body's worth of garbage in the renderer's worker) and keeps up to
// BODY_WINDOW bytes in flight; the receiver grants more as its reader takes
// them, so a reader that stops still stops the transport, and a cancelled
// stream cancels the transport's body.

import { postToPort } from './messages';
import { closePort, onPort, privateChannel } from './ports';

/** bytes sent that the receiving reader has not taken yet, at most */
export const BODY_WINDOW = 4 * 1024 * 1024;

/**
 * What the readers of the bodies this realm sent took, and when they last
 * took any (their credit): a carrier host's rider hands epoxy the wire's
 * packets at their pace (carrierClient.ts), and `waiters` hear each take
 */
export const bodiesTaken = {
	bytes: 0,
	at: -Infinity,
	waiters: new Set<() => void>(),
};
/** the most one message carries */
const MESSAGE_MAX = 1024 * 1024;

/** sender to receiver */
type BodyMessage =
	| { type: 'data'; data: Uint8Array | Uint8Array[] }
	| { type: 'end'; encoded?: number }
	| { type: 'error'; error: unknown };

/** receiver to sender */
type BodyControl =
	{ type: 'credit'; bytes: number } | { type: 'cancel'; reason: string };

/** a body on its way: the receiving end's port */
export interface PortBody {
	$stompBodyPort: MessagePort;
}

// not `instanceof MessagePort`: in a proxied page the global is the page's
export function isPortBody(value: unknown): value is PortBody {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as PortBody).$stompBodyPort === 'object' &&
		(value as PortBody).$stompBodyPort !== null
	);
}

/** a chunk that owns its whole buffer is transferred as it is */
function ownsBuffer(chunk: Uint8Array): boolean {
	return (
		chunk.buffer instanceof ArrayBuffer &&
		chunk.byteOffset === 0 &&
		chunk.byteLength === chunk.buffer.byteLength
	);
}

/**
 * the sending end: reads `body` and pushes it to the port it returns.
 * `encoded`: the transport's count of the bytes the body came as before it
 * was decoded (responseFacts.ts), sent with the body's end.
 * `owned`: no one else holds the stream's chunks (the transport's, a
 * response the proxy fetched), so their buffers are transferred; a page's
 * own stream (a response its service worker made, or one it may have
 * cloned, whose twin shares the chunks) is copied, as the browser copies
 * what it reads from it, so the page's buffers are never detached
 */
export function sendBody(
	body: ReadableStream<Uint8Array>,
	owned: boolean,
	encoded?: (() => number | undefined) | null,
): PortBody {
	// the browser's own channel, listened to with its own methods: in a
	// page's realm the page may have replaced them (src/transport/ports.ts)
	const [port, port2] = privateChannel();
	const reader = body.getReader();
	let credit = BODY_WINDOW;
	let stopped = false;
	let wake: (() => void) | null = null;
	const resume = () => {
		const resolve = wake;
		wake = null;
		resolve?.();
	};

	onPort(port, 'message', (message) => {
		const data = message as BodyControl;
		if (data.type === 'credit') {
			credit += data.bytes;
			bodiesTaken.bytes += data.bytes;
			bodiesTaken.at = performance.now();
			for (const waiter of [...bodiesTaken.waiters]) waiter();
		} else if (data.type === 'cancel') {
			stopped = true;
			reader.cancel(data.reason).catch(() => {});
			closePort(port);
		}
		resume();
	});

	let batch: Uint8Array[] = [];
	let batched = 0;
	let scheduled = false;
	const flush = () => {
		scheduled = false;
		if (stopped || batched === 0) return;
		// a chunk that is part of a larger buffer (or shares one with
		// another chunk) is copied: transferring it would move all of that
		// buffer, and the structured clone would copy all of it. A chunk
		// that is not ours is left to the structured clone, which copies it
		// straight into the receiver's buffer
		const transfer: ArrayBuffer[] = [];
		const data: Uint8Array[] = [];
		for (let i = 0; i < batch.length; i++) {
			const chunk = batch[i];
			const whole =
				ownsBuffer(chunk) && !transfer.includes(chunk.buffer as ArrayBuffer);
			const sent = whole ? chunk : new Uint8Array(chunk);
			if (owned || !whole) transfer.push(sent.buffer as ArrayBuffer);
			data.push(sent);
		}
		batch = [];
		batched = 0;
		postToPort(
			port,
			{
				type: 'data',
				data: data.length === 1 ? data[0] : data,
			} satisfies BodyMessage,
			transfer,
		);
	};

	const pump = async () => {
		for (;;) {
			while (credit <= 0 && !stopped)
				await new Promise<void>((resolve) => (wake = resolve));
			if (stopped) return;
			const { done, value } = await reader.read();
			if (stopped) return;
			if (done) break;
			if (value.byteLength === 0) continue;
			credit -= value.byteLength;
			batch.push(value);
			batched += value.byteLength;
			// the chunks that arrive within one task go out as one message
			if (batched >= MESSAGE_MAX) flush();
			else if (!scheduled) {
				scheduled = true;
				setTimeout(flush, 0);
			}
		}
		flush();
		let count: number | undefined;
		try {
			count = encoded?.();
		} catch {
			// no count
		}
		postToPort(port, {
			type: 'end',
			...(typeof count === 'number' && { encoded: count }),
		} satisfies BodyMessage);
	};
	pump().catch((error) => {
		if (stopped) return;
		flush();
		try {
			postToPort(port, { type: 'error', error } satisfies BodyMessage);
		} catch {
			// an error the structured clone cannot carry
			postToPort(port, {
				type: 'error',
				error: new Error(String(error)),
			} satisfies BodyMessage);
		}
	});

	return { $stompBodyPort: port2 };
}

/**
 * the receiving end: the body as a stream. `settled` runs once, when the
 * body ended, failed or was cancelled; `encoded` with the sender's count of
 * the bytes it came as before decoding, before the stream ends (sendBody).
 */
export function receiveBody(
	{ $stompBodyPort: port }: PortBody,
	settled?: (() => void) | null,
	encoded?: (count: number) => void,
): ReadableStream<Uint8Array> {
	let open = true;
	let received = 0;
	let granted = 0;
	const close = () => {
		open = false;
		closePort(port);
		settled?.();
	};
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				onPort(port, 'message', (message) => {
					const data = message as BodyMessage;
					if (!open) return;
					if (data.type === 'data') {
						for (const chunk of Array.isArray(data.data)
							? data.data
							: [data.data]) {
							received += chunk.byteLength;
							controller.enqueue(chunk);
						}
					} else if (data.type === 'end') {
						if (typeof data.encoded === 'number') encoded?.(data.encoded);
						close();
						controller.close();
					} else if (data.type === 'error') {
						close();
						controller.error(data.error);
					}
				});
			},
			// runs as the reader takes chunks: what it took is granted back in
			// steps, and all of it once the reader has caught up
			pull(controller) {
				if (!open) return;
				const queued = BODY_WINDOW - (controller.desiredSize ?? 0);
				const taken = received - queued;
				const step = taken - granted;
				if (step >= BODY_WINDOW / 8 || (step > 0 && taken === received)) {
					granted = taken;
					postToPort(port, {
						type: 'credit',
						bytes: step,
					} satisfies BodyControl);
				}
			},
			cancel(reason) {
				if (!open) return;
				postToPort(port, {
					type: 'cancel',
					reason: String(reason),
				} satisfies BodyControl);
				close();
			},
		},
		{ highWaterMark: BODY_WINDOW, size: (chunk) => chunk.byteLength },
	);
}

/**
 * A short body (by its Content-Length, INLINE_MAX at most) that the
 * transport has whole within INLINE_WAIT_MS of its headers crosses with
 * them, as one transferred buffer in the answer's own message: no port,
 * no data, end and credit messages, no stream on either side. One that is
 * not all there by then (a server that dribbles it, a connection that
 * stalls) streams on a port as any other, from where the read stopped.
 */
export const INLINE_MAX = 64 * 1024;
// (one turn of the transport's task queue: a body that is not all there by
// then streams, and its headers waited no longer than that turn)
const INLINE_WAIT_MS = 0;
/** the answer's property that carries the inline body's count of the bytes it came as */
export const INLINE_ENCODED = '$stompEncoded';

/** whether the headers say a length short enough to try inline */
export function shortLength(headers: [string, string][]): boolean {
	for (const [name, value] of headers)
		if (name.toLowerCase() === 'content-length')
			return /^\d+$/.test(value.trim()) && Number(value) <= INLINE_MAX;
	return false;
}

/**
 * `body` read whole into one buffer when it ends within INLINE_WAIT_MS and
 * INLINE_MAX bytes; else the body as a stream again, what was read first
 * (a failure of the read reaches that stream's reader, as it would have)
 */
export async function readShort(
	body: ReadableStream<Uint8Array>,
): Promise<
	| { whole: ArrayBuffer; rest?: undefined }
	| { whole: null; rest: ReadableStream<Uint8Array> }
> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<null>(
		(resolve) => (timer = setTimeout(() => resolve(null), INLINE_WAIT_MS)),
	);
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
	let failure: { error: unknown } | null = null;
	try {
		for (;;) {
			pending = reader.read();
			const got = await Promise.race([pending, late]);
			if (got === null) break;
			pending = null;
			if (got.done) {
				clearTimeout(timer);
				if (chunks.length === 1 && ownsBuffer(chunks[0]))
					return { whole: chunks[0].buffer as ArrayBuffer };
				const bytes = new Uint8Array(size);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return { whole: bytes.buffer };
			}
			size += got.value.byteLength;
			chunks.push(got.value);
			if (size > INLINE_MAX) break;
		}
	} catch (error) {
		pending = null;
		failure = { error };
	}
	clearTimeout(timer);
	const rest = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const chunk = chunks.shift();
				if (chunk) {
					controller.enqueue(chunk);
					return;
				}
				if (failure) {
					controller.error(failure.error);
					return;
				}
				try {
					const got = await (pending ?? reader.read());
					pending = null;
					if (got.done) controller.close();
					else controller.enqueue(got.value);
				} catch (error) {
					controller.error(error);
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
	return { whole: null, rest };
}

/**
 * a response's body that came on a port, and the sender's count of the
 * bytes it came as before decoding, read once it has ended (sendBody's
 * `encoded`; responseFacts.ts)
 */
export function receiveCounted(
	body: PortBody,
	settled?: (() => void) | null,
): {
	body: ReadableStream<Uint8Array>;
	encodedBytes: () => number | undefined;
} {
	let count: number | undefined;
	return {
		body: receiveBody(body, settled, (encoded) => (count = encoded)),
		encodedBytes: () => count,
	};
}
