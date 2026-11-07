import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
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

		for (const prototype of [
			global.HTMLAnchorElement.prototype,
			global.HTMLAreaElement.prototype,
		]) {
			// the URL the page wrote, or null for an element without href
			const linkURL = (element: HTMLAnchorElement | HTMLAreaElement) => {
				try {
					return new URL(element.href);
				} catch (error) {
					return null;
				}
			};

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

				Reflect.defineProperty(prototype, common, {
					...linkDescriptor,
					get: linkDescriptor.get
						? proxyModule.wrapFunction(
								linkDescriptor.get,
								(target, that: HTMLAnchorElement, args) => {
									const url = linkURL(that);
									// no href, or not a URL: what the browser says
									if (!url) return Reflect.apply(target, that, args);
									return Reflect.apply(urlDescriptor.get!, url, args);
								},
							)
						: undefined,
					set: linkDescriptor.set
						? proxyModule.wrapFunction(
								linkDescriptor.set,
								(target, that: HTMLAnchorElement, args) => {
									const url = linkURL(that);
									if (!url) return Reflect.apply(target, that, args);
									Reflect.apply(urlDescriptor.set!, url, args);
									// the hooked setAttribute: routed, with the page's value kept
									that.setAttribute('href', url.href);
								},
							)
						: undefined,
				});
			}

			// the stringifier is the href
			prototype.toString = proxyModule.wrapFunction(
				prototype.toString,
				(target, that: HTMLAnchorElement) => that.href,
			);
		}
	}
}
