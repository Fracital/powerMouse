// A realm's instance of the codec module (./codec.ts says what it is and
// when a realm makes one), made from the module's bytes and the browser's
// WebAssembly functions the bundle took before any page code ran. A file of
// its own because the document bundle has it as a deferred part
// (./codecBytes.ts, with the bytes: a proxied top makes the instance at its
// first seal and the frames under it seal in that one), where build.js
// stubCodecInstance hands codec.ts ./codecInstanceStub.ts in its place; the
// worker bundles and the service worker import it as any module.
import { asciiInto, asciiText, bytesOf, textOf, unbase64 } from '../xorWire';
import type { CodecBackend } from './codec';

/** the module's exports (rust/codec/abi.json) */
interface CodecExports {
	memory: WebAssembly.Memory;
	/** where the input buffer is */
	i(): number;
	/** where the output buffer is */
	o(): number;
	/** seal `len` bytes of the input buffer, which stand at byte `at` of the text */
	e(len: number, at: number, a: number, b: number): number;
	/** open `len` characters of the input buffer, the first byte at `at` */
	d(len: number, at: number, a: number, b: number): number;
}

/** the bytes of each buffer, and the most one `e` seals (rust/codec/src/lib.rs) */
const ROOM = 16384;
const SEAL = (ROOM / 4) * 3;

/**
 * The instance of the module whose bytes are `text` (base64url), as the
 * backend of the bundle `build`, or null when they are no module's bytes
 */
export function codecInstance(
	text: string,
	build: string,
	WasmModule: typeof WebAssembly.Module,
	WasmInstance: typeof WebAssembly.Instance,
	exportsOf: () => unknown,
	bufferOf: () => unknown,
	Bytes: typeof Uint8Array,
): CodecBackend | null {
	const bytes = unbase64(text);
	if (!bytes) return null;
	const made = Reflect.apply(
		exportsOf,
		new WasmInstance(new WasmModule(bytes as Uint8Array<ArrayBuffer>)),
		[],
	) as unknown as CodecExports;
	// the module never grows its memory, so these views hold for its life
	const memory = Reflect.apply(bufferOf, made.memory, []) as ArrayBuffer;
	const input = new Bytes(memory, made.i(), ROOM);
	const few = input.subarray(0, SEAL);
	const output = new Bytes(memory, made.o(), ROOM);
	return {
		build,
		seal(text, a, b) {
			// a URL: ASCII, and one piece
			const length = asciiInto(text, few);
			if (length !== -1)
				return asciiText(output.subarray(0, made.e(length, 0, a, b)));
			const all = bytesOf(text);
			let sealed = '';
			for (let at = 0; at < all.length; at += SEAL) {
				const piece = all.subarray(at, at + SEAL);
				input.set(piece);
				sealed += asciiText(output.subarray(0, made.e(piece.length, at, a, b)));
			}
			return sealed;
		},
		open(text, a, b) {
			if (text.length <= ROOM) {
				const length = asciiInto(text, input);
				if (length === -1) return null;
				const opened = made.d(length, 0, a, b);
				return opened < 0 ? null : textOf(output.subarray(0, opened));
			}
			const all = new Bytes(Math.ceil((text.length / 4) * 3));
			let written = 0;
			for (let at = 0; at < text.length; at += ROOM) {
				const length = asciiInto(text.slice(at, at + ROOM), input);
				if (length === -1) return null;
				const opened = made.d(length, written, a, b);
				if (opened < 0) return null;
				all.set(output.subarray(0, opened), written);
				written += opened;
			}
			return textOf(all.subarray(0, written));
		},
	};
}
