// What another document reads of a proxied document in the gap, before
// its inject bundle runs: the shell has committed, and the parser waits on
// its scripts. That realm runs nothing of ours yet (a popup's next
// document, or a frame's after one that had loaded, is a new realm), so
// its document's URL, documentURI, baseURI, referrer and domain were the
// route's and the proxy's, where natively they are the page's own. The
// shell's first script (src/htmlShell.ts gapView) gives the document itself
// own getters of the page's values, and the bundle takes them off before
// any other module of it runs (closeGapView). The natives the bundle takes are its
// prototypes', which nothing changed: a hook of a prototype in the gap
// would have been taken for the browser's own. What it cannot answer for:
// a read before the parser has run that first script, in a document still
// empty (measured: 2 of 30 popups were read once that early by a page
// polling for them), and a document's members other than these.

/** the members of a document the gap view answers for */
const MEMBERS = ['URL', 'documentURI', 'baseURI', 'referrer', 'domain'];

/** take the gap view's getters off `document` (the bundle's first act) */
export function closeGapView(document: Document) {
	for (const member of MEMBERS)
		if (Object.prototype.hasOwnProperty.call(document, member))
			Reflect.deleteProperty(document, member);
}
