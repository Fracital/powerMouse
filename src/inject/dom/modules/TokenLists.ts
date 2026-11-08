import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';
import { nativeElement } from './DOMHooks';

/**
 * The token lists whose attribute a hook keeps off the real element: an
 * iframe's `sandbox` (an opaque origin the service worker cannot serve) is
 * dropped and read back as the page wrote it. As the constructor's name, the
 * list's property and the attribute it reflects.
 */
const HOOKED_LISTS: [string, string, string][] = [
	['HTMLIFrameElement', 'sandbox', 'sandbox'],
];

// taken while the bundle's realm is untouched: a list is computed on a
// detached copy of the element, which no hook may see
const nativeCreateElement = Document.prototype.createElement;
const nativeOwnerDocument = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'ownerDocument',
)!.get!;
const nativeLocalName = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'localName',
)!.get!;
const nativeListGetters = new Map(
	HOOKED_LISTS.map(([ctor, property]) => [
		property,
		Reflect.getOwnPropertyDescriptor(
			(globalThis as any)[ctor]?.prototype ?? {},
			property,
		)?.get,
	]),
);

/**
 * A token list writes its attribute itself (`iframe.sandbox.add(flag)`,
 * `.toggle`, `.replace`, `.remove`, `.value = x`): no attribute hook sees
 * it. reCAPTCHA sets its anchor frame's sandbox attribute, then adds each
 * newer flag the browser supports that way, so the frame was really
 * sandboxed with the added flags alone: an opaque origin, whose navigation
 * skipped the service worker and reached the proxy server (a 404), with no
 * scripts. A call on a hooked list is made on a detached copy holding the
 * page's value, so it returns and throws as it would natively, and its
 * result is written back through the page's setAttribute, where the hooks
 * and the page's observers see one write. Reads stay native: the list is
 * an array-like whose indexed reads no hook can reach, so its own reads
 * agree with each other (and show the real list) rather than with
 * getAttribute.
 */
export default class TokenListsModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const proxyModule = this.client.getModule(ProxyModule)!;
		// the page-facing pair: the page's value in, the hooks on the way out
		const pageGetAttribute = global.Element.prototype.getAttribute;
		const pageSetAttribute = global.Element.prototype.setAttribute;

		// each hooked list is the same object every time its getter answers
		const owners = new WeakMap<object, [Element, string, string]>();
		for (const [ctor, property, attribute] of HOOKED_LISTS) {
			const prototype = (global as any)[ctor]?.prototype;
			const descriptor =
				prototype && Reflect.getOwnPropertyDescriptor(prototype, property);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(prototype, property, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const list = Reflect.apply(target, that, args);
					if (typeof list === 'object' && list !== null)
						owners.set(list, [that, property, attribute]);
					return list;
				}),
			});
		}

		/**
		 * Run `call` on a detached copy of the owner's list holding the page's
		 * value; when `wrote` says the call updated the attribute, the copy's
		 * value is written to the owner as the page's own setAttribute.
		 */
		const onCopy = <T>(
			list: object,
			call: (copy: DOMTokenList) => T,
			wrote: (
				result: T,
				before: string | null,
				after: string | null,
			) => boolean,
		): { result: T } | null => {
			const owner = owners.get(list);
			const getter = owner && nativeListGetters.get(owner[1]);
			if (!owner || !getter) return null;
			const [element, , attribute] = owner;
			const copy = Reflect.apply(
				nativeCreateElement,
				Reflect.apply(nativeOwnerDocument, element, []),
				[Reflect.apply(nativeLocalName, element, [])],
			) as Element;
			const before = Reflect.apply(pageGetAttribute, element, [attribute]) as
				string | null;
			if (before !== null)
				Reflect.apply(nativeElement.setAttribute, copy, [attribute, before]);
			const result = call(Reflect.apply(getter, copy, []));
			const after = Reflect.apply(nativeElement.getAttribute, copy, [
				attribute,
			]) as string | null;
			if (after !== null && wrote(result, before, after))
				Reflect.apply(pageSetAttribute, element, [attribute, after]);
			return { result };
		};

		const prototype = global.DOMTokenList.prototype;
		const methods: [
			string,
			(result: unknown, before: string | null, after: string | null) => boolean,
		][] = [
			// the update steps run unless there was no attribute and is no token
			['add', () => true],
			['remove', () => true],
			// a toggle that leaves the token where it was updates nothing; one
			// that adds or removes it always changes the value
			['toggle', (_result, before, after) => before !== after],
			// a replace of a token the list does not hold updates nothing
			['replace', (result) => result === true],
		];
		for (const [name, wrote] of methods) {
			const native = Reflect.get(prototype, name);
			if (typeof native !== 'function') continue;
			Reflect.set(
				prototype,
				name,
				proxyModule.wrapFunction(native, (target, that, args) => {
					const done = onCopy(
						that,
						(copy) => Reflect.apply(target, copy, args),
						wrote,
					);
					return done ? done.result : Reflect.apply(target, that, args);
				}),
			);
		}
		// `list.value = x` sets the attribute, whatever it held
		const value = Reflect.getOwnPropertyDescriptor(prototype, 'value');
		if (value?.set)
			Reflect.defineProperty(prototype, 'value', {
				...value,
				set: proxyModule.wrapFunction(value.set, (target, that, args) => {
					const done = onCopy(
						that,
						(copy) => Reflect.apply(target, copy, args),
						() => true,
					);
					if (!done) Reflect.apply(target, that, args);
				}),
			});
	}
}
