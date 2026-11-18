import { IMAGES_SEEN } from '../../transport/messages';
import type DocumentClient from './Client';
import type { addDocumentOpenListener } from './Client';
import type { seenImageNatives } from './seenImageNatives';

/**
 * Chrome raises an image's request to a fetch's urgency once the image is
 * laid out in the viewport, so on an HTTP/1 server the images a page shows
 * go before its scripts and the images out of sight (measured in Chrome
 * 157, connection-limits). The transport queues requests as Chrome does
 * (src/transport/socketPool.ts) but cannot see layout, so the document
 * says: until it has loaded, the images still loading are watched by one
 * IntersectionObserver (made only when one is), and each that is in the
 * viewport is named to the worker once (IMAGES_SEEN), which raises its
 * request if it still waits (or when it comes).
 *
 * A deferred part (./deferredParts.ts), started once the worker says one
 * of the document's images waits for a connection (IMAGES_WAITING,
 * ./loadGrants.ts): a frame whose images never wait (an ad's pixel, every
 * image of an HTTP/2 site) runs none of it, nor does one told once its
 * images have loaded, and one that started lets go of its observer once
 * they have. Whether it watches. The bundle hands in what it reads with,
 * so the parts' statement shares none of it: the natives taken before the
 * page ran (./seenImageNatives.ts: a page that replaced
 * requestAnimationFrame, IntersectionObserver or the getters sees none of
 * it), and how the bundle hears of a document.open().
 */
export function seenImages(
	client: DocumentClient,
	natives: typeof seenImageNatives,
	onOpen: typeof addDocumentOpenListener,
): boolean {
	if (!natives) return false;
	const global = client.global;
	const [
		frame,
		Observer,
		observe,
		unobserve,
		disconnect,
		images,
		length,
		complete,
		src,
		target,
		intersecting,
	] = natives;
	const read = (get: () => unknown, that: object) =>
		Reflect.apply(get, that, []);
	/**
	 * whether the document still parses or has an image still loading
	 * (readyState alone will not do: a proxied document reads complete
	 * before its images have loaded)
	 */
	const loading = () => {
		if (global.document.readyState === 'loading') return true;
		const collection = read(images, global.document) as HTMLCollection;
		for (let k = 0, n = read(length, collection) as number; k < n; k++)
			if (!read(complete, collection[k])) return true;
		return false;
	};
	// one whose images waited only a moment (an ad's pixel) and have loaded
	// is not watched at all
	if (!loading()) return false;

	/** what `observer` reports in the viewport, named to the worker once each */
	const report = (
		entries: IntersectionObserverEntry[],
		observer: IntersectionObserver,
	) => {
		const seen: string[] = [];
		for (let k = 0; k < entries.length; k++) {
			const shown = read(target, entries[k]) as HTMLImageElement;
			if (!read(intersecting, entries[k])) continue;
			Reflect.apply(unobserve, observer, [shown]);
			// what it asked for (currentSrc is empty until it has loaded)
			const url = read(src, shown) as string;
			if (url && !read(complete, shown)) seen[seen.length] = url;
		}
		if (seen.length) client.postToWorker({ [IMAGES_SEEN]: seen });
	};
	// the document's images in order as the parser adds them, watched at
	// each frame it renders until it has parsed and they have loaded (Chrome
	// raises them at each layout while the page loads)
	let observer: IntersectionObserver | null = null;
	let scanned = 0;
	let running = false;
	const scan = () => {
		const collection = read(images, global.document) as HTMLCollection;
		for (const n = read(length, collection) as number; scanned < n; scanned++) {
			const image = collection[scanned];
			if (read(complete, image)) continue;
			if (!observer) {
				const made: IntersectionObserver = new Observer((entries) =>
					report(entries, made),
				);
				observer = made;
			}
			Reflect.apply(observe, observer, [image]);
		}
	};
	const stop = () => {
		// an image or a document.open() since: watched again
		if (loading()) return tick();
		if (observer) Reflect.apply(disconnect, observer, []);
		observer = null;
		running = false;
	};
	const tick = () => {
		scan();
		if (loading()) Reflect.apply(frame, global, [tick]);
		// the last images' first report comes after the next rendering
		else
			Reflect.apply(frame, global, [
				() => Reflect.apply(frame, global, [stop]),
			]);
	};
	const start = () => {
		if (observer) Reflect.apply(disconnect, observer, []);
		observer = null;
		scanned = 0;
		if (running) return;
		running = true;
		Reflect.apply(frame, global, [tick]);
	};
	start();
	// document.open() starts the document again
	onOpen(global, start);
	return true;
}
