// What a click activates and where a document's links and forms go by
// default, as the hooks read them: by the page's own attributes (the
// hooked getAttribute answers with what the page wrote).

/**
 * the link (an `a` or `area` with an href, and with the attribute `also`
 * when it is given) on `event`'s path, nearest first, if any
 */
export const clickedLink = (
	global: typeof globalThis,
	event: Event,
	also?: string,
): HTMLAnchorElement | HTMLAreaElement | undefined =>
	event
		.composedPath()
		.find(
			(node): node is HTMLAnchorElement | HTMLAreaElement =>
				node instanceof global.Element &&
				(node.nodeName === 'A' || node.nodeName === 'AREA') &&
				node.hasAttribute('href') &&
				(!also || node.hasAttribute(also)),
		);

/** the target `document`'s base element gives its links and forms, '' for none */
export const baseTarget = (document: Document): string =>
	document.querySelector('base[target]')?.getAttribute('target') ?? '';

/** targets that navigate a document's own frame or an ancestor of it */
export const SAME_FRAME = ['', '_self', '_top', '_parent', '_unfencedtop'];
