import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule, {
	applyDescriptors,
	cleanupPrototype,
	usePrototype,
} from '../../modules/Proxy';
import DocumentClient, {
	getGlobalParsingState,
	runDocumentOpenListeners,
	setGlobalParsingState,
} from '../Client';
import cloneRawNode, { parseHTMLFragment } from '../cloneNode';

const attributeTab = new WeakMap<CustomElement, Map<string, string | null>>();
// the value last applied to each hooked attribute (the routed one), so a
// hook can tell an attribute it wrote from one the page changed since
const appliedTab = new WeakMap<Element, Map<string, string | null>>();

const ORIGINAL_ATTRIBUTE = `s_o:`;

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

		for (const [attribute, value] of tab) {
			tab.delete(attribute);

			try {
				if (value === null) {
					nativeElement.removeAttribute.call(this, attribute);
				} else {
					nativeElement.setAttribute.call(this, attribute, value);
				}
				if (!appliedTab.has(this)) appliedTab.set(this, new Map());
				appliedTab.get(this)!.set(attribute, value);
			} catch (error) {
				console.warn('bad attribute', attribute, value, error);
			}
		}

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

type HookCallback = (element: CustomElement) => void;

type AttributeHook = [nodeName: Element['nodeName'], attribute: string];

/**
 * This function is called when the property is accessed on the specified element ctor. If false, the next property hook getter will be called until the result is a string.
 */
type PropertyHookGetter = (element: CustomElement) => string | false;

type PropertyHook = [
	ctor: ElementCtor,
	property: string,
	getter: PropertyHookGetter,
];

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
	private hooks: {
		hook: AttributeHook | PropertyHook;
		callback: HookCallback;
	}[];
	constructor(client: DocumentClient) {
		super(client);

		this.hooks = [];
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
	}
	updateAttributeHooks(element: CustomElement, attribute: string) {
		for (const entry of this.hooks) {
			if (
				!isAttributeHook(entry.hook) ||
				(entry.hook[0] !== '*' && entry.hook[0] !== element.nodeName) ||
				entry.hook[1] !== attribute
			)
				continue;

			entry.callback(element);
		}
	}
	private updatePropertyHooks(
		element: CustomElement,
		ctor: ElementCtor,
		property: string,
	) {
		for (const entry of this.hooks) {
			if (
				isAttributeHook(entry.hook) ||
				entry.hook[0] !== ctor ||
				entry.hook[1] !== property
			)
				continue;

			entry.callback(element);
		}
	}
	apply() {
		// all hooks are in, now apply them

		// MutationObserver will leak a lot of values and is complex.. we cannot support this yet.
		// delete (this.client.global as any).MutationObserver;

		const proxyModule = this.client.getModule(ProxyModule)!;

		/**
		 * Etc hooks are here
		 */

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
				const result = Reflect.apply(target, that, args);
				if (that === this.client.global.document)
					runDocumentOpenListeners(this.client.global);
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
					destination = new URL(String(args[0]), this.client.url.toString());
				const routable =
					destination !== null && /^https?:$/.test(destination.protocol);
				// a javascript: URL runs in the opened window: rewritten, like a
				// javascript: link (routeHTML rewrites its body)
				if (destination !== null && destination.protocol === 'javascript:')
					args[0] = routeHTML(
						new StompURL(destination, this.client.url),
						this.client.url,
						this.client.config,
						false,
						this.client.nestedRoute,
					);
				// a new tab: the host's to open, when it said so (then the page
				// sees null, as with a popup blocker)
				if (
					routable &&
					!['_self', '_top', '_parent', '_unfencedtop'].includes(
						name.toLowerCase(),
					) &&
					this.client.openInHost(destination!.toString())
				)
					return null;

				if (routable)
					args[0] = routeHTML(
						new StompURL(destination!, this.client.url),
						this.client.url,
						this.client.config,
						false,
						this.client.nestedRoute,
					);

				// a top-level page is its own top and parent: navigate the frame
				if (
					args[1] !== undefined &&
					['_top', '_parent', '_unfencedtop'].includes(
						String(args[1]).toLowerCase(),
					)
				)
					args[1] = '_self';

				return Reflect.apply(target, that, args);
			},
		);

		type Write = (...text: string[]) => void;
		const writeFactory = (target: Write): Write =>
			proxyModule.wrapFunction(target, (target, that, args) => {
				for (let i = 0; i < args.length; i++) {
					const prevState = getGlobalParsingState(this.client.global);
					setGlobalParsingState(this.client.global, 'parsingBeforeWrite');
					// the client's document (this hook also serves a child frame the
					// parent injected); scripts in the markup run when the parser
					// sees them, so they are rewritten here like the written page's
					const div = this.client.global.document.createElement('div');
					div.append(cloneRawNode(parseHTMLFragment(String(args[i]))));
					this.client.rewriteInlineScripts(div);
					args[i] = this.client.innerHTMLOf(div);
					setGlobalParsingState(this.client.global, prevState);
				}

				Reflect.apply(target, that, args);
			});

		this.client.global.document.write = writeFactory(
			this.client.global.document.write,
		);
		this.client.global.document.writeln = writeFactory(
			this.client.global.document.writeln,
		);

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
					Reflect.apply(target, that, args);
					return this.client.url.toString();
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
					return this.client.location.toString();
				},
			),
		});

		// document.domain: the page's host; setting it to the host or a parent
		// domain is accepted (and read back) like a browser does, anything else
		// is the browser's SecurityError. The native setter never runs: it
		// would act on the proxy origin, and refuses in a sandboxed frame
		const domainDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Document.prototype,
			'domain',
		)!;
		const domains = new WeakMap<Document, string>();
		Reflect.defineProperty(this.client.global.Document.prototype, 'domain', {
			enumerable: true,
			configurable: true,
			get: proxyModule.wrapFunction(
				domainDescriptor.get!,
				(target, that: Document, args) => {
					// only side effect this getter has is the potential to throw an illegal invocation error
					Reflect.apply(target, that, args);
					return domains.get(that) ?? this.client.url.url.hostname;
				},
			),
			set: proxyModule.wrapFunction(
				domainDescriptor.set!,
				(target, that: Document, args) => {
					const value = String(args[0]);
					const host = this.client.url.url.hostname;
					if (value !== host && !host.endsWith(`.${value}`))
						throw new DOMException(
							`Failed to set the 'domain' property on 'Document': '${value}' is not a suffix of '${host}'.`,
							'SecurityError',
						);
					domains.set(that, value);
				},
			),
		});

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
						// snapshot: removing while iterating the live list skips every
						// other node and leaves half the old text in place
						for (const node of [...that.childNodes]) node.remove();

						that.append(
							new Text(this.client.prepareScriptText(that, String(args[0]))),
						);
					},
				),
			},
		);

		const textContentDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Node.prototype,
			'textContent',
		)!;

		Reflect.defineProperty(this.client.global.Node.prototype, 'textContent', {
			enumerable: true,
			configurable: true,
			get: textContentDescriptor.get,
			set: proxyModule.wrapFunction(
				textContentDescriptor.set!,
				(target, that: Node, args) => {
					// only elements and fragments have children to hook (and an
					// `append`); YouTube sets textContent on Text nodes
					if (that.nodeType !== 1 && that.nodeType !== 11)
						return Reflect.apply(target, that, args);

					for (const node of [...that.childNodes]) node.remove();

					// a script's text set while it is connected runs at once
					const text =
						that instanceof this.client.global.HTMLScriptElement
							? this.client.prepareScriptText(that, String(args[0]))
							: String(args[0]);
					(that as Element).append(new Text(text));
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

						that.append(new Text(args[0]));
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
						that.replaceWith(new Text(args[0]));
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
					usePrototype(that, nativeElement, (element) => {
						if (element.nodeName === 'TEMPLATE')
							usePrototype(that, nativeHTMLTemplateElement, (element) => {
								for (const node of element.content.childNodes) node.remove();

								element.content.append(
									cloneRawNode(parseHTMLFragment(args[0])),
								);
							});
						else {
							for (const node of element.childNodes) node.remove();

							if (element.nodeName === 'SCRIPT') {
								// allow the bad practice of setting the script's innerHTML
								// scripts cannot support nodes as content
								element.append(new Text(args[0]));
							} else {
								element.append(cloneRawNode(parseHTMLFragment(args[0])));
							}
						}
					});
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
					that.replaceWith(cloneRawNode(parseHTMLFragment(args[0])));
				},
			),
		});

		// markup the browser parses itself (setHTMLUnsafe, where a
		// `<template shadowrootmode>` becomes a shadow root only in the real
		// parser; a shadow root's innerHTML): our parser rewrites it first and
		// hands over the serialisation, markers included. The fragment parser
		// never runs a script, so none is rewritten here.
		const rewriteMarkup = (markup: unknown): string => {
			const div = this.client.global.document.createElement('div');
			div.append(cloneRawNode(parseHTMLFragment(String(markup))));
			return this.client.innerHTMLOf(div);
		};
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
						if (args.length) args[0] = rewriteMarkup(args[0]);
						return Reflect.apply(target, that, args);
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
						// and their markers folded back
						const div = this.client.global.document.createElement('div');
						for (const child of that.childNodes)
							div.append(child.cloneNode(true));
						return this.serializeOriginal(div, false);
					},
				),
				set: proxyModule.wrapFunction(
					shadowInnerHTML.set,
					(target, that: ShadowRoot, args) =>
						Reflect.apply(target, that, [rewriteMarkup(args[0])]),
				),
			});

		this.client.global.Element.prototype.getAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.getAttribute,
				(target, that: Element, args) => {
					// only side effect this getter has is the potential to throw an illegal invocation error
					Reflect.apply(target, that, args);

					const attribute: string = args[0];

					return usePrototype(that, CustomElement.prototype, (element) => {
						if (element.hasAttributeOG(attribute)) {
							return element.getAttributeOG(attribute);
						} else {
							return element.getAttribute(attribute);
						}
					});
				},
			);

		// What the page reads back must be what it wrote: the marker attributes
		// (`s_o:*`) never show, values come from the markers, and markup is
		// serialised from a copy with the markers folded back in.
		const isMarker = (name: unknown) =>
			typeof name === 'string' && name.startsWith(ORIGINAL_ATTRIBUTE);

		this.client.global.Element.prototype.hasAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.hasAttribute,
				(target, that, args) =>
					isMarker(args[0])
						? false
						: Reflect.apply(target, that, args) ||
							// an attribute a hook dropped (iframe sandbox) is still
							// there for the page
							usePrototype(that, CustomElement.prototype, (element) =>
								element.hasAttributeOG(String(args[0])),
							),
			);

		this.client.global.Element.prototype.getAttributeNames =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.getAttributeNames,
				(target, that, args) =>
					(Reflect.apply(target, that, args) as string[]).filter(
						(name) => !isMarker(name),
					),
			);

		// Attr.value: the page's value when the element keeps one for it
		const attrValue = (attr: Attr, native: string | null) => {
			const owner = attr.ownerElement;
			if (!owner) return native;
			return usePrototype(owner, CustomElement.prototype, (element) =>
				element.hasAttributeOG(attr.name)
					? element.getAttributeOG(attr.name)
					: native,
			);
		};
		for (const [proto, property] of [
			[this.client.global.Attr.prototype, 'value'],
			[this.client.global.Node.prototype, 'nodeValue'],
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
						const visible = () =>
							[...map].filter((attr) => !isMarker(attr.name));
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
											isMarker(name) ? null : map.getNamedItem(name);
									if (key === Symbol.iterator)
										return function* () {
											yield* visible();
										};
									const value = Reflect.get(map, key);
									return typeof value === 'function' ? value.bind(map) : value;
								},
								has: (map, key) =>
									typeof key === 'string' && /^\d+$/.test(key)
										? Number(key) < visible().length
										: Reflect.has(map, key),
								ownKeys: (map) => [
									...visible().map((_, i) => String(i)),
									...Reflect.ownKeys(map).filter(
										(key) => typeof key !== 'string' || !/^\d+$/.test(key),
									),
								],
							}),
						);
					}
					return attributeMaps.get(map)!;
				},
			),
		});

		// markup as the page wrote it: a copy with every marker folded back
		const serializeOriginal = (element: Element, outer: boolean): string =>
			usePrototype(element, nativeElement, (native) => {
				const clone = native.cloneNode(true) as Element;
				return usePrototype(clone, nativeElement, (clone) => {
					for (const node of [clone, ...clone.querySelectorAll('*')])
						usePrototype(node, nativeElement, (node) => {
							for (const name of node.getAttributeNames())
								if (isMarker(name)) {
									node.setAttribute(
										name.slice(ORIGINAL_ATTRIBUTE.length),
										node.getAttribute(name)!,
									);
									node.removeAttribute(name);
								}
						});
					return outer ? clone.outerHTML : clone.innerHTML;
				});
			});
		this.serializeOriginal = serializeOriginal;

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
		this.client.global.Element.prototype.setAttributeNS =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.setAttributeNS,
				(target, that: Element, args) => {
					Reflect.apply(target, that, args);
					usePrototype(that, CustomElement.prototype, (element) =>
						this.updateAttributeHooks(element, String(args[1])),
					);
				},
			);
		this.client.global.Element.prototype.toggleAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.toggleAttribute,
				(target, that: Element, args) => {
					const result = Reflect.apply(target, that, args);
					usePrototype(that, CustomElement.prototype, (element) =>
						this.updateAttributeHooks(element, String(args[0])),
					);
					return result;
				},
			);
		this.client.global.Element.prototype.setAttributeNode =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.setAttributeNode,
				(target, that: Element, args) => {
					const name = (args[0] as Attr)?.name;
					const result = Reflect.apply(target, that, args);
					if (name)
						usePrototype(that, CustomElement.prototype, (element) =>
							this.updateAttributeHooks(element, name),
						);
					return result;
				},
			);

		this.client.global.Element.prototype.setAttribute =
			proxyModule.wrapFunction(
				this.client.global.Element.prototype.setAttribute,
				(target, that: Element, args) => {
					// too many side effects
					// illegal invocation error will throw by nature
					// Reflect.apply(target, that, args);

					const [attribute, value] = args;

					usePrototype(that, CustomElement.prototype, (element) => {
						element.setAttribute(attribute, value);

						this.updateAttributeHooks(element, attribute);
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

					const [attribute] = args;

					usePrototype(that, CustomElement.prototype, (element) => {
						element.removeAttribute(attribute);
						element.removeAttributeOG(attribute);
						this.updateAttributeHooks(element, attribute);
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
								for (const entry of this.hooks) {
									if (isAttributeHook(entry.hook) || entry.hook[1] !== property)
										continue;

									const result = entry.hook[2](element);

									if (result === false) continue;

									return result;
								}

								return Reflect.apply(target, that, args);
							});
						},
					),
					set: proxyModule.wrapFunction(
						descriptor.set!,
						(target, that, args) => {
							// properties are only set at the end of the stack
							// attributes differ because they will immediately have an effect and will overrule properties set in the same stack

							Reflect.apply(target, that, args);

							usePrototype(that, CustomElement.prototype, (element) => {
								this.updatePropertyHooks(element, ctor, property);
							});

							// getter isn't stack based and we can use this to make the attribute immediately take effect

							// equivalent to i.src = i.src. Not for `style`: its getter
							// returns the declaration object, and assigning that back goes
							// through PutForwards=cssText as "[object CSSStyleDeclaration]",
							// which wipes the inline style
							const value = Reflect.apply(descriptor.get!, that, []);

							if (typeof value === 'string')
								Reflect.apply(target, that, [value]);
						},
					),
				});
			}
		}
	}
}
