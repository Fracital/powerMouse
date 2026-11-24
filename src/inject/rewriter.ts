// The rewriters as the inject uses them: modifyJS, modifyCSS and the public
// suffix lookups, with the signatures of the originals, backed by the
// rewriter library. What a bundle carries of it is the light library
// (src/rewriterLight.ts): the glue of the wasm modules (scripts,
// stylesheets, the public suffix list), with no parser, printer or list of
// its own. A frame evaluates none of that either: it uses its top's copy,
// which lives in a realm no page code runs in
// (src/inject/dom/rewriterRealm.ts), and evaluates a copy of its own only
// when it has no such top (a sandboxed document without allow-same-origin,
// a worker), the first time it rewrites something.
//
// The JavaScript rewriter itself (meriyah, escodegen, css-tree, tldts and
// the rewriters on them, src/rewriterLib.ts) is in no bundle: it is the
// asset `rewriterLib`. A proxied top's shell loads that file before this
// bundle (src/rewriteHTML.ts), which takes the factory it assigned. With
// `rewriter: 'js'` the top's library is made from it; with `'wasm'` the top
// keeps it, and hands its text to the light library the first time a call
// needs it (a rewrite the module has not arrived for or declines, an error
// message's expression). A frame asks its top for that. Either way nothing
// under a top waits for a request. A realm with no such top (a worker, a
// frame under a top of another build) loads the file itself the first time a
// call needs it (for a dedicated worker handed the module, handModules: what
// its module has not arrived for or declines), with a synchronous request:
// every rewrite is synchronous, and the light library cannot fetch (its
// realm is usually detached, and a detached realm makes no request). The
// controller fetched the same URL when it started, so the answer comes from
// the HTTP cache.
//
// The library may be another realm's, so only strings, numbers and
// booleans cross: arguments are made strings here, results are checked to
// be what they should be, a failure comes back as a message and is thrown
// here as this realm's Error, and what the library logged is logged here.
import rewriterLib from 'stomp:rewriter-lib';
import { codecType, type Config } from '../config';
import { LAZY_CONTEXTS, MAY_ROUTE } from '../cssURL';
import { keepSource } from '../functionSource';
import { realmCacheMark } from '../memoryMark';
import type { ScriptSource } from '../rewriteJS';
import type { RewriterLib } from '../rewriterLight';
import { provideRewriters } from '../rewriters';
import { blobOriginPair, routeScopeList } from '../routeURL';
import type { ScriptType } from '../scriptRoutes';
import type StompURL from '../StompURL';
import {
	ACTIVATION_FACTORY,
	DEFERRED_FACTORY,
	LIGHT_FACTORY,
	PASSKEYS_FACTORY,
} from '../version';
import { keepCode, MAPPED } from './positionParts';
import { knownSite } from './sites';
import { trustedFunction } from './trusted';

// the globals a copy of the library made here reads, as they were when the
// bundle loaded (URL, Reflect and Function are the inject's snapshots)
const realm = {
	URL,
	Reflect,
	Function,
	atob: globalThis.atob,
	btoa: globalThis.btoa,
	TextEncoder: globalThis.TextEncoder,
	TextDecoder: globalThis.TextDecoder,
	// what a copy made here instantiates a module it is handed with (a
	// worker's: handModules): the constructors as they were, not what the
	// namespace object holds when the copy is first needed
	WebAssembly: {
		Module: globalThis.WebAssembly?.Module,
		Instance: globalThis.WebAssembly?.Instance,
	},
	// what the copy's syntax iterates (src/ownIterable.ts): this bundle's,
	// whose natives are the realm's before the page replaced any
	ownIterable,
};
const nativeConsole = globalThis.console;
/** WebAssembly.Module.exports as it was: throws for anything but a module */
const moduleExports = globalThis.WebAssembly?.Module?.exports;

// what the rewriter library is loaded with, taken when the bundle loads:
// the inject wraps these methods later, and a page may replace them
const requestOpen = XMLHttpRequest.prototype.open;
const requestSend = XMLHttpRequest.prototype.send;
const requestOverrideMime = XMLHttpRequest.prototype.overrideMimeType;
const requestStatus = Reflect.getOwnPropertyDescriptor(
	XMLHttpRequest.prototype,
	'status',
)!.get!;
const requestText = Reflect.getOwnPropertyDescriptor(
	XMLHttpRequest.prototype,
	'responseText',
)!.get!;
const requestTypeSet = Reflect.getOwnPropertyDescriptor(
	XMLHttpRequest.prototype,
	'responseType',
)?.set;
const requestResponse = Reflect.getOwnPropertyDescriptor(
	XMLHttpRequest.prototype,
	'response',
)?.get;
const Bytes = Uint8Array;
/** whether this realm is a worker's, whose synchronous request may answer an ArrayBuffer (a window's may not) */
const inWorker = typeof globalThis.document === 'undefined';
const clock = globalThis.performance;
const clockNow = clock?.now;
const now = (): number =>
	clockNow ? (Reflect.apply(clockNow, clock, []) as number) : 0;
const toSource = Function.prototype.toString;

/**
 * The document's light library's factory, when the shell loaded the asset
 * before this bundle (the service worker writes that script into a proxied
 * top's shell: rewriteHTML.ts). The file assigns it to a global the shell
 * made non-enumerable; it is taken and the name is gone here, while the
 * bundle loads, before the client exists and long before any page script.
 */
const givenLight: Function | null = taken(LIGHT_FACTORY);
/** the document bundle's deferred parts' function, the file's second statement, taken the same way */
const givenDeferred: Function | null = taken(DEFERRED_FACTORY);
/** the passkey provider's client's function, the file's third statement, taken the same way */
const givenPasskeys: Function | null = taken(PASSKEYS_FACTORY);
/** the activation gates' function, the file's last statement, taken the same way */
const givenActivation: Function | null = taken(ACTIVATION_FACTORY);

function taken(name: string): Function | null {
	const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, name);
	if (!descriptor) return null;
	Reflect.deleteProperty(globalThis, name);
	return typeof descriptor.value === 'function' ? descriptor.value : null;
}

type Factory = (realm?: Record<string, unknown>) => RewriterLib;

/** the light library's factory, once this realm has it (a worker's bundle carries it) */
let light: Factory | null =
	rewriterLib ?? (givenLight as Factory | null) ?? null;

/** the light library file's text, once this realm asked for it (lightFactory, deferredFactory) */
let fetched: string | null = null;

/** the file's deferred statements, in the order build.js writes them */
const DEFERRED_STATEMENTS = [
	DEFERRED_FACTORY,
	PASSKEYS_FACTORY,
	ACTIVATION_FACTORY,
];

/**
 * The file's statements: the light library's, then the document bundle's
 * deferred ones in DEFERRED_STATEMENTS' order (build.js writes each after a
 * line break, and no line of another starts with its global assignment), null
 * for one the file does not have. The protected demo site's file
 * (scripts/build-demo-site.mjs) has each statement on a line of its own that
 * assigns the name bare (`<name>=function...;`), its strings' pool inside
 * the function
 */
function fileStatements(): (string | null)[] {
	const file = (fetched ??= fetchLibrary().source);
	const starts = DEFERRED_STATEMENTS.map((name) => {
		const at = file.lastIndexOf(`\nglobalThis.${name}=`);
		return at === -1 ? file.lastIndexOf(`\n${name}=`) : at;
	});
	const statements: (string | null)[] = [];
	let end = file.length;
	for (let index = starts.length - 1; index >= 0; index--) {
		const at = starts[index];
		if (at === -1 || at >= end) {
			statements[index + 1] = null;
			continue;
		}
		statements[index + 1] = file.slice(at + 1, end);
		end = at;
	}
	statements[0] = file.slice(0, end);
	return statements;
}

/**
 * The light library's factory. A worker's bundle carries it; a document's
 * does not (a frame uses its top's library and evaluates none): it is the
 * asset `rewriterLib` (now the light library alone), which a top's shell
 * loaded. Anywhere else (a frame's own copy, a top whose shell did not load
 * the file) it is made from the file's text: its top's, or the file's, asked
 * for with one synchronous request, and evaluated here as the body of a
 * function that has the name as its parameter, which writes no global.
 * Throws when it cannot be had.
 */
export function lightFactory(): Factory {
	if (light) return light;
	const made = evaluated(statementText(LIGHT_FACTORY)!, LIGHT_FACTORY);
	if (typeof made !== 'function')
		throw new Error('Stomp: the rewriterLib asset has no light library');
	light = made as Factory;
	return light;
}

/**
 * The function `statement` (`<name>=function...;`) assigns, evaluated here
 * as the body of a function that has the name as its parameter, which
 * writes no global; where this realm's policy refuses code made from a
 * string, run as a script of its own (sharing.factory). `sourceURL` names
 * the code (a comment the text ends with), so the stack cleaner knows its
 * frames for the inject's (Unroute).
 */
function evaluated(statement: string, name: string, sourceURL = ''): unknown {
	try {
		if (sharing.evaluates?.() === false) throw new Error('no eval');
		const local = statement.replace(`globalThis.${name}=`, `${name}=`);
		const body = `${local}\n;return ${name};${sourceURL}`;
		// (eval of a trusted value where Trusted Types are in use: trusted.ts)
		return (
			(trustedFunction(globalThis, [name], body) ??
				Reflect.construct(realm.Function, [name, body])) as () => unknown
		)();
	} catch (error) {
		// a document whose script policy refuses eval: a script of its own
		return sharing.factory?.(`${statement}${sourceURL}`, name) ?? null;
	}
}

/**
 * The parts' statement with the group (build.js partsStatement) that has
 * `part` its only case, null where no group has it: the function of the
 * whole statement, made from its text, was some 11 KB of each frame that
 * needed one part, though it ran one group (a top's shell loaded the whole
 * statement as a script)
 */
function partGroup(text: string, part: string): string | null {
	const at = text.indexOf(`case "${part}":`);
	return at === -1
		? null
		: text.slice(0, text.indexOf('\n')) +
				text.slice(
					text.lastIndexOf('\n', at),
					text.indexOf('\n}break;', at) + 8,
				) +
				'}return __stompParts.made;};';
}

/** the deferred statements' functions, once this realm has them (deferredFactory), by name */
const deferredMade = new Map<string, Function>();
if (givenDeferred) deferredMade.set(DEFERRED_FACTORY, givenDeferred);
if (givenPasskeys) deferredMade.set(PASSKEYS_FACTORY, givenPasskeys);
if (givenActivation) deferredMade.set(ACTIVATION_FACTORY, givenActivation);

/**
 * Whether this realm holds the deferred parts' whole function already (a
 * proxied top's shell loaded it), so a part costs no request and no text
 */
export const deferredHeld = (): boolean => deferredMade.has(DEFERRED_FACTORY);

/**
 * The function of one of the light library's file's deferred statements
 * (src/inject/dom/deferred.ts): the document bundle's deferred parts'
 * (DEFERRED_FACTORY), the passkey provider's client's (PASSKEYS_FACTORY) or
 * the activation gates' (ACTIVATION_FACTORY),
 * each a statement of its own so a realm compiles only the one it needs: the
 * one a top's shell loaded, else made here from its text (the top's, or the
 * file's, asked for with the light library's one synchronous request) as
 * lightFactory makes that library. Given a `part`, a realm without the
 * parts' function makes that part's group alone (partGroup). Throws when it
 * cannot be had.
 */
export function deferredFactory(
	name: string = DEFERRED_FACTORY,
	part?: string,
	// false: only a text this realm or the realm above holds, never the
	// file's synchronous request (src/inject/dom/deferred.ts partAtHand)
	ask = true,
): (shared: unknown, part?: string) => unknown {
	let made = deferredMade.get(name);
	if (!made) {
		const text = statementText(name, ask);
		const group = text !== null && part ? partGroup(text, part) : null;
		// named as the file the statement is in: the stack cleaner drops the
		// frames of the inject's own files
		const url = libraryURL?.();
		const value =
			text === null
				? null
				: evaluated(group ?? text, name, url ? `\n//# sourceURL=${url}` : '');
		if (typeof value !== 'function')
			throw new Error(`Stomp: the rewriterLib asset has no ${name}`);
		if (group !== null) return value as (shared: unknown) => unknown;
		made = value;
		deferredMade.set(name, made);
	}
	return made as (shared: unknown, part?: string) => unknown;
}

/** one of the file's statements (fileStatements), by its name: the top's, or the file's */
function statementText(name: string, ask = true): string | null {
	try {
		const held: unknown =
			name === LIGHT_FACTORY
				? sharing.lightText?.()
				: sharing.deferredText?.(name);
		if (typeof held === 'string') return held;
	} catch (error) {
		// the realm above is gone or of another kind: this one asks
	}
	if (!ask && fetched === null) return null;
	return fileStatements()[DEFERRED_STATEMENTS.indexOf(name) + 1] ?? null;
}

/**
 * A deferred statement (deferredFactory), for a document under this top
 * that evaluates it: null where this realm has not had it yet. A realm that
 * made only groups of the parts' asks for it again where it had it (a copy
 * of the top's text would be one of its own)
 */
export function deferredText(name: string = DEFERRED_FACTORY): string | null {
	const made = deferredMade.get(name);
	if (made) return `${name}=${Reflect.apply(toSource, made, []) as string};`;
	return name === DEFERRED_FACTORY ? statementText(name) : null;
}

/**
 * The light library's statement, for a document under this top that makes
 * a copy of its own: null where this realm has none
 */
export function lightText(): string | null {
	return light && !rewriterLib
		? `${LIGHT_FACTORY}=${Reflect.apply(toSource, light, []) as string};`
		: null;
}

/** how this bundle's first client lets its rewrites share (shareRewriter) */
export interface RewriterSharing {
	/**
	 * The light library's statement from the realm above this one (a frame's
	 * top holds it), for this realm's own copy (lightFactory)
	 */
	lightText?: () => string | null;
	/** a deferred statement from the realm above, by its name (deferredFactory) */
	deferredText?: (name: string) => string | null;
	/**
	 * The function the statement `text` assigns to `name` (the light
	 * library's factory, the deferred parts'), made in this realm where this
	 * realm's own copy cannot make it from the text (a document whose script
	 * policy refuses eval, src/inject/dom/rewriterRealm.ts); null where it can
	 */
	factory?: (text: string, name?: string) => Function | null;
	/**
	 * The core module the controller compiled, where this realm reaches the
	 * window it left it on (StompController publishCore): taken in place of
	 * a synchronous request for the bytes and a compile of them here
	 * (provideModule). Anything, or nothing: the caller checks it is a module
	 */
	module?: () => unknown;
	/**
	 * Whether this realm may make code from a string: where its policy
	 * refuses it (src/csp.ts), the factory makes the library at once, since
	 * the browser reports every refused attempt to the page
	 */
	evaluates?: () => boolean;
}

let own: RewriterLib | null = null;
let shared: (() => RewriterLib | null) | null = null;
let sharing: RewriterSharing = {};
let libraryURL: (() => string) | null = null;
let coreURL: (() => string) | null = null;

/**
 * Where this bundle's rewrites go when they can share a library: `provider`
 * answers the library to use for the next call, or null for this realm's
 * own copy. Taken by the bundle's first client, which is its realm's own
 * document (a client this bundle makes for an about:blank window it injects
 * shares this bundle and its library). False when one was taken already.
 */
export function shareRewriter(
	provider: () => RewriterLib | null,
	how: RewriterSharing = {},
): boolean {
	if (shared) return false;
	shared = provider;
	sharing = how;
	return true;
}

/**
 * Where the light library asset is (routeURL.ts rewriterLibJS), said by the
 * bundle's first client: read when this realm's own copy first needs it (a
 * worker, a sandboxed frame; a document under a top uses the top's)
 */
export function rewriterLibraryAt(url: () => string): void {
	libraryURL ??= url;
}

/**
 * Where the rewriter's wasm core module is (routeURL.ts coreWasm), said by
 * the bundle's first client: fetched and compiled here when a rewrite is
 * needed before the controller's compiled module has arrived (requestModules)
 */
export function coreModuleAt(url: () => string): void {
	coreURL ??= url;
}

/** loads that failed in a row: a host that stopped serving an asset is not asked on every rewrite */
let failedLoads = 0;
const LOAD_ATTEMPTS = 3;

/**
 * Give `lib` the rewriter's wasm core module, for a rewrite needed before the
 * controller's compiled module has arrived in this realm (a page's first task
 * often rewrites something: eval, new Function, an inline script or style, a
 * `javascript:` URL in its markup). The controller left the module on its
 * window, which a document of its agent cluster reaches (a top in its frame,
 * a frame under one, a window one opened): it is taken from there. Anywhere
 * else (a tab opened with noopener) the bytes are fetched with one
 * synchronous request (the controller fetched the same URL when it started,
 * so the answer is in the HTTP cache) and compiled here with the native
 * WebAssembly taken before the page wrapped it. `lib` reads no property of
 * the module and only instantiates it. The controller's module, posted
 * compiled, replaces this one when it arrives. Throws when the module cannot
 * be had or compiled (a page whose policy refuses WebAssembly, where the
 * codec module could not compile either).
 */
export function provideModule(lib: RewriterLib): void {
	if (lib.holds('core')) return;
	const reached = controllerModule();
	if (reached && lib.adopt('core', reached)) return;
	if (failedLoads >= LOAD_ATTEMPTS)
		throw new Error('Stomp: the rewriter module did not load');
	failedLoads++;
	const started = now();
	const bytes = fetchCoreBytes();
	const Module = realm.WebAssembly.Module;
	if (!Module) throw new Error('Stomp: no WebAssembly to compile the module');
	const module = Reflect.construct(Module, [bytes]) as WebAssembly.Module;
	lib.adopt('core', module);
	coreLoads.requests++;
	coreLoads.ms += now() - started;
	failedLoads = 0;
}

/** how this realm had the core module: taken from the controller's window (controllerModule), or asked for with a request and compiled (provideModule) */
const coreLoads = { reached: 0, requests: 0, ms: 0 };

/**
 * The module the controller left on its window, when this realm reaches it
 * and it is one: a value that is no WebAssembly.Module (the check reads its
 * internal slot, whatever realm made it) is not taken. A top takes it when
 * its client is made (DocumentClient), and a rewrite that finds its library
 * without one when it needs it (provideModule).
 */
export function controllerModule(): WebAssembly.Module | null {
	let found: unknown;
	try {
		found = sharing.module?.();
		if (!found || !moduleExports) return null;
		Reflect.apply(moduleExports, null, [found]);
	} catch (error) {
		return null;
	}
	coreLoads.reached++;
	return found as WebAssembly.Module;
}

/**
 * The core module's bytes, with one synchronous request. A worker's answers
 * an ArrayBuffer; a window's synchronous XHR cannot ask for one, so there
 * the bytes are read as a `x-user-defined` string and unpacked a byte at a
 * time. Throws when the asset cannot be had.
 */
function fetchCoreBytes(): Uint8Array {
	const url = coreURL?.();
	if (!url) throw new Error('Stomp: no rewriter module to load');
	const request = new XMLHttpRequest();
	Reflect.apply(requestOpen, request, ['GET', url, false]);
	const buffered = inWorker && !!requestTypeSet && !!requestResponse;
	if (buffered) Reflect.apply(requestTypeSet, request, ['arraybuffer']);
	else
		Reflect.apply(requestOverrideMime, request, [
			'text/plain; charset=x-user-defined',
		]);
	Reflect.apply(requestSend, request, []);
	const status: unknown = Reflect.apply(requestStatus, request, []);
	if (status !== 200)
		throw new Error(
			`Stomp: the rewriter module did not load (HTTP ${String(status)})`,
		);
	if (buffered)
		return new Bytes(
			Reflect.apply(requestResponse, request, []) as ArrayBuffer,
		);
	const binary = text(Reflect.apply(requestText, request, []));
	const bytes = new Bytes(binary.length);
	for (let i = 0; i < binary.length; i++)
		bytes[i] = binary.charCodeAt(i) & 0xff;
	return bytes;
}

/**
 * The light library's file, with one synchronous request for the asset,
 * which the calling script waits for. Throws when it cannot be had.
 */
function fetchLibrary(): { source: string; waited: number } {
	if (failedLoads >= LOAD_ATTEMPTS)
		throw new Error('Stomp: the rewriter library did not load');
	failedLoads++;
	const url = libraryURL?.();
	if (!url) throw new Error('Stomp: no rewriter library to load');
	const started = now();
	const request = new XMLHttpRequest();
	Reflect.apply(requestOpen, request, ['GET', url, false]);
	Reflect.apply(requestSend, request, []);
	const status: unknown = Reflect.apply(requestStatus, request, []);
	if (status !== 200)
		throw new Error(
			`Stomp: the rewriter library did not load (HTTP ${String(status)})`,
		);
	const source = text(Reflect.apply(requestText, request, []));
	failedLoads = 0;
	return { source, waited: now() - started };
}

/**
 * This realm's own copy of the light library, evaluated the first time it is
 * needed: a worker's, a sandboxed frame's, a frame under a top of another
 * build (src/inject/rewriter.ts).
 */
export function ownRewriter(): RewriterLib {
	if (own) return own;
	const lib = lightFactory()(realm);
	own = lib;
	if (handed) adoptHanded(lib, handed);
	return lib;
}

/** the compiled wasm modules this realm's own copy rewrites with (handModules) */
let handed: Record<string, unknown> | null = null;

function adoptHanded(lib: RewriterLib, modules: Record<string, unknown>) {
	for (const name in modules)
		try {
			lib.adopt(name, modules[name]);
		} catch (error) {
			// not a module this copy can hold: the rewriter library answers
		}
}

/**
 * The compiled wasm modules (`rewriter: 'wasm'`, by Assets key) this
 * realm's own copy of the library rewrites with, from the context that
 * started this one: a dedicated worker's, which shares no library with
 * anyone. They are adopted when the copy exists, so a worker that never
 * rewrites anything evaluates no library for them.
 */
export function handModules(modules: Record<string, unknown>): void {
	handed = modules;
	if (own) adoptHanded(own, modules);
}

function library(): RewriterLib {
	return shared?.() ?? ownRewriter();
}

/**
 * `work` asked of the library for this realm's next call. When the call
 * stopped because the library it was asked of holds no wasm module yet (a
 * rewrite early in the realm's life, before the controller's compiled module
 * arrived), the module is fetched and compiled here (provideModule) and the
 * call is made again. A frame's rewrite adopts into its top's shared library,
 * so one fetch serves the frames too.
 */
export function ask<T>(work: (lib: RewriterLib) => T): [RewriterLib, T] {
	const lib = library();
	const result = work(lib);
	if (lib.needs() !== true) return [lib, result];
	provideModule(lib);
	return [lib, work(lib)];
}

/**
 * How the rewrites of the library this realm uses went, as numbers (see
 * LibraryLoader.count in src/rewriterLib.ts): `answered` by the wasm
 * module, `declined` by it, `early` for it, `library` calls the rewriter
 * library answered, `loads` of that library for a call that needed it,
 * the `requests` among them (a synchronous request the call waited for)
 * and the `ms` they waited; and of this realm's own: the core modules it
 * took from the controller's window (`coreReached`), the ones it asked for
 * with a synchronous request and compiled (`coreRequests`) and the `coreMs`
 * those took (provideModule). @internal (tests, the demo)
 */
export function rewriteCounts(): {
	answered: number;
	declined: number;
	early: number;
	library: number;
	loads: number;
	requests: number;
	ms: number;
	coreReached: number;
	coreRequests: number;
	coreMs: number;
} {
	const lib = library();
	const count = (which: number) => Number(lib.count(which)) || 0;
	return {
		answered: count(0),
		declined: count(1),
		early: count(2),
		library: count(3),
		loads: count(4),
		requests: count(6),
		ms: count(5),
		coreReached: coreLoads.reached,
		coreRequests: coreLoads.requests,
		coreMs: coreLoads.ms,
	};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : String(value);
}

/** what a rewrite depends on, as the library reads it (rewriterLib.ts Context) */
function contextOf(url: StompURL, config: Config | null): string {
	return JSON.stringify([
		url.url.href,
		codecType(url.codec),
		url.codec.key,
		url.directory,
		config,
		blobOriginPair(),
		routeScopeList(),
		url.mark ?? realmCacheMark(),
	]);
}

/** replay what the call logged (whether it did), throw what it threw */
function settle(lib: RewriterLib, failed: boolean): boolean {
	const logged = lib.messages();
	if (logged)
		for (const [level, message] of JSON.parse(logged) as [string, string][])
			(level === 'error'
				? nativeConsole.error
				: level === 'warn'
					? nativeConsole.warn
					: nativeConsole.log
			).call(nativeConsole, message);
	if (failed) throw new Error(text(lib.error()) || 'Stomp: rewrite failed');
	return !!logged;
}

function checked<T>(value: unknown, kind: 'string' | 'boolean'): T {
	if (typeof value !== kind)
		throw new TypeError('Stomp: the rewriter library answered no ' + kind);
	return value as T;
}

/** the map the last rewrite asked for apart handed over */
export let apartMap = '';

export function modifyJS(
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType = 'generic',
	preamble = '',
	source?: ScriptSource,
): string {
	const context = contextOf(url, config);
	const [lib, result] = ask<unknown>((lib) =>
		lib.js(
			context,
			text(script),
			text(type),
			text(preamble),
			source === undefined ? '' : JSON.stringify(source),
		),
	);
	settle(lib, result === null);
	for (let i = 0, count = Number(lib.keptCount()); i < count; i++)
		keepSource(text(lib.keptKey(i)), text(lib.keptText(i)));
	const output = checked<string>(result, 'string');
	// (its positions read as its own: the light library asks for the map
	// apart, ScriptSource.apart)
	apartMap = text(lib.positions());
	if (source !== MAPPED) keepCode(apartMap, source, output);
	return output;
}

export function modifyCSS(
	script: string,
	url: StompURL,
	context = 'stylesheet',
): string {
	// what the library does first (rewriteCSS.ts), done here: most inline
	// styles a page writes hold nothing to route, and the call (the context
	// serialised, the trip to the library's realm) cost more than the check
	const source = text(script);
	const kind = text(context);
	if (LAZY_CONTEXTS.includes(kind) && !MAY_ROUTE.test(source)) return source;
	const routing = contextOf(url, null);
	// an inline style with a url() comes back each time its element is made
	// again (Google's suggestion thumbnails, on every keystroke), and the
	// library parses it in full: the same text in the same context is the
	// same rewrite, kept unless the library logged something
	const key = `${kind}\n${routing}\n${source}`;
	const kept = cssMemo.get(key);
	if (kept !== undefined) {
		cssMemo.delete(key);
		cssMemo.set(key, kept);
		return kept;
	}
	const [lib, result] = ask<unknown>((lib) => lib.css(routing, source, kind));
	const logged = settle(lib, result === null);
	const output = checked<string>(result, 'string');
	if (!logged && key.length + output.length <= CSS_MEMO_ENTRY) {
		cssMemo.set(key, output);
		cssMemoChars += key.length + output.length;
		for (const [old, value] of cssMemo) {
			if (cssMemoChars <= CSS_MEMO_CHARS) break;
			cssMemo.delete(old);
			cssMemoChars -= old.length + value.length;
		}
	}
	return output;
}

/** recent CSS rewrites by kind, context and text (modifyCSS), oldest first */
const cssMemo = new Map<string, string>();
let cssMemoChars = 0;
const CSS_MEMO_CHARS = 64 * 1024;
const CSS_MEMO_ENTRY = 8 * 1024;

/** whether `code` parses as a script of one expression statement */
export function singleExpression(code: string): boolean {
	const [lib, result] = ask<unknown>((lib) => lib.singleExpression(text(code)));
	settle(lib, false);
	return checked<boolean>(result, 'boolean');
}

/** whether `code` parses as a classic script */
export function parsesAsScript(code: string): boolean {
	const [lib, result] = ask<unknown>((lib) => lib.parsesAsScript(text(code)));
	settle(lib, false);
	return checked<boolean>(result, 'boolean');
}

function nullableString(value: unknown): string | null {
	return value === null ? null : checked<string>(value, 'string');
}

/**
 * What V8 names a part of a page's expression by in an error's message
 * (src/callPrinter.ts), or null when the source does not parse
 */
export function printExpression(source: string, part: string): string | null {
	const [lib, result] = ask<unknown>((lib) =>
		lib.print(text(source), text(part)),
	);
	settle(lib, false);
	return nullableString(result);
}

/**
 * tldts getDomain with the private domains: the registrable domain of
 * `host`, or null. What the shell said of the host answers
 * (src/inject/sites.ts); the library's list is asked about any other.
 */
export function getDomain(host: string): string | null {
	const known = knownSite(host, 0);
	if (known !== undefined) return known;
	const [lib, result] = ask<unknown>((lib) => lib.domain(text(host)));
	settle(lib, false);
	return nullableString(result);
}

/**
 * tldts getPublicSuffix with the private domains: the public suffix of
 * `host`, or null
 */
export function getPublicSuffix(host: string): string | null {
	const known = knownSite(host, 1);
	if (known !== undefined) return known;
	const [lib, result] = ask<unknown>((lib) => lib.publicSuffix(text(host)));
	settle(lib, false);
	return nullableString(result);
}

provideRewriters({ modifyJS, modifyCSS, singleExpression });
