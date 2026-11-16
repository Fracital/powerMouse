// The JavaScript rewriter's wasm backend (docs/rust-plan.md, rust/rwjs): the
// same rewrites as src/rewriteJS.ts, made as edits to the script's own text
// by the rewriter, a member of the core module (rust/core-module). This is
// the host's half: what the module is told
// (the helper names once, the script's URL, source key and leading text per
// script), the routing it asks for, and what is kept of the script's text.
// Anything the module declines (a shape it leaves alone, a script its parser
// refuses, a URL that does not route) is answered null, and the caller runs
// the JavaScript rewriter on that script.
import type { Config } from '../config';
import {
	holderStatement,
	keepSource,
	keepsSourcesHere,
	sourceKey,
} from '../functionSource';
import { helperNames } from '../helperNames';
import { cannotRewrite } from '../rewriteJS';
import { routeBinary } from '../routeURL';
import { isModuleType, routeImport, type ScriptType } from '../scriptRoutes';
import StompURL from '../StompURL';
import type { BufferInstance } from './module';
import { hasModule, withInstance } from './thread';

/** the core module's member that rewrites scripts (src/wasm/module.ts MEMBERS) */
export const REWRITER = 'rewriter';

// rust/rwjs/src/abi.rs
const FLAG_MODULE = 2;
const FLAG_HOLDER = 4;
const FLAG_PARAMS = 8;
const FLAG_META = 16;
const FLAG_REVISION = 32;
const FLAG_PARSES = 64;
const FLAG_SINGLE = 128;
const FLAG_PRINT = 256;
const STATUS_INVALID = 7;
const ROUTE_IMPORT = 1;
const ROUTE_SOURCE_MAP = 2;

/** where the text a script's functions read back as is kept (ScriptSource of src/rewriteJS.ts) */
interface Source {
	key?: string;
	text?: string | null;
	shifts?: number[];
	embed?: boolean;
}

/**
 * How the questions this thread asked its module went, counted: `answered`
 * by the module, `declined` by a module the thread holds (a shape it
 * leaves alone, a script its parser refuses, a call inside a call, a
 * trap), `early` a rewrite asked for before the thread held a module. The
 * last two are the JavaScript rewriter's, which a page loads only then
 * (src/rewriterLight.ts adds how often; test/suites/rewriter-fallback.mjs
 * reads them).
 */
export const counts = { answered: 0, declined: 0, early: 0 };

/** whether this thread can rewrite scripts in wasm at all */
export const hasRewriter = () => hasModule(REWRITER);

/**
 * The revision of what this thread's module writes (rust/rwjs/src/rewrite.rs
 * REVISION), or null when it holds none: with the backend, what a kept
 * rewrite is of
 */
export function rewriterRevision(): string | null {
	return withInstance(REWRITER, (instance) => {
		const answered = instance.call('', FLAG_REVISION);
		return 'output' in answered ? answered.output : null;
	});
}

/**
 * The revision this glue was written against (rust/rwjs/src/rewrite.rs
 * REVISION; test/suites/wasm-rewriter-glue.mjs holds the two together).
 * The module is an asset fetched apart from the bundles, behind whatever
 * cache the host has, so a thread may hold another build's: one that
 * answers another revision is never asked for a rewrite or for what
 * parses. The phase 0 artifact answers every call with its input, the
 * revision call included: its "rewrite" of a script would be the script as
 * the page wrote it, and a revision 1 module takes the flags of the parse
 * questions for a rewrite.
 */
export const REVISION = '12';

/** whether an instance answered REVISION, asked once of each */
const speaks = new WeakMap<BufferInstance, boolean>();

function sameRevision(instance: BufferInstance): boolean {
	let same = speaks.get(instance);
	if (same === undefined) {
		const answered = instance.call('', FLAG_REVISION);
		same = 'output' in answered && answered.output === REVISION;
		speaks.set(instance, same);
	}
	return same;
}

/** a surrogate with no other half (under `u` a pair is one character, which the class does not hold) */
const LONE = /[\ud800-\udfff]/gu;
/** the private use characters of the BMP, which stand in for them */
const PRIVATE = /[\ue000-\uf8ff]/g;

/** how the texts of one call cross to the module (`out`) and its answers come back (`back`) */
interface StandIns {
	out(text: string): string;
	back(text: string): string;
}

const same = (text: string) => text;
/** the crossing of texts that are well-formed: as they are */
const PLAIN: StandIns = { out: same, back: same };

/**
 * How `texts`, of which one is not well-formed, cross to the module. It
 * reads UTF-8, which has no bytes for a surrogate without its other half
 * (the encoder would hand it U+FFFD, and what came back would not be the
 * page's text). A script from the network never holds one; a string a page
 * evaluates can, and V8 runs it. So each such surrogate crosses as a
 * private use character that none of the texts holds, and every one of
 * those in an answer is read back as the surrogate it stands for. The
 * stand-in is one UTF-16 unit as the surrogate is, so every position the
 * module answers (a function's mark) is the page's text's; and it is to
 * the module's parser what the surrogate is to V8: no white space, no line
 * end, nothing a name starts with or goes on with, and a character like
 * any other where V8 takes a lone surrogate at all (a string, a template,
 * a comment, a pattern). One stands for each surrogate, given out in the
 * surrogates' order, so a class range between two of them is in order when
 * the page's is.
 *
 * Two things the module then answers are not V8's answer for the page's
 * text. The order of a lone surrogate and a character between U+D800 and
 * the stand-in that is no lone surrogate of the text (written as an
 * escape, a half of a pair in a pattern without `u`, a private use
 * character): a class range from a lone surrogate up to one of those is
 * refused by the module where V8 takes it (the script is handed back like
 * any the module declines), and one from such a character down to a lone
 * surrogate, which V8 refuses, is rewritten. And a module's import or
 * export name written as a string, where V8 refuses a lone surrogate and
 * nothing else: rewritten too. What is rewritten where V8 refuses the
 * page's text is refused by V8 all the same, the literal being the page's.
 *
 * Null when the texts leave fewer private use characters free than they
 * hold different lone surrogates.
 */
function standIns(...texts: string[]): StandIns | null {
	const lone = new Set<string>();
	const taken = new Set<string>();
	for (const text of texts) {
		for (const unit of text.match(LONE) ?? []) lone.add(unit);
		for (const unit of text.match(PRIVATE) ?? []) taken.add(unit);
	}
	const out = new Map<string, string>();
	const back = new Map<string, string>();
	let code = 0xe000;
	// (single units sort by their value)
	for (const unit of [...lone].sort()) {
		while (taken.has(String.fromCharCode(code))) code++;
		if (code > 0xf8ff) return null;
		const standIn = String.fromCharCode(code++);
		out.set(unit, standIn);
		back.set(standIn, unit);
	}
	return {
		out: (text) => text.replace(LONE, (unit) => out.get(unit)!),
		back: (text) => text.replace(PRIVATE, (unit) => back.get(unit) ?? unit),
	};
}

/** how one text crosses: as it is when it is well-formed, as nearly every text is */
const crossingOf = (text: string) =>
	text.isWellFormed() ? PLAIN : standIns(text);

/**
 * The crossing of the rewrite in hand, for its routing calls (the text the
 * module asks about is the page's once read back). A rewrite made from
 * inside a routing call has its own, and puts this one back.
 */
let crossing = PLAIN;

/**
 * Whether `code` parses as a classic script (`single`: as one of a single
 * expression statement), asked of this thread's module, or null when it
 * holds none or another revision's: the caller asks the JavaScript parser
 */
export function parsesInWasm(code: string, single: boolean): boolean | null {
	if (!hasModule(REWRITER)) return null;
	const parses = withInstance(REWRITER, (instance) => {
		const cross = crossingOf(code);
		if (!cross || !sameRevision(instance)) return null;
		const answered = instance.call(
			cross.out(code),
			single ? FLAG_SINGLE : FLAG_PARSES,
		);
		return 'output' in answered ? answered.output === '1' : null;
	});
	if (parses === null) counts.declined++;
	else counts.answered++;
	return parses;
}

/**
 * What V8 names a part of a page's expression by in an error's message
 * (src/callPrinter.ts printExpression, ported to rust/rwjs/src/printer.rs),
 * asked of this thread's module: `{ printed }` with the string or null (the
 * source did not parse, or the part does not apply), or null when the thread
 * holds no module or another revision's, for the caller to ask the rewriter
 * library instead. The `print` member of src/inject/rewriter.ts reaches it.
 */
export function printInWasm(
	source: string,
	part: string,
): { printed: string | null } | null {
	if (!hasModule(REWRITER)) return null;
	return withInstance(REWRITER, (instance) => {
		const asked = `${part}\n${source}`;
		const cross = crossingOf(asked);
		if (!cross || !sameRevision(instance)) return null;
		const answered = instance.call(cross.out(asked), FLAG_PRINT);
		return {
			printed: 'output' in answered ? cross.back(answered.output) : null,
		};
	});
}

/**
 * What a script that cannot be rewritten is answered with: itself. The
 * browser may still parse it (and rejects it the same way when it cannot),
 * while a `throw` in its place would silently kill every script with that
 * shape, unless the host asked for a loud failure (allowInvalidJs: false).
 */
export function unrewritten(
	script: string,
	url: StompURL,
	config: Config,
	why: string,
): string {
	const message = `Stomp could not rewrite ${url}: ${why}`;
	console.warn(message);
	if (config.allowInvalidJs === false)
		return `throw new SyntaxError(${JSON.stringify(message)});`;
	return script;
}

/** the configuration the module takes (rust/rwjs/src/config.rs) */
export function rewriterConfig(config: Config): string {
	const names = helperNames(config);
	return `access\t${names.access}\nclient\t${names.client}\nglobalProxy\t${names.globalProxy}\nglobalName\t${names.globalName}\n`;
}

/**
 * `script` rewritten by `instance` (as it was when no browser runs it), or
 * null when it declined. `lead` is
 * what runs before the script's own code (the worker bootstrap, a module's
 * `import.meta.url`, the caller's preamble), which the module places after
 * the directive prologue.
 */
export function rewriteWith(
	instance: BufferInstance,
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType,
	lead: string,
	source?: Source,
): string | null {
	const isModule = isModuleType(type);
	const here = keepsSourcesHere();
	let key = source?.key;
	// the module makes the key of the text it is handed: where that is not
	// the page's (a lone surrogate crosses as a stand-in), the key is made
	// here, of the page's text, which is the one kept
	const loose = !script.isWellFormed();
	if (loose) key ??= sourceKey(script);
	let flags = isModule ? FLAG_MODULE : 0;
	if (source?.text === undefined) {
		// the script's own text is the one kept: written into the output by
		// the module when a function of it is marked, or kept in this realm
		if (!here && source?.embed !== false) flags |= FLAG_HOLDER;
	} else if (source.text !== null) {
		// a part of a split script that keeps the whole's text writes it
		// whether or not a function of its own is marked
		key ??= sourceKey(script);
		if (here) keepSource(key, source.text);
		else if (source.embed !== false)
			lead +=
				holderStatement(helperNames(config).access, key, source.text) ?? '';
	}
	const params = `${url.toString()}\n${key ?? ''}\n${(source?.shifts ?? []).join(',')}\n${lead}`;
	const cross =
		loose || !params.isWellFormed() ? standIns(script, params) : PLAIN;
	if (!cross) return null;
	instance.configure(rewriterConfig(config));
	const given = instance.call(cross.out(params), FLAG_PARAMS);
	if (!('output' in given)) return null;
	const around = crossing;
	crossing = cross;
	let result: { output: string } | { status: number };
	try {
		result = instance.call(cross.out(script), flags);
	} finally {
		crossing = around;
	}
	if (!('output' in result))
		// a script no browser runs is answered as the JavaScript rewriter
		// answers what it cannot parse or print, without asking it: handed
		// back where the browser refuses it as it is (an early error, syntax
		// no browser has shipped), or with an end no browser compiles where
		// the browser would run it (so unshipped syntax a browser later takes
		// does not run unrewritten), the same `cannotRewrite` the JavaScript
		// rewriter uses for the shapes its printer cannot write
		return result.status === STATUS_INVALID
			? cannotRewrite(
					script,
					url,
					config,
					type,
					'SyntaxError: no browser runs this script',
				)
			: null;
	if (here && source?.text === undefined) {
		const meta = instance.call('', FLAG_META);
		if (!('output' in meta)) return null;
		const tab = meta.output.indexOf('\t');
		if (+meta.output.slice(0, tab) > 0)
			keepSource(meta.output.slice(tab + 1), script);
	}
	return cross.back(result.output);
}

/**
 * The routing the module asks of the host while it rewrites the script at
 * `url`: a static import's source (`<length>:<type><specifier>`, the
 * `with { type }` value by its length in UTF-16 units) and a source map's
 * URL. Null when the text is no URL: the import declines the script (as
 * the JavaScript rewriter gives it up), the source map stays as written.
 */
export function rewriterRoute(
	url: StompURL,
	config: Config,
	type: ScriptType,
): (kind: number, text: string) => string | null {
	const route = (kind: number, text: string) => {
		try {
			if (kind === ROUTE_IMPORT) {
				const colon = text.indexOf(':');
				const length = +text.slice(0, colon);
				const moduleType = text.slice(colon + 1, colon + 1 + length);
				return routeImport(
					new StompURL(
						new URL(text.slice(colon + 1 + length), url.toString()),
						url,
					),
					url,
					config,
					type === 'workerModule' || type === 'workletModule'
						? type
						: 'genericModule',
					moduleType || undefined,
				);
			}
			if (kind === ROUTE_SOURCE_MAP)
				return routeBinary(new StompURL(new URL(text, url.toString()), url));
		} catch (error) {
			// not a URL
		}
		return null;
	};
	return (kind, asked) => {
		const cross = crossing;
		const answer = route(kind, cross.back(asked));
		// (an answer that held a stand-in would be read back as holding the
		// surrogate: no URL does)
		return answer !== null && cross.back(answer) !== answer ? null : answer;
	};
}

/**
 * `script` rewritten by an instance of this thread's module, or null: the
 * thread holds none, it holds another revision's, the script holds more
 * lone surrogates than can cross (standIns), it trapped, or it declined
 * the script. A data: module the script imports is rewritten from inside
 * this call's routing, by another instance (src/wasm/thread.ts).
 */
export function rewriteInWasm(
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType,
	lead: () => string,
	source?: Source,
): string | null {
	if (!hasModule(REWRITER)) {
		counts.early++;
		return null;
	}
	const output = withInstance(
		REWRITER,
		(instance) =>
			sameRevision(instance)
				? rewriteWith(instance, script, url, config, type, lead(), source)
				: null,
		rewriterRoute(url, config, type),
	);
	if (output === null) counts.declined++;
	else counts.answered++;
	return output;
}
