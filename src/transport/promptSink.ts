// The packets' WritableStream as epoxy's function transport is handed it
// (wispWebTransport.ts, CarrierTransport's #pipes): its writer's `ready` and
// `write()` are settled when they are returned, and call what is attached to
// them at once, so an epoxy build writes through it as it writes to its own
// WebSocket, whose `send` never waits.
//
// epoxy writes a function transport's packets through wasm-streams'
// IntoSink, whose poll_ready and poll_flush stay Pending until the writer's
// `ready` and `write()` promises call back, a microtask later at the
// soonest. Every stream of the wisp connection writes behind wisp-mux's lock,
// and a writer that met Pending kept it: rustls polls its flush once in a
// TLS handshake, so the lock stayed held while the multiplexor's actor
// waited on it to send the next stream's CONNECT and read nothing, and
// every request on the connection hung. deploy/epoxy's epoxy-tls 0075 fixed
// that in the build STomp pins, but a host may serve another build
// (SystemYA's e2a70d6, of 2026-11-10): there a TLS request with any other
// request beside it hung the page on both carriers. wasm-bindgen's JsFuture
// takes what `then` is handed called at once as settled, so here no poll is
// ever Pending; the packet is written to the stream as `write()` is called,
// in order, as 0075 does.
//
// Only a sink that waits reads `ready`: IntoSink reads it before every
// write. A build with 0075 never reads it and only watches each `write()`
// for a failure, in a JsFuture of its own. A JsFuture whose callback is
// called at once never drops its closures (wasm-bindgen-futures 0.4.50
// keeps them after `then` returns, and the callback drops what it finds
// kept), so they keep its state and it keeps them: two closures and their
// slots of wasm-bindgen's heap for every packet, for the worker's life (a
// shard grew 6 to 8 MB a minute on news sites). So `write()` returns a
// settled thenable only to a writer whose `ready` was read, a build that
// waits, which keeps that cost; to the others it returns a promise.
//
// A packet that is a view of a larger buffer (wasm memory) is copied: it is
// written after the call returns. A write the stream rejects fails the
// writer's `ready` and every later `write()`, as a dead WebSocket's sends.

/** a settled promise whose callbacks run when they are attached */
class Settled {
	readonly #ok: boolean;
	readonly #value: unknown;

	constructor(ok: boolean, value: unknown) {
		this.#ok = ok;
		this.#value = value;
	}

	then(onFulfilled?: unknown, onRejected?: unknown): Promise<unknown> {
		const callback = this.#ok ? onFulfilled : onRejected;
		if (typeof callback !== 'function')
			return this.#ok
				? Promise.resolve(this.#value)
				: Promise.reject(this.#value);
		try {
			return Promise.resolve(callback(this.#value));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	catch(onRejected?: unknown): Promise<unknown> {
		return this.then(undefined, onRejected);
	}

	finally(onFinally?: () => void): Promise<unknown> {
		return Promise.resolve(this).finally(onFinally);
	}
}

/** `stream`, written as epoxy's function transport expects (see the top of the file) */
export function promptSink(
	stream: WritableStream<Uint8Array>,
): WritableStream<Uint8Array> {
	const writer = stream.getWriter();
	let failed: { error: unknown } | null = null;
	// the writer waits on its promises (see the top of the file)
	let waits = false;
	const state = () =>
		failed ? new Settled(false, failed.error) : new Settled(true, undefined);
	const settled = () =>
		waits ? state() : failed ? Promise.reject(failed.error) : Promise.resolve();
	const prompt = {
		get ready() {
			waits = true;
			return state();
		},
		get closed() {
			return writer.closed;
		},
		get desiredSize() {
			return writer.desiredSize;
		},
		write(packet: Uint8Array) {
			if (failed) return settled();
			const own =
				packet.byteOffset !== 0 ||
				packet.byteLength !== packet.buffer.byteLength
					? packet.slice()
					: packet;
			writer.write(own).catch((error: unknown) => {
				failed ??= { error };
			});
			return settled();
		},
		close() {
			return writer.close();
		},
		abort(reason?: unknown) {
			return writer.abort(reason);
		},
		// the stream stays this writer's
		releaseLock() {},
	};
	return {
		get locked() {
			return false;
		},
		getWriter: () => prompt,
		close: () => writer.close(),
		abort: (reason?: unknown) => writer.abort(reason),
	} as unknown as WritableStream<Uint8Array>;
}
