import type DocumentClient from './Client';
import cloneRawNode, { parseHTMLContainer } from './cloneNode';
import { completeLength } from './writeTokenizer';

/**
 * What one document has pending between document.write calls: the tail of
 * the last call that was not a whole token yet (held back, prepended to
 * the next call), the elements the written markup left open, and the
 * script that wrote them (a different script's writes land among different
 * ancestors).
 */
interface WriteState {
	tail: string;
	stack: string[];
	script: Element | null;
}

const STATES = new WeakMap<object, WriteState>();

// the comment appended to the markup before it is parsed: the open elements
// at the end of the write are its ancestors, and everything the serializer
// emits after it is an end tag the page did not write
const SENTINEL = 'stomp-write-end';
const SENTINEL_COMMENT = `<!--${SENTINEL}-->`;
const ELEMENT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The document.write stream of a document, rewritten the way the browser's
 * own parser sees it: markup is tokenized across calls (an open tag, raw
 * text element or comment waits for the call that finishes it), and the
 * elements a call leaves open are reopened as context for the next one, so
 * `write('<div>'); write('x</div>')` makes one div with `x` inside rather
 * than a closed div followed by text and a dropped end tag.
 */
export default class WriteStream {
	readonly #client: DocumentClient;
	constructor(client: DocumentClient) {
		this.#client = client;
	}
	/** the state of `document` (any object the page called write on) */
	#state(document: object): WriteState {
		let state = STATES.get(document);
		if (!state) {
			state = { tail: '', stack: [], script: null };
			STATES.set(document, state);
		}
		return state;
	}
	/** nothing is pending any more (an explicit open, a close, the parser's end) */
	reset(document: object) {
		STATES.delete(document);
	}
	/**
	 * The text document.close() must still hand to the parser: the browser
	 * would see the unfinished tail at the end of its input the same way.
	 */
	take(document: object): string {
		const tail = STATES.get(document)?.tail ?? '';
		this.reset(document);
		return tail;
	}
	/**
	 * The markup to write now for `text`; the incomplete tail is kept.
	 * `opens`: this write opens a fresh document (just opened, or a write
	 * once the document had loaded), whose doctype and html, head and body
	 * tags are the document's own, not a fragment's.
	 */
	write(document: object, text: string, opens = false): string {
		const state = this.#state(document);
		// a fresh document's doctype and html, head and body tags go first, as
		// they are; the rest is this document's stream from there on (a tail
		// the write leaves unfinished waits for the next one)
		let prelude = '';
		if (opens && !state.tail) {
			const found = this.#prelude(text);
			if (found) {
				prelude = found.markup;
				text = found.rest;
				state.stack = [];
			}
		}
		const script = this.#currentScript(document);
		if (state.script !== script) {
			state.script = script;
			state.stack = this.#ancestors(script);
		}
		const buffer = state.tail + text;
		const end = completeLength(buffer);
		state.tail = buffer.slice(end);
		if (end === 0) return prelude;
		return prelude + this.#rewrite(buffer.slice(0, end), state);
	}
	/**
	 * A fresh document's markup that starts with its prelude: the doctype
	 * as written, the html, head and body start tags with their attributes
	 * (routed by the hooks, as any element's) and the head's content
	 * rewritten as a fragment; `rest` is what follows, for the document's own
	 * stream (a tail it leaves unfinished waits for the next write). Null
	 * when the markup does not start with a prelude (a fragment, as any other
	 * write).
	 */
	#prelude(markup: string): { markup: string; rest: string } | null {
		const match =
			/^(\s*(?:<!--[\s\S]*?-->\s*)*)(<!doctype[^>]*>)?(\s*)(<html\b[^>]*>)?(\s*)(?:(<head\b[^>]*>)([\s\S]*?)(<\/head\s*>))?(\s*)(<body\b[^>]*>)?/i.exec(
				markup,
			);
		if (!match || !(match[2] || match[4] || match[6] || match[10])) return null;
		const [whole, lead, doctype, , html, , head, headContent, , , body] = match;
		const tag = (start: string | undefined, name: string) => {
			if (!start) return '';
			// the start tag's attributes on an element of the client's
			// document, through the hooks, serialized back as `name`'s
			const attributes = start.replace(/^<\w+/i, '').replace(/\/?>$/, '');
			const holder = parseHTMLContainer(
				`<div${attributes}></div>`,
				this.#client.global.document,
			);
			const div = this.#client.global.document.createElement('div');
			div.append(
				cloneRawNode([...holder.childNodes], this.#client.global.document),
			);
			const serialized = this.#client.innerHTMLOf(div);
			const open = /^<div([^>]*)>/i.exec(serialized)?.[1] ?? '';
			return `<${name}${open}>`;
		};
		const headState: WriteState = { tail: '', stack: [], script: null };
		return {
			markup:
				lead +
				(doctype ?? '') +
				tag(html, 'html') +
				(head
					? `${tag(head, 'head')}${headContent ? this.#rewrite(headContent, headState) : ''}</head>`
					: '') +
				tag(body, 'body'),
			rest: markup.slice(whole.length),
		};
	}
	#currentScript(document: object): Element | null {
		const doc = document as { currentScript?: unknown };
		const script =
			'currentScript' in doc
				? doc.currentScript
				: this.#client.global.document.currentScript;
		return typeof script === 'object' ? (script as Element | null) : null;
	}
	/**
	 * The parser's stack of open elements when a parser-inserted script
	 * runs: the script's ancestors below the body (or head). What the script
	 * writes is inserted there, so an end tag it writes may close one of
	 * them.
	 */
	#ancestors(script: Element | null): string[] {
		const stack: string[] = [];
		for (
			let node = script?.parentElement;
			node && !/^(html|head|body)$/.test(node.localName);
			node = node.parentElement
		) {
			if (!ELEMENT_NAME.test(node.localName)) return [];
			stack.unshift(node.localName);
		}
		return stack;
	}
	#rewrite(markup: string, state: WriteState): string {
		// a script copied while the page's markup is rewritten is copied at
		// once (a document no worker controls; see placeLoad)
		const writing = this.#client.writing;
		this.#client.writing = true;
		try {
			return this.#rewriteNow(markup, state);
		} finally {
			this.#client.writing = writing;
		}
	}
	#rewriteNow(markup: string, state: WriteState): string {
		const result = this.#parse(markup, state.stack);
		if (result) {
			state.stack = result.stack;
			return result.html;
		}
		// the context did not come out in front (the markup moved out of it,
		// as the parser's foster parenting does): the fragment on its own
		const bare = this.#parse(markup, []);
		state.stack = bare ? bare.stack : [];
		return bare ? bare.html : this.#parseFlat(markup);
	}
	/**
	 * Parse `markup` with the open elements `stack` reopened in front of it,
	 * rewrite it, and serialize what the page wrote: the reopened context is
	 * cut off the front, the end tags the serializer added for elements
	 * still open are cut off the end.
	 */
	#parse(
		markup: string,
		stack: string[],
	): { html: string; stack: string[] } | null {
		const document = this.#client.global.document;
		const context = stack.map((name) => `<${name}>`).join('');
		const container = parseHTMLContainer(
			context + markup + SENTINEL_COMMENT,
			document,
		);
		// the sentinel is the last node: its ancestors are the open elements
		const open: string[] = [];
		let node: Node | null = container.lastChild;
		while (node && node.nodeType === 1) {
			open.push((node as Element).localName);
			node =
				(node as Element).localName === 'template'
					? (node as HTMLTemplateElement).content.lastChild
					: node.lastChild;
		}
		if (!node || node.nodeType !== 8 || node.nodeValue !== SENTINEL)
			return null;
		const html = this.#serialize([...container.childNodes]);
		if (!html.startsWith(context)) return null;
		const at = html.lastIndexOf(SENTINEL_COMMENT);
		if (at < context.length) return null;
		return { html: html.slice(context.length, at), stack: open };
	}
	/** the markup as one complete fragment (what every write used to be) */
	#parseFlat(markup: string): string {
		return this.#serialize([
			...parseHTMLContainer(markup, this.#client.global.document).childNodes,
		]);
	}
	#serialize(nodes: Node[]): string {
		const document = this.#client.global.document;
		// the client's document (this hook also serves a child frame the
		// parent injected); scripts in the markup run when the parser sees
		// them, so they are rewritten here like the written page's
		const div = document.createElement('div');
		div.append(cloneRawNode(nodes, document));
		this.#client.rewriteInlineScripts(div);
		return this.#client.innerHTMLOf(div);
	}
}
