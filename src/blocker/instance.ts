// An instance of the blocker's wasm module (rust/block, assets/blocker.wasm)
// in the service worker: the buffer ABI of src/wasm/module.ts, with bytes in
// and out as well as strings (a serialized engine is not text), and the one
// import answered here: the public suffix list, from the tldts the worker
// already carries for its cookie jar and its partitions, so the crate's own
// copy stays out of the artifact.
import { getDomain } from 'tldts';
import type { BufferExports } from '../wasm/module';

/** the operations `r` takes in the low byte of its flags (rust/block/src/lib.rs) */
export const OP = {
	addList: 1,
	build: 2,
	load: 3,
	resources: 4,
	check: 5,
	csp: 6,
	cosmetic: 7,
	classIds: 8,
	drop: 9,
} as const;
/** bit 8 of the flags of an `addList`: the list may use `trusted-*` scriptlets */
export const FLAG_TRUSTED = 1 << 8;
/** bit 9: a hosts file */
export const FLAG_HOSTS = 1 << 9;

/** the statuses `r` answers besides 0 */
export const STATUS_NO_ENGINE = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** the registrable domain (eTLD+1) of a hostname, as the lists' `$domain=` and third-party rules need it */
export function registrableDomain(host: string): string | null {
	return getDomain(host, { allowPrivateDomains: true });
}

export class BlockerInstance {
	readonly #exports: BufferExports;
	constructor(module: WebAssembly.Module) {
		const instance = new WebAssembly.Instance(module, {
			e: {
				r: (kind: number, ptr: number, len: number): number => {
					if (kind !== 1) return -1;
					const host = decoder.decode(this.#view(ptr, len));
					const domain = registrableDomain(host);
					if (domain === null) return -1;
					const bytes = encoder.encode(domain);
					if (bytes.length > len) return -1;
					this.#view(this.#exports.b(), bytes.length).set(bytes);
					return bytes.length;
				},
			},
		});
		this.#exports = instance.exports as unknown as BufferExports;
	}
	#view(ptr: number, len: number): Uint8Array {
		return new Uint8Array(this.#exports.memory.buffer, ptr, len);
	}
	/** the operation `flags` names on `input`; its status and, when 0, its output */
	call(input: Uint8Array | string, flags: number): number {
		const bytes = typeof input === 'string' ? encoder.encode(input) : input;
		const ptr = this.#exports.a(bytes.length);
		if (bytes.length) this.#view(ptr, bytes.length).set(bytes);
		return this.#exports.r(ptr, bytes.length, flags);
	}
	/** the last call's output, as text */
	text(): string {
		return decoder.decode(this.#view(this.#exports.p(), this.#exports.n()));
	}
	/** the last call's output, copied out */
	bytes(): Uint8Array<ArrayBuffer> {
		return this.#view(this.#exports.p(), this.#exports.n()).slice();
	}
	/** how much linear memory the instance holds now */
	get memoryBytes(): number {
		return this.#exports.memory.buffer.byteLength;
	}
}
