import { modifyCSS, rewriteCSSValueURLs } from '../../../rewriteCSS';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';
import DOMAttributesModule from './DOMAttributes';

// the FontFace of the realm the bundle was evaluated in, before any hook: the
// realm whose fetch a document with no controlled ancestor of its own (a
// popup the opener injected) goes through (see Client.routedFetch)
const bundleFontFace =
	typeof globalThis.FontFace === 'function' ? globalThis.FontFace : undefined;

/**
 * CSS that never passes through a <link> or a <style>: rules inserted into a
 * sheet, constructable sheets (CSS-in-JS, `adoptedStyleSheets`) and
 * FontFace sources. Each is rewritten like a stylesheet before the browser
 * sees it, or its url()s would fetch from the proxy origin.
 */
export default class CSSOMModule extends Module<DocumentClient> {
	/** @internal this realm's FontFace, before the hook */
	nativeFontFace?: typeof FontFace;
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		this.nativeFontFace = global.FontFace;

		/**
		 * A FontFace constructor whose fonts load through a service worker,
		 * for a document no worker controls: the nearest controlled ancestor's
		 * (the same one routedFetch goes through), or the bundle's realm's.
		 * A face fetches its source from the realm it was made in, and its
		 * source cannot change once it is made, so a copy made later could
		 * never reach it.
		 */
		const controlledFontFace = (): typeof FontFace | undefined => {
			const controlled = this.client.controlledClient();
			if (controlled && controlled !== this.client)
				return (
					(controlled as DocumentClient).getModule?.(CSSOMModule)
						?.nativeFontFace ?? bundleFontFace
				);
			return globalThis === (global as unknown) ? undefined : bundleFontFace;
		};

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

		// a face made in another realm settles that realm's promises: the page
		// gets one of its own for each, the same one every time
		const foreign = new WeakSet<object>();
		const promises = new WeakMap<object, Promise<unknown>>();
		const ownPromise = (promise: unknown) => {
			if (!promise || typeof promise !== 'object') return promise;
			if (!promises.has(promise))
				promises.set(
					promise,
					new global.Promise((resolve, reject) =>
						Reflect.apply(Reflect.get(promise, 'then') as Function, promise, [
							resolve,
							reject,
						]),
					),
				);
			return promises.get(promise);
		};
		const faceProto = global.FontFace?.prototype;
		const loadedGet =
			faceProto && Reflect.getOwnPropertyDescriptor(faceProto, 'loaded');
		if (loadedGet?.get)
			Reflect.defineProperty(faceProto, 'loaded', {
				...loadedGet,
				get: proxyModule.wrapFunction(loadedGet.get, (target, that, args) => {
					const promise = Reflect.apply(target, that, args);
					return foreign.has(that) ? ownPromise(promise) : promise;
				}),
			});
		if (typeof faceProto?.load === 'function')
			faceProto.load = proxyModule.wrapFunction(
				faceProto.load,
				(target, that, args) => {
					const promise = Reflect.apply(target, that, args);
					return foreign.has(that) ? ownPromise(promise) : promise;
				},
			);

		if (typeof global.FontFace === 'function')
			global.FontFace = proxyModule.wrapFunction(
				global.FontFace,
				(target, that, args, newTarget) => {
					if (!newTarget)
						throw new TypeError(
							"Failed to construct 'FontFace': Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
						);
					// a string source is a CSS `src` value; a buffer is data
					if (typeof args[1] !== 'string')
						return Reflect.construct(target, args, newTarget);
					args[1] = rewriteCSSValueURLs(args[1], this.client.url);
					// in a document no worker controls, a face whose source names
					// routes is made in a controlled realm, so it loads through the
					// worker; it is still this realm's FontFace (its prototype
					// comes from newTarget), and any document's font set takes it
					const Controlled =
						args[1].includes('url(') &&
						this.client.getModule(DOMAttributesModule)?.uncontrolled()
							? controlledFontFace()
							: undefined;
					if (!Controlled) return Reflect.construct(target, args, newTarget);
					const face = Reflect.construct(Controlled, args, newTarget);
					foreign.add(face);
					return face;
				},
				true,
			) as typeof FontFace;
	}
}
