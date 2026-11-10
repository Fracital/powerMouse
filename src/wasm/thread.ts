// The wasm modules a thread was handed and the one instance of each it
// runs. The controller loads every artifact once and hands it on: compiled,
// to each rewrite worker beside its REWRITE_PORT (REWRITE_MODULES), and as
// bytes to the service worker with its handshake
// (ControllerInitMessage.modules, or a later CONTROLLER_MODULES when the
// load finished after it). Each thread instantiates a module here, once,
// the first time a rewrite asks. Every caller falls back to the JavaScript
// rewriter when there is no instance: the module has not arrived, the host
// runs `rewriter: 'js'`, or the instance trapped.
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
 * Past this much linear memory an instance is dropped after its call and
 * the next call gets a fresh one from the same compiled module: wasm memory
 * never shrinks, and one 13 MB script would leave tens of MB behind in a
 * service worker that lives for hours
 */
export const MEMORY_LIMIT = 64 * 1024 * 1024;

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

/** the instance of `name` is not used again (it trapped, or grew too large) */
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
 * written, so that inner piece is the JavaScript rewriter's. An instance
 * that grew past MEMORY_LIMIT is dropped after the call as well.
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
		if (instances.get(name) === instance && instance.memoryBytes > MEMORY_LIMIT)
			dropInstance(name);
	}
}
