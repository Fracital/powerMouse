// The rewriter library: everything the inject needs a parser or a public
// suffix list for (meriyah, escodegen, css-tree, tldts), built as a bundle of
// its own (build.js: rewriterLibDocument.ts for documents, with CSS and the
// suffix list; rewriterLibWorker.ts for workers, scripts only) and carried
// in the inject bundles as a function that is not called until a rewrite
// needs it (src/inject/rewriter.ts). A frame's top
// evaluates it once, in a realm of its own that no page code runs in, and
// the frames under it use that copy (src/inject/dom/rewriterRealm.ts).
//
// The library is called from other realms, so it speaks in strings, numbers
// and booleans only: it never hands out an object (whose prototype would be
// the library's realm's), and it never calls out. Everything a rewrite
// depends on (the document's URL, the codec, the config, the blob: origins,
// the route scopes) comes with the call; nothing of one caller is kept for
// the next but the parsed form of the last context, which is the next one's
// only when the next one sends the same text.
import { parse } from 'meriyah';
import { printExpression } from './callPrinter';
import { reportKeptSources } from './functionSource';
import { messages } from './libGlobals';
import { modifyJS, singleExpression, type ScriptSource } from './rewriteJS';
import { enter } from './rewriterContext';
import type { ScriptType } from './scriptRoutes';
import type StompURL from './StompURL';
import { BUILD } from './version';
import { counts, parsesInWasm } from './wasm/rewriter';
import { adoptModule, hasModule } from './wasm/thread';

let error = '';
const kept: [key: string, text: string][] = [];
reportKeptSources((key, text) => kept.push([key, text]));

/** how many calls this copy answered */
let calls = 0;

function run<T>(work: () => T, failed: T, counted = true): T {
	if (counted) calls++;
	error = '';
	kept.length = 0;
	messages.length = 0;
	try {
		return work();
	} catch (thrown) {
		error = String(thrown instanceof Error ? thrown.message : thrown);
		return failed;
	}
}

function parsesAsScript(source: string): boolean {
	// the module's parser where this copy holds it
	const answered = parsesInWasm(source, false);
	if (answered !== null) return answered;
	try {
		parse(source, { next: true, globalReturn: true, webcompat: true });
		return true;
	} catch (error) {
		return false;
	}
}

/** what the library has beyond scripts (a worker's has none of it) */
export interface LibraryParts {
	modifyCSS?: (text: string, url: StompURL, context?: string) => string;
	getDomain?: (host: string) => string | null;
	/** with the private list unless `icann` (the ICANN section alone) */
	getPublicSuffix?: (host: string, icann?: boolean) => string | null;
	/** the public suffix list this copy's suffix module holds (its commit and date), '' while tldts answers */
	suffixList?: () => string;
}

function missing(name: string): never {
	throw new Error(`Stomp: no ${name} in this rewriter library`);
}

export function library(parts: LibraryParts) {
	return {
		/** the build this copy is (a frame shares only its own build's) */
		build: BUILD,
		/**
		 * modifyJS; `compact` -1 for undefined, `source` '' for none or the
		 * ScriptSource as JSON. Null when it threw (see error()).
		 */
		js(
			contextJSON: string,
			script: string,
			type: string,
			preamble: string,
			compact: number,
			sourceJSON: string,
		): string | null {
			return run(() => {
				const { url, config } = enter(contextJSON);
				const source =
					sourceJSON === ''
						? undefined
						: (JSON.parse(sourceJSON) as ScriptSource);
				return modifyJS(
					script,
					url,
					config,
					type as ScriptType,
					preamble,
					compact === -1 ? undefined : compact === 1,
					source,
				);
			}, null);
		},
		/** modifyCSS; null when it threw (unparsable: see error()) */
		css(contextJSON: string, text: string, kind: string): string | null {
			return run(
				() =>
					(parts.modifyCSS ?? missing('modifyCSS'))(
						text,
						enter(contextJSON).url,
						kind,
					),
				null,
			);
		},
		singleExpression(code: string): boolean {
			return run(() => singleExpression(code), false);
		},
		parsesAsScript(code: string): boolean {
			return run(() => parsesAsScript(code), false);
		},
		/** printExpression (callPrinter.ts): null when the source does not parse */
		print(source: string, part: string): string | null {
			return run(() => printExpression(source, part), null);
		},
		domain(host: string): string | null {
			return run(() => (parts.getDomain ?? missing('getDomain'))(host), null);
		},
		/** with the private list, or the ICANN section alone when `icann` */
		publicSuffix(host: string, icann: boolean): string | null {
			return run(
				() =>
					(parts.getPublicSuffix ?? missing('getPublicSuffix'))(
						host,
						icann === true,
					),
				null,
			);
		},
		/**
		 * The public suffix list `domain` and `publicSuffix` are answered
		 * from when this copy holds the suffix module: the list's commit and
		 * date (src/wasm/suffix.ts); '' while tldts answers
		 */
		suffixList(): string {
			return run(() => parts.suffixList?.() ?? '', '');
		},
		/**
		 * A wasm module the controller compiled (`rewriter: 'wasm'`), by its
		 * Assets key, for this copy's rewrites (src/wasm/thread.ts). The one
		 * object that crosses, and only inward: the library reads nothing of
		 * it, it instantiates it, which a module answers from its own slots
		 * whatever realm it was made in. Whether the copy holds it now.
		 */
		adopt(name: string, module: unknown): boolean {
			return run(
				() => {
					adoptModule(`${name}`, module as WebAssembly.Module);
					return hasModule(`${name}`);
				},
				false,
				false,
			);
		},
		/** whether this copy holds the wasm module `name` */
		holds(name: string): boolean {
			return run(() => hasModule(`${name}`), false, false);
		},
		/** the message of what the last call threw, '' when it did not */
		error(): string {
			return error;
		},
		/** how many texts the last call kept (each a key and the text it names) */
		keptCount(): number {
			return kept.length;
		},
		keptKey(index: number): string {
			return kept[index]?.[0] ?? '';
		},
		keptText(index: number): string {
			return kept[index]?.[1] ?? '';
		},
		/** what the last call logged, as JSON `[[level, text], ...]`, '' for nothing */
		messages(): string {
			return messages.length ? JSON.stringify(messages) : '';
		},
		// LibraryLoader, for a realm that holds this library and nothing
		// else (a top of `rewriter: 'js'`, made from the text its shell
		// loaded): it needs no other library and never waits for one
		needs(): boolean {
			return false;
		},
		load(): boolean {
			return false;
		},
		count(which: number): number {
			return (
				[counts.answered, counts.declined, counts.early, calls, 0, 0, 0][
					which
				] ?? 0
			);
		},
	};
}

/** the rewriter library itself: what `dist/rewriterLib.js` makes */
export type RewriterLibrary = ReturnType<typeof library>;

/**
 * What a library the inject reaches has beyond the rewrites (the light
 * library the bundles carry, src/rewriterLight.ts, answers a call from a
 * wasm module or passes it on to this library once it holds it)
 */
export interface LibraryLoader {
	/**
	 * Whether the last call stopped because it needs the rewriter library,
	 * which this copy does not hold: the caller loads the library's text,
	 * hands it to `load` and makes the call again
	 */
	needs(): boolean;
	/**
	 * The rewriter library's text (the asset `rewriterLib`), evaluated in
	 * this copy's realm; `ms` is how long the caller waited for a request
	 * for it, negative when it made none (it had the text). Whether the
	 * copy holds the library now (see error()).
	 */
	load(text: string, ms: number): boolean;
	/**
	 * A count of this copy's calls: 0 answered by the wasm module, 1
	 * declined by a module it holds, 2 rewrites asked for before it held
	 * one, 3 calls the rewriter library answered, 4 times the library was
	 * loaded for a call that needed it, 5 the milliseconds such calls
	 * waited for a request, 6 how many of the loads made one
	 */
	count(which: number): number;
}

/** the library as the inject reaches it (src/inject/rewriter.ts) */
export type RewriterLib = Omit<RewriterLibrary, keyof LibraryLoader> &
	LibraryLoader;
