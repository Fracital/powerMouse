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
import { parseConfig, type Config, type ConfigCodec } from './config';
import { reportKeptSources } from './functionSource';
import { messages } from './libGlobals';
import { modifyJS, singleExpression, type ScriptSource } from './rewriteJS';
import { setBlobOrigins, setRouteScopes } from './routeURL';
import type { ScriptType } from './scriptRoutes';
import StompURL from './StompURL';
import { BUILD } from './version';
import { parsesInWasm } from './wasm/rewriter';
import { adoptModule, hasModule } from './wasm/thread';

/**
 * What a rewrite depends on, as the caller sends it (JSON): the document's
 * URL, its codec and key, the controller's directory, the config (null for
 * CSS, which needs none), the blob: origins and the route scopes
 */
type Context = [
	url: string,
	codec: ConfigCodec,
	key: string,
	directory: string,
	config: Config | null,
	blob: [page: string, proxy: string] | null,
	scopes: string[],
];

let contextText = '';
let context: { url: StompURL; config: Config } | null = null;

function enter(text: string): { url: StompURL; config: Config } {
	if (context && text === contextText) return context;
	const [url, codecName, key, directory, config, blob, scopes] = JSON.parse(
		text,
	) as Context;
	const full: Config = config ?? { codec: codecName, directory, scope: '' };
	const { codec } = parseConfig({ ...full, codec: codecName }, key);
	// the module state the rewriters read is the caller's
	if (blob) setBlobOrigins(blob[0], blob[1]);
	else setBlobOrigins('', '');
	setRouteScopes(scopes);
	context = { url: new StompURL(url, codec, directory), config: full };
	contextText = text;
	return context;
}

let error = '';
const kept: [key: string, text: string][] = [];
reportKeptSources((key, text) => kept.push([key, text]));

function run<T>(work: () => T, failed: T): T {
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
			return run(() => {
				adoptModule(`${name}`, module as WebAssembly.Module);
				return hasModule(`${name}`);
			}, false);
		},
		/** whether this copy holds the wasm module `name` */
		holds(name: string): boolean {
			return run(() => hasModule(`${name}`), false);
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
	};
}

export type RewriterLib = ReturnType<typeof library>;
