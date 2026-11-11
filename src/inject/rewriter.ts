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
import { LAZY_CONTEXTS, MAY_ROUTE } from '../cssURL';
import { keepSource } from '../functionSource';
import type { ScriptSource } from '../rewriteJS';
import type { RewriterLib } from '../rewriterLib';
import { provideRewriters } from '../rewriters';
import { blobOriginPair, routeScopeList } from '../routeURL';
import type { ScriptType } from '../scriptRoutes';
import type StompURL from '../StompURL';
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
	const lib = library();
	const result: unknown = lib.css(routing, source, kind);
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

/**
 * What V8 names a part of a page's expression by in an error's message
 * (src/callPrinter.ts), or null when the source does not parse
 */
export function printExpression(source: string, part: string): string | null {
	const lib = library();
	const result: unknown = lib.print(text(source), text(part));
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
	const lib = library();
	const result: unknown = lib.domain(text(host));
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
	const lib = library();
	const result: unknown = lib.publicSuffix(text(host), icann);
	settle(lib, false);
	return nullableString(result);
}

provideRewriters({ modifyJS, modifyCSS, singleExpression });
