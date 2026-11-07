/**
 * The four global names the rewriter and the inject bundles rendezvous on:
 * the access API object every rewritten script calls (`$s$j.get(...)`), the
 * client on the window (`$P$s.apply()`), and the two marker keys on the
 * `location` and `eval` stand-ins, plus the global the worker writes into
 * the host's error page. A deployment can choose its own (see
 * ControllerInit.names); the rewriter reads them from the config every
 * request carries, and the inject bundle from the config the shell hands
 * `createClient`, so one document and its scripts always agree. The
 * bootstrap name `createClient` is not one of them: the bundle deletes it
 * before any page script runs.
 */
export interface HelperNames {
	/** the access API on every global (default `$s$j`) */
	access: string;
	/** the stand-in marker on `location` and `eval` (default `$s$L`) */
	globalProxy: string;
	/** the stand-in's name marker, and the key of a Stomp message envelope (default `$s$N`) */
	globalName: string;
	/** the client on the window and on workers (default `$P$s`) */
	client: string;
	/**
	 * the global the worker writes into the host's error page (`errorPage`)
	 * with the failure (`{ url, status, error, kind }`); default `stompError`.
	 * A host whose build renames identifiers in its vendored pages sets it to
	 * what its page reads
	 */
	error: string;
}

export const DEFAULT_NAMES: Readonly<HelperNames> = Object.freeze({
	access: '$s$j',
	globalProxy: '$s$L',
	globalName: '$s$N',
	client: '$P$s',
	error: 'stompError',
});

/** the names a config asks for, the defaults for the rest */
export function helperNames(config?: object | null): HelperNames {
	const names: HelperNames = { ...DEFAULT_NAMES };
	const asked = (config as { names?: Partial<HelperNames> } | null | undefined)
		?.names;
	if (asked && typeof asked === 'object')
		for (const key of Object.keys(DEFAULT_NAMES) as (keyof HelperNames)[]) {
			const value = asked[key];
			if (typeof value === 'string' && value) names[key] = value;
		}
	return names;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// reserved words, strict-mode reserved words and the names the rewriter or a
// page gives a meaning no helper may take
const UNUSABLE = new Set([
	'await',
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'implements',
	'import',
	'in',
	'instanceof',
	'interface',
	'let',
	'new',
	'null',
	'package',
	'private',
	'protected',
	'public',
	'return',
	'static',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'yield',
	'arguments',
	'undefined',
	'NaN',
	'Infinity',
	'globalThis',
	'window',
	'self',
	'document',
	'top',
	'parent',
	'frames',
	'location',
	'eval',
	'createClient',
]);

/**
 * Throws a TypeError when a names option cannot be used: an unknown key, a
 * value that is not an identifier, a reserved or special word, two names
 * alike, or a name a plain window already has (`taken`: the host passes
 * `Object.getOwnPropertyNames(globalThis)`, so a proxied page cannot tell a
 * helper from a global it expects).
 */
export function validateNames(
	names: Partial<HelperNames> | undefined,
	taken: Iterable<string> = [],
): void {
	if (names === undefined) return;
	if (typeof names !== 'object' || names === null)
		throw new TypeError('Stomp names must be an object');
	for (const key of Object.keys(names))
		if (!(key in DEFAULT_NAMES))
			throw new TypeError(`Stomp names: ${key} is not a helper name`);
	const takenSet = new Set(taken);
	const seen = new Set<string>();
	for (const [key, value] of Object.entries(helperNames({ names }))) {
		const shown = `Stomp names.${key}: ${JSON.stringify(value)}`;
		if (!IDENTIFIER.test(value))
			throw new TypeError(`${shown} is not an identifier`);
		if (UNUSABLE.has(value))
			throw new TypeError(`${shown} is a reserved or special name`);
		if (takenSet.has(value))
			throw new TypeError(`${shown} is a global of this page`);
		if (seen.has(value)) throw new TypeError(`${shown} is used twice`);
		seen.add(value);
	}
}
