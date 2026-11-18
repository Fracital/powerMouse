// A content blocker engine compiled from its lists by a rewrite worker
// (src/rewriteWorker.ts) for the service worker (src/server/blocker.ts):
// the compile is one call into the module of 220 to 280 ms for the default
// lists, which on the service worker's thread held every request of the
// pages it serves meanwhile. The module's one import (the registrable domain of a host,
// src/blocker/instance.ts) is never called while lists are added and
// compiled (measured: no call for the default lists, and the engine's bytes
// are the same as with the import), so it is answered with "unknown" here
// and the public suffix list stays out of the rewrite worker.

/** OP.addList and OP.build of src/blocker/instance.ts, which is not imported: it brings the suffix list */
const ADD_LIST = 1;
const BUILD = 2;

/** a list's text and the flags of its addList (FLAG_TRUSTED, FLAG_HOSTS) */
export interface EngineList {
	text: string;
	flags: number;
}

interface BuildExports {
	memory: WebAssembly.Memory;
	a(length: number): number;
	r(ptr: number, length: number, flags: number): number;
	p(): number;
	n(): number;
}

/** the serialized engine of `lists`, null when the module refuses them */
export function buildEngine(
	module: WebAssembly.Module,
	lists: EngineList[],
): Uint8Array<ArrayBuffer> | null {
	const instance = new WebAssembly.Instance(module, {
		e: { r: () => -1 },
	});
	const exports = instance.exports as unknown as BuildExports;
	const encoder = new TextEncoder();
	const call = (text: string, flags: number) => {
		const bytes = encoder.encode(text);
		const ptr = exports.a(bytes.length);
		if (bytes.length)
			new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
		return exports.r(ptr, bytes.length, flags);
	};
	for (const { text, flags } of lists) call(text, ADD_LIST | flags);
	if (call('', BUILD) !== 0) return null;
	return new Uint8Array(
		exports.memory.buffer,
		exports.p(),
		exports.n(),
	).slice();
}
