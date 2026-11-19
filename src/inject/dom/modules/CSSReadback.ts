import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteCSS, unrouteURL } from '../../modules/Unroute';
import DocumentClient from '../Client';
import { RULE_STYLE_INTERFACES } from '../cssRules';
import { isStylesheetPI, stylesheetPIs } from '../stylesheetPIs';
import DOMAttributesModule from './DOMAttributes';
import { keptPiece } from './DOMContentHooks';
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
		const client = this.client;
		const proxyModule = client.getModule(ProxyModule)!;
		const global = client.global as typeof globalThis & Record<string, any>;

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
		const css = (value: string) => unrouteCSS(client, value);
		const url = (value: string) => unrouteURL(client, value) ?? value;

		// rules and sheets: a rule is the browser's serialisation of what it
		// parsed, whose url() is quoted whatever the page wrote
		unrouteStringGetter(global.CSSRule?.prototype, 'cssText', (value) =>
			unrouteCSS(client, value, true),
		);
		unrouteStringGetter(global.StyleSheet?.prototype, 'href', url);
		unrouteStringGetter(global.CSSImportRule?.prototype, 'href', url);

		// a rule's declaration: the same proxy as element.style
		const wrapDeclaration =
			client.getModule(DOMAttributesModule)!.wrapDeclaration;
		const ruleStyle = (get: Function, that: unknown, args: unknown[]) =>
			wrapDeclaration!(Reflect.apply(get, that, args));
		if (wrapDeclaration)
			for (const name of RULE_STYLE_INTERFACES) {
				const prototype = global[name]?.prototype;
				const descriptor =
					prototype && Reflect.getOwnPropertyDescriptor(prototype, 'style');
				if (!descriptor?.get) continue;
				Reflect.defineProperty(prototype, 'style', {
					...descriptor,
					get: proxyModule.wrapFunction(descriptor.get, ruleStyle),
				});
			}

		// the text of a style element (an HTML or an SVG one, see
		// Client.styleElement), read from it or from its text node
		const parentNodeGet = Reflect.getOwnPropertyDescriptor(
			global.Node.prototype,
			'parentNode',
		)!.get!;
		const inStyle = (that: unknown): boolean => {
			if (client.styleElement(that)) return true;
			try {
				return !!client.styleElement(Reflect.apply(parentNodeGet, that, []));
			} catch (error) {
				return false;
			}
		};
		// and an xml-stylesheet processing instruction's data, whose href
		// is routed where it loads (../stylesheetPIs.ts)
		for (const [prototype, key] of [
			[global.Node.prototype, 'textContent'],
			[global.Node.prototype, 'nodeValue'],
			[global.CharacterData.prototype, 'data'],
		] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(prototype, key, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (get, that, args) => {
					const value = Reflect.apply(get, that, args);
					if (typeof value !== 'string') return value;
					if (isStylesheetPI(that)) return stylesheetPIs(client).pageOf(that);
					// (a piece of a style the hooks hold elsewhere, wherever it is now)
					return keptPiece(that, value) ?? (inStyle(that) ? css(value) : value);
				}),
			});
		}
		unrouteStringGetter(
			global.HTMLElement.prototype,
			'innerText',
			css,
			inStyle,
		);

		// serialised markup: style text and style attributes in innerHTML /
		// outerHTML (the marker fold of DOMHooks runs first)
		const domHooks = client.getModule(DOMHooksModule)!;
		const serializeOriginal = domHooks.serializeOriginal;
		domHooks.serializeOriginal = (element, outer) =>
			css(serializeOriginal(element, outer));
		const foldMarkup = domHooks.foldMarkup;
		domHooks.foldMarkup = (html) => css(foldMarkup(html));
	}
}
