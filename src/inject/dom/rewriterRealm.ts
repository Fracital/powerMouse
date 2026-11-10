import rewriterLib from 'stomp:rewriter-lib';
import type { RewriterLib } from '../../rewriterLib';

// taken when the bundle loads, before any hook or page code runs: the realm
// is made through the browser's own methods, so no hook of ours (the IFrame
// module injects a client into new frames) and no page code sees the frame
const createElement = Document.prototype.createElement;
const appendChild = Node.prototype.appendChild;
const removeChild = Node.prototype.removeChild;
const documentElementGet = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'documentElement',
)!.get!;
const contentWindowGet = Reflect.getOwnPropertyDescriptor(
	HTMLIFrameElement.prototype,
	'contentWindow',
)!.get!;
const toSource = Function.prototype.toString;

/**
 * The rewriter library (src/rewriterLib.ts) in a realm of its own, for a
 * proxied top and every frame under it (src/inject/rewriter.ts), or null
 * when one cannot be made (a document whose script policy refuses eval: a
 * sandbox without allow-scripts, sandbox.ts).
 *
 * The realm is an about:blank frame's, made in `document` and removed again
 * in the same task, before any page code of the document runs: no page can
 * reach it, so no page can change what its code reads (a page that replaces
 * `String.prototype.slice` in its own realm changes nothing here), and no
 * frame of one site can reach the realm of another's through it. The
 * library is evaluated there while the frame is in the document: a removed
 * frame's realm still runs code, but the DOM globals it would look up later
 * (URL, atob) are gone, so the library takes those when it is evaluated
 * (src/libGlobals.ts). What the realm holds is the library and the last
 * call's context, nothing of any one site's (rewriterLib.ts).
 */
export function createRewriterRealm(document: Document): RewriterLib | null {
	let root: Element | null = null;
	let frame: HTMLIFrameElement | null = null;
	try {
		root = Reflect.apply(documentElementGet, document, []) as Element | null;
		if (!root) return null;
		frame = Reflect.apply(createElement, document, [
			'iframe',
		]) as HTMLIFrameElement;
		Reflect.apply(appendChild, root, [frame]);
		const realm = Reflect.apply(contentWindowGet, frame, []) as
			(typeof globalThis & { eval: (code: string) => unknown }) | null;
		if (!realm) return null;
		// the library's own text, which names nothing of this bundle's
		const make = realm.eval(`(${Reflect.apply(toSource, rewriterLib, [])})`);
		if (typeof make !== 'function') return null;
		const lib = make() as RewriterLib;
		return typeof lib === 'object' && lib !== null ? lib : null;
	} catch (error) {
		return null;
	} finally {
		if (root && frame)
			try {
				Reflect.apply(removeChild, root, [frame]);
			} catch (error) {
				// not in the document after all
			}
	}
}
