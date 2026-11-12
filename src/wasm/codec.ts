// The codec module (rust/codec, `codec.wasm`) as a realm runs it: the xor
// codec's seal and open (src/xorWire.ts says what they are), in wasm. Unlike
// the other modules it is neither fetched nor handed over: its 1.4 KB ride
// in every bundle as text (build.js defines STOMP_CODEC_WASM from
// assets/codec.wasm) and a realm compiles them where it stands, the first
// time it seals or opens a URL, because that first time comes before
// anything asynchronous can have finished: a document's client reads its
// own address before the page's first script. The module is one page of
// memory with two buffers at fixed places, no import and no allocator.
//
// Where a realm holds no instance the JavaScript in src/xorWire.ts writes
// the same bytes: a bundle built without the module (the rewriter
// library's copies, whose bundle carries it already), a realm that may not
// compile one (`forbidCodecModule`), an instance that trapped. A document
// under a proxied top does not compile its own: it asks its top's bundle
// (`shareCodec`), so a page of forty frames holds one instance, not forty
// memories.
import { BUILD } from '../version';
import {
	asciiInto,
	asciiText,
	bytesOf,
	open,
	seal,
	textOf,
	unbase64,
} from '../xorWire';

// esbuild replaces this at build time (build.js `define`); a bundle made
// without it (a unit test's) has no module and the JavaScript answers
declare const process: { env: Record<string, string | undefined> };

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
 * The codec as a realm's instance answers it. Strings in and out, so one
 * realm's may answer for another's (a frame asks its top's); `build` says
 * which bundle made it.
 */
export interface CodecBackend {
	readonly build: string;
	/** `text` sealed under the key `a`, `b` */
	seal(text: string, a: number, b: number): string;
	/** the text the seal `text` holds, or null when it is no seal */
	open(text: string, a: number, b: number): string | null;
}

// taken when the bundle is evaluated, before any page code: a page that
// replaces WebAssembly (or the accessors of its objects) changes nothing
// here and sees no call
// (the name itself, not a property of the global: in the rewriter library it
// is the realm's the library was made for, src/libGlobals.ts)
const wasm = typeof WebAssembly === 'object' ? WebAssembly : undefined;
const WasmModule = wasm?.Module;
const WasmInstance = wasm?.Instance;
const exportsOf =
	WasmInstance &&
	Object.getOwnPropertyDescriptor(WasmInstance.prototype, 'exports')?.get;
const bufferOf =
	wasm?.Memory &&
	Object.getOwnPropertyDescriptor(wasm.Memory.prototype, 'buffer')?.get;
const Bytes = Uint8Array;

/** the module's bytes as this bundle carries them, or undefined for a bundle without */
function carried(): string | undefined {
	try {
		return process.env.STOMP_CODEC_WASM || undefined;
	} catch (error) {
		// neither a build's define nor Node
		return undefined;
	}
}

function instantiate(): CodecBackend | null {
	const text = carried();
	if (!text || !WasmModule || !WasmInstance || !exportsOf || !bufferOf)
		return null;
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
		build: BUILD,
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

/** this realm's instance: undefined until it is asked for, null when there is none */
let own: CodecBackend | null | undefined;
/** a realm that may not compile (or whose instance trapped) makes none */
let allowed = true;
/** another realm's, when this one may ask it (a document's top) */
let shared: (() => CodecBackend | null) | null = null;

/**
 * This realm compiles no module: a document whose own policy would refuse
 * it and report the attempt to the page (a list's `$csp=` rule, carried by
 * the worker: `Config.codecModule`). The JavaScript answers there.
 */
export function forbidCodecModule(): void {
	allowed = false;
	own = null;
}

/**
 * Where this bundle's codec asks before it compiles a module of its own:
 * `provider` answers another realm's backend, or null for none. Taken by
 * the bundle's first client (its realm's document); false when one was
 * taken already.
 */
export function shareCodec(provider: () => CodecBackend | null): boolean {
	if (shared) return false;
	shared = provider;
	return true;
}

/** this realm's own instance, compiled the first time it is asked for; null when it has none */
export function ownCodec(): CodecBackend | null {
	if (own !== undefined) return own;
	own = null;
	if (allowed)
		try {
			own = instantiate();
		} catch (error) {
			// a realm that may not compile, or has no room: the JavaScript
			// answers, and the attempt is not made twice
		}
	return own;
}

/** the backend for this realm's next seal or open, or null for the JavaScript */
function backend(): CodecBackend | null {
	return shared?.() ?? ownCodec();
}

/** `failed` threw (a trap: the instance is dead): it is not asked again */
function drop(failed: CodecBackend): void {
	if (own === failed) own = null;
	// another realm's: its own bundle drops it the same way when it asks
	else shared = null;
}

/** `text` sealed under the key `a`, `b`: in the module where this realm has one */
export function sealText(text: string, a: number, b: number): string {
	const module = backend();
	if (module)
		try {
			return module.seal(text, a, b);
		} catch (error) {
			drop(module);
		}
	return seal(bytesOf(text), a, b);
}

/** the text the seal `text` holds under the key `a`, `b`, or null when it is no seal */
export function openText(text: string, a: number, b: number): string | null {
	const module = backend();
	if (module)
		try {
			return module.open(text, a, b);
		} catch (error) {
			drop(module);
		}
	const bytes = open(text, a, b);
	return bytes && textOf(bytes);
}

/** whether this realm's next seal runs in the module (tests, and the controller's `codecModule`) */
export function codecInModule(): boolean {
	return backend() !== null;
}
