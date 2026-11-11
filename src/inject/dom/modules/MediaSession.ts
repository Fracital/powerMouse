import { routeBinary } from '../../../routeURL';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import type DocumentClient from '../Client';

type Image = { src?: unknown; sizes?: unknown; type?: unknown };

/**
 * A media session's artwork. The browser fetches it itself, for its media
 * controls, outside the page and so outside the service worker: the page's
 * URL went straight to the site, past the proxy, and a relative one resolved
 * against the proxy origin. Each image's src is routed when the metadata is
 * made or its artwork set, and `artwork` reads back the page's URLs.
 */
export default class MediaSessionModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const NativeMetadata = (global as { MediaMetadata?: typeof MediaMetadata })
			.MediaMetadata;
		if (typeof NativeMetadata !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;

		// an image list with each web URL routed, resolved against the page
		const routed = (artwork: unknown): unknown => {
			if (artwork === null || typeof artwork !== 'object') return artwork;
			if (!(Symbol.iterator in artwork)) return artwork;
			return [...(artwork as Iterable<Image>)].map((image) => {
				if (image === null || typeof image !== 'object') return image;
				let url: URL;
				try {
					url = new URL(String(image.src), this.client.baseURL.toString());
				} catch (error) {
					// the native constructor throws its own TypeError
					return image;
				}
				if (url.protocol !== 'http:' && url.protocol !== 'https:') return image;
				return {
					...image,
					src: routeBinary(new StompURL(url, this.client.url)),
				};
			});
		};

		const prototype = NativeMetadata.prototype;
		const descriptor = Reflect.getOwnPropertyDescriptor(prototype, 'artwork');
		if (descriptor?.get && descriptor.set) {
			// the page's view of each native frozen array, made once: the
			// getter answers with the same object every time, as natively
			const views = new WeakMap<object, readonly Image[]>();
			Reflect.defineProperty(prototype, 'artwork', {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const list = Reflect.apply(target, that, args) as readonly Image[];
					if (!Array.isArray(list)) return list;
					if (!views.has(list))
						views.set(
							list,
							Object.freeze(
								list.map((image) =>
									Object.freeze({
										...image,
										src:
											typeof image.src === 'string'
												? (unrouteURL(this.client, image.src) ?? image.src)
												: image.src,
									}),
								),
							),
						);
					return views.get(list);
				}),
				set: proxyModule.wrapFunction(descriptor.set, (target, that, args) =>
					Reflect.apply(target, that, [routed(args[0])]),
				),
			});
		}

		global.MediaMetadata = proxyModule.wrapFunction(
			NativeMetadata,
			(target, _that, args, newTarget) => {
				const init = args[0];
				const next =
					init !== null && typeof init === 'object' && 'artwork' in init
						? [
								{
									...init,
									artwork: routed(
										(init as Image & { artwork: unknown }).artwork,
									),
								},
							]
						: args;
				return Reflect.construct(target, next, newTarget);
			},
			true,
		);
	}
}
