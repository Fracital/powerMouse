// A media session's artwork as the MediaSession module routes it and reads
// it back (./modules/MediaSession.ts says why), a deferred part of the
// document bundle (./deferredParts.ts) made at a document's first artwork:
// few pages set a media session's metadata, and fewer of their frames.
import { routeBinary } from '../../routeURL';
import StompURL from '../../StompURL';
import { unrouteURL } from '../modules/Unroute';
import type DocumentClient from './Client';

export type ArtworkImage = { src?: unknown; sizes?: unknown; type?: unknown };

/** an image list with each web URL routed, resolved against the page */
export function routedArtwork(
	client: DocumentClient,
	artwork: unknown,
): unknown {
	if (artwork === null || typeof artwork !== 'object') return artwork;
	if (!(Symbol.iterator in artwork)) return artwork;
	return [...(artwork as Iterable<ArtworkImage>)].map((image) => {
		if (image === null || typeof image !== 'object') return image;
		let url: URL;
		try {
			url = new URL(String(image.src), client.baseHref);
		} catch (error) {
			// the native constructor throws its own TypeError
			return image;
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return image;
		return {
			...image,
			src: routeBinary(new StompURL(url, client.url)),
		};
	});
}

/** the page's view of the browser's frozen artwork `list`: its URLs the page's */
export function artworkView(
	client: DocumentClient,
	list: readonly ArtworkImage[],
): readonly ArtworkImage[] {
	return Object.freeze(
		list.map((image) =>
			Object.freeze({
				...image,
				src:
					typeof image.src === 'string'
						? (unrouteURL(client, image.src) ?? image.src)
						: image.src,
			}),
		),
	);
}
