import { modifyCSS, rewriteCSSValueURLs } from '../../../rewriteCSS';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

/**
 * CSS that never passes through a <link> or a <style>: rules inserted into a
 * sheet, constructable sheets (CSS-in-JS, `adoptedStyleSheets`) and
 * FontFace sources. Each is rewritten like a stylesheet before the browser
 * sees it, or its url()s would fetch from the proxy origin.
 */
export default class CSSOMModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;

		const rewrite = (text: unknown) => {
			const source = String(text);
			try {
				return modifyCSS(source, this.client.url);
			} catch (error) {
				// unparsable: route what the regex can find
				return rewriteCSSValueURLs(source, this.client.url);
			}
		};

		const sheet = global.CSSStyleSheet.prototype;
		for (const method of ['insertRule', 'replace', 'replaceSync'] as const) {
			if (typeof sheet[method] !== 'function') continue;
			sheet[method] = proxyModule.wrapFunction(
				sheet[method] as Function,
				(target, that, args) => {
					if (args.length) args[0] = rewrite(args[0]);
					return Reflect.apply(target, that, args);
				},
			) as any;
		}

		if (typeof global.FontFace === 'function')
			global.FontFace = proxyModule.wrapFunction(
				global.FontFace,
				(target, that, args, newTarget) => {
					if (!newTarget)
						throw new TypeError(
							"Failed to construct 'FontFace': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
						);
					// a string source is a CSS `src` value; a buffer is data
					if (typeof args[1] === 'string')
						args[1] = rewriteCSSValueURLs(args[1], this.client.url);
					return Reflect.construct(target, args, newTarget);
				},
				true,
			) as typeof FontFace;
	}
}
