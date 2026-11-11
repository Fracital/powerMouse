// The rewriter library as the inject bundles carry it (build.js,
// `stomp:rewriter-lib`): the calls of src/rewriterLib.ts with no parser
// and no printer behind them. A script is rewritten by the wasm module
// where this copy holds it (src/wasm/rewriter.ts), and so are a stylesheet
// and a host's site where its entry asks their modules
// (src/rewriterLightDocument.ts); everything else is the rewriter
// library's, which is a file of its own (the asset `rewriterLib`:
// meriyah, escodegen, css-tree, tldts and the rewriters on them) that no
// frame fetches, scans or holds until a call needs it: a rewrite with
// `rewriter: 'js'`, a rewrite before the modules arrived or one they
// declined, an error message that names a part of the page's expression.
//
// This copy never fetches anything: it is called from other realms, speaks
// in strings, numbers and booleans, and its own realm is usually a
// detached one, where no request can be made. A call that needs the
// library it does not hold stops and says so (`needs`); the caller loads
// the library's text (src/inject/rewriter.ts, synchronously) and hands it
// in (`load`), and it is evaluated here, with the globals this copy took
// when it was made.
import { reportKeptSources } from './functionSource';
import { messages, realmGlobals } from './libGlobals';
import type { ScriptSource } from './rewriteJS';
import { enter } from './rewriterContext';
import type {
	LibraryLoader,
	RewriterLib,
	RewriterLibrary,
} from './rewriterLib';
import { provideRewriters } from './rewriters';
import { scriptLead } from './scriptLead';
import type { ScriptType } from './scriptRoutes';
import type StompURL from './StompURL';
import { BUILD, LIBRARY_FACTORY } from './version';
import { counts, parsesInWasm, rewriteInWasm } from './wasm/rewriter';
import { adoptModule, hasModule } from './wasm/thread';

/**
 * What an entry answers itself, without the rewriter library (a worker's
 * has none of it). Each answers `undefined` for what it leaves to the
 * library, which is then loaded like for any other call: a part that is
 * not given is always the library's.
 */
export interface LightParts {
	modifyCSS?: (
		text: string,
		url: StompURL,
		context?: string,
	) => string | undefined;
	/** a stylesheet this entry left to the rewriter library was rewritten there */
	styledByLibrary?: () => void;
	getDomain?: (host: string) => string | null | undefined;
	/** with the private list unless `icann` (the ICANN section alone) */
	getPublicSuffix?: (
		host: string,
		icann?: boolean,
	) => string | null | undefined;
	/** the public suffix list this copy's suffix module holds (its commit and date), '' while it holds none */
	suffixList?: () => string;
}

/** the rewriter library, once its text was handed in */
let full: RewriterLibrary | null = null;
/** the last call stopped for the library */
let needed = false;
/** the library was just loaded: the next call is the one that stopped for it, made again */
let again = false;
/** this call is that one: its question is the library's, the module is not asked twice */
let repeated = false;
let loads = 0;
let requests = 0;
let waited = 0;
let served = 0;

/** the context of the call under way, as its caller sent it */
let entered = '';

let error = '';
const kept: [key: string, text: string][] = [];
reportKeptSources((key, text) => kept.push([key, text]));

function run<T>(work: () => T, failed: T): T {
	error = '';
	needed = false;
	repeated = again;
	again = false;
	kept.length = 0;
	messages.length = 0;
	try {
		return work();
	} catch (thrown) {
		error = String(thrown instanceof Error ? thrown.message : thrown);
		return failed;
	}
}

/**
 * `work` done by the rewriter library, with what it kept, logged and threw
 * handed on as this call's. Without the library the call stops: it answers
 * `failed`, and `needs()` says why.
 */
function inLibrary<T>(work: (lib: RewriterLibrary) => T, failed: T): T {
	const lib = full;
	if (!lib) {
		needed = true;
		return failed;
	}
	served++;
	const result = work(lib);
	collect(lib);
	error = lib.error();
	return result;
}

/** what the rewriter library's last call kept and logged, added to this call's */
function collect(lib: RewriterLibrary) {
	for (let i = 0, count = lib.keptCount(); i < count; i++)
		kept.push([lib.keptKey(i), lib.keptText(i)]);
	const logged = lib.messages();
	if (logged)
		for (const message of JSON.parse(logged) as typeof messages)
			messages.push(message);
}

/**
 * `work` asked of the rewriter library in the middle of a call of this
 * copy's: a URL the call routes holds something to rewrite (a `data:`
 * script that a script the module is rewriting imports, a `data:`
 * stylesheet in a stylesheet: src/scriptRoutes.ts, src/cssURLs.ts), and
 * no instance of the module took it (src/wasm/thread.ts runs INSTANCES of
 * it, one inside another). Without the library the call under way
 * cannot be finished here: it is marked as needing it, so the caller loads
 * it and makes the whole call again, whatever the rewriter in between made
 * of this failure (a stylesheet's leaves the URL as written).
 */
function within<T>(work: (lib: RewriterLibrary) => T | null): T {
	const lib = full;
	if (!lib) {
		needed = true;
		throw new Error('Stomp: the rewriter library is not loaded');
	}
	served++;
	const result = work(lib);
	collect(lib);
	if (result === null) throw new Error(lib.error() || 'Stomp: rewrite failed');
	return result;
}

export function library(parts: LightParts): RewriterLib {
	// the rewriters as the light modules reach them (src/rewriters.ts): what
	// this copy answers itself, else the rewriter library
	provideRewriters({
		modifyJS(
			script,
			url,
			config,
			type = 'generic',
			preamble = '',
			compact,
			source,
		) {
			const output =
				config.rewriter === 'wasm' && compact === undefined
					? rewriteInWasm(
							script,
							url,
							config,
							type,
							() => scriptLead(url, config, type, preamble),
							source,
						)
					: null;
			if (output !== null) return output;
			return within((lib) =>
				lib.js(
					entered,
					script,
					type,
					preamble,
					compact === undefined ? -1 : compact ? 1 : 0,
					source === undefined ? '' : JSON.stringify(source),
				),
			);
		},
		modifyCSS: (text, url, context = 'stylesheet') =>
			parts.modifyCSS?.(text, url, context) ??
			within((lib) => {
				const output = lib.css(entered, text, context);
				if (output !== null) parts.styledByLibrary?.();
				return output;
			}),
		singleExpression: (code) =>
			parsesInWasm(code, true) ?? within((lib) => lib.singleExpression(code)),
	});
	const loader: LibraryLoader = {
		needs(): boolean {
			return needed;
		},
		load(text: string, ms: number): boolean {
			return run(() => {
				// The text is one statement that assigns the library's factory
				// to a name (src/version.ts LIBRARY_FACTORY): evaluated as the
				// body of a function that has the name as its parameter, it
				// writes no global and reads none, whatever a host's build
				// step put before or after it. The function is made with the
				// realm's own Function (src/libGlobals.ts): in a frame's own
				// copy the one the inject took before it wrapped the page's.
				const factory: unknown = (
					Reflect.construct(Function, [
						LIBRARY_FACTORY,
						`${text}\n;return ${LIBRARY_FACTORY};`,
					]) as (factory?: unknown) => unknown
				)();
				if (typeof factory !== 'function')
					throw new Error('Stomp: the rewriterLib asset is not the library');
				const lib = (factory as (realm: unknown) => RewriterLibrary)(
					realmGlobals,
				);
				if (typeof lib !== 'object' || lib === null)
					throw new Error('Stomp: the rewriterLib asset made no library');
				// a stale file next to a new bundle (or the reverse) still
				// rewrites, as a stale bundle next to a new worker still runs
				if (lib.build !== BUILD)
					console.error(
						`Stomp: the rewriter library is build ${lib.build} but this inject bundle is build ${BUILD}; hard-reload the page`,
					);
				full = lib;
				again = true;
				loads++;
				// (negative: the caller had the text, and waited for nothing)
				if (ms >= 0) {
					requests++;
					waited += Number(ms) || 0;
				}
				return true;
			}, false);
		},
		count(which: number): number {
			return (
				[
					counts.answered,
					counts.declined,
					counts.early,
					served,
					loads,
					waited,
					requests,
				][which] ?? 0
			);
		},
	};
	return {
		build: BUILD,
		js(
			contextJSON: string,
			script: string,
			type: string,
			preamble: string,
			compact: number,
			sourceJSON: string,
		): string | null {
			return run(() => {
				entered = contextJSON;
				const { url, config } = enter(contextJSON);
				// as modifyJS asks it (src/rewriteJS.ts): a part of a split
				// script is the JavaScript rewriter's
				if (!repeated && config.rewriter === 'wasm' && compact === -1) {
					const output = rewriteInWasm(
						script,
						url,
						config,
						type as ScriptType,
						() => scriptLead(url, config, type as ScriptType, preamble),
						sourceJSON === ''
							? undefined
							: (JSON.parse(sourceJSON) as ScriptSource),
					);
					if (output !== null) return output;
				}
				return inLibrary(
					(lib) =>
						lib.js(contextJSON, script, type, preamble, compact, sourceJSON),
					null,
				);
			}, null);
		},
		css(contextJSON: string, text: string, kind: string): string | null {
			return run(() => {
				entered = contextJSON;
				return (
					parts.modifyCSS?.(text, enter(contextJSON).url, kind) ??
					inLibrary((lib) => {
						const output = lib.css(contextJSON, text, kind);
						if (output !== null) parts.styledByLibrary?.();
						return output;
					}, null)
				);
			}, null);
		},
		singleExpression(code: string): boolean {
			return run(
				() =>
					(repeated ? null : parsesInWasm(code, true)) ??
					inLibrary((lib) => lib.singleExpression(code), false),
				false,
			);
		},
		parsesAsScript(code: string): boolean {
			return run(
				() =>
					(repeated ? null : parsesInWasm(code, false)) ??
					inLibrary((lib) => lib.parsesAsScript(code), false),
				false,
			);
		},
		print(source: string, part: string): string | null {
			return run(() => inLibrary((lib) => lib.print(source, part), null), null);
		},
		domain(host: string): string | null {
			return run(() => {
				const answered = parts.getDomain?.(host);
				return answered !== undefined
					? answered
					: inLibrary((lib) => lib.domain(host), null);
			}, null);
		},
		publicSuffix(host: string, icann: boolean): string | null {
			return run(() => {
				const answered = parts.getPublicSuffix?.(host, icann === true);
				return answered !== undefined
					? answered
					: inLibrary((lib) => lib.publicSuffix(host, icann === true), null);
			}, null);
		},
		suffixList(): string {
			return run(() => parts.suffixList?.() ?? '', '');
		},
		adopt(name: string, module: unknown): boolean {
			return run(() => {
				adoptModule(`${name}`, module as WebAssembly.Module);
				return hasModule(`${name}`);
			}, false);
		},
		holds(name: string): boolean {
			return run(() => hasModule(`${name}`), false);
		},
		error(): string {
			return error;
		},
		keptCount(): number {
			return kept.length;
		},
		keptKey(index: number): string {
			return kept[index]?.[0] ?? '';
		},
		keptText(index: number): string {
			return kept[index]?.[1] ?? '';
		},
		messages(): string {
			return messages.length ? JSON.stringify(messages) : '';
		},
		...loader,
	};
}
