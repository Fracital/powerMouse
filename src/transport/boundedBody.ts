// A body on a Wisp connection that nothing holds back is read as it comes,
// and reset when its reader stops for good, as a socket is reset under
// memory pressure, instead of being kept in epoxy's memory without end.
//
// Natively a reader that stops holds its connection back: Chrome stops
// reading the socket and TCP's window holds the origin. Through the proxy
// an HTTP/1 body is one Wisp stream of the relay's connection, and plain
// Wisp has no flow control toward the client: the relay sends a stream
// whatever its reader takes, and epoxy keeps what came for it (an
// unbounded queue per stream) in the transport worker's wasm memory, which
// never shrinks. A tab that read 1 MB of a 384 MB chunked body and paused
// had all 384 MB in that memory within seconds, for the life of the tab
// (paused-body-memory).
//
// What does hold a stream back, where the connection has it, is left
// alone: a relay with stream credit (Wisp 0xE2, streamCredit.ts) sends a
// stream no more than its reader in epoxy granted; HTTP/2 and HTTP/3 have
// their own windows, which epoxy and stomp-h3 open only as the body is
// read; and a body that can be resumed by range is let go and resumed
// (resumableBody.ts). Holding back the whole connection for one stream
// would hold every other stream of the profile behind it (the carrier
// host's pause is bounded for that reason, and a paused reader is past
// it). So the rest is read as it arrives, into a queue of its own the
// collector gives back, and epoxy's stays short; the reader takes from
// that queue at its own pace. When the queue holds HOLD_MAX, the
// transport's body is cancelled (its stream closes at the relay and the
// origin's connection with it), what waited is dropped, and the reader's
// stream fails as a reset connection's does: the bound the carrier host
// keeps for a rider's queue (RIDER_QUEUE_MAX). It is a bound of bytes, not
// of time: a reader that pauses a few seconds on an origin that sends at a
// home connection's pace still gets the whole body (paused-bodies), and a
// reader that keeps up never meets it. Through the carrier host a reader
// that reads slower than the wire never does either: a rider hands epoxy
// its packets no further ahead of its realm's readers than PACED_AHEAD
// while they read (riderPace.ts).
import type { TransferrableResponse } from '@mercuryworkshop/proxy-transports';
import { chromeProtocol } from './responseFacts';
import { relayCredit } from './streamCredit';
import { wispNote } from './transportLog';

const MiB = 1024 * 1024;
/** what may wait for the reader (carrierHost.ts RIDER_QUEUE_MAX) */
export const HOLD_MAX = 64 * MiB;

const header = (response: TransferrableResponse, name: string) => {
	for (const [key, value] of response.headers)
		if (key.toLowerCase() === name) return value;
	return null;
};

/**
 * `body`, `response`'s, bounded as above when nothing else bounds it; as
 * it is when the relay holds its stream back, its protocol has windows of
 * its own, it is short, or it is not the transport's own (resumableBody's)
 */
export function boundedBody(
	response: TransferrableResponse,
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	if (body !== response.body || relayCredit.on) return body;
	const protocol = chromeProtocol(
		(response as { httpVersion?: unknown }).httpVersion,
	);
	// one with windows of its own, or a transport that does not say
	if (protocol === null || protocol === 'h2' || protocol === 'h3') return body;
	const length = header(response, 'content-length');
	if (
		length !== null &&
		/^\s*\d+\s*$/.test(length) &&
		Number(length) <= HOLD_MAX
	)
		return body;
	const reader = body.getReader();
	const queue: Uint8Array[] = [];
	let queued = 0;
	let ended = false;
	let cancelled = false;
	let failure: { error: unknown } | null = null;
	let wake: (() => void) | null = null;
	const woken = () => {
		const resolve = wake;
		wake = null;
		resolve?.();
	};
	const reset = () => {
		const held = queued;
		queue.length = 0;
		queued = 0;
		failure = {
			error: new TypeError(
				'network error: the reader fell too far behind a relay without flow control',
			),
		};
		wispNote(
			'warn',
			`a response body's reader fell ${Math.round(held / MiB)} MB behind on a relay without stream credit: the body is reset`,
		);
		reader.cancel('the reader fell behind').catch(() => {});
	};
	void (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (cancelled || failure) return;
				if (done) {
					ended = true;
					return;
				}
				queue.push(value);
				queued += value.byteLength;
				if (queued >= HOLD_MAX) {
					reset();
					return;
				}
				woken();
			}
		} catch (error) {
			if (!cancelled && !failure) failure = { error };
		} finally {
			woken();
		}
	})();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				// (a cancel wakes a pull that waits, and it ends there)
				while (!queue.length && !ended && !failure && !cancelled)
					await new Promise<void>((resolve) => (wake = resolve));
				if (cancelled) return;
				const chunk = queue.shift();
				if (chunk) {
					queued -= chunk.byteLength;
					controller.enqueue(chunk);
				} else if (failure) controller.error(failure.error);
				else controller.close();
			},
			cancel(reason) {
				cancelled = true;
				queue.length = 0;
				queued = 0;
				woken();
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}
