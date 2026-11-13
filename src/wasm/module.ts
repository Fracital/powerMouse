// How a wasm artifact of stomp (assets/, built by deploy/rust/build.sh)
// reaches the realms that run it. One compiled WebAssembly.Module is shared:
// it is structured cloneable, so the controller compiles it once and posts it
// to the rewrite workers and the page's library realm, where instantiating
// it is synchronous and cheap. The core module (rust/core-module) holds the
// JS rewriter, the scanner and the suffix lookup as members of one instance,
// each called through a view of its own (CoreInstance). Nothing here reads
// import.meta.url or names a file: the host says where the bytes are (a URL,
// the bytes themselves, a Response or a module it compiled, decrypted or
// renamed itself), and a glue that named its own file would break the
// moment a host renamed it.

// STomp's own wasm (the epoxy transport, the content blocker) compiles here.
// The inject enforces the page's script-src against the page's WebAssembly by
// wrapping the global WebAssembly (src/inject/dom/modules/WebAssemblyPolicy.ts);
// STomp's own compilation must never be subject to it, so this captures the
// native methods at load, before any wrap, and compiles with them.
const nativeWasm =
	typeof WebAssembly === 'object' && WebAssembly
		? {
				Module: WebAssembly.Module,
				compile: WebAssembly.compile?.bind(WebAssembly),
				compileStreaming: WebAssembly.compileStreaming?.bind(WebAssembly),
			}
		: { Module: undefined, compile: undefined, compileStreaming: undefined };

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
	const compile = nativeWasm.compile ?? WebAssembly.compile.bind(WebAssembly);
	const NativeModule = nativeWasm.Module ?? WebAssembly.Module;
	const given = await source;
	if (given instanceof NativeModule) return given;
	if (typeof given === 'string' || given instanceof URL) {
		const url = new URL(given, base);
		const response = fetch(url.href);
		if (typeof nativeWasm.compileStreaming === 'function')
			try {
				return await nativeWasm.compileStreaming(response);
			} catch (error) {
				// a server that does not label the file application/wasm fails
				// the streaming form only: the bytes compile the same
				return compile(await (await fetch(url.href)).arrayBuffer());
			}
		return compile(await (await response).arrayBuffer());
	}
	if (given instanceof Response) return compile(await given.arrayBuffer());
	return compile(given);
}

/** what a buffer module exports, or a member of the core under its view's names */
export interface MemberExports {
	memory: WebAssembly.Memory;
	/** `len` bytes to write into */
	a(len: number): number;
	/** the call; the module owns the bytes and keeps the output */
	r(ptr: number, len: number, flags: number): number;
	/** the output's pointer and length */
	p(): number;
	n(): number;
	/** the configuration, once per change; the module owns the bytes */
	c?(ptr: number, len: number): number;
	/** the scratch the host answers a routing call in */
	b?(): number;
	/**
	 * A member that keeps its input buffer from call to call (the scanner):
	 * the buffer, at least `len` bytes, what it held kept when it grows
	 */
	i?(len: number): number;
	/** the call on the first `len` bytes of that buffer */
	x?(len: number, flags: number): number;
	/** the scratch, made at least `len` bytes */
	s?(len: number): number;
}

/** the exports of a buffer module of its own (rust/block/abi.json) */
export interface BufferExports extends MemberExports {
	/** bytes given back unused */
	f(ptr: number, len: number): void;
	c(ptr: number, len: number): number;
	b(): number;
}

/**
 * The core module's members, and the export each role of a view is read
 * from (rust/core-module/src/lib.rs, abi.json): `route` is the import that
 * routes for the member, when it routes anything
 */
export const MEMBERS = {
	rewriter: { a: 'a', c: 'jc', r: 'jr', p: 'jp', n: 'jn', b: 'jb', route: 'j' },
	scanner: {
		a: 'a',
		r: 'sr',
		p: 'sp',
		n: 'sn',
		i: 'si',
		x: 'sx',
		s: 'ss',
		route: 's',
	},
	suffix: { a: 'da', r: 'dr', p: 'dp', n: 'dn' },
} as const;
export type MemberName = keyof typeof MEMBERS;

/** a member's routing import (`e.j`, `e.s`): the host's routing of the text it asks about, or null when it does not route */
export type RouteImport = (kind: number, text: string) => string | null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** for `exchange`: a byte order mark is a character of the text like any other */
const keeping = new TextDecoder('utf-8', { ignoreBOM: true });

/** whether `text` is free of surrogates with no other half (what UTF-8 has no bytes for) */
function wellFormed(text: string): boolean {
	const native = (text as { isWellFormed?: () => boolean }).isWellFormed;
	return typeof native === 'function'
		? native.call(text)
		: !/[\ud800-\udfff]/.test(text) || !loneAt(text);
}

/** whether a surrogate of `text` has no other half */
function loneAt(text: string): boolean {
	for (let at = 0; at < text.length; at++) {
		const unit = text.charCodeAt(at);
		if ((unit & 0xf800) !== 0xd800) continue;
		if (unit < 0xdc00 && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) at++;
		else return true;
	}
	return false;
}

/**
 * `text` as UTF-8, a surrogate with no other half as the three bytes its
 * code point would take (WTF-8), where an encoder writes U+FFFD
 */
function encodeLoose(text: string): Uint8Array {
	const parts: Uint8Array[] = [];
	let from = 0;
	for (let at = 0; at < text.length; at++) {
		const unit = text.charCodeAt(at);
		if ((unit & 0xf800) !== 0xd800) continue;
		if (unit < 0xdc00 && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) {
			at++;
			continue;
		}
		parts.push(
			encoder.encode(text.slice(from, at)),
			Uint8Array.of(0xed, 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f)),
		);
		from = at + 1;
	}
	parts.push(encoder.encode(text.slice(from)));
	let size = 0;
	for (const part of parts) size += part.length;
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

/** `encodeLoose` read back: every unit of the string that was encoded */
function decodeLoose(bytes: Uint8Array): string {
	let text = '';
	let from = 0;
	// 0xED leads U+D000 to U+DFFF, and a surrogate's second byte is 0xA0 up
	for (
		let at = bytes.indexOf(0xed);
		at !== -1 && at + 2 < bytes.length;
		at = bytes.indexOf(0xed, at + 1)
	) {
		if (bytes[at + 1] < 0xa0) continue;
		text +=
			keeping.decode(bytes.subarray(from, at)) +
			String.fromCharCode(
				0xd000 | ((bytes[at + 1] & 0x3f) << 6) | (bytes[at + 2] & 0x3f),
			);
		from = at + 3;
		at += 2;
	}
	return text + keeping.decode(bytes.subarray(from));
}

/**
 * One instance of the core module, and its members' views of it. The
 * members share the memory and nothing else: one can be called from inside
 * another's routing call. A trap in any of them (a Rust panic, `panic =
 * "abort"`) is thrown through as a RuntimeError, after which the whole
 * instance is dead: the caller drops it and makes another from the same
 * compiled module, whose members start over.
 */
export class CoreInstance {
	readonly members: { readonly [name in MemberName]: BufferInstance };
	readonly #memory: WebAssembly.Memory;
	/** `route` answers every member's routing import, by member */
	constructor(
		module: WebAssembly.Module,
		route: (
			member: MemberName,
			kind: number,
			text: string,
		) => string | null = () => null,
	) {
		const imports: Record<
			string,
			(kind: number, ptr: number, len: number) => number
		> = {};
		const members = {} as Record<MemberName, BufferInstance>;
		for (const name of Object.keys(MEMBERS) as MemberName[]) {
			const names = MEMBERS[name];
			if ('route' in names)
				imports[names.route] = (kind, ptr, len) =>
					members[name].answerRoute(kind, ptr, len);
		}
		const { exports } = new WebAssembly.Instance(module, { e: imports });
		this.#memory = exports.memory as WebAssembly.Memory;
		for (const name of Object.keys(MEMBERS) as MemberName[]) {
			const view: Record<string, unknown> = { memory: this.#memory };
			for (const [role, field] of Object.entries(MEMBERS[name]))
				if (role !== 'route') view[role] = exports[field];
			members[name] = new BufferInstance(
				view as unknown as MemberExports,
				(kind, text) => route(name, kind, text),
			);
		}
		this.members = members;
	}
	/** how much linear memory the instance holds now */
	get memoryBytes(): number {
		return this.#memory.buffer.byteLength;
	}
}

/**
 * The member `name` of a new core instance, `route` answering its routing
 * import: for a caller that keeps an instance of its own (a test, a tool
 * of rust/host) rather than the thread's (src/wasm/thread.ts)
 */
export function memberInstance(
	module: WebAssembly.Module,
	name: MemberName,
	route: RouteImport = () => null,
): BufferInstance {
	return new CoreInstance(module, (member, kind, text) =>
		member === name ? route(kind, text) : null,
	).members[name];
}

/**
 * A member of the core module as its callers see it: strings in, strings
 * out, every call synchronous. A call that traps throws (CoreInstance).
 */
export class BufferInstance {
	readonly #exports: MemberExports;
	#route: RouteImport;
	/** the configuration last handed over, so a repeat costs nothing */
	#config = '';
	/** the bytes of the scratch the routing import writes into */
	#scratch = 64 * 1024;
	/**
	 * How the texts of the call in hand cross: 0 as `call` reads them, 1
	 * with a byte order mark kept (`exchange`), 2 with lone surrogates kept
	 * as well
	 */
	#crossing = 0;
	constructor(exports: MemberExports, route: RouteImport) {
		this.#exports = exports;
		this.#route = route;
	}
	/** the member's routing import: the host's routing of `len` bytes at `ptr`, written to its scratch */
	answerRoute(kind: number, ptr: number, len: number): number {
		const asked = this.#view(ptr, len);
		const text =
			this.#crossing === 0
				? decoder.decode(asked)
				: this.#crossing === 1
					? keeping.decode(asked)
					: decodeLoose(asked);
		const answer = this.#route(kind, text);
		if (answer === null) return -1;
		const { s: sized, b: scratch } = this.#exports;
		if (sized) {
			// a scratch the module makes as large as the answer,
			// written where it stands
			if (!wellFormed(answer)) {
				// the answer to the call then holds one too
				this.#crossing = 2;
				const loose = encodeLoose(answer);
				this.#view(sized(loose.length), loose.length).set(loose);
				return loose.length;
			}
			const room = answer.length * 3;
			return encoder.encodeInto(answer, this.#view(sized(room), room)).written;
		}
		if (!scratch) return -1;
		const bytes = encoder.encode(answer);
		if (bytes.length > this.#scratch) return -1;
		this.#view(scratch(), bytes.length).set(bytes);
		return bytes.length;
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
		const configure = this.#exports.c;
		if (!configure) throw new Error('wasm configure: this member takes none');
		const status = configure(...this.#give(encoder.encode(config)));
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
	/**
	 * `call` for a module with a kept input buffer (`i`, `x`): the text is
	 * encoded where the module reads it (no array and no allocation per
	 * call), and it comes back unit for unit: a byte order mark that leads
	 * the answer or the text of a routing call is kept, and a surrogate
	 * with no other half crosses as the three bytes of its code point, both
	 * ways. Status -1 when the module has no such buffer.
	 */
	exchange(
		input: string,
		flags: number,
	): { output: string } | { status: number } {
		const { i: buffer, x: run } = this.#exports;
		if (!buffer || !run) return { status: -1 };
		const loose = !wellFormed(input);
		let length: number;
		if (loose) {
			const bytes = encodeLoose(input);
			length = bytes.length;
			this.#view(buffer(length), length).set(bytes);
		} else {
			// a byte a unit for ASCII, which most text is; room for the rest
			// only when there is a rest
			let room = input.length + 8;
			const first = encoder.encodeInto(input, this.#view(buffer(room), room));
			length = first.written;
			if (first.read < input.length) {
				room = length + (input.length - first.read) * 3;
				length += encoder.encodeInto(
					input.slice(first.read),
					this.#view(buffer(room) + length, room - length),
				).written;
			}
		}
		// (kept and put back: the module can be entered again from a
		// routing call, and the call around this one goes on after it)
		const around = this.#crossing;
		this.#crossing = loose ? 2 : 1;
		let status: number;
		let crossed: number;
		try {
			status = run(length, flags);
		} finally {
			crossed = this.#crossing;
			this.#crossing = around;
		}
		if (status !== 0) return { status };
		const answer = this.#view(this.#exports.p(), this.#exports.n());
		return {
			output: crossed === 2 ? decodeLoose(answer) : keeping.decode(answer),
		};
	}
	/** how much linear memory the instance holds now (the core's, which its members share) */
	get memoryBytes(): number {
		return this.#exports.memory.buffer.byteLength;
	}
}
