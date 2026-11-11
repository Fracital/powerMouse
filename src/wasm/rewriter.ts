// The JavaScript rewriter's wasm backend (docs/rust-plan.md, rust/rwjs): the
// same rewrites as src/rewriteJS.ts, made as edits to the script's own text
// by the module `rewriter`. This is the host's half: what the module is told
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
import { routeBinary } from '../routeURL';
import { routeImport, type ScriptType } from '../scriptRoutes';
import StompURL from '../StompURL';
import type { BufferInstance } from './module';
import { hasModule, withInstance } from './thread';

/** the Assets key of the module */
export const REWRITER = 'rewriter';

// rust/rwjs/src/abi.rs
const FLAG_MODULE = 2;
const FLAG_HOLDER = 4;
const FLAG_PARAMS = 8;
const FLAG_META = 16;
const FLAG_REVISION = 32;
const FLAG_PARSES = 64;
const FLAG_SINGLE = 128;
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
export const REVISION = '2';

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

/**
 * Whether `code` parses as a classic script (`single`: as one of a single
 * expression statement), asked of this thread's module, or null when it
 * holds none or another revision's: the caller asks the JavaScript parser
 */
export function parsesInWasm(code: string, single: boolean): boolean | null {
	if (!hasModule(REWRITER)) return null;
	const parses = withInstance(REWRITER, (instance) => {
		if (!sameRevision(instance)) return null;
		const answered = instance.call(code, single ? FLAG_SINGLE : FLAG_PARSES);
		return 'output' in answered ? answered.output === '1' : null;
	});
	if (parses === null) counts.declined++;
	else counts.answered++;
	return parses;
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
	const isModule = type === 'genericModule' || type === 'workerModule';
	const here = keepsSourcesHere();
	let key = source?.key;
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
	instance.configure(rewriterConfig(config));
	const given = instance.call(
		`${url.toString()}\n${key ?? ''}\n${(source?.shifts ?? []).join(',')}\n${lead}`,
		FLAG_PARAMS,
	);
	if (!('output' in given)) return null;
	const result = instance.call(script, flags);
	if (!('output' in result))
		// a script no browser runs is answered as the JavaScript rewriter
		// answers what it cannot parse, without asking it
		return result.status === STATUS_INVALID
			? unrewritten(
					script,
					url,
					config,
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
	return result.output;
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
	return (kind, text) => {
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
					type === 'workerModule' ? 'workerModule' : 'genericModule',
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
}

/**
 * `script` rewritten by an instance of this thread's module, or null: the
 * thread holds none, it holds another revision's, the script is not
 * well-formed UTF-16, it trapped, or it declined the script. A data:
 * module the script imports is rewritten from inside this call's routing,
 * by another instance (src/wasm/thread.ts).
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
	// a lone surrogate has no UTF-8: the encoder would hand the module
	// U+FFFD in its place, and what came back would not be the page's
	// text. A script from the network never holds one; a string a page
	// evaluates can
	const output = script.isWellFormed()
		? withInstance(
				REWRITER,
				(instance) =>
					sameRevision(instance)
						? rewriteWith(instance, script, url, config, type, lead(), source)
						: null,
				rewriterRoute(url, config, type),
			)
		: null;
	if (output === null) counts.declined++;
	else counts.answered++;
	return output;
}
