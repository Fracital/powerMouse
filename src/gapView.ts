// What another document reads of a proxied document in the gap, before
// its inject bundle runs: the shell has committed, and the parser waits on
// its scripts. That realm runs nothing of ours yet (a popup's next
// document, or a frame's after one that had loaded, is a new realm), so
// its document's URL, documentURI, baseURI, referrer and domain were the
// route's and the proxy's, where natively they are the page's own. The
// shell's first script (gapView) gives the document itself own getters of
// the page's values, and the bundle takes them off before any other module
// of it runs (closeGapView). The natives the bundle takes are its
// prototypes', which nothing changed: a hook of a prototype in the gap
// would have been taken for the browser's own. What it cannot answer for:
// a read before the parser has run that first script, in a document still
// empty (measured: 2 of 30 popups were read once that early by a page
// polling for them), and a document's members other than these.

/** the members of a document the gap view answers for */
const MEMBERS = ['URL', 'documentURI', 'baseURI', 'referrer', 'domain'];

/**
 * The shell's first script, for a document of `url` (its real URL) whose
 * referrer is `referrer` ('' for none, and for one its client works out
 * from its parent): its URL keeps the route's fragment, which is the page's
 */
export function gapView(url: URL, referrer: string): string {
	const href = url.href.split('#')[0];
	const text = (value: string) =>
		JSON.stringify(value).replace(
			/[<\u007f-￿]/g,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
		);
	return `(()=>{const d=document,u=${text(href)},r=${text(referrer)},h=${text(url.hostname)},g=(v)=>({get:v,configurable:true}),f=()=>{const l=location.href,i=l.indexOf("#");return i<0?u:u+l.slice(i)},n=Object.getOwnPropertyDescriptor(Document.prototype,"domain");Object.defineProperties(d,{URL:g(f),documentURI:g(f),baseURI:g(f),referrer:g(()=>r),domain:{get:()=>h,set:(v)=>n.set.call(d,v),configurable:true}})})()`;
}

/** take the gap view's getters off `document` (the bundle's first act) */
export function closeGapView(document: Document) {
	for (const member of MEMBERS)
		if (Object.prototype.hasOwnProperty.call(document, member))
			Reflect.deleteProperty(document, member);
}
