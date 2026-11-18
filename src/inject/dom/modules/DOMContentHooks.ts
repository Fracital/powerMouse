import { MAY_ROUTE } from '../../../cssURL';
import {
	isSpeculationRules,
	NO_SPECULATION,
	rewriteImportMap,
} from '../../../scriptRoutes';
import Module from '../../Module';
import ProxyModule, {
	applyDescriptors,
	usePrototype,
} from '../../modules/Proxy';
import { unrouteCSS } from '../../modules/Unroute';
import { withStack } from '../../nativeErrors';
import { LazyWeakMap } from '../../ownCollections';
import { modifyCSS, modifyJS } from '../../rewriter';
import { markOwnInjector, ownScripts, trustedScript } from '../../trusted';
import DocumentClient, {
	getGlobalParsingState,
	type StyleElement,
} from '../Client';
import cloneRawNode, {
	inertClones,
	inertDocumentOf,
	isHTMLTemplate,
	isScriptElement,
	parseHTMLFragmentIn,
	startedScripts,
} from '../cloneNode';
import {
	isStylesheetPI,
	landStylesheetPIs,
	stylesheetPIs,
} from '../stylesheetPIs';
import DOMAttributesModule, {
	scriptType,
	shouldRewriteScript,
} from './DOMAttributes';
import DOMHooksModule, {
	CustomElement,
	nativeElement,
	nativeGetter,
	nativeHTMLElement,
	nativeNode,
	pendingAttributes,
} from './DOMHooks';
import { hiddenMove, hiddenMutation, markerPrefix } from './MutationObserver';

export const nativeHTMLStyleElement: HTMLStyleElement =
	Object.create(nativeHTMLElement);
// an SVG <style> (inline SVG in an HTML page applies its CSS like an HTML
// one): its own `sheet`, which HTMLStyleElement's throws on
export const nativeSVGStyleElement: SVGStyleElement =
	Object.create(nativeElement);
export const nativeHTMLScriptElement: HTMLScriptElement =
	Object.create(nativeHTMLElement);
export const nativeCharacterData: CharacterData = Object.create(nativeNode);
export const nativeDocumentFragment: DocumentFragment =
	Object.create(nativeNode);

applyDescriptors(nativeCharacterData, CharacterData.prototype);
applyDescriptors(nativeCharacterData, Text.prototype);
applyDescriptors(nativeDocumentFragment, DocumentFragment.prototype);
applyDescriptors(nativeHTMLStyleElement, HTMLStyleElement.prototype);
applyDescriptors(nativeSVGStyleElement, SVGElement.prototype);
applyDescriptors(nativeSVGStyleElement, SVGStyleElement.prototype);
applyDescriptors(nativeHTMLScriptElement, HTMLScriptElement.prototype);
const nativeCreateTextNode = Document.prototype.createTextNode;
const nodeTypeGet = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'nodeType',
)!.get!;
const parentNodeGet = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'parentNode',
)!.get!;
const nodeNameGet = nativeGetter(nativeNode, 'nodeName');
const namespaceGet = nativeGetter(nativeElement, 'namespaceURI');
const childNodesGet = nativeGetter(nativeNode, 'childNodes');
const nextSiblingGet = nativeGetter(nativeNode, 'nextSibling');
const nativeInsertBefore = Node.prototype.insertBefore;
const nativeDataDescriptor = Reflect.getOwnPropertyDescriptor(
	CharacterData.prototype,
	'data',
)!;
const nativeGetAttribute = Element.prototype.getAttribute;
const nativeSetAttribute = Element.prototype.setAttribute;
const nativeRemoveAttribute = Element.prototype.removeAttribute;
const nativeHasAttribute = Element.prototype.hasAttribute;
const nativeHasAttributeNS = Element.prototype.hasAttributeNS;
/** the Text children of `node` (CDATA sections too), in order: a script's source is their text */
function textChildren(node: Node): CharacterData[] {
	const texts: CharacterData[] = [];
	for (const child of [
		...(Reflect.apply(childNodesGet, node, []) as NodeListOf<ChildNode>),
	]) {
		const type = nodeTypeOf(child);
		if (type === 3 || type === 4) texts.push(child as CharacterData);
	}
	return texts;
}
const dataOf = (text: CharacterData): string =>
	Reflect.apply(nativeDataDescriptor.get!, text, []);
const setData = (text: CharacterData, data: string): void =>
	Reflect.apply(nativeDataDescriptor.set!, text, [data]);
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
	// read by the browser's getters on the node (every insertion asks): no
	// prototype swap
	if (nodeTypeOf(node) !== 1)
		return Reflect.apply(nodeNameGet, node, []) as string;
	const name = Reflect.apply(nodeNameGet, node, []) as string;
	return Reflect.apply(namespaceGet, node, []) ===
		'http://www.w3.org/1999/xhtml'
		? name.toUpperCase()
		: name;
}

export default class DOMContentHooks extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const realm = client.global;
		const proxyModule = client.getModule(ProxyModule)!;

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
			const kind = client.styleKind(node);
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
			// the page's own style-src refuses this inline style of the markup:
			// it applies nothing (no text) and the inject reports it (src/csp.ts)
			if (client.refuseInlineStyle(style, text, true)) {
				style.textContent = '';
				return;
			}
			const routed = client.prepareStyleText(text);
			// a style the page's policy lets through by the hash of its text,
			// which the routing changed (src/csp.ts)
			if (routed !== text) client.giveCodeNonce(style, null, text, true);
			style.textContent = routed;
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
				const routed = client.prepareStyleText(data);
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
				client,
				usePrototype(node, nativeCharacterData, (text) => text.data),
			);
			const scratch = Reflect.apply(nativeCreateTextNode, realm.document, [
				page,
			]) as Text;
			const result = edit(scratch);
			const edited = usePrototype(
				scratch,
				nativeCharacterData,
				(text) => text.data,
			);
			usePrototype(node, nativeCharacterData, (text) => {
				text.data = client.prepareStyleText(edited);
			});
			return result;
		};

		const rewriteStyle = (style: StyleElement) => {
			if (getGlobalParsingState(realm) === 'parsingBeforeWrite') {
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
					if (inertClones.has(style) || client.styleKind(style) !== 'html')
						return;
					// a document without allow-scripts runs only the inject's
					// nonce: the script carries it, or the style is lost
					const nonce = client.scriptNonce;
					compositeElement(style, () => {
						const script = realm.document.createElement('script');

						usePrototype(script, nativeHTMLScriptElement, (script) => {
							if (nonce) script.setAttribute('nonce', nonce);
							const markup = style.outerHTML;
							// the style's markup holds its original text, which can be a
							// stylesheet with `</script>` in a string or comment; escaped
							// here, or it would close this stand-in script early and the
							// rest would run as markup (the loadHTML rule: nothing may
							// produce `</script` in generated code)
							script.textContent = trustedScript(
								`document.currentScript.outerHTML=${JSON.stringify(
									markup,
								).replace(/</g, '\\u003c')}`,
							);
							// (its outerHTML is the inject's, which no Trusted Types judge)
							// the page is serialized and parsed again, so the script that
							// runs is not this element: ownScripts (held by element) no
							// longer finds it, and the markup it writes is recognised by
							// its text instead (markOwnInjector)
							ownScripts.add(script);
							markOwnInjector(markup);
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

			// the page's own style-src refuses this inline style (now connected,
			// so the browser parsed its sheet): it applies nothing and the inject
			// reports it (src/csp.ts). Its text is the page's own.
			if (client.refuseInlineStyle(style, style.textContent ?? '', false)) {
				for (let i = style.sheet.cssRules.length - 1; i >= 0; i--)
					style.sheet.deleteRule(i);
				return;
			}

			// a document no service worker controls: the routed rules' loads are
			// copied (DOMAttributes)
			const copied = () =>
				client
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
					modifyCSS(rules[i].cssText, client.baseURL),
					i,
				);
				(style.sheet!.cssRules[added] as any)[rewrittenRule] = true;
			}
			copied();
		};

		// a script element runs once, so rewrite its text once: a rewritten
		// script that is moved to another parent must not be rewritten again
		// the rewritten text each script carries; text set later is rewritten again
		const rewrittenScripts = client.rewrittenScripts;

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
					getGlobalParsingState(realm) !== 'parsingBeforeWrite')
			)
				return;
			// (the page's Trusted Types judge its text as it runs)
			const passed = client.scriptPrepared(
				script,
				source,
				'SVGScriptElement text',
			);
			if (passed === null) return;
			const rewritten = modifyJS(
				passed,
				client.baseURL,
				client.config,
				scriptType(script),
			);
			rewrittenScripts.set(script as HTMLScriptElement, rewritten);
			client.trustedApprove?.(rewritten);
			script.textContent = rewritten;
		};
		// the kind is read natively: an HTML script gets the script prototype,
		// an SVG one (inline SVG, an SVG document) the element's
		const rewriteAnyScript = (node: Node, willConnect: boolean) => {
			const namespace = Reflect.apply(namespaceGet, node, []);
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
				client.noteImportMap(script.text);
				script.text = trustedScript(
					rewriteImportMap(script.text, client.baseURL, client.config),
				);
				return;
			}
			// speculation rules: none reach the browser (scriptRoutes.ts)
			if (isSpeculationRules(script.getAttribute('type'))) {
				if (!script.text || rewrittenScripts.get(script) === script.text)
					return;
				rewrittenScripts.set(script, NO_SPECULATION);
				script.text = trustedScript(NO_SPECULATION);
				return;
			}
			if (
				!shouldRewriteScript(script) ||
				rewrittenScripts.get(script) === script.text ||
				(!script.isConnected &&
					!willConnect &&
					getGlobalParsingState(realm) !== 'parsingBeforeWrite')
			) {
				// eventually we'll catch a connected script
				return;
			}

			/*document.currentScript.textContent = ${JSON.stringify(
				script.textContent
			)};*/
			// what the page's Trusted Types let run of it (judged as it runs,
			// scriptPrepared): refused, it runs nothing (its text is cleared) and
			// the inject already reported it
			const passed = client.scriptPrepared(script, script.text);
			if (passed === null) {
				script.text = '';
				return;
			}
			// a script of the document's own markup the page inserts again (it
			// read the text back and made a script of it): the worker's rewrite
			const type = scriptType(script);
			// a script with no text (one that loads by `src`, most of a page's)
			// runs none of it: nothing to rewrite. Asked of the library, it made
			// a top's first task fetch and compile the wasm module synchronously
			// when nothing else of that task needed it (15 to 30 ms)
			const rewritten =
				passed === ''
					? ''
					: (client.prewrittenScript(type === 'genericModule', passed, true) ??
						modifyJS(passed, client.baseURL, client.config, type));
			// a rewrite that changed nothing leaves no mark. The mark is the
			// rewritten text, and a script of the document's markup whose text
			// is its own rewrite (nothing in it to rewrite, and written as the
			// rewriter prints it) was taken for one rewritten already when the
			// markup's scripts were named: it ran without its name, and its
			// errors read as an unnamed script's. Rewriting it again changes
			// nothing
			if (rewritten !== script.text) rewrittenScripts.set(script, rewritten);
			// the page's own script-src refuses this inline script: it keeps no
			// text, so it runs nothing, and the inject reports it (src/csp.ts)
			if (!script.hasAttribute('src')) {
				if (client.refuseInlineScript(script, passed, false)) {
					script.text = '';
					return;
				}
				// let through by the hash of the page's text where its policy says so
				client.giveCodeNonce(script, null, passed, false);
			}
			script.text = trustedScript(rewritten);
		};

		function cdUpdated(element: CharacterData, parent?: Element | null) {
			if (!parent) return;

			withStyle(parent, rewriteStyle);
		}

		for (const triggersRender of ['replaceWith', 'remove']) {
			(realm.CharacterData.prototype as any)[triggersRender] =
				proxyModule.wrapFunction(
					(realm.CharacterData.prototype as any)[triggersRender],
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

		// (an xml-stylesheet processing instruction's edits: ../stylesheetPIs.ts)
		// a node moved within its document keeps its state, a PI included: it
		// loads where it lands as a document's child
		const moveBefore = (realm.Document.prototype as any).moveBefore;
		if (typeof moveBefore === 'function')
			(realm.Document.prototype as any).moveBefore = proxyModule.wrapFunction(
				moveBefore,
				(target, that, args) => {
					landStylesheetPIs(client, args[0]);
					return Reflect.apply(target, that, args);
				},
			);
		for (const edit of [
			'appendData',
			'insertData',
			'replaceData',
			'deleteData',
		] as const) {
			const native = realm.CharacterData.prototype[edit];
			if (typeof native !== 'function') continue;
			(realm.CharacterData.prototype as any)[edit] = proxyModule.wrapFunction(
				native as (...args: unknown[]) => unknown,
				(target, that: CharacterData, args) => {
					if (isStylesheetPI(that))
						return stylesheetPIs(client).edited(that, (copy) =>
							Reflect.apply(target, copy, args),
						);
					const style = client.styleOfText(that);
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
		// in DOMHooks), routed when it is a style's (or a stylesheet PI's)
		for (const [prototype, property] of <[object, string][]>[
			[realm.CharacterData.prototype, 'data'],
			[realm.Node.prototype, 'nodeValue'],
		]) {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property)!;

			Reflect.defineProperty(prototype, property, {
				enumerable: true,
				configurable: true,
				get: descriptor.get,
				set: proxyModule.wrapFunction(descriptor.set!, (target, that, args) => {
					if (isStylesheetPI(that))
						return stylesheetPIs(client).settle(
							that,
							args[0] === null ? '' : String(args[0]),
						);
					const style = client.styleOfText(that);
					if (!style) return Reflect.apply(target, that, args);
					// null sets the empty string, as natively
					const text = args[0] === null ? '' : String(args[0]);
					Reflect.apply(target, that, [client.prepareStyleText(text)]);
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

		const domAttributesModule = client.getModule(DOMAttributesModule)!;
		const domHooksModule = client.getModule(DOMHooksModule)!;
		const { requireElement } = domHooksModule;
		// the browser's own answers, called on the node: a prototype swapped
		// in does not reach a getter the page put on the instance itself, and
		// that getter would run with its prototype chain gone (YouTube's
		// Polymer logging getters threw from appendChild)
		const nativeIsConnected = nativeGetter(nativeNode, 'isConnected');
		const nativeGetAttributeNames = nativeElement.getAttributeNames;
		const shadowRootGet = nativeGetter(nativeElement, 'shadowRoot');
		const ownerDocumentGet = nativeGetter(nativeNode, 'ownerDocument');
		const viewOf = nativeGetter(Document.prototype, 'defaultView');
		const contentGet = Reflect.getOwnPropertyDescriptor(
			HTMLTemplateElement.prototype,
			'content',
		)!.get!;
		// the elements in an element (1) or a fragment (11) that match, found
		// by the browser's own query on the node, with no prototype swap: the
		// swaps cost more than the queries on a Google keystroke. A node with
		// no element in it (most insertions) is not queried at all.
		const firstElementOf = {
			1: nativeGetter(nativeElement, 'firstElementChild'),
			11: nativeGetter(nativeDocumentFragment, 'firstElementChild'),
		};
		const queryOf = {
			1: nativeElement.querySelectorAll,
			11: nativeDocumentFragment.querySelectorAll,
		};
		const queryIn = (node: Node, type: 1 | 11, selector: string): Element[] =>
			Reflect.apply(firstElementOf[type], node, []) === null
				? []
				: [
						...(Reflect.apply(queryOf[type], node, [
							selector,
						]) as NodeListOf<Element>),
					];

		// The elements of `root` (an element, 1, or a fragment, 11) whose
		// attributes no hook saw get them routed and their handlers rewritten
		// where they stand. `deep`: a tree from another document, whose open
		// shadow roots (a declarative one, Document.parseHTMLUnsafe) and
		// templates' content come along with it
		const routeUnseen = (root: Node, type: 1 | 11, deep: boolean) => {
			// a tree from another window's document (a creator's nodes put in
			// its frame): what that document's hooks routed names routes,
			// which mean nothing in a document no service worker controls, so
			// each watched attribute is routed again as this document's (every
			// hook starts from the page's original), as the browser loads an
			// adopted node's resources for its new document
			const again =
				deep &&
				domAttributesModule.uncontrolled() &&
				!!Reflect.apply(viewOf, documentOf(root), []);
			const pending: [Node, 1 | 11][] = [[root, type]];
			for (let next = pending.pop(); next; next = pending.pop()) {
				const elements = queryIn(next[0], next[1], '*');
				if (next[1] === 1) elements.unshift(next[0] as Element);
				for (const element of elements) {
					if (deep) {
						const shadow = Reflect.apply(shadowRootGet, element, []) as Node;
						if (shadow) pending.push([shadow, 11]);
						if (isHTMLTemplate(element))
							pending.push([
								Reflect.apply(contentGet, element, []) as Node,
								11,
							]);
					}
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
								!name.startsWith(markerPrefix()) &&
								domHooksModule.hooksAttribute(name),
						)
					)
						continue;
					// and one whose watched attributes all have the original the
					// hooks kept beside them has none to route (every move of an
					// element the hooks saw walked it again with the swap: a
					// framework's keyed moves). A style a CSSOM write serialised
					// has none (the write dropped it), and one that names nothing
					// to route is its own original: React's and jQuery's style
					// objects ran the style hook on every move
					const working = pendingAttributes(element);
					if (
						names.some(
							(name) =>
								!name.startsWith(markerPrefix()) &&
								domHooksModule.hooksAttribute(name) &&
								(working ||
									again ||
									(!names.includes(`${markerPrefix()}${name}`) &&
										(name !== 'style' ||
											MAY_ROUTE.test(
												Reflect.apply(nativeGetAttribute, element, [
													name,
												]) as string,
											)))),
						)
					)
						usePrototype(element, CustomElement.prototype, (element) => {
							for (const name of element.getAttributeNames())
								if (
									!name.startsWith(markerPrefix()) &&
									(again || !element.hasAttributeOG(name))
								)
									domHooksModule.updateAttributeHooks(element, name);
						});
					// a style the hooks saw elsewhere (a clone, an element of
					// another document) names routes: in a document no service
					// worker controls its loads are copied here
					if (names.includes('style'))
						domAttributesModule.copyInline?.(element);
				}
			}
		};
		// the document a node (or a document) belongs to; null for no node
		const documentOf = (node: unknown): Document | null => {
			const type = nodeTypeOf(node);
			if (type === null) return null;
			return type === 9
				? (node as Document)
				: (Reflect.apply(ownerDocumentGet, node, []) as Document);
		};
		// the documents whose nodes the hooks wrote: this realm's and the one
		// its templates' content lives in (whatever enters it from elsewhere
		// is routed on the way in, so the page's own templates, which a
		// framework imports for every copy it stamps, are not walked again)
		let templates: [Document, Document] | null = null;
		const ownDocument = (document: Document | null): boolean => {
			const own = realm.document;
			if (document === own) return true;
			if (templates?.[0] !== own) templates = [own, inertDocumentOf(own)];
			return document === templates[1];
		};
		// whether `node` comes from another document (a parser's, an XHR's:
		// none has a window) into one of this realm's, where it loads
		const foreignNode = (node: Node, into: unknown): boolean =>
			ownDocument(documentOf(into)) && !ownDocument(documentOf(node));

		// A connected script that has not run yet runs the moment a child
		// lands in it: the browser prepares it again at every child insertion,
		// and runs whatever text it holds then. The insertion hooks above see
		// a script as it connects, where it is rewritten; a script that
		// connected empty (or with a type that named no script, or whose text
		// went into a child it already had) holds text nothing rewrote, and
		// ran it as the page wrote it, with the browser's `top` and the
		// routed URL. So whatever puts a child into such a script is run
		// through here, and the text the script will run is rewritten before
		// the browser reads it.
		const currentScriptGet = nativeGetter(
			realm.Document.prototype,
			'currentScript',
		);
		/** what the browser should run for `text` in `script`; null when its type names nothing the hooks rewrite */
		const runnable = (script: Element, text: string): string | null =>
			usePrototype(script, nativeElement, (element) => {
				if (
					(element.getAttribute('type') || '').trim().toLowerCase() ===
					'importmap'
				) {
					client.noteImportMap(text);
					return rewriteImportMap(text, client.baseURL, client.config);
				}
				if (isSpeculationRules(element.getAttribute('type')))
					return NO_SPECULATION;
				if (!shouldRewriteScript(element)) return null;
				// (the page's Trusted Types judge the text as the script runs;
				// refused, the script holds nothing and runs nothing, the inject
				// having reported it in scriptPrepared)
				const passed = client.scriptPrepared(
					script,
					text,
					element.namespaceURI === 'http://www.w3.org/1999/xhtml'
						? undefined
						: 'SVGScriptElement text',
				);
				if (passed === null) return '';
				const type = scriptType(element);
				const output =
					client.prewrittenScript(type === 'genericModule', passed, true) ??
					modifyJS(passed, client.baseURL, client.config, type);
				client.trustedApprove?.(output);
				return output;
			});
		/**
		 * The script `node` is when a child landing in it can run it: connected,
		 * of a type the browser runs, with no source of its own to load (which
		 * the browser runs instead of its text), and not one known to have
		 * started (the running script, a script of a markup string: what lands
		 * in it never runs)
		 */
		const fillable = (node: unknown): Element | null => {
			if (!isScriptElement(node)) return null;
			if (startedScripts.has(node)) return null;
			if (!Reflect.apply(nativeIsConnected, node, [])) return null;
			if (node === Reflect.apply(currentScriptGet, realm.document, [])) {
				startedScripts.add(node);
				return null;
			}
			if (
				Reflect.apply(nativeHasAttribute, node, ['src']) ||
				(Reflect.apply(namespaceGet, node, []) !==
					'http://www.w3.org/1999/xhtml' &&
					(Reflect.apply(nativeHasAttribute, node, ['href']) ||
						Reflect.apply(nativeHasAttributeNS, node, [
							'http://www.w3.org/1999/xlink',
							'href',
						])))
			)
				return null;
			return usePrototype(node, nativeElement, (element) =>
				shouldRewriteScript(element) ||
				isSpeculationRules(element.getAttribute('type')) ||
				(element.getAttribute('type') || '').trim().toLowerCase() ===
					'importmap'
					? node
					: null,
			);
		};
		/** `script` holds `output` from here, in the first of `texts`, for what the page wrote in them: the insertion hook leaves it, the page reads its own text */
		const filled = (
			script: Element,
			texts: CharacterData[],
			output: string,
		) => {
			const pieces = texts.map((text): [CharacterData, string] => [
				text,
				dataOf(text),
			]);
			// (a text node may be watched where it stands: no record of this)
			hiddenMutation(() => {
				setData(texts[0], output);
				for (const text of texts.slice(1)) setData(text, '');
			});
			rewrittenScripts.set(script as HTMLScriptElement, output);
			client.scriptSource?.(
				script,
				pieces.map(([, piece]) => piece).join(''),
				output,
				pieces,
			);
		};
		/**
		 * Keep `script` from running while children land in it, for a script
		 * that already holds text the hooks did not write: where the new
		 * children stand among the old decides the text, and only the browser's
		 * own insertion says where that is. Its type names no script for the
		 * time, and the function this returns puts the type back, rewrites the
		 * text the script holds by then into its first text node and puts that
		 * node back where it is: the insertion the browser prepares the script
		 * at. None of it is the page's doing, so no observer of the page's
		 * hears of it. A script that had run already does not run again, as
		 * natively.
		 */
		const holdScript = (script: Element): (() => void) => {
			const type = Reflect.apply(nativeGetAttribute, script, ['type']) as
				string | null;
			hiddenMutation(() =>
				Reflect.apply(nativeSetAttribute, script, ['type', 'text/plain']),
			);
			return () => {
				const first = hiddenMutation(() => {
					if (type === null)
						Reflect.apply(nativeRemoveAttribute, script, ['type']);
					else Reflect.apply(nativeSetAttribute, script, ['type', type]);
					const texts = textChildren(script);
					const written = texts.map(dataOf).join('');
					if (written === '') return null;
					const output =
						rewrittenScripts.get(script as HTMLScriptElement) === written
							? written
							: runnable(script, written);
					if (output === null) return null;
					if (output !== written) filled(script, texts, output);
					return texts[0];
				});
				// the script runs here, if it has not: what it does is the page's
				if (first)
					hiddenMove(script, first, () =>
						Reflect.apply(nativeInsertBefore, script, [
							first,
							Reflect.apply(nextSiblingGet, first, []),
						]),
					);
			};
		};
		/**
		 * Children are about to land in `script` (see fillable): the first
		 * `count` of `args`, strings among them when `strings`. An empty
		 * script runs what lands, wherever it lands, so that text is
		 * rewritten where it stands, in its first node (a string becomes the
		 * Text node the browser would make of it); a script that holds text
		 * is held (holdScript) unless that text is what the hooks wrote, which
		 * ran when they wrote it. Returns what to call once the children are in.
		 */
		const fillScript = (
			script: Element,
			args: unknown[],
			count: number,
			strings: boolean,
		): (() => void) | undefined => {
			const existing = textChildren(script).map(dataOf).join('');
			if (existing !== '')
				return rewrittenScripts.get(script as HTMLScriptElement) === existing
					? undefined
					: holdScript(script);
			const texts: CharacterData[] = [];
			for (let i = 0; i < count; i++) {
				const type = nodeTypeOf(args[i]);
				if (type === 3 || type === 4) texts.push(args[i] as CharacterData);
				else if (type === 11) texts.push(...textChildren(args[i] as Node));
				else if (type === null && strings) {
					args[i] = Reflect.apply(nativeCreateTextNode, realm.document, [
						String(args[i]),
					]);
					texts.push(args[i] as CharacterData);
				}
			}
			const written = texts.map(dataOf).join('');
			// nothing to run, or the text a hooked setter prepared already
			if (
				written === '' ||
				rewrittenScripts.get(script as HTMLScriptElement) === written
			)
				return;
			const output = runnable(script, written);
			if (output === null) return;
			// text the rewriter leaves as it is stays in the nodes it came in
			if (output === written)
				rewrittenScripts.set(script as HTMLScriptElement, output);
			else filled(script, texts, output);
		};

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

			// the browser's nodeType (an insertion argument is a Node)
			const nodeType = nodeTypeOf(insert);
			const queryable = nodeType === 1 || nodeType === 11 ? nodeType : null;

			// nodes the hooks never saw (DOMParser, createContextualFragment,
			// importNode, another document): route their attributes now. A node
			// of another document is adopted into this one on the way in, where
			// its images load at once, connected or not
			if (queryable !== null) {
				const foreign = foreignNode(insert, that);
				if (willConnect || foreign) routeUnseen(insert, queryable, foreign);
			}

			// scripts the page's script-src refused before they connected, which
			// a nonce could still let through (DocumentClient.holdScript): judged
			// again now, with the nonce they have; refused, the violation and the
			// error, let through, their src is the page's again. Before the
			// scripts are rewritten, which would take one without its src for
			// an empty inline script
			if (willConnect && queryable !== null && client.scriptsHeld) {
				const scripts = queryIn(insert, queryable, 'script');
				if (queryable === 1) scripts.unshift(insert as Element);
				for (const script of scripts) {
					const held = client.releaseScript(script);
					if (!held) continue;
					if (client.refuseExternalScript(script, held.url, false))
						client.dispatchLoadError(script);
					else
						usePrototype(script, CustomElement.prototype, (element) => {
							element.setAttribute('src', held.src);
							domHooksModule.updateAttributeHooks(element, 'src');
						});
				}
			}

			// we're about to render
			const name = htmlName(insert);
			// (where the page inserts a base a violation may name)
			if (willConnect)
				client.notesBases?.(
					name === 'BASE'
						? [insert as Element]
						: queryable !== null
							? queryIn(insert, queryable, 'base')
							: [],
				);
			// an HTML or an SVG <style>, inserted itself
			const insertedStyle = client.styleElement(insert);
			// a script itself, an HTML or an SVG one (whose name is lowercase)
			if (isScriptElement(insert)) {
				rewriteAnyScript(insert, willConnect);
			} else if (insertedStyle) {
				// before it connects and the browser parses it
				if (willConnect) withStyle(insertedStyle, rewriteStyleText);
			} else if (queryable !== null) {
				// any element named style: an HTML one, an SVG one, or one of
				// another namespace, which is no style (withStyle)
				for (const element of queryIn(insert, queryable, 'style')) {
					const style = client.styleElement(element);
					if (!style) continue;
					if (willConnect) withStyle(style, rewriteStyleText);
					styles.push(style);
				}

				for (const script of queryIn(insert, queryable, 'script'))
					rewriteAnyScript(script, willConnect);
			}

			const result = insertElement();
			// a frame that just connected is injected before the page can
			// reach it by a literal name (IFrame's sweepFrames)
			if (willConnect) client.sweepFrames?.();

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
		// `call` puts the first `count` of `args` under `parent`, beside or
		// into `receiver` (the parent itself, or the child they land next to)
		const landing = <T>(
			receiver: Node | null,
			parent: Node | null,
			args: unknown[],
			count: number,
			strings: boolean,
			call: () => T,
		): T => {
			const style = client.styleElement(parent);
			if (style) {
				for (let i = 0; i < count; i++) {
					if (nodeTypeOf(args[i]) !== null) routeInsertedText(args[i] as Node);
					else if (strings)
						args[i] = Reflect.apply(nativeCreateTextNode, realm.document, [
							client.prepareStyleText(String(args[i])),
						]);
				}
				prewritten.add(style);
			}
			const script = fillable(parent);
			const release = script
				? fillScript(script, args, count, strings)
				: undefined;
			// a node of any realm: the page's own document made it, or the
			// bundle did for a document its creator reaches into. Only what
			// lands: insertBefore's reference child and replaceChild's old one
			// are arguments too, and each was walked again, subtree and all,
			// on every keyed move a framework makes
			const nodes: Node[] = [];
			for (let i = 0; i < count; i++)
				if (nodeTypeOf(args[i]) !== null) nodes.push(args[i] as Node);
			// an xml-stylesheet processing instruction loads as a document's child
			if (nodeTypeOf(parent) === 9) {
				for (const node of nodes) landStylesheetPIs(client, node);
			}
			const run = (index: number): T =>
				index < nodes.length
					? insert(nodes[index], receiver, () => run(index + 1))
					: call();
			try {
				return run(0);
			} finally {
				// the insertion threw before the pass that takes it
				if (style) prewritten.delete(style);
				release?.();
			}
		};
		// one hook for each kind of method, shared by its wrappers (a hook
		// made for each wrapper cost a frame a function and a context apiece)
		const insertHook =
			(childNode: boolean, strings: boolean) =>
			(target: Function, that: any, args: any[]) =>
				landing(
					that,
					childNode ? parentOf(that) : that,
					args,
					strings ? args.length : Math.min(args.length, 1),
					strings,
					() => Reflect.apply(target, that, args),
				);
		/** Node's own: one node, into `this` */
		const nodeHook = insertHook(false, false);
		/** ParentNode's: nodes and strings, into `this` */
		const parentHook = insertHook(false, true);
		/** ChildNode's: nodes and strings, into `this`'s parent */
		const childHook = insertHook(true, true);
		const willInsertNode = (
			x: (inserted: Node, ...args: any[]) => any,
			hook = nodeHook,
		) => proxyModule.wrapFunction(x, hook);

		realm.Node.prototype.appendChild = willInsertNode(
			realm.Node.prototype.appendChild,
		);
		realm.Node.prototype.insertBefore = willInsertNode(
			realm.Node.prototype.insertBefore,
		);
		realm.Node.prototype.replaceChild = willInsertNode(
			realm.Node.prototype.replaceChild,
		);
		// ParentNode and ChildNode methods, on each prototype that has its own
		// copy: a shadow root (a DocumentFragment) connected through its host
		// runs a script appended to it like any connected parent
		// (a Text's before, after and replaceWith put text into its style)
		// (a doctype's before, after and replaceWith put nodes into its document)
		for (const proto of [
			realm.Element.prototype,
			realm.DocumentFragment.prototype,
			realm.Document.prototype,
			realm.CharacterData.prototype,
			realm.DocumentType.prototype,
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
					['replaceWith', 'before', 'after'].includes(method)
						? childHook
						: parentHook,
				);
			}

		// The insertAdjacent methods, as the spec writes them: a position in
		// any case (Chrome's error for another), the node put in through the
		// hooked insertBefore of the element or its parent (so the hooks see
		// it as for any insertion), what Chrome returns. insertAdjacentHTML
		// parses in the context the browser would: the element, or the parent
		// for a sibling position (a fragment's or the root's is the body's)
		const hookedInsertBefore = realm.Node.prototype.insertBefore;
		const nativeFirstChild = Reflect.getOwnPropertyDescriptor(
			Node.prototype,
			'firstChild',
		)!.get!;
		const nativeNextSibling = Reflect.getOwnPropertyDescriptor(
			Node.prototype,
			'nextSibling',
		)!.get!;
		const nativeOwnerDocument = Reflect.getOwnPropertyDescriptor(
			Node.prototype,
			'ownerDocument',
		)!.get!;
		const POSITIONS = ['beforebegin', 'afterbegin', 'beforeend', 'afterend'];
		const adjacentPosition = (value: unknown, api: string): string => {
			const given = String(value);
			const position = given.replace(/[A-Z]/g, (c) => c.toLowerCase());
			if (!POSITIONS.includes(position))
				throw withStack(
					new realm.DOMException(
						`Failed to execute '${api}' on 'Element': The value provided ('${given}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.`,
						'SyntaxError',
					),
				);
			return position;
		};
		/** put `node` at `position` of `element`; false when a sibling position has no parent */
		const insertAdjacent = (
			element: Element,
			position: string,
			node: Node,
		): boolean => {
			switch (position) {
				case 'beforebegin': {
					const parent = parentOf(element);
					if (parent === null) return false;
					Reflect.apply(hookedInsertBefore, parent, [node, element]);
					return true;
				}
				case 'afterbegin':
					Reflect.apply(hookedInsertBefore, element, [
						node,
						Reflect.apply(nativeFirstChild, element, []),
					]);
					return true;
				case 'beforeend':
					Reflect.apply(hookedInsertBefore, element, [node, null]);
					return true;
				default: {
					const parent = parentOf(element);
					if (parent === null) return false;
					Reflect.apply(hookedInsertBefore, parent, [
						node,
						Reflect.apply(nativeNextSibling, element, []),
					]);
					return true;
				}
			}
		};

		realm.Element.prototype.insertAdjacentText = proxyModule.wrapFunction(
			realm.Element.prototype.insertAdjacentText,
			(target, that: Element, args) => {
				// the browser's own refusals first: of the receiver, then of
				// the count
				if (args.length < 2) return Reflect.apply(target, that, args);
				requireElement(that);
				const position = adjacentPosition(args[0], 'insertAdjacentText');
				const text = Reflect.apply(
					nativeCreateTextNode,
					Reflect.apply(nativeOwnerDocument, that, []),
					[String(args[1])],
				) as Text;
				insertAdjacent(that, position, text);
			},
		);

		realm.Element.prototype.insertAdjacentElement = proxyModule.wrapFunction(
			realm.Element.prototype.insertAdjacentElement,
			(target, that: Element, args) => {
				// the browser's own refusals first: of the receiver, then of
				// the count
				if (args.length < 2) return Reflect.apply(target, that, args);
				requireElement(that);
				// an element of any realm (instanceof knows only one)
				if (nodeTypeOf(args[1]) !== 1)
					throw new realm.TypeError(
						`Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.`,
					);
				const position = adjacentPosition(args[0], 'insertAdjacentElement');
				return insertAdjacent(that, position, args[1] as Element)
					? args[1]
					: null;
			},
		);

		realm.Element.prototype.insertAdjacentHTML = proxyModule.wrapFunction(
			realm.Element.prototype.insertAdjacentHTML,
			(target, that: Element, args) => {
				const own = domHooksModule.ownMember(that, 'insertAdjacentHTML');
				if (own) return Reflect.apply(own, that, args);
				// the browser's own refusals first: of the receiver, then of
				// the count
				if (args.length < 2) return Reflect.apply(target, that, args);
				requireElement(that);
				// (the page's Trusted Types judge the markup first)
				const markup = client.trustedValue(
					args[1],
					'TrustedHTML',
					'Element insertAdjacentHTML',
					() => Reflect.apply(target, that, args),
				);
				if (markup === null) return;
				const position = adjacentPosition(args[0], 'insertAdjacentHTML');
				let context: Node | null = that;
				if (position === 'beforebegin' || position === 'afterend') {
					context = parentOf(that);
					if (context === null || nodeTypeOf(context) === 9)
						throw withStack(
							new realm.DOMException(
								"Failed to execute 'insertAdjacentHTML' on 'Element': The element has no parent.",
								'NoModificationAllowedError',
							),
						);
				}
				const document = realm.document;
				const fragment = cloneRawNode(
					parseHTMLFragmentIn(
						markup,
						nodeTypeOf(context) === 1 &&
							!(
								(context as Element).localName === 'html' &&
								(context as Element).namespaceURI ===
									'http://www.w3.org/1999/xhtml'
							)
							? (context as Element)
							: null,
						document,
					),
					document,
				) as DocumentFragment;
				insertAdjacent(that, position, fragment);
			},
		);

		// The other ways one node of the page's reaches a tree: a range puts
		// it at its start (insertNode) or around its contents
		// (surroundContents), a document takes it for its body, a table for
		// its caption, head or foot, a select (or its options collection) for
		// an option. None of them goes through an insertion method the page
		// could have called itself, so each is run through the hooks here: a
		// script in the node ran as the page wrote it, and a node another
		// parser made kept the handlers and URLs of its markup.
		const global = realm;
		const wrapMethod = (
			prototype: object | undefined,
			name: string,
			handler: (target: Function, that: any, args: any[]) => unknown,
		) => {
			const native = prototype && (prototype as Record<string, unknown>)[name];
			if (typeof native !== 'function') return;
			(prototype as Record<string, unknown>)[name] = proxyModule.wrapFunction(
				native as (...args: any[]) => unknown,
				handler,
			);
		};
		const wrapSetter = (
			prototype: object | undefined,
			name: string,
			handler: (target: Function, that: any, args: any[]) => unknown,
		) => {
			const descriptor =
				prototype && Reflect.getOwnPropertyDescriptor(prototype, name);
			if (!descriptor?.set) return;
			Reflect.defineProperty(prototype!, name, {
				...descriptor,
				set: proxyModule.wrapFunction(descriptor.set, handler),
			});
		};
		const rangeStart = nativeGetter(global.Range.prototype, 'startContainer');
		// where a range inserts: its start node, or the parent of the text,
		// comment or processing instruction it starts in. Null when the
		// receiver is no range (the call throws on its own)
		const rangeParent = (range: unknown): Node | null => {
			try {
				const start = Reflect.apply(rangeStart, range, []) as Node;
				const type = nodeTypeOf(start);
				return type === 3 || type === 4 || type === 7 || type === 8
					? parentOf(start)
					: start;
			} catch (error) {
				return null;
			}
		};
		wrapMethod(global.Range.prototype, 'insertNode', (target, that, args) => {
			const parent = rangeParent(that);
			return landing(
				parent,
				parent,
				args,
				Math.min(args.length, 1),
				false,
				() => Reflect.apply(target, that, args),
			);
		});
		wrapMethod(
			global.Range.prototype,
			'surroundContents',
			(target, that, args) => {
				const parent = rangeParent(that);
				// the new parent lands empty and takes the range's contents
				// once it is in: a script runs them then
				const wrapper = args[0];
				const script =
					parent !== null &&
					Reflect.apply(nativeIsConnected, parent, []) &&
					isScriptElement(wrapper) &&
					runnable(wrapper, '') !== null
						? wrapper
						: null;
				return landing(
					parent,
					parent,
					args,
					Math.min(args.length, 1),
					false,
					() => {
						const release = script ? holdScript(script) : undefined;
						try {
							return Reflect.apply(target, that, args);
						} finally {
							release?.();
						}
					},
				);
			},
		);
		// a Text split in two puts the second half in as a new child: a script
		// that holds text it has not run runs it then
		wrapMethod(global.Text.prototype, 'splitText', (target, that, args) => {
			const script = fillable(parentOf(that));
			const release =
				script &&
				rewrittenScripts.get(script as HTMLScriptElement) !==
					textChildren(script).map(dataOf).join('')
					? holdScript(script)
					: undefined;
			try {
				return Reflect.apply(target, that, args);
			} finally {
				release?.();
			}
		});
		const documentElementGet = nativeGetter(
			global.Document.prototype,
			'documentElement',
		);
		wrapSetter(global.Document.prototype, 'body', (target, that, args) => {
			let root: Node | null = null;
			try {
				root = Reflect.apply(documentElementGet, that, []) as Node | null;
			} catch (error) {
				// not a document: the setter throws on its own
			}
			return landing(root, root, args, 1, false, () =>
				Reflect.apply(target, that, args),
			);
		});
		for (const section of ['caption', 'tHead', 'tFoot'])
			wrapSetter(
				global.HTMLTableElement?.prototype,
				section,
				(target, that, args) =>
					landing(that, that, args, 1, false, () =>
						Reflect.apply(target, that, args),
					),
			);
		wrapMethod(
			global.HTMLSelectElement?.prototype,
			'add',
			(target, that, args) =>
				landing(that, that, args, Math.min(args.length, 1), false, () =>
					Reflect.apply(target, that, args),
				),
		);
		// an options collection does not say whose it is: the select that
		// handed it out is remembered
		const selects = new LazyWeakMap<object, Node>();
		{
			const prototype = global.HTMLSelectElement?.prototype;
			const descriptor =
				prototype && Reflect.getOwnPropertyDescriptor(prototype, 'options');
			if (descriptor?.get)
				Reflect.defineProperty(prototype, 'options', {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const options = Reflect.apply(target, that, args);
							if (options && typeof options === 'object')
								selects.set(options, that);
							return options;
						},
					),
				});
		}
		wrapMethod(
			global.HTMLOptionsCollection?.prototype,
			'add',
			(target, that, args) => {
				const select = selects.get(that) ?? null;
				return landing(
					select,
					select,
					args,
					Math.min(args.length, 1),
					false,
					() => Reflect.apply(target, that, args),
				);
			},
		);

		// `select[0] = option` and `select.options[0] = option` insert through
		// the indexed setter, which is no method: the access API brings the
		// write here (set2), and the node lands as it does through `add`
		{
			const lengthGet = Reflect.getOwnPropertyDescriptor(
				global.HTMLOptionsCollection?.prototype ?? {},
				'length',
			)?.get;
			client.landIndexed = (target, value, assign) => {
				if (nodeTypeOf(value) === null) return assign();
				let select: Node | null;
				if (nodeTypeOf(target) === 1) {
					if (htmlName(target as Node) !== 'SELECT') return assign();
					select = target as Node;
				} else {
					// the select that handed the collection out, when it was
					// this realm's getter that did
					select = selects.get(target) ?? null;
					if (!select)
						try {
							if (!lengthGet) return assign();
							Reflect.apply(lengthGet, target, []);
						} catch (error) {
							// no options collection
							return assign();
						}
				}
				return landing(select, select, [value], 1, false, assign);
			};
		}

		// adoptNode and importNode put a node of another document in this one
		// without inserting it: its images and media load there at once and
		// its handlers run when they fire (an img's onerror). It is routed
		// where it stands first, in its own document, where nothing loads
		for (const name of ['adoptNode', 'importNode'])
			wrapMethod(global.Document.prototype, name, (target, that, args) => {
				const type = nodeTypeOf(args[0]);
				if ((type === 1 || type === 11) && foreignNode(args[0], that))
					routeUnseen(args[0], type, true);
				return Reflect.apply(target, that, args);
			});

		// does not insert element
		realm.Node.prototype.removeChild = proxyModule.wrapFunction(
			realm.Node.prototype.removeChild,
			(target, that, args) => {
				const result = Reflect.apply(target, that, args);

				textUpdatesStyle(that);

				return result;
			},
		);
	}
}
