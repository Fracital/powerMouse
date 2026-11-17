// A large body the reader falls behind on is let go at the origin and asked
// for again, by range, from where the transport stopped, once the reader
// has caught up.
//
// Natively a reader that stops or reads slowly (a media element that
// buffered what it wants, a page that reads a download slowly) holds the
// connection back: the browser stops reading the socket and TCP holds the
// origin back. Through the proxy nothing does: wisp has no flow control
// towards the client, so epoxy receives the body at the wire's speed
// whatever the reader takes, and keeps what it received in its stream's
// queue in the transport worker's wasm memory, which never shrinks. A
// 300 MB video the media element read 25 MB of was all in that memory
// within 20 s, and stayed there for the life of the tab: a few videos and
// Chrome runs out.
//
// So a body that can be resumed (a GET answered whole or in part, with a
// length, ranges, a strong validator and no content coding the transport
// decodes) is read through here. Its transport body is read as it arrives,
// so epoxy's queue stays short, into a queue of its own the collector gives
// back; when that queue holds BUFFER_MAX the reader has not taken while
// more than RESUME_MIN is still to come, the transport's body is cancelled
// (the origin's response ends), and once the reader has taken the queue
// down to RESUME_AT the rest is asked for with Range and If-Range. Only a
// 206 of exactly the rest, of the same version, carries on; anything else
// fails the body, as a connection that broke would. A reader that keeps up
// with the wire is never asked for again; one slower than the wire costs a
// request each BUFFER_MAX - RESUME_AT it takes.
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from '@mercuryworkshop/proxy-transports';

const MiB = 1024 * 1024;
/** what may wait for the reader before the transport lets the body go */
export const BUFFER_MAX = 16 * MiB;
/** what is left waiting when the rest is asked for (covers the request's round trip) */
export const RESUME_AT = 4 * MiB;
/** what must still be to come for a full queue to let the body go (less is simply received) */
export const RESUME_MIN = 8 * MiB;

const header = (headers: RawHeaders, name: string): string | null => {
	for (const [key, value] of headers)
		if (key.toLowerCase() === name) return value;
	return null;
};

/** the run of bytes a response holds of its resource, null when it cannot be resumed */
function resumable(
	method: string,
	response: TransferrableResponse,
): { from: number; to: number; size: number; validator: string } | null {
	if (method !== 'GET') return null;
	const headers = response.headers;
	const encoding = header(headers, 'content-encoding');
	if (encoding !== null && encoding.trim().toLowerCase() !== 'identity')
		return null;
	const etag = header(headers, 'etag');
	const validator =
		etag !== null && !/^\s*W\//.test(etag)
			? etag
			: header(headers, 'last-modified');
	if (validator === null) return null;
	if (response.status === 206) {
		const range = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(
			header(headers, 'content-range') ?? '',
		);
		if (!range) return null;
		const [from, to, size] = range.slice(1).map(Number);
		return from <= to && to < size ? { from, to, size, validator } : null;
	}
	if (response.status !== 200) return null;
	if (!/\bbytes\b/i.test(header(headers, 'accept-ranges') ?? '')) return null;
	const length = header(headers, 'content-length');
	if (length === null || !/^\s*\d+\s*$/.test(length)) return null;
	const size = Number(length);
	return size > 0 ? { from: 0, to: size - 1, size, validator } : null;
}

/**
 * `response`'s body, read so that a reader that falls behind lets it go and
 * resumes it by range as it catches up (see above); the body as it is when
 * it cannot be resumed or is too short to matter
 */
export function resumableBody(
	transport: ProxyTransport,
	remote: URL,
	method: string,
	headers: RawHeaders,
	response: TransferrableResponse,
): ReadableStream<Uint8Array> {
	const body = response.body as ReadableStream<Uint8Array>;
	const run = resumable(method, response);
	if (!run || run.to - run.from + 1 <= RESUME_MIN) return body;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = body.getReader();
	/** the next byte of the resource the transport is to send */
	let received = run.from;
	/** what the transport sent that the reader has not taken */
	const queue: Uint8Array[] = [];
	let queued = 0;
	let ended = false;
	let cancelled = false;
	let failure: { error: unknown } | null = null;
	let pumping: Promise<void> | null = null;
	let wake: (() => void) | null = null;
	const woken = () => {
		const resolve = wake;
		wake = null;
		resolve?.();
	};
	const resume = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
		const sent: RawHeaders = headers.filter(
			([name]) => !['range', 'if-range'].includes(name.toLowerCase()),
		);
		sent.push(['Range', `bytes=${received}-${run.to}`]);
		sent.push(['If-Range', run.validator]);
		const answer = await transport.request(
			remote,
			method,
			null,
			sent,
			undefined,
		);
		const got = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(
			header(answer.headers, 'content-range') ?? '',
		);
		const again = resumable(method, answer);
		if (
			answer.status !== 206 ||
			!(answer.body instanceof ReadableStream) ||
			!got ||
			Number(got[1]) !== received ||
			Number(got[2]) !== run.to ||
			Number(got[3]) !== run.size ||
			again?.validator !== run.validator
		) {
			if (answer.body instanceof ReadableStream)
				await answer.body.cancel().catch(() => {});
			throw new TypeError('the resource changed while it was read');
		}
		return answer.body.getReader();
	};
	/** reads the transport's body into the queue until it ends or the queue is full */
	const pump = async () => {
		try {
			const next = reader ?? (await resume());
			if (cancelled) {
				await next.cancel().catch(() => {});
				return;
			}
			reader = next;
			for (;;) {
				const { done, value } = await next.read();
				if (cancelled) return;
				if (done) {
					ended = true;
					reader = null;
					return;
				}
				queue.push(value);
				queued += value.byteLength;
				received += value.byteLength;
				woken();
				if (queued >= BUFFER_MAX && run.to - received + 1 > RESUME_MIN) {
					reader = null;
					await next.cancel('the reader fell behind').catch(() => {});
					return;
				}
			}
		} catch (error) {
			reader = null;
			failure = { error };
		} finally {
			pumping = null;
			woken();
		}
	};
	pumping = pump();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				while (!queue.length && !ended && !failure) {
					pumping ??= pump();
					await new Promise<void>((resolve) => (wake = resolve));
				}
				const chunk = queue.shift();
				if (chunk) {
					queued -= chunk.byteLength;
					controller.enqueue(chunk);
					if (!pumping && !ended && !failure && queued <= RESUME_AT)
						pumping = pump();
				} else if (failure) controller.error(failure.error);
				else controller.close();
			},
			cancel(reason) {
				cancelled = true;
				queue.length = 0;
				queued = 0;
				const current = reader;
				reader = null;
				return current?.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}
