import type DocumentClient from './Client';
import { appliedAttribute } from './modules/DOMHooks';
import { hiddenMutation } from './modules/MutationObserver';

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
 * document that asks for the swap (src/freshFrame.ts).
 *
 * The element keeps every attribute the page sees: the page's `src` and
 * `srcdoc` stay what it wrote (their markers), the browser's `src` is the
 * route (a frame's first document makes no history entry), or a form with
 * the request's body is submitted for a POST. The empty context's load
 * event, which inserting the element fires, is kept from the page (IFrame).
 */

// taken when the bundle loads, before any of the page's script
const natives = (() => {
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
export const swappingFrames = new WeakSet<Element>();

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

/** what the browsing context group keeps of the fresh contexts its frames were given */
function registry(client: DocumentClient) {
	const group = client.groupClient;
	return (group.freshRegistry ??= {
		frames: new WeakMap(),
		elements: new WeakMap(),
	});
}

/**
 * A frame was given a fresh context for `destination` (the page's URL): the
 * window it showed (`old`) stays the frame's to every realm that held it.
 * Natively that object is the frame's window still, now of another origin,
 * so the realm's `contentWindow`, `frames[i]` and `event.source` of the
 * frame are it (Context), and what may be done to a window of another
 * origin through it (a message, a location set, `closed`, `length`, focus)
 * is done to the frame's window (the access API, and the members below).
 * The rest of it is its old document, of the realm's own origin: nothing
 * of the next one.
 */
export function recordFresh(
	client: DocumentClient,
	element: Element,
	old: object | null,
	destination: string,
	wrap: (native: Function, hook: (args: unknown[]) => unknown) => Function,
) {
	const { frames, elements } = registry(client);
	let record = frames.get(element);
	if (!record) frames.set(element, (record = { windows: [], destination }));
	record.destination = destination;
	if (!old || elements.has(old)) return;
	record.windows.push(old);
	elements.set(old, element);
	const live = () => frameWindow(element);
	const own = (name: string) => {
		try {
			return Reflect.getOwnPropertyDescriptor(old, name);
		} catch (error) {
			return undefined;
		}
	};
	const define = (name: string, descriptor: PropertyDescriptor) => {
		try {
			Reflect.defineProperty(old, name, descriptor);
		} catch (error) {
			// a window being torn down
		}
	};
	for (const [name, read] of [
		['closed', () => live()?.closed ?? true],
		['length', () => live()?.length ?? 0],
	] as const) {
		const descriptor = own(name);
		if (descriptor?.get && descriptor.configurable)
			define(name, {
				...descriptor,
				get: wrap(descriptor.get, () => read()) as () => unknown,
			});
	}
	for (const name of ['focus', 'blur'] as const) {
		const descriptor = own(name);
		if (typeof descriptor?.value === 'function' && descriptor.configurable)
			define(name, {
				...descriptor,
				value: wrap(descriptor.value, () => {
					live()?.[name]();
				}),
			});
	}
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
	let element: Element | null;
	try {
		element = frameElementOf(context);
	} catch (error) {
		return [];
	}
	const record = element && registry(client).frames.get(element);
	return record ? [...record.windows].reverse() : [];
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
	if (!natives?.frameElement) return null;
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

/**
 * Give `element` (an iframe or a frame) a fresh browsing context navigated
 * to `routed`, a route the page's navigation already made; `formData`, when
 * the navigation is a POST, is its body. With no route the context is left
 * on its initial about:blank, for a navigation the browser is about to make
 * by the frame's name. Whether it was done.
 */
export function freshFrame(
	element: Element,
	routed: string | null,
	formData?: FormData | null,
): boolean {
	if (!natives) return false;
	const parent = Reflect.apply(natives.parentNode, element, []) as Node | null;
	if (!parent) return false;
	const next = Reflect.apply(natives.nextSibling, element, []) as Node | null;
	const document = Reflect.apply(
		natives.ownerDocument,
		element,
		[],
	) as Document;
	// a POST: a form of the frame's document, aimed at the new context by a
	// name it is made with for this submission alone
	const name =
		formData && routed !== null
			? `$stomp$fresh${Math.random().toString(36).slice(2)}`
			: null;
	const previous = Reflect.apply(natives.getAttribute, element, ['name']) as
		string | null;
	hiddenMutation(() => {
		Reflect.apply(natives.removeChild, parent, [element]);
		// the real src: the route, where the context starts (a GET); the
		// page's own value is its marker's, which the hooks read back. A POST
		// starts on about:blank and is submitted there
		if (name || routed === null) {
			if (Reflect.apply(natives.hasAttribute, element, ['src']))
				Reflect.apply(natives.removeAttribute, element, ['src']);
			if (name) Reflect.apply(natives.setAttribute, element, ['name', name]);
			swappingFrames.add(element);
		} else Reflect.apply(natives.setAttribute, element, ['src', routed]);
		// a srcdoc would be the new context's document: the page's value is
		// its marker's still
		if (Reflect.apply(natives.hasAttribute, element, ['srcdoc']))
			Reflect.apply(natives.removeAttribute, element, ['srcdoc']);
		Reflect.apply(natives.insertBefore, parent, [element, next]);
	});
	// the src STomp wrote is the one its hooks applied: one at work on the
	// element (the page's own src set) writes nothing over it, and a later
	// run of them (the element moved) starts again from the page's
	appliedAttribute(element, 'src', name ? null : routed);
	appliedAttribute(element, 'srcdoc', null);
	if (!name || !formData || routed === null) return true;
	hiddenMutation(() => {
		const form = Reflect.apply(natives.createElement, document, [
			'form',
		]) as HTMLFormElement;
		Reflect.apply(natives.setAttribute, form, ['method', 'post']);
		Reflect.apply(natives.setAttribute, form, ['action', routed]);
		Reflect.apply(natives.setAttribute, form, ['target', name]);
		let files = false;
		for (const [key, value] of formData.entries()) {
			const input = Reflect.apply(natives.createElement, document, [
				typeof value === 'string' ? 'textarea' : 'input',
			]) as HTMLTextAreaElement | HTMLInputElement;
			Reflect.apply(natives.setAttribute, input, ['name', key]);
			if (typeof value === 'string')
				(input as HTMLTextAreaElement).value = value;
			else {
				files = true;
				Reflect.apply(natives.setAttribute, input, ['type', 'file']);
				const transfer = new DataTransfer();
				transfer.items.add(value);
				(input as HTMLInputElement).files = transfer.files;
			}
			Reflect.apply(natives.appendChild, form, [input]);
		}
		if (files)
			Reflect.apply(natives.setAttribute, form, [
				'enctype',
				'multipart/form-data',
			]);
		Reflect.apply(
			natives.appendChild,
			document.body ?? document.documentElement,
			[form],
		);
		Reflect.apply(natives.submit, form, []);
		Reflect.apply(
			natives.removeChild,
			Reflect.apply(natives.parentNode, form, []) as Node,
			[form],
		);
		if (previous === null)
			Reflect.apply(natives.removeAttribute, element, ['name']);
		else Reflect.apply(natives.setAttribute, element, ['name', previous]);
	});
	return true;
}
