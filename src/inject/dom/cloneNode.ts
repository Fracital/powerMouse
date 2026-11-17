import { LazyWeakMap, LazyWeakSet } from '../ownCollections';
import { asParsed, trustedHTML } from '../trusted';

// the native parser call, taken before the Trusted Types parse wrap
// (src/inject/dom/modules/TrustedParse.ts): STomp's own parses are never
// judged by the page's require-trusted-types-for
const nativeParseFromString =
	typeof DOMParser === 'function' ? DOMParser.prototype.parseFromString : null;

/** the DOMParser of the document's own realm (a child frame runs its creator's bundle) */
function parserFor(document: Document): DOMParser {
	const Parser =
		(document.defaultView as { DOMParser?: typeof DOMParser } | null)
			?.DOMParser ?? DOMParser;
	return new Parser();
}

function parse(
	document: Document,
	markup: string,
	mime: DOMParserSupportedType,
): Document {
	const parser = parserFor(document);
	return nativeParseFromString
		? (Reflect.apply(nativeParseFromString, parser, [markup, mime]) as Document)
		: parser.parseFromString(markup, mime);
}

export function parseHTML(
	script: string,
	document: Document = globalThis.document,
	mime: DOMParserSupportedType = 'text/html',
) {
	return parse(document, trustedHTML(script), mime);
}

/**
 * Parse markup into nodes that stay in the parser's inert document: moving
 * them into the page's document would start their loads (an `<img src>`
 * fires `error` with its raw `onerror` the moment it is adopted), so the
 * page only ever sees the re-created copies cloneRawNode makes from them.
 */
export function parseHTMLFragment(
	script: string,
	document: Document = globalThis.document,
): Node[] {
	return [...parseHTMLContainer(script, document).childNodes];
}

/** the inert element the fragment was parsed into (its children are the nodes) */
export function parseHTMLContainer(
	script: string,
	document: Document = globalThis.document,
): Element {
	const parsed = parse(
		document,
		trustedHTML(`<fragment>${script}</fragment>`),
		'text/html',
	);
	return parsed.body.children[0];
}

// taken before the DOM hooks replace the getter
export const nativeAttributes = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'attributes',
)!.get!;

const nativeGetAttributeNames = Element.prototype.getAttributeNames;
const nativeGetAttributeNS = Element.prototype.getAttributeNS;
const nativeHasAttributeNS = Element.prototype.hasAttributeNS;

/**
 * A parsed element's attributes as [namespace, qualified name, value], in
 * their order. Read by name where that is exact: Blink makes the element's
 * attribute map, an Attr node for each attribute and their wrappers the
 * moment `attributes` is read, and for an element of markup parsed only to
 * be copied all of it is garbage (on a page of links, the copy's largest
 * share of what it left to the collector). An attribute of a namespace (a
 * prefixed name, an unprefixed one of a namespace, or two of one name) is
 * read from the map, as before.
 */
function attributesOf(element: Element): [string | null, string, string][] {
	const names = Reflect.apply(nativeGetAttributeNames, element, []) as string[];
	const out: [string | null, string, string][] = [];
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		let plain = !name.includes(':');
		for (let j = 0; plain && j < i; j++) if (names[j] === name) plain = false;
		if (plain)
			plain = Reflect.apply(nativeHasAttributeNS, element, [
				null,
				name,
			]) as boolean;
		if (!plain)
			return Array.from(
				Reflect.apply(nativeAttributes, element, []) as NamedNodeMap,
				(attribute) => [
					attribute.namespaceURI,
					attribute.name,
					attribute.value,
				],
			);
		out.push([
			null,
			name,
			Reflect.apply(nativeGetAttributeNS, element, [null, name]) as string,
		]);
	}
	return out;
}

const nativeOwnerDocument = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'ownerDocument',
)!.get!;
const nativeTemplateContent = Reflect.getOwnPropertyDescriptor(
	HTMLTemplateElement.prototype,
	'content',
)!.get!;
const nativeAdoptNode = Document.prototype.adoptNode;
const nativeNodeType = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'nodeType',
)!.get!;
const nativeLocalName = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'localName',
)!.get!;
const nativeNamespace = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'namespaceURI',
)!.get!;

/**
 * Whether `node` is an HTML <template>, whose children live in its content.
 * Its name alone does not tell: an XHTML document's is `template`, and an
 * element of another namespace may be named `TEMPLATE` (createElementNS, or
 * an XML document), which has no content and whose HTMLTemplateElement
 * accessors throw "Illegal invocation".
 */
export function isHTMLTemplate(node: unknown): node is HTMLTemplateElement {
	try {
		return (
			Reflect.apply(nativeNodeType, node, []) === 1 &&
			Reflect.apply(nativeLocalName, node, []) === 'template' &&
			Reflect.apply(nativeNamespace, node, []) ===
				'http://www.w3.org/1999/xhtml'
		);
	} catch (error) {
		// not a node
		return false;
	}
}

/**
 * Script elements known to be "already started", which the browser tells
 * nobody: the ones a markup string made, the ones seen running. Text that
 * lands in one never runs, so the hooks leave it as the page wrote it.
 */
export const startedScripts = new WeakSet<object>();

/**
 * Whether `node` is a script element, an HTML one or an SVG one: the two
 * the browser runs. Read by the browser's own getters, like isHTMLTemplate
 * (an element of another namespace named `script` is no script, and an SVG
 * one's nodeName is lowercase).
 */
export function isScriptElement(node: unknown): node is Element {
	try {
		if (
			Reflect.apply(nativeNodeType, node, []) !== 1 ||
			Reflect.apply(nativeLocalName, node, []) !== 'script'
		)
			return false;
		const namespace = Reflect.apply(nativeNamespace, node, []);
		return (
			namespace === 'http://www.w3.org/1999/xhtml' ||
			namespace === 'http://www.w3.org/2000/svg'
		);
	} catch (error) {
		// not a node
		return false;
	}
}

/**
 * The document a template's content lives in: inert, with no window and so
 * no custom element registry. What the parser puts in a template is made
 * there, so a defined custom element in it is not constructed until the
 * page clones it into its own document (Polymer and YouTube take the
 * "[[...]]" bindings off a template's attributes first; an element made in
 * the page's document is constructed with them on and reads them as its
 * data).
 */
export function templateContentDocument(template: Element): Document {
	return Reflect.apply(
		nativeOwnerDocument,
		Reflect.apply(nativeTemplateContent, template, []),
		[],
	) as Document;
}

/**
 * An inert document of `document`'s kind (HTML for an HTML page, XML
 * otherwise) to build a throwaway copy of markup in: made in the page's
 * document, every defined custom element in the copy would be constructed,
 * and then again for the markup the browser parses from it.
 */
export function inertDocumentOf(document: Document): Document {
	// in the HTML namespace, so it is a template in an SVG document too
	// (by the browser's own createElementNS: the page's could hand back an
	// element of its own)
	return templateContentDocument(
		Reflect.apply(nativeCreateElementNS, document, [
			'http://www.w3.org/1999/xhtml',
			'template',
		]) as Element,
	);
}

// taken before the DOM hooks replace the setter
const nativeInnerHTMLSet = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'innerHTML',
)!.set!;
const nativeCreateElementNS = Document.prototype.createElementNS;
const nativeChildNodes = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'childNodes',
)!.get!;

const nativeCreateElement = Document.prototype.createElement;
/** an element of `name` made by `document`'s createElement, the browser's own */
export const createElementIn = (document: Document, name: string) =>
	Reflect.apply(nativeCreateElement, document, [name]) as Element;
/** an HTML element of `name` in `document`, by the browser's own createElementNS */
export const createHTMLElement = (document: Document, name: string) =>
	Reflect.apply(nativeCreateElementNS, document, [
		'http://www.w3.org/1999/xhtml',
		name,
	]) as Element;

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const nativeGetAttribute = Element.prototype.getAttribute;
const nativeSetAttribute = Element.prototype.setAttribute;
/**
 * An element of `context`'s name and namespace in `inert`, to parse markup
 * in as the browser parses it in `context`: a MathML <annotation-xml> with
 * its `encoding` too, which makes it a place HTML goes in (an
 * `encoding="text/html"` one's <script> is an HTML script, of none a
 * MathML one). By the browser's own members.
 */
export function holderLike(inert: Document, context: Element): Element {
	const namespace = Reflect.apply(nativeNamespace, context, []);
	const name = Reflect.apply(nativeLocalName, context, []);
	const holder = Reflect.apply(nativeCreateElementNS, inert, [
		namespace,
		name,
	]) as Element;
	if (namespace === MATHML_NAMESPACE && name === 'annotation-xml') {
		const encoding = Reflect.apply(nativeGetAttribute, context, ['encoding']);
		if (encoding !== null)
			Reflect.apply(nativeSetAttribute, holder, ['encoding', encoding]);
	}
	return holder;
}

/**
 * Parse markup as the browser parses it into `context` (innerHTML, the
 * parent for outerHTML, insertAdjacentHTML's element or parent): a <tr> in
 * a table section stays a row, an <svg>'s markup is SVG, a <textarea>'s or
 * <title>'s is text, a <colgroup>'s columns. The browser's own innerHTML
 * of a holder of the same name and namespace in an inert document, like
 * parseHTMLFragment (whose body context is what a context of none gets):
 * its scripts are marked as started, as the fragment parser marks them,
 * so none of them ever runs.
 */
export function parseHTMLFragmentIn(
	script: string,
	context: Element | null,
	document: Document = globalThis.document,
): Node[] {
	if (context === null) return parseHTMLFragment(script, document);
	const holder = holderLike(inertDocumentOf(document), context);
	Reflect.apply(nativeInnerHTMLSet, holder, [trustedHTML(script)]);
	// a template's markup lands in its content
	const parent = isHTMLTemplate(holder)
		? Reflect.apply(nativeTemplateContent, holder, [])
		: holder;
	return [...(Reflect.apply(nativeChildNodes, parent, []) as NodeList)];
}

const nativeParentNode = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'parentNode',
)!.get!;
const nativeRemoveChild = Node.prototype.removeChild;
const nativeQuerySelectorAll: Record<number, (selectors: string) => unknown> = {
	1: Element.prototype.querySelectorAll,
	9: Document.prototype.querySelectorAll,
	11: DocumentFragment.prototype.querySelectorAll,
};

const nativeRemoveAttribute = Element.prototype.removeAttribute;

/**
 * Let go of markup parsed or copied only to be read: a parse the hooks clone
 * the page's nodes from, a copy they serialize. Such a document is inert (no
 * frame: nothing loads), but it is the window's: a `<source media>` listens
 * to its media query there, and Blink keeps a MediaQueryList with a listener
 * alive as a pending activity, and an `<img>` can listen to the viewport of
 * a document that outlives the copy (a template's inert document lives as
 * long as the page's). Either kept the whole tree and its document for the
 * window's life: Wikipedia kept three copies of every page, Notion its whole
 * markup, and each innerHTML written or read with a `<picture>` in it kept
 * one more. So every source loses its media query and leaves its parent,
 * and every image leaves its parent (removal is what drops its listener),
 * in template contents too.
 */
export function releaseMarkup(root: Node | null | undefined): void {
	if (!root) return;
	try {
		const type = Reflect.apply(nativeNodeType, root, []) as number;
		const query = nativeQuerySelectorAll[type];
		if (!query) return;
		const nodes: Element[] = [
			...(Reflect.apply(query, root, ['source, img, template']) as Element[]),
		];
		if (type === 1) nodes.push(root as Element);
		for (const node of nodes) {
			const name = Reflect.apply(nativeLocalName, node, []);
			// an HTML template's content only: one of another namespace has none
			if (isHTMLTemplate(node)) {
				releaseMarkup(Reflect.apply(nativeTemplateContent, node, []) as Node);
				continue;
			}
			if (name !== 'source' && name !== 'img') continue;
			if (name === 'source')
				Reflect.apply(nativeRemoveAttribute, node, ['media']);
			const parent = Reflect.apply(nativeParentNode, node, []) as Node | null;
			if (parent) Reflect.apply(nativeRemoveChild, parent, [node]);
		}
	} catch (error) {
		// not a node of any realm: nothing to let go of
	}
}

const nativeFirstChild = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'firstChild',
)!.get!;
const nativeNextSibling = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'nextSibling',
)!.get!;
const nativeInnerHTMLGet = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'innerHTML',
)!.get!;
const nativeTextContentSet = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'textContent',
)!.set!;
const nativeElementQuery = Element.prototype.querySelector;
const nativeFragmentQuery = DocumentFragment.prototype.querySelector;
// (in either case, letter by letter)
const NOSCRIPT_END = '</noscript';
const NOSCRIPT_END_UPPER = '</NOSCRIPT';
/** `</noscript` in `text`, in any ASCII case, by the language alone (no String method the page may have replaced) */
function endsNoscript(text: string): boolean {
	const length = NOSCRIPT_END.length;
	for (let at = 0; at + length <= text.length; at++) {
		let i = 0;
		while (
			i < length &&
			(text[at + i] === NOSCRIPT_END[i] ||
				text[at + i] === NOSCRIPT_END_UPPER[i])
		)
			i++;
		if (i === length) return true;
	}
	return false;
}

/**
 * Empty every HTML <noscript> under `root` (an inert copy of markup the
 * browser parses next, in the page) whose markup would not end where it
 * ends in the copy, and say whether there was one. The copy is parsed and
 * serialized with scripting off, where a noscript's markup is markup; the
 * page parses with scripting on, where it is text up to the first
 * `</noscript`. So one that holds a `</noscript` (a <style>'s text, a
 * comment's, an attribute's) ends there in the page, and the rest of its
 * markup is the page's markup, which no hook saw: `<noscript><style>
 * </noscript><img src=x onerror=...>` made an image with its raw handler,
 * and with runScripts a raw <script>. Natively nothing of a noscript shows
 * (scripting is on), so only what it would have let out is lost. In
 * template contents too; read by the browser's own getters, so a page that
 * replaced them decides nothing of it.
 */
export function closeNoscripts(root: Node): boolean {
	let closed = false;
	try {
		const type = Reflect.apply(nativeNodeType, root, []) as number;
		const query =
			type === 1
				? nativeElementQuery
				: type === 11
					? nativeFragmentQuery
					: null;
		if (!query || Reflect.apply(query, root, ['noscript, template']) === null)
			return false;
	} catch (error) {
		// not a node
		return false;
	}
	let node = Reflect.apply(nativeFirstChild, root, []) as Node | null;
	while (node) {
		let descend = true;
		if (Reflect.apply(nativeNodeType, node, []) === 1) {
			const name = Reflect.apply(nativeLocalName, node, []);
			const html =
				Reflect.apply(nativeNamespace, node, []) ===
				'http://www.w3.org/1999/xhtml';
			if (html && name === 'template') {
				if (
					closeNoscripts(Reflect.apply(nativeTemplateContent, node, []) as Node)
				)
					closed = true;
			} else if (html && name === 'noscript') {
				descend = false;
				if (endsNoscript(Reflect.apply(nativeInnerHTMLGet, node, []))) {
					Reflect.apply(nativeTextContentSet, node, ['']);
					closed = true;
				}
			}
		}
		const first = descend
			? (Reflect.apply(nativeFirstChild, node, []) as Node | null)
			: null;
		if (first) {
			node = first;
			continue;
		}
		// the next node after this one's subtree, up to `root`
		while (node && node !== root) {
			const next = Reflect.apply(nativeNextSibling, node, []) as Node | null;
			if (next) break;
			node = Reflect.apply(nativeParentNode, node, []) as Node | null;
		}
		node =
			node && node !== root
				? (Reflect.apply(nativeNextSibling, node, []) as Node | null)
				: null;
	}
	return closed;
}

// the browser's DOMParser as the bundle loaded, for the documents below
const NativeDOMParser = typeof DOMParser === 'function' ? DOMParser : null;
const nativeCompatMode = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'compatMode',
)?.get;
// (not an array: an index the page put on Array.prototype is no document)
let noQuirksDocument: Document | undefined;
let quirksDocument: Document | undefined;
/**
 * An inert HTML document (a DOMParser's: no window, nothing loads, no
 * script runs) in the mode of `like` (quirks or not: a quirks document's
 * parser keeps a <p> open around a <table>), made once each by the
 * browser's own constructor and parser as the bundle loaded
 */
export function inertHTMLDocument(like: Document): Document | null {
	if (!NativeDOMParser || !nativeParseFromString || !nativeCompatMode)
		return null;
	const quirks = Reflect.apply(nativeCompatMode, like, []) === 'BackCompat';
	const make = () =>
		Reflect.apply(nativeParseFromString, new NativeDOMParser(), [
			trustedHTML(quirks ? '' : '<!doctype html>'),
			'text/html',
		]) as Document;
	return quirks ? (quirksDocument ??= make()) : (noQuirksDocument ??= make());
}

/**
 * Elements cloneRawNode made inside a template's content or a <noscript>.
 * Where the written page puts them, a script runs with no
 * document.currentScript (a declarative shadow root), never runs (a plain
 * template) or is text (a noscript, with scripting on), so markup that
 * replaces itself from a script (DOMContentHooks' parsed <style>) must land
 * as itself there.
 */
export const inertClones = new LazyWeakSet<Node>();

/**
 * The parsed <base> a copy is being made from, while its attributes are
 * set. They go through the hooks before the copy is put in its tree, so
 * its hook cannot see what stands before it; the parsed one is still where
 * the markup has it (the metas before it are the policies that judge it,
 * DocumentClient baseRefused).
 */
export const parsedBases = new LazyWeakMap<Element, Element>();

const STACK_ITERATE = Symbol();
const STACK_FINALIZE = Symbol();

// the document the child is made in: the caller's, or a template's inert
// content document below a template; whether it is below a template or a
// noscript (inertClones)
type stackIterateData = [
	child: Node,
	target: ParentNode,
	document: Document,
	inert: boolean,
];
type stackFinalizeData = [parent: ParentNode, node: Node];

/**
 * Clones or re-creates the node using the hooked DOM apis. `fragment` is
 * markup parsed for this copy: once copied it is spent (releaseMarkup).
 * @param node Node to clone
 */
export default function cloneRawNode(
	fragment: ParentNode | Node[],
	// the document the nodes are made in: the client's, which for a child
	// frame the parent injected is not this bundle's own
	document: Document = globalThis.document,
	// a document being loaded (loadXML): its scripts are made fresh so they
	// run when the tree lands, instead of adopted "already started"
	runScripts = false,
): DocumentFragment {
	const tempTarget = document.createDocumentFragment();

	const stack: [symbol, ...(stackIterateData | stackFinalizeData)][] = [];

	const childNodes = Array.isArray(fragment) ? fragment : fragment.childNodes;
	const max = childNodes.length;

	for (let i = 0; i < max; i++) {
		const child = childNodes[max - i - 1];
		stack.push([STACK_ITERATE, child, tempTarget, document, false]);
	}

	while (true) {
		const array = stack.pop();

		if (!array) break;

		const [instruction, ...data] = array;

		switch (instruction) {
			case STACK_ITERATE:
				{
					const d = data as stackIterateData;
					const document = d[2];

					// node types, not realm constructors: the parsed nodes and the
					// client's document may each belong to another realm than this
					// bundle's
					if (d[0].nodeType === 3) {
						d[1].append(document.createTextNode(d[0].nodeValue!));
						continue;
					} else if (d[0].nodeType === 8) {
						d[1].append(document.createComment(d[0].nodeValue!));
						continue;
					} else if (d[0].nodeType === 7) {
						// a processing instruction (the HTML parser makes one of
						// `<?target data>` since Chrome 150; an XML parser of any)
						const pi = d[0] as ProcessingInstruction;
						try {
							d[1].append(
								document.createProcessingInstruction(pi.target, pi.data),
							);
						} catch (error) {
							// a target or data the DOM method refuses: left out
						}
						continue;
					} else if (d[0].nodeType !== 1) {
						// may be a document-fragment or CharacterData
						console.error('skip', d[0]);
						continue;
					}

					// a script from a markup string must not run (the parser marked
					// it "already started", as a browser's innerHTML does); a fresh
					// element would lose that, so the parsed one is adopted and only
					// its attributes go through the hooks. An SVG script as much as
					// an HTML one: re-created, it ran the moment the markup landed,
					// which no browser does, and ran as the page wrote it
					if (!runScripts && isScriptElement(d[0])) {
						// (by the browser's own adoptNode: the hooked one routes a
						// node of another document, which the copy does below)
						const script = Reflect.apply(nativeAdoptNode, document, [
							d[0],
						]) as Element;
						startedScripts.add(script);
						// attributes first, on an empty element (the type hook reads the
						// text), then the source back, like a fresh clone would
						const children = [...script.childNodes];
						for (const child of children) script.removeChild(child);
						// by qualified name: an SVG script's xlink:href keeps the
						// namespace the parser gave it
						asParsed(script, () => {
							for (const attribute of script.getAttributeNames())
								script.setAttribute(attribute, script.getAttribute(attribute)!);
						});
						for (const child of children) script.appendChild(child);
						stack.push([STACK_FINALIZE, d[1], script]);
						continue;
					}

					let target = d[0] as Element;

					// in the element's own namespace: an SVG in an HTML page, or
					// any element of an XML document (where createElement would
					// make one of no namespace)
					const namespace = (d[0] as Element).namespaceURI;
					try {
						target =
							namespace === 'http://www.w3.org/1999/xhtml' &&
							document.contentType === 'text/html'
								? document.createElement(d[0].nodeName)
								: document.createElementNS(
										namespace,
										(d[0] as Element).localName,
									);
					} catch (err) {
						// d[0].nodeName may be HTMLUnknownElement
						console.error(err);
					}

					const base = d[0].nodeName === 'BASE';
					if (base) parsedBases.set(target, d[0] as Element);

					// by the browser's own members: the hooked `attributes` getter
					// hands the page a view that hides the markers, not an
					// iterable NamedNodeMap (the parser's attributes, which no
					// Trusted Types judge)
					asParsed(target, () => {
						for (const [namespace, name, value] of attributesOf(
							d[0] as Element,
						))
							// a namespaced attribute (xlink:href) keeps its namespace; the
							// hooks see both ways of setting it
							if (namespace) target.setAttributeNS(namespace, name, value);
							else target.setAttribute(name, value);
					});
					// (the copy may live on in the page: it keeps nothing of the markup)
					if (base) parsedBases.delete(target);

					// An XML document's external scripts ran in the order the
					// parser met them. A script made here is not the parser's: the
					// browser would run each as it arrives, a small file ahead of
					// the library before it, unless it is told to keep the order
					// (`async = false` on a script that never asked for async).
					if (
						runScripts &&
						namespace === 'http://www.w3.org/1999/xhtml' &&
						target.localName === 'script' &&
						target.hasAttribute('src') &&
						!target.hasAttribute('async')
					)
						(target as HTMLScriptElement).async = false;

					if (d[3]) inertClones.add(target);

					// a template's children live in its content fragment, not in
					// childNodes; clone them into the new template's fragment
					const isTemplate = isHTMLTemplate(d[0]);
					const inert = d[3] || isTemplate || d[0].nodeName === 'NOSCRIPT';
					const children = isTemplate
						? (d[0] as HTMLTemplateElement).content.childNodes
						: d[0].childNodes;
					const parent = isTemplate
						? (target as HTMLTemplateElement).content
						: target;
					const childDocument = isTemplate
						? templateContentDocument(target)
						: document;
					const max = children.length;
					for (let i = 0; i < max; i++) {
						// append in reverse order
						const child = children[max - i - 1];
						stack.push([STACK_ITERATE, child, parent, childDocument, inert]);
					}

					stack.push([STACK_FINALIZE, d[1], target]);
				}
				break;
			case STACK_FINALIZE:
				{
					const d = data as stackFinalizeData;
					d[0].append(d[1]);
				}
				break;
		}
	}

	// the parsed markup has served: what the page gets is the copy
	if (Array.isArray(fragment)) for (const node of fragment) releaseMarkup(node);
	else releaseMarkup(fragment as Node);

	return tempTarget;
}
