// The rewriters as the inject uses them: modifyJS, modifyCSS and the public
// suffix lookups, with the signatures of the originals, backed by the
// rewriter library (src/rewriterLib.ts). The library holds meriyah,
// escodegen, css-tree and tldts, and their tables: evaluating it was most
// of what a proxied frame cost (about 600 KB of heap of the 1.4 MB a frame
// paid over a native one), and a page with hundreds of ad and cookie-sync
// frames paid it hundreds of times in one renderer. So a frame evaluates
// none of it: it uses its top's copy, which lives in a realm no page code
// runs in (src/inject/dom/rewriterRealm.ts), and evaluates a copy of its
// own only when it has no such top (a sandboxed document without
// allow-same-origin, a worker), the first time it rewrites something.
//
// The library may be another realm's, so only strings, numbers and
// booleans cross: arguments are made strings here, results are checked to
// be what they should be, a failure comes back as a message and is thrown
// here as this realm's Error, and what the library logged is logged here.
import rewriterLib from 'stomp:rewriter-lib';
import { codecType, type Config } from '../config';
import { keepSource } from '../functionSource';
import type { ScriptSource } from '../rewriteJS';
import type { RewriterLib } from '../rewriterLib';
import { provideRewriters } from '../rewriters';
import { blobOriginPair, routeScopeList } from '../routeURL';
import type { ScriptType } from '../scriptRoutes';
import type StompURL from '../StompURL';

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
};
const nativeConsole = globalThis.console;

let own: RewriterLib | null = null;
let shared: (() => RewriterLib | null) | null = null;

/**
 * Where this bundle's rewrites go when they can share a library: `provider`
 * answers the library to use for the next call, or null for this realm's
 * own copy. Taken by the bundle's first client, which is its realm's own
 * document (a client this bundle makes for an about:blank window it injects
 * shares this bundle and its library). False when one was taken already.
 */
export function shareRewriter(provider: () => RewriterLib | null): boolean {
	if (shared) return false;
	shared = provider;
	return true;
}

/** this realm's own copy of the library, evaluated the first time it is needed */
export function ownRewriter(): RewriterLib {
	return (own ??= rewriterLib(realm));
}

function library(): RewriterLib {
	return shared?.() ?? ownRewriter();
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

/** replay what the call logged, throw what it threw */
function settle(lib: RewriterLib, failed: boolean) {
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
	const lib = library();
	const result: unknown = lib.js(
		contextOf(url, config),
		text(script),
		text(type),
		text(preamble),
		compact === undefined ? -1 : compact ? 1 : 0,
		source === undefined ? '' : JSON.stringify(source),
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
	const lib = library();
	const result: unknown = lib.css(
		contextOf(url, null),
		text(script),
		text(context),
	);
	settle(lib, result === null);
	return checked<string>(result, 'string');
}

/** whether `code` parses as a script of one expression statement */
export function singleExpression(code: string): boolean {
	const lib = library();
	const result: unknown = lib.singleExpression(text(code));
	settle(lib, false);
	return checked<boolean>(result, 'boolean');
}

/** whether `code` parses as a classic script */
export function parsesAsScript(code: string): boolean {
	const lib = library();
	const result: unknown = lib.parsesAsScript(text(code));
	settle(lib, false);
	return checked<boolean>(result, 'boolean');
}

function nullableString(value: unknown): string | null {
	return value === null ? null : checked<string>(value, 'string');
}

/** tldts getDomain: the registrable domain of `host`, or null */
export function getDomain(host: string): string | null {
	const lib = library();
	const result: unknown = lib.domain(text(host));
	settle(lib, false);
	return nullableString(result);
}

/** tldts getPublicSuffix with private domains: the public suffix of `host`, or null */
export function getPublicSuffix(host: string): string | null {
	const lib = library();
	const result: unknown = lib.publicSuffix(text(host));
	settle(lib, false);
	return nullableString(result);
}

provideRewriters({ modifyJS, modifyCSS, singleExpression });
