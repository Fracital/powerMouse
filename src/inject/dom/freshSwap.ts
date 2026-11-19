// A frame's fresh browsing context (./freshContext.ts, which says why): the
// swap of its element and the record of the window it showed, a deferred
// part of the document bundle (./deferredParts.ts), made the first time a
// frame of a document is to show another origin's document where a window
// the page reached would show it. Its top level reads no global: the
// natives are those freshContext.ts took when the bundle loaded.
import ProxyModule from '../modules/Proxy';
import { unrouteURL } from '../modules/Unroute';
import type DocumentClient from './Client';
import {
	frameWindow,
	registry,
	swappingFrames,
	natives as taken,
	weakDeref,
} from './freshContext';
import { appliedAttribute } from './modules/DOMHooks';
import { hiddenMutation } from './modules/MutationObserver';

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
function recordFresh(
	client: DocumentClient,
	element: Element,
	old: object | null,
	destination: string,
	wrap: (native: Function, hook: (args: unknown[]) => unknown) => Function,
) {
	const { frames, elements, weakRef } = registry(client);
	let record = frames.get(element);
	if (!record) frames.set(element, (record = { windows: [], destination }));
	record.destination = destination;
	if (!old || elements.has(old)) return;
	const made = registry(client);
	made.held = (made.held ?? 0) + 1;
	// (the refs of windows nothing holds any more go)
	const kept: WeakRef<object>[] = [];
	for (const ref of record.windows)
		if (Reflect.apply(weakDeref, ref, []) !== undefined)
			kept[kept.length] = ref;
	kept[kept.length] = Reflect.construct(weakRef, [old]) as WeakRef<object>;
	record.windows = kept;
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

/**
 * Give `element` (an iframe or a frame) a fresh browsing context navigated
 * to `routed`, a route the page's navigation already made; `formData`, when
 * the navigation is a POST, is its body. With no route the context is left
 * on its initial about:blank, for a navigation the browser is about to make
 * by the frame's name. Whether it was done.
 */
function freshFrame(
	element: Element,
	routed: string | null,
	formData?: FormData | null,
): boolean {
	const natives = taken;
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

/**
 * DocumentClient.freshFrame of `client` (modules/IFrame.ts): `element`, a
 * frame of its document, gets a fresh context navigated to `routed` (with
 * `formData`, a POST), the window it showed recorded as the frame's for
 * `page` (the page's URL, else the route's). Whether it was done.
 */
export function freshSwap(
	client: DocumentClient,
	element: Element,
	routed: string | null,
	formData?: FormData | null,
	page?: string,
): boolean {
	const old = frameWindow(element);
	if (!freshFrame(element, routed, formData)) return false;
	const proxyModule = client.getModule(ProxyModule)!;
	recordFresh(
		client,
		element,
		old,
		page ?? (routed === null ? '' : (unrouteURL(client, routed) ?? routed)),
		(native, hook) =>
			proxyModule.wrapFunction(native, (target, that, args) => hook(args)),
	);
	return true;
}
