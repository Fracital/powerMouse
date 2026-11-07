export function parseHTML(script: string) {
	return new DOMParser().parseFromString(script, 'text/html');
}

export function parseHTMLFragment(script: string): DocumentFragment {
	const parsed = new DOMParser().parseFromString(
		`<fragment>${script}</fragment>`,
		'text/html',
	);
	const simulatedFragment = parsed.body.children[0];
	const fragment = document.createDocumentFragment();

	for (const child of [...simulatedFragment.childNodes]) {
		fragment.append(child);
	}

	return fragment;
}

const STACK_ITERATE = Symbol();
const STACK_FINALIZE = Symbol();

type stackIterateData = [child: Node, target: ParentNode];
type stackFinalizeData = [parent: ParentNode, node: Node];

/**
 * Clones or re-creates the node using the hooked DOM apis
 * @param node Node to clone
 */
export default function cloneRawNode(
	fragment: ParentNode | ParentNode[],
): DocumentFragment {
	const tempTarget = new DocumentFragment();

	const stack: [symbol, ...(stackIterateData | stackFinalizeData)][] = [];

	const childNodes = Array.isArray(fragment) ? fragment : fragment.childNodes;
	const max = childNodes.length;

	for (let i = 0; i < max; i++) {
		const child = childNodes[max - i - 1];
		stack.push([STACK_ITERATE, child, tempTarget]);
	}

	while (true) {
		const array = stack.pop();

		if (!array) break;

		const [instruction, ...data] = array;

		switch (instruction) {
			case STACK_ITERATE:
				{
					const d = data as stackIterateData;

					if (d[0] instanceof Text) {
						d[1].append(new Text(d[0].nodeValue!));
						continue;
					} else if (d[0] instanceof Comment) {
						d[1].append(new Comment(d[0].nodeValue!));
						continue;
					} else if (!(d[0] instanceof Element)) {
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
						d[0].nodeName === 'SCRIPT' &&
						d[0].namespaceURI === 'http://www.w3.org/1999/xhtml'
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

					let target = d[0];

					try {
						target = document.createElement(d[0].nodeName);
					} catch (err) {
						// d[0].nodeName may be HTMLUnknownElement
						console.error(err);
						// eslint-disable-next-line no-debugger
						debugger;
					}

					if (d[0] instanceof Element) {
						for (const attribute of d[0].getAttributeNames()) {
							target.setAttribute(attribute, d[0].getAttribute(attribute)!);
						}
					}

					// a template's children live in its content fragment, not in
					// childNodes; clone them into the new template's fragment
					const isTemplate = d[0].nodeName === 'TEMPLATE';
					const children = isTemplate
						? (d[0] as HTMLTemplateElement).content.childNodes
						: d[0].childNodes;
					const parent = isTemplate
						? (target as HTMLTemplateElement).content
						: target;
					const max = children.length;
					for (let i = 0; i < max; i++) {
						// append in reverse order
						const child = children[max - i - 1];
						stack.push([STACK_ITERATE, child, parent]);
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
