import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { LazyWeakMap } from '../../ownCollections';
import DocumentClient from '../Client';

/**
 * The URL parts of a link (`a.pathname`, `area.host`, `String(a)`) are the
 * link's own, computed from the URL the page wrote (the hooked `href`), not
 * from the routed attribute the browser holds; setting one updates the link
 * through the hooked `href`, so it is routed again.
 */
export default class AnchorModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;

		// the URL the page wrote, or null for an element without href
		const linkURL = (element: HTMLAnchorElement | HTMLAreaElement) => {
			try {
				return new URL(element.href);
			} catch (error) {
				return null;
			}
		};
		// each part's name, URL descriptor and link getter, by the link's
		// native getter and setter of it, for the one getter and one setter
		// call every part's wrappers make (two calls of their own for each
		// part of each interface were some 40 closures and their scopes in
		// every frame)
		const parts = new LazyWeakMap<
			Function,
			{ common: string; url: PropertyDescriptor; get: Function | undefined }
		>();
		const partGet = (
			target: Function,
			that: HTMLAnchorElement,
			args: unknown[],
		) => {
			const { common, url: urlDescriptor } = parts.get(target)!;
			const url = linkURL(that);
			if (!url) {
				// (the browser's own check of what it is called on)
				Reflect.apply(target, that, args);
				// No href, or one that is no URL for the page: the
				// browser's answer for either. Its own reading of the
				// element would be of the attribute against the
				// document's real address, where `http:` is a URL.
				return common === 'protocol' ? ':' : '';
			}
			return Reflect.apply(urlDescriptor.get!, url, args);
		};
		const partSet = (
			target: Function,
			that: HTMLAnchorElement,
			args: unknown[],
		) => {
			const { url: urlDescriptor, get } = parts.get(target)!;
			const url = linkURL(that);
			if (!url) {
				// nothing to set a part of, as in the browser
				Reflect.apply(get!, that, []);
				return;
			}
			Reflect.apply(urlDescriptor.set!, url, args);
			// the hooked setAttribute: routed, with the page's value kept
			that.setAttribute('href', url.href);
		};
		// the stringifier is the href
		const stringify = (_target: Function, that: HTMLAnchorElement) => that.href;

		for (const prototype of [
			global.HTMLAnchorElement.prototype,
			global.HTMLAreaElement.prototype,
		]) {
			for (const common of [
				'origin',
				'protocol',
				'username',
				'password',
				'host',
				'hostname',
				'port',
				'pathname',
				'search',
				'hash',
				// DOM hook takes care of this
				// 'href',
			]) {
				const urlDescriptor = Reflect.getOwnPropertyDescriptor(
					global.URL.prototype,
					common,
				);
				const linkDescriptor = Reflect.getOwnPropertyDescriptor(
					prototype,
					common,
				);

				if (!urlDescriptor || !linkDescriptor) {
					console.error(
						`Common property ${common} was missing on URL.prototype/${prototype.constructor.name}.prototype`,
					);
					continue;
				}

				const record = { common, url: urlDescriptor, get: linkDescriptor.get };
				if (linkDescriptor.get) parts.set(linkDescriptor.get, record);
				if (linkDescriptor.set) parts.set(linkDescriptor.set, record);
				Reflect.defineProperty(prototype, common, {
					...linkDescriptor,
					get: linkDescriptor.get
						? proxyModule.wrapFunction(linkDescriptor.get, partGet)
						: undefined,
					set: linkDescriptor.set
						? proxyModule.wrapFunction(linkDescriptor.set, partSet)
						: undefined,
				});
			}

			prototype.toString = proxyModule.wrapFunction(
				prototype.toString,
				stringify,
			);
		}
	}
}
