import type { RewriterLib } from '../../rewriterLib';
import { LIBRARY_FACTORY } from '../../version';
import { lightFactory } from '../rewriter';

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
const setAttribute = Element.prototype.setAttribute;
const textContentSet = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'textContent',
)!.set!;

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
export function createRewriterRealm(
	document: Document,
	/** what makes the library: the light one (src/inject/rewriter.ts lightFactory), or the rewriter library itself when the shell loaded it (givenLibrary) */
	given?: (realm?: Record<string, unknown>) => RewriterLib,
): RewriterLib | null {
	let root: Element | null = null;
	let frame: HTMLIFrameElement | null = null;
	try {
		const factory = given ?? lightFactory();
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
		const make = realm.eval(`(${Reflect.apply(toSource, factory, [])})`);
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

/**
 * The rewriter library's factory from the asset's `text`, run in this
 * realm's `document` as a script with its script policy's `nonce`: for a
 * document whose policy refuses eval (a sandbox without allow-scripts,
 * sandbox.ts), where the library cannot make it from the text itself
 * (src/rewriterLight.ts). The shell's own scripts run the same way. The
 * text assigns the factory to a name (src/version.ts LIBRARY_FACTORY),
 * which is made here, not enumerable, and is gone again with the script's
 * element before this returns: an inline script runs as it is inserted,
 * and it is inserted with the browser's own methods, which no hook of ours
 * and no observer sees first. Null when the script did not run.
 */
export function libraryFactoryFromScript(
	document: Document,
	text: string,
	nonce: string,
	/** the name the text assigns: the rewriter library's, or the light library's */
	name: string = LIBRARY_FACTORY,
): ((realm?: Record<string, unknown>) => RewriterLib) | null {
	let root: Element | null = null;
	let script: Element | null = null;
	try {
		root = Reflect.apply(documentElementGet, document, []) as Element | null;
		if (!root) return null;
		script = Reflect.apply(createElement, document, ['script']) as Element;
		Reflect.apply(setAttribute, script, ['nonce', nonce]);
		Reflect.apply(textContentSet, script, [text]);
		Reflect.defineProperty(globalThis, name, {
			value: undefined,
			writable: true,
			configurable: true,
		});
		Reflect.apply(appendChild, root, [script]);
		const made: unknown = Reflect.getOwnPropertyDescriptor(
			globalThis,
			name,
		)?.value;
		return typeof made === 'function'
			? (made as (realm?: Record<string, unknown>) => RewriterLib)
			: null;
	} catch (error) {
		return null;
	} finally {
		Reflect.deleteProperty(globalThis, name);
		if (root && script)
			try {
				Reflect.apply(removeChild, root, [script]);
			} catch (error) {
				// not in the document after all
			}
	}
}
