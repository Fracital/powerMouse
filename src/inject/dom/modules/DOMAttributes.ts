import { parseSrcset, stringifySrcset } from 'srcset';
import {
	modifyCSS,
	restoreCSSValueURLs,
	rewriteCSSValueURLs,
	routeCSS,
} from '../../../rewriteCSS';
import { modifyHTML, modifyRefresh, routeHTML } from '../../../rewriteHTML';
import { modifyJS, routeJS, ScriptType } from '../../../rewriteJS';
import { routeBinary } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';
import DOMHooksModule, { CustomElement, nativeElement } from './DOMHooks';

/** the JavaScript MIME type essences (HTML "JavaScript MIME type") */
const JS_MIME_TYPES = new Set([
	'application/ecmascript',
	'application/javascript',
	'application/x-ecmascript',
	'application/x-javascript',
	'text/ecmascript',
	'text/javascript',
	'text/javascript1.0',
	'text/javascript1.1',
	'text/javascript1.2',
	'text/javascript1.3',
	'text/javascript1.4',
	'text/javascript1.5',
	'text/jscript',
	'text/livescript',
	'text/x-ecmascript',
	'text/x-javascript',
]);

/**
 * What the browser makes of a script element's type, as Chrome does it: a
 * classic script (no type, a JavaScript MIME type in any case or spacing,
 * or the legacy `language` attribute), a module (`module` in any case, no
 * surrounding whitespace), or something that does not run.
 */
export function scriptKind(element: Element): 'classic' | 'module' | null {
	let type = element.getAttribute('type');
	if (type === null) {
		const language = element.getAttribute('language');
		type = language ? `text/${language}` : '';
	}
	if (type.toLowerCase() === 'module') return 'module';
	type = type.trim().toLowerCase();
	if (type === '') return 'classic';
	return JS_MIME_TYPES.has(type) ? 'classic' : null;
}

export function shouldRewriteScript(element: Element) {
	return scriptKind(element) !== null;
}

export function scriptType(element: Element): ScriptType {
	return scriptKind(element) === 'module' ? 'genericModule' : 'generic';
}

export default class DOMAttributesModule extends Module<DocumentClient> {
	formHook?: (element: CustomElement) => void;
	// captured before the hooks replace them, for serializeStyle
	#nativeStyle: PropertyDescriptor;
	#nativeCssText: PropertyDescriptor;
	#scratch?: HTMLElement;
	constructor(client: DocumentClient) {
		super(client);
		this.#nativeStyle = Reflect.getOwnPropertyDescriptor(
			client.global.HTMLElement.prototype,
			'style',
		)!;
		this.#nativeCssText = Reflect.getOwnPropertyDescriptor(
			client.global.CSSStyleDeclaration.prototype,
			'cssText',
		)!;
	}
	/** the style attribute the browser writes when `text` is assigned to el.style */
	serializeStyle(text: string): string {
		this.#scratch ??= this.client.global.document.createElement('div');
		Reflect.apply(
			this.#nativeCssText.set!,
			Reflect.apply(this.#nativeStyle.get!, this.#scratch, []),
			[text],
		);
		return nativeElement.getAttribute.call(this.#scratch, 'style') ?? '';
	}
	apply() {
		const domHooksModule = this.client.getModule(DOMHooksModule)!;

		// inline event handler attributes are scripts too: `onclick="top.x()"`
		// would reach the real top. Every `on*` the platform knows about, from
		// the prototypes that carry them; a hook per name, like the URL hooks
		const handlerNames = new Set<string>();
		const g = this.client.global;
		for (const owner of [
			g,
			g.Document.prototype,
			g.HTMLElement.prototype,
			g.SVGElement.prototype,
			g.Element.prototype,
			g.HTMLMediaElement.prototype,
			g.HTMLBodyElement.prototype,
		])
			for (const name of Object.getOwnPropertyNames(owner))
				if (/^on[a-z]+$/.test(name)) handlerNames.add(name);
		for (const name of handlerNames)
			domHooksModule.useAttributes(
				(element) => {
					element.restoreAttributesOG(name);
					if (element.hasAttribute(name)) {
						const source = element.getAttribute(name)!;
						element.setAttributeOG(name, source);
						element.setAttribute(
							name,
							modifyJS(source, this.client.url, this.client.config, 'generic'),
						);
					}
				},
				[['*', name]],
			);

		// SVG references (sprites, images, filters) by href or legacy
		// xlink:href. SVG node names keep their case, and the fragment stays
		const svgHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '' || value.startsWith('#')) return;
			element.setAttributeOG(attribute, value);
			element.setAttribute(
				attribute,
				routeBinary(
					new StompURL(
						new URL(value, this.client.url.toString()),
						this.client.url,
					),
				),
			);
		};
		for (const attribute of ['href', 'xlink:href'])
			domHooksModule.useAttributes(
				svgHook(attribute),
				// live SVG elements keep their case; the page loader clones them as
				// HTML elements first, whose nodeName is upper case
				[
					'use',
					'image',
					'feImage',
					'mpath',
					'textPath',
					'linearGradient',
					'radialGradient',
					'pattern',
					'filter',
					'animate',
					'animateMotion',
					'animateTransform',
					'set',
					'cursor',
					'tref',
				]
					.flatMap((tag) => [tag, tag.toUpperCase()])
					.map((tag): [string, string] => [tag, attribute]),
			);

		// an SVG script loads its source by href (or xlink:href), like src
		const svgScriptHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '') return;
			element.setAttributeOG(attribute, value);
			element.setAttribute(
				attribute,
				routeJS(
					new StompURL(
						new URL(value, this.client.url.toString()),
						this.client.url,
					),
					this.client.url,
					this.client.config,
					'generic',
				),
			);
		};
		for (const attribute of ['href', 'xlink:href'])
			domHooksModule.useAttributes(svgScriptHook(attribute), [
				['script', attribute],
				['SCRIPT', attribute],
			]);

		// an SVG reference's `href` is an SVGAnimatedString: its baseVal and
		// animVal read the attribute the page wrote (the hooked getAttribute),
		// setting baseVal writes through the hooked setAttribute, so it routes
		{
			const proxyModule = this.client.getModule(ProxyModule)!;
			const global = this.client.global as unknown as Record<string, any>;
			const owners = new WeakMap<object, Element>();
			for (const name of Object.getOwnPropertyNames(global)) {
				if (!/^SVG\w+Element$/.test(name)) continue;
				const prototype = global[name]?.prototype;
				const descriptor =
					prototype && Reflect.getOwnPropertyDescriptor(prototype, 'href');
				if (!descriptor?.get) continue;
				Reflect.defineProperty(prototype, 'href', {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const value = Reflect.apply(target, that, args);
							if (value && typeof value === 'object') owners.set(value, that);
							return value;
						},
					),
				});
			}
			const animated = global.SVGAnimatedString?.prototype;
			if (animated)
				for (const property of ['baseVal', 'animVal']) {
					const descriptor = Reflect.getOwnPropertyDescriptor(
						animated,
						property,
					);
					if (!descriptor?.get) continue;
					Reflect.defineProperty(animated, property, {
						...descriptor,
						get: proxyModule.wrapFunction(
							descriptor.get,
							(target, that, args) => {
								const owner = owners.get(that);
								if (!owner) return Reflect.apply(target, that, args);
								return (
									owner.getAttribute(
										owner.hasAttribute('href') ? 'href' : 'xlink:href',
									) ?? ''
								);
							},
						),
						set: descriptor.set
							? proxyModule.wrapFunction(
									descriptor.set,
									(target, that, args) => {
										const owner = owners.get(that);
										if (!owner) return Reflect.apply(target, that, args);
										owner.setAttribute('href', String(args[0]));
									},
								)
							: undefined,
					});
				}
		}

		// browsing context names that would leave the frame: a top-level page
		// navigates itself for these, so does a proxied one. `_blank` and
		// names stay native (popups) until a host opts into onOpen
		const selfTargets = ['_top', '_parent', '_unfencedtop'];
		const targetHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (!selfTargets.includes(value.toLowerCase())) return;
			element.setAttributeOG(attribute, value);
			element.setAttribute(attribute, '_self');
		};
		const ogOrFalse = (attribute: string) => (element: CustomElement) =>
			element.getAttributeOG(attribute) ?? false;
		domHooksModule.useAttributes(targetHook('target'), [
			['A', 'target'],
			['AREA', 'target'],
			['FORM', 'target'],
			['BASE', 'target'],
			[HTMLAnchorElement, 'target', ogOrFalse('target')],
			[HTMLAreaElement, 'target', ogOrFalse('target')],
			[HTMLFormElement, 'target', ogOrFalse('target')],
			[HTMLBaseElement, 'target', ogOrFalse('target')],
		]);
		domHooksModule.useAttributes(targetHook('formtarget'), [
			['BUTTON', 'formtarget'],
			['INPUT', 'formtarget'],
			[HTMLButtonElement, 'formTarget', ogOrFalse('formtarget')],
			[HTMLInputElement, 'formTarget', ogOrFalse('formtarget')],
		]);

		// <iframe srcdoc>: the inline document gets the same shell a fetched
		// one gets, with this page as its base
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('srcdoc');
				if (element.hasAttribute('srcdoc')) {
					const source = element.getAttribute('srcdoc')!;
					element.setAttributeOG('srcdoc', source);
					element.setAttribute(
						'srcdoc',
						modifyHTML(source, this.client.url, this.client.config),
					);
				}
			},
			[
				['IFRAME', 'srcdoc'],
				[
					HTMLIFrameElement,
					'srcdoc',
					(element) => element.getAttributeOG('srcdoc') ?? false,
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.getAttribute('href') !== ''
				) {
					element.setAttributeOG('href', element.getAttribute('href')!);
					element.setAttribute(
						'href',
						routeHTML(
							new StompURL(
								new URL(
									element.getAttribute('href')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
							this.client.url,
							this.client.config,
						),
					);
				}
			},
			[
				['A', 'href'],
				['a', 'href'],
				['AREA', 'href'],
				[
					HTMLAnchorElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							element.getAttributeOG('href')!,
							this.client.url.toString(),
						).toString(),
				],
				// an image map's areas are links too
				[
					HTMLAreaElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							element.getAttributeOG('href')!,
							this.client.url.toString(),
						).toString(),
				],
			],
			// URL attributes do not mixin with element attributes
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (
					element.hasAttribute('src') &&
					element.getAttribute('src') !== '' &&
					shouldRewriteScript(element)
				) {
					element.setAttributeOG('src', element.getAttribute('src')!);
					element.setAttribute(
						'src',
						routeJS(
							new StompURL(
								new URL(
									element.getAttribute('src')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
							this.client.url,
							this.client.config,
							scriptType(element),
						),
					);
				}
			},
			[
				['SCRIPT', 'src'],
				// the route depends on type=module, which pages may set after src
				['SCRIPT', 'type'],
				[
					HTMLScriptElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('integrity');

				if (element.hasAttribute('integrity')) {
					element.setAttributeOG(
						'integrity',
						element.getAttribute('integrity')!,
					);
					element.removeAttribute('integrity');
				}
			},
			[
				['LINK', 'integrity'],
				['SCRIPT', 'integrity'],
				[
					HTMLLinkElement,
					'integrity',
					(element) =>
						element.hasAttribute('integrity') &&
						element.getAttribute('integrity') !== '' &&
						element.getAttributeOG('integrity')!,
				],
				[
					HTMLScriptElement,
					'integrity',
					(element) =>
						element.hasAttribute('integrity') &&
						element.getAttribute('integrity') !== '' &&
						element.getAttributeOG('integrity')!,
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.hasAttribute('rel') &&
					element.getAttribute('href') !== ''
				) {
					// rel is a token list; a preload's route follows `as`
					const rel = new Set(
						element.getAttribute('rel')!.trim().toLowerCase().split(/\s+/),
					);
					const as = (element.getAttribute('as') || '').trim().toLowerCase();
					const resource = new StompURL(
						new URL(element.getAttribute('href')!, this.client.url.toString()),
						this.client.url,
					);
					element.setAttributeOG('href', element.getAttribute('href')!);
					if (rel.has('manifest')) element.removeAttribute('href');
					else if (
						rel.has('stylesheet') ||
						((rel.has('preload') || rel.has('prefetch')) && as === 'style')
					)
						element.setAttribute('href', routeCSS(resource, this.client.url));
					else if (rel.has('modulepreload'))
						element.setAttribute(
							'href',
							routeJS(
								resource,
								this.client.url,
								this.client.config,
								'genericModule',
							),
						);
					else if (
						(rel.has('preload') || rel.has('prefetch')) &&
						as === 'script'
					)
						element.setAttribute(
							'href',
							routeJS(resource, this.client.url, this.client.config, 'generic'),
						);
					else element.setAttribute('href', routeBinary(resource));
				}
			},
			[
				['LINK', 'href'],
				['LINK', 'rel'],
				['LINK', 'as'],
				[HTMLLinkElement, 'as', () => false],
				[
					HTMLLinkElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							element.getAttributeOG('href')!,
							this.client.url.toString(),
						).toString(),
				],
				[HTMLLinkElement, 'rel', () => false],
			],
		);

		// todo: mimes...?
		// https://www.w3schools.com/tags/tag_embed.asp

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					element.setAttribute(
						'src',
						routeHTML(
							new StompURL(
								new URL(
									element.getAttribute('src')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
							this.client.url,
							this.client.config,
						),
					);
				}
			},
			[
				['IFRAME', 'src'],
				['EMBED', 'src'],
				['FRAME', 'src'],
				[
					HTMLFrameElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],
				[
					HTMLIFrameElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],

				[
					HTMLEmbedElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('content');

				if (
					element.hasAttribute('content') &&
					element.getAttribute('content') !== ''
				)
					switch (element.getAttribute('http-equiv')?.toLowerCase()) {
						case 'content-security-policy':
							element.setAttributeOG(
								'content',
								element.getAttribute('content')!,
							);
							element.removeAttribute('content');
							break;
						case 'refresh':
							element.setAttributeOG(
								'content',
								element.getAttribute('content')!,
							);
							element.setAttribute(
								'content',
								modifyRefresh(
									element.getAttribute('content')!,
									this.client.url,
									this.client.config,
								),
							);
							break;
					}
			},
			[
				['META', 'content'],
				['META', 'http-equiv'],
				[
					HTMLMetaElement,
					'content',
					(element) =>
						element.hasAttribute('content') &&
						element.getAttribute('content') !== '' &&
						new URL(
							element.getAttributeOG('content')!,
							this.client.url.toString(),
						).toString(),
				],
				[HTMLMetaElement, 'httpEquiv', () => false],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					element.setAttribute(
						'src',
						routeBinary(
							new StompURL(
								new URL(
									element.getAttribute('src')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
						),
					);
				}
			},
			[
				['IMG', 'src'],
				['INPUT', 'src'],
				[
					HTMLInputElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],
				[
					HTMLImageElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('srcset');

				if (
					element.hasAttribute('srcset') &&
					element.getAttribute('srcset') !== ''
				) {
					element.setAttributeOG('srcset', element.getAttribute('srcset')!);

					const parsed = parseSrcset(element.getAttribute('srcset')!);
					const updated: { url: string; width?: number; density?: number }[] =
						[];

					for (const src of parsed) {
						updated.push({
							...src,
							url: routeBinary(
								new StompURL(
									new URL(src.url, this.client.url.toString()),
									this.client.url,
								),
							),
						});
					}

					element.setAttribute('srcset', stringifySrcset(updated));
				}
			},
			[
				['IMG', 'srcset'],
				['SOURCE', 'srcset'],
				[
					HTMLImageElement,
					'srcset',
					(element) =>
						element.hasAttribute('srcset') &&
						element.getAttribute('srcset') !== '' &&
						element.getAttributeOG('srcset')!,
				],
				[
					HTMLSourceElement,
					'srcset',
					(element) =>
						element.hasAttribute('srcset') &&
						element.getAttribute('srcset') !== '' &&
						element.getAttributeOG('srcset')!,
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					element.setAttribute(
						'src',
						routeBinary(
							new StompURL(
								new URL(
									element.getAttribute('src')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
						),
					);
				}
			},
			[
				['AUDIO', 'src'],
				['VIDEO', 'src'],
				['SOURCE', 'src'],
				['TRACK', 'src'],
				[
					HTMLTrackElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],
				[
					HTMLMediaElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],
				[
					HTMLSourceElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							element.getAttributeOG('src')!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				// our rewritten text comes back serialized by the browser when the
				// page assigns it to el.style (Polymer does, from
				// attributeChangedCallback for the attribute we just wrote). Taken
				// as a new value it would flip the attribute between the original
				// and the rewritten text forever, which froze YouTube
				const current = element.getAttribute('style');

				if (current !== null && element.hasAttributeOG('style')) {
					const rewritten = modifyCSS(
						element.getAttributeOG('style')!,
						this.client.url,
						'declarationList',
					);

					if (
						current === rewritten ||
						current === this.serializeStyle(rewritten)
					)
						return;
				}

				element.restoreAttributesOG('style');

				if (
					element.hasAttribute('style') &&
					element.getAttribute('style') !== ''
				) {
					element.setAttributeOG('style', element.getAttribute('style')!);
					element.setAttribute(
						'style',
						modifyCSS(
							element.getAttributeOG('style')!,
							this.client.url,
							'declarationList',
						),
					);
				}
			},
			[
				['*', 'style'],
				[HTMLElement, 'style', () => false],
			],
		);

		// CSSStyleDeclaration: element.style.x = ..., setProperty(), cssText
		{
			const styleProto = this.client.global.CSSStyleDeclaration.prototype;
			const proxyModule = this.client.getModule(ProxyModule)!;

			const rewriteValue = (value: unknown) =>
				typeof value === 'string' && value.includes('url(')
					? rewriteCSSValueURLs(value, this.client.url)
					: value;

			const rewriteCssText = (value: unknown) => {
				try {
					return modifyCSS(String(value), this.client.url, 'declarationList');
				} catch (error) {
					return value;
				}
			};

			// Chromium implements the named properties (style.backgroundImage = ...)
			// as per-instance named setters, so the only way to see those writes
			// is to hand the page a Proxy from the `style` getter.
			const declarationProxies = new WeakMap<
				CSSStyleDeclaration,
				CSSStyleDeclaration
			>();

			const wrapDeclaration = (declaration: CSSStyleDeclaration) => {
				if (!declaration || typeof declaration !== 'object') return declaration;

				let proxy = declarationProxies.get(declaration);

				if (!proxy) {
					proxy = new Proxy(declaration, {
						get: (target, key) => {
							const value = Reflect.get(target, key);
							// getPropertyValue reads back the page's URL like the named
							// properties do
							if (key === 'getPropertyValue' && typeof value === 'function')
								return (...args: unknown[]) => {
									const result = Reflect.apply(value, target, args);
									return typeof result === 'string' && result.includes('url(')
										? restoreCSSValueURLs(result)
										: result;
								};
							if (typeof value === 'function') return value.bind(target);
							return typeof value === 'string' && value.includes('url(')
								? restoreCSSValueURLs(value)
								: value;
						},
						set: (target, key, value) => {
							if (typeof key === 'string')
								value =
									key === 'cssText'
										? rewriteCssText(value)
										: rewriteValue(value);
							return Reflect.set(target, key, value);
						},
					});

					declarationProxies.set(declaration, proxy);
				}

				return proxy;
			};

			for (const ctor of [
				this.client.global.HTMLElement,
				this.client.global.SVGElement,
			]) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					ctor.prototype,
					'style',
				);
				if (!descriptor?.get) continue;

				Reflect.defineProperty(ctor.prototype, 'style', {
					...descriptor,
					get: proxyModule.wrapFunction(descriptor.get, (target, that, args) =>
						wrapDeclaration(Reflect.apply(target, that, args)),
					),
				});
			}

			// computed styles read back the page's URLs too
			this.client.global.getComputedStyle = proxyModule.wrapFunction(
				this.client.global.getComputedStyle,
				(target, that, args) =>
					wrapDeclaration(Reflect.apply(target, that, args)),
			);

			// the Typed OM: values stringify with the page's URLs; what the page
			// parses or sets is routed
			const typed = this.client.global as unknown as Record<string, any>;
			if (typeof typed.CSSStyleValue === 'function') {
				for (const name of ['parse', 'parseAll'])
					if (typeof typed.CSSStyleValue[name] === 'function')
						typed.CSSStyleValue[name] = proxyModule.wrapFunction(
							typed.CSSStyleValue[name],
							(target, that, args) => {
								if (args.length > 1) args[1] = rewriteValue(args[1]);
								return Reflect.apply(target, that, args);
							},
						);
				typed.CSSStyleValue.prototype.toString = proxyModule.wrapFunction(
					typed.CSSStyleValue.prototype.toString,
					(target, that, args) => {
						const value = Reflect.apply(target, that, args);
						return typeof value === 'string' && value.includes('url(')
							? restoreCSSValueURLs(value)
							: value;
					},
				);
			}
			if (typeof typed.StylePropertyMap === 'function')
				for (const name of ['set', 'append'])
					if (typeof typed.StylePropertyMap.prototype[name] === 'function')
						typed.StylePropertyMap.prototype[name] = proxyModule.wrapFunction(
							typed.StylePropertyMap.prototype[name],
							(target, that, args) => {
								for (let i = 1; i < args.length; i++)
									args[i] = rewriteValue(args[i]);
								return Reflect.apply(target, that, args);
							},
						);

			styleProto.setProperty = proxyModule.wrapFunction(
				styleProto.setProperty,
				(target, that, args) => {
					if (args.length > 1) args[1] = rewriteValue(args[1]);
					return Reflect.apply(target, that, args);
				},
			);

			// newer Chromium moves the named properties (backgroundImage, ...)
			// onto CSSStyleProperties; wrap setters on both prototypes
			const protos = [
				styleProto,
				(
					this.client.global as unknown as {
						CSSStyleProperties?: typeof CSSStyleDeclaration;
					}
				).CSSStyleProperties?.prototype,
			].filter((proto): proto is CSSStyleDeclaration => !!proto);

			for (const proto of protos)
				for (const name of Object.getOwnPropertyNames(proto)) {
					const descriptor = Reflect.getOwnPropertyDescriptor(proto, name)!;
					if (!descriptor.set || !descriptor.configurable) continue;

					const rewrite =
						name === 'cssText'
							? (value: unknown) => {
									try {
										return modifyCSS(
											String(value),
											this.client.url,
											'declarationList',
										);
									} catch (error) {
										return value;
									}
								}
							: rewriteValue;

					Reflect.defineProperty(proto, name, {
						...descriptor,
						set: proxyModule.wrapFunction(
							descriptor.set,
							(target, that, args) =>
								Reflect.apply(target, that, [rewrite(args[0])]),
						),
					});
				}
		}

		const validMethods = ['GET', 'POST'];

		this.formHook = (element) => {
			element.restoreAttributesOG('action');

			// this hook always sets a routed 'action', so on later runs (e.g. the
			// method changing) the attribute may hold our own value rather than
			// the page's; only record it as the original when it isn't ours
			const current = element.getAttribute('action');
			const routedPrefix = `${this.client.directory}html`;

			if (
				element.hasAttribute('action') &&
				current !== '' &&
				!current!.startsWith(routedPrefix)
			) {
				element.setAttributeOG('action', current!);
			}

			/**
			 * Absolute URL
			 */
			const action = element.hasAttributeOG('action')
				? new URL(
						element.getAttributeOG('action')!,
						this.client.url.toString(),
					).toString()
				: this.client.url.toString();

			const methodIndex = validMethods.indexOf(
				element.getAttribute('method')?.toUpperCase() || '',
			);
			const method = validMethods[methodIndex === -1 ? 0 : methodIndex];

			switch (method) {
				case 'GET':
					element.setAttribute(
						'action',
						routeHTML(
							new StompURL(action, this.client.url),
							this.client.url,
							this.client.config,
							true,
						),
					);
					break;
				case 'POST':
					element.setAttribute(
						'action',
						routeHTML(
							new StompURL(action, this.client.url),
							this.client.url,
							this.client.config,
						),
					);

					break;
			}
		};

		/** the page's absolute URL for a routed URL attribute, or false without one */
		const originalURL = (attribute: string) => (element: CustomElement) =>
			element.hasAttribute(attribute) &&
			element.getAttribute(attribute) !== '' &&
			new URL(
				element.getAttributeOG(attribute)!,
				this.client.url.toString(),
			).toString();

		/** route one URL attribute, keeping the page's value as the original */
		const routeAttribute =
			(attribute: string, route: (resource: StompURL) => string) =>
			(element: CustomElement) => {
				element.restoreAttributesOG(attribute);
				if (
					element.hasAttribute(attribute) &&
					element.getAttribute(attribute) !== ''
				) {
					element.setAttributeOG(attribute, element.getAttribute(attribute)!);
					element.setAttribute(
						attribute,
						route(
							new StompURL(
								new URL(
									element.getAttribute(attribute)!,
									this.client.url.toString(),
								),
								this.client.url,
							),
						),
					);
				}
			};

		// <object data>: a document or a plugin resource, like <embed src>
		domHooksModule.useAttributes(
			routeAttribute('data', (resource) =>
				routeHTML(resource, this.client.url, this.client.config),
			),
			[
				['OBJECT', 'data'],
				[HTMLObjectElement, 'data', originalURL('data')],
			],
		);

		// <video poster>
		domHooksModule.useAttributes(routeAttribute('poster', routeBinary), [
			['VIDEO', 'poster'],
			[HTMLVideoElement, 'poster', originalURL('poster')],
		]);

		// <button formaction>, <input formaction>: the form's method decides how
		// the query travels, as for <form action>
		domHooksModule.useAttributes(
			routeAttribute('formaction', (resource) =>
				routeHTML(resource, this.client.url, this.client.config, true),
			),
			[
				['BUTTON', 'formaction'],
				['INPUT', 'formaction'],
				[HTMLButtonElement, 'formAction', originalURL('formaction')],
				[HTMLInputElement, 'formAction', originalURL('formaction')],
			],
		);

		// <link imagesrcset>: a preload's candidates, like <img srcset>
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('imagesrcset');
				if (
					element.hasAttribute('imagesrcset') &&
					element.getAttribute('imagesrcset') !== ''
				) {
					element.setAttributeOG(
						'imagesrcset',
						element.getAttribute('imagesrcset')!,
					);
					element.setAttribute(
						'imagesrcset',
						stringifySrcset(
							parseSrcset(element.getAttribute('imagesrcset')!).map((src) => ({
								...src,
								url: routeBinary(
									new StompURL(
										new URL(src.url, this.client.url.toString()),
										this.client.url,
									),
								),
							})),
						),
					);
				}
			},
			[
				['LINK', 'imagesrcset'],
				[
					HTMLLinkElement,
					'imageSrcset',
					(element) =>
						element.hasAttribute('imagesrcset') &&
						element.getAttribute('imagesrcset') !== '' &&
						element.getAttributeOG('imagesrcset')!,
				],
			],
		);

		// a child frame's sandbox (an opaque origin), csp or credentialless
		// attribute would put its document outside what the service worker can
		// serve or rewrite: dropped, read back as written
		for (const attribute of ['sandbox', 'csp', 'credentialless'])
			domHooksModule.useAttributes(
				(element) => {
					element.restoreAttributesOG(attribute);
					if (element.hasAttribute(attribute)) {
						element.setAttributeOG(attribute, element.getAttribute(attribute)!);
						element.removeAttribute(attribute);
					}
				},
				[['IFRAME', attribute]],
			);

		domHooksModule.useAttributes(this.formHook, [
			['FORM', 'action'],
			['FORM', 'method'],
			[
				HTMLFormElement,
				'action',
				(element) =>
					element.hasAttribute('action') &&
					element.getAttribute('action') !== '' &&
					new URL(
						element.getAttributeOG('action')!,
						this.client.url.toString(),
					).toString(),
			],
			[HTMLFormElement, 'method', () => false],
		]);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.getAttribute('href') !== ''
				) {
					element.setAttributeOG('href', element.getAttribute('href')!);
					element.setAttribute(
						'href',
						routeHTML(
							new StompURL(
								new URL(
									element.getAttribute('href')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
							this.client.url,
							this.client.config,
						),
					);
				}
			},
			[
				['BASE', 'href'],
				[
					HTMLBaseElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							element.getAttributeOG('href')!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);
	}
}
