import { routeHTML } from '../../../rewriteHTML';
import { openFragment } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule, {
	applyDescriptors,
	cleanupPrototype,
	usePrototype,
} from '../../modules/Proxy';
import {
	routedPrefix,
	scopePrefix,
	unrouteCSS,
	unrouteURL,
} from '../../modules/Unroute';
import { getPublicSuffix } from '../../rewriter';
import {
	isParsed,
	ownScripts,
	TRUSTED_KINDS,
	trustedAttribute,
	trustedHTML,
	trustedOf,
	trustedSink,
} from '../../trusted';
import DocumentClient, {
	addDocumentOpenListener,
	getGlobalParsingState,
	runDocumentOpenListeners,
	setGlobalParsingState,
} from '../Client';
import cloneRawNode, {
	inertDocumentOf,
	isHTMLTemplate,
	isScriptElement,
	parseHTMLFragmentIn,
	releaseMarkup,
	templateContentDocument,
} from '../cloneNode';
import { frameWindow } from '../freshContext';
import { responseURLOf } from '../responseDocuments';
import WriteStream from '../WriteStream';
import {
	attributeName,
	hookWrite,
	MARKER,
	pageWrite,
	propertyAttribute,
} from './MutationObserver';

const attributeTab = new WeakMap<CustomElement, Map<string, string | null>>();
// the value last applied to each hooked attribute (the routed one), so a
// hook can tell an attribute it wrote from one the page changed since
const appliedTab = new WeakMap<Element, Map<string, string | null>>();

// the namespace ('' for none) of each prefixed attribute a hook removed
// (xlink:href, while a load's copy is on its way): set again, it is the same
// attribute, not one of no namespace that the element ignores
const removedNamespaces = new WeakMap<Element, Map<string, string>>();

const ORIGINAL_ATTRIBUTE = MARKER;
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Whether the hooks are working on `element` (inside usePrototype with the
 * CustomElement prototype), where their view of its attributes holds writes
 * the DOM has not had yet. Anywhere else the DOM is that view, and a read of
 * it needs no prototype swap.
 */
export function pendingAttributes(element: unknown): boolean {
	return attributeTab.has(element as CustomElement);
}

/**
 * `attribute` of `element` made real by STomp itself, natively, now (a frame
 * given a fresh context, freshContext.ts): the hooks' view, while they work
 * on it, drops a write of it, and `value` is the one they applied
 */
export function appliedAttribute(
	element: Element,
	attribute: string,
	value: string | null,
) {
	attributeTab.get(element as CustomElement)?.delete(attribute);
	if (!appliedTab.has(element)) appliedTab.set(element, new Map());
	appliedTab.get(element)!.set(attribute, value);
}
/** the string an HTML sink makes of a value ([LegacyNullToEmptyString]) */
const htmlString = (value: unknown) => (value === null ? '' : String(value));

/** a value the hooks' view of `element` holds (null: removed) made real */
function applyAttribute(
	element: Element,
	attribute: string,
	value: string | null,
) {
	try {
		if (value === null) {
			const node = nativeElement.getAttributeNode.call(element, attribute);
			if (node && attribute.includes(':')) {
				if (!removedNamespaces.has(element))
					removedNamespaces.set(element, new Map());
				removedNamespaces.get(element)!.set(attribute, node.namespaceURI ?? '');
			}
			nativeElement.removeAttribute.call(element, attribute);
		} else if (nativeElement.hasAttribute.call(element, attribute)) {
			nativeElement.setAttribute.call(
				element,
				attribute,
				trustedAttribute(element, attribute, value),
			);
		} else {
			// an SVG element's xlink: attribute the hooks set first (one
			// the parser made from written markup that a hook held back)
			// is in the xlink namespace, as the parser would have put it
			const namespace =
				removedNamespaces.get(element)?.get(attribute) ??
				(attribute.startsWith('xlink:') &&
				Reflect.get(nativeElement, 'namespaceURI', element) === SVG_NAMESPACE
					? XLINK_NAMESPACE
					: '');
			// (a trusted value where Trusted Types require one: trusted.ts)
			const given = trustedAttribute(
				element,
				attribute,
				value,
				namespace || null,
			);
			if (namespace)
				nativeElement.setAttributeNS.call(element, namespace, attribute, given);
			else nativeElement.setAttribute.call(element, attribute, given);
		}
		if (!appliedTab.has(element)) appliedTab.set(element, new Map());
		appliedTab.get(element)!.set(attribute, value);
	} catch (error) {
		console.warn('bad attribute', attribute, value, error);
	}
}

export class CustomElement extends Element {
	get attributeTab() {
		if (!attributeTab.has(this)) {
			attributeTab.set(this, new Map());
		}

		return attributeTab.get(this)!;
	}
	getAttribute(attribute: string): string | null {
		if (this.attributeTab.has(attribute)) {
			return this.attributeTab.get(attribute)!;
		} else {
			return nativeElement.getAttribute.call(this, attribute);
		}
	}
	setAttribute(attribute: string, value: string) {
		this.attributeTab.set(attribute, value);
	}
	removeAttribute(attribute: string) {
		this.attributeTab.set(attribute, null);
	}
	hasAttribute(attribute: string) {
		if (this.attributeTab.has(attribute)) {
			return this.attributeTab.get(attribute) !== null;
		}

		return nativeElement.hasAttribute.call(this, attribute);
	}
	applyAttributes() {
		// called after the prototype is restored, so don't rely on `this.attributeTab`
		const tab = attributeTab.get(this);
		if (!tab) return;
		// only read (getAttribute, a property hook that took nothing): no
		// write, so no write for the page's observers to be kept from
		if (!tab.size) {
			attributeTab.delete(this);
			return;
		}

		// outside a page write these are the hooks' own: no record for them
		hookWrite(
			this,
			() => tab.keys(),
			() => {
				for (const [attribute, value] of tab) {
					tab.delete(attribute);
					applyAttribute(this, attribute, value);
				}
			},
		);

		attributeTab.delete(this);
	}
	/**
	 * Before a hook recomputes an attribute: when the attribute still holds
	 * the value the hook last wrote, start again from the page's original;
	 * when the page has set a new value since (setAttribute, the property),
	 * that value stands and the stale original goes.
	 */
	restoreAttributesOG(...names: string[]) {
		for (const name of names) {
			if (!this.hasAttributeOG(name)) {
				continue;
			}

			const applied = appliedTab.get(this)?.get(name);
			if (applied !== undefined && this.getAttribute(name) === applied)
				this.setAttribute(name, this.getAttributeOG(name)!);
			this.removeAttributeOG(name);
		}
	}
	[cleanupPrototype]() {
		// invoked after the real prototype is restored (see usePrototype)
		CustomElement.prototype.applyAttributes.call(this);
	}
	getAttributeOG(attribute: string): string | null {
		const og = `${ORIGINAL_ATTRIBUTE}${attribute}`;

		if (this.hasAttribute(og)) {
			return this.getAttribute(og)!;
		} else {
			return null;
		}
	}
	getAttributeNamesOG(): string[] {
		const names: string[] = [];

		for (const name of this.getAttributeNames())
			if (name.startsWith(ORIGINAL_ATTRIBUTE))
				names.push(name.slice(ORIGINAL_ATTRIBUTE.length));

		console.log(names, ORIGINAL_ATTRIBUTE, this.getAttributeNames());

		return names;
	}
	setAttributeOG(attribute: string, value: string) {
		const og = `${ORIGINAL_ATTRIBUTE}${attribute}`;

		this.setAttribute(og, value);
	}
	hasAttributeOG(attribute: string): boolean {
		const og = `${ORIGINAL_ATTRIBUTE}${attribute}`;

		return this.hasAttribute(og);
	}
	removeAttributeOG(attribute: string) {
		const og = `${ORIGINAL_ATTRIBUTE}${attribute}`;

		this.removeAttribute(og);
	}
}

export const nativeEventTarget: EventTarget = <any>{};
export const nativeNode: Node = Object.create(nativeEventTarget);
export const nativeElement: Element = Object.create(nativeNode);
export const nativeHTMLElement: HTMLElement = Object.create(nativeElement);
const nativeHTMLTemplateElement: HTMLTemplateElement =
	Object.create(nativeHTMLElement);

applyDescriptors(nativeNode, Node.prototype);
applyDescriptors(nativeEventTarget, EventTarget.prototype);
applyDescriptors(nativeElement, Element.prototype);
applyDescriptors(nativeHTMLElement, HTMLElement.prototype);
applyDescriptors(nativeHTMLTemplateElement, HTMLTemplateElement.prototype);

Reflect.setPrototypeOf(CustomElement.prototype, nativeElement);

/**
 * The browser's getter of `key` on one of the native prototypes above (its
 * own or an ancestor's), to call on a node with Reflect.apply: a read that
 * needs no hook prototype costs no swap (usePrototype), and a getter the page
 * put on the instance is passed by just the same
 */
export function nativeGetter(prototype: object, key: string): () => unknown {
	for (
		let object: object | null = prototype;
		object;
		object = Reflect.getPrototypeOf(object)
	) {
		const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
		if (descriptor?.get) return descriptor.get;
	}
	throw new TypeError(`Stomp: no native getter ${key}`);
}

/*
do it statefully

// set element prototype when working on it

useAttributes(element => {
	if(element.hasAttribute('href') && element.hasAttribute('rel')) {
		
	}
}, ['rel', 'href']);

determining element.src:
	element.setAttribute('src', RAW SRC);
	const src = element.src;
	element.setAttribute('src', PROXIED SRC);
	can work for every element that has an effect at the end of the stack
	end of stake being when setTimeout(() => {}) is executed

*/

type ElementCtor = { new (): HTMLElement };

/** called with the element and the attribute that changed */
type HookCallback = (element: CustomElement, attribute: string) => void;

/**
 * An element name (or '*') and the attribute watched, or a set of them that
 * one callback watches (the event handler attributes: an entry each cost
 * every frame about 120 bytes)
 */
type AttributeHook = [
	nodeName: Element['nodeName'],
	attribute: string | ReadonlySet<string>,
];

/**
 * This function is called when the property is accessed on the specified element ctor. If false, the next property hook getter will be called until the result is a string.
 */
type PropertyHookGetter = (element: CustomElement) => string | false;

type PropertyHook = [
	ctor: ElementCtor,
	property: string,
	getter: PropertyHookGetter,
];

interface HookEntry {
	hook: AttributeHook | PropertyHook;
	callback: HookCallback;
}

/** what attributeHooks answers for an attribute no hook watches */
const NO_HOOKS: readonly HookEntry[] = [];

function isAttributeHook(
	hook: AttributeHook | PropertyHook,
): hook is AttributeHook {
	return typeof hook[0] === 'string';
}

/**
 * Provides a framework for hooking elements
 */
export default class DOMHooksModule extends Module<DocumentClient> {
	/** markup of an element as the page wrote it (markers folded back) */
	serializeOriginal!: (element: Element, outer: boolean) => string;
	/** getHTML's serialized markup, for the readback modules to finish (CSS) */
	foldMarkup!: (html: string) => string;
	/** a deep copy of `node` in a document with no window, where nothing loads */
	inertCopy!: <T extends Node>(node: T) => T;
	private hooks: HookEntry[];
	constructor(client: DocumentClient) {
		super(client);

		this.hooks = [];
	}
	/**
	 * A URL property's native value as the page sees it: a route of the scope
	 * is the real URL it stands for (an inline document's own address is the
	 * page's URL); anything else is returned as it is.
	 */
	readbackURL(value: string): string {
		if (!value.startsWith(scopePrefix(this.client))) return value;
		if (value.startsWith(`${routedPrefix(this.client)}inline:`)) {
			const hash = value.indexOf('#');
			const url = new URL(this.client.url.toString());
			url.hash =
				hash === -1
					? ''
					: `#${openFragment(this.client.codec, value.slice(hash + 1))}`;
			return url.href;
		}
		return unrouteURL(this.client, value) ?? value;
	}
	/*useAttributes(
		callback: (element: CustomElement) => void,
		elements: string[],
		attributes: string[],
		ctors: ElementCtor[] = [],
		properties: { [property: string]: PropData } = {}
	) {
		for (const element of elements) {
			if (!this.trackAttributes.has(element)) {
				this.trackAttributes.set(element, new Set());
			}

			for (const attribute of attributes) {
				this.trackAttributes.get(element)!.add(attribute);
			}
		}

		for (const ctor of ctors) {
			if (!this.trackProperties.has(ctor)) {
				this.trackProperties.set(ctor, new Map());
			}

			for (const property in properties) {
				if (!this.trackProperties.get(ctor)!.has(property)) {
					this.trackProperties.get(ctor)!.set(property, []);
					console.error(this.trackProperties.get(ctor), property);
					throw new Error(`Property hooks cannot overlap.`);
				}

				this.trackProperties
					.get(ctor)!
					.get(property)!
					.push(properties[property]);
			}
		}

		this.attributeHooks.push([
			elements,
			callback,
			attributes,
			ctors,
			properties,
		]);
	}*/
	/**
	 * A property hook's constructor is this client's realm's
	 * (`this.client.global.X`), never the bundle's free global: an about:blank
	 * frame its creator reaches into runs the creator's bundle, and a free
	 * name would put the frame's hooks on the creator's prototypes (the frame,
	 * which no worker controls, then copied the creator's own loads).
	 */
	useAttributes(
		callback: HookCallback,
		hooks: (AttributeHook | PropertyHook)[],
	) {
		for (const hook of hooks) {
			this.hooks.push({
				callback,
				hook,
			});
		}
		this.#hookedNames = null;
		this.#hooksByName.clear();
		this.#readHooks.clear();
		this.#writeHooks.clear();
	}
	/** the attribute hooks by element name and attribute (attributeHooks) */
	#hooksByName = new Map<string, Map<string, readonly HookEntry[]>>();
	/** every attribute name an attribute hook watches, on any element */
	#hookedNames: Set<string> | null = null;
	/** the sets of names a hook watches (AttributeHook) */
	#hookedSets: ReadonlySet<string>[] = [];
	/**
	 * Whether an attribute hook watches `attribute` on some element: the
	 * insertion pass asks before it looks at an element's hooks at all, since
	 * most attributes of most elements (class, id, a template's bindings)
	 * have none
	 */
	hooksAttribute(attribute: string): boolean {
		if (!this.#hookedNames) {
			this.#hookedNames = new Set();
			this.#hookedSets = [];
			for (const entry of this.hooks)
				if (isAttributeHook(entry.hook)) {
					const watched = entry.hook[1];
					if (typeof watched === 'string') this.#hookedNames.add(watched);
					else this.#hookedSets.push(watched);
				}
		}
		return (
			this.#hookedNames.has(attribute) ||
			this.#hookedSets.some((names) => names.has(attribute))
		);
	}
	/** the attribute hooks of `attribute` on `element` */
	private attributeHooks(
		element: Element,
		attribute: string,
	): readonly HookEntry[] {
		if (!this.hooksAttribute(attribute)) return NO_HOOKS;
		// HTML hooks are keyed by the uppercase nodeName of an HTML document;
		// an XHTML document's elements carry the same names in lowercase
		const name =
			element.namespaceURI === 'http://www.w3.org/1999/xhtml'
				? element.nodeName.toUpperCase()
				: element.nodeName;
		// every attribute write and insertion asks: the list is filtered once
		// per name and watched attribute (useAttributes starts again)
		let byAttribute = this.#hooksByName.get(name);
		if (!byAttribute) {
			byAttribute = new Map();
			this.#hooksByName.set(name, byAttribute);
		}
		let hooks = byAttribute.get(attribute);
		if (!hooks) {
			hooks = this.hooks.filter(
				(entry) =>
					isAttributeHook(entry.hook) &&
					(entry.hook[0] === '*' || entry.hook[0] === name) &&
					(typeof entry.hook[1] === 'string'
						? entry.hook[1] === attribute
						: entry.hook[1].has(attribute)),
			);
			byAttribute.set(attribute, hooks);
		}
		return hooks;
	}
	updateAttributeHooks(element: CustomElement, attribute: string) {
		for (const entry of this.attributeHooks(element, attribute))
			entry.callback(element, attribute);
	}
	/**
	 * The property hooks by property (a read asks every constructor's), and
	 * by constructor and property (a write's), in the hooks' order, until
	 * useAttributes adds any: each read and write looked at every hook
	 */
	#readHooks = new Map<string, readonly HookEntry[]>();
	#writeHooks = new Map<ElementCtor, Map<string, readonly HookEntry[]>>();
	#propertyHooks(property: string): readonly HookEntry[] {
		let entries = this.#readHooks.get(property);
		if (!entries) {
			entries = this.hooks.filter(
				(entry) => !isAttributeHook(entry.hook) && entry.hook[1] === property,
			);
			this.#readHooks.set(property, entries);
		}
		return entries;
	}
	private updatePropertyHooks(
		element: CustomElement,
		ctor: ElementCtor,
		property: string,
	) {
		let byProperty = this.#writeHooks.get(ctor);
		if (!byProperty) {
			byProperty = new Map();
			this.#writeHooks.set(ctor, byProperty);
		}
		let entries = byProperty.get(property);
		if (!entries) {
			entries = this.hooks.filter(
				(entry) =>
					!isAttributeHook(entry.hook) &&
					entry.hook[0] === ctor &&
					entry.hook[1] === property,
			);
			byProperty.set(property, entries);
		}
		for (const entry of entries)
			entry.callback(element, propertyAttribute(property));
	}
	apply() {
		// all hooks are in, now apply them

		const proxyModule = this.client.getModule(ProxyModule)!;

		/**
		 * Etc hooks are here
		 */

		// native write, taken before the prototype hook below replaces it: the
		// stream's output and a pending tail go through it
		const nativeWrite = this.client.global.document.write;
		const stream = new WriteStream(this.client);

		// document.open() drops every listener on the window: the modules that
		// listen there (message filter and tagger, link and navigate hooks)
		// register again. With three arguments it is window.open, which the
		// hook below handles.
		const documentOpen = this.client.global.Document.prototype.open;
		this.client.global.Document.prototype.open = proxyModule.wrapFunction(
			documentOpen,
			(target, that, args) => {
				if (args.length >= 3)
					return Reflect.apply(
						this.client.global.open,
						this.client.global,
						args,
					);
				// a fresh parser with an empty input stream: whatever an earlier
				// write left unfinished went with the old one
				if (typeof that === 'object' && that !== null) stream.reset(that);
				const result = Reflect.apply(target, that, args);
				if (that === this.client.global.document) {
					this.client.opened = true;
					runDocumentOpenListeners(this.client.global);
				}
				return result;
			},
		);

		this.client.global.open = proxyModule.wrapFunction(
			this.client.global.open,
			(target, that, args) => {
				const name = args[1] === undefined ? '_blank' : String(args[1]);
				// about:blank (or no URL) is a document the page writes itself:
				// opened as is, injected by the IFrame module's hook
				let destination: URL | null = null;
				if (args[0] !== undefined && String(args[0]) !== '')
					destination = new URL(
						String(args[0]),
						this.client.baseURL.toString(),
					);
				const routable =
					destination !== null && /^https?:$/.test(destination.protocol);
				// the proxied parent or top, named from a frame under the top:
				// the URL is routed as that window's document
				let aimed = this.client.targetWindow(name);
				// from a sandboxed document, the one it may navigate (else the
				// browser opens nothing and the page gets null)
				const keyword = name.toLowerCase();
				if (
					this.client.sandboxFlags !== null &&
					['_top', '_parent', '_unfencedtop'].includes(keyword)
				) {
					const window =
						keyword === '_parent' ? this.client.parent : this.client.proxiedTop;
					if (window !== this.client.global) {
						if (!this.client.mayNavigate(window)) return null;
						const client = (window as Record<string, any>)[
							this.client.names.client
						] as DocumentClient | undefined;
						if (client) aimed = { window, client };
					}
				}
				// a javascript: URL runs in the opened window: rewritten, like a
				// javascript: link (routeHTML rewrites its body)
				if (destination !== null && destination.protocol === 'javascript:')
					args[0] = routeHTML(
						new StompURL(destination, this.client.url),
						this.client.url,
						this.client.config,
						false,
						aimed ? aimed.client.nestedRoute : this.client.nestedRoute,
					);
				// a new tab: the host's to open, when it said so (then the page
				// sees null, as with a popup blocker). Not for a sandboxed
				// document's popup that keeps its sandbox: the browser refuses it
				// without allow-popups, and opens it sandboxed like the page
				// (the IFrame module starts it with the opener's flags)
				const escapes =
					this.client.sandboxFlags === null ||
					(this.client.allows('allow-popups') &&
						this.client.allows('allow-popups-to-escape-sandbox'));
				if (
					routable &&
					escapes &&
					!['_self', '_top', '_parent', '_unfencedtop'].includes(
						name.toLowerCase(),
					) &&
					// a frame of this page by that name: the browser navigates it
					!this.client.hasFrameNamed(name) &&
					this.client.openInHost(destination!.toString())
				)
					return null;

				if (routable)
					args[0] =
						// this window itself: a navigation like location.assign's; the
						// proxied parent or top: one of that window's own
						name.toLowerCase() === '_self'
							? this.client.navigationRoute(destination!)
							: aimed
								? aimed.client.navigationRoute(destination!)
								: routeHTML(
										new StompURL(destination!, this.client.url),
										this.client.url,
										this.client.config,
										false,
										this.client.nestedRoute,
									);

				// the proxied parent or top navigates from its own realm (see
				// DocumentClient targetWindow), and a javascript: URL's code runs
				// there; the caller gets that window
				if (aimed)
					return aimed.client.callIn(target, aimed.window, [
						args[0],
						'_self',
						...args.slice(2),
					]);

				// a frame of this document by that name still on its initial
				// about:blank fires no navigate event: one sent to another
				// origin gets a fresh context first, which the browser then
				// navigates by its name
				if (routable && destination) {
					const element = this.client.frameNamed(name);
					const view = element && frameWindow(element);
					let client: DocumentClient | undefined;
					try {
						client = view
							? ((view as unknown as Record<string, unknown>)[
									this.client.names.client
								] as DocumentClient | undefined)
							: undefined;
					} catch (error) {
						// another real origin's
					}
					client?.freshTo?.(destination, null, true);
				}

				// a top-level page is its own top and parent: navigate the frame
				// (a sandboxed frame's too)
				if (
					args[1] !== undefined &&
					['_top', '_parent', '_unfencedtop'].includes(name.toLowerCase())
				)
					args[1] = '_self';

				return Reflect.apply(target, that, args);
			},
		);

		// the written markup is tokenized across calls (WriteStream): a tag,
		// comment or script a call leaves unfinished waits for the call that
		// finishes it, as it does in the browser's own parser, and the whole
		// prefix is rewritten and written now. The arguments are joined first,
		// the way the browser does before it tokenizes (writeln's newline
		// included, so a tag left open by writeln sees it inside).
		type Write = (...text: string[]) => void;
		const writeFactory = (target: Write, newline: boolean): Write =>
			proxyModule.wrapFunction(target, (target, that, args) => {
				let text = '';
				for (const arg of args) text += String(arg);
				// (the page's Trusted Types: its joined text, a lone trusted value
				// as it is, TrustedTypes.ts)
				const passed = this.client.trustedValue(
					args.length === 1 ? args[0] : text,
					'TrustedHTML',
					newline ? 'Document writeln' : 'Document write',
					() => Reflect.apply(target, that, args),
					() => text,
				);
				if (passed === null) return;
				text = passed;
				if (newline) text += '\n';
				const document =
					typeof that === 'object' && that !== null
						? that
						: this.client.global.document;
				// a write once the document has loaded opens it again (the page
				// never called open()): known before the markup is rewritten, the
				// listeners after, once the browser has dropped the window's own
				const opens =
					document === this.client.global.document &&
					this.client.global.document.readyState === 'complete';
				// a document just opened (no root yet), or one this write opens
				const fresh =
					opens ||
					(document === this.client.global.document &&
						this.client.global.document.documentElement === null);
				if (opens) this.client.opened = true;
				const prevState = getGlobalParsingState(this.client.global);
				setGlobalParsingState(this.client.global, 'parsingBeforeWrite');
				let markup: string;
				try {
					markup = stream.write(document, text, fresh);
				} finally {
					setGlobalParsingState(this.client.global, prevState);
				}
				// an empty write still reaches the parser: after the document
				// has loaded it opens a new one, as the page's own call would
				Reflect.apply(nativeWrite, that, [trustedHTML(markup)]);
				// a frame the written markup made (a script it holds sweeps
				// first, see prepareScriptText)
				this.client.sweepFrames?.();
				if (opens) runDocumentOpenListeners(this.client.global);
				this.client.writtenLoads?.(document as Document);
			});

		// on the prototype, where the browser has them: an own property of the
		// document is a tell (Object.getOwnPropertyNames(document)), and a
		// window that keeps its realm across documents hands each new one the
		// hook. A popup's document finds its own realm's prototype, and so
		// that realm's client.
		const documentProto = this.client.global.Document.prototype;
		documentProto.write = writeFactory(documentProto.write, false);
		documentProto.writeln = writeFactory(documentProto.writeln, true);

		// document.close() ends the input: the unfinished tail goes to the
		// parser as it is, which meets it at the end of its input the way the
		// browser's would
		this.client.global.Document.prototype.close = proxyModule.wrapFunction(
			this.client.global.Document.prototype.close,
			(target, that, args) => {
				const tail = stream.take(that);
				if (tail) Reflect.apply(nativeWrite, that, [trustedHTML(tail)]);
				const result = Reflect.apply(target, that, args);
				this.client.writtenLoads?.(that as Document);
				return result;
			},
		);

		// when the parser stops on its own (the end of the real page's markup
		// after a blocking script, a frame's srcdoc) nothing can be written
		// into it any more: a write now would open a new document. A tail
		// left behind is stale, like the browser's at its end of input.
		const dropAtParserEnd = () => {
			if (this.client.global.document.readyState !== 'loading')
				stream.reset(this.client.global.document);
		};
		const listen = () =>
			this.client.global.document.addEventListener(
				'readystatechange',
				dropAtParserEnd,
			);
		listen();
		addDocumentOpenListener(this.client.global, listen);

		Reflect.defineProperty(this.client.global.Node.prototype, 'baseURI', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(
					this.client.global.Node.prototype,
					'baseURI',
				)!.get!,
				(target, that, args) => {
					// only side effect this getter has is the potential to throw an illegal invocation error
					const base = Reflect.apply(target, that, args);
					// a document with no base URL of its own or inherited (a popup
					// opened on a javascript: URL, a document the page made with
					// createHTMLDocument) has none for the page either
					if (base === 'about:blank') return base;
					return responseURLOf(that) ?? this.client.baseURL.toString();
				},
			),
		});

		Reflect.defineProperty(this.client.global.Document.prototype, 'URL', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(
					this.client.global.Document.prototype,
					'URL',
				)!.get!,
				(target, that, args) => {
					// only side effect this getter has is the potential to throw an illegal invocation error
					Reflect.apply(target, that, args);
					return responseURLOf(that) ?? this.client.location.toString();
				},
			),
		});

		// document.domain: the page's host, or the domain it set. The setter
		// checks the value as Chrome does (parsed as a host, then the host
		// itself or a parent domain of a name that is not a public suffix,
		// else the browser's SecurityError), and it takes effect only in an
		// agent cluster keyed by site (Origin-Agent-Cluster: ?0, decided by
		// the origin's first document in the tab; DocumentClient.siteKeyed).
		// In one keyed by origin, the default, it does nothing, as natively
		// (window.originAgentCluster). Set, even to the host itself, it is
		// what the window membrane compares this document by
		// (Context reachableClients). The native setter never runs: it would
		// act on the proxy origin, and refuses in a sandboxed frame.
		// The keying is decided now, before the page runs: an origin's first
		// document decides it for the later ones
		void this.client.siteKeyed;
		const domainDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Document.prototype,
			'domain',
		)!;
		const isIP = (host: string) =>
			host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
		Reflect.defineProperty(this.client.global.Document.prototype, 'domain', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				domainDescriptor.get!,
				(target, that: Document, args) => {
					// only side effect this getter has is the potential to throw an illegal invocation error
					Reflect.apply(target, that, args);
					// an opaque origin has no domain
					if (this.client.sandboxedOpaque) return '';
					return this.client.documentDomain ?? this.client.url.url.hostname;
				},
			),
			set: proxyModule.wrapFunction(
				domainDescriptor.set!,
				(target, that: Document, args) => {
					const value = String(args[0]);
					// the effective domain: the host, or what an earlier write set
					const host =
						this.client.documentDomain ?? this.client.url.url.hostname;
					const refuse = (reason: string) =>
						new this.client.global.DOMException(
							`Failed to set the 'domain' property on 'Document': ${reason}`,
							'SecurityError',
						);
					// a sandboxed document never sets it, allow-same-origin or not
					if (this.client.sandboxFlags !== null)
						throw refuse('Assignment is forbidden for sandboxed iframes.');
					if (value === '') throw refuse("'' is an empty domain.");
					let parsed: string | null = null;
					try {
						parsed = new URL(`http://${value}/`).hostname;
					} catch (error) {
						// not a host
					}
					const shown = parsed ?? encodeURI(value);
					if (parsed !== host) {
						if (
							parsed === null ||
							isIP(host) ||
							isIP(parsed) ||
							!host.endsWith(`.${parsed}`)
						)
							throw refuse(`'${shown}' is not a suffix of '${host}'.`);
						// with the list's private section, as Chrome refuses it:
						// 'github.io' is a top-level domain to a page of its customer
						if (getPublicSuffix(parsed) === parsed)
							throw refuse(`'${shown}' is a top-level domain.`);
					}
					if (this.client.siteKeyed) this.client.setDocumentDomain(parsed!);
				},
			),
		});

		// window.originAgentCluster: whether this document's agent cluster is
		// keyed by origin (DocumentClient.siteKeyed), not the proxy origin's
		for (const owner of [
			this.client.global,
			this.client.global.Window.prototype,
		] as object[]) {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				owner,
				'originAgentCluster',
			);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(owner, 'originAgentCluster', {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					Reflect.apply(target, that, args);
					return !this.client.siteKeyed;
				}),
			});
			break;
		}

		/**
		 * Make sure hooks are triggered instead of unhooked elements being generated.
		 * Generation being:
		 * .innerHTML (generates any element)
		 * .outerHTML
		 * .innerText (generates Text)
		 * .outerText
		 * .textContent
		 */

		/**
		 * Text getters can safely be ignored
		 * Scripts and style text should appear to be unhooked
		 */

		const scriptTextDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.HTMLScriptElement.prototype,
			'text',
		)!;

		Reflect.defineProperty(
			this.client.global.HTMLScriptElement.prototype,
			'text',
			{
				enumerable: true,
				configurable: true,
				get: scriptTextDescriptor.get,
				set: proxyModule.wrapFunction(
					scriptTextDescriptor.set!,
					(target, that: HTMLScriptElement, args) => {
						// (the page's Trusted Types: DocumentClient.scriptValue)
						const text = this.client.scriptValue(
							that,
							args[0],
							'HTMLScriptElement text',
							() => Reflect.apply(target, that, args),
						);
						if (text === null || this.client.trustedScriptText(that, text))
							return;
						// snapshot: removing while iterating the live list skips every
						// other node and leaves half the old text in place
						for (const node of [...that.childNodes]) node.remove();

						that.append(
							new this.client.global.Text(
								this.client.prepareScriptText(that, text),
							),
						);
					},
				),
			},
		);

		// An HTML style's markup is its text: the browser parses what
		// innerHTML or setHTMLUnsafe give an HTML <style> as raw text, so it
		// is set as the text, through the insertion hook of DOMContentHooks
		// (applied before this module), which routes text going into a style
		// before it lands
		const hookedAppend = this.client.global.Element.prototype.append;
		const setStyleText = (style: Element, text: string) => {
			usePrototype(style, nativeElement, (element) => {
				for (const node of [...element.childNodes]) node.remove();
			});
			// the empty string leaves no text node, as natively
			if (text !== '') Reflect.apply(hookedAppend, style, [text]);
		};
		// and a Text's `data`, which DOMContentHooks routes in a style
		const hookedDataSet = Reflect.getOwnPropertyDescriptor(
			this.client.global.CharacterData.prototype,
			'data',
		)!.set!;

		const textContentDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Node.prototype,
			'textContent',
		)!;

		// Chrome gives HTMLScriptElement its own `textContent` and `innerText`
		// (the Trusted Types ones), which shadow the hooked accessors of Node
		// and HTMLElement: a connected script's text set through either ran
		// as the page wrote it. Both replace the script's children with the
		// text, as `text` does (an `innerText` with line breaks puts <br>
		// elements between its lines, which are no part of a script's text).
		for (const name of ['textContent', 'innerText'] as const) {
			const own = Reflect.getOwnPropertyDescriptor(
				this.client.global.HTMLScriptElement.prototype,
				name,
			);
			if (!own?.set) continue;
			Reflect.defineProperty(
				this.client.global.HTMLScriptElement.prototype,
				name,
				{
					...own,
					set: proxyModule.wrapFunction(
						own.set,
						(target, that: HTMLScriptElement, args) => {
							if (!isScriptElement(that))
								return Reflect.apply(target, that, args);
							// null is the empty string, which leaves no child
							const text = this.client.scriptValue(
								that,
								args[0],
								`HTMLScriptElement ${name}`,
								() => Reflect.apply(target, that, args),
								(value) => (value === null ? '' : String(value)),
							);
							if (text === null || this.client.trustedScriptText(that, text))
								return;
							usePrototype(that, nativeElement, (element) => {
								for (const node of [...element.childNodes]) node.remove();
							});
							if (text === '') return;
							const lines =
								name === 'innerText' ? text.split(/\r\n|\r|\n/) : [text];
							const nodes: (string | Node)[] = [];
							for (const [index, line] of lines.entries()) {
								if (index)
									nodes.push(this.client.global.document.createElement('br'));
								if (line !== '') nodes.push(line);
							}
							Reflect.apply(hookedAppend, that, nodes);
						},
					),
				},
			);
		}

		Reflect.defineProperty(this.client.global.Node.prototype, 'textContent', {
			enumerable: true,
			configurable: true,
			get: textContentDescriptor.get,
			set: proxyModule.wrapFunction(
				textContentDescriptor.set!,
				(target, that: Node, args) => {
					// only elements and fragments have children to hook (and an
					// `append`); YouTube sets textContent on Text nodes, which is
					// their data (null the empty string)
					if (that.nodeType !== 1 && that.nodeType !== 11)
						return this.client.styleOfText(that)
							? Reflect.apply(hookedDataSet, that, [
									args[0] === null ? '' : String(args[0]),
								])
							: Reflect.apply(target, that, args);

					for (const node of [...that.childNodes]) node.remove();

					// null is the empty string, which leaves no text node, as
					// natively (it left a text node reading "null")
					const written = args[0] === null ? '' : String(args[0]);
					if (written === '') return;
					// a script's text set while it is connected runs at once
					const text =
						that instanceof this.client.global.HTMLScriptElement
							? this.client.prepareScriptText(that, written)
							: written;
					(that as Element).append(new this.client.global.Text(text));
				},
			),
		});

		const innerTextDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.HTMLElement.prototype,
			'innerText',
		)!;

		Reflect.defineProperty(
			this.client.global.HTMLElement.prototype,
			'innerText',
			{
				enumerable: true,
				configurable: true,
				get: innerTextDescriptor.get,
				set: proxyModule.wrapFunction(
					innerTextDescriptor.set!,
					(target, that: Element, args) => {
						// snapshot: removing while iterating the live list skips every
						// other node and leaves half the old text in place
						for (const node of [...that.childNodes]) node.remove();

						// as the browser builds it: null is the empty string, which
						// leaves nothing, and each line break is a <br> between
						// the text of the lines
						const text = args[0] === null ? '' : String(args[0]);
						if (text === '') return;
						const nodes: Node[] = [];
						for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
							if (index)
								nodes.push(this.client.global.document.createElement('br'));
							if (line !== '') nodes.push(new this.client.global.Text(line));
						}
						that.append(...nodes);
					},
				),
			},
		);

		const outerTextDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.HTMLElement.prototype,
			'outerText',
		)!;

		Reflect.defineProperty(
			this.client.global.HTMLElement.prototype,
			'outerText',
			{
				enumerable: true,
				configurable: true,
				get: outerTextDescriptor.get,
				set: proxyModule.wrapFunction(
					outerTextDescriptor.set!,
					(target, that: Element, args) => {
						that.replaceWith(new this.client.global.Text(args[0]));
					},
				),
			},
		);

		/**
		 * inner and outer HTML need to have their getters hooked
		 * this will reveal hooked attributes etc
		 *
		 * Element.prototype.getInnerHTML
		 */

		if ('getInnerHTML' in this.client.global.Element.prototype) {
			(this.client.global.Element.prototype as any).getInnerHTML =
				proxyModule.wrapFunction(
					(this.client.global.Element.prototype as any)
						.getInnerHTML as () => string,
					(target, that) => {
						return that.innerHTML;
					},
				);
		}

		const innerHTMLDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Element.prototype,
			'innerHTML',
		)!;

		Reflect.defineProperty(this.client.global.Element.prototype, 'innerHTML', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				innerHTMLDescriptor.get!,
				(target, that: Element) => this.serializeOriginal(that, false),
			),
			set: proxyModule.wrapFunction(
				innerHTMLDescriptor.set!,
				(target, that: Element, args) => {
					// null is the empty string ([LegacyNullToEmptyString]), after the
					// page's Trusted Types judged it
					const markup = this.client.trustedValue(
						args[0],
						'TrustedHTML',
						'Element innerHTML',
						() => Reflect.apply(target, that, args),
						htmlString,
					);
					if (markup === null) return;
					const kind = this.client.styleKind(that);
					if (kind === 'html') return setStyleText(that, markup);
					// an SVG <style> parses its markup as markup (measured: an
					// element in it stays one); what it makes goes in through the
					// insertion hook, which routes the text going into a style
					if (kind === 'svg') {
						const nodes = cloneRawNode(
							parseHTMLFragmentIn(markup, that, this.client.global.document),
							this.client.global.document,
						);
						usePrototype(that, nativeElement, (element) => {
							for (const node of [...element.childNodes]) node.remove();
						});
						Reflect.apply(hookedAppend, that, [nodes]);
						return;
					}
					usePrototype(that, nativeElement, (element) => {
						if (isHTMLTemplate(that))
							usePrototype(that, nativeHTMLTemplateElement, (element) => {
								// snapshot: removing while iterating the live list skips
								// every other node and leaves it next to the new markup
								for (const node of [...element.content.childNodes])
									node.remove();

								// made in the content's own inert document, as the
								// browser parses it (in the template's context): nothing
								// in it is constructed
								element.content.append(
									cloneRawNode(
										parseHTMLFragmentIn(
											markup,
											that,
											this.client.global.document,
										),
										templateContentDocument(element),
									),
								);
							});
						else {
							for (const node of [...element.childNodes]) node.remove();

							if (isScriptElement(that)) {
								// a script's markup is its text (an HTML script's as it
								// is written, an SVG script's parsed), and a connected
								// script that has not run runs it: it goes in through
								// the insertion hook, which rewrites what will run
								const nodes =
									element.nodeName === 'SCRIPT'
										? markup
										: cloneRawNode(
												parseHTMLFragmentIn(
													markup,
													that,
													this.client.global.document,
												),
												this.client.global.document,
											);
								if (nodes !== '') Reflect.apply(hookedAppend, that, [nodes]);
							} else {
								// parsed in the element's context, as the browser does:
								// a table section's rows, an <svg>'s SVG, a <textarea>'s
								// text
								element.append(
									cloneRawNode(
										parseHTMLFragmentIn(
											markup,
											that,
											this.client.global.document,
										),
										this.client.global.document,
									),
								);
							}
						}
					});
					// a frame in the markup is injected as it connects
					this.client.sweepFrames?.();
				},
			),
		});

		const outerHTMLDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Element.prototype,
			'outerHTML',
		)!;

		Reflect.defineProperty(this.client.global.Element.prototype, 'outerHTML', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				outerHTMLDescriptor.get!,
				(target, that: Element) => this.serializeOriginal(that, true),
			),
			set: proxyModule.wrapFunction(
				outerHTMLDescriptor.set!,
				(target, that: Element, args) => {
					// (the page's Trusted Types judge the markup first; a style's
					// stand-in writes the inject's own)
					const markup = ownScripts.has(that)
						? htmlString(args[0])
						: this.client.trustedValue(
								args[0],
								'TrustedHTML',
								'Element outerHTML',
								() => Reflect.apply(target, that, args),
								htmlString,
							);
					if (markup === null) return;
					// as the browser: nothing without a parent, an error under the
					// document, and the markup parsed in the parent's context (a
					// fragment's is the body's)
					const parent = usePrototype(
						that,
						nativeNode,
						(node) => node.parentNode,
					);
					if (parent === null) return;
					const parentType = usePrototype(
						parent,
						nativeNode,
						(node) => node.nodeType,
					);
					if (parentType === 9)
						throw new this.client.global.DOMException(
							"Failed to set the 'outerHTML' property on 'Element': This element's parent is a Document, which may not be modified.",
							'NoModificationAllowedError',
						);
					that.replaceWith(
						cloneRawNode(
							parseHTMLFragmentIn(
								markup,
								parentType === 1 ? (parent as Element) : null,
								this.client.global.document,
							),
							this.client.global.document,
						),
					);
				},
			),
		});

		// markup the browser parses itself (setHTMLUnsafe, where a
		// `<template shadowrootmode>` becomes a shadow root only in the real
		// parser; a shadow root's innerHTML): our parser rewrites it first and
		// hands over the serialisation, markers included. The fragment parser
		// never runs a script, so none is rewritten here. The copy is made in
		// an inert document (see inertDocumentOf).
		const rewriteMarkup = (
			markup: unknown,
			context: Element | null,
		): string => {
			const inert = inertDocumentOf(this.client.global.document);
			const div = inert.createElement('div');
			// parsed in the context the browser parses it in next, so the
			// serialisation keeps what that context keeps (a section's rows)
			div.append(
				cloneRawNode(
					parseHTMLFragmentIn(
						String(markup),
						context,
						this.client.global.document,
					),
					inert,
				),
			);
			const html = this.client.innerHTMLOf(div);
			releaseMarkup(div);
			return html;
		};
		// execCommand edits the document from inside the browser: the markup
		// of insertHTML is parsed and inserted with no hook in the way (an
		// `<img onerror>` in it ran as the page wrote it, a srcdoc frame in it
		// loaded with no inject), insertImage makes an image of a URL and
		// createLink a link. The markup is rewritten first, as for
		// setHTMLUnsafe; an image is inserted as its markup, which is what the
		// command makes; a link's URL is routed, and the links the command
		// made are then given the URL through the hook, which keeps what the
		// page wrote for it to read back.
		const nativeExecCommand = this.client.global.Document.prototype.execCommand;
		if (typeof nativeExecCommand === 'function') {
			const nativeGetSelection =
				this.client.global.Document.prototype.getSelection;
			const nativeQuerySelectorAll =
				this.client.global.Document.prototype.querySelectorAll;
			// the element the selection starts in: the context the browser
			// parses inserted markup in
			const editingContext = (document: Document): Element | null => {
				try {
					const selection = Reflect.apply(
						nativeGetSelection,
						document,
						[],
					) as Selection | null;
					if (!selection || selection.rangeCount === 0) return null;
					const start = selection.getRangeAt(0).startContainer;
					return usePrototype(start, nativeNode, (node) =>
						node.nodeType === 1 ? (node as Element) : node.parentElement,
					);
				} catch (error) {
					return null;
				}
			};
			const escapeAttribute = (value: string) =>
				value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
			this.client.global.Document.prototype.execCommand =
				proxyModule.wrapFunction(nativeExecCommand, (target, that, args) => {
					const command = String(args[0]).toLowerCase();
					if (args.length < 3 || args[2] === undefined || args[2] === null)
						return Reflect.apply(target, that, args);
					let made: string | null = null;
					if (command === 'inserthtml') {
						// (the page's Trusted Types judge the markup first)
						const value = this.client.trustedValue(
							args[2],
							'TrustedHTML',
							'Document execCommand',
							() => Reflect.apply(target, that, args),
						);
						if (value === null) return false;
						args[2] = trustedHTML(rewriteMarkup(value, editingContext(that)));
						const result = Reflect.apply(target, that, args);
						this.client.sweepFrames?.();
						return result;
					}
					const value = String(args[2]);
					if (command === 'insertimage' && value !== '') {
						args[0] = 'insertHTML';
						args[2] = trustedHTML(
							rewriteMarkup(
								`<img src="${escapeAttribute(value)}">`,
								editingContext(that),
							),
						);
					} else if (command === 'createlink' && value !== '') {
						try {
							made = routeHTML(
								new StompURL(
									new URL(value, this.client.baseURL.toString()),
									this.client.baseURL,
								),
								this.client.baseURL,
								this.client.config,
								false,
								this.client.nestedRoute,
							);
							args[2] = made;
						} catch (error) {
							// no URL: the link is made of it as it is
						}
					} else return Reflect.apply(target, that, args);
					const result = Reflect.apply(target, that, args);
					if (made !== null)
						for (const link of [
							...(Reflect.apply(nativeQuerySelectorAll, that, [
								'a[href]',
							]) as NodeListOf<Element>),
						])
							// the ones the command made: the routed URL, and no record
							// of what the page wrote
							if (
								usePrototype(
									link,
									CustomElement.prototype,
									(element) =>
										element.getAttribute('href') === made &&
										!element.hasAttributeOG('href'),
								)
							)
								link.setAttribute('href', value);
					this.client.sweepFrames?.();
					return result;
				});
		}
		// Range.createContextualFragment parses in the page's document, so an
		// element in the fragment starts its load as it is parsed, inserted or
		// not: the page's raw URLs went straight to the site, or unrouted to
		// the proxy origin. The markup is parsed by the browser in an inert
		// document instead, in a context element of the range's kind (a <tr>
		// for a table section parses as one), and the nodes are made in the
		// page's document through the hooks. Scripts in it run when the page
		// inserts them, rewritten then, as natively.
		const RangeProto = this.client.global.Range?.prototype;
		if (typeof RangeProto?.createContextualFragment === 'function')
			RangeProto.createContextualFragment = proxyModule.wrapFunction(
				RangeProto.createContextualFragment,
				(target, that: Range, args) => {
					if (!args.length) return Reflect.apply(target, that, args);
					// (the page's Trusted Types judge the markup first)
					const markup = this.client.trustedValue(
						args[0],
						'TrustedHTML',
						'Range createContextualFragment',
						() => Reflect.apply(target, that, args),
					);
					if (markup === null) return;
					const start = that.startContainer;
					const owner = (
						start.nodeType === 9 ? start : start.ownerDocument
					) as Document;
					const inert = inertDocumentOf(owner);
					// the context element, as the spec picks it: the start node
					// if it is an element, else its parent element; none for a
					// document or fragment
					const element =
						start.nodeType === 1
							? (start as Element)
							: start.parentNode?.nodeType === 1
								? (start.parentNode as Element)
								: null;
					const holder = element
						? inert.createElementNS(element.namespaceURI, element.localName)
						: inert.createElement('body');
					const range = inert.createRange();
					range.selectNodeContents(holder);
					const parsed = Reflect.apply(target, range, [
						trustedHTML(markup),
					]) as DocumentFragment;
					const fragment = owner.createDocumentFragment();
					fragment.append(cloneRawNode([...parsed.childNodes], owner));
					// its scripts are the parser's, which run as they are
					this.client.parsedScripts(fragment);
					return fragment;
				},
			);
		const hookedInnerHTMLSet = Reflect.getOwnPropertyDescriptor(
			this.client.global.Element.prototype,
			'innerHTML',
		)!.set!;
		const shadowRootPrototype = (
			this.client.global as { ShadowRoot?: typeof ShadowRoot }
		).ShadowRoot?.prototype;
		for (const proto of [
			this.client.global.Element.prototype,
			shadowRootPrototype,
		]) {
			const native = (proto as { setHTMLUnsafe?: unknown } | undefined)
				?.setHTMLUnsafe;
			if (typeof native !== 'function') continue;
			(proto as { setHTMLUnsafe: unknown }).setHTMLUnsafe =
				proxyModule.wrapFunction(
					native as (html: string) => void,
					(target, that, args) => {
						if (args.length) {
							// (the page's Trusted Types judge the markup first; what goes
							// on is the inject's, trusted)
							const markup = this.client.trustedValue(
								args[0],
								'TrustedHTML',
								`${(that as Node).nodeType === 1 ? 'Element' : 'ShadowRoot'} setHTMLUnsafe`,
								() => Reflect.apply(target, that, args),
							);
							if (markup === null) return;
							args[0] = trustedHTML(markup);
						}
						const kind = args.length ? this.client.styleKind(that) : null;
						if (kind === 'html')
							return setStyleText(that as Element, String(args[0]));
						// an SVG <style>'s markup is markup, its text routed as it
						// goes in, which the native call would not (no declarative
						// shadow root is made in a style)
						if (kind === 'svg')
							return Reflect.apply(hookedInnerHTMLSet, that, [args[0]]);
						// and a script's markup is its text, which a connected
						// script runs: rewritten as it goes in, by the same setter
						if (args.length && isScriptElement(that))
							return Reflect.apply(hookedInnerHTMLSet, that, [args[0]]);
						if (args.length)
							args[0] = trustedHTML(
								rewriteMarkup(
									args[0],
									(that as Node).nodeType === 1
										? (that as Element)
										: ((that as ShadowRoot).host ?? null),
								),
							);
						const result = Reflect.apply(target, that, args);
						this.client.sweepFrames?.();
						return result;
					},
				);
		}
		// setHTML is the setter that sanitizes: the browser parses the markup
		// in the element's context and keeps what its sanitizer allows. On the
		// page's own element that leaves nodes as the page wrote them (a link
		// to the address in the markup, where the proxy's own origin answers),
		// and rewriting the markup first would hand the sanitizer attributes
		// it drops. So the browser sanitizes into a copy of the element in the
		// inert document, where nothing loads, and what it leaves goes in
		// through the insertion hook, like the nodes of any other parser.
		const elementSetHTML = (
			this.client.global.Element.prototype as { setHTML?: unknown }
		).setHTML;
		const shadowHost =
			shadowRootPrototype &&
			Reflect.getOwnPropertyDescriptor(shadowRootPrototype, 'host')?.get;
		const contentOf = Reflect.getOwnPropertyDescriptor(
			this.client.global.HTMLTemplateElement.prototype,
			'content',
		)!.get!;
		const importNode = this.client.global.Document.prototype.importNode;
		const hookedReplaceChildren = {
			element: this.client.global.Element.prototype.replaceChildren,
			fragment: this.client.global.DocumentFragment.prototype.replaceChildren,
		};
		const hookedTextContent = Reflect.getOwnPropertyDescriptor(
			this.client.global.Node.prototype,
			'textContent',
		)!;
		for (const proto of [
			this.client.global.Element.prototype,
			shadowRootPrototype,
		]) {
			const native = (proto as { setHTML?: unknown } | undefined)?.setHTML;
			if (typeof native !== 'function' || typeof elementSetHTML !== 'function')
				continue;
			const ofShadow = proto === shadowRootPrototype;
			(proto as unknown as { setHTML: unknown }).setHTML =
				proxyModule.wrapFunction(
					native as (html: string, options?: unknown) => void,
					(target, that, args) => {
						// the element whose context the markup is parsed in: a shadow
						// root's host, or the element itself
						let context: Element | null = null;
						try {
							if (ofShadow)
								context = Reflect.apply(shadowHost!, that, []) as Element;
							else if (isScriptElement(that))
								// the browser leaves a script as it is
								context = null;
							else if ((that as Node).nodeType === 1) context = that as Element;
						} catch (error) {
							// no shadow root: the native call throws what the browser does
						}
						if (!context || !args.length)
							return Reflect.apply(target, that, args);
						const shell = Reflect.apply(
							importNode,
							inertDocumentOf(this.client.global.document),
							[context, false],
						) as Element;
						// (a sanitizer the browser refuses throws here, as natively)
						Reflect.apply(elementSetHTML, shell, args);
						const kind = ofShadow ? null : this.client.styleKind(that);
						if (kind) {
							// a style's markup is its text, which is routed as it goes in
							const text = String(
								Reflect.apply(hookedTextContent.get!, shell, []) ?? '',
							);
							if (kind === 'html') setStyleText(that as Element, text);
							else Reflect.apply(hookedTextContent.set!, that, [text]);
							return;
						}
						// a template's markup is its content's
						const template = !ofShadow && isHTMLTemplate(that);
						const left = template
							? (Reflect.apply(contentOf, shell, []) as DocumentFragment)
							: shell;
						Reflect.apply(
							ofShadow || template
								? hookedReplaceChildren.fragment
								: hookedReplaceChildren.element,
							template ? Reflect.apply(contentOf, that, []) : that,
							[...left.childNodes],
						);
						// a frame the sanitizer was told to keep is injected as it connects
						this.client.sweepFrames?.();
					},
				);
		}
		const shadowInnerHTML =
			shadowRootPrototype &&
			Reflect.getOwnPropertyDescriptor(shadowRootPrototype, 'innerHTML');
		if (shadowRootPrototype && shadowInnerHTML?.get && shadowInnerHTML.set)
			Reflect.defineProperty(shadowRootPrototype, 'innerHTML', {
				...shadowInnerHTML,
				get: proxyModule.wrapFunction(
					shadowInnerHTML.get,
					(target, that: ShadowRoot) => {
						// as the page wrote it: the children copied under an element
						// of the inert document (see inertCopy) and their markers
						// folded back
						const div = this.inertCopy(
							this.client.global.document.createElement('div'),
						);
						for (const child of that.childNodes)
							div.append(this.inertCopy(child));
						const html = this.serializeOriginal(div, false);
						releaseMarkup(div);
						return html;
					},
				),
				set: proxyModule.wrapFunction(
					shadowInnerHTML.set,
					(target, that: ShadowRoot, args) => {
						const markup = this.client.trustedValue(
							args[0],
							'TrustedHTML',
							'ShadowRoot innerHTML',
							() => Reflect.apply(target, that, args),
							htmlString,
						);
						if (markup === null) return;
						Reflect.apply(target, that, [
							trustedHTML(rewriteMarkup(markup, that.host ?? null)),
						]);
						this.client.sweepFrames?.();
					},
				),
			});

		// the null namespace is the attribute itself: the page's value
		this.client.global.Element.prototype.getAttributeNS =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.getAttributeNS,
				(target, that: Element, args) => {
					if (args.length >= 2 && (args[0] === null || args[0] === ''))
						return that.getAttribute(String(args[1]));
					// a namespaced attribute a hook rewrote (xlink:href): the page's
					// value, by the attribute's qualified name, or by the xlink prefix
					// while a load's copy is on its way and the attribute is gone
					const value = Reflect.apply(target, that, args);
					if (args.length < 2 || !(that instanceof this.client.global.Element))
						return value;
					const node = Reflect.apply(
						nativeElement.getAttributeNodeNS,
						that,
						args.slice(0, 2),
					) as Attr | null;
					const name =
						node?.name ??
						(args[0] === XLINK_NAMESPACE ? `xlink:${args[1]}` : null);
					if (name === null) return value;
					return usePrototype(that, CustomElement.prototype, (element) =>
						element.hasAttributeOG(name) ? element.getAttributeOG(name) : value,
					);
				},
			);

		this.client.global.Element.prototype.getAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.getAttribute,
				(target, that: Element, args) => {
					// only side effect this getter has is the potential to throw an illegal invocation error
					Reflect.apply(target, that, args);

					const attribute = attributeName(that, String(args[0]));
					if (isMarker(attribute)) return null;

					// no hook is working on the element: the DOM is the hooks'
					// view, read natively without a prototype swap
					if (!pendingAttributes(that)) {
						const marker = ORIGINAL_ATTRIBUTE + attribute;
						if (nativeElement.hasAttribute.call(that, marker))
							return nativeElement.getAttribute.call(that, marker);
						const value = nativeElement.getAttribute.call(that, attribute);
						return attribute === 'style' && typeof value === 'string'
							? unrouteCSS(this.client, value, true)
							: value;
					}

					return usePrototype(that, CustomElement.prototype, (element) => {
						if (element.hasAttributeOG(attribute)) {
							return element.getAttributeOG(attribute);
						}
						const value = element.getAttribute(attribute);
						// a style the browser serialised from a CSSOM write carries no
						// marker: its routed url()s read as the browser serialises
						// the page's
						return attribute === 'style' && typeof value === 'string'
							? unrouteCSS(this.client, value, true)
							: value;
					});
				},
			);

		// What the page reads back must be what it wrote: the marker attributes
		// (`s_o:*`) never show, values come from the markers, and markup is
		// serialised from a copy with the markers folded back in.
		const isMarker = (name: unknown) =>
			typeof name === 'string' && name.startsWith(ORIGINAL_ATTRIBUTE);
		// the name a call acts on is lowercased on an HTML element, so
		// `S_O:HREF` names a marker there too
		const isMarkerOn = (element: unknown, name: unknown) =>
			typeof name === 'string' && isMarker(attributeName(element, name));

		this.client.global.Element.prototype.hasAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.hasAttribute,
				(target, that, args) => {
					const native = Reflect.apply(target, that, args);
					if (isMarkerOn(that, args[0])) return false;
					// an attribute a hook dropped (iframe sandbox, an object's data)
					// is still there for the page
					if (native) return native;
					const attribute = attributeName(that, String(args[0]));
					if (!pendingAttributes(that))
						return nativeElement.hasAttribute.call(
							that,
							ORIGINAL_ATTRIBUTE + attribute,
						);
					return usePrototype(that, CustomElement.prototype, (element) =>
						element.hasAttributeOG(attribute),
					);
				},
			);

		this.client.global.Element.prototype.getAttributeNode =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.getAttributeNode,
				(target, that, args) => {
					const node = Reflect.apply(target, that, args);
					return isMarkerOn(that, args[0]) ? null : node;
				},
			);

		/**
		 * The attribute names in the order the page sees them: a marker stands
		 * where the page wrote an attribute a hook then dropped (it is written
		 * in the attribute's place), and is hidden where the attribute stayed.
		 * An attribute after its marker was dropped and set again (a load's
		 * copy in a document no worker controls): it stands at the marker's
		 * place too.
		 */
		const visibleNames = (names: string[]): string[] => {
			const result: string[] = [];
			names.forEach((name, index) => {
				if (!isMarker(name)) {
					const marker = names.indexOf(`${ORIGINAL_ATTRIBUTE}${name}`);
					if (marker === -1 || marker > index) result.push(name);
				} else {
					const base = names.indexOf(name.slice(ORIGINAL_ATTRIBUTE.length));
					if (base === -1 || base > index)
						result.push(name.slice(ORIGINAL_ATTRIBUTE.length));
				}
			});
			return result;
		};

		this.client.global.Element.prototype.getAttributeNames =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.getAttributeNames,
				(target, that, args) =>
					visibleNames(Reflect.apply(target, that, args) as string[]),
			);

		// Attr.value: the page's value when the element keeps one for it, and
		// a style the CSSOM wrote as getAttribute reads it
		const attrValue = (attr: Attr, native: string | null) => {
			const owner = attr.ownerElement;
			if (!owner) return native;
			return usePrototype(owner, CustomElement.prototype, (element) =>
				element.hasAttributeOG(attr.name)
					? element.getAttributeOG(attr.name)
					: attr.name === 'style' && typeof native === 'string'
						? unrouteCSS(this.client, native, true)
						: native,
			);
		};
		for (const [proto, property] of [
			[this.client.global.Attr.prototype, 'value'],
			[this.client.global.Node.prototype, 'nodeValue'],
			[this.client.global.Node.prototype, 'textContent'],
		] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, property)!;
			Reflect.defineProperty(proto, property, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get!, (target, that, args) => {
					const native = Reflect.apply(target, that, args);
					return that instanceof this.client.global.Attr
						? attrValue(that, native)
						: native;
				}),
				// writing an attribute node is writing the attribute: through the
				// owner's hooked setAttribute, so src, on* and srcdoc are rewritten
				set: proxyModule.wrapFunction(descriptor.set!, (target, that, args) => {
					if (that instanceof this.client.global.Attr && that.ownerElement) {
						that.ownerElement.setAttribute(that.name, String(args[0]));
						return;
					}
					return Reflect.apply(target, that, args);
				}),
			});
		}

		// Element.attributes: a view of the map without the markers
		const attributeMaps = new WeakMap<NamedNodeMap, NamedNodeMap>();
		/** the element's hooked setAttributeNode and setAttributeNodeNS, once they are wrapped below */
		const setNamedItems: {
			setAttributeNode?: Element['setAttributeNode'];
			setAttributeNodeNS?: Element['setAttributeNodeNS'];
		} = {};
		const standIns = new WeakMap<Attr, Attr>();
		const nativeCreateAttribute =
			this.client.global.Document.prototype.createAttribute;
		const nativeOwnerDocument = Reflect.getOwnPropertyDescriptor(
			this.client.global.Node.prototype,
			'ownerDocument',
		)!.get!;
		const attributesDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Element.prototype,
			'attributes',
		)!;
		Reflect.defineProperty(this.client.global.Element.prototype, 'attributes', {
			...attributesDescriptor,
			get: proxyModule.wrapFunction(
				attributesDescriptor.get!,
				(target, that, args) => {
					const map: NamedNodeMap = Reflect.apply(target, that, args);
					if (!attributeMaps.has(map)) {
						const owner = that as Element;
						// an attribute a hook dropped is still the page's: a detached
						// Attr with its name and value stands in, where it was written
						const visible = () => {
							const all = [...map];
							const names = all.map((attr) => attr.name);
							const result: Attr[] = [];
							for (const attr of all) {
								if (!isMarker(attr.name)) {
									result.push(attr);
									continue;
								}
								const base = attr.name.slice(ORIGINAL_ATTRIBUTE.length);
								if (names.includes(base)) continue;
								let standIn = standIns.get(attr);
								if (!standIn) {
									standIn = Reflect.apply(
										nativeCreateAttribute,
										Reflect.apply(nativeOwnerDocument, owner, []),
										[base],
									) as Attr;
									standIns.set(attr, standIn);
								}
								standIn.value = attr.value;
								result.push(standIn);
							}
							return result;
						};
						const named = (name: string) =>
							visible().find((attr) => attr.name === name);
						attributeMaps.set(
							map,
							new Proxy(map, {
								get: (map, key) => {
									if (key === 'length') return visible().length;
									if (typeof key === 'string' && /^\d+$/.test(key))
										return visible()[Number(key)];
									if (key === 'item')
										return (index: number) => visible()[index] ?? null;
									if (key === 'getNamedItem')
										return (name: string) =>
											isMarkerOn(owner, name)
												? null
												: (map.getNamedItem(name) ??
													named(attributeName(owner, String(name))) ??
													null);
									// an attribute node set through the map is set on the
									// element: through its hooks, so what it loads is routed
									if (key === 'setNamedItem' || key === 'setNamedItemNS') {
										const set =
											setNamedItems[
												key === 'setNamedItem'
													? 'setAttributeNode'
													: 'setAttributeNodeNS'
											];
										if (set)
											return (...args: unknown[]) => {
												// the browser's own errors (no argument, not an
												// Attr, a node in use) name the map's method
												const attr = args[0];
												if (
													!(attr instanceof this.client.global.Attr) ||
													(attr.ownerElement && attr.ownerElement !== owner)
												)
													return Reflect.apply(
														Reflect.get(map, key) as Function,
														map,
														args,
													);
												return Reflect.apply(set, owner, args);
											};
									}
									if (key === Symbol.iterator)
										return function* () {
											yield* visible();
										};
									if (typeof key === 'string' && isMarker(key))
										return undefined;
									const value = Reflect.get(map, key);
									if (value === undefined && typeof key === 'string')
										return named(key);
									return typeof value === 'function' ? value.bind(map) : value;
								},
								has: (map, key) =>
									typeof key === 'string' && /^\d+$/.test(key)
										? Number(key) < visible().length
										: typeof key === 'string' && isMarker(key)
											? false
											: Reflect.has(map, key) ||
												(typeof key === 'string' && !!named(key)),
								ownKeys: (map) => [
									...visible().map((_, i) => String(i)),
									...Reflect.ownKeys(map).filter(
										(key) =>
											typeof key !== 'string' ||
											(!/^\d+$/.test(key) && !isMarker(key)),
									),
								],
							}),
						);
					}
					return attributeMaps.get(map)!;
				},
			),
		});

		// markup as the page wrote it: a copy with every marker folded back,
		// template contents included (their elements are not descendants)
		const nativeQueryAll = {
			element: nativeElement.querySelectorAll,
			document: this.client.global.Document.prototype.querySelectorAll,
			fragment: this.client.global.DocumentFragment.prototype.querySelectorAll,
		};
		const querySelectorAllOf = (root: Node): Element[] => {
			const native =
				root.nodeType === 1
					? nativeQueryAll.element
					: root.nodeType === 9
						? nativeQueryAll.document
						: root.nodeType === 11
							? nativeQueryAll.fragment
							: null;
			if (!native) return [];
			try {
				return [...(Reflect.apply(native, root, ['*']) as NodeListOf<Element>)];
			} catch (error) {
				return [];
			}
		};
		const templateContent = Reflect.getOwnPropertyDescriptor(
			this.client.global.HTMLTemplateElement.prototype,
			'content',
		)!.get!;
		const foldMarkers = (root: Node) => {
			const queue: Node[] = [root];
			while (queue.length) {
				const current = queue.pop()!;
				const elements =
					current.nodeType === 1
						? [current as Element, ...querySelectorAllOf(current)]
						: querySelectorAllOf(current);
				for (const node of elements)
					usePrototype(node, nativeElement, (node) => {
						const names = node.getAttributeNames();
						let dropped = false;
						for (const name of names)
							if (isMarker(name)) {
								const base = name.slice(ORIGINAL_ATTRIBUTE.length);
								const at = names.indexOf(base);
								if (at === -1 || at > names.indexOf(name)) dropped = true;
								node.setAttribute(base, node.getAttribute(name)!);
								node.removeAttribute(name);
							}
						// an attribute a hook dropped was set again at the end: every
						// attribute goes back to the order the page wrote them in
						if (dropped)
							for (const name of visibleNames(names)) {
								const attr = node.getAttributeNode(name);
								if (!attr) continue;
								node.removeAttributeNode(attr);
								node.setAttributeNode(attr);
							}
						if (isHTMLTemplate(node))
							queue.push(Reflect.apply(templateContent, node, []));
					});
			}
		};
		// A copy to fold the markers on and serialize, in a document of its own
		// with no window: there nothing loads or runs, where a copy in the
		// page's document would fetch every image and media source the fold
		// puts back (the page's raw URLs, past the proxy). HTML markup in an
		// HTML document, XML (an SVG, an XHTML page) in an XML one, so it
		// serializes as before.
		const nativeImportNode = this.client.global.Document.prototype.importNode;
		const nativeContentType = Reflect.getOwnPropertyDescriptor(
			this.client.global.Document.prototype,
			'contentType',
		)!.get!;
		const implementation = this.client.global.document.implementation;
		const inertDocuments: { html?: Document; xml?: Document } = {};
		const inertDocumentFor = (node: Node) => {
			const owner = (
				node.nodeType === 9 ? node : node.ownerDocument
			) as Document | null;
			const html =
				!owner || Reflect.apply(nativeContentType, owner, []) === 'text/html';
			return html
				? (inertDocuments.html ??= Reflect.apply(
						this.client.global.DOMImplementation.prototype.createHTMLDocument,
						implementation,
						[''],
					) as Document)
				: (inertDocuments.xml ??= Reflect.apply(
						this.client.global.DOMImplementation.prototype.createDocument,
						implementation,
						[null, null, null],
					) as Document);
		};
		const inertCopy = <T extends Node>(node: T): T =>
			Reflect.apply(nativeImportNode, inertDocumentFor(node), [
				node,
				true,
			]) as T;
		this.inertCopy = inertCopy;
		const serializeOriginal = (element: Element, outer: boolean): string =>
			usePrototype(element, nativeElement, (native) => {
				const clone = inertCopy(native);
				foldMarkers(clone);
				const html = usePrototype(clone, nativeElement, (clone) =>
					outer ? clone.outerHTML : clone.innerHTML,
				);
				// a copy only to be serialized (see releaseMarkup)
				releaseMarkup(clone);
				return html;
			});
		this.serializeOriginal = serializeOriginal;

		// getHTML: the browser's own serializer on a folded copy in the inert
		// document (see inertCopy), with a copy of each shadow root it could
		// serialize (open and serializable, or one the page lists) attached to
		// the copy of its host as the root is, its markers folded too; the
		// native call gets the page's options with the copies of the roots it
		// listed, so it decides what to include as it would on the page's own
		type ShadowOptions = {
			serializableShadowRoots?: boolean;
			shadowRoots?: ShadowRoot[];
		};
		const copyWithShadows = <T extends Element | DocumentFragment>(
			node: T,
			options: ShadowOptions,
			// the copies of the roots the page listed, for the native call
			listed: ShadowRoot[],
			// every copy and shadow root made, to let go of after (releaseMarkup)
			made: Node[],
		): T =>
			usePrototype(node, nativeNode, (native) => {
				const copy = inertCopy(native) as T;
				made.push(copy);
				const originals: Node[] = [
					...(native.nodeType === 1 ? [native] : []),
					...querySelectorAllOf(native),
				];
				const copies: Node[] = [
					...(copy.nodeType === 1 ? [copy] : []),
					...querySelectorAllOf(copy),
				];
				originals.forEach((original, index) => {
					const host = original as Element;
					const root =
						host.shadowRoot ??
						options.shadowRoots?.find((root) => root.host === host) ??
						null;
					if (
						!root ||
						!(
							(options.serializableShadowRoots && root.serializable) ||
							options.shadowRoots?.includes(root)
						)
					)
						return;
					// the root as it is: the browser decides from these, as it would
					// from the page's own
					const shadow = (copies[index] as Element).attachShadow({
						mode: root.mode,
						serializable: root.serializable,
						clonable: root.clonable,
						delegatesFocus: root.delegatesFocus,
					});
					if (options.shadowRoots?.includes(root)) listed.push(shadow);
					made.push(shadow);
					for (const child of root.childNodes)
						shadow.append(
							child.nodeType === 1
								? copyWithShadows(child as Element, options, listed, made)
								: inertCopy(child),
						);
					foldMarkers(shadow);
				});
				foldMarkers(copy);
				return copy;
			});
		this.foldMarkup = (html: string): string => html;
		const elementGetHTML = (
			this.client.global.Element.prototype as { getHTML?: unknown }
		).getHTML as ((options?: ShadowOptions) => string) | undefined;
		for (const proto of [
			this.client.global.Element.prototype,
			(this.client.global as { ShadowRoot?: typeof ShadowRoot }).ShadowRoot
				?.prototype,
		]) {
			const getHTML = (proto as { getHTML?: unknown } | undefined)?.getHTML;
			if (typeof getHTML !== 'function') continue;
			(proto as { getHTML: unknown }).getHTML = proxyModule.wrapFunction(
				getHTML as (options?: ShadowOptions) => string,
				(target, that, args) => {
					const options = (args[0] ?? {}) as ShadowOptions;
					// the page's options, with the copies of the roots it listed
					const listed: ShadowRoot[] = [];
					const call = () => [
						{
							serializableShadowRoots: !!options.serializableShadowRoots,
							shadowRoots: listed,
						},
					];
					// every copy made, the shadow roots' too, for releaseMarkup
					const made: Node[] = [];
					if (that instanceof this.client.global.Element) {
						const copy = copyWithShadows(that, options, listed, made);
						const html = Reflect.apply(target, copy, call()) as string;
						for (const node of made) releaseMarkup(node);
						return this.foldMarkup(html);
					}
					// a shadow root cannot be copied: its children are, under a
					// holder in the inert document, serialized as the root's
					const holder = inertCopy(
						this.client.global.document.createElement('div'),
					);
					for (const child of (that as ShadowRoot).childNodes)
						holder.append(
							child.nodeType === 1
								? copyWithShadows(child as Element, options, listed, made)
								: inertCopy(child),
						);
					foldMarkers(holder);
					const html = Reflect.apply(elementGetHTML!, holder, call()) as string;
					releaseMarkup(holder);
					for (const node of made) releaseMarkup(node);
					return this.foldMarkup(html);
				},
			);
		}

		// XMLSerializer: the same folded copy, serialised as XML
		const serializeToString =
			this.client.global.XMLSerializer.prototype.serializeToString;
		this.client.global.XMLSerializer.prototype.serializeToString =
			proxyModule.wrapFunction(serializeToString, (target, that, args) => {
				const node = args[0];
				if (!(node instanceof this.client.global.Node))
					return Reflect.apply(target, that, args);
				const clone = inertCopy(node as Node);
				foldMarkers(clone);
				const xml = Reflect.apply(target, that, [clone]) as string;
				releaseMarkup(clone);
				return unrouteCSS(this.client, xml);
			});

		// attribute selectors match the page's values: `[href="/x"]` is
		// `[s_o:href="/x"]` on a rewritten element, `[href="/x"]` on one that
		// was never rewritten
		const SELECTOR_ATTRIBUTE =
			/\[\s*([A-Za-z_][\w-]*)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]\s]+)\s*([isIS])?)?\s*\]/g;
		const marker = ORIGINAL_ATTRIBUTE.replace(':', '\\:');
		const rewriteSelector = (selector: unknown): string =>
			String(selector).replace(
				SELECTOR_ATTRIBUTE,
				(match, name, op = '', value = '', flag = '') => {
					const rest = op ? `${op}${value}${flag ? ` ${flag}` : ''}` : '';
					return `:is([${marker}${name}${rest}],[${name}${rest}]:not([${marker}${name}]))`;
				},
			);
		for (const proto of [
			this.client.global.Element.prototype,
			this.client.global.Document.prototype,
			this.client.global.DocumentFragment.prototype,
		])
			for (const method of [
				'querySelector',
				'querySelectorAll',
				'matches',
				'closest',
			] as const) {
				const native = (proto as any)[method];
				if (typeof native !== 'function') continue;
				(proto as any)[method] = proxyModule.wrapFunction(
					native,
					(target, that, args) => {
						if (args.length) args[0] = rewriteSelector(args[0]);
						return Reflect.apply(target, that, args);
					},
				);
			}

		// the other ways to set an attribute all end in the same hooks
		// A hooked attribute (xlink:href) never reaches the element as the page
		// wrote it: an SVG <use> fetches its reference the moment the attribute
		// lands, before a hook could route it, and against the document's
		// route. The namespaced attribute is made empty (no reference), then
		// the value is written through the hooks, as setAttribute does
		this.client.global.Element.prototype.setAttributeNS =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.setAttributeNS,
				(target, that: Element, args) =>
					pageWrite(that, String(args[1]), () => {
						const name = String(args[1]);
						// (the page's Trusted Types judge an SVG script's href)
						const sink =
							args.length > 2 && !isParsed(that)
								? trustedSink(
										that,
										name.slice(name.indexOf(':') + 1),
										false,
										args[0] === null ? null : String(args[0]),
									)
								: null;
						if (sink) {
							const passed = this.client.trustedValue(
								args[2],
								TRUSTED_KINDS[sink[0]],
								sink[1],
								() => Reflect.apply(target, that, args),
							);
							if (passed === null) return;
							args[2] = trustedOf(sink[0], passed);
						}
						if (
							args.length < 3 ||
							!(that instanceof this.client.global.Element) ||
							!this.attributeHooks(that, name).length
						) {
							Reflect.apply(target, that, args);
							usePrototype(that, CustomElement.prototype, (element) =>
								this.updateAttributeHooks(element, name),
							);
							return;
						}
						Reflect.apply(target, that, [args[0], name, '']);
						// an attribute that was there keeps its own prefix
						const actual =
							(
								Reflect.apply(nativeElement.getAttributeNodeNS, that, [
									args[0],
									name.slice(name.indexOf(':') + 1),
								]) as Attr | null
							)?.name ?? name;
						usePrototype(that, CustomElement.prototype, (element) => {
							element.setAttribute(actual, String(args[2]));
							this.updateAttributeHooks(element, actual);
						});
					}),
			);
		this.client.global.Element.prototype.toggleAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.toggleAttribute,
				(target, that: Element, args) =>
					pageWrite(that, String(args[0]), () => {
						const result = Reflect.apply(target, that, args);
						usePrototype(that, CustomElement.prototype, (element) =>
							this.updateAttributeHooks(
								element,
								attributeName(that, String(args[0])),
							),
						);
						return result;
					}),
			);
		// setAttributeNode and setAttributeNodeNS are one algorithm, and an
		// attribute map's setNamedItem and setNamedItemNS are the same one
		// again (setNamedItems, read by the attributes view)
		for (const method of ['setAttributeNode', 'setAttributeNodeNS'] as const)
			this.client.global.Element.prototype[method] = setNamedItems[method] =
				proxyModule.wrapFunction(
					this.client.global.Element.prototype[method],
					(target, that: Element, args) => {
						const name = (args[0] as Attr)?.name;
						const write = () => {
							const result = Reflect.apply(target, that, args);
							if (name)
								usePrototype(that, CustomElement.prototype, (element) =>
									this.updateAttributeHooks(element, name),
								);
							return result;
						};
						return name ? pageWrite(that, name, write) : write();
					},
				);

		this.client.global.Element.prototype.setAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.setAttribute,
				(target, that: Element, args) => {
					// too many side effects
					// illegal invocation error will throw by nature
					// Reflect.apply(target, that, args);

					// the hooks are keyed by the name the attribute gets:
					// `setAttribute('HREF', x)` writes `href`.
					// The value is the string the browser makes of it (an object's
					// toString, a TrustedScriptURL): the hooks compare it with '' and
					// resolve it, and an object that reads as '' was taken for a URL,
					// the document's own, which an image then loaded
					let value = args.length < 2 ? args[1] : `${args[1]}`;
					const attribute =
						typeof args[0] === 'string'
							? attributeName(that, args[0])
							: args[0];
					// the page's Trusted Types judge a handler, a script's src, a
					// frame's srcdoc (its value went to a string once, above:
					// a trusted value's string is its own)
					const sink =
						args.length > 1 && typeof attribute === 'string' && !isParsed(that)
							? trustedSink(that, attribute)
							: null;
					if (sink) {
						const passed = this.client.trustedValue(
							args[1],
							TRUSTED_KINDS[sink[0]],
							sink[1],
							() => Reflect.apply(target, that, args),
							() => value as string,
						);
						if (passed === null) return;
						value = passed;
					}

					// the page's style-src-attr refuses a style attribute the page
					// sets as a string (a CSSOM write that serialises into the
					// attribute is the browser's to allow, and never calls
					// setAttribute): apply nothing and report it (src/csp.ts)
					if (
						attribute === 'style' &&
						args.length > 1 &&
						typeof value === 'string' &&
						value !== '' &&
						!isParsed(that) &&
						this.client.refuseStyleAttribute(that, value)
					) {
						pageWrite(that, attribute, () =>
							usePrototype(that, CustomElement.prototype, (element) => {
								element.removeAttribute('style');
								element.removeAttributeOG('style');
							}),
						);
						return;
					}

					pageWrite(that, attribute, () => {
						// an attribute no hook watches (class, aria-*, data-*) is
						// written as the hooks' view would write it, with no swap
						if (
							typeof attribute === 'string' &&
							!pendingAttributes(that) &&
							!this.hooksAttribute(attribute)
						)
							return applyAttribute(that, attribute, value);
						usePrototype(that, CustomElement.prototype, (element) => {
							element.setAttribute(attribute, value);

							this.updateAttributeHooks(element, attribute);
						});
					});
				},
			);

		this.client.global.Element.prototype.removeAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.removeAttribute,
				(target, that: Element, args) => {
					// too many side effects
					// illegal invocation error will throw by nature
					// Reflect.apply(target, that, args);

					const attribute =
						typeof args[0] === 'string'
							? attributeName(that, args[0])
							: args[0];

					pageWrite(that, attribute, () => {
						if (
							typeof attribute === 'string' &&
							!pendingAttributes(that) &&
							!this.hooksAttribute(attribute)
						) {
							// in the order the hooks' view applies them
							applyAttribute(that, attribute, null);
							applyAttribute(that, ORIGINAL_ATTRIBUTE + attribute, null);
							return;
						}
						usePrototype(that, CustomElement.prototype, (element) => {
							element.removeAttribute(attribute);
							element.removeAttributeOG(attribute);
							this.updateAttributeHooks(element, attribute);
						});
					});
				},
			);

		const trackProperties = new Map<ElementCtor, Set<string>>();

		for (const entry of this.hooks) {
			if (isAttributeHook(entry.hook)) continue;

			if (!trackProperties.has(entry.hook[0])) {
				trackProperties.set(entry.hook[0], new Set());
			}

			trackProperties.get(entry.hook[0])!.add(entry.hook[1]);
		}

		for (const [ctor, properties] of trackProperties) {
			for (const property of properties) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					ctor.prototype,
					property,
				);

				if (!descriptor) {
					throw new Error(`Ctor ${ctor} did not have ${property}`);
				}

				Reflect.defineProperty(ctor.prototype, property, {
					enumerable: true,
					configurable: true,
					get: proxyModule.wrapFunction(
						descriptor.get!,
						(target, that, args) => {
							return usePrototype(that, CustomElement.prototype, (element) => {
								for (const entry of this.#propertyHooks(property)) {
									const result = (entry.hook as PropertyHook)[2](element);

									if (result === false) continue;

									return result;
								}

								// no hook answered (the attribute is missing or empty): the
								// browser's value for a URL property is then the document's
								// own URL or base URL, which is a route, and is read back as
								// the page's
								const value = Reflect.apply(target, that, args);
								return typeof value === 'string'
									? this.readbackURL(value)
									: value;
							});
						},
					),
					set: proxyModule.wrapFunction(descriptor.set!, (target, that, args) =>
						// one write for the page's observers, however many it takes
						pageWrite(that, propertyAttribute(property), () => {
							// properties are only set at the end of the stack
							// attributes differ because they will immediately have an effect and will overrule properties set in the same stack

							// A reflecting property is its attribute: the page's value goes
							// into the hooks' view of it and only what they make of it (a
							// route, a copy) reaches the element, as with setAttribute.
							// Handed to the native setter first, the raw URL would start a
							// load (a connected script, link or frame, an image) straight
							// from the site, past the proxy. `style` is not one: its setter
							// forwards to cssText.
							if (property === 'style') Reflect.apply(target, that, args);

							// (the page's Trusted Types judge a script's src, a frame's
							// srcdoc)
							const sink = trustedSink(that as Element, property, true);
							const written = sink
								? this.client.trustedValue(
										args[0],
										TRUSTED_KINDS[sink[0]],
										sink[1],
										() => Reflect.apply(target, that, args),
									)
								: String(args[0]);
							if (written === null) return;
							let untouched = false;
							usePrototype(that, CustomElement.prototype, (element) => {
								const attribute = propertyAttribute(property);
								if (property !== 'style')
									element.setAttribute(attribute, written);
								this.updatePropertyHooks(element, ctor, property);
								untouched =
									property !== 'style' &&
									element.getAttribute(attribute) === written;
							});
							// No hook took the value (a link's href before its rel is
							// set, an icon's): it is the page's attribute as written,
							// as natively. Read back through the native getter it would
							// be resolved against the document's real URL, the proxy's,
							// and the hook that takes it later (when the rel comes)
							// would load it from the proxy origin.
							if (untouched) return;

							// getter isn't stack based and we can use this to make the attribute immediately take effect

							// equivalent to i.src = i.src. Not for `style`: its getter
							// returns the declaration object, and assigning that back goes
							// through PutForwards=cssText as "[object CSSStyleDeclaration]",
							// which wipes the inline style
							// An empty value stays empty: the browser's reading of it is
							// the document's own URL (a route), not a URL to apply.
							const value = Reflect.apply(descriptor.get!, that, []);

							// nor one a hook removed (a load whose proxied copy is still on
							// its way): written back it would be an empty URL, which a
							// script reports as an error and never loads again
							// A base's href took effect with its attribute, and written
							// again it is judged again (base-uri, a violation each time)
							if (
								typeof value === 'string' &&
								written !== '' &&
								value !== '' &&
								ctor !== this.client.global.HTMLBaseElement
							)
								Reflect.apply(target, that, [
									sink ? trustedOf(sink[0], value) : value,
								]);
						}),
					),
				});
			}
		}
	}
}
