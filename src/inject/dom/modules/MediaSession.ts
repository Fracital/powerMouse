import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { LazyWeakMap } from '../../ownCollections';
import type DocumentClient from '../Client';
import { deferred } from '../deferred';
import type { ArtworkImage } from '../mediaArtwork';

/**
 * A media session's artwork. The browser fetches it itself, for its media
 * controls, outside the page and so outside the service worker: the page's
 * URL went straight to the site, past the proxy, and a relative one resolved
 * against the proxy origin. Each image's src is routed when the metadata is
 * made or its artwork set, and `artwork` reads back the page's URLs.
 */
export default class MediaSessionModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const NativeMetadata = (global as { MediaMetadata?: typeof MediaMetadata })
			.MediaMetadata;
		if (typeof NativeMetadata !== 'function') return;
		const proxyModule = client.getModule(ProxyModule)!;

		// the routing and the reading back are a deferred part
		// (../mediaArtwork.ts): without it the artwork is refused (a throw),
		// and no URL of the page's reaches the browser
		const routed = (artwork: unknown): unknown =>
			deferred('routedArtwork')(client, artwork);

		const prototype = NativeMetadata.prototype;
		const descriptor = Reflect.getOwnPropertyDescriptor(prototype, 'artwork');
		if (descriptor?.get && descriptor.set) {
			// the page's view of each native frozen array, made once: the
			// getter answers with the same object every time, as natively
			const views = new LazyWeakMap<object, readonly ArtworkImage[]>();
			Reflect.defineProperty(prototype, 'artwork', {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const list = Reflect.apply(
						target,
						that,
						args,
					) as readonly ArtworkImage[];
					if (!Array.isArray(list)) return list;
					if (!views.has(list))
						views.set(list, deferred('artworkView')(client, list));
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
									artwork: routed((init as { artwork: unknown }).artwork),
								},
							]
						: args;
				return Reflect.construct(target, next, newTarget);
			},
			true,
		);
	}
}
