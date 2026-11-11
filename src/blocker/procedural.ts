// The procedural cosmetic filters of the lists, applied in the page
// (docs/adblock.md). The crate only parses them (`example.com##div:has-text(
// Sponsored)` comes out as a chain of operators, filters/cosmetic.rs); a
// content blocker's content script interprets them against the DOM, and so
// does this, with uBlock Origin's semantics for each operator. Everything
// that touches the DOM goes through the natives the inject took before it
// hooked anything (`Dom`), so the page's replacements are never called and
// the proxy's own hooks never run for the blocker's reads.
import type { ProceduralFilter } from './types';

/** the DOM as the blocker reads and edits it: natives of the page's realm */
export interface Dom {
	document: Document;
	/** the real page's path and query (`:matches-path()`) */
	path: string;
	queryAll(root: Document | Element, selector: string): Element[];
	parent(element: Element): Element | null;
	closest(element: Element, selector: string): Element | null;
	text(element: Element): string;
	attributes(element: Element): [string, string][];
	computed(element: Element, pseudo: string | null, property: string): string;
	xpath(expression: string, context: Node): Element[];
	remove(element: Element): void;
	removeAttribute(element: Element, name: string): void;
	removeClass(element: Element, name: string): void;
	/** inline declarations added to the element's style */
	style(element: Element, declarations: string): void;
}

type Test = (text: string) => boolean;

/** a filter argument as a test: `/regex/flags`, or a literal that must be contained (or equal, when `whole`) */
function testOf(arg: string, whole = false): Test {
	const regex = /^\/(.+)\/([dgimsuvy]*)$/s.exec(arg);
	if (regex)
		try {
			const compiled = new RegExp(regex[1], regex[2].replace(/[gy]/g, ''));
			return (text) => compiled.test(text);
		} catch (error) {
			return () => false;
		}
	return whole ? (text) => text === arg : (text) => text.includes(arg);
}

const unquote = (text: string): string =>
	/^(["']).*\1$/s.test(text) ? text.slice(1, -1) : text;

type Step = (nodes: Element[] | null, dom: Dom) => Element[];

/** every element under the roots (or the document) the selector names */
function select(selector: string): Step {
	// a selector that starts with a combinator is relative to each node; a
	// sibling combinator is asked of the parent, naming the node by its place
	const relative = /^\s*[>+~]/.test(selector);
	const sibling = /^\s*[+~]/.test(selector);
	return (nodes, dom) => {
		if (nodes === null) return dom.queryAll(dom.document, selector);
		const out = new Set<Element>();
		for (const node of nodes)
			try {
				let found: Element[];
				if (sibling) {
					const parent = dom.parent(node);
					if (!parent) continue;
					const place = dom.queryAll(parent, ':scope > *').indexOf(node) + 1;
					found = dom.queryAll(
						parent,
						`:scope > :nth-child(${place}) ${selector}`,
					);
				} else
					found = dom.queryAll(
						node,
						relative ? `:scope ${selector}` : selector,
					);
				for (const element of found) out.add(element);
			} catch (error) {
				// not a selector this browser takes
			}
		return [...out];
	};
}

const filtering =
	(keep: (element: Element, dom: Dom) => boolean): Step =>
	(nodes, dom) =>
		(nodes ?? dom.queryAll(dom.document, '*')).filter((element) => {
			try {
				return keep(element, dom);
			} catch (error) {
				return false;
			}
		});

function matchesCss(arg: string, pseudo: string | null): Step {
	const colon = arg.indexOf(':');
	if (colon === -1) return () => [];
	const property = arg.slice(0, colon).trim();
	const test = testOf(arg.slice(colon + 1).trim(), true);
	return filtering((element, dom) =>
		test(dom.computed(element, pseudo, property)),
	);
}

function matchesAttr(arg: string): Step {
	// `name`, `name=value`, either side quoted or a /regex/
	const split = /^((?:"[^"]*"|'[^']*'|\/.+?\/[a-z]*|[^=])+?)(?:=(.*))?$/s.exec(
		arg.trim(),
	);
	if (!split) return () => [];
	const name = testOf(unquote(split[1].trim()), true);
	const value =
		split[2] === undefined ? null : testOf(unquote(split[2].trim()), true);
	return filtering((element, dom) =>
		dom
			.attributes(element)
			.some(
				([attribute, text]) =>
					name(attribute) && (value === null || value(text)),
			),
	);
}

function upward(arg: string): Step {
	const levels = /^\d+$/.test(arg.trim()) ? Number(arg) : null;
	return (nodes, dom) => {
		const out = new Set<Element>();
		for (const node of nodes ?? []) {
			let found: Element | null = node;
			if (levels !== null)
				for (let i = 0; i < levels && found; i++) found = dom.parent(found);
			else {
				const parent = dom.parent(node);
				try {
					found = parent ? dom.closest(parent, arg) : null;
				} catch (error) {
					found = null;
				}
			}
			if (found) out.add(found);
		}
		return [...out];
	};
}

function stepOf(type: string, arg: string): Step | null {
	switch (type) {
		case 'css-selector':
			return select(arg);
		case 'has-text': {
			const test = testOf(arg);
			return filtering((element, dom) => test(dom.text(element)));
		}
		case 'min-text-length': {
			const least = Number(arg);
			return filtering((element, dom) => dom.text(element).length >= least);
		}
		case 'matches-attr':
			return matchesAttr(arg);
		case 'matches-css':
			return matchesCss(arg, null);
		case 'matches-css-before':
			return matchesCss(arg, '::before');
		case 'matches-css-after':
			return matchesCss(arg, '::after');
		case 'matches-path': {
			const test = testOf(arg);
			return (nodes, dom) =>
				test(dom.path) ? (nodes ?? dom.queryAll(dom.document, '*')) : [];
		}
		case 'upward':
			return upward(arg);
		case 'xpath':
			return (nodes, dom) => {
				const out = new Set<Element>();
				for (const node of nodes ?? [dom.document.documentElement])
					try {
						if (node) for (const found of dom.xpath(arg, node)) out.add(found);
					} catch (error) {
						// not an expression this browser takes
					}
				return [...out];
			};
		default:
			return null;
	}
}

/** a filter ready to run: the elements it names now, and what is done to each */
export interface CompiledFilter {
	/** a plain selector with a style: a rule of the blocker's stylesheet, no DOM work */
	css?: string;
	matches(dom: Dom): Element[];
	/** the filter's action on a matched element (nothing for a filter that hides) */
	act(element: Element, dom: Dom): void;
	/** matched elements are hidden by the caller (no action of the filter's own) */
	hides: boolean;
}

/** the crate's JSON for one procedural or action filter, compiled; null for one this interpreter does not know */
export function compileFilter(json: string): CompiledFilter | null {
	let filter: ProceduralFilter;
	try {
		filter = JSON.parse(json) as ProceduralFilter;
	} catch (error) {
		return null;
	}
	if (!Array.isArray(filter.selector) || !filter.selector.length) return null;
	const steps: Step[] = [];
	for (const part of filter.selector) {
		const step = stepOf(part.type, String(part.arg ?? ''));
		if (!step) return null;
		steps.push(step);
	}
	const action = filter.action;
	const plain =
		filter.selector.length === 1 && filter.selector[0].type === 'css-selector'
			? filter.selector[0].arg
			: null;
	return {
		...(plain !== null && action?.type === 'style'
			? { css: `${plain}{${action.arg ?? ''}}` }
			: {}),
		hides: !action,
		matches(dom) {
			let nodes: Element[] | null = null;
			for (const step of steps) {
				nodes = step(nodes, dom);
				if (!nodes.length) return nodes;
			}
			return nodes ?? [];
		},
		act(element, dom) {
			if (!action) return;
			switch (action.type) {
				case 'remove':
					dom.remove(element);
					break;
				case 'style':
					dom.style(element, action.arg ?? '');
					break;
				case 'remove-attr':
					dom.removeAttribute(element, action.arg ?? '');
					break;
				case 'remove-class':
					dom.removeClass(element, action.arg ?? '');
					break;
			}
		},
	};
}
