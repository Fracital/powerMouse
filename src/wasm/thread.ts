// The wasm modules a thread was handed and the one instance of each it
// runs. The controller loads every artifact once and hands it on: compiled,
// to each rewrite worker beside its REWRITE_PORT (REWRITE_MODULES), to a
// page's library and from there to its dedicated workers, and as bytes to
// the service worker with its handshake (ControllerInitMessage.modules, or
// a later CONTROLLER_MODULES when the load finished after it). Each thread
// instantiates a module here the first time a rewrite asks, keeps the
// instance for the next one, and replaces it when it has grown too large.
// Every caller falls back to the JavaScript rewriter when there is no
// instance: the module has not arrived, the host runs `rewriter: 'js'`, or
// the instance trapped.
import { BufferInstance, type RouteImport } from './module';

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
 * past the thread's limit is dropped, and the next call gets a new one
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

let memoryLimit = PAGE_MEMORY_LIMIT;

/** this thread keeps an instance that holds up to `bytes` (the service worker and the rewrite workers say so; a suite forces it low) */
export function setMemoryLimit(bytes: number): void {
	memoryLimit = bytes;
}

const modules = new Map<string, WebAssembly.Module>();
const instances = new Map<string, BufferInstance>();
/** the bytes each module was last compiled from, by length and hash: every handshake of every tab carries them again */
const compiledFrom = new Map<string, string>();
/** the compiles in flight */
const pending = new Set<Promise<void>>();

/** `module` is this thread's copy of the artifact `name` (an Assets key); a new one replaces the old and its instance */
export function adoptModule(name: string, module: WebAssembly.Module): void {
	if (modules.get(name) === module) return;
	modules.set(name, module);
	instances.delete(name);
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
	try {
		const module = await WebAssembly.compile(bytes);
		// a newer handshake's bytes won while these compiled
		if (compiledFrom.get(name) === print) adoptModule(name, module);
	} catch (error) {
		if (compiledFrom.get(name) === print) compiledFrom.delete(name);
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

/** whether this thread holds the module `name` at all */
export function hasModule(name: string): boolean {
	return modules.has(name);
}

/**
 * The compiled module `name` itself, or null: for a caller that keeps
 * instances of its own (the blocker makes one per engine it loads, and
 * exchanges bytes with it where a BufferInstance exchanges text)
 */
export function moduleOf(name: string): WebAssembly.Module | null {
	return modules.get(name) ?? null;
}

/** the modules this thread holds, once every compile it was asked for has settled */
export async function heldModules(): Promise<string[]> {
	while (pending.size) await Promise.all(pending);
	return [...modules.keys()];
}

/** what answers each module's routing import during the call in hand */
const routes = new Map<string, RouteImport>();
/** the modules with a call in hand: an instance is not entered twice */
const busy = new Set<string>();

/**
 * This thread's instance of the module `name`, made on first use, or null
 * when the thread was never handed the module or it would not instantiate
 */
export function instanceOf(name: string): BufferInstance | null {
	const kept = instances.get(name);
	if (kept) return kept;
	const module = modules.get(name);
	if (!module) return null;
	try {
		const instance = new BufferInstance(
			module,
			(kind, text) => routes.get(name)?.(kind, text) ?? null,
		);
		instances.set(name, instance);
		return instance;
	} catch (error) {
		console.warn(`Stomp: the ${name} module did not instantiate`, error);
		return null;
	}
}

/** the instance of `name` is not used again (it trapped, or ended a call past the thread's memory limit) */
export function dropInstance(name: string): void {
	instances.delete(name);
}

/**
 * `work` run with this thread's instance of `name`, `route` answering the
 * module's routing import for as long as it runs. Null when there is no
 * instance, when the call trapped (a Rust panic aborts: the instance is
 * dead and dropped, the caller does the work in JavaScript this once, and
 * the next call gets a new instance) and when the instance is in a call
 * already: a route that rewrites something itself (a data: stylesheet
 * inside a stylesheet) would enter it again while its output is half
 * written, so that inner piece is the JavaScript rewriter's.
 *
 * An instance that ended the call holding more than the thread's memory
 * limit is dropped after the call as well, and only then: one that grows
 * past the limit during a call finishes it.
 */
export function withInstance<T>(
	name: string,
	work: (instance: BufferInstance) => T,
	route?: RouteImport,
): T | null {
	if (busy.has(name)) return null;
	const instance = instanceOf(name);
	if (!instance) return null;
	busy.add(name);
	if (route) routes.set(name, route);
	try {
		return work(instance);
	} catch (error) {
		dropInstance(name);
		console.warn(`Stomp: the ${name} module failed, rewriting in JS`, error);
		return null;
	} finally {
		busy.delete(name);
		routes.delete(name);
		if (instances.get(name) === instance && instance.memoryBytes > memoryLimit)
			dropInstance(name);
	}
}
