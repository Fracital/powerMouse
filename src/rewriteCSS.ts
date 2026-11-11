import type { CssNode, ParseOptions, Url } from 'css-tree';
// the parser, walker and generator alone: the whole syntax builds a lexer
// from css-tree's grammar data, which the rewriter never asks for
import generate from 'css-tree/generator';
import parse from 'css-tree/parser';
import walk from 'css-tree/walker';
import { LAZY_CONTEXTS, MAY_ROUTE } from './cssURL';
import {
	originalOf,
	preserveValue,
	rewriteCSSValueURLs as rewriteValueURLsInJS,
	routeCSS,
} from './cssURLs';
import { provideRewriters } from './rewriters';
import { routeBinary } from './routeURL';
import StompURL from './StompURL';
import { rewriteStyles, rewriteValueURLs } from './wasm/scanner';

export { restoreCSSValueURLs, routeCSS } from './cssURLs';

/**
 * Asks for the wasm backend (`rewriter: 'wasm'`), and is told which backend
 * did the rewrite: the module (rust/rwcss, `wasm`) or the JavaScript below
 * (`js`: this thread holds no module, the module declined the text, or it
 * was in a call already). Left as it was when there was nothing to look
 * into. The output is the same either way, byte for byte.
 */
export interface StyleRewrittenBy {
	by?: 'wasm' | 'js';
}

/**
 * Route every url() in a raw CSS value (cssURLs' rewriteCSSValueURLs, the
 * expression): in the module when `told` asks for it and this thread holds
 * it, in JavaScript otherwise. The module's answer is the expression's, but
 * on a single value the expression is the faster of the two (2.7 against
 * 4.7 microseconds: the text crosses into the module and back), so the
 * callers of this build do not ask.
 */
export function rewriteCSSValueURLs(
	value: string,
	url: StompURL,
	told?: StyleRewrittenBy,
): string {
	if (told && value.includes('url(')) {
		const output = rewriteValueURLs(value, url);
		told.by = output === null ? 'js' : 'wasm';
		if (output !== null) return output;
	}
	return rewriteValueURLsInJS(value, url);
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

/** css-tree's parser as its parse contexts see it (`this`): the token buffer it keeps from one parse to the next */
interface Tokens {
	offsetAndType?: Uint32Array;
	tokenCount: number;
}
type ParseContext = (this: Tokens, options: ParseOptions) => CssNode;
/** css-tree's parse contexts by name: the parser looks the one to run up here on every parse */
const contexts = (
	parse as unknown as { config?: { context?: Record<string, ParseContext> } }
).config?.context;
const CLEARED = 'cleared';
// css-tree reads one token of its buffer that the parse at hand never
// writes: when the outermost block of a sheet closes, the bracket it waits
// for next is the pair of the token at index `source.length`
// (TokenStream.setSource), which is whatever a longer sheet parsed earlier
// left there. With an opening bracket there, a closing bracket with nothing
// open (`a{} } b{}`) matched it and the balance table went round in a
// circle: the same sheet parsed differently after another sheet, and for
// some the recovery never ended, making nodes until the heap was gone (a
// sheet of 32 characters, in the service worker and in the page). So a
// parse runs in a context that runs the one asked for and then clears the
// tokens it wrote: every parse reads a buffer of zeros, as the first does.
if (contexts)
	contexts[CLEARED] = function (options) {
		try {
			return contexts[(options as { inner: string }).inner]!.call(
				this,
				options,
			);
		} finally {
			this.offsetAndType?.fill(0, 0, this.tokenCount + 1);
		}
	};
/** css-tree's parse, the same whatever it parsed before */
const parseCleared = (
	text: string,
	options: ParseOptions & { context: string },
): CssNode =>
	contexts && options.context in contexts
		? parse(text, {
				...options,
				context: CLEARED,
				inner: options.context,
			} as ParseOptions)
		: parse(text, options);

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
	/** `rewriter: 'wasm'`: the module rewrites the text when this thread holds it; the output is the same with it and without */
	told?: StyleRewrittenBy,
) {
	// A stylesheet is parsed with its values, at-rule preludes and selectors
	// left as raw text, and only a piece that could hold a URL is parsed in
	// full, where it stands: parsing every value of a large sheet was nearly
	// all the time (YouTube's 3 MB stylesheet, one url() in it, took 2 s to
	// rewrite in the service worker on every load). The output is the same.
	const lazy = LAZY_CONTEXTS.includes(context);
	if (lazy && !MAY_ROUTE.test(script)) return script;
	// The module does all of what follows (css-tree's tokenizer and parsers
	// ported, the same routing asked of this thread URL by URL), and what it
	// cannot do the same it declines.
	if (told && lazy) {
		const output = rewriteStyles(script, url, context);
		told.by = output === null ? 'js' : 'wasm';
		if (output !== null) return output;
	}
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
			const generated = rewriteValueURLsInJS(node.value, url);

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
				// a URL that does not parse loads nothing natively, and says
				// nothing: left as written (the browser fails to parse it too)
				if (!(error instanceof TypeError)) console.error(error);
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
				// as for @import: a URL that does not parse is left as written
				if (!(error instanceof TypeError)) console.error(error);
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
			piece = parseCleared(script.slice(start, node.loc!.end.offset), {
				positions: true,
				context: kind,
				offset: start,
				...(atrule === undefined ? {} : { atrule }),
			} as ParseOptions & { context: string });
		} catch (error) {
			route.call({}, node, atrule);
			return;
		}
		walk(piece, function (inner) {
			route.call(this as WalkContext, inner, atrule);
		});
	};

	const tree = parseCleared(
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

provideRewriters({ modifyCSS });
