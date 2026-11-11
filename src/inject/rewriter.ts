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
import type { ScriptSource } from '../rewriteJS';
import type { RewriterLib } from '../rewriterLib';
import { provideRewriters } from '../rewriters';
import { blobOriginPair, routeScopeList } from '../routeURL';
import type { ScriptType } from '../scriptRoutes';
import type StompURL from '../StompURL';
import { LIBRARY_FACTORY } from '../version';
import { knownSite } from './sites';

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
};
const nativeConsole = globalThis.console;

// what the rewriter library is loaded with, taken when the bundle loads:
// the inject wraps these methods later, and a page may replace them
const requestOpen = XMLHttpRequest.prototype.open;
const requestSend = XMLHttpRequest.prototype.send;
const requestStatus = Reflect.getOwnPropertyDescriptor(
	XMLHttpRequest.prototype,
	'status',
)!.get!;
const requestText = Reflect.getOwnPropertyDescriptor(
	XMLHttpRequest.prototype,
	'responseText',
)!.get!;
const clock = globalThis.performance;
const clockNow = clock?.now;
const now = (): number =>
	clockNow ? (Reflect.apply(clockNow, clock, []) as number) : 0;
const toSource = Function.prototype.toString;

/**
 * The rewriter library's factory, when the document's shell loaded the
 * asset before this bundle (the service worker writes that script into a
 * proxied top's shell: rewriteHTML.ts). The file assigns it to a global
 * the shell made non-enumerable; it is taken and the name is gone here,
 * while the bundle loads, before the client exists and long before any
 * script of the page.
 */
const given: Function | null = (() => {
	const descriptor = Reflect.getOwnPropertyDescriptor(
		globalThis,
		LIBRARY_FACTORY,
	);
	if (!descriptor) return null;
	Reflect.deleteProperty(globalThis, LIBRARY_FACTORY);
	return typeof descriptor.value === 'function' ? descriptor.value : null;
})();

/**
 * That factory, which makes the library itself: with `rewriter: 'js'` a
 * top evaluates its text in the realm it shares as the whole of its
 * library (src/inject/dom/rewriterRealm.ts), which then never asks for
 * another, and so does a copy this realm makes for itself (ownRewriter).
 * Null without one.
 */
export function givenLibrary():
	((realm?: Record<string, unknown>) => RewriterLib) | null {
	return given as ((realm?: Record<string, unknown>) => RewriterLib) | null;
}

/**
 * The rewriter library's text, where this realm's shell loaded the file:
 * what a library that needs it is handed (a top's light library with
 * `rewriter: 'wasm'`, a sandboxed frame's own copy). Null without it.
 */
export function libraryText(): string | null {
	return given
		? `${LIBRARY_FACTORY}=${Reflect.apply(toSource, given, []) as string};`
		: null;
}

/** how this bundle's first client lets its rewrites share (shareRewriter) */
export interface RewriterSharing {
	/**
	 * The rewriter library loaded into a library the provider answered, by
	 * the realm that made it (a top, for the frames under it); false when
	 * that realm could not, and this one loads it itself
	 */
	load?: (library: RewriterLib) => boolean;
	/**
	 * The rewriter library's text from the realm above this one (a frame's
	 * top holds it), for this realm's own copy; null when it has none
	 */
	text?: () => string | null;
	/**
	 * The rewriter library's factory made from its text in this realm,
	 * where this realm's own copy cannot make it (a document whose script
	 * policy refuses eval, src/inject/dom/rewriterRealm.ts); null where it
	 * can
	 */
	factory?: (
		text: string,
	) => ((realm?: Record<string, unknown>) => RewriterLib) | null;
}

let own: RewriterLib | null = null;
let shared: (() => RewriterLib | null) | null = null;
let sharing: RewriterSharing = {};
let libraryURL: (() => string) | null = null;

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
 * Where the rewriter library asset is (routeURL.ts rewriterLibJS), said by
 * the bundle's first client: read when a call first needs the library
 */
export function rewriterLibraryAt(url: () => string): void {
	libraryURL ??= url;
}

/** loads that failed in a row: a host that stopped serving the asset is not asked on every rewrite */
let failedLoads = 0;
const LOAD_ATTEMPTS = 3;

/**
 * Load the rewriter library into `lib` from this realm: its text, which
 * `lib` evaluates in its own realm. The text is the one this realm's shell
 * loaded or the one its top holds; without either it is fetched with one
 * synchronous request for the asset, which the calling script waits for,
 * once per library. Throws when the asset cannot be had or is not the
 * library.
 */
export function loadRewriterLibrary(lib: RewriterLib): void {
	let source = libraryText();
	if (source === null && lib === own)
		try {
			const held: unknown = sharing.text?.();
			if (typeof held === 'string') source = held;
		} catch (error) {
			// the realm above is gone or of another kind: this one asks
		}
	// (negative: no request was made)
	let waited = -1;
	if (source === null) {
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
		source = text(Reflect.apply(requestText, request, []));
		waited = now() - started;
	}
	// this realm's own copy, in a document that may not evaluate a string:
	// the rewriter library takes its place
	const factory = lib === own ? sharing.factory?.(source) : null;
	if (factory) own = factory(realm);
	else settle(lib, lib.load(source, waited) !== true);
	failedLoads = 0;
}

/**
 * This realm's own copy of the library, evaluated the first time it is
 * needed: the rewriter library itself where the shell loaded it (a top
 * that could make no realm to share), else the bundle's light one.
 */
export function ownRewriter(): RewriterLib {
	if (own) return own;
	const lib = (givenLibrary() ?? rewriterLib)(realm);
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
 * stopped because the library it was asked of holds no rewriter library,
 * that is loaded (by the realm the library is shared from where it can:
 * a frame's own requests may be refused by its `allow` attribute) and the
 * call is made again.
 */
function ask<T>(work: (lib: RewriterLib) => T): [RewriterLib, T] {
	const lib = library();
	const result = work(lib);
	if (lib.needs() !== true) return [lib, result];
	let loaded = false;
	if (lib !== own && sharing.load)
		try {
			loaded = sharing.load(lib) === true;
		} catch (error) {
			// the realm it is shared from could not: this one tries
		}
	if (!loaded) loadRewriterLibrary(lib);
	// (this realm's own copy may be another one now)
	const holder = library();
	return [holder, work(holder)];
}

/**
 * How the rewrites of the library this realm uses went, as numbers (see
 * LibraryLoader.count in src/rewriterLib.ts): `answered` by the wasm
 * module, `declined` by it, `early` for it, `library` calls the rewriter
 * library answered, `loads` of that library for a call that needed it,
 * the `requests` among them (a synchronous request the call waited for)
 * and the `ms` they waited. @internal (tests, the demo)
 */
export function rewriteCounts(): {
	answered: number;
	declined: number;
	early: number;
	library: number;
	loads: number;
	requests: number;
	ms: number;
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

export function modifyJS(
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType = 'generic',
	preamble = '',
	compact?: boolean,
	source?: ScriptSource,
): string {
	const context = contextOf(url, config);
	const [lib, result] = ask<unknown>((lib) =>
		lib.js(
			context,
			text(script),
			text(type),
			text(preamble),
			compact === undefined ? -1 : compact ? 1 : 0,
			source === undefined ? '' : JSON.stringify(source),
		),
	);
	settle(lib, result === null);
	for (let i = 0, count = Number(lib.keptCount()); i < count; i++)
		keepSource(text(lib.keptKey(i)), text(lib.keptText(i)));
	return checked<string>(result, 'string');
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
 * tldts getDomain: the registrable domain of `host`, or null. What the
 * shell said of the host answers (src/inject/sites.ts); the library's list
 * is asked about any other.
 */
export function getDomain(host: string): string | null {
	const known = knownSite(host, 0);
	if (known !== undefined) return known;
	const [lib, result] = ask<unknown>((lib) => lib.domain(text(host)));
	settle(lib, false);
	return nullableString(result);
}

/**
 * tldts getPublicSuffix: the public suffix of `host`, or null; with the
 * private domains unless `icann` (the ICANN section alone)
 */
export function getPublicSuffix(host: string, icann = false): string | null {
	const known = knownSite(host, icann ? 2 : 1);
	if (known !== undefined) return known;
	const [lib, result] = ask<unknown>((lib) =>
		lib.publicSuffix(text(host), icann),
	);
	settle(lib, false);
	return nullableString(result);
}

provideRewriters({ modifyJS, modifyCSS, singleExpression });
