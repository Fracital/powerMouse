import { parseSrcset, stringifySrcset } from 'srcset';
import {
	modifyCSS,
	restoreCSSValueURLs,
	rewriteCSSValueURLs,
	routeCSS,
} from '../../../rewriteCSS';
import { modifyHTML, modifyRefresh, routeHTML } from '../../../rewriteHTML';
import { modifyJS, routeJS, ScriptType } from '../../../rewriteJS';
import {
	parseDataURI,
	proxyBlobURL,
	ROUTE_PROTOCOLS,
	routeBinary,
	routeXHR,
} from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule, { usePrototype } from '../../modules/Proxy';
import { scopePrefix } from '../../modules/Unroute';
import { blobLoads } from '../blobLoads';
import DocumentClient, { addDocumentOpenListener } from '../Client';
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
	/** @internal the page's view of a CSSStyleDeclaration: reads unrouted, writes routed (CSSReadback) */
	wrapDeclaration?: (declaration: CSSStyleDeclaration) => CSSStyleDeclaration;
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
		// before the BlobDocuments module wraps it (it applies after this one)
		const NativeBlob = this.client.global.Blob;

		// A document no service worker controls (an about:blank frame or popup
		// the page built, or a document it opened: Chrome hands neither to the
		// page's worker) loads its elements from the proxy origin's own server,
		// where a route means nothing. Its loads are fetched through the proxy
		// instead (routedFetch, from the nearest controlled ancestor) and the
		// element gets a blob: URL of the copy, written underneath the hooks:
		// the attribute, the property and the markup read back as the page
		// wrote them, currentSrc as the URL the copy came from.
		let opened = false;
		addDocumentOpenListener(this.client.global, () => (opened = true));
		const uncontrolled = () =>
			!this.client.controlled &&
			(opened || this.client.global.location.href === 'about:blank');
		// the proxy origin from the base URL: an about:blank document's own
		// origin reads "null"
		const isRoute = (value: string) => {
			const prefix = scopePrefix(this.client);
			try {
				return new URL(value, prefix).href.startsWith(prefix);
			} catch (error) {
				return false;
			}
		};
		// per element and attribute: the routed value the copy is for, and its
		// blob: URL once it is in (a hook that runs again for the same value
		// keeps the copy)
		const copies = new WeakMap<
			Element,
			Map<string, { routed: string; url?: string }>
		>();
		/** a routed URL's copy, as a blob: URL (the proxy's form) */
		const copyOf = async (routed: string, page: string): Promise<string> => {
			const response = await this.client.routedFetch(routed, {
				credentials: 'include',
			});
			if (!response.ok && response.status !== 0)
				throw new Error(String(response.status));
			const url = proxyBlobURL(
				this.client.global.URL.createObjectURL(await response.blob()),
			);
			blobLoads.set(url, page);
			return url;
		};
		/**
		 * Set a load attribute to its routed value, or in a document no service
		 * worker controls to a copy of what it names (`urls` maps the value to
		 * the routed URLs it holds, for a srcset; one URL otherwise).
		 */
		const placeLoad = (
			element: CustomElement,
			attribute: string,
			routed: string,
			urls: { routed: string; page: string }[] | null = null,
			compose: (copies: string[]) => string = (copies) => copies[0],
		) => {
			const targets = urls ?? [
				{
					routed,
					page: new URL(
						element.getAttributeOG(attribute) ?? routed,
						this.client.url.toString(),
					).href,
				},
			];
			if (!uncontrolled() || !targets.some(({ routed }) => isRoute(routed))) {
				element.setAttribute(attribute, routed);
				return;
			}
			if (!copies.has(element)) copies.set(element, new Map());
			const perAttribute = copies.get(element)!;
			const current = perAttribute.get(attribute);
			if (current?.routed === routed) {
				if (current.url) element.setAttribute(attribute, current.url);
				else element.removeAttribute(attribute);
				return;
			}
			const state: { routed: string; url?: string } = { routed };
			perAttribute.set(attribute, state);
			// nothing loads until the copy is in
			element.removeAttribute(attribute);
			const settle = (value: string) => {
				if (perAttribute.get(attribute) !== state) return;
				state.url = value;
				usePrototype(element, CustomElement.prototype, (element) =>
					element.setAttribute(attribute, value),
				);
			};
			Promise.all(
				targets.map(({ routed, page }) =>
					isRoute(routed) ? copyOf(routed, page) : routed,
				),
			)
				.then((urls) => settle(compose(urls)))
				// the copy failed: the routed value, which fails as it would have
				.catch(() => settle(routed));
		};
		// A frame whose src is a data: document gets an opaque origin, which
		// the inject cannot reach: its requests would have nowhere to go and
		// its messages no route to the page. It loads instead from a blob: URL
		// of the shell with the data: URL itself as the document's URL, so it
		// runs injected and same-origin underneath, while every readback treats
		// it as the opaque origin "null" it is: its location is the data: URL,
		// its origin "null", and the page and the frame see each other through
		// the restricted cross-origin stand-ins (contentDocument null), as for
		// any frame of another real origin. Best effort, as every proxied
		// cross-origin frame is in same-origin mode.
		const opaqueDocument = (resource: StompURL): string | null => {
			if (resource.url.protocol !== 'data:') return null;
			const { mime, data } = parseDataURI(
				resource.url.pathname + resource.url.search,
			);
			if (
				!/^\s*(text\/html|application\/xhtml\+xml)\s*$/i.test(
					mime || 'text/plain',
				)
			)
				return null;
			// served by the worker as an inline document (controlled, its
			// subresources reaching the worker); its requests refer as a data:
			// document does, with nothing. Without a worker to register with,
			// the shell is a blob as before (subresources then miss the worker)
			const inline = this.client.inlineDocument(
				data,
				resource.url.href,
				'data:,',
			);
			if (inline) return inline;
			const blob = new NativeBlob(
				[modifyHTML(data, resource, this.client.config, true)],
				{ type: 'text/html' },
			);
			return proxyBlobURL(this.client.global.URL.createObjectURL(blob));
		};
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
					this.client.global.HTMLIFrameElement,
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
							false,
							this.client.nestedRoute,
						),
					);
				}
			},
			[
				['A', 'href'],
				['a', 'href'],
				['AREA', 'href'],
				[
					this.client.global.HTMLAnchorElement,
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
					this.client.global.HTMLAreaElement,
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
					placeLoad(
						element,
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
					this.client.global.HTMLScriptElement,
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
					this.client.global.HTMLLinkElement,
					'integrity',
					(element) =>
						element.hasAttribute('integrity') &&
						element.getAttribute('integrity') !== '' &&
						element.getAttributeOG('integrity')!,
				],
				[
					this.client.global.HTMLScriptElement,
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
						placeLoad(element, 'href', routeCSS(resource, this.client.url));
					else if (rel.has('modulepreload'))
						placeLoad(
							element,
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
						placeLoad(
							element,
							'href',
							routeJS(resource, this.client.url, this.client.config, 'generic'),
						);
					else placeLoad(element, 'href', routeBinary(resource));
				}
			},
			[
				['LINK', 'href'],
				['LINK', 'rel'],
				['LINK', 'as'],
				[HTMLLinkElement, 'as', () => false],
				[
					this.client.global.HTMLLinkElement,
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
					const resource = new StompURL(
						new URL(element.getAttribute('src')!, this.client.url.toString()),
						this.client.url,
					);
					const opaque = opaqueDocument(resource);
					if (opaque) this.client.opaqueFrames.add(element);
					else this.client.opaqueFrames.delete(element);
					element.setAttribute(
						'src',
						opaque ??
							routeHTML(
								resource,
								this.client.url,
								this.client.config,
								false,
								this.client.topOrigin,
							),
					);
				}
			},
			[
				['IFRAME', 'src'],
				['FRAME', 'src'],
				[
					this.client.global.HTMLFrameElement,
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
					this.client.global.HTMLIFrameElement,
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
									this.client.nestedRoute,
								),
							);
							break;
					}
			},
			[
				['META', 'content'],
				['META', 'http-equiv'],
				[
					this.client.global.HTMLMetaElement,
					'content',
					// what the page wrote, for a refresh the hook rewrote; any
					// other content (a token, a payload) is not a URL and reads
					// natively
					(element) => element.getAttributeOG('content') ?? false,
				],
				[this.client.global.HTMLMetaElement, 'httpEquiv', () => false],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					placeLoad(
						element,
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
					this.client.global.HTMLInputElement,
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
					this.client.global.HTMLImageElement,
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

					placeLoad(
						element,
						'srcset',
						stringifySrcset(updated),
						updated.map((candidate, index) => ({
							routed: candidate.url,
							page: new URL(parsed[index].url, this.client.url.toString()).href,
						})),
						(copied) =>
							stringifySrcset(
								updated.map((candidate, index) => ({
									...candidate,
									url: copied[index],
								})),
							),
					);
				}
			},
			[
				['IMG', 'srcset'],
				['SOURCE', 'srcset'],
				[
					this.client.global.HTMLImageElement,
					'srcset',
					(element) =>
						element.hasAttribute('srcset') &&
						element.getAttribute('srcset') !== '' &&
						element.getAttributeOG('srcset')!,
				],
				[
					this.client.global.HTMLSourceElement,
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
					placeLoad(
						element,
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
					this.client.global.HTMLTrackElement,
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
					this.client.global.HTMLMediaElement,
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
					this.client.global.HTMLSourceElement,
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
			this.wrapDeclaration = wrapDeclaration;

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

			// a form without an action (or an empty one) submits to the document's
			// own address, which is already a route; the page reads it back
			// without an action, as it wrote it (a routed one would hand the page
			// the proxy's address, which it might route again)
			if (!element.hasAttributeOG('action')) return;

			/**
			 * Absolute URL
			 */
			const action = new URL(
				element.getAttributeOG('action')!,
				this.client.url.toString(),
			).toString();

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
							this.client.nestedRoute,
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
							false,
							this.client.nestedRoute,
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
			(
				attribute: string,
				route: (resource: StompURL) => string,
				// a load (an image, media): copied in a document no worker controls
				load = false,
			) =>
			(element: CustomElement) => {
				element.restoreAttributesOG(attribute);
				if (
					element.hasAttribute(attribute) &&
					element.getAttribute(attribute) !== ''
				) {
					element.setAttributeOG(attribute, element.getAttribute(attribute)!);
					const value = route(
						new StompURL(
							new URL(
								element.getAttribute(attribute)!,
								this.client.url.toString(),
							),
							this.client.url,
						),
					);
					if (load) placeLoad(element, attribute, value);
					else element.setAttribute(attribute, value);
				}
			};

		// <object data> and <embed src>: Chrome never routes their loads through
		// a service worker, so a routed URL would reach the proxy origin's own
		// server. The inject fetches the resource through the proxy instead and
		// hands the element a blob: URL of it: HTML wrapped in the shell (as a
		// blob document, its real URL as base), anything else as it came. The
		// element loads nothing until then; a later value wins over a load
		// still in flight, and a failed fetch falls back to the routed URL.
		// The attribute and the property read back as the page wrote them.
		// per element: the URL the page wrote, the load for it, and the blob:
		// URL once it is in. A hook that runs again for the same value (the
		// insertion hooks re-run every attribute hook) keeps the load and its
		// blob instead of starting over, which would reset a document the
		// element is already showing
		const loads = new WeakMap<
			Element,
			{ written: string; generation: number; url?: string }
		>();
		let generations = 0;
		const proxiedLoad = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (
				!element.hasAttribute(attribute) ||
				element.getAttribute(attribute) === ''
			)
				return;
			const written = element.getAttribute(attribute)!;
			element.setAttributeOG(attribute, written);
			const resource = new StompURL(
				new URL(written, this.client.url.toString()),
				this.client.url,
			);
			const routed = routeHTML(
				resource,
				this.client.url,
				this.client.config,
				false,
				this.client.topOrigin,
			);
			if (!ROUTE_PROTOCOLS.includes(resource.url.protocol)) {
				// data:, blob: and the like: as routeHTML leaves them
				element.setAttribute(attribute, routed);
				return;
			}
			const current = loads.get(element);
			if (current?.written === resource.url.href) {
				if (current.url) element.setAttribute(attribute, current.url);
				else element.removeAttribute(attribute);
				return;
			}
			const generation = ++generations;
			const state: { written: string; generation: number; url?: string } = {
				written: resource.url.href,
				generation,
			};
			loads.set(element, state);
			// no URL at all until the proxied copy is in (an empty one makes an
			// object show its fallback and not load again)
			element.removeAttribute(attribute);
			const settle = (value: string) => {
				if (loads.get(element) !== state) return;
				state.url = value;
				usePrototype(element, CustomElement.prototype, (element) =>
					element.setAttribute(attribute, value),
				);
			};
			this.client
				.routedFetch(routeXHR(resource))
				.then(async (response) => {
					if (!response.ok && response.status !== 0)
						throw new Error(String(response.status));
					const type = response.headers.get('content-type') ?? '';
					const blob = /^\s*(text\/html|application\/xhtml\+xml)/i.test(type)
						? new NativeBlob(
								[
									modifyHTML(
										await response.text(),
										resource,
										this.client.config,
										true,
									),
								],
								{ type: 'text/html' },
							)
						: await response.blob();
					if (loads.get(element) !== state) return;
					if (current?.url?.startsWith('blob:'))
						this.client.global.URL.revokeObjectURL(current.url);
					settle(proxyBlobURL(this.client.global.URL.createObjectURL(blob)));
				})
				.catch(() => settle(routed));
		};
		// the property reads the page's URL from the original alone: the real
		// attribute is absent while the proxied copy loads, then a blob: URL
		const writtenURL = (attribute: string) => (element: CustomElement) => {
			const written = element.getAttributeOG(attribute);
			return written !== null && written !== ''
				? new URL(written, this.client.url.toString()).toString()
				: false;
		};
		domHooksModule.useAttributes(proxiedLoad('data'), [
			['OBJECT', 'data'],
			[this.client.global.HTMLObjectElement, 'data', writtenURL('data')],
		]);
		domHooksModule.useAttributes(proxiedLoad('src'), [
			['EMBED', 'src'],
			[this.client.global.HTMLEmbedElement, 'src', writtenURL('src')],
		]);

		// <a ping>, <area ping>: a list of URLs the browser posts to when the
		// link is followed. Each is routed, or the ping would reach the site
		// past the proxy (and name the proxy's URLs in Ping-From / Ping-To);
		// one that does not parse is dropped, as the browser drops it
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('ping');
				if (
					element.hasAttribute('ping') &&
					element.getAttribute('ping')!.trim() !== ''
				) {
					const written = element.getAttribute('ping')!;
					element.setAttributeOG('ping', written);
					const routed: string[] = [];
					for (const token of written.split(/[\t\n\f\r ]+/)) {
						if (!token) continue;
						try {
							routed.push(
								routeXHR(
									new StompURL(
										new URL(token, this.client.url.toString()),
										this.client.url,
									),
								),
							);
						} catch (error) {
							// not a URL
						}
					}
					element.setAttribute('ping', routed.join(' '));
				}
			},
			[
				['A', 'ping'],
				['AREA', 'ping'],
				[
					this.client.global.HTMLAnchorElement,
					'ping',
					(element) => element.getAttributeOG('ping') ?? false,
				],
				[
					this.client.global.HTMLAreaElement,
					'ping',
					(element) => element.getAttributeOG('ping') ?? false,
				],
			],
		);

		// <video poster>
		domHooksModule.useAttributes(routeAttribute('poster', routeBinary, true), [
			['VIDEO', 'poster'],
			[HTMLVideoElement, 'poster', originalURL('poster')],
		]);

		// <button formaction>, <input formaction>: the form's method decides how
		// the query travels, as for <form action>
		domHooksModule.useAttributes(
			routeAttribute('formaction', (resource) =>
				routeHTML(
					resource,
					this.client.url,
					this.client.config,
					true,
					this.client.nestedRoute,
				),
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
					this.client.global.HTMLLinkElement,
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
		// serve or rewrite: dropped, read back as written. Setting the
		// property (`iframe.sandbox = x` writes through its token list, which
		// no attribute hook sees) drops it at once too, so it is not dropped
		// later on insertion, behind attributes the page set after it. Not
		// `csp`: the property hook applies a string property's value again,
		// which would bring the attribute back
		const iframePrototype = this.client.global.HTMLIFrameElement.prototype;
		for (const [attribute, property] of [
			['sandbox', 'sandbox'],
			['csp', ''],
			['credentialless', 'credentialless'],
		])
			domHooksModule.useAttributes(
				(element) => {
					element.restoreAttributesOG(attribute);
					if (element.hasAttribute(attribute)) {
						element.setAttributeOG(attribute, element.getAttribute(attribute)!);
						element.removeAttribute(attribute);
					}
				},
				[
					['IFRAME', attribute],
					...(property &&
					Reflect.getOwnPropertyDescriptor(iframePrototype, property)?.set
						? [
								[
									this.client.global.HTMLIFrameElement,
									property,
									() => false,
								] as [typeof HTMLIFrameElement, string, () => false],
							]
						: []),
				],
			);

		domHooksModule.useAttributes(this.formHook, [
			['FORM', 'action'],
			['FORM', 'method'],
			[
				this.client.global.HTMLFormElement,
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

		// a base's href resolves against the document's URL, not against the
		// base URL (which client.url follows once a base is in place, and is
		// the page's own base while loadHTML rewrites the markup)
		const documentURL = () => {
			const location = this.client.location;
			return ROUTE_PROTOCOLS.includes(location.url.protocol)
				? location
				: this.client.url;
		};
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.getAttribute('href') !== ''
				) {
					const document = documentURL();
					element.setAttributeOG('href', element.getAttribute('href')!);
					element.setAttribute(
						'href',
						routeHTML(
							new StompURL(
								new URL(element.getAttribute('href')!, document.toString()),
								document,
							),
							document,
							this.client.config,
							false,
							this.client.nestedRoute,
						),
					);
				}
			},
			[
				['BASE', 'href'],
				[
					this.client.global.HTMLBaseElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							element.getAttributeOG('href')!,
							documentURL().toString(),
						).toString(),
				],
			],
		);
	}
}
