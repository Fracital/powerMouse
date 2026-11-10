// How a wasm artifact of stomp (assets/, built by deploy/rust/build.sh)
// reaches the realms that run it. One compiled WebAssembly.Module is shared:
// it is structured cloneable, so the controller compiles it once and posts it
// to the service worker, the rewrite workers and the page's library realm,
// where instantiating it is synchronous and cheap. Nothing here reads
// import.meta.url or names a file: the host says where the bytes are (a URL,
// the bytes themselves, a Response or a module it compiled, decrypted or
// renamed itself), and a glue that named its own file would break the
// moment a host renamed it.

/** where a module comes from, as a host may give it */
export type ModuleSource =
	| WebAssembly.Module
	| BufferSource
	| Response
	| URL
	| string
	| Promise<WebAssembly.Module | BufferSource | Response>;

/**
 * The compiled module for `source`: as given when it is one, compiled from
 * bytes or a Response, fetched (and compiled while it streams) from a URL
 * resolved against `base` when it is a string. Compiling off the main
 * thread or asynchronously is what keeps a 600 KB module out of Chrome's
 * synchronous-compile limit, so this is the only place that compiles.
 */
export async function compileModule(
	source: ModuleSource,
	base?: string,
): Promise<WebAssembly.Module> {
	const given = await source;
	if (given instanceof WebAssembly.Module) return given;
	if (typeof given === 'string' || given instanceof URL) {
		const url = new URL(given, base);
		const response = fetch(url.href);
		if (typeof WebAssembly.compileStreaming === 'function')
			try {
				return await WebAssembly.compileStreaming(response);
			} catch (error) {
				// a server that does not label the file application/wasm fails
				// the streaming form only: the bytes compile the same
				return WebAssembly.compile(await (await fetch(url.href)).arrayBuffer());
			}
		return WebAssembly.compile(await (await response).arrayBuffer());
	}
	if (given instanceof Response)
		return WebAssembly.compile(await given.arrayBuffer());
	return WebAssembly.compile(given);
}

/** the exports every buffer module of stomp has (rust/<crate>/abi.json) */
export interface BufferExports {
	memory: WebAssembly.Memory;
	/** `len` bytes to write into */
	a(len: number): number;
	/** bytes given back unused */
	f(ptr: number, len: number): void;
	/** the configuration, once per change; the module owns the bytes */
	c(ptr: number, len: number): number;
	/** the call; the module owns the bytes and keeps the output */
	r(ptr: number, len: number, flags: number): number;
	/** the output's pointer and length */
	p(): number;
	n(): number;
	/** the scratch the host answers a routing call in */
	b(): number;
}

/** `e.r`: the host's routing of `len` bytes at `ptr`, written to the scratch */
export type RouteImport = (kind: number, text: string) => string | null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * An instance of a buffer module: strings in, strings out, every call
 * synchronous. A trap (a Rust panic, `panic = "abort"`) is thrown through as
 * a RuntimeError, after which the instance is dead: the caller drops it and
 * makes another from the same compiled module.
 */
export class BufferInstance {
	readonly #exports: BufferExports;
	#route: RouteImport;
	/** the configuration last handed over, so a repeat costs nothing */
	#config = '';
	/** the bytes of the scratch the routing import writes into */
	#scratch = 64 * 1024;
	constructor(module: WebAssembly.Module, route: RouteImport = () => null) {
		this.#route = route;
		const instance = new WebAssembly.Instance(module, {
			e: {
				r: (kind: number, ptr: number, len: number): number => {
					const text = decoder.decode(this.#view(ptr, len));
					const answer = this.#route(kind, text);
					if (answer === null) return -1;
					const bytes = encoder.encode(answer);
					if (bytes.length > this.#scratch) return -1;
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
	/** bytes copied into the module, which owns them from then on */
	#give(bytes: Uint8Array): [number, number] {
		const ptr = this.#exports.a(bytes.length);
		if (bytes.length) this.#view(ptr, bytes.length).set(bytes);
		return [ptr, bytes.length];
	}
	/** the configuration (JSON or any text), handed over when it changed */
	configure(config: string): void {
		if (config === this.#config) return;
		const status = this.#exports.c(...this.#give(encoder.encode(config)));
		if (status !== 0) throw new Error(`wasm configure failed: ${status}`);
		this.#config = config;
	}
	/** the module's answer for `input`, or null with the status when it declined */
	call(input: string, flags = 0): { output: string } | { status: number } {
		const status = this.#exports.r(...this.#give(encoder.encode(input)), flags);
		if (status !== 0) return { status };
		return {
			output: decoder.decode(this.#view(this.#exports.p(), this.#exports.n())),
		};
	}
	/** how much linear memory the instance holds now */
	get memoryBytes(): number {
		return this.#exports.memory.buffer.byteLength;
	}
}
