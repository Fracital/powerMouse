// A response's body read for a rewrite another thread may make: its bytes,
// and the chunks they came in kept besides. The bytes go to a rewrite
// worker as they are (transferred, where a copy of them was made on the
// service worker's thread for each script: 4 ms for Discord's 12.7 MB
// bundle), and they are put together again from the chunks when that
// worker never answers (it closed with its page, or took longer than the
// pool waits) and the service worker rewrites the script itself. The
// chunks are what reading the body as one buffer lets go of at once:
// kept for the rewrite, they take the room the copy took.

export class BodyBytes {
	#bytes: Uint8Array<ArrayBuffer>;
	/** what the bytes were put together from; null when they are the one chunk itself, or none */
	readonly #chunks: Uint8Array<ArrayBuffer>[] | null;
	/** how many bytes the body has */
	readonly size: number;
	constructor(chunks: Uint8Array<ArrayBuffer>[]) {
		let size = 0;
		for (const chunk of chunks) size += chunk.length;
		this.size = size;
		if (chunks.length < 2) {
			this.#bytes = chunks[0] ?? new Uint8Array(0);
			this.#chunks = null;
		} else {
			this.#chunks = chunks;
			this.#bytes = join(chunks, size);
		}
	}
	/** the body read to its end, as arrayBuffer() reads it (a chunk that is no bytes is a TypeError) */
	static async read(response: Response): Promise<BodyBytes> {
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		const body = response.body;
		if (body) {
			const reader = body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!(value instanceof Uint8Array))
					throw new TypeError('a body chunk is not a Uint8Array');
				if (value.length) chunks.push(value as Uint8Array<ArrayBuffer>);
			}
		}
		return new BodyBytes(chunks);
	}
	/** the bytes, put together again when they were handed over */
	get bytes(): Uint8Array<ArrayBuffer> {
		if (this.#bytes.byteLength !== this.size)
			this.#bytes = join(this.#chunks!, this.size);
		return this.#bytes;
	}
	/**
	 * A buffer of the bytes for another thread, to be transferred: the
	 * bytes' own where the chunks keep them, else a copy (a body of one
	 * chunk, which may be part of a larger buffer)
	 */
	handOver(): ArrayBuffer {
		return this.#chunks ? this.bytes.buffer : this.bytes.slice().buffer;
	}
}

function join(
	chunks: Uint8Array<ArrayBuffer>[],
	size: number,
): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}
