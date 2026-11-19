// A deferred part (./deferredParts.ts): the getters of the event handler
// properties whose attribute a document's markup or code has written.
//
// Chrome compiles a handler of an attribute as its property is first read
// (`el.onclick`) if it did not run before, and judges it then by the
// policies in force, as at a run: the property reads null where refused,
// and a handler compiled before any policy governed code runs later
// whatever policy comes. The getter of each handler property the page's
// attributes use is hooked so (DocumentClient codeRuns keeps the verdict,
// the compiled handler's), in every document, the first time the inject
// meets an attribute of that name (modules/DOMAttributes.ts), before the
// element is in the document. Only those: reading the descriptors of every
// handler (some 300 on Element, HTMLElement and SVGElement) makes their
// native getters and setters, some 19 KB a frame (../modules/Proxy.ts
// applyDescriptors), where a frame's markup uses a few names.
import ProxyModule from '../modules/Proxy';
import type DocumentClient from './Client';
import { nativeGetAttribute } from './Client';
import { nativeNodeType } from './cloneNode';

/** the handlers a body's attributes give its window, besides those of the body's own interface */
const BODY_WINDOW = [
	'onblur',
	'onerror',
	'onfocus',
	'onload',
	'onresize',
	'onscroll',
];

/**
 * The hooked native getters, each with its property's name and whether its
 * handler is a window's: one table the shared getter body (`readers`) reads
 */
const names = new WeakMap<Function, [string, boolean]>();

/** each document's one getter body, which every hooked getter of its realm calls */
const readers = new WeakMap<
	DocumentClient,
	(target: Function, that: unknown) => unknown
>();

/** the handler property `name`'s getters in `client`'s realm, hooked */
export function hookHandlerName(client: DocumentClient, name: string) {
	const g = client.global as typeof globalThis & {
		MathMLElement?: { prototype: object };
	};
	const proxyModule = client.getModule(ProxyModule);
	if (!proxyModule) return;
	let reader = readers.get(client);
	if (!reader) {
		reader = (target, that) => {
			const [name, windows] = names.get(target)!;
			return read(client, name, windows, Reflect.apply(target, that, []), that);
		};
		readers.set(client, reader);
	}
	const body = g.HTMLBodyElement.prototype;
	const frameset = g.HTMLFrameSetElement?.prototype;
	for (const owner of [
		g,
		g.Element.prototype,
		g.HTMLElement.prototype,
		g.SVGElement.prototype,
		g.MathMLElement?.prototype,
		g.HTMLMediaElement.prototype,
		body,
		frameset,
	]) {
		if (!owner) continue;
		// (a body's handler of the window's, its attribute the body's: the
		// window's others have none)
		if (
			owner === g &&
			!BODY_WINDOW.includes(name) &&
			!Reflect.getOwnPropertyDescriptor(body, name)
		)
			continue;
		const descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
		if (!descriptor?.get || !descriptor.configurable) continue;
		names.set(descriptor.get, [
			name,
			owner === g || owner === body || owner === frameset,
		]);
		descriptor.get = proxyModule.wrapFunction(descriptor.get, reader);
		Reflect.defineProperty(owner, name, descriptor);
	}
}

/**
 * A read of the handler property `name` of `that` whose native value is
 * `value`: the handler of its attribute (marked with the key of the page's
 * text: modules/DOMAttributes.ts) compiles now if it has not run, judged as
 * it runs (DocumentClient codeRuns, which keeps the verdict: false where no
 * policy governs code yet); refused, it reads null
 */
function read(
	client: DocumentClient,
	name: string,
	windows: boolean,
	value: unknown,
	that: unknown,
): unknown {
	if (value === null) return value;
	const g = client.global as typeof globalThis;
	let element: Element | null = null;
	try {
		element =
			that === g
				? g.document.body
				: Reflect.apply(nativeNodeType, that, []) === 1
					? (that as Element)
					: null;
	} catch (error) {
		// neither
	}
	const key =
		element &&
		(
			Reflect.apply(nativeGetAttribute, element, [name]) as string | null
		)?.match(/^\/\*(.+?)\*\//)?.[1];
	if (!key) return value;
	client.handlerRead = true;
	try {
		return client.codeRuns(windows ? g : that, key) ? null : value;
	} finally {
		client.handlerRead = false;
	}
}
