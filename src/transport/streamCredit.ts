// Wisp's stream credit (extension and packet 0xE2, holyWisp's
// `stream-credit`): each TCP stream's DATA comes no faster than the
// stream's reader in epoxy grants it (deploy/epoxy patch epoxy-tls 0084),
// as a native socket's receive window holds its remote back. It is on for
// a connection once the relay's INFO and the client's both name it; epoxy
// names it only when the relay's did.
//
// With it on, a slow reader holds back its own stream at the relay, and
// the rest of the connection goes on, so the pacing STomp does for a
// connection without it (riderPace.ts, the carrier host's bounded pause of
// the relay) is a backstop only: it must not hold back every stream of a
// rider, or the whole relay, for one slow reader.

/** the extension's id in an INFO, and its packet's type */
export const STREAM_CREDIT = 0xe2;
const INFO = 0x05;

/** whether `packet` is an INFO on stream 0 whose extensions name stream credit */
export function namesStreamCredit(packet: Uint8Array): boolean {
	if (
		packet.length < 7 ||
		packet[0] !== INFO ||
		packet[1] | packet[2] | packet[3] | packet[4]
	)
		return false;
	// the version (2 bytes), then each extension: id u8, length u32 LE, payload
	for (let at = 7; at + 5 <= packet.length;) {
		if (packet[at] === STREAM_CREDIT) return true;
		const length =
			(packet[at + 1] |
				(packet[at + 2] << 8) |
				(packet[at + 3] << 16) |
				(packet[at + 4] << 24)) >>>
			0;
		at += 5 + length;
	}
	return false;
}

/**
 * Whether this realm's Wisp connection has stream credit, as the last INFOs
 * that went by said (each StreamCreditWatch's, the carrier host's rider's or
 * the realm's own carrier's): a body read here on a connection without it
 * is bounded by boundedBody.ts, since nothing else holds its stream back.
 * False until a connection's INFOs said otherwise (Wisp v1 has none).
 */
export const relayCredit = { on: false };

/** a Wisp connection's stream credit, from the INFOs that go by */
export class StreamCreditWatch {
	#server = false;
	#client = false;
	/** both INFOs named it */
	get on(): boolean {
		return this.#server && this.#client;
	}
	/** a packet of the relay's */
	fromServer(packet: Uint8Array): void {
		if (packet[0] !== INFO) return;
		if (namesStreamCredit(packet)) this.#server = true;
		relayCredit.on = this.on;
	}
	/** a packet of the client's (epoxy's) */
	fromClient(packet: Uint8Array): void {
		if (packet[0] !== INFO) return;
		if (namesStreamCredit(packet)) this.#client = true;
		relayCredit.on = this.on;
	}
}

/**
 * `read` and `write`, a Wisp connection's packets each way, with their
 * INFOs watched for stream credit (`relayCredit`): a carrier this realm
 * opened itself, which no rider's pace (riderPace.ts) watches
 */
export function watchCredit(
	read: ReadableStream<ArrayBuffer>,
	write: WritableStream<Uint8Array>,
): { read: ReadableStream<ArrayBuffer>; write: WritableStream<Uint8Array> } {
	const watch = new StreamCreditWatch();
	// only a connection's opening has INFOs: past it, the packets just pass
	let server = 0;
	let client = 0;
	const watched = read.pipeThrough(
		new TransformStream<ArrayBuffer, ArrayBuffer>({
			transform(packet, controller) {
				if (server < 4) {
					server++;
					watch.fromServer(new Uint8Array(packet));
				}
				controller.enqueue(packet);
			},
		}),
	);
	const writer = write.getWriter();
	return {
		read: watched,
		write: new WritableStream<Uint8Array>({
			write(packet) {
				if (client < 4) {
					client++;
					watch.fromClient(packet);
				}
				return writer.write(packet);
			},
			close: () => writer.close(),
			abort: (reason) => writer.abort(reason),
		}),
	};
}
