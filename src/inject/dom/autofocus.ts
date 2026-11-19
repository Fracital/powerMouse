import type DocumentClient from './Client';

type Focusable = { focus(): void };

/**
 * A page's autofocus, which natively the browser runs for it: the proxied
 * top is a frame of the host's page, and Chrome runs autofocus for its top
 * document only, the host's. There the address bar has the focus (Chrome
 * drops the candidates), and in the demo's isolation mode the frame is of
 * another origin, where it refuses them outright ("Blocked autofocusing on
 * a <input> element in a cross-origin subframe"). So Bing's search box,
 * which a user types into as the page appears, had no focus. Natively the
 * page is a top, and its autofocus candidates are flushed at a rendering
 * update (HTML's flush autofocus candidates): once per document, nothing
 * when something has the focus by then or the document is at a fragment's
 * target, after its style sheets have loaded, the first candidate that
 * takes the focus. Returns what to call once the document's tree changed
 * (the Navigate module's observer), or null in a real top.
 */
export function autofocusFlush(client: DocumentClient): (() => void) | null {
	const global = client.global;
	if (client.proxiedTop !== global || client.parent === global) return null;
	const document = global.document;
	const proto = global.Document.prototype;
	const all = proto.querySelectorAll;
	const one = proto.querySelector;
	const get = (of: object, name: string) =>
		Reflect.getOwnPropertyDescriptor(of, name)!.get!;
	const activeGet = get(proto, 'activeElement');
	const bodyGet = get(proto, 'body');
	const readyGet = get(proto, 'readyState');
	const link = global.HTMLLinkElement.prototype;
	const sheetGet = get(link, 'sheet');
	const disabledGet = get(link, 'disabled');
	const isPrototypeOf = Object.prototype.isPrototypeOf;
	// taken now, before the page can replace them
	const focuses: [object, () => void][] = [];
	for (const name of ['HTMLElement', 'SVGElement', 'MathMLElement']) {
		const type = (
			global as unknown as Record<string, { prototype: Focusable }>
		)[name];
		if (type) focuses.push([type.prototype, type.prototype.focus]);
	}
	const frame = global.requestAnimationFrame;
	const call = (target: Function, that: unknown, args: unknown[] = []) =>
		Reflect.apply(target, that, args);
	const unfocused = () => {
		const active = call(activeGet, document);
		return !active || active === call(bodyGet, document);
	};
	const tried = new WeakSet<Element>();
	let processed = false;
	let scheduled = false;
	const flush = () => {
		scheduled = false;
		if (processed) return;
		const candidates = [
			...(call(all, document, ['[autofocus]']) as NodeListOf<Element>),
		].filter((element) => !tried.has(element));
		if (!candidates.length) return;
		if (!unfocused() || call(one, document, [':target'])) {
			processed = true;
			return;
		}
		// a style sheet still loading: the next update
		if (
			call(readyGet, document) !== 'complete' &&
			[
				...(call(all, document, [
					'link[rel~=stylesheet i]',
				]) as NodeListOf<HTMLLinkElement>),
			].some(
				(element) => !call(sheetGet, element) && !call(disabledGet, element),
			)
		) {
			schedule();
			return;
		}
		for (const element of candidates) {
			tried.add(element);
			const owner = focuses.find(([prototype]) =>
				call(isPrototypeOf, prototype, [element]),
			);
			if (owner) call(owner[1], element);
			if (!unfocused()) {
				processed = true;
				return;
			}
		}
	};
	const schedule = () => {
		if (processed || scheduled) return;
		scheduled = true;
		call(frame, global, [flush]);
	};
	return schedule;
}
