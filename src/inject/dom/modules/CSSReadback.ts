import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteCSS, unrouteURL } from '../../modules/Unroute';
import DocumentClient from '../Client';
import DOMAttributesModule from './DOMAttributes';
import DOMHooksModule from './DOMHooks';

/**
 * What a page reads back from the CSSOM and from its own stylesheets is what
 * it wrote: a rule's `cssText` and `style`, a sheet's `href` (and an
 * `@import`'s), the text of a style element, and serialised markup (a style
 * element's text, a style attribute the browser serialised) show the url()s
 * of the page, not the routed ones the rewriter put there. The declaration
 * hooks of DOMAttributes (`element.style`, computed styles) are reused for a
 * rule's `style`.
 */
export default class CSSReadbackModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global as typeof globalThis &
			Record<string, any>;

		const unrouteStringGetter = (
			target: object | undefined,
			key: string,
			unroute: (value: string) => string,
			when: (that: unknown) => boolean = () => true,
		) => {
			if (!target) return;
			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
			if (!descriptor?.get) return;
			Reflect.defineProperty(target, key, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (get, that, args) => {
					const value = Reflect.apply(get, that, args);
					return typeof value === 'string' && when(that)
						? unroute(value)
						: value;
				}),
			});
		};
		const css = (value: string) => unrouteCSS(this.client, value);
		const url = (value: string) => unrouteURL(this.client, value) ?? value;

		// rules and sheets
		unrouteStringGetter(global.CSSRule?.prototype, 'cssText', css);
		unrouteStringGetter(global.StyleSheet?.prototype, 'href', url);
		unrouteStringGetter(global.CSSImportRule?.prototype, 'href', url);

		// a rule's declaration: the same proxy as element.style
		const wrapDeclaration =
			this.client.getModule(DOMAttributesModule)!.wrapDeclaration;
		if (wrapDeclaration)
			for (const name of Object.getOwnPropertyNames(global)) {
				if (!/^CSS\w+Rule$/.test(name)) continue;
				const prototype = global[name]?.prototype;
				const descriptor =
					prototype && Reflect.getOwnPropertyDescriptor(prototype, 'style');
				if (!descriptor?.get) continue;
				Reflect.defineProperty(prototype, 'style', {
					...descriptor,
					get: proxyModule.wrapFunction(descriptor.get, (get, that, args) =>
						wrapDeclaration(Reflect.apply(get, that, args)),
					),
				});
			}

		// the text of a style element, read from it or from its text node
		const nodeNameGet = Reflect.getOwnPropertyDescriptor(
			global.Node.prototype,
			'nodeName',
		)!.get!;
		const parentNodeGet = Reflect.getOwnPropertyDescriptor(
			global.Node.prototype,
			'parentNode',
		)!.get!;
		const inStyle = (that: unknown): boolean => {
			try {
				if (Reflect.apply(nodeNameGet, that, []) === 'STYLE') return true;
				const parent = Reflect.apply(parentNodeGet, that, []);
				return (
					parent !== null && Reflect.apply(nodeNameGet, parent, []) === 'STYLE'
				);
			} catch (error) {
				return false;
			}
		};
		unrouteStringGetter(global.Node.prototype, 'textContent', css, inStyle);
		unrouteStringGetter(global.Node.prototype, 'nodeValue', css, inStyle);
		unrouteStringGetter(global.CharacterData.prototype, 'data', css, inStyle);
		unrouteStringGetter(
			global.HTMLElement.prototype,
			'innerText',
			css,
			inStyle,
		);

		// serialised markup: style text and style attributes in innerHTML /
		// outerHTML (the marker fold of DOMHooks runs first)
		const domHooks = this.client.getModule(DOMHooksModule)!;
		const serializeOriginal = domHooks.serializeOriginal;
		domHooks.serializeOriginal = (element, outer) =>
			css(serializeOriginal(element, outer));
		const foldMarkup = domHooks.foldMarkup;
		domHooks.foldMarkup = (html) => css(foldMarkup(html));
	}
}
