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

const jsTypes = ['text/javascript', 'application/javascript', 'module', ''];

export function shouldRewriteScript(element: Element) {
	return jsTypes.includes(element.getAttribute('type') || '');
}

export function scriptType(element: Element): ScriptType {
	return element.getAttribute('type') === 'module'
		? 'genericModule'
		: 'generic';
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
				['use', 'image', 'feImage', 'mpath', 'textPath']
					.flatMap((tag) => [tag, tag.toUpperCase()])
					.map((tag): [string, string] => [tag, attribute]),
			);

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
					switch (element.getAttribute('rel')) {
						case 'stylesheet':
							element.setAttributeOG('href', element.getAttribute('href')!);
							element.setAttribute(
								'href',
								routeCSS(
									new StompURL(
										new URL(
											element.getAttribute('href')!,
											this.client.url.toString(),
										),
										this.client.url,
									),
									this.client.url,
								),
							);
							break;
						case 'manifest':
							element.setAttributeOG('href', element.getAttribute('href')!);
							element.removeAttribute('href');
							break;
						default:
							element.setAttributeOG('href', element.getAttribute('href')!);
							element.setAttribute(
								'href',
								routeBinary(
									new StompURL(
										new URL(
											element.getAttribute('href')!,
											this.client.url.toString(),
										),
										this.client.url,
									),
								),
							);
							break;
					}
				}
			},
			[
				['LINK', 'href'],
				['LINK', 'rel'],
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
