import { rewriteImportMap } from '../../../scriptRoutes';
import Module from '../../Module';
import ProxyModule, {
	applyDescriptors,
	catchRequiredArguments,
	usePrototype,
} from '../../modules/Proxy';
import { unrouteCSS } from '../../modules/Unroute';
import { modifyCSS, modifyJS } from '../../rewriter';
import DocumentClient, {
	getGlobalParsingState,
	type StyleElement,
} from '../Client';
import cloneRawNode, { inertClones, parseHTMLFragment } from '../cloneNode';
import DOMAttributesModule, {
	scriptType,
	shouldRewriteScript,
} from './DOMAttributes';
import DOMHooksModule, {
	CustomElement,
	nativeElement,
	nativeNode,
} from './DOMHooks';

export const nativeHTMLElement: HTMLElement = Object.create(nativeElement);
export const nativeHTMLStyleElement: HTMLStyleElement =
	Object.create(nativeHTMLElement);
// an SVG <style> (inline SVG in an HTML page applies its CSS like an HTML
// one): its own `sheet`, which HTMLStyleElement's throws on
export const nativeSVGStyleElement: SVGStyleElement =
	Object.create(nativeElement);
export const nativeHTMLFormElement: HTMLFormElement =
	Object.create(nativeHTMLElement);
export const nativeHTMLScriptElement: HTMLScriptElement =
	Object.create(nativeHTMLElement);
export const nativeCharacterData: CharacterData = Object.create(nativeNode);
export const nativeDocumentFragment: DocumentFragment =
	Object.create(nativeNode);

applyDescriptors(nativeCharacterData, CharacterData.prototype);
applyDescriptors(nativeCharacterData, Text.prototype);
applyDescriptors(nativeDocumentFragment, DocumentFragment.prototype);
applyDescriptors(nativeHTMLElement, HTMLElement.prototype);
applyDescriptors(nativeHTMLStyleElement, HTMLStyleElement.prototype);
applyDescriptors(nativeSVGStyleElement, SVGElement.prototype);
applyDescriptors(nativeSVGStyleElement, SVGStyleElement.prototype);
applyDescriptors(nativeHTMLScriptElement, HTMLScriptElement.prototype);
applyDescriptors(nativeHTMLFormElement, HTMLFormElement.prototype);
const nativeCreateTextNode = Document.prototype.createTextNode;
const nodeTypeGet = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'nodeType',
)!.get!;
const parentNodeGet = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'parentNode',
)!.get!;
/** a node of any realm (`instanceof` knows only one), else null */
function nodeTypeOf(value: unknown): number | null {
	// a string or null is no node: answered without the getter's TypeError
	if (typeof value !== 'object' || value === null) return null;
	try {
		return Reflect.apply(nodeTypeGet, value, []) as number;
	} catch (error) {
		return null;
	}
}
function parentOf(value: unknown): Node | null {
	if (typeof value !== 'object' || value === null) return null;
	try {
		return Reflect.apply(parentNodeGet, value, []) as Node | null;
	} catch (error) {
		return null;
	}
}

/**
 * The name the hooks know an element by: HTML elements uppercase (what an
 * HTML document's nodeName is; an XHTML document keeps them lowercase),
 * anything else (SVG, MathML) as is.
 */
export function htmlName(node: Node): string {
	if (nodeTypeOf(node) !== 1)
		return usePrototype(node, nativeNode, (node) => node.nodeName);
	return usePrototype(node as Element, nativeElement, (element) =>
		element.namespaceURI === 'http://www.w3.org/1999/xhtml'
			? element.nodeName.toUpperCase()
			: element.nodeName,
	);
}

function getSupportedQueryInterface(
	node: Node,
): DocumentFragment | Element | undefined {
	// by the node's type: trying a querySelector('*') through the element
	// interface (it throws for anything else) cost a query and two prototype
	// swaps on every insertion, a fifth of the hooks' time on YouTube
	const type = nodeTypeOf(node);
	if (type === 11) return nativeDocumentFragment;
	if (type === 1) return nativeElement;
	// a Text, a comment, a document: no element interface
	return undefined;
}

export default class DOMContentHooks extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const compositeElements = new Map<Element, () => Element>(); // new WeakMap<Element, () => Element>();

		/*const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
					usePrototype(node, nativeNode, (node) => {
						if (node.nodeName !== '#text') return;

						usePrototype(mutation.target, nativeNode, (target) => {
							if (target.nodeName !== 'STYLE') return;

							usePrototype(target, nativeHTMLStyleElement, (style) => {
								rewriteStyle(style);
							});
						});
					});
				}
			}
		});

		observer.observe(document, {
			subtree: true,
			childList: true,
		});*/

		const rewrittenRule = Symbol();

		function compositeElement(
			element: Element,
			createComposite: () => Element,
		) {
			element.replaceWith(createComposite());
			Reflect.defineProperty(element, Symbol.toStringTag, {
				value: 'abc' + Math.random().toString(36).slice(2),
			});
			element.setAttribute((element as any)[Symbol.toStringTag], 'TEST');
			compositeElements.set(element, createComposite);
		}

		// `node` read through its own kind's native accessors, if it is a
		// <style> whose text is CSS (Client.styleKind): HTMLStyleElement's
		// `sheet` throws "Illegal invocation" on an SVG <style>, which
		// `querySelectorAll('style')` finds too (Wikipedia's inline SVG threw
		// from the page's appendChild); any other element is no style
		const withStyle = (
			node: unknown,
			callback: (style: StyleElement) => void,
		) => {
			const kind = this.client.styleKind(node);
			if (kind === 'html')
				usePrototype(
					node as HTMLStyleElement,
					nativeHTMLStyleElement,
					callback,
				);
			else if (kind === 'svg')
				usePrototype(node as SVGStyleElement, nativeSVGStyleElement, callback);
		};

		// styles whose text was rewritten before the browser parsed it; the
		// CSSOM pass would only redo the same work (modifyCSS is idempotent)
		const prewritten = new WeakSet<StyleElement>();
		const rewriteStyleText = (style: StyleElement) => {
			const text = style.textContent;
			if (!text) return;
			style.textContent = this.client.prepareStyleText(text);
			prewritten.add(style);
		};

		// Text that becomes part of a <style>'s text, however it gets there,
		// is routed before it lands (see prepareStyleText): chess.com filled
		// its board's style with innerHTML and every piece loaded straight
		// from the site. Each piece of text is routed on its own, which holds
		// as long as no url() is split across two text nodes.
		const routeTextNode = (node: Node) =>
			usePrototype(node, nativeCharacterData, (text) => {
				const data = text.data;
				const routed = this.client.prepareStyleText(data);
				if (routed !== data) text.data = routed;
			});
		// a node argument about to go into a style: a Text, or a fragment's
		// Text children (an element in a style is not part of its text)
		const routeInsertedText = (node: Node) =>
			usePrototype(node, nativeNode, (native) => {
				if (native.nodeType === 3) routeTextNode(node);
				else if (native.nodeType === 11)
					for (const child of [...native.childNodes])
						if (
							usePrototype(child, nativeNode, (child) => child.nodeType) === 3
						)
							routeTextNode(child);
			});
		// an edit of a Text node in a style (appendData, insertData,
		// replaceData, deleteData) is made to the text as the page reads it,
		// whose offsets count the page's URLs, on a scratch node, so the
		// browser's own method decides the result and any IndexSizeError;
		// the result is routed and set at once
		const editStyleText = <T>(
			node: CharacterData,
			edit: (scratch: CharacterData) => T,
		): T => {
			const page = unrouteCSS(
				this.client,
				usePrototype(node, nativeCharacterData, (text) => text.data),
			);
			const scratch = Reflect.apply(
				nativeCreateTextNode,
				this.client.global.document,
				[page],
			) as Text;
			const result = edit(scratch);
			const edited = usePrototype(
				scratch,
				nativeCharacterData,
				(text) => text.data,
			);
			usePrototype(node, nativeCharacterData, (text) => {
				text.data = this.client.prepareStyleText(edited);
			});
			return result;
		};

		const rewriteStyle = (style: StyleElement) => {
			if (getGlobalParsingState(this.client.global) === 'parsingBeforeWrite') {
				// once everything is finalized and off the alternative parse stack

				if (style.textContent) {
					// rewritten now, so the browser never fetches an @import or a
					// font from the proxy origin while parsing the written page
					rewriteStyleText(style);
					// in a template or a noscript the script could not put it back
					// (MDN's declarative shadow roots threw on currentScript);
					// its text is rewritten already. In SVG it could not either:
					// the parser makes the script an SVG one, which has no
					// currentScript, and the style was lost from every page
					if (inertClones.has(style) || this.client.styleKind(style) !== 'html')
						return;
					compositeElement(style, () => {
						const script = document.createElement('script');

						usePrototype(script, nativeHTMLScriptElement, (script) => {
							script.textContent = `document.currentScript.outerHTML=${JSON.stringify(
								style.outerHTML,
							)}`;
							// the client's own code, nothing of the page's to rewrite: the
							// insertion and the written page's pass leave it as it is
							// (rewriting a 3 MB stylesheet as a string literal took CNN
							// half a second)
							rewrittenScripts.set(script, script.text);
						});

						return script;
					});
				}

				return;
			}

			// not in document
			if (!style.sheet) {
				// eventually we'll catch a connected style
				return;
			}

			// a document no service worker controls: the routed rules' loads are
			// copied (DOMAttributes)
			const copied = () =>
				this.client
					.getModule(DOMAttributesModule)
					?.copySheet?.(style, (rule) => ((rule as any)[rewrittenRule] = true));

			if (prewritten.has(style)) {
				prewritten.delete(style);
				for (const rule of style.sheet.cssRules)
					(rule as any)[rewrittenRule] = true;
				copied();
				return;
			}

			const rules = [...style.sheet!.cssRules].filter(
				(rule) => !(rule as any)[rewrittenRule],
			);

			for (let i = 0; i < rules.length; i++) {
				style.sheet!.deleteRule(rules.length - i - 1);
			}

			for (let i = 0; i < rules.length; i++) {
				const added = style.sheet!.insertRule(
					modifyCSS(rules[i].cssText, this.client.url),
					i,
				);
				(style.sheet!.cssRules[added] as any)[rewrittenRule] = true;
			}
			copied();
		};

		// a script element runs once, so rewrite its text once: a rewritten
		// script that is moved to another parent must not be rewritten again
		// the rewritten text each script carries; text set later is rewritten again
		const rewrittenScripts = this.client.rewrittenScripts;

		// `willConnect`: the script is about to be inserted into a connected
		// tree, which is the moment it runs. At that point it is not connected
		// yet, so the connected check alone would skip every dynamically
		// inserted inline script and leave it unrewritten.
		// an SVG script element (inline SVG, a standalone SVG document) has no
		// `text`: its textContent is the source, rewritten the same way
		const rewriteSVGScript = (script: Element, willConnect: boolean) => {
			const source = script.textContent ?? '';
			if (
				!source ||
				!shouldRewriteScript(script) ||
				rewrittenScripts.get(script as HTMLScriptElement) === source ||
				(!script.isConnected &&
					!willConnect &&
					getGlobalParsingState(this.client.global) !== 'parsingBeforeWrite')
			)
				return;
			const rewritten = modifyJS(
				source,
				this.client.url,
				this.client.config,
				scriptType(script),
			);
			rewrittenScripts.set(script as HTMLScriptElement, rewritten);
			script.textContent = rewritten;
		};
		// `node` arrives with its prototype swapped (the insert hook reads it
		// as a plain Node), so the kind is read natively: an HTML script gets
		// the script prototype, an SVG one (inline SVG, an SVG document) the
		// element's
		const rewriteAnyScript = (node: Node, willConnect: boolean) => {
			const namespace = usePrototype(
				node,
				nativeElement,
				(element) => element.namespaceURI,
			);
			if (namespace === 'http://www.w3.org/1999/xhtml')
				usePrototype(node, nativeHTMLScriptElement, (script) =>
					rewriteScript(script, willConnect),
				);
			else
				usePrototype(node, nativeElement, (element) =>
					rewriteSVGScript(element, willConnect),
				);
		};
		const rewriteScript = (script: HTMLScriptElement, willConnect = false) => {
			// an import map's targets are routed once, before it connects
			if (script.type.trim().toLowerCase() === 'importmap') {
				if (rewrittenScripts.has(script)) return;
				rewrittenScripts.set(script, script.text);
				script.text = rewriteImportMap(
					script.text,
					this.client.url,
					this.client.config,
				);
				return;
			}
			if (
				!shouldRewriteScript(script) ||
				rewrittenScripts.get(script) === script.text ||
				(!script.isConnected &&
					!willConnect &&
					getGlobalParsingState(this.client.global) !== 'parsingBeforeWrite')
			) {
				// eventually we'll catch a connected script
				return;
			}

			/*document.currentScript.textContent = ${JSON.stringify(
				script.textContent
			)};*/
			// a script of the document's own markup the page inserts again (it
			// read the text back and made a script of it): the worker's rewrite
			const type = scriptType(script);
			const rewritten =
				this.client.prewrittenScript(
					type === 'genericModule',
					script.text,
					true,
				) ?? modifyJS(script.text, this.client.url, this.client.config, type);
			rewrittenScripts.set(script, rewritten);
			script.text = rewritten;
		};

		function cdUpdated(element: CharacterData, parent?: Element | null) {
			if (!parent) return;

			withStyle(parent, rewriteStyle);
		}

		for (const triggersRender of ['replaceWith', 'remove']) {
			(this.client.global.CharacterData.prototype as any)[triggersRender] =
				proxyModule.wrapFunction(
					(this.client.global.CharacterData.prototype as any)[triggersRender],
					(target, that: CharacterData, args) => {
						// will be null after remove()
						const parent = usePrototype(
							that,
							nativeCharacterData,
							(cd) => cd.parentElement,
						);

						const result = Reflect.apply(target, that, args);

						cdUpdated(that, parent);

						return result;
					},
				);
		}

		// a style's text rewritten before the browser parsed it: the CSSOM
		// pass only marks its rules (and copies their loads for a document no
		// worker controls)
		const prewrote = (style: StyleElement) => {
			prewritten.add(style);
			withStyle(style, rewriteStyle);
		};

		for (const edit of [
			'appendData',
			'insertData',
			'replaceData',
			'deleteData',
		] as const) {
			const native = this.client.global.CharacterData.prototype[edit];
			if (typeof native !== 'function') continue;
			(this.client.global.CharacterData.prototype as any)[edit] =
				proxyModule.wrapFunction(
					native as (...args: unknown[]) => unknown,
					(target, that: CharacterData, args) => {
						const style = this.client.styleOfText(that);
						if (!style) return Reflect.apply(target, that, args);
						const result = editStyleText(that, (scratch) =>
							Reflect.apply(target, scratch, args),
						);
						prewrote(style);
						return result;
					},
				);
		}

		// a Text node's whole text, set: `data`, `nodeValue` (`textContent`
		// in DOMHooks), routed when it is a style's
		for (const [prototype, property] of <[object, string][]>[
			[this.client.global.CharacterData.prototype, 'data'],
			[this.client.global.Node.prototype, 'nodeValue'],
		]) {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property)!;

			Reflect.defineProperty(prototype, property, {
				enumerable: true,
				configurable: true,
				get: descriptor.get,
				set: proxyModule.wrapFunction(descriptor.set!, (target, that, args) => {
					const style = this.client.styleOfText(that);
					if (!style) return Reflect.apply(target, that, args);
					// null sets the empty string, as natively
					const text = args[0] === null ? '' : String(args[0]);
					Reflect.apply(target, that, [this.client.prepareStyleText(text)]);
					prewrote(style);
				}),
			});
		}

		/**
		 * Called after a function with side-effects that may trigger a style to re-render.
		 * @param target Text. Possibly a child of a Style.
		 */
		const textUpdatesStyle = (target: Node | null) => {
			// only applies to .replaceWith where a #text is being replaced with a different text
			withStyle(parentOf(target), rewriteStyle);
			// general inserting things into style
			withStyle(target, rewriteStyle);
		};

		const domAttributesModule = this.client.getModule(DOMAttributesModule)!;
		const domHooksModule = this.client.getModule(DOMHooksModule)!;
		// the browser's own answers, called on the node: a prototype swapped
		// in does not reach a getter the page put on the instance itself, and
		// that getter would run with its prototype chain gone (YouTube's
		// Polymer logging getters threw from appendChild)
		const nativeGetter = (name: string) =>
			Reflect.getOwnPropertyDescriptor(nativeNode, name)!.get!;
		const nativeIsConnected = nativeGetter('isConnected');
		const nativeNodeType = nativeGetter('nodeType');
		const nativeGetAttributeNames = nativeElement.getAttributeNames;

		const insert = <T>(
			insert: Node,
			that: Node | null,
			insertElement: () => T,
		): T => {
			// if insert is a DocumentFragment, its childNodes will be cleared upon insertion
			// we need to snapshot the childNodes or run a query before its childNodes are cleared
			const styles: StyleElement[] = [];

			// scripts inside `insert` run as soon as it lands in a connected tree
			const willConnect = that
				? (Reflect.apply(nativeIsConnected, that, []) as boolean)
				: false;

			// nodes the hooks never saw (DOMParser, createContextualFragment,
			// importNode, another document): route their attributes now
			if (willConnect)
				usePrototype(insert, nativeNode, (node) => {
					const nodeType = Reflect.apply(nativeNodeType, insert, []) as number;
					if (nodeType !== 1 && nodeType !== 11) return;
					const elements: Element[] = [];
					if (nodeType === 1) elements.push(insert as Element);
					usePrototype(
						insert,
						getSupportedQueryInterface(node) ?? nativeNode,
						(queryable) => {
							if ('querySelectorAll' in queryable)
								elements.push(...(queryable as Element).querySelectorAll('*'));
						},
					);
					for (const element of elements) {
						// read natively first: an element none of whose attributes a
						// hook watches is left alone, without the prototype swap
						// (Polymer stamps thousands of such elements on YouTube)
						const names = Reflect.apply(
							nativeGetAttributeNames,
							element,
							[],
						) as string[];
						if (
							!names.some(
								(name) =>
									!name.startsWith('s_o:') &&
									domHooksModule.hooksAttribute(name),
							)
						)
							continue;
						usePrototype(element, CustomElement.prototype, (element) => {
							for (const name of element.getAttributeNames())
								if (!name.startsWith('s_o:') && !element.hasAttributeOG(name))
									domHooksModule.updateAttributeHooks(element, name);
						});
					}
				});

			// we're about to render
			const name = htmlName(insert);
			// an HTML or an SVG <style>, inserted itself
			const insertedStyle = this.client.styleElement(insert);
			usePrototype(insert, nativeNode, (node) => {
				if (name === 'SCRIPT') {
					rewriteAnyScript(insert, willConnect);
				} else if (insertedStyle) {
					// before it connects and the browser parses it
					if (willConnect) withStyle(insertedStyle, rewriteStyleText);
				} else {
					const queryInterface = getSupportedQueryInterface(node);

					if (queryInterface)
						usePrototype(node, queryInterface, (queryable) => {
							// any element named style: an HTML one, an SVG one, or one
							// of another namespace, which is no style (withStyle)
							for (const element of queryable.querySelectorAll('style')) {
								const style = this.client.styleElement(element);
								if (!style) continue;
								if (willConnect) withStyle(style, rewriteStyleText);
								styles.push(style);
							}

							for (const script of queryable.querySelectorAll('script'))
								rewriteAnyScript(script, willConnect);
						});
				}
			});

			const result = insertElement();
			// a frame that just connected is injected before the page can
			// reach it by a literal name (IFrame's sweepFrames)
			if (willConnect) this.client.sweepFrames?.();

			if (name === 'FORM')
				usePrototype(insert, nativeNode, () =>
					usePrototype(insert, CustomElement.prototype, (form) => {
						domAttributesModule.formHook!(form);
					}),
				);
			if (insertedStyle) withStyle(insertedStyle, rewriteStyle);

			for (const style of styles) withStyle(style, rewriteStyle);

			textUpdatesStyle(that);

			return result;
		};

		// every node argument is about to land (`append(a, b)`, a string is
		// a text node); the hooks run innermost-last, then the insertion.
		// `childNode`: the method inserts beside the receiver (before, after,
		// replaceWith), into the receiver's parent; `strings`: the method
		// takes strings as Text (the ParentNode and ChildNode methods), where
		// the Node methods insert their first argument only
		const willInsertNode = (
			x: (inserted: Node, ...args: any[]) => any,
			{ childNode = false, strings = false } = {},
		) =>
			proxyModule.wrapFunction(x, (target, that, args) => {
				const style = this.client.styleElement(
					childNode ? parentOf(that) : that,
				);
				if (style) {
					const inserted = strings ? args.length : Math.min(args.length, 1);
					for (let i = 0; i < inserted; i++) {
						if (nodeTypeOf(args[i]) !== null) routeInsertedText(args[i]);
						else if (strings)
							args[i] = Reflect.apply(
								nativeCreateTextNode,
								this.client.global.document,
								[this.client.prepareStyleText(String(args[i]))],
							);
					}
					prewritten.add(style);
				}
				const nodes = args.filter(
					(arg): arg is Node => arg instanceof this.client.global.Node,
				);
				const run = (index: number): any =>
					index < nodes.length
						? insert(nodes[index], that, () => run(index + 1))
						: Reflect.apply(target, that, args);
				try {
					return run(0);
				} finally {
					// the insertion threw before the pass that takes it
					if (style) prewritten.delete(style);
				}
			});

		this.client.global.Node.prototype.appendChild = willInsertNode(
			this.client.global.Node.prototype.appendChild,
		);
		this.client.global.Node.prototype.insertBefore = willInsertNode(
			this.client.global.Node.prototype.insertBefore,
		);
		this.client.global.Node.prototype.replaceChild = willInsertNode(
			this.client.global.Node.prototype.replaceChild,
		);
		// ParentNode and ChildNode methods, on each prototype that has its own
		// copy: a shadow root (a DocumentFragment) connected through its host
		// runs a script appended to it like any connected parent
		// (a Text's before, after and replaceWith put text into its style)
		for (const proto of [
			this.client.global.Element.prototype,
			this.client.global.DocumentFragment.prototype,
			this.client.global.Document.prototype,
			this.client.global.CharacterData.prototype,
		])
			for (const method of [
				'append',
				'prepend',
				'replaceChildren',
				'replaceWith',
				'before',
				'after',
			] as const) {
				const methods = proto as unknown as Record<string, unknown>;
				const native = methods[method];
				if (typeof native !== 'function') continue;
				methods[method] = willInsertNode(
					native as (inserted: Node, ...args: any[]) => any,
					{
						childNode: ['replaceWith', 'before', 'after'].includes(method),
						strings: true,
					},
				);
			}

		function insertAdjacentTarget(
			position: string,
			relative: Element,
			on: string,
			api: string,
		): Element | null {
			switch (position) {
				case 'afterbegin':
				case 'beforeend':
					return relative;
				case 'beforebegin':
				case 'afterend':
					return relative.parentElement;
				default:
					throw new DOMException(
						`Failed to execute '${api}' on '${on}': The value provided ('${position}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`,
					);
			}
		}

		function insertAdjacent(
			targetElement: Element,
			position: string,
			relative: Element,
			node: Node,
		) {
			if (!targetElement) {
				return;
			}

			switch (position) {
				case 'afterbegin':
					if (targetElement.childNodes.length) {
						targetElement.insertBefore(node, targetElement.childNodes[0]);
					} else {
						targetElement.append(node, targetElement.childNodes[0]);
					}
					break;
				case 'beforebegin':
					targetElement.insertBefore(node, relative);
					break;
				case 'beforeend':
					targetElement.append(node);
					break;
				case 'afterend':
					{
						if (targetElement.childNodes.length) {
							const childNodes = [...targetElement.childNodes];
							const afterRelative =
								childNodes[childNodes.indexOf(relative) + 1];

							if (afterRelative) {
								console.log(afterRelative);
								targetElement.insertBefore(node, afterRelative);
							} else {
								// maybe the target ends with relative
								targetElement.append(node);
							}
						} else {
							targetElement.append(node);
						}
					}
					break;
			}
		}

		this.client.global.Element.prototype.insertAdjacentText =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.insertAdjacentText,
				(target, that: Element, args) => {
					catchRequiredArguments(
						args.length,
						2,
						'Element',
						'insertAdjacentText',
					);

					const position = String(args[0]);
					const insertNode: Node = new Text(args[1]);
					const targetElement = insertAdjacentTarget(
						position,
						that,
						'Element',
						'insertAdjacentText',
					);

					if (!targetElement) return;

					insert(insertNode, targetElement, () =>
						usePrototype(that, nativeElement, (element) =>
							insertAdjacent(targetElement, position, element, insertNode),
						),
					);
				},
			);

		this.client.global.Element.prototype.insertAdjacentElement =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.insertAdjacentElement,
				(target, that: Element, args) => {
					catchRequiredArguments(
						args.length,
						2,
						'Element',
						'insertAdjacentElement',
					);

					if (!(args[1] instanceof Element)) {
						throw new TypeError(
							`Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.`,
						);
					}

					const position = String(args[0]);
					const insertElement = args[1];
					const targetElement = insertAdjacentTarget(
						position,
						that,
						'Element',
						'insertAdjacentElement',
					);

					if (!targetElement) return;

					insert(insertElement, targetElement, () =>
						usePrototype(that, nativeElement, (element) =>
							insertAdjacent(targetElement, position, element, insertElement),
						),
					);
				},
			);

		this.client.global.Element.prototype.insertAdjacentHTML =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.insertAdjacentHTML,
				(target, that: Element, args) => {
					catchRequiredArguments(
						args.length,
						2,
						'Element',
						'insertAdjacentHTML',
					);

					const position = String(args[0]);
					const insertFragment: DocumentFragment = cloneRawNode(
						parseHTMLFragment(String(args[1]), this.client.global.document),
						this.client.global.document,
					);
					const targetElement = insertAdjacentTarget(
						position,
						that,
						'Element',
						'insertAdjacentHTML',
					);

					if (!targetElement) return;

					insert(insertFragment, targetElement, () =>
						usePrototype(that, nativeElement, (element) =>
							insertAdjacent(targetElement, position, element, insertFragment),
						),
					);
				},
			);

		// does not insert element
		this.client.global.Node.prototype.removeChild = proxyModule.wrapFunction(
			this.client.global.Node.prototype.removeChild,
			(target, that, args) => {
				const result = Reflect.apply(target, that, args);

				textUpdatesStyle(that);

				return result;
			},
		);
	}
}
