// The page's markup, handed to the written document as it is parsed.
//
// The client used to parse the whole markup, copy all of it through the
// hooks and write it in one task: the page painted nothing and loaded
// nothing (not its stylesheets in the head) until every node was copied and
// parsed again, 1.5 s on a 5 MB page and twice that on CNN. Natively the
// parser builds the page as the bytes come and paints between its tasks.
//
// Here the markup goes into an inert document's parser (no frame: nothing
// loads, no script runs), which is the same tree a parse of the whole
// would make, built as far as the markup goes. A node the parser can no
// longer change is copied through the hooks and written; an element it
// may still add to is written as its start tag, its children follow as
// they are done, and its end tag once the parser has moved past it. What is
// written is the whole tree's serialization, cut in pieces, so the written
// document's parser builds the tree the whole one would have.
//
// The parser changes only the open elements' last children, but for a few
// rules, which decide what may be written early:
// - foster parenting puts text and elements before an open table, and the
//   adoption agency moves what an open formatting element holds: neither
//   is ever written as a start tag, only whole once the parser is past it,
//   and a text right before an open table waits with it;
// - after the head ends and before the body starts, a meta, link, style or
//   script still lands in the head: the head is written whole once the
//   body is there (its first <base> is then known, which every URL of the
//   page resolves against, as when the whole markup was copied);
// - a later <html> or <body> tag adds attributes to the root or the body:
//   they are written again as such a tag, which the written document's
//   parser merges the same way;
// - a <frameset> replaces a body that holds nothing yet: nothing of the
//   body is written before it holds an element or text that keeps it.

import { trustedHTML } from '../trusted';

const nodeType = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'nodeType',
)!.get!;
const firstChild = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'firstChild',
)!.get!;
const nextSibling = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'nextSibling',
)!.get!;
const nodeValue = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'nodeValue',
)!.get!;
const localName = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'localName',
)!.get!;
const namespaceURI = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'namespaceURI',
)!.get!;
const documentElement = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'documentElement',
)!.get!;
/** a document's root, by the browser's own getter */
export const rootOf = (document: Document): Element | null =>
	Reflect.apply(documentElement, document, []);
const bodyOf = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'body',
)!.get!;
const doctypeOf = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'doctype',
)!.get!;
const doctypeName = Reflect.getOwnPropertyDescriptor(
	DocumentType.prototype,
	'name',
)!.get!;
const getAttributeNames = Element.prototype.getAttributeNames;
const removeAttribute = Element.prototype.removeAttribute;
const cloneNode = Node.prototype.cloneNode;
const appendChild = Node.prototype.appendChild;
const removeChild = Node.prototype.removeChild;
const replaceChildren = Element.prototype.replaceChildren;
/** `element` emptied, by the browser's own */
export const empty = (element: Element) =>
	Reflect.apply(replaceChildren, element, []);
const createElement = Document.prototype.createElement;
const documentOpen = Document.prototype.open;
const documentWrite = Document.prototype.write;
const documentClose = Document.prototype.close;
const clock = performance;
const clockNow = Performance.prototype.now;
/** the clock's time, by the browser's own (taken before page code ran) */
export const now = (): number => Reflect.apply(clockNow, clock, []);

/** how long the first pass may copy (the head and what is first to paint) */
export const FIRST_PASS_MS = 4;
/** how long any later pass may */
export const PASS_MS = 20;
/**
 * what is copied is written once there is this much of it (a quarter of
 * what is written already, from WRITE_CHARS up to WRITE_MAX), or once the
 * last write is WRITE_MS old (or the parse has nothing more for now): the
 * browser lays out and paints the page after each task that changed it, all
 * of it each time, where natively a loading page is drawn every 250 to 300
 * KB of its markup. Written after each pass, a 20 MB page was laid out 290
 * times (natively 70) and took three times as long to load
 */
export const WRITE_CHARS = 256 * 1024;
export const WRITE_MAX = 1024 * 1024;
export const WRITE_MS = 250;

const HTML = 'http://www.w3.org/1999/xhtml';
// elements whose start tag may be written while the parser still adds to
// them: none moves, none is a table's or a formatting element (each
// between spaces)
const OPENS =
	' html body div section article main header footer nav aside ul ol li dl dd dt form p center blockquote figure figcaption details fieldset address hgroup search menu ';
// what a body can hold while a <frameset> could still replace it
const FRAMESET_OK = ' script style link meta noscript template base title ';
// elements whose text runs to their end tag (the parse's, scripting off:
// not noscript), each between spaces
const RAW_TEXT = ' script style title textarea xmp iframe noembed noframes ';
/** complete nodes copied together, then the clock is read */
const RUN = 64;

/**
 * The markup a client writes as its parse goes. `copy` makes the written
 * markup of `from`'s children (the holder, an element in the parse's tree,
 * so that what stands before a node is still there), or with `shallow` of
 * `from` alone, as its start tag and end tag, through the hooks. `watch` is
 * shown each element before it is copied, in the order of the markup, while
 * it is still where the parse put it, until it answers true.
 */
export default class PageStream {
	readonly #parse: Document;
	readonly #copy: (from: Element, shallow: boolean) => string;
	#watch: ((element: Element) => boolean) | null;
	readonly #holder: Element;
	/** the parse's elements whose start tag is written and end tag not yet */
	readonly #open: Element[] = [];
	/** the attributes written of the root and the body */
	readonly #written = new Map<Element, number>();
	#started = false;
	#ended = false;
	#kept = false;
	/**
	 * `document`: the inert document the parse is made in, or with `whole`
	 * the parse of all of the markup
	 */
	constructor(
		document: Document,
		copy: (from: Element, shallow: boolean) => string,
		watch: (element: Element) => boolean,
		whole = false,
	) {
		const parse = (this.#parse = document);
		if (whole) this.#ended = true;
		else Reflect.apply(documentOpen, parse, []);
		this.#copy = copy;
		this.#watch = watch;
		this.#holder = Reflect.apply(createElement, parse, ['div']) as Element;
	}
	/** more of the page's markup, which ends between whole tokens (`end`: the last of it) */
	add(markup: string, end: boolean) {
		if (this.#ended) return;
		if (markup)
			Reflect.apply(documentWrite, this.#parse, [trustedHTML(markup)]);
		if (end) {
			Reflect.apply(documentClose, this.#parse, []);
			this.#ended = true;
		}
	}
	/** everything is written */
	get done(): boolean {
		return this.#ended && this.#started && !this.#open.length;
	}
	/**
	 * The markup that can be written now, about until `deadline` (the
	 * clock's), or '' while the parse has nothing more that is done
	 */
	take(deadline: number): string {
		const parse = this.#parse;
		let out = '';
		if (!this.#started) {
			const root = Reflect.apply(documentElement, parse, []) as Element | null;
			if (!root) return '';
			const doctype = Reflect.apply(doctypeOf, parse, []);
			if (doctype)
				out += `<!DOCTYPE ${Reflect.apply(doctypeName, doctype, [])}>`;
			this.#started = true;
			// a small page there all of: copied at once, as it always was
			if (this.#small(root)) {
				this.#watch?.(root);
				const holder = this.#holder;
				Reflect.apply(appendChild, holder, [root]);
				Reflect.apply(appendChild, parse, [holder]);
				try {
					return out + this.#copy(holder, false);
				} finally {
					Reflect.apply(removeChild, parse, [holder]);
					empty(holder);
				}
			}
			out += this.#start(root);
			this.#open.push(root);
		}
		out += this.#merged();
		const holder = this.#holder;
		let run = 0;
		const flush = () => {
			if (!run) return '';
			run = 0;
			return this.#copied();
		};
		for (;;) {
			const open = this.#open;
			const parent = open[open.length - 1];
			if (!parent) break;
			const child = Reflect.apply(firstChild, parent, []) as Node | null;
			// (below an element the parser is past, every node is done)
			const closed = this.#closed(open.length - 1);
			if (child !== null && (closed || this.#done(child, parent))) {
				// a large element is written in pieces all the same
				if (this.#opens(child, parent) && large(child as Element)) {
					out += flush();
					out += this.#start(child as Element);
					open.push(child as Element);
					if (now() > deadline) break;
					continue;
				}
				if (
					this.#watch &&
					Reflect.apply(nodeType, child, []) === 1 &&
					this.#watch(child as Element)
				)
					this.#watch = null;
				Reflect.apply(appendChild, holder, [child]);
				if (++run < RUN) continue;
				out += flush();
				if (now() > deadline) break;
				continue;
			}
			out += flush();
			if (child === null) {
				if (!closed) break;
				out += `</${Reflect.apply(localName, parent, [])}>`;
				open.pop();
				// written: gone from the parse, as a copied node is (the parser
				// is past it)
				const above = open[open.length - 1];
				if (above) Reflect.apply(removeChild, above, [parent]);
				continue;
			}
			if (!this.#opens(child, parent)) break;
			out += this.#start(child as Element);
			open.push(child as Element);
			if (now() > deadline) break;
		}
		return out + flush();
	}
	/**
	 * All of a small page's markup, copied now (take), when the whole page
	 * is in the parse and nothing of it is taken yet; else null. The client
	 * copies such a page before it opens the document for it, as it always
	 * did: the copy and the write that runs the page's scripts are tasks of
	 * their own then (prewrite's page of 1 MB of inline scripts had its
	 * longest task 8 ms longer with both in one)
	 */
	takeWhole(): string | null {
		if (this.#started || !this.#ended) return null;
		const root = Reflect.apply(
			documentElement,
			this.#parse,
			[],
		) as Element | null;
		return root && this.#small(root) ? this.take(Infinity) : null;
	}
	/** whether the parse, all there, is a page small enough to copy in one call */
	#small(root: Element): boolean {
		return (
			this.#ended &&
			(Reflect.apply(
				collectionLength,
				Reflect.apply(getElementsByTagName, root, ['*']),
				[],
			) as number) <=
				RUN * 8
		);
	}
	/** an element's start tag, as written */
	#start(element: Element): string {
		const name = Reflect.apply(localName, element, []) as string;
		if (name === 'html' || name === 'body')
			this.#written.set(
				element,
				(Reflect.apply(getAttributeNames, element, []) as string[]).length,
			);
		return startTag(this.#copy(element, true), name);
	}
	/** the holder's nodes, copied, in the parse's tree while they are, and gone after */
	#copied(): string {
		const holder = this.#holder;
		const root = Reflect.apply(documentElement, this.#parse, []) as Element;
		Reflect.apply(appendChild, root, [holder]);
		try {
			return this.#copy(holder, false);
		} finally {
			Reflect.apply(removeChild, root, [holder]);
			empty(holder);
		}
	}
	/**
	 * The attributes a later <html> or <body> tag added to the root or the
	 * body, as such a tag (the written document's parser adds them too)
	 */
	#merged(): string {
		let out = '';
		for (const [element, count] of this.#written) {
			const names = Reflect.apply(getAttributeNames, element, []) as string[];
			if (names.length === count) continue;
			this.#written.set(element, names.length);
			const shallow = Reflect.apply(cloneNode, element, [false]) as Element;
			for (const name of names.slice(0, count))
				Reflect.apply(removeAttribute, shallow, [name]);
			out += startTag(
				this.#copy(shallow, true),
				Reflect.apply(localName, element, []) as string,
			);
		}
		return out;
	}
	/** the open element at `index` is one the parser is past */
	#closed(index: number): boolean {
		if (this.#ended) return true;
		const open = this.#open;
		// (the root and the body until the end: a later tag adds to them)
		for (let i = 2; i <= index; i++)
			if (Reflect.apply(nextSibling, open[i], []) !== null) return true;
		return false;
	}
	/** `child` (`parent`'s first not yet written) is one the parser is done with */
	#done(child: Node, parent: Element): boolean {
		if (this.#ended) return true;
		if (!this.#keeps(child, parent)) return false;
		const next = Reflect.apply(nextSibling, child, []) as Node | null;
		const type = Reflect.apply(nodeType, child, []);
		// the parser may still add to the last node, but for an element whose
		// text is all the parser takes up to its end tag (a script's): each
		// piece of the markup ends between whole tokens, so its end tag was
		// in it. A script that ends a piece runs before the rest arrives, as
		// natively
		if (next === null)
			return (
				type === 1 &&
				Reflect.apply(namespaceURI, child, []) === HTML &&
				RAW_TEXT.includes(` ${Reflect.apply(localName, child, []) as string} `)
			);
		if (type === 1 && isNamed(child, 'head'))
			return Reflect.apply(bodyOf, this.#parse, []) !== null;
		if (type === 1 && isNamed(child, 'body')) return false;
		// foster parenting adds to a text right before an open table
		if (
			type === 3 &&
			Reflect.apply(nodeType, next, []) === 1 &&
			isNamed(next, 'table') &&
			Reflect.apply(nextSibling, next, []) === null
		)
			return false;
		return true;
	}
	/** whether `child` may be written as a start tag before its end */
	#opens(child: Node, parent: Element): boolean {
		if (Reflect.apply(nodeType, child, []) !== 1) return false;
		if (Reflect.apply(namespaceURI, child, []) !== HTML) return false;
		const name = Reflect.apply(localName, child, []) as string;
		if (name === 'head' || !OPENS.includes(` ${name} `)) return false;
		return this.#keeps(child, parent);
	}
	/**
	 * Whether a body's child may be written: a <frameset> replaces a body
	 * that holds only what keeps the parser's frameset-ok flag
	 */
	#keeps(child: Node, parent: Element): boolean {
		if (this.#kept || !isNamed(parent, 'body')) return true;
		const type = Reflect.apply(nodeType, child, []);
		if (
			(type === 1 &&
				!FRAMESET_OK.includes(
					` ${Reflect.apply(localName, child, []) as string} `,
				)) ||
			(type === 3 && /\S/.test(Reflect.apply(nodeValue, child, []) as string))
		)
			this.#kept = true;
		else {
			// a script or white space: kept back while what follows decides
			for (
				let next = Reflect.apply(nextSibling, child, []) as Node | null;
				next !== null;
				next = Reflect.apply(nextSibling, next, []) as Node | null
			) {
				const nextType = Reflect.apply(nodeType, next, []);
				if (
					(nextType === 1 &&
						!FRAMESET_OK.includes(
							` ${Reflect.apply(localName, next, []) as string} `,
						)) ||
					(nextType === 3 &&
						/\S/.test(Reflect.apply(nodeValue, next, []) as string))
				) {
					this.#kept = true;
					break;
				}
			}
		}
		return this.#kept;
	}
}

const childElementCount = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'childElementCount',
)!.get!;
const getElementsByTagName = Element.prototype.getElementsByTagName;
const collectionLength = Reflect.getOwnPropertyDescriptor(
	HTMLCollection.prototype,
	'length',
)!.get!;
/** an element of more than a pass's worth of elements */
function large(element: Element): boolean {
	const children = Reflect.apply(childElementCount, element, []) as number;
	if (children >= RUN) return true;
	if (children === 0) return false;
	return (
		(Reflect.apply(
			collectionLength,
			Reflect.apply(getElementsByTagName, element, ['*']),
			[],
		) as number) >
		RUN * 4
	);
}

/** an element's markup without its end tag */
const startTag = (markup: string, name: string) =>
	markup.endsWith(`</${name}>`) ? markup.slice(0, -name.length - 3) : markup;

const isNamed = (node: Node, name: string) =>
	Reflect.apply(namespaceURI, node, []) === HTML &&
	Reflect.apply(localName, node, []) === name;

// the browser's own, taken when the bundle runs: the page's scripts run
// while the markup is still read
const nativeFetch = globalThis.fetch;
const responseOk = Reflect.getOwnPropertyDescriptor(
	Response.prototype,
	'ok',
)!.get!;
const responseBody = Reflect.getOwnPropertyDescriptor(
	Response.prototype,
	'body',
)!.get!;
const NativeTextDecoder = TextDecoder;
const decode = TextDecoder.prototype.decode;
const parseJSON = JSON.parse;
const indexOf = String.prototype.indexOf;
const slice = String.prototype.slice;

/**
 * Read the rest of a document's markup from the worker (its MARKUP_ROUTE,
 * at `url`), handing each piece to `feed` as it comes: its markup, its
 * table of prewritten scripts and styles (or null), and with the last one
 * the sizes the document's body had ([encoded, decoded]). A read that
 * fails ends the markup where it got to, as a body the network cut short.
 */
export async function readMarkup(
	url: string,
	feed: (
		markup: string,
		table: unknown,
		sizes: [number, number] | null,
		end: boolean,
	) => void,
): Promise<void> {
	// the streams' methods are taken when the read begins, in the shell's
	// script, before any script of the page's: a frame that reads no
	// stream never makes their interfaces (about 4 KB of every frame's
	// heap, frame-cost)
	const getReader = globalThis.ReadableStream.prototype.getReader;
	const readChunk = globalThis.ReadableStreamDefaultReader.prototype.read;
	let ended = false;
	try {
		const response = (await Reflect.apply(nativeFetch, globalThis, [
			url,
			{ cache: 'no-store', credentials: 'omit' },
		])) as Response;
		if (!Reflect.apply(responseOk, response, []))
			throw new Error(`no markup stream (${url})`);
		const reader = Reflect.apply(
			getReader,
			Reflect.apply(responseBody, response, []),
			[],
		) as ReadableStreamDefaultReader<Uint8Array>;
		const decoder = new NativeTextDecoder();
		let text = '';
		for (;;) {
			const chunk = (await Reflect.apply(
				readChunk,
				reader,
				[],
			)) as ReadableStreamReadResult<Uint8Array>;
			if (chunk.done) break;
			text += Reflect.apply(decode, decoder, [
				chunk.value,
				{ stream: true },
			]) as string;
			// each record is `<length>\n<JSON>`
			for (;;) {
				const line = Reflect.apply(indexOf, text, ['\n']) as number;
				if (line < 0) break;
				const length = +(Reflect.apply(slice, text, [0, line]) as string);
				if (text.length < line + 1 + length) break;
				// (by index: a page's Array.prototype iterator is not asked)
				const record = parseJSON(
					Reflect.apply(slice, text, [line + 1, line + 1 + length]) as string,
				) as [string, unknown, [number, number] | null];
				const markup = record[0];
				const table = record[1];
				const sizes = record[2];
				text = Reflect.apply(slice, text, [line + 1 + length]) as string;
				ended = sizes !== null;
				feed(markup, table, sizes, ended);
				if (ended) return;
			}
		}
	} catch (error) {
		console.warn('Stomp: the markup stream failed:', error);
	}
	if (!ended) feed('', null, null, true);
}
