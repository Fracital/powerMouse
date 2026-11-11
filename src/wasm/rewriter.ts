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
const ROUTE_IMPORT = 1;
const ROUTE_SOURCE_MAP = 2;

/** where the text a script's functions read back as is kept (ScriptSource of src/rewriteJS.ts) */
interface Source {
	key?: string;
	text?: string | null;
	shifts?: number[];
	embed?: boolean;
}

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

/** the configuration the module takes (rust/rwjs/src/config.rs) */
export function rewriterConfig(config: Config): string {
	const names = helperNames(config);
	return `access\t${names.access}\nclient\t${names.client}\nglobalProxy\t${names.globalProxy}\nglobalName\t${names.globalName}\n`;
}

/**
 * `script` rewritten by `instance`, or null when it declined. `lead` is
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
	if (!('output' in result)) return null;
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
 * `script` rewritten by this thread's instance of the module, or null: the
 * thread holds none, it is in a call already (a data: import inside the
 * script being rewritten), it trapped, or it declined the script
 */
export function rewriteInWasm(
	script: string,
	url: StompURL,
	config: Config,
	type: ScriptType,
	lead: () => string,
	source?: Source,
): string | null {
	if (!hasModule(REWRITER)) return null;
	return withInstance(
		REWRITER,
		(instance) =>
			rewriteWith(instance, script, url, config, type, lead(), source),
		rewriterRoute(url, config, type),
	);
}
