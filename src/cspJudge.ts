// How a script or style directive of the page's own policy judges a piece
// of the page's code (src/csp.ts): its nonce, its hash, its integrity, its
// URL and 'strict-dynamic', as Chrome judges them. The browser never gets
// the page's script-src or style-src (src/csp.ts browserPolicy); the inject
// enforces them with this (src/inject/dom/policyChecks.ts), and the workers
// read the hosts' part (hostsApply). In the document bundle, a deferred part
// with those checks (src/inject/dom/deferred.ts).
import { sourcesMatch } from './cspSources';
import { digest } from './sha';
import { base64Standard } from './sri';

const NONCE_OR_HASH = /^'(nonce-|sha(256|384|512)-)/i;

/** whether a script or style directive's `sources` lets the page's inline code run without a nonce or hash */
export function inlineAllowed(sources: string[], directive: string): boolean {
	const lower = sources.map((source) => source.toLowerCase());
	return (
		lower.includes("'unsafe-inline'") &&
		!sources.some((source) => NONCE_OR_HASH.test(source)) &&
		!(directive.startsWith('script') && lower.includes("'strict-dynamic'"))
	);
}

/**
 * Whether the hosts of a script or style directive's `sources` are the
 * worker's to apply to the document's requests: a list that lets a load
 * through by a nonce, a hash or 'strict-dynamic' judges it by its element,
 * which the worker never sees (the inject gives a load the page's policy
 * allows by its host the document's nonce, ./inject/dom/policyChecks.ts
 * codeNonce)
 */
export function hostsApply(sources: string[]): boolean {
	return (
		!sources.some((source) => NONCE_OR_HASH.test(source)) &&
		!sources.some((source) => source.toLowerCase() === "'strict-dynamic'")
	);
}

/** what `codeAllows` is asked of a piece of the page's own code */
export interface CodeItem {
	/** the real URL of an external script or style, or null for inline code */
	url?: URL | null;
	/** the page's own text of an inline script, style, handler or eval (for a hash) */
	text?: string | null;
	/** a script or style element's nonce attribute, as the page set it */
	nonce?: string | null;
	/** an external script's integrity attribute */
	integrity?: string | null;
	/** what 'self' means (the real URL of the document whose policy it is) */
	self?: URL;
	/** code made from a string that WebAssembly compilation allows under 'wasm-unsafe-eval' */
	wasm?: boolean;
	/** the element is the parser's or a document.write's (not DOM-inserted): 'strict-dynamic' does not propagate to it */
	parser?: boolean;
}

/**
 * Whether a script or style directive's `sources` let a specific piece of
 * the page's own code run, refuse or report, as Chrome judges it (measured,
 * Chrome 152 and 156). The browser never gets the page's script-src,
 * style-src or Trusted Types (browserPolicy); the inject enforces them
 * against the page's own code with this. `directive` is the effective
 * directive (CODE_DIRECTIVES); `script-src`/`style-src` stand for code made
 * from a string (eval, the Function constructor, a string timer, WebAssembly
 * compilation).
 */
export function codeAllows(
	sources: string[],
	directive: string,
	item: CodeItem = {},
): boolean {
	const lower = sources.map((source) => source.toLowerCase());
	// code made from a string: only 'unsafe-eval' (and 'wasm-unsafe-eval' for
	// WebAssembly compilation) lets it run
	if (directive === 'script-src' || directive === 'style-src') {
		if (lower.includes("'unsafe-eval'")) return true;
		return !!item.wasm && lower.includes("'wasm-unsafe-eval'");
	}
	const attr = directive.endsWith('-attr');
	const script = directive.startsWith('script');
	const { url = null, text = null, nonce = null, self } = item;
	// 'strict-dynamic' (script-src-elem only): a script the page inserts
	// through the DOM is let through whether inline or external (trust
	// propagates from the running script), host sources and 'unsafe-inline'
	// are ignored, and the parser's and document.write's need a nonce or hash
	if (script && !attr && lower.includes("'strict-dynamic'")) {
		if (!item.parser) return true;
		if (nonce && sources.includes(`'nonce-${nonce}'`)) return true;
		if (url === null) return text !== null && hashMatches(sources, text);
		return !!item.integrity && integrityMatches(sources, item.integrity);
	}
	if (url === null) {
		// inline: a <script>/<style>'s text, or a handler/style attribute
		if (!attr && nonce && sources.includes(`'nonce-${nonce}'`)) return true;
		if (inlineAllowed(sources, directive)) return true;
		if (text === null) return false;
		// a handler or style attribute is let through by its hash only with
		// 'unsafe-hashes'; a script or style element's by its hash alone
		if (attr)
			return lower.includes("'unsafe-hashes'") && hashMatches(sources, text);
		return hashMatches(sources, text);
	}
	// an external script or style, named by its URL
	if (nonce && sources.includes(`'nonce-${nonce}'`)) return true;
	if (script && item.integrity && integrityMatches(sources, item.integrity))
		return true;
	return sourcesMatch(sources, url, self ?? url);
}

/** whether one of `sources` is a hash of `text` (its UTF-8 bytes; base64 or base64url) */
export function hashMatches(sources: string[], text: string): boolean {
	const hashes = sources.filter((source) =>
		/^'sha(256|384|512)-/i.test(source),
	);
	if (!hashes.length) return false;
	const made = new Map<string, string>();
	return hashes.some((source) => {
		const [, algorithm, value] = /^'(sha256|sha384|sha512)-([^']*)'$/i.exec(
			source,
		) ?? ['', '', ''];
		if (!algorithm) return false;
		const name = algorithm.toLowerCase() as 'sha256' | 'sha384' | 'sha512';
		if (!made.has(name)) made.set(name, digest(name, text));
		return made.get(name) === base64Standard(value);
	});
}

/** whether one of `sources` is a hash an `integrity` attribute's metadata names */
export function integrityMatches(
	sources: string[],
	integrity: string,
): boolean {
	const wanted = new Set(
		sources
			.map((source) => /^'(sha256|sha384|sha512)-([^']*)'$/i.exec(source))
			.filter((match) => match !== null)
			.map(
				(match) => `${match![1].toLowerCase()}-${base64Standard(match![2])}`,
			),
	);
	return integrity
		.split(/\s+/)
		.map((part) => /^(sha256|sha384|sha512)-([A-Za-z0-9+/_=-]+)/i.exec(part))
		.some(
			(match) =>
				match !== null &&
				wanted.has(`${match[1].toLowerCase()}-${base64Standard(match[2])}`),
		);
}
