import { Config } from './config';
import { provideRewriters } from './rewriters';
import { scriptLead } from './scriptLead';
import { type ScriptType } from './scriptRoutes';
import StompURL from './StompURL';
import { parsesInWasm, rewriteInWasm, unrewritten } from './wasm/rewriter';

export {
	ACCESS_KEY,
	BARE_SPECIFIER,
	CLIENT_KEY,
	GLOBAL_NAME,
	GLOBAL_PROXY,
	isBareSpecifier,
	postMessageMethod,
	PROVIDERS,
	rewriteImportMap,
	routeImport,
	routeJS,
	UNDEFINABLE,
	type ScriptType,
} from './scriptRoutes';
export { scriptLead };

/** whether a script is printed compact: minified code comes back minified */
export const minified = (script: string) => {
	let lines = 1;
	for (
		let at = script.indexOf('\n');
		at !== -1;
		at = script.indexOf('\n', at + 1)
	)
		lines++;
	return script.length / lines > 200;
};

export function modifyJS(
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType = 'generic',
	/** code the caller needs to run first (an inline script's currentScript restore): placed after the directive prologue */
	preamble = '',
	/** where the text its functions read back as is kept (a javascript: URL) */
	source?: ScriptSource,
	/** told which backend rewrote the script (the request log's `rewriteBy`): always the wasm module now */
	told?: RewrittenBy,
): string {
	// the rewriter is the wasm core module (rust/rwjs, src/wasm/rewriter.ts).
	// A thread that holds it rewrites every script it can parse; one it
	// cannot (its parser refuses it, or a shape with no shipped syntax) is
	// handed back by cannotRewrite, which ends a script the browser would
	// otherwise run so it cannot run unrewritten. A thread with no module
	// yet compiles the bytes it holds synchronously (src/wasm/thread.ts), so
	// this is never reached before the module is available.
	const output = rewriteInWasm(
		script,
		url,
		config,
		type,
		() => scriptLead(url, config, type, preamble),
		source,
	);
	if (told) told.by = 'wasm';
	if (output !== null) return output;
	return cannotRewrite(
		script,
		url,
		config,
		type,
		'SyntaxError: the rewriter could not rewrite this script',
	);
}

/**
 * Whether the browser this runs in refuses `script` (of `type`) as it
 * compiles it, asked of its own engine without running anything: as a
 * function's body (a classic script's: the body takes what a script does,
 * a leading `#!` line aside, and `return` and `new.target` besides), or as
 * a strict async function's (a module's, when it names neither `import`
 * nor `export`, which no function body takes). False when it may take it:
 * the engine cannot be asked (a policy that forbids compiling strings), or
 * the script writes `eval` or `arguments` with an escape, where the answer
 * may not be the script's (V8 13.7 and before take the name in strict code
 * they compile lazily, and a function's body is compiled otherwise than a
 * script).
 */
function refusedHere(script: string, type: ScriptType): boolean {
	if (escapesEval(script)) return false;
	const body = script.replace(/^#![^\n\r\u2028\u2029]*/, '');
	const module = type === 'genericModule' || type === 'workerModule';
	if (module && /\b(?:import|export)\b/.test(body)) return false;
	try {
		new Function(
			module ? `'use strict'; return async function () {\n${body}\n};` : body,
		);
		return false;
	} catch (error) {
		return (error as Error)?.name === 'SyntaxError';
	}
}

/** a name with an escape in its text, decoded */
const decoded = (written: string) =>
	written.replace(
		/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g,
		(_, braced, plain) => {
			// (one past the last code point is no name's)
			const point = parseInt(braced ?? plain, 16);
			return point > 0x10ffff ? '\\' : String.fromCodePoint(point);
		},
	);

/** whether `script` writes `eval` or `arguments` with an escape (as a name or anywhere) */
function escapesEval(script: string): boolean {
	if (!script.includes('\\u')) return false;
	for (const [word] of script.matchAll(
		/(?:[\w$]|\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4}))+/g,
	))
		if (word.includes('\\') && /^(?:eval|arguments)$/.test(decoded(word)))
			return true;
	return false;
}

/**
 * The end written after a script this rewriter cannot rewrite and the
 * browser may run: a private name no class declares, an early error in
 * every kind of script, after all of the page's code. The browser
 * refuses the whole before any of it runs, with the page's own error
 * where the page's code has one, and STomp's name in the message where it
 * has none.
 */
export const UNREWRITTEN_END =
	'\n;this.#STomp_could_not_rewrite_this_script;\n';

/**
 * What a script this rewriter cannot rewrite (its parser refuses it, or
 * the rewrite failed) is answered with. One the browser refuses goes as it
 * came, and the page reads the browser's own SyntaxError. One it would run
 * must not run unrewritten, where its code would reach the real globals:
 * it goes with an end no browser compiles (UNREWRITTEN_END).
 */
export function cannotRewrite(
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType,
	why: string,
): string {
	const output = unrewritten(script, url, config, why);
	if (output !== script || refusedHere(script, type)) return output;
	return script + UNREWRITTEN_END;
}

/**
 * Which backend rewrote a script (the request log's `rewriteBy`): always
 * the wasm module, the only rewriter. Unset when nothing rewrote the text.
 */
export interface RewrittenBy {
	by?: 'wasm';
}

export interface ScriptSource {
	/** the key of the text this script's positions refer to */
	key?: string;
	/** the text kept: null when another part of a split script keeps it */
	text?: string | null;
	/**
	 * `[position, shift, ...]`, ascending: a position of this script at or
	 * past `position` stands `shift` further on in the text (a part of a
	 * split script)
	 */
	shifts?: number[];
	/** false: never written into the output (a javascript: URL's body) */
	embed?: boolean;
}

/** whether `code` parses as a script of one expression statement (a javascript: URL's body) */
export function singleExpression(code: string): boolean {
	// the module's parser; false when this thread holds no module (its caller
	// asks again once it does, src/inject/rewriter.ts) or it declines
	return parsesInWasm(code, true) ?? false;
}

provideRewriters({ modifyJS, singleExpression });
