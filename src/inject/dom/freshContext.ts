import { LazyWeakSet } from '../ownCollections';
import type DocumentClient from './Client';

/**
 * A fresh browsing context for a frame whose next document is of another
 * origin than the one it shows. Every proxied site is the proxy's one real
 * origin, so the browser keeps a window a page reached while the frame was
 * of its own origin as the page's to read once the frame shows another
 * site; natively that window is then a cross-origin one. No hook can take
 * back the object the page holds, so the next document never loads where it
 * could reach it: the frame element is taken out and put back where it was
 * (a new browsing context), and the navigation goes on there, before
 * anything of the other origin arrives. Measured natively (Chrome 152, 156):
 * a held window keeps its identity across a cross-site navigation and
 * throws on every read but `length`, `top`, `parent` and `closed`, and a
 * message, a location set, focus and blur through it reach the frame.
 *
 * The window the page held shows its old document, of the page's origin,
 * and stays the frame's window to every realm that held it (recordFresh):
 * the frame's `contentWindow`, `frames[i]` and its messages' `event.source`
 * are that object, and a message, a location set or a read through the
 * access API goes to the frame's window as the realm has it (a stand-in of
 * another origin). Its plain reads are its old document's, not a
 * SecurityError; nothing of the next one.
 *
 * Gates (each before the other origin's document commits): the frame's own
 * document cancels the navigation in its `navigate` event (IFrame); a frame
 * still on its initial about:blank, which fires none, is swapped by the
 * page's `src` setter (DOMAttributes), its location setters (Location),
 * `window.open` by name (DOMHooks) and links and forms aimed at it
 * (IFrame); a redirect to another origin is answered by the worker with a
 * document that asks for the swap (src/freshFrame.ts). A frame or popup
 * whose first document (its src, window.open's URL) is of another origin
 * needs none: the page reads its about:blank as a stand-in from the start
 * and nothing injects it (ContextModule pendingForeign), so the window the
 * browser keeps for that document is as fresh as a new one. A document
 * that still finds a client of another origin in its window leaves it
 * here before any of it runs (DocumentClient keptFor, leaveKept).
 *
 * The element keeps every attribute the page sees: the page's `src` and
 * `srcdoc` stay what it wrote (their markers), the browser's `src` is the
 * route (a frame's first document makes no history entry), or a form with
 * the request's body is submitted for a POST. The empty context's load
 * event, which inserting the element fires, is kept from the page (IFrame).
 */

// taken when the bundle loads, before any of the page's script
export const natives = (() => {
	try {
		const getter = (from: object, name: string) =>
			Reflect.getOwnPropertyDescriptor(from, name)!.get!;
		return {
			parentNode: getter(Node.prototype, 'parentNode'),
			nextSibling: getter(Node.prototype, 'nextSibling'),
			ownerDocument: getter(Node.prototype, 'ownerDocument'),
			insertBefore: Node.prototype.insertBefore,
			removeChild: Node.prototype.removeChild,
			getAttribute: Element.prototype.getAttribute,
			setAttribute: Element.prototype.setAttribute,
			removeAttribute: Element.prototype.removeAttribute,
			hasAttribute: Element.prototype.hasAttribute,
			createElement: Document.prototype.createElement,
			appendChild: Node.prototype.appendChild,
			submit: HTMLFormElement.prototype.submit,
			contentWindow: getter(HTMLIFrameElement.prototype, 'contentWindow'),
			frameContentWindow: getter(HTMLFrameElement.prototype, 'contentWindow'),
			isConnected: getter(Node.prototype, 'isConnected'),
			// a window's own accessors answer for any window
			frameElement: Reflect.getOwnPropertyDescriptor(globalThis, 'frameElement')
				?.get,
			parent: Reflect.getOwnPropertyDescriptor(globalThis, 'parent')?.get,
			destinationURL:
				'NavigationDestination' in globalThis
					? getter(
							(globalThis as unknown as { NavigationDestination: Function })
								.NavigationDestination.prototype,
							'url',
						)
					: null,
		};
	} catch (error) {
		return null;
	}
})();

/** the frame elements being given a fresh context: their next load event is the empty one's */
export const swappingFrames = new LazyWeakSet<Element>();

/** the window a frame element shows, as the browser has it */
export function frameWindow(element: Element): Window | null {
	if (!natives) return null;
	try {
		return Reflect.apply(
			element.nodeName === 'FRAME'
				? natives.frameContentWindow
				: natives.contentWindow,
			element,
			[],
		) as Window | null;
	} catch (error) {
		return null;
	}
}

const NativeWeakRef = WeakRef;
export const weakDeref = WeakRef.prototype.deref;

/**
 * What the browsing context group keeps of the fresh contexts its frames
 * were given. A frame's old windows are held weakly: one matters only to a
 * realm that holds it (Context), and each kept its whole realm (about a
 * megabyte with the inject) for as long as the frame element, one more for
 * every navigation of an ad frame from one site to another. The refs are
 * made by the registry's realm: an object keeps the realm that made it.
 */
export function registry(client: DocumentClient) {
	const group = client.groupClient;
	return (group.freshRegistry ??= {
		frames: new WeakMap(),
		elements: new WeakMap(),
		weakRef: NativeWeakRef,
	});
}

/** the old windows of a frame's record still alive, latest last */
function liveWindows(record: { windows: WeakRef<object>[] }): object[] {
	const live: object[] = [];
	for (const ref of record.windows) {
		const window = Reflect.apply(weakDeref, ref, []) as object | undefined;
		if (window) live[live.length] = window;
	}
	return live;
}

/** the page's URL the fresh context of `element` is on its way to, else its src */
export function frameDestination(
	client: DocumentClient,
	element: object,
): unknown {
	return (
		registry(client).frames.get(element as Element)?.destination ??
		Reflect.get(element, 'src')
	);
}

/** the frame's src set by the page again: its own destination from now on */
export function forgetDestination(client: DocumentClient, element: Element) {
	const record = registry(client).frames.get(element);
	if (record) record.destination = null;
}

/**
 * The windows `context` (a frame's window now) stands for in a realm that
 * held one before the frame got a fresh context, latest first
 */
export function heldBefore(client: DocumentClient, context: object): object[] {
	// (asked of every stand-in handed out: a group that never gave a frame a
	// fresh context while a window of it was held has no record to find)
	if (!registry(client).held) return [];
	let element: Element | null = null;
	try {
		element = frameElementOf(context);
	} catch (error) {
		// a window of another origin
	}
	// (the site pool: a frame showing another slot's document names no
	// element to this origin; one of this document's frames shows it)
	if (!element && client.sites && registry(client).held)
		try {
			for (const frame of Array.from(
				client.global.document.querySelectorAll('iframe, frame'),
			))
				if (frameWindow(frame) === context) {
					element = frame;
					break;
				}
		} catch (error) {
			// a document being torn down
		}
	const record = element && registry(client).frames.get(element);
	return record ? liveWindows(record).reverse() : [];
}

/**
 * `target` when it is a window a frame showed before its fresh context:
 * the frame and its window now (null once the element is out of its
 * document, as a removed frame's window is closed natively too)
 */
export function frameOfHeld(
	client: DocumentClient,
	target: unknown,
): { element: Element; now: Window | null } | null {
	if ((typeof target !== 'object' && typeof target !== 'function') || !target)
		return null;
	const element = registry(client).elements.get(target);
	if (!element || !natives) return null;
	const connected = Reflect.apply(natives.isConnected, element, []);
	return { element, now: connected ? frameWindow(element) : null };
}

/** the frame element a window is the frame of, read natively */
function frameElementOf(context: object): Element | null {
	// (a window of another origin names none to this one, and would throw:
	// its prototype is null to this realm, as no window of its own has)
	if (!natives?.frameElement || Reflect.getPrototypeOf(context) === null)
		return null;
	return Reflect.apply(natives.frameElement, context, []) as Element | null;
}

/** the frame element `global` is the window of, and the client of its document */
export function containerOf(
	global: typeof globalThis,
	clientName: string,
): { element: Element; parent: DocumentClient } | null {
	try {
		// the browser's parent: the page's getter answers with a stand-in for
		// one of another origin
		if (!natives?.parent) return null;
		const above = Reflect.apply(natives.parent, global, []) as unknown as
			typeof globalThis | null;
		if (!above || (above as unknown) === (global as unknown)) return null;
		const parent = (above as unknown as Record<string, unknown>)[clientName] as
			DocumentClient | undefined;
		if (!parent?.isDOM) return null;
		for (const element of Array.from(
			parent.global.document.querySelectorAll('iframe, frame'),
		))
			if (frameWindow(element) === (global as unknown))
				return { element, parent };
	} catch (error) {
		// a parent of another real origin (the host): not ours
	}
	return null;
}

/** where a navigate event's `destination` goes, as the browser has it (routed) */
export function destinationURL(destination: object): string | null {
	if (!natives?.destinationURL) return null;
	try {
		return Reflect.apply(natives.destinationURL, destination, []) as string;
	} catch (error) {
		return null;
	}
}
