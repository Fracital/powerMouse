// The rewriter the inject bundles carry: the glue of the wasm core module
// (src/wasm/rewriter.ts for scripts, src/wasm/scanner.ts for stylesheets,
// src/wasm/suffix.ts for the public suffix list) and nothing that stands in
// for a parser. There is no JavaScript rewriter any more: a script the module
// declines is handed back (cannotRewrite), and a call made before the module
// has arrived in this realm stops and says so (`needs`), so the caller gives
// this copy the module and asks again (src/inject/rewriter.ts).
//
// This copy is called from other realms, so it speaks in strings, numbers and
// booleans only; its own realm is usually a detached one, where no request
// can be made, and the globals it reads were taken when it was made
// (src/libGlobals.ts). The one object that crosses, and only inward, is the
// compiled WebAssembly.Module the caller hands `adopt`: this copy reads no
// property of it and only instantiates it (src/wasm/thread.ts).
import { reportKeptSources } from './functionSource';
import { messages } from './libGlobals';
import { cannotRewrite, type ScriptSource } from './rewriteJS';
import { enter } from './rewriterContext';
import { provideRewriters } from './rewriters';
import { scriptLead } from './scriptLead';
import type { ScriptType } from './scriptRoutes';
import type StompURL from './StompURL';
import { BUILD } from './version';
import {
	counts,
	hasRewriter,
	parsesInWasm,
	printInWasm,
	rewriteInWasm,
} from './wasm/rewriter';
import { adoptModule, hasModule } from './wasm/thread';

/**
 * What an entry answers itself from its own wasm members (a worker's has no
 * stylesheets or suffix list). Each answers `undefined` for what it has no
 * module for, which makes the call stop for one (`needs`).
 */
export interface LightParts {
	modifyCSS?: (
		text: string,
		url: StompURL,
		context?: string,
	) => string | undefined;
	/** both with the list's private section, where Chrome ends a site */
	getDomain?: (host: string) => string | null | undefined;
	getPublicSuffix?: (host: string) => string | null | undefined;
	/** the public suffix list this copy's suffix module holds (its commit and date), '' while it holds none */
	suffixList?: () => string;
}

/** the last call stopped because this copy holds no module yet */
let needed = false;
/** calls this copy answered from its module */
let served = 0;
/** modules this copy was handed (adopt) */
let loads = 0;

let error = '';
const kept: [key: string, text: string][] = [];
reportKeptSources((key, text) => kept.push([key, text]));

function run<T>(work: () => T, failed: T): T {
	error = '';
	needed = false;
	kept.length = 0;
	messages.length = 0;
	try {
		return work();
	} catch (thrown) {
		error = String(thrown instanceof Error ? thrown.message : thrown);
		return failed;
	}
}

export function library(parts: LightParts) {
	// the rewriters as the light modules reach them (src/rewriters.ts): the
	// module where this copy holds it, else what the module answers for a
	// shape it cannot rewrite. These are reached only from inside a rewrite
	// the module asked routing of (a data: script or stylesheet), so the
	// module is always present here.
	provideRewriters({
		modifyJS(script, url, config, type = 'generic', preamble = '', source) {
			const output = rewriteInWasm(
				script,
				url,
				config,
				type,
				() => scriptLead(url, config, type, preamble),
				source,
			);
			return (
				output ??
				cannotRewrite(
					script,
					url,
					config,
					type,
					'SyntaxError: the rewriter could not rewrite this script',
				)
			);
		},
		modifyCSS: (text, url, context = 'stylesheet') =>
			parts.modifyCSS?.(text, url, context) ?? text,
		singleExpression: (code) => parsesInWasm(code, true) ?? false,
	});
	const loader: LibraryLoader = {
		needs(): boolean {
			return needed;
		},
		count(which: number): number {
			return (
				[counts.answered, counts.declined, counts.early, served, loads, 0, 0][
					which
				] ?? 0
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
			sourceJSON: string,
		): string | null {
			return run(() => {
				const { url, config } = enter(contextJSON);
				const source =
					sourceJSON === ''
						? undefined
						: (JSON.parse(sourceJSON) as ScriptSource);
				const output = rewriteInWasm(
					script,
					url,
					config,
					type as ScriptType,
					() => scriptLead(url, config, type as ScriptType, preamble),
					source,
				);
				if (output !== null) {
					served++;
					return output;
				}
				// no module in this realm yet: the caller gives us one and asks
				// again (src/inject/rewriter.ts). With a module, a shape it
				// declined is handed back so it cannot run unrewritten.
				if (!hasRewriter()) {
					needed = true;
					return null;
				}
				served++;
				return cannotRewrite(
					script,
					url,
					config,
					type as ScriptType,
					'SyntaxError: the rewriter could not rewrite this script',
				);
			}, null);
		},
		css(contextJSON: string, text: string, kind: string): string | null {
			return run(() => {
				const output = parts.modifyCSS?.(text, enter(contextJSON).url, kind);
				if (output !== undefined) {
					served++;
					return output;
				}
				if (!hasRewriter()) {
					needed = true;
					return null;
				}
				// a context the scanner leaves alone: as written
				served++;
				return text;
			}, null);
		},
		singleExpression(code: string): boolean {
			return run(() => {
				const answered = parsesInWasm(code, true);
				if (answered !== null) {
					served++;
					return answered;
				}
				if (!hasRewriter()) needed = true;
				return false;
			}, false);
		},
		parsesAsScript(code: string): boolean {
			return run(() => {
				const answered = parsesInWasm(code, false);
				if (answered !== null) {
					served++;
					return answered;
				}
				if (!hasRewriter()) needed = true;
				return false;
			}, false);
		},
		print(source: string, part: string): string | null {
			return run(() => {
				const answered = printInWasm(source, part);
				if (answered) {
					served++;
					return answered.printed;
				}
				if (!hasRewriter()) needed = true;
				return null;
			}, null);
		},
		domain(host: string): string | null {
			return run(() => {
				const answered = parts.getDomain?.(host);
				if (answered !== undefined) {
					served++;
					return answered;
				}
				if (!hasRewriter()) needed = true;
				return null;
			}, null);
		},
		publicSuffix(host: string): string | null {
			return run(() => {
				const answered = parts.getPublicSuffix?.(host);
				if (answered !== undefined) {
					served++;
					return answered;
				}
				if (!hasRewriter()) needed = true;
				return null;
			}, null);
		},
		suffixList(): string {
			return run(() => parts.suffixList?.() ?? '', '');
		},
		adopt(name: string, module: unknown): boolean {
			return run(() => {
				adoptModule(`${name}`, module as WebAssembly.Module);
				loads++;
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

/** the library the inject reaches (src/inject/rewriter.ts), everything library() returns */
export type RewriterLib = ReturnType<typeof library>;

/**
 * What a library the inject reaches has beyond the rewrites: whether a call
 * stopped for the module, and the counts tests read.
 */
export interface LibraryLoader {
	/**
	 * Whether the last call stopped because this copy holds no module yet:
	 * the caller gives it one (`adopt`) and makes the call again
	 * (src/inject/rewriter.ts).
	 */
	needs(): boolean;
	/**
	 * A count of this copy's calls: 0 answered by the wasm module, 1 declined
	 * by it, 2 rewrites asked for before it held one, 3 calls it answered, 4
	 * modules it was handed, 5 and 6 are 0 (no library is loaded any more)
	 */
	count(which: number): number;
}
