import { openFragment } from '../../../routeURL';
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
import { withStack } from '../../nativeErrors';
import { LazyMap, LazyWeakMap } from '../../ownCollections';
import {
	isOwnInjector,
	isParsed,
	ownScripts,
	TRUSTED_KINDS,
	trustedAttribute,
	trustedHTML,
	trustedOf,
	trustedSink,
} from '../../trusted';
import type { AttributeView, ViewMethod } from '../attributeViewMethods';
import DocumentClient, {
	addDocumentOpenListener,
	getGlobalParsingState,
	runDocumentOpenListeners,
	setGlobalParsingState,
} from '../Client';
import cloneRawNode, {
	closeNoscripts,
	createElementIn,
	inertDocumentOf,
	isHTMLTemplate,
	isScriptElement,
	parseHTMLFragmentIn,
	releaseMarkup,
	templateContentDocument,
} from '../cloneNode';
import { deferred } from '../deferred';
import type { DeferredParts } from '../deferredParts';
import type { MarkupContext, ScriptNotes } from '../markupMembers';
import type { SinkContext } from '../markupSinks';
import { responseURLOf } from '../responseDocuments';
import type WriteStream from '../WriteStream';
import { isStomp } from './Context';
import {
	attributeName,
	hiddenSuffix,
	hookWrite,
	isHiddenValue,
	markerPrefix,
	pageWrite as observedPageWrite,
	propertyAttribute,
} from './MutationObserver';

const attributeTab = new WeakMap<CustomElement, Map<string, string | null>>();
// the value last applied to each hooked attribute (the routed one), so a
// hook can tell an attribute it wrote from one the page changed since
const appliedTab = new WeakMap<Element, Map<string, string | null>>();

/**
 * A page's write of attribute `name` (every way of setting one comes here):
 * what the hooks last applied no longer describes the attribute, even when
 * the page's value is the same string. Google's sign-in page builds its
 * CheckConnection frame's sandbox one token at a time (`setAttribute('sandbox',
 * '')`, then `sandbox.add(flag)` per flag), and its `allow-same-origin
 * allow-scripts` step wrote exactly what the hook had made real of the step
 * before, so restoreAttributesOG took it for the hook's own value and put
 * the page's earlier one back: allow-scripts was lost and the frame's
 * scripts were refused.
 */
function pageWrite<T>(element: Element, name: string, callback: () => T): T {
	// (a name the page gave that is no string is the browser's to refuse)
	if (typeof name === 'string')
		appliedTab.get(element)?.delete(attributeName(element, name));
	return observedPageWrite(element, name, callback);
}

/**
 * Whether `name` of `element` is an attribute the page does not have: a
 * type the hooks hid (an object's while its copy loads, DOMAttributes hold)
 * that no marker of the page's stands for
 */
const isHidden = (element: unknown, name: unknown): boolean =>
	name === 'type' &&
	isHiddenValue(Reflect.apply(nativeElement.getAttribute, element, [name])) &&
	!Reflect.apply(nativeElement.hasAttribute, element, [markerPrefix() + name]);
/** isHidden of the name a call with `name` acts on */
const isHiddenOn = (element: unknown, name: unknown): boolean =>
	typeof name === 'string' && isHidden(element, attributeName(element, name));

// the namespace ('' for none) of each prefixed attribute a hook removed
// (xlink:href, while a load's copy is on its way): set again, it is the same
// attribute, not one of no namespace that the element ignores
const removedNamespaces = new LazyWeakMap<Element, Map<string, string>>();

/**
 * the markup members of Node, Element, ShadowRoot, CharacterData,
 * DocumentFragment and Document the inject hooks (or that only serialize);
 * any other member named with HTML is taken off those prototypes, except
 * the insertion members below on the three prototypes they are hooked on
 */
const HOOKED_MARKUP_MEMBERS = new Set([
	'innerHTML',
	'outerHTML',
	'getHTML',
	'insertAdjacentHTML',
	'setHTMLUnsafe',
	'setHTML',
]);
type Fn = (...args: unknown[]) => unknown;
/**
 * Chrome 157's markup insertion members the inject hooks (../markupMembers.ts).
 * Their stream* forms (streamHTML(Unsafe), streamAppendHTML and the rest) are
 * not: they stay off the prototypes with every other unhooked markup member.
 * A stream form's chunks go to the browser's own WritableStream through its
 * writer, and the only writer methods a hook could call are the ones the
 * realm has when the page first streams (taken as the bundle loads, each
 * frame made the WritableStream interfaces, which cost every frame's heap):
 * a page that replaced the writer's `write` or the stream's `getWriter` by
 * then would be handed the browser's own writer, and could write its markup
 * into the browser's parser unrewritten. No check of what it installed tells
 * a native from a bound or planted one well enough. They can be hooked once
 * the writer's natives are taken at load at a cost a frame can carry.
 */
const MARKUP_INSERTION =
	/^(?:append|prepend|before|after|replaceWith)HTML(?:Unsafe)?$/;
/** the insertion methods the safe members put nodes in with (as the hooks made them) */
const MARKUP_INSERTS = [
	'append',
	'prepend',
	'before',
	'after',
	'replaceWith',
] as const;
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
/** an href by a prefix other than xlink (x:href), which may be xlink's */
const otherXlinkPrefix = (name: string) =>
	name.endsWith(':href') &&
	name !== 'xlink:href' &&
	!name.startsWith(markerPrefix()) &&
	name.indexOf(':') === name.length - 5;

/**
 * A property hook that reads nothing itself (`[ctor, 'style', nativeRead]`):
 * it is there for the property's setter, and its getter answers natively.
 * A getter whose hooks are all this one works on no element, so it needs
 * no prototype swap (a page's every `el.style` read made one).
 */
export const nativeRead = (): false => false;

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
	page = false,
) {
	try {
		if (value === null) {
			const node = Reflect.apply(nativeElement.getAttributeNode, element, [
				attribute,
			]);
			if (node && attribute.includes(':')) {
				if (!removedNamespaces.has(element))
					removedNamespaces.set(element, new Map());
				removedNamespaces.get(element)!.set(attribute, node.namespaceURI ?? '');
			}
			Reflect.apply(nativeElement.removeAttribute, element, [attribute]);
		} else if (
			Reflect.apply(nativeElement.hasAttribute, element, [attribute])
		) {
			Reflect.apply(nativeElement.setAttribute, element, [
				attribute,
				trustedAttribute(element, attribute, value),
			]);
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
				Reflect.apply(nativeElement.setAttributeNS, element, [
					namespace,
					attribute,
					given,
				]);
			else
				Reflect.apply(nativeElement.setAttribute, element, [attribute, given]);
		}
		if (!appliedTab.has(element)) appliedTab.set(element, new Map());
		appliedTab.get(element)!.set(attribute, value);
	} catch (error) {
		// the page's own write throws what the browser throws at it
		if (page) throw error;
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
			return Reflect.apply(nativeElement.getAttribute, this, [attribute]);
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

		return Reflect.apply(nativeElement.hasAttribute, this, [attribute]);
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
		Reflect.apply(CustomElement.prototype.applyAttributes, this, []);
	}
	getAttributeOG(attribute: string): string | null {
		const og = `${markerPrefix()}${attribute}`;

		if (this.hasAttribute(og)) {
			return this.getAttribute(og)!;
		} else {
			return null;
		}
	}
	getAttributeNamesOG(): string[] {
		const names: string[] = [];

		for (const name of this.getAttributeNames())
			if (name.startsWith(markerPrefix()))
				names.push(name.slice(markerPrefix().length));

		return names;
	}
	setAttributeOG(attribute: string, value: string) {
		const og = `${markerPrefix()}${attribute}`;

		this.setAttribute(og, value);
	}
	hasAttributeOG(attribute: string): boolean {
		const og = `${markerPrefix()}${attribute}`;

		return this.hasAttribute(og);
	}
	removeAttributeOG(attribute: string) {
		const og = `${markerPrefix()}${attribute}`;

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

// taken before any page code could replace it
const isPrototypeOf = Object.prototype.isPrototypeOf;
/**
 * Whether `that` has `ctor`'s prototype above it: an element of this realm
 * (a prototype object, an impostor made of one and an element of another
 * realm do not, and the browser is asked about those)
 */
const inherits = (that: unknown, ctor: { prototype: object }): boolean =>
	((typeof that === 'object' && that !== null) || typeof that === 'function') &&
	(Reflect.apply(isPrototypeOf, ctor.prototype, [that]) as boolean);
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
/** the property's value (`true`: a boolean one's), or false for the browser's */
type PropertyHookGetter = (element: CustomElement) => string | boolean;

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
// taken when the bundle loads, before any page script
const NativeWeakRef = WeakRef;

export default class DOMHooksModule extends Module<DocumentClient> {
	#namespaceURI?: () => unknown;
	/**
	 * The browser's own refusal of a receiver that is no element, for a
	 * hook that works on its receiver before any native call would refuse
	 * it: a native getter of this realm's Element (called directly:
	 * Reflect.get would be a frame of the error's stack), which throws the
	 * Illegal invocation a native method or accessor called on `that`
	 * throws, an error of the page's realm.
	 */
	requireElement = (that: unknown): void => {
		this.#namespaceURI ??= Reflect.getOwnPropertyDescriptor(
			this.client.global.Element.prototype,
			'namespaceURI',
		)!.get!;
		Reflect.apply(this.#namespaceURI, that, []);
	};
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
		const client = this.client;
		if (!value.startsWith(scopePrefix(client))) return value;
		if (value.startsWith(`${routedPrefix(client)}inline:`)) {
			const hash = value.indexOf('#');
			const url = new URL(client.url.toString());
			url.hash =
				hash === -1
					? ''
					: `#${openFragment(client.codec, value.slice(hash + 1))}`;
			return url.href;
		}
		return unrouteURL(client, value) ?? value;
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
			// a property hook added once the hooks are applied (one only some
			// documents come to need): its property is wrapped now, unless
			// another hook of it had it wrapped
			if (
				this.#wrapProperty &&
				!isAttributeHook(hook) &&
				!this.hooks.some(
					(entry) =>
						entry.hook !== hook &&
						entry.hook[0] === hook[0] &&
						entry.hook[1] === hook[1],
				)
			)
				this.#wrapProperty(hook[0], hook[1]);
		}
		this.#hookedNames = null;
		this.#hooksByName.clear();
		this.#readHooks.clear();
		this.#writeHooks.clear();
	}
	/** apply's wrapping of a hooked property, for a hook added later */
	#wrapProperty?: (ctor: ElementCtor, property: string) => void;
	/**
	 * The member `name` (its setter with `setter`) of the realm of the node
	 * `that` when that node's document is another client's (this realm's
	 * member called on a frame's node: `Element.prototype.setHTMLUnsafe
	 * .call(frameElement, markup)`), else null. The browser parses into the
	 * node's document and makes its nodes in that document's realm; its
	 * client's hooks rewrite the markup as that document's (a frame no
	 * worker controls copies its loads, where a route means nothing), so a
	 * markup member hands such a call to that realm's own
	 */
	ownMember: (that: unknown, name: string, setter?: boolean) => Fn | null =
		() => null;
	/** the attribute hooks by element name and attribute (attributeHooks) */
	#hooksByName = new LazyMap<string, Map<string, readonly HookEntry[]>>();
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
			this.#hookedSets.some((names) => names.has(attribute)) ||
			otherXlinkPrefix(attribute)
		);
	}
	/** the attribute hooks of `attribute` on `element` */
	private attributeHooks(
		element: Element,
		attribute: string,
	): readonly HookEntry[] {
		if (!this.hooksAttribute(attribute)) return NO_HOOKS;
		// the browser finds an xlink:href by its namespace, whatever its
		// prefix (x:href, an XML document's own): its hooks are xlink:href's,
		// called with the name it has. A q:href of no namespace is no link
		if (otherXlinkPrefix(attribute)) {
			const node = Reflect.apply(nativeElement.getAttributeNode, element, [
				attribute,
			]);
			if (
				node
					? node.namespaceURI !== XLINK_NAMESPACE
					: !Reflect.apply(nativeElement.hasAttribute, element, [
							markerPrefix() + attribute,
						])
			)
				return NO_HOOKS;
			attribute = 'xlink:href';
		}
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
			this.#runHook(entry, element, attribute);
	}
	/**
	 * The value the page gave `attribute` when it is no URL at all (it does
	 * not parse against the page's base: `https://[`, `//[]`, a port out of
	 * range, any relative URL under `<base href="about:blank">`), else null.
	 * The browser keeps such a value as written: nothing throws, the property
	 * reads back as the attribute, and the load it names fails as any other
	 * does (a script's error event, from a task).
	 */
	#unparsed(element: CustomElement, attribute: string): string | null {
		const value =
			element.getAttributeOG(attribute) ?? element.getAttribute(attribute);
		if (value === null) return null;
		try {
			new URL(value, this.client.baseHref);
			return null;
		} catch (error) {
			return value;
		}
	}
	/**
	 * One hook of a written attribute. A hook resolves the page's value to
	 * route it, and a value that is no URL made that throw out of the page's
	 * `img.src = value`, `setAttribute` or `appendChild`, where the browser
	 * throws nothing (a link made only to take a URL apart,
	 * `a.href = input; a.hostname`, is given anything). The hooks' view
	 * already holds the value as written, which is what the element keeps
	 * (it names nothing the browser can load either). The hook of one
	 * attribute reads others (a script's `type` its `src`, a link's `rel` its
	 * `href`), so any of the element's may be the one that did not parse.
	 * Anything else a hook throws still propagates.
	 */
	#runHook(entry: HookEntry, element: CustomElement, attribute: string) {
		try {
			entry.callback(element, attribute);
		} catch (error) {
			if (
				!String((error as Error | null)?.message).includes('Invalid URL') ||
				// (the written one first: it may be in the hooks' view only)
				![attribute, ...element.getAttributeNames()].some(
					(name) =>
						!name.startsWith(markerPrefix()) &&
						this.#unparsed(element, name) !== null,
				)
			)
				throw error;
		}
	}
	/**
	 * The property hooks by property (a read asks every constructor's), and
	 * by constructor and property (a write's), in the hooks' order, until
	 * useAttributes adds any: each read and write looked at every hook
	 */
	#readHooks = new LazyMap<string, readonly HookEntry[]>();
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
			this.#runHook(entry, element, propertyAttribute(property));
	}
	apply() {
		const moduleClient = this.client;
		const realm = moduleClient.global;
		// all hooks are in, now apply them

		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const { requireElement } = this;

		const ownerOf = Reflect.getOwnPropertyDescriptor(
			realm.Node.prototype,
			'ownerDocument',
		)!.get!;
		const viewOf = Reflect.getOwnPropertyDescriptor(
			realm.Document.prototype,
			'defaultView',
		)!.get!;
		const ownObject = realm.Object.prototype;
		this.ownMember = (that, name, setter) => {
			try {
				const document = Reflect.apply(ownerOf, that, []);
				if (!document || document === realm.document) return null;
				const view = Reflect.apply(viewOf, document, []);
				if (
					!view ||
					view === realm ||
					!isStomp(view, moduleClient.names.client)
				)
					return null;
				// (a node of this realm's adopted there keeps this realm's
				// members, which are these)
				let member: unknown;
				for (
					let proto = Reflect.getPrototypeOf(that as object);
					proto;
					proto = Reflect.getPrototypeOf(proto)
				) {
					if (proto === ownObject) return null;
					const descriptor =
						member === undefined &&
						Reflect.getOwnPropertyDescriptor(proto, name);
					if (descriptor)
						member = (setter ? descriptor.set : descriptor.value) ?? null;
				}
				return typeof member === 'function' ? (member as Fn) : null;
			} catch (error) {
				return null;
			}
		};

		/**
		 * Etc hooks are here
		 */

		// native write, taken before the prototype hook below replaces it: the
		// stream's output and a pending tail go through it
		const nativeWrite = realm.document.write;
		// the stream (../WriteStream.ts), a deferred part made at a document's
		// first write: until then nothing is pending to drop or take
		let stream: WriteStream | undefined;

		// document.open() drops every listener on the window: the modules that
		// listen there (message filter and tagger, link and navigate hooks)
		// register again. With three arguments it is window.open, which the
		// hook below handles.
		const documentOpen = realm.Document.prototype.open;
		const stopPieces = (that: unknown) => {
			if (that !== realm.document || !moduleClient.pieces?.between) return;
			moduleClient.pieces.stopped = true;
			moduleClient.pieces = null;
			moduleClient.pendingScripts = null;
		};
		realm.Document.prototype.open = proxyModule.wrapFunction(
			documentOpen,
			(target, that, args) => {
				if (args.length >= 3) return Reflect.apply(realm.open, realm, args);
				// a fresh parser with an empty input stream: whatever an earlier
				// write left unfinished went with the old one
				if (typeof that === 'object' && that !== null) stream?.reset(that);
				// between two pieces of the page's markup (loadHTML) no script of
				// the parser runs, so open() aborts the page's parser, as
				// natively: the rest of the markup is never written
				stopPieces(that);
				const result = Reflect.apply(target, that, args);
				if (that === realm.document) {
					moduleClient.opened = true;
					runDocumentOpenListeners(realm);
				}
				return result;
			},
		);
		const openHook = realm.Document.prototype.open;

		// window.open(): where the URL is routed and the window it opened
		// remembered for the tab are a deferred part (../windowOpen.ts),
		// made in the call before anything of the browser's is (so the call
		// stays inside the user's activation): without it the call throws
		let opener: ReturnType<DeferredParts['windowOpen']> | null = null;
		realm.open = proxyModule.wrapFunction(realm.open, (target, that, args) =>
			(opener ??= deferred('windowOpen')(moduleClient, NativeWeakRef))(
				target,
				that,
				args,
			),
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
				const passed = moduleClient.trustedValue(
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
					typeof that === 'object' && that !== null ? that : realm.document;
				// between two pieces of the page's markup (loadHTML), where the
				// network's parser has no insertion point (a MutationObserver's
				// callback before a script), the write opens the document first
				if (document === realm.document && moduleClient.pieces?.between)
					Reflect.apply(openHook, document, []);
				// a write once the document has loaded opens it again (the page
				// never called open()): known before the markup is rewritten, the
				// listeners after, once the browser has dropped the window's own
				const opens =
					document === realm.document &&
					realm.document.readyState === 'complete';
				// a document just opened (no root yet), or one this write opens
				const fresh =
					opens ||
					(document === realm.document &&
						realm.document.documentElement === null);
				// the browser opens it inside the write, and a script of the
				// written markup runs before the write returns: the window's
				// listeners (the message tagger first) are registered again
				// before it, as after the page's own open(). Opened by an empty
				// write of the browser's, which refuses as the page's would (a
				// write from a module, async or deferred script opens nothing,
				// natively with the console's warning): then nothing is written,
				// as natively. open() itself would not refuse.
				if (opens) {
					Reflect.apply(nativeWrite, document, [trustedHTML('')]);
					if (realm.document.readyState === 'complete') return;
					stream?.reset(document);
					moduleClient.opened = true;
					runDocumentOpenListeners(realm);
				}
				const prevState = getGlobalParsingState(realm);
				setGlobalParsingState(realm, 'parsingBeforeWrite');
				let markup: string;
				try {
					stream ??= deferred('writeStream')(moduleClient);
					markup = stream.write(document, text, fresh);
				} finally {
					setGlobalParsingState(realm, prevState);
				}
				// an empty write still reaches the parser: after the document
				// has loaded it opens a new one, as the page's own call would
				Reflect.apply(nativeWrite, that, [trustedHTML(markup)]);
				// a frame the written markup made (a script it holds sweeps
				// first, see prepareScriptText)
				moduleClient.sweepFrames?.();
				moduleClient.writtenLoads?.(document as Document);
			});

		// on the prototype, where the browser has them: an own property of the
		// document is a tell (Object.getOwnPropertyNames(document)), and a
		// window that keeps its realm across documents hands each new one the
		// hook. A popup's document finds its own realm's prototype, and so
		// that realm's client.
		const documentProto = realm.Document.prototype;
		documentProto.write = writeFactory(documentProto.write, false);
		documentProto.writeln = writeFactory(documentProto.writeln, true);

		// document.close() ends the input: the unfinished tail goes to the
		// parser as it is, which meets it at the end of its input the way the
		// browser's would
		realm.Document.prototype.close = proxyModule.wrapFunction(
			realm.Document.prototype.close,
			(target, that, args) => {
				// the page's markup is still being written in pieces (loadHTML):
				// the network's parser is no script-created parser, so close()
				// ends nothing
				if (that === realm.document && moduleClient.pieces) return;
				const tail = stream?.take(that);
				if (tail) Reflect.apply(nativeWrite, that, [trustedHTML(tail)]);
				const result = Reflect.apply(target, that, args);
				moduleClient.writtenLoads?.(that as Document);
				return result;
			},
		);

		// when the parser stops on its own (the end of the real page's markup
		// after a blocking script, a frame's srcdoc) nothing can be written
		// into it any more: a write now would open a new document. A tail
		// left behind is stale, like the browser's at its end of input.
		const dropAtParserEnd = () => {
			if (realm.document.readyState !== 'loading')
				stream?.reset(realm.document);
		};
		const listen = () =>
			realm.document.addEventListener('readystatechange', dropAtParserEnd);
		listen();
		addDocumentOpenListener(realm, listen);

		Reflect.defineProperty(realm.Node.prototype, 'baseURI', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(realm.Node.prototype, 'baseURI')!.get!,
				(target, that, args) => {
					// only side effect this getter has is the potential to throw an illegal invocation error
					const base = Reflect.apply(target, that, args);
					// a document with no base URL of its own or inherited (a popup
					// opened on a javascript: URL, a document the page made with
					// createHTMLDocument) has none for the page either
					if (base === 'about:blank') return base;
					return responseURLOf(that) ?? moduleClient.baseHref;
				},
			),
		});

		Reflect.defineProperty(realm.Document.prototype, 'URL', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(realm.Document.prototype, 'URL')!.get!,
				(target, that, args) => {
					// (the native getter throws for what is no document)
					const native = Reflect.apply(target, that, args) as string;
					return moduleClient.documentURL(
						that,
						native,
						() => responseURLOf(that) ?? moduleClient.locationHref,
					);
				},
			),
		});

		// <q>, <blockquote>, <ins> and <del> reflect `cite` as a URL the
		// browser resolves itself, against the document's real base: a route.
		// No load is made from it, so the attribute stays as written and the
		// property resolves it against the page's base
		const nativeGetAttribute = realm.Element.prototype.getAttribute;
		for (const ctor of [realm.HTMLQuoteElement, realm.HTMLModElement]) {
			const cite = Reflect.getOwnPropertyDescriptor(ctor.prototype, 'cite');
			if (!cite?.get) continue;
			Reflect.defineProperty(ctor.prototype, 'cite', {
				...cite,
				get: proxyModule.wrapFunction(cite.get, (target, that, args) => {
					// the native brand check first
					Reflect.apply(target, that, args);
					const written = Reflect.apply(nativeGetAttribute, that, ['cite']) as
						string | null;
					if (written === null) return '';
					try {
						return moduleClient.encodingParse(
							written,
							moduleClient.baseHref,
							that,
						).href;
					} catch (error) {
						// not a URL: as written, like the browser
						return written;
					}
				}),
			});
		}

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
		void moduleClient.siteKeyed;
		const domainDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.Document.prototype,
			'domain',
		)!;
		// The setter's work, and that of the rare markup sinks below
		// (execCommand's markup and links, createContextualFragment,
		// setHTMLUnsafe, setHTML, getHTML, serializeToString), is a deferred
		// part (../markupSinks.ts), made at a page's first call of one, before
		// the hook calls anything of the browser's: without it the call
		// throws. What it needs is taken now (sinkContext, by the getHTML
		// hooks).
		let sinkParts: ReturnType<DeferredParts['markupSinks']> | null = null;
		const sinks = () => (sinkParts ??= deferred('markupSinks')(sinkContext));
		Reflect.defineProperty(realm.Document.prototype, 'domain', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				domainDescriptor.get!,
				(target, that: Document, args) => {
					// only side effect this getter has is the potential to throw an illegal invocation error
					Reflect.apply(target, that, args);
					// an opaque origin has no domain, nor has a removed frame's
					// document (a document the page made without a window has
					// its creator's, as natively)
					if (moduleClient.sandboxedOpaque || realm.closed) return '';
					return moduleClient.documentDomain ?? moduleClient.url.url.hostname;
				},
			),
			set: proxyModule.wrapFunction(
				domainDescriptor.set!,
				(target, that: Document, args) => sinks().setDomain(that, args),
			),
		});

		// window.originAgentCluster: whether this document's agent cluster is
		// keyed by origin (DocumentClient.siteKeyed), not the proxy origin's;
		// window.credentialless, in a credentialless frame's documents only
		for (const [name, answer] of [
			['originAgentCluster', () => !moduleClient.siteKeyed],
			...(moduleClient.credentiallessNonce === null
				? []
				: [['credentialless', () => true]]),
		] as [string, () => boolean][])
			for (const owner of [realm, realm.Window.prototype] as object[]) {
				const descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
				if (!descriptor?.get) continue;
				Reflect.defineProperty(owner, name, {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							Reflect.apply(target, that, args);
							return answer();
						},
					),
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
			realm.HTMLScriptElement.prototype,
			'text',
		)!;

		Reflect.defineProperty(realm.HTMLScriptElement.prototype, 'text', {
			enumerable: true,
			configurable: true,
			get: scriptTextDescriptor.get,
			set: proxyModule.wrapFunction(
				scriptTextDescriptor.set!,
				(target, that: HTMLScriptElement, args) => {
					// (the page's Trusted Types: DocumentClient.scriptValue)
					const text = moduleClient.scriptValue(
						that,
						args[0],
						'HTMLScriptElement text',
						() => Reflect.apply(target, that, args),
					);
					if (text === null || moduleClient.trustedScriptText(that, text))
						return;
					// snapshot: removing while iterating the live list skips every
					// other node and leaves half the old text in place
					for (const node of [...that.childNodes]) node.remove();

					// the empty string leaves no text node, as natively
					if (text === '') return;
					that.append(
						new realm.Text(moduleClient.prepareScriptText(that, text)),
					);
				},
			),
		});

		// An HTML style's markup is its text: the browser parses what
		// innerHTML or setHTMLUnsafe give an HTML <style> as raw text, so it
		// is set as the text, through the insertion hook of DOMContentHooks
		// (applied before this module), which routes text going into a style
		// before it lands
		const hookedAppend = realm.Element.prototype.append;
		const setStyleText = (style: Element, text: string) => {
			usePrototype(style, nativeElement, (element) => {
				for (const node of [...element.childNodes]) node.remove();
			});
			// the empty string leaves no text node, as natively
			if (text !== '') Reflect.apply(hookedAppend, style, [text]);
		};
		// and a Text's `data`, which DOMContentHooks routes in a style
		const hookedDataSet = Reflect.getOwnPropertyDescriptor(
			realm.CharacterData.prototype,
			'data',
		)!.set!;

		const textContentDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.Node.prototype,
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
				realm.HTMLScriptElement.prototype,
				name,
			);
			if (!own?.set) continue;
			Reflect.defineProperty(realm.HTMLScriptElement.prototype, name, {
				...own,
				set: proxyModule.wrapFunction(
					own.set,
					(target, that: HTMLScriptElement, args) => {
						if (!isScriptElement(that))
							return Reflect.apply(target, that, args);
						// null is the empty string, which leaves no child (and
						// undefined too for textContent, whose type is nullable)
						const text = moduleClient.scriptValue(
							that,
							args[0],
							`HTMLScriptElement ${name}`,
							() => Reflect.apply(target, that, args),
							(value) =>
								value === null ||
								(value === undefined && name === 'textContent')
									? ''
									: String(value),
						);
						if (text === null || moduleClient.trustedScriptText(that, text))
							return;
						usePrototype(that, nativeElement, (element) => {
							for (const node of [...element.childNodes]) node.remove();
						});
						if (text === '') return;
						const lines =
							name === 'innerText' ? text.split(/\r\n|\r|\n/) : [text];
						const nodes: (string | Node)[] = [];
						for (const [index, line] of lines.entries()) {
							if (index) nodes.push(realm.document.createElement('br'));
							if (line !== '') nodes.push(line);
						}
						Reflect.apply(hookedAppend, that, nodes);
					},
				),
			});
		}

		Reflect.defineProperty(realm.Node.prototype, 'textContent', {
			enumerable: true,
			configurable: true,
			get: textContentDescriptor.get,
			set: proxyModule.wrapFunction(
				textContentDescriptor.set!,
				(target, that: Node, args) => {
					// only elements and fragments have children to hook (and an
					// `append`); YouTube sets textContent on Text nodes, which is
					// their data (null the empty string)
					// (null and undefined are the empty string: the type is nullable)
					if (that.nodeType !== 1 && that.nodeType !== 11)
						return moduleClient.styleOfText(that) || that.nodeType === 7
							? Reflect.apply(hookedDataSet, that, [
									args[0] === null || args[0] === undefined
										? ''
										: String(args[0]),
								])
							: Reflect.apply(target, that, args);

					// Only a script's text and a style's are the proxy's to
					// rewrite. Any other element's is set by the browser, in one
					// step: taken apart here (each child removed, then a text node
					// appended), a page's MutationObserver got a record per child
					// where natively it gets one, `undefined` was written out as
					// text, and every such write paid for the loop
					if (
						!(that instanceof realm.HTMLScriptElement) &&
						!(that instanceof realm.SVGScriptElement) &&
						moduleClient.styleKind(that) === null
					)
						return Reflect.apply(target, that, args);

					for (const node of [...that.childNodes]) node.remove();

					// the empty string leaves no text node, as natively (null left
					// a text node reading "null")
					const written =
						args[0] === null || args[0] === undefined ? '' : String(args[0]);
					if (written === '') return;
					// a script's text set while it is connected runs at once
					const text =
						that instanceof realm.HTMLScriptElement
							? moduleClient.prepareScriptText(that, written)
							: written;
					(that as Element).append(new realm.Text(text));
				},
			),
		});

		const innerTextDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.HTMLElement.prototype,
			'innerText',
		)!;

		Reflect.defineProperty(realm.HTMLElement.prototype, 'innerText', {
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
						if (index) nodes.push(realm.document.createElement('br'));
						if (line !== '') nodes.push(new realm.Text(line));
					}
					that.append(...nodes);
				},
			),
		});

		const outerTextDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.HTMLElement.prototype,
			'outerText',
		)!;

		Reflect.defineProperty(realm.HTMLElement.prototype, 'outerText', {
			enumerable: true,
			configurable: true,
			get: outerTextDescriptor.get,
			set: proxyModule.wrapFunction(
				outerTextDescriptor.set!,
				(target, that: Element, args) => {
					requireElement(that);
					that.replaceWith(new realm.Text(args[0]));
				},
			),
		});

		/**
		 * inner and outer HTML need to have their getters hooked
		 * this will reveal hooked attributes etc
		 * (a getInnerHTML, which Chrome no longer has, is taken off the
		 * prototype with every other unhooked markup member below)
		 */

		const innerHTMLDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.Element.prototype,
			'innerHTML',
		)!;

		Reflect.defineProperty(realm.Element.prototype, 'innerHTML', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				innerHTMLDescriptor.get!,
				(target, that: Element) => {
					requireElement(that);
					return this.serializeOriginal(that, false);
				},
			),
			set: proxyModule.wrapFunction(
				innerHTMLDescriptor.set!,
				(target, that: Element, args) => {
					const own = this.ownMember(that, 'innerHTML', true);
					if (own) return Reflect.apply(own, that, args);
					// null is the empty string ([LegacyNullToEmptyString]), after the
					// page's Trusted Types judged it
					const markup = moduleClient.trustedValue(
						args[0],
						'TrustedHTML',
						'Element innerHTML',
						() => Reflect.apply(target, that, args),
						htmlString,
					);
					if (markup === null) return;
					const kind = moduleClient.styleKind(that);
					if (kind === 'html') return setStyleText(that, markup);
					// an SVG <style> parses its markup as markup (measured: an
					// element in it stays one); what it makes goes in through the
					// insertion hook, which routes the text going into a style
					if (kind === 'svg') {
						const nodes = cloneRawNode(
							parseHTMLFragmentIn(markup, that, realm.document),
							realm.document,
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
										parseHTMLFragmentIn(markup, that, realm.document),
										templateContentDocument(element),
									),
								);
							});
						else if (isScriptElement(that)) {
							for (const node of [...element.childNodes]) node.remove();

							// a script's markup is its text (an HTML script's as it
							// is written, an SVG script's parsed), and a connected
							// script that has not run runs it: it goes in through
							// the insertion hook, which rewrites what will run
							const nodes =
								element.nodeName === 'SCRIPT'
									? markup
									: cloneRawNode(
											parseHTMLFragmentIn(markup, that, realm.document),
											realm.document,
										);
							if (nodes !== '') Reflect.apply(hookedAppend, that, [nodes]);
						} else {
							// parsed in the element's context, as the browser does (a
							// table section's rows, an <svg>'s SVG, a <textarea>'s text),
							// and put in the children's place in one step, as the browser
							// replaces them: a page's MutationObserver gets one record.
							// Removed one by one, it got a record per child and one more
							// for the new nodes, and a `remove` the page had put on a child
							// or its prototype ran for each
							element.replaceChildren(
								cloneRawNode(
									parseHTMLFragmentIn(markup, that, realm.document),
									realm.document,
								),
							);
						}
					});
					// a frame in the markup is injected as it connects
					moduleClient.sweepFrames?.();
				},
			),
		});

		const outerHTMLDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.Element.prototype,
			'outerHTML',
		)!;

		Reflect.defineProperty(realm.Element.prototype, 'outerHTML', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				outerHTMLDescriptor.get!,
				(target, that: Element) => {
					requireElement(that);
					return this.serializeOriginal(that, true);
				},
			),
			set: proxyModule.wrapFunction(
				outerHTMLDescriptor.set!,
				(target, that: Element, args) => {
					const own = this.ownMember(that, 'outerHTML', true);
					if (own) return Reflect.apply(own, that, args);
					// (the page's Trusted Types judge the markup first; a style's
					// stand-in writes the inject's own, known by its element, or, once
					// the written page is parsed again and the running script is a
					// fresh one, by the markup it writes: isOwnInjector)
					const written = htmlString(args[0]);
					const markup =
						ownScripts.has(that) || isOwnInjector(written)
							? written
							: moduleClient.trustedValue(
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
						throw withStack(
							new realm.DOMException(
								"Failed to set the 'outerHTML' property on 'Element': This element's parent is a Document, which may not be modified.",
								'NoModificationAllowedError',
							),
						);
					that.replaceWith(
						cloneRawNode(
							parseHTMLFragmentIn(
								markup,
								parentType === 1 ? (parent as Element) : null,
								realm.document,
							),
							realm.document,
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
		// A <noscript> whose markup would end early in the page (where
		// scripting is on, and its markup is text up to the first
		// `</noscript`) is emptied first (closeNoscripts). (`scripts`: the
		// markup's scripts may run, runScripts, so they are rewritten as a
		// written page's are, ../markupMembers.ts settle, which may turn
		// runScripts off.)
		const rewriteMarkup = (
			markup: unknown,
			context: Element | null,
			scripts?: ScriptNotes,
		): string => {
			const inert = inertDocumentOf(realm.document);
			const div = createElementIn(inert, 'div');
			// parsed in the context the browser parses it in next, so the
			// serialisation keeps what that context keeps (a section's rows)
			// (put in by the insertion hook, as the page's own nodes are)
			Reflect.apply(markupContext.inserts[0], div, [
				cloneRawNode(
					parseHTMLFragmentIn(String(markup), context, realm.document),
					inert,
				),
			]);
			closeNoscripts(div);
			let html = moduleClient.innerHTMLOf(div);
			releaseMarkup(div);
			if (scripts) html = markupParts().settle(html, context, scripts);
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
		// That work is a deferred part (../markupSinks.ts); a call with no
		// value, or of another command, needs none: the hook coerces the value,
		// as it always did, and calls the browser's.
		const nativeExecCommand = realm.Document.prototype.execCommand;
		if (typeof nativeExecCommand === 'function')
			realm.Document.prototype.execCommand = proxyModule.wrapFunction(
				nativeExecCommand,
				(target, that, args) => {
					const command = String(args[0]).toLowerCase();
					if (args.length < 3 || args[2] === undefined || args[2] === null)
						return Reflect.apply(target, that, args);
					if (
						command === 'inserthtml' ||
						command === 'insertimage' ||
						command === 'createlink'
					)
						return sinks().execCommand(target, that, args, command);
					// (coerced before the browser coerces it again, as the part does)
					String(args[2]);
					return Reflect.apply(target, that, args);
				},
			);
		// Range.createContextualFragment parses in the page's document, so an
		// element in the fragment starts its load as it is parsed, inserted or
		// not: the page's raw URLs went straight to the site, or unrouted to
		// the proxy origin. The markup is parsed by the browser in an inert
		// document instead, in a context element of the range's kind (a <tr>
		// for a table section parses as one), and the nodes are made in the
		// page's document through the hooks. Scripts in it run when the page
		// inserts them, rewritten then, as natively.
		const RangeProto = realm.Range?.prototype;
		if (typeof RangeProto?.createContextualFragment === 'function')
			RangeProto.createContextualFragment = proxyModule.wrapFunction(
				RangeProto.createContextualFragment,
				(target, that: Range, args) =>
					sinks().contextualFragment(target, that, args),
			);
		const hookedInnerHTMLSet = Reflect.getOwnPropertyDescriptor(
			realm.Element.prototype,
			'innerHTML',
		)!.set!;
		const shadowRootPrototype = (realm as { ShadowRoot?: typeof ShadowRoot })
			.ShadowRoot?.prototype;
		// Markup insertion members the inject does not hook are taken off the
		// page's prototypes, so markup never reaches the browser's parser with
		// no hook in the way (an `<img onerror>` or, with runScripts, a
		// `<script>` in it ran as the page wrote it, and its loads went out
		// unrouted): a member a later Chrome adds reads as absent until it is
		// hooked. Chrome 157's insertion members on Element, ShadowRoot and
		// CharacterData are hooked below.
		const global = realm;
		const characterDataPrototype = (
			global as { CharacterData?: typeof CharacterData }
		).CharacterData?.prototype;
		const insertionPrototypes: (object | undefined)[] = [
			global.Element.prototype,
			shadowRootPrototype,
			characterDataPrototype,
		];
		for (const proto of [
			...insertionPrototypes,
			global.DocumentFragment.prototype,
			global.Document.prototype,
			global.Node.prototype,
		]) {
			if (!proto) continue;
			const insertions = insertionPrototypes.includes(proto);
			for (const name of Reflect.ownKeys(proto))
				if (
					typeof name === 'string' &&
					name.includes('HTML') &&
					!HOOKED_MARKUP_MEMBERS.has(name) &&
					!(insertions && MARKUP_INSERTION.test(name))
				)
					Reflect.deleteProperty(proto, name);
		}
		// appendHTML(Unsafe), prependHTML, beforeHTML, afterHTML,
		// replaceWithHTML and their stream* forms: the Unsafe ones as
		// setHTMLUnsafe (the markup rewritten, then the browser's parser), the
		// safe ones as setHTML (sanitized by the browser in an inert copy, what
		// it leaves put in through the insertion hooks). The work is a deferred
		// part of the bundle (../markupMembers.ts), made at the page's first
		// call; what it needs that a page could replace is taken now, before
		// any page script ran, in as little code as can take it (a frame
		// compiles what runs here: each kilobyte of it was a kilobyte of every
		// frame's heap).
		const markupContext: MarkupContext = {
			client: moduleClient,
			rewrite: rewriteMarkup,
			natives: [],
			ends: [],
			inserts: [],
			shadowHost:
				shadowRootPrototype &&
				Reflect.getOwnPropertyDescriptor(shadowRootPrototype, 'host')?.get,
			contentOf: nativeGetter(nativeHTMLTemplateElement, 'content'),
			importNode: global.Document.prototype.importNode,
			nativeNode,
			nativeElement,
		};
		for (const proto of [
			global.Element.prototype,
			global.DocumentFragment.prototype,
			global.CharacterData.prototype,
		])
			for (const name of MARKUP_INSERTS)
				markupContext.inserts.push(
					(proto as unknown as Record<string, Fn>)[name],
				);
		let made: ReturnType<DeferredParts['markupMembers']> | null = null;
		const markupParts = () =>
			(made ??= deferred('markupMembers')(markupContext));
		// one call for every wrapper: the native it wraps says which member it
		// is (its name), and its place in `natives` whose interface (`ends`:
		// where each prototype's natives end)
		const markupCall = (target: Fn, that: unknown, args: unknown[]) => {
			const own = this.ownMember(that, target.name);
			return own
				? Reflect.apply(own, that, args)
				: markupParts().member(target, that as Node, args);
		};
		for (const proto of insertionPrototypes) {
			if (proto)
				for (const name of Reflect.ownKeys(proto)) {
					if (typeof name !== 'string' || !MARKUP_INSERTION.test(name))
						continue;
					const native = (proto as unknown as Record<string, unknown>)[name];
					if (typeof native !== 'function') continue;
					markupContext.natives.push(native as Fn);
					(proto as unknown as Record<string, unknown>)[name] =
						proxyModule.wrapFunction(native as Fn, markupCall);
				}
			markupContext.ends.push(markupContext.natives.length);
		}
		// setHTMLUnsafe: the markup rewritten (its scripts too, with
		// runScripts), then the browser's parser (../markupSinks.ts)
		const setHTMLUnsafeCall = (target: Fn, that: unknown, args: unknown[]) => {
			const own = this.ownMember(that, 'setHTMLUnsafe');
			return own
				? Reflect.apply(own, that, args)
				: sinks().setHTMLUnsafe(target, that, args);
		};
		for (const proto of [realm.Element.prototype, shadowRootPrototype]) {
			const native = (proto as { setHTMLUnsafe?: unknown } | undefined)
				?.setHTMLUnsafe;
			if (typeof native !== 'function') continue;
			(proto as { setHTMLUnsafe: unknown }).setHTMLUnsafe =
				proxyModule.wrapFunction(native as Fn, setHTMLUnsafeCall);
		}
		// setHTML is the setter that sanitizes: the browser parses the markup
		// in the element's context and keeps what its sanitizer allows. On the
		// page's own element that leaves nodes as the page wrote them (a link
		// to the address in the markup, where the proxy's own origin answers),
		// and rewriting the markup first would hand the sanitizer attributes
		// it drops. So the browser sanitizes into a copy of the element in the
		// inert document, where nothing loads, and what it leaves goes in
		// through the insertion hook, like the nodes of any other parser
		// (../markupSinks.ts; a wrapper of Element's setHTML is Element's,
		// any other ShadowRoot's).
		const elementSetHTML = (realm.Element.prototype as { setHTML?: unknown })
			.setHTML as Fn | undefined;
		const hookedReplaceChildren = {
			element: realm.Element.prototype.replaceChildren,
			fragment: realm.DocumentFragment.prototype.replaceChildren,
		};
		const hookedTextContent = Reflect.getOwnPropertyDescriptor(
			realm.Node.prototype,
			'textContent',
		)!;
		const setHTMLCall = (target: Fn, that: unknown, args: unknown[]) =>
			sinks().setHTML(target, that, args);
		for (const proto of [realm.Element.prototype, shadowRootPrototype]) {
			const native = (proto as { setHTML?: unknown } | undefined)?.setHTML;
			if (typeof native !== 'function' || typeof elementSetHTML !== 'function')
				continue;
			(proto as unknown as { setHTML: unknown }).setHTML =
				proxyModule.wrapFunction(native as Fn, setHTMLCall);
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
						const div = this.inertCopy(realm.document.createElement('div'));
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
						const own = this.ownMember(that, 'innerHTML', true);
						if (own) return Reflect.apply(own, that, args);
						const markup = moduleClient.trustedValue(
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
						// (in a document no worker controls, the loads' copies)
						moduleClient.writtenLoads?.(that);
						moduleClient.sweepFrames?.();
					},
				),
			});

		realm.Element.prototype.getAttributeNS = proxyModule.wrapFunction(
			realm.Element.prototype.getAttributeNS,
			(target, that: Element, args) => {
				if (
					args.length >= 2 &&
					(args[0] === null || args[0] === '') &&
					that instanceof realm.Element
				) {
					// the attribute of no namespace by exactly that local name
					// (getAttribute lowercases on an HTML element and finds the
					// first of any namespace by its qualified name): the page's
					// value when a hook rewrote it or dropped it
					const value = Reflect.apply(target, that, args) as string | null;
					const local = String(args[1]);
					if (isMarker(local) || isHidden(that, local)) return null;
					// a marker is named as the hooks name the attribute
					// (lowercased on an HTML element), and a name taken by an
					// attribute of a namespace is not one a hook dropped
					if (
						attributeName(that, local) !== local ||
						(value === null &&
							Reflect.apply(nativeElement.hasAttribute, that, [local]))
					)
						return value;
					const original = pendingAttributes(that)
						? usePrototype(that, CustomElement.prototype, (element) =>
								element.getAttributeOG(local),
							)
						: Reflect.apply(nativeElement.getAttribute, that, [
								markerPrefix() + local,
							]);
					if (original !== null) return original;
					// a style the browser serialised from a CSSOM write, as
					// getAttribute reads it
					return local === 'style' && typeof value === 'string'
						? unrouteCSS(moduleClient, value, true)
						: value;
				}
				// a namespaced attribute a hook rewrote (xlink:href): the page's
				// value, by the attribute's qualified name, or by the xlink prefix
				// while a load's copy is on its way and the attribute is gone
				const value = Reflect.apply(target, that, args);
				if (args.length < 2 || !(that instanceof realm.Element)) return value;
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

		realm.Element.prototype.getAttribute = proxyModule.wrapFunction(
			realm.Element.prototype.getAttribute,
			(target, that: Element, args) => {
				// only side effect this getter has is the potential to throw an illegal invocation error
				Reflect.apply(target, that, args);

				const attribute = attributeName(that, String(args[0]));
				if (isMarker(attribute) || isHidden(that, attribute)) return null;

				// no hook is working on the element: the DOM is the hooks'
				// view, read natively without a prototype swap
				if (!pendingAttributes(that)) {
					const marker = markerPrefix() + attribute;
					if (Reflect.apply(nativeElement.hasAttribute, that, [marker]))
						return Reflect.apply(nativeElement.getAttribute, that, [marker]);
					const value = Reflect.apply(nativeElement.getAttribute, that, [
						attribute,
					]);
					return attribute === 'style' && typeof value === 'string'
						? unrouteCSS(moduleClient, value, true)
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
						? unrouteCSS(moduleClient, value, true)
						: value;
				});
			},
		);

		// What the page reads back must be what it wrote: the marker attributes
		// (`s_o:*`) never show, values come from the markers, and markup is
		// serialised from a copy with the markers folded back in.
		const isMarker = (name: unknown) =>
			typeof name === 'string' && name.startsWith(markerPrefix());
		// the name a call acts on is lowercased on an HTML element, so
		// `S_O:HREF` names a marker there too
		const isMarkerOn = (element: unknown, name: unknown) =>
			typeof name === 'string' && isMarker(attributeName(element, name));

		realm.Element.prototype.hasAttribute = proxyModule.wrapFunction(
			realm.Element.prototype.hasAttribute,
			(target, that, args) => {
				const native = Reflect.apply(target, that, args);
				if (isMarkerOn(that, args[0]) || isHiddenOn(that, args[0]))
					return false;
				// an attribute a hook dropped (iframe sandbox, an object's data)
				// is still there for the page
				if (native) return native;
				const attribute = attributeName(that, String(args[0]));
				if (!pendingAttributes(that))
					return Reflect.apply(nativeElement.hasAttribute, that, [
						markerPrefix() + attribute,
					]);
				return usePrototype(that, CustomElement.prototype, (element) =>
					element.hasAttributeOG(attribute),
				);
			},
		);

		realm.Element.prototype.getAttributeNode = proxyModule.wrapFunction(
			realm.Element.prototype.getAttributeNode,
			(target, that, args) => {
				const node = Reflect.apply(target, that, args);
				return isMarkerOn(that, args[0]) || isHiddenOn(that, args[0])
					? null
					: node;
			},
		);
		// by no namespace and a local name: a marker, or an attribute the page
		// does not have, is none, and stays
		for (const method of [
			'getAttributeNodeNS',
			'hasAttributeNS',
			'removeAttributeNS',
		] as const)
			(realm.Element.prototype as any)[method] = proxyModule.wrapFunction(
				realm.Element.prototype[method],
				(target, that, args) =>
					(args[0] === null || args[0] === '') &&
					args.length > 1 &&
					that instanceof realm.Element &&
					(isMarker(args[1]) || isHidden(that, args[1]))
						? method === 'getAttributeNodeNS'
							? null
							: method === 'hasAttributeNS'
								? false
								: undefined
						: Reflect.apply(target, that, args),
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
					const marker = names.indexOf(`${markerPrefix()}${name}`);
					if (marker === -1 || marker > index) result.push(name);
				} else {
					const base = names.indexOf(name.slice(markerPrefix().length));
					if (base === -1 || base > index)
						result.push(name.slice(markerPrefix().length));
				}
			});
			return result;
		};

		realm.Element.prototype.getAttributeNames = proxyModule.wrapFunction(
			realm.Element.prototype.getAttributeNames,
			(target, that, args) =>
				visibleNames(Reflect.apply(target, that, args) as string[]).filter(
					(name) => !isHidden(that, name),
				),
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
						? unrouteCSS(moduleClient, native, true)
						: native,
			);
		};
		for (const [proto, property] of [
			[realm.Attr.prototype, 'value'],
			[realm.Node.prototype, 'nodeValue'],
			[realm.Node.prototype, 'textContent'],
		] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, property)!;
			Reflect.defineProperty(proto, property, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get!, (target, that, args) => {
					const native = Reflect.apply(target, that, args);
					return that instanceof realm.Attr ? attrValue(that, native) : native;
				}),
				// writing an attribute node is writing the attribute: through the
				// owner's hooked setAttribute, so src, on* and srcdoc are rewritten
				set: proxyModule.wrapFunction(descriptor.set!, (target, that, args) => {
					if (that instanceof realm.Attr && that.ownerElement) {
						that.ownerElement.setAttribute(that.name, String(args[0]));
						return;
					}
					return Reflect.apply(target, that, args);
				}),
			});
		}

		// Element.attributes: a view of the map without the markers
		const attributeMaps = new LazyWeakMap<NamedNodeMap, NamedNodeMap>();
		const views = new LazyWeakMap<object, AttributeView>();
		/** the element's hooked setAttributeNode and setAttributeNodeNS, once they are wrapped below */
		const setNamedItems: {
			setAttributeNode?: Element['setAttributeNode'];
			setAttributeNodeNS?: Element['setAttributeNodeNS'];
		} = {};
		const standIns = new LazyWeakMap<Attr, Attr>();
		const nativeCreateAttribute = realm.Document.prototype.createAttribute;
		const nativeOwnerDocument = Reflect.getOwnPropertyDescriptor(
			realm.Node.prototype,
			'ownerDocument',
		)!.get!;
		const attributesDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.Element.prototype,
			'attributes',
		)!;
		Reflect.defineProperty(realm.Element.prototype, 'attributes', {
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
									if (!isHidden(owner, attr.name)) result.push(attr);
									continue;
								}
								const base = attr.name.slice(markerPrefix().length);
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
						// a name the page has no attribute by
						const unseen = (key: string | symbol) =>
							typeof key === 'string' &&
							(isMarker(key) || isHidden(owner, key));
						const view = new Proxy(map, {
							get: (map, key) => {
								if (key === 'length') return visible().length;
								if (typeof key === 'string' && /^\d+$/.test(key))
									return visible()[Number(key)];
								if (unseen(key)) return undefined;
								// the methods are the prototype's own (map.item is
								// NamedNodeMap.prototype.item), which act on the view
								// when it is their receiver (viewMethods below), and
								// the iterator is Array.prototype.values over it
								const value = Reflect.get(map, key);
								if (value === undefined && typeof key === 'string')
									return named(key);
								return value;
							},
							has: (map, key) =>
								typeof key === 'string' && /^\d+$/.test(key)
									? Number(key) < visible().length
									: unseen(key)
										? false
										: Reflect.has(map, key) ||
											(typeof key === 'string' && !!named(key)),
							// the names as the page's attributes have them: a
							// marker's for an attribute a hook dropped
							ownKeys: (map) => {
								const keys = Reflect.ownKeys(map);
								return [
									...visible().map((_, i) => String(i)),
									...keys.flatMap((key): (string | symbol)[] => {
										if (typeof key !== 'string') return [key];
										if (/^\d+$/.test(key) || isHidden(owner, key)) return [];
										if (!isMarker(key)) return [key];
										const base = key.slice(markerPrefix().length);
										return keys.includes(base) ? [] : [base];
									}),
								];
							},
						});
						views.set(view, { map, owner, visible, named });
						attributeMaps.set(map, view);
					}
					return attributeMaps.get(map)!;
				},
			),
		});
		// NamedNodeMap's methods called on a view: the view's own
		// (../attributeViewMethods.ts, a deferred part, at the first call),
		// anything else on the map itself
		let viewMethods: Record<string, ViewMethod> | null = null;
		const VIEW_METHODS = [
			'item',
			'getNamedItem',
			'getNamedItemNS',
			'removeNamedItem',
			'removeNamedItemNS',
			'setNamedItem',
			'setNamedItemNS',
		];
		const namedNodeMap = realm.NamedNodeMap.prototype;
		const nativeNamedNodeMap: Record<string, unknown> = {};
		// one call for every method, which reads which one it is from the
		// native it wraps
		const namedNodeMapMethod = (
			target: Function,
			that: any,
			args: unknown[],
		) => {
			const view = views.get(that);
			// no argument: the browser's own TypeError
			if (!view || !args.length)
				return Reflect.apply(target, view?.map ?? that, args);
			const key: string = target.name;
			return VIEW_METHODS.includes(key)
				? (viewMethods ??= deferred('attributeViewMethods')({
						isMarkerOn,
						isHiddenOn,
						empty: () =>
							Reflect.apply(
								attributesDescriptor.get!,
								createElementIn(inertDocumentOf(realm.document), 'div'),
								[],
							) as NamedNodeMap,
						attributeName,
						Attr: realm.Attr,
						nativeNamedNodeMap,
						setNamedItems,
					}))[key](view, args, key)
				: Reflect.apply(target, view.map, args);
		};
		for (const key of Reflect.ownKeys(namedNodeMap)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(namedNodeMap, key)!;
			if (
				typeof key !== 'string' ||
				key === 'constructor' ||
				typeof descriptor.value !== 'function'
			)
				continue;
			nativeNamedNodeMap[key] = descriptor.value;
			Reflect.defineProperty(namedNodeMap, key, {
				...descriptor,
				value: proxyModule.wrapFunction(descriptor.value, namedNodeMapMethod),
			});
		}

		// markup as the page wrote it: a copy with every marker folded back,
		// template contents included (their elements are not descendants)
		const nativeQueryAll = {
			element: nativeElement.querySelectorAll,
			document: realm.Document.prototype.querySelectorAll,
			fragment: realm.DocumentFragment.prototype.querySelectorAll,
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
			realm.HTMLTemplateElement.prototype,
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
								const base = name.slice(markerPrefix().length);
								const at = names.indexOf(base);
								if (at === -1 || at > names.indexOf(name)) dropped = true;
								node.setAttribute(base, node.getAttribute(name)!);
								node.removeAttribute(name);
							}
						// a type the page has none of (isHidden)
						if (isHiddenValue(node.getAttribute('type')))
							node.removeAttribute('type');
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
		const nativeImportNode = realm.Document.prototype.importNode;
		const nativeContentType = Reflect.getOwnPropertyDescriptor(
			realm.Document.prototype,
			'contentType',
		)!.get!;
		const implementation = realm.document.implementation;
		const inertDocuments: { html?: Document; xml?: Document } = {};
		const inertDocumentFor = (node: Node) => {
			const owner = (
				node.nodeType === 9 ? node : node.ownerDocument
			) as Document | null;
			const html =
				!owner || Reflect.apply(nativeContentType, owner, []) === 'text/html';
			return html
				? (inertDocuments.html ??= Reflect.apply(
						realm.DOMImplementation.prototype.createHTMLDocument,
						implementation,
						[''],
					) as Document)
				: (inertDocuments.xml ??= Reflect.apply(
						realm.DOMImplementation.prototype.createDocument,
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
		// serialize attached to the copy of its host; and XMLSerializer: the
		// same folded copy, serialised as XML (../markupSinks.ts). What the
		// part reads back is finished by foldMarkup, as the readback modules
		// rewrap it (CSS), read at the call
		this.foldMarkup = (html: string): string => html;
		const elementGetHTML = (realm.Element.prototype as { getHTML?: unknown })
			.getHTML as Fn | undefined;
		const sinkContext: SinkContext = {
			hooks: this,
			markup: markupContext,
			members: markupParts,
			setStyleText,
			innerHTMLSet: hookedInnerHTMLSet,
			replaceChildren: hookedReplaceChildren,
			textContent: hookedTextContent,
			elementSetHTML,
			elementGetHTML,
			domainGet: domainDescriptor.get!,
			getSelection: realm.Document.prototype.getSelection,
			querySelectorAll: nativeQueryAll.document,
			foldMarkers,
			querySelectorAllOf,
			inertDocumentFor,
		};
		const getHTMLCall = (target: Fn, that: unknown, args: unknown[]) =>
			sinks().getHTML(target, that, args);
		for (const proto of [
			realm.Element.prototype,
			(realm as { ShadowRoot?: typeof ShadowRoot }).ShadowRoot?.prototype,
		]) {
			const getHTML = (proto as { getHTML?: unknown } | undefined)?.getHTML;
			if (typeof getHTML !== 'function') continue;
			(proto as { getHTML: unknown }).getHTML = proxyModule.wrapFunction(
				getHTML as Fn,
				getHTMLCall,
			);
		}

		realm.XMLSerializer.prototype.serializeToString = proxyModule.wrapFunction(
			realm.XMLSerializer.prototype.serializeToString,
			(target, that, args) => sinks().serializeToString(target, that, args),
		);

		// attribute selectors match the page's values: `[href="/x"]` is
		// `[s_o:href="/x"]` on a rewritten element, `[href="/x"]` on one that
		// was never rewritten
		const SELECTOR_ATTRIBUTE =
			/\[\s*([A-Za-z_][\w-]*)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]\s]+)\s*([isIS])?)?\s*\]/g;
		const marker = markerPrefix().replace(':', '\\:');
		const rewriteSelector = (selector: unknown): string =>
			String(selector).replace(
				SELECTOR_ATTRIBUTE,
				(match, name, op = '', value = '', flag = '') => {
					const rest = op ? `${op}${value}${flag ? ` ${flag}` : ''}` : '';
					// (and not a type the page has none of, isHidden)
					const hidden = /^type$/i.test(name)
						? `:not([${name}$="${hiddenSuffix()}"])`
						: '';
					return `:is([${marker}${name}${rest}],[${name}${rest}]:not([${marker}${name}])${hidden})`;
				},
			);
		const selectorCall = (target: Function, that: unknown, args: unknown[]) => {
			if (args.length) args[0] = rewriteSelector(args[0]);
			return Reflect.apply(target, that, args);
		};
		for (const proto of [
			realm.Element.prototype,
			realm.Document.prototype,
			realm.DocumentFragment.prototype,
		])
			for (const method of [
				'querySelector',
				'querySelectorAll',
				'matches',
				'webkitMatchesSelector',
				'closest',
			] as const) {
				const native = (proto as any)[method];
				if (typeof native !== 'function') continue;
				(proto as any)[method] = proxyModule.wrapFunction(native, selectorCall);
			}

		// the other ways to set an attribute all end in the same hooks
		// A hooked attribute (xlink:href) never reaches the element as the page
		// wrote it: an SVG <use> fetches its reference the moment the attribute
		// lands, before a hook could route it, and against the document's
		// route. The namespaced attribute is made empty (no reference), then
		// the value is written through the hooks, as setAttribute does
		realm.Element.prototype.setAttributeNS = proxyModule.wrapFunction(
			realm.Element.prototype.setAttributeNS,
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
						const passed = moduleClient.trustedValue(
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
						!(that instanceof realm.Element) ||
						!(
							this.attributeHooks(that, name).length ||
							(args[0] === XLINK_NAMESPACE && otherXlinkPrefix(name))
						)
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
		realm.Element.prototype.toggleAttribute = proxyModule.wrapFunction(
			realm.Element.prototype.toggleAttribute,
			(target, that: Element, args) => {
				// one the page has none of is added empty, or with force false
				// stays none
				if (isHiddenOn(that, args[0])) {
					if (args.length > 1 && !args[1]) return false;
					pageWrite(that, 'type', () =>
						usePrototype(that, CustomElement.prototype, (element) => {
							element.setAttribute('type', '');
							this.updateAttributeHooks(element, 'type');
						}),
					);
					return true;
				}
				return pageWrite(that, String(args[0]), () => {
					const result = Reflect.apply(target, that, args);
					usePrototype(that, CustomElement.prototype, (element) =>
						this.updateAttributeHooks(
							element,
							attributeName(that, String(args[0])),
						),
					);
					return result;
				});
			},
		);
		// setAttributeNode and setAttributeNodeNS are one algorithm, and an
		// attribute map's setNamedItem and setNamedItemNS are the same one
		// again (setNamedItems, read by the attributes view)
		for (const method of ['setAttributeNode', 'setAttributeNodeNS'] as const)
			realm.Element.prototype[method] = setNamedItems[method] =
				proxyModule.wrapFunction(
					realm.Element.prototype[method],
					(target, that: Element, args) => {
						const name = (args[0] as Attr)?.name;
						// (it replaces no attribute of the page's)
						const hidden = isHiddenOn(that, name);
						const write = () => {
							const result = Reflect.apply(target, that, args);
							if (name)
								usePrototype(that, CustomElement.prototype, (element) =>
									this.updateAttributeHooks(element, name),
								);
							return result;
						};
						const result = name ? pageWrite(that, name, write) : write();
						return hidden ? null : result;
					},
				);

		realm.Element.prototype.setAttribute = proxyModule.wrapFunction(
			realm.Element.prototype.setAttribute,
			(target, that: Element, args) => {
				// the native's side effects are the hooks' to decide, so it is
				// not called first; what it would refuse is: a call without
				// both arguments (the browser's own error, for the receiver or
				// for the count, whichever it checks first) and a receiver
				// that is no element
				if (args.length < 2) return Reflect.apply(target, that, args);
				requireElement(that);

				// the hooks are keyed by the name the attribute gets:
				// `setAttribute('HREF', x)` writes `href`.
				// The value is the string the browser makes of it (an object's
				// toString, a TrustedScriptURL): the hooks compare it with '' and
				// resolve it, and an object that reads as '' was taken for a URL,
				// the document's own, which an image then loaded
				let value = args.length < 2 ? args[1] : `${args[1]}`;
				const attribute =
					typeof args[0] === 'string' ? attributeName(that, args[0]) : args[0];
				// the page's Trusted Types judge a handler, a script's src, a
				// frame's srcdoc (its value went to a string once, above:
				// a trusted value's string is its own)
				const sink =
					args.length > 1 && typeof attribute === 'string' && !isParsed(that)
						? trustedSink(that, attribute)
						: null;
				if (sink) {
					const passed = moduleClient.trustedValue(
						args[1],
						TRUSTED_KINDS[sink[0]],
						sink[1],
						() => Reflect.apply(target, that, args),
						() => value as string,
						true,
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
					moduleClient.refuseStyleAttribute(that, value)
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
						try {
							return applyAttribute(that, attribute, value, true);
						} catch (error) {
							// an invalid name: the browser's own error, which names
							// the attribute as the page wrote it, not lowercased. It
							// is asked of an element of an inert document (and with
							// no value, which the page's object would be read for):
							// a name the browser takes writes nothing there, and the
							// page's value is never written unrewritten on its own
							// element when the failure was not its name (a builtin
							// the page replaced and the hooks asked)
							Reflect.apply(
								target,
								createElementIn(inertDocumentOf(realm.document), 'div'),
								[args[0], ''],
							);
							return;
						}
					usePrototype(that, CustomElement.prototype, (element) => {
						element.setAttribute(attribute, value);

						this.updateAttributeHooks(element, attribute);
					});
				});
			},
		);

		realm.Element.prototype.removeAttribute = proxyModule.wrapFunction(
			realm.Element.prototype.removeAttribute,
			(target, that: Element, args) => {
				// (as setAttribute: the browser's own refusals first)
				if (args.length < 1) return Reflect.apply(target, that, args);
				requireElement(that);

				const attribute =
					typeof args[0] === 'string' ? attributeName(that, args[0]) : args[0];
				// one the page has none of: nothing to remove
				if (isHidden(that, attribute)) return;

				pageWrite(that, attribute, () => {
					if (
						typeof attribute === 'string' &&
						!pendingAttributes(that) &&
						!this.hooksAttribute(attribute)
					) {
						// in the order the hooks' view applies them
						applyAttribute(that, attribute, null);
						applyAttribute(that, markerPrefix() + attribute, null);
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

		// each hooked property's interface, name and native getter, by its native
		// getter and setter, for the one getter and one setter call every
		// property's wrappers make (two calls of their own for each property
		// were some 90 closures and their scopes in every frame)
		const tracked = new LazyWeakMap<
			Function,
			{ ctor: ElementCtor; property: string; get: Function }
		>();
		const propertyGet = (target: Function, that: any, args: unknown[]) => {
			const { ctor, property } = tracked.get(target)!;
			// a receiver that is plainly no element of this interface
			// (the prototype itself, as a script that tests for hooks
			// calls it): the browser refuses it before any hook runs
			if (!inherits(that, ctor)) Reflect.apply(target, that, args);
			const entries = this.#propertyHooks(property);
			if (
				!pendingAttributes(that) &&
				entries.every((entry) => entry.hook[2] === nativeRead)
			) {
				const value = Reflect.apply(target, that, args);
				return typeof value === 'string' ? this.readbackURL(value) : value;
			}
			return usePrototype(that, CustomElement.prototype, (element) => {
				for (const entry of entries) {
					let result: string | boolean;
					try {
						result = (entry.hook as PropertyHook)[2](element);
					} catch (error) {
						// the page's value is no URL (`http://a:b/`, a
						// relative one under `<base href="about:blank">`):
						// the property is then the attribute as written
						const written = this.#unparsed(
							element,
							propertyAttribute(property),
						);
						if (written === null) throw error;
						return written;
					}

					if (result === false) continue;

					return result;
				}

				// no hook answered (the attribute is missing or empty): the
				// browser's value for a URL property is then the document's
				// own URL or base URL, which is a route, and is read back as
				// the page's
				const value = Reflect.apply(target, that, args);
				return typeof value === 'string' ? this.readbackURL(value) : value;
			});
		};
		const propertySet = (target: Function, that: any, args: unknown[]) => {
			const { ctor, property, get } = tracked.get(target)!;
			// (the getter refuses what the setter would, and writes
			// nothing)
			if (!inherits(that, ctor)) Reflect.apply(get, that, []);
			// one write for the page's observers, however many it takes
			return pageWrite(that, propertyAttribute(property), () => {
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
					? moduleClient.trustedValue(
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
					if (property !== 'style') element.setAttribute(attribute, written);
					this.updatePropertyHooks(element, ctor, property);
					untouched =
						property !== 'style' && element.getAttribute(attribute) === written;
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
				const value = Reflect.apply(get, that, []);

				// nor one a hook removed (a load whose proxied copy is still on
				// its way): written back it would be an empty URL, which a
				// script reports as an error and never loads again
				// A base's href took effect with its attribute, and written
				// again it is judged again (base-uri, a violation each time)
				if (
					typeof value === 'string' &&
					written !== '' &&
					value !== '' &&
					ctor !== realm.HTMLBaseElement
				)
					Reflect.apply(target, that, [
						sink ? trustedOf(sink[0], value) : value,
					]);
			});
		};
		const wrapProperty = (ctor: ElementCtor, property: string) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				ctor.prototype,
				property,
			);

			if (!descriptor) {
				throw new Error(`Ctor ${ctor} did not have ${property}`);
			}

			const record = { ctor, property, get: descriptor.get! };
			tracked.set(descriptor.get!, record);
			tracked.set(descriptor.set!, record);
			Reflect.defineProperty(ctor.prototype, property, {
				enumerable: true,
				configurable: true,
				get: proxyModule.wrapFunction(descriptor.get!, propertyGet),
				set: proxyModule.wrapFunction(descriptor.set!, propertySet),
			});
		};
		for (const [ctor, properties] of trackProperties)
			for (const property of properties) wrapProperty(ctor, property);
		this.#wrapProperty = wrapProperty;
	}
}
