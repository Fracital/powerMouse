// The wasm modules a thread was handed and the instances of each it runs.
// The controller loads every artifact once and hands it on: compiled, to
// each rewrite worker beside its REWRITE_PORT (REWRITE_MODULES), to a
// page's library and from there to its dedicated workers, and as bytes to
// the service worker with its handshake (ControllerInitMessage.modules, or
// a later CONTROLLER_MODULES when the load finished after it). The JS
// rewriter, the scanner and the suffix lookup are members of one module,
// the core (rust/core-module): an instance of it serves a call of any of
// them. Each thread instantiates a module here the first time a call asks,
// keeps the instance for the next one, and replaces it when it has grown
// too large. Every caller falls back to the JavaScript rewriter when there
// is no instance: the module has not arrived, the host runs
// `rewriter: 'js'`, or the instance trapped.
import {
	compileModuleSync,
	CoreInstance,
	MEMBERS,
	type BufferInstance,
	type MemberName,
	type RouteImport,
} from './module';

/** the Assets key of the module that holds the members (src/config.ts) */
export const CORE = 'core';

/** the module a name stands for: a member's is the core's, a module's its own */
const moduleName = (name: string): string =>
	Object.hasOwn(MEMBERS, name) ? CORE : name;

/**
 * What a thread is handed for a module. A dedicated worker shares its
 * owner's agent cluster and takes the compiled module. A service worker is
 * an agent cluster of its own: a WebAssembly.Module posted to it never
 * arrives (Chrome 152 fires `messageerror` for the whole message, which in
 * a handshake would lose the controller), so it takes the bytes and
 * compiles them itself, off the main thread like every compile.
 */
export type ModuleGiven = WebAssembly.Module | ArrayBuffer;

/**
 * How much linear memory an instance may hold between calls. wasm memory
 * never shrinks: an instance keeps what its largest script needed (10 to
 * 34 times the script's length; docs/rust-plan.md, Instance memory) until
 * it is dropped, and a new one costs 0.1 to 0.3 ms. One that ends a call
 * past the thread's limit is not kept, and the next call gets a new one
 * from the same compiled module.
 *
 * A page's library and a dedicated worker rewrite what the page evaluates,
 * mostly a few lines at a time, and there is one of them for every tab and
 * every worker: they keep at most 8 MB, which is what a script of 250 to
 * 300 KB leaves behind.
 */
export const PAGE_MEMORY_LIMIT = 8 * 1024 * 1024;
/**
 * The service worker and the rewrite workers rewrite a site's scripts, one
 * large one after another, where a new instance costs 0.2 to 1.2 ms for
 * every MB it has to grow again (37% over the 28 corpus scripts): they
 * keep up to 64 MB, which every script up to 1.4 MB fits in, and a 12 MB
 * bundle costs its 200 MB for the one rewrite and then nothing.
 */
export const SERVING_MEMORY_LIMIT = 64 * 1024 * 1024;
/**
 * The instances of the core a thread runs at a time: a rewrite made
 * during a rewrite (a `data:` stylesheet a stylesheet imports, a `data:`
 * module a module imports, each rewritten from inside the routing call of
 * the one around it) runs in an instance of its own, and so does one inside
 * that. Deeper than this the JavaScript rewriter has the piece, so a page
 * that nests them without end makes a thread hold four instances and no
 * more.
 */
export const INSTANCES = 4;

let memoryLimit = PAGE_MEMORY_LIMIT;

/** this thread keeps an instance that holds up to `bytes` (the service worker and the rewrite workers say so; a suite forces it low) */
export function setMemoryLimit(bytes: number): void {
	memoryLimit = bytes;
}

/**
 * An instance of the core module, and what answers its member's routing
 * import during the call it is in (one member's: a call made during it
 * takes another instance)
 */
interface Held {
	instance: CoreInstance;
	module: WebAssembly.Module;
	route: RouteImport | undefined;
}

const modules = new Map<string, WebAssembly.Module>();
/**
 * The bytes each module was handed as, kept until its asynchronous compile
 * settles: a thread that holds the bytes but not yet the compiled module
 * compiles them synchronously the first time a call needs it
 * (src/wasm/module.ts compileModuleSync), so a rewrite early in a thread's
 * life is never answered without the module. The compiled module replaces
 * the bytes when it is in. This is what the JavaScript rewriter used to
 * answer in the window before the module compiled.
 */
const rawBytes = new Map<string, ArrayBuffer>();
/** the instances of each module that are in no call, the one last used last */
const idle = new Map<string, Held[]>();
/** how many calls each module has in hand (one inside another) */
const calls = new Map<string, number>();
/** the bytes each module was last compiled from, by length and hash: every handshake of every tab carries them again */
const compiledFrom = new Map<string, string>();
/** the compiles in flight */
const pending = new Set<Promise<void>>();

/**
 * `module` is this thread's copy of the artifact `name` (an Assets key); a
 * new one replaces the old and its instances (one in a call finishes the
 * call and is not kept)
 */
export function adoptModule(name: string, module: WebAssembly.Module): void {
	if (modules.get(name) === module) return;
	modules.set(name, module);
	// the compiled module wins over any bytes kept for the sync fallback
	rawBytes.delete(name);
	idle.delete(name);
}

function fingerprint(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let hash = 0x811c9dc5;
	for (let i = 0; i < view.length; i++)
		hash = Math.imul(hash ^ view[i], 0x01000193);
	return `${view.length}.${hash >>> 0}`;
}

async function adoptBytes(name: string, bytes: ArrayBuffer): Promise<void> {
	const print = fingerprint(bytes);
	if (compiledFrom.get(name) === print) return;
	compiledFrom.set(name, print);
	// kept at once (before the await) so a rewrite on this thread before the
	// compile settles has the bytes to compile synchronously (instantiate)
	if (!modules.has(name)) rawBytes.set(name, bytes);
	try {
		const module = await WebAssembly.compile(bytes);
		// a newer handshake's bytes won while these compiled
		if (compiledFrom.get(name) === print) adoptModule(name, module);
	} catch (error) {
		if (compiledFrom.get(name) === print) {
			compiledFrom.delete(name);
			if (rawBytes.get(name) === bytes) rawBytes.delete(name);
		}
		console.warn(`Stomp: the ${name} module did not compile`, error);
	}
}

/**
 * Every module of a handshake, as the message carries them: adopted at
 * once when compiled, once its bytes compiled otherwise (the same bytes
 * again are the module the thread has). Settles when all of them are in.
 */
export async function adoptModules(
	given: Record<string, ModuleGiven> | undefined,
): Promise<void> {
	if (!given) return;
	const compiles: Promise<void>[] = [];
	for (const [name, module] of Object.entries(given))
		if (module instanceof WebAssembly.Module) adoptModule(name, module);
		else if (module instanceof ArrayBuffer)
			compiles.push(adoptBytes(name, module));
	if (!compiles.length) return;
	const all = Promise.all(compiles).then(() => {});
	pending.add(all);
	await all;
	pending.delete(all);
}

/** whether this thread holds the module `name` at all (a member: the core), compiled or as bytes it can compile synchronously */
export function hasModule(name: string): boolean {
	const which = moduleName(name);
	return modules.has(which) || rawBytes.has(which);
}

/**
 * The compiled module `name` itself, or null: for a caller that keeps
 * instances of its own (the blocker makes one per engine it loads, and
 * exchanges bytes with it where a BufferInstance exchanges text)
 */
export function moduleOf(name: string): WebAssembly.Module | null {
	return modules.get(name) ?? null;
}

/** the modules this thread holds, once every compile it was asked for has settled (bytes not yet compiled count: a call compiles them synchronously) */
export async function heldModules(): Promise<string[]> {
	while (pending.size) await Promise.all(pending);
	return [...new Set([...modules.keys(), ...rawBytes.keys()])];
}

/**
 * The compiled core module this thread holds: the one it was handed, or one
 * compiled synchronously (and kept) from the bytes it holds when its
 * asynchronous compile has not settled. Null when it holds neither.
 */
function coreModule(): WebAssembly.Module | null {
	const module = modules.get(CORE);
	if (module) return module;
	const bytes = rawBytes.get(CORE);
	if (!bytes) return null;
	try {
		const compiled = compileModuleSync(bytes);
		adoptModule(CORE, compiled);
		return compiled;
	} catch (error) {
		rawBytes.delete(CORE);
		console.warn(`Stomp: the ${CORE} module did not compile`, error);
		return null;
	}
}

/** a new instance of the core module, or null when the thread was never handed it or it would not instantiate */
function instantiate(): Held | null {
	const module = coreModule();
	if (!module) return null;
	try {
		const held: Held = {
			module,
			route: undefined,
			instance: new CoreInstance(
				module,
				(member, kind, text) => held.route?.(kind, text) ?? null,
			),
		};
		return held;
	} catch (error) {
		console.warn(`Stomp: the ${CORE} module did not instantiate`, error);
		return null;
	}
}

/**
 * `work` run with the member `name` of a core instance that is this call's
 * alone, `route` answering that member's routing import for as long as it
 * runs. The thread keeps the instance for the next call, of any member; a
 * call made during a call (a route that rewrites something itself, with
 * the same member or another) takes another, made when there is none, and
 * each route goes on answering its own call.
 *
 * Null when there is no instance, when INSTANCES calls are in hand already,
 * and when the call threw (a Rust panic aborts, and a route that throws
 * leaves the module's state half written): the caller does the work in
 * JavaScript this once, and whatever call is around this one goes on in an
 * instance of its own.
 *
 * An instance is only ever dropped here, after its own call returned: one
 * that threw, one whose module was replaced meanwhile, and one that ended
 * the call holding more than the thread's memory limit.
 */
export function withInstance<T>(
	name: MemberName,
	work: (instance: BufferInstance) => T,
	route?: RouteImport,
): T | null {
	const depth = calls.get(CORE) ?? 0;
	if (depth >= INSTANCES) return null;
	const held = idle.get(CORE)?.pop() ?? instantiate();
	if (!held) return null;
	held.route = route;
	calls.set(CORE, depth + 1);
	let keep = true;
	try {
		return work(held.instance.members[name]);
	} catch (error) {
		keep = false;
		console.warn(`Stomp: the ${name} module failed, rewriting in JS`, error);
		return null;
	} finally {
		held.route = undefined;
		calls.set(CORE, depth);
		if (
			keep &&
			held.module === modules.get(CORE) &&
			held.instance.memoryBytes <= memoryLimit
		) {
			const kept = idle.get(CORE);
			if (kept) kept.push(held);
			else idle.set(CORE, [held]);
		}
	}
}
