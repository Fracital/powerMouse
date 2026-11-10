import {
	generate,
	parse,
	Url,
	walk,
	type CssNode,
	type ParseOptions,
} from 'css-tree';
import { createDataURI, parseDataURI, routeBinary, routeURL } from './routeURL';
import StompURL from './StompURL';

export function routeCSS(resource: StompURL, url: StompURL) {
	if (resource.url.protocol === 'data:') {
		const { mime, data, attributes } = parseDataURI(
			// the data is everything after `data:` but the fragment: a `?` in it
			// is data too, which the URL parser filed under `search`
			resource.url.pathname + resource.url.search,
		);
		return createDataURI({
			mime,
			data: modifyCSS(data, url),
			attributes,
		});
	}

	return routeURL('css', resource);
}

function preserveValue(url: string, value: string) {
	{
		const hashi = url.indexOf('#');
		if (hashi !== -1) {
			url = url.slice(0, hashi);
		}
	}

	return `${url}#${value}`;
}

function restoreValue(url: string) {
	const hashi = url.indexOf('#');

	if (hashi === -1) {
		throw new Error('Invalid value URL');
	}

	// the browser percent-encodes the quotes of a serialised url() token
	const token = url.slice(hashi + 1);
	try {
		return decodeURIComponent(token);
	} catch (error) {
		return token;
	}
}

const RAW_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/g;

/**
 * The page's URL from a value that may already be routed: a routed url()
 * keeps the original token after '#', which the browser serialises with
 * percent-encoded quotes. Rewriting is idempotent because of this, so text
 * rewritten before parsing and rules rewritten again in the CSSOM agree.
 */
function originalOf(target: string): { url: string; token: string } | null {
	const hash = target.indexOf('#url(');
	if (hash === -1) return null;
	let token = target.slice(hash + 1);
	try {
		token = decodeURIComponent(token);
	} catch (error) {
		// not percent-encoded
	}
	const match = /^url\(\s*(['"]?)(.*?)\1\s*\)$/s.exec(token);
	return match ? { url: match[2], token } : null;
}

/**
 * Route every url() in a raw CSS value (a single declaration value, a custom
 * property, or anything css-tree can't parse) through the binary route.
 */
export function rewriteCSSValueURLs(value: string, url: StompURL): string {
	return value.replace(RAW_URL, (match, quote, target) => {
		try {
			const routed = originalOf(target);
			const original = routed?.url ?? target;
			const resolved = new StompURL(new URL(original, url.toString()), url);
			// routed already: the page's token as it was kept, so text routed
			// twice still reads back as the page wrote it
			if (routed) match = routed.token;
			// keep the page's own token after '#', so reads can give it back
			return `url(${JSON.stringify(
				preserveValue(routeBinary(resolved), match),
			)})`;
		} catch (error) {
			return match;
		}
	});
}

// a url() token whose quoted target may hold escapes: a Typed OM value
// serialises the routed URL as a CSS string, the quotes of the page's token
// after '#' escaped with backslashes
const QUOTED_URL =
	/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/gs;

/** inverse of rewriteCSSValueURLs for values the page reads back */
export function restoreCSSValueURLs(value: string): string {
	return value.replace(
		QUOTED_URL,
		(match, double?: string, single?: string, bare?: string) => {
			try {
				const quoted = double ?? single;
				return restoreValue(
					quoted === undefined ? bare! : quoted.replace(/\\(.)/gs, '$1'),
				);
			} catch (error) {
				return match;
			}
		},
	);
}

/**
 * The replacements a walk makes in a stylesheet, in source order, applied
 * once at the end. Splicing each into the whole text rebuilt it every time,
 * which was quadratic: a page's 3 MB of inline CSS with 600 url()s took
 * seconds to rewrite.
 */
class Edits {
	readonly #parts: string[] = [];
	#at = 0;
	constructor(readonly text: string) {}
	/** `text` from `start` to `end` becomes `replacement`; one that overlaps the last is dropped */
	replace(start: number, end: number, replacement: string) {
		if (start < this.#at) return;
		this.#parts.push(this.text.slice(this.#at, start), replacement);
		this.#at = end;
	}
	result(): string {
		if (!this.#parts.length) return this.text;
		return this.#parts.join('') + this.text.slice(this.#at);
	}
}

/**
 * What a declaration value, an at-rule prelude or a selector must contain
 * for the walk to route anything in it: a url() token, a string inside
 * image-set() or src(), an @import's string, or a CSS escape (`\75 rl(` is
 * a url() token as well).
 */
const MAY_ROUTE = /url\(|image-set|src\(|import|\\/i;

/** the contexts parsed lazily: values, preludes and selectors stay raw text */
const LAZY_CONTEXTS = ['stylesheet', 'declarationList'];

/** what css-tree's walker tells a visitor about where a node is */
interface WalkContext {
	function?: { name: string } | null;
	atrule?: { name: string; prelude: CssNode | null } | null;
	rule?: { prelude: CssNode } | null;
	declaration?: { property: string; value: CssNode } | null;
}

export function modifyCSS(
	script: string,
	url: StompURL,
	context = 'stylesheet',
) {
	// A stylesheet is parsed with its values, at-rule preludes and selectors
	// left as raw text, and only a piece that could hold a URL is parsed in
	// full, where it stands: parsing every value of a large sheet was nearly
	// all the time (YouTube's 3 MB stylesheet, one url() in it, took 2 s to
	// rewrite in the service worker on every load). The output is the same.
	const lazy = LAZY_CONTEXTS.includes(context);
	if (lazy && !MAY_ROUTE.test(script)) return script;
	const edits = new Edits(script);

	const route = function (
		this: WalkContext,
		node: CssNode,
		/** the at-rule a prelude parsed on its own belongs to */
		atrule?: string,
	) {
		const atruleName = this.atrule?.name ?? atrule;
		// css-tree leaves custom property values (--x: url(...)) unparsed, and
		// anything it could not shape (a block under a malformed at-rule
		// prelude) comes as raw text too: its url()s are routed by the regex
		if (node.type === 'Raw' && node.value.includes('url(')) {
			const generated = rewriteCSSValueURLs(node.value, url);

			if (generated !== node.value) {
				edits.replace(node.loc!.start.offset, node.loc!.end.offset, generated);
			}
		} else if (
			node.type === 'String' &&
			/^(-webkit-)?image-set$|^src$/i.test(this.function?.name ?? '')
		) {
			// a string inside image-set() or src() is a URL: routed as a url()
			// token, so the readback restores the written value like any other
			try {
				const resolved = new StompURL(new URL(node.value, url.toString()), url);
				const generated = generate({
					type: 'Url',
					value: preserveValue(
						routeBinary(resolved),
						`url(${JSON.stringify(node.value)})`,
					),
				});
				edits.replace(node.loc!.start.offset, node.loc!.end.offset, generated);
			} catch (error) {
				// not a URL: left as written
			}
		} else if (node.type === 'String' && atruleName === 'import') {
			try {
				// already routed (a second pass over rewritten text): leave it
				if (node.value.startsWith(`${url.directory}css/`)) return;
				const resolved = new StompURL(new URL(node.value, url.toString()), url);
				const generated = JSON.stringify(routeCSS(resolved, url));

				edits.replace(node.loc!.start.offset, node.loc!.end.offset, generated);
			} catch (error) {
				console.error(error);
			}
		} else if (node.type === 'Url')
			try {
				const routed = originalOf(node.value);
				const original = routed?.url ?? node.value;
				// @ts-ignore
				const resolved = new StompURL(new URL(original, url), url);

				let replace: Url;

				// routed already: the page's token as it was kept
				const raw =
					routed?.token ??
					script.slice(node.loc!.start.offset, node.loc!.end.offset);

				if (atruleName === 'import') {
					replace = {
						type: 'Url',
						value: preserveValue(routeCSS(resolved, url), raw),
					};
				} else {
					replace = {
						type: 'Url',
						value: preserveValue(routeBinary(resolved), raw),
					};
				}

				const generated = generate(replace);

				edits.replace(node.loc!.start.offset, node.loc!.end.offset, generated);
			} catch (error) {
				console.error(error);
			}
	};

	/**
	 * A raw piece of the lazy parse that a full parse would have shaped
	 * (`kind` is its parse context), parsed now where it stands. One that a
	 * full parse could not shape either stays raw, as it would have.
	 */
	const deep = (node: CssNode, kind: string, atrule?: string) => {
		const start = node.loc!.start.offset;
		let piece: CssNode;
		try {
			piece = parse(script.slice(start, node.loc!.end.offset), {
				positions: true,
				context: kind,
				offset: start,
				...(atrule === undefined ? {} : { atrule }),
			} as ParseOptions);
		} catch (error) {
			route.call({}, node, atrule);
			return;
		}
		walk(piece, function (inner) {
			route.call(this as WalkContext, inner, atrule);
		});
	};

	const tree = parse(
		script,
		lazy
			? {
					positions: true,
					context,
					parseValue: false,
					parseAtrulePrelude: false,
					parseRulePrelude: false,
				}
			: { positions: true, context },
	);
	walk(tree, function (node) {
		const walked = this as WalkContext;
		if (lazy && node.type === 'Raw') {
			const kind =
				walked.declaration?.value === node
					? walked.declaration.property.startsWith('--')
						? null
						: 'value'
					: walked.atrule?.prelude === node
						? 'atrulePrelude'
						: walked.rule?.prelude === node
							? 'selectorList'
							: null;
			if (kind !== null) {
				// an @import's prelude is its URL, even as a bare string
				if (
					MAY_ROUTE.test(node.value) ||
					(kind === 'atrulePrelude' && walked.atrule!.name === 'import')
				)
					deep(
						node,
						kind,
						kind === 'atrulePrelude' ? walked.atrule!.name : undefined,
					);
				return;
			}
		}
		route.call(walked, node);
	});

	return edits.result();
}
