/** the DOMParser of the document's own realm (a child frame runs its creator's bundle) */
function parserFor(document: Document): DOMParser {
	const Parser =
		(document.defaultView as { DOMParser?: typeof DOMParser } | null)
			?.DOMParser ?? DOMParser;
	return new Parser();
}

export function parseHTML(
	script: string,
	document: Document = globalThis.document,
	mime: DOMParserSupportedType = 'text/html',
) {
	return parserFor(document).parseFromString(script, mime);
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
	const parsed = parserFor(document).parseFromString(
		`<fragment>${script}</fragment>`,
		'text/html',
	);
	return parsed.body.children[0];
}

// taken before the DOM hooks replace the getter
export const nativeAttributes = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'attributes',
)!.get!;

const nativeOwnerDocument = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'ownerDocument',
)!.get!;
const nativeTemplateContent = Reflect.getOwnPropertyDescriptor(
	HTMLTemplateElement.prototype,
	'content',
)!.get!;

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
	return templateContentDocument(
		document.createElementNS('http://www.w3.org/1999/xhtml', 'template'),
	);
}

const STACK_ITERATE = Symbol();
const STACK_FINALIZE = Symbol();

// the document the child is made in: the caller's, or a template's inert
// content document below a template
type stackIterateData = [child: Node, target: ParentNode, document: Document];
type stackFinalizeData = [parent: ParentNode, node: Node];

/**
 * Clones or re-creates the node using the hooked DOM apis
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
		stack.push([STACK_ITERATE, child, tempTarget, document]);
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
					} else if (d[0].nodeType !== 1) {
						// may be a document-fragment or CharacterData
						console.error('skip', d[0]);
						continue;
					}

					// a script from a markup string must not run (the parser marked
					// it "already started", as a browser's innerHTML does); a fresh
					// element would lose that, so the parsed one is adopted and only
					// its attributes go through the hooks
					// (an SVG script is re-created like any other element: the script
					// hooks expect HTMLScriptElement)
					if (
						!runScripts &&
						d[0].nodeName === 'SCRIPT' &&
						(d[0] as Element).namespaceURI === 'http://www.w3.org/1999/xhtml'
					) {
						const script = document.adoptNode(d[0]) as Element;
						// attributes first, on an empty element (the type hook reads the
						// text), then the source back, like a fresh clone would
						const children = [...script.childNodes];
						for (const child of children) script.removeChild(child);
						for (const attribute of script.getAttributeNames())
							script.setAttribute(attribute, script.getAttribute(attribute)!);
						for (const child of children) script.appendChild(child);
						stack.push([STACK_FINALIZE, d[1], script]);
						continue;
					}

					let target = d[0] as Element;

					try {
						// in the element's own namespace: an SVG in an HTML page, or
						// any element of an XML document (where createElement would
						// make one of no namespace)
						const namespace = (d[0] as Element).namespaceURI;
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
						// eslint-disable-next-line no-debugger
						debugger;
					}

					// the native map: the hooked `attributes` getter hands the page a
					// view that hides the markers, not an iterable NamedNodeMap
					for (const attribute of Array.from(
						Reflect.apply(nativeAttributes, d[0], []) as NamedNodeMap,
					))
						// a namespaced attribute (xlink:href) keeps its namespace; the
						// hooks see both ways of setting it
						if (attribute.namespaceURI)
							target.setAttributeNS(
								attribute.namespaceURI,
								attribute.name,
								attribute.value,
							);
						else target.setAttribute(attribute.name, attribute.value);

					// a template's children live in its content fragment, not in
					// childNodes; clone them into the new template's fragment
					const isTemplate = d[0].nodeName === 'TEMPLATE';
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
						stack.push([STACK_ITERATE, child, parent, childDocument]);
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

	return tempTarget;
}
