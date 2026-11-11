import { rewriteCSSValueURLs } from '../../../cssURLs';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import ResourceTimingModule from '../../modules/ResourceTiming';
import { unrouteURL } from '../../modules/Unroute';
import { modifyCSS } from '../../rewriter';
import { blobLoads, opaqueCopies } from '../blobLoads';
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

		// what addRule takes for a rule's body: a declaration list
		const rewriteDeclarations = (text: unknown) => {
			const source = String(text);
			try {
				return modifyCSS(source, this.client.url, 'declarationList');
			} catch (error) {
				return rewriteCSSValueURLs(source, this.client.url);
			}
		};

		// a sheet in a document no service worker controls has its loads
		// copied once its rules change (replace: once they are in)
		const domAttributes = this.client.getModule(DOMAttributesModule);
		const copied = (sheet: unknown) => {
			if (domAttributes?.uncontrolled())
				domAttributes.copyRules?.(sheet as CSSStyleSheet);
		};
		// The rules of another origin's stylesheet are not the page's to read
		// or change: every route is same-origin to the browser, so it hands
		// them over. The browser's rule, by the real origins: a sheet a
		// crossorigin <link> loaded reached the page only past the worker's
		// CORS check; any other sheet of another origin's URL (an @import is
		// never a CORS load, whatever loaded the sheet that imports it), and
		// one of the page's own URL that came through another origin (a
		// redirect), refuses its rules with the browser's SecurityError.
		const sheetGetter = (proto: object | undefined, name: string) =>
			proto
				? (Reflect.getOwnPropertyDescriptor(proto, name)?.get as
						((this: unknown) => unknown) | undefined)
				: undefined;
		const sheetHref = sheetGetter(global.StyleSheet?.prototype, 'href');
		const sheetOwner = sheetGetter(global.StyleSheet?.prototype, 'ownerNode');
		const linkCrossOrigin = sheetGetter(
			global.HTMLLinkElement?.prototype,
			'crossOrigin',
		);
		const opaqueLoad = this.client
			.getModule(ResourceTimingModule)
			?.opaqueLoads();
		/** per sheet of another origin's URL: whether its rules are refused */
		const foreignSheets = new WeakMap<object, boolean>();
		const refused = (styleSheet: unknown): boolean => {
			if (styleSheet === null || typeof styleSheet !== 'object') return false;
			const known = foreignSheets.get(styleSheet);
			if (known !== undefined) return known;
			let href: unknown;
			try {
				href = sheetHref && Reflect.apply(sheetHref, styleSheet, []);
			} catch (error) {
				// not a stylesheet: the native member says so
				return false;
			}
			// a <style>'s sheet or a constructed one, and a data: URL's
			if (typeof href !== 'string' || href === '' || href.startsWith('data:'))
				return false;
			let real: string | undefined;
			if (href.startsWith('blob:')) {
				// a copy the inject made for a document no worker controls
				// stands for the page's URL; any other blob: URL is the page's own
				if (opaqueCopies.has(href)) return true;
				real = blobLoads.get(href);
				if (real === undefined) return false;
			} else real = unrouteURL(this.client, href) ?? href;
			let cross: boolean;
			try {
				cross =
					new URL(real).origin !==
					(this.client.opaqueRequests ? 'null' : this.client.url.url.origin);
			} catch (error) {
				return false;
			}
			if (!cross) return !!opaqueLoad?.(href);
			let verdict = true;
			try {
				const owner = sheetOwner && Reflect.apply(sheetOwner, styleSheet, []);
				if (owner && linkCrossOrigin)
					verdict = Reflect.apply(linkCrossOrigin, owner, []) === null;
			} catch (error) {
				// an owner that is no <link> (an XML stylesheet's): no CORS load
			}
			foreignSheets.set(styleSheet, verdict);
			return verdict;
		};
		const refuse = (message: string) =>
			new global.DOMException(message, 'SecurityError');
		const promiseThen = global.Promise.prototype.then;
		const sheet = global.CSSStyleSheet.prototype;
		for (const name of ['cssRules', 'rules']) {
			const descriptor = Reflect.getOwnPropertyDescriptor(sheet, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(sheet, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					if (refused(that))
						throw refuse(
							`Failed to read the '${name}' property from 'CSSStyleSheet': Cannot access rules`,
						);
					return Reflect.apply(target, that, args);
				}),
			});
		}
		for (const [method, action] of [
			['addRule', 'insertRule'],
			['removeRule', 'deleteRule'],
		] as const) {
			if (typeof sheet[method] !== 'function') continue;
			sheet[method] = proxyModule.wrapFunction(
				sheet[method] as Function,
				(target, that, args) => {
					if (refused(that))
						throw refuse(
							`Failed to execute '${method}' on 'CSSStyleSheet': Cannot access StyleSheet to ${action}`,
						);
					// addRule(selector, declarations, index): the declarations are
					// the page's CSS as much as insertRule's rule is
					if (method === 'addRule' && args.length > 1)
						args[1] = rewriteDeclarations(args[1]);
					const result = Reflect.apply(target, that, args);
					copied(that);
					return result;
				},
			) as any;
		}
		for (const method of [
			'insertRule',
			'replace',
			'replaceSync',
			'deleteRule',
		] as const) {
			if (typeof sheet[method] !== 'function') continue;
			sheet[method] = proxyModule.wrapFunction(
				sheet[method] as Function,
				(target, that, args) => {
					if (
						(method === 'insertRule' || method === 'deleteRule') &&
						refused(that)
					)
						throw refuse(
							`Failed to execute '${method}' on 'CSSStyleSheet': Cannot access StyleSheet to ${method}`,
						);
					if (method !== 'deleteRule' && args.length)
						args[0] = rewrite(args[0]);
					const result = Reflect.apply(target, that, args);
					if (method !== 'replace') copied(that);
					else
						Reflect.apply(promiseThen, result, [() => copied(that), () => {}]);
					return result;
				},
			) as any;
		}

		// A rule put inside another (an @media's, an @supports's, a style
		// rule's nested ones, a keyframe of an @keyframes) is the page's CSS
		// too: routed before the browser parses it, or its url()s load from
		// the site itself, past the proxy. Its sheet's loads are copied where
		// no service worker controls.
		const parentSheet = sheetGetter(
			global.CSSRule?.prototype,
			'parentStyleSheet',
		);
		for (const name of Object.getOwnPropertyNames(global)) {
			if (!/^CSS\w*Rule$/.test(name)) continue;
			const rule = (global as unknown as Record<string, any>)[name]?.prototype;
			if (!rule) continue;
			for (const method of ['insertRule', 'appendRule', 'deleteRule']) {
				const descriptor = Reflect.getOwnPropertyDescriptor(rule, method);
				if (typeof descriptor?.value !== 'function') continue;
				rule[method] = proxyModule.wrapFunction(
					descriptor.value as Function,
					(target, that, args) => {
						if (method !== 'deleteRule' && args.length)
							args[0] = rewrite(args[0]);
						const result = Reflect.apply(target, that, args);
						try {
							const owner = parentSheet && Reflect.apply(parentSheet, that, []);
							if (owner) copied(owner);
						} catch (error) {
							// not a rule: the native method threw already
						}
						return result;
					},
				);
			}
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
