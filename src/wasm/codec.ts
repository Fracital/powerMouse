// The codec module (rust/codec, `codec.wasm`) as a realm runs it: the xor
// codec's seal and open (src/xorWire.ts says what they are), in wasm. Unlike
// the other modules it is never fetched: its 1.4 KB ride as text (build.js
// defines STOMP_CODEC_WASM from assets/codec.wasm) and a realm compiles
// them where it stands, the first time it seals or opens a URL, because
// that first time comes before anything asynchronous can have finished: a
// document's client reads its own address before the page's first script.
// The worker bundles and the service worker carry the text; the document
// bundle's is a deferred part (./codecBytes.ts, `codecParts`), which a
// proxied top's shell loaded before the bundle, so only a top compiles one
// and no frame carries the text. The module is one page of memory with two
// buffers at fixed places, no import and no allocator.
//
// Where a realm holds no instance the JavaScript in src/xorWire.ts writes
// the same bytes: a bundle built without the module (the rewriter
// library's copies, whose bundle carries it already), a document whose
// realm does not hold the parts already (a frame of another slot, a top
// whose shell did not load them: it asks for no file for this), a realm
// that may not compile one (`forbidCodecModule`), an instance that trapped.
// A document under a proxied top does not compile its own: it asks its
// top's bundle (`shareCodec`), so a page of forty frames holds one
// instance, not forty memories.
import { BUILD } from '../version';
import { bytesOf, open, seal, textOf } from '../xorWire';
import { codecInstance } from './codecInstance';

// esbuild replaces this at build time (build.js `define`); a bundle made
// without it (a unit test's) has no module and the JavaScript answers
declare const process: { env: Record<string, string | undefined> };

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

/**
 * Where a bundle built without the module's bytes takes them: the document
 * bundle's deferred part, where its realm holds the parts already
 * (src/inject/dom/document.ts); undefined for none
 */
export const codecParts: { bytes?: () => string | undefined } = {};

/** the module's bytes as this bundle carries them, or undefined for a bundle without */
function carried(): string | undefined {
	try {
		return process.env.STOMP_CODEC_WASM || codecParts.bytes?.() || undefined;
	} catch (error) {
		// neither a build's define nor Node, or a part that could not be had
		return undefined;
	}
}

function instantiate(): CodecBackend | null {
	const text = carried();
	if (!text || !WasmModule || !WasmInstance || !exportsOf || !bufferOf)
		return null;
	return codecInstance(
		text,
		BUILD,
		WasmModule,
		WasmInstance,
		exportsOf,
		bufferOf,
		Bytes,
	);
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
