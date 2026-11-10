/**
 * The documents an XMLHttpRequest made of a response, by the URL they read
 * back: the response's, as natively (`document.URL`, `documentURI`, a
 * node's `baseURI`, and the base a link in one resolves against). The
 * browser makes them from a data: URL of the response's bytes
 * (XMLHttpRequest module), so their own URL is that, and the page-facing
 * getters say the page's URL for every other document. Shared by every
 * client of this bundle: a document is one realm's or another's, never
 * both.
 */
export const responseURLs = new WeakMap<Document, string>();

/** the URL `node`'s document reads back when it is a response's, else null */
export function responseURLOf(node: Node | null | undefined): string | null {
	if (!node) return null;
	const document =
		node.nodeType === 9 ? (node as Document) : node.ownerDocument;
	return (document && responseURLs.get(document)) ?? null;
}
