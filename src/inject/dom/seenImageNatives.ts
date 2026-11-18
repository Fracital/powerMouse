// The browser's own members the watch of a document's images
// (./seenImages.ts) reads with, taken when the bundle runs, before any page
// script: the watch is a deferred part (./deferredParts.ts), evaluated only
// once the worker says one of the document's images waits for a connection.
// One array, as a frame pays for every binding the bundle keeps.
const getter = (prototype: object, name: string) =>
	Reflect.getOwnPropertyDescriptor(prototype, name)!.get!;

export const seenImageNatives = (() => {
	if (typeof IntersectionObserver !== 'function') return null;
	const observer = IntersectionObserver.prototype;
	const image = HTMLImageElement.prototype;
	const entry = IntersectionObserverEntry.prototype;
	return [
		requestAnimationFrame,
		IntersectionObserver,
		observer.observe,
		observer.unobserve,
		observer.disconnect,
		getter(Document.prototype, 'images'),
		getter(HTMLCollection.prototype, 'length'),
		getter(image, 'complete'),
		getter(image, 'src'),
		getter(entry, 'target'),
		getter(entry, 'isIntersecting'),
	] as const;
})();
