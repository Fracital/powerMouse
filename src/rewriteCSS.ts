import {
	generate,
	parse,
	Url,
	walk,
	type CssNode,
	type ParseOptions,
} from 'css-tree';
import {
	originalOf,
	preserveValue,
	rewriteCSSValueURLs,
	routeCSS,
} from './cssURLs';
import { provideRewriters } from './rewriters';
import { routeBinary } from './routeURL';
import StompURL from './StompURL';

export { restoreCSSValueURLs, rewriteCSSValueURLs, routeCSS } from './cssURLs';

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

provideRewriters({ modifyCSS });
