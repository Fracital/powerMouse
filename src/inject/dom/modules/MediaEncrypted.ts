import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';
import CanvasTaintModule from './CanvasTaint';

type Getter = (this: unknown) => unknown;

/**
 * The encrypted event carries a media's init data (its key ids) only when
 * the media is CORS-same-origin: Chrome gives another origin's media loaded
 * without CORS an empty initDataType and an empty initData. Every route is
 * same-origin to the browser, so another site's media gave the page its key
 * ids. The browser's event of media that taints (CanvasTaint's verdict)
 * reads as Chrome's does; an event the page made keeps what it was made
 * with.
 */
export default class MediaEncryptedModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global as typeof client.global & {
			MediaEncryptedEvent?: { prototype: object };
		};
		const proto = global.MediaEncryptedEvent?.prototype;
		const canvasTaint = client.getModule(CanvasTaintModule);
		if (!proto || !canvasTaint) return;
		const proxyModule = client.getModule(ProxyModule)!;
		const target = Reflect.getOwnPropertyDescriptor(
			global.Event.prototype,
			'target',
		)!.get as Getter;
		/** the empty init data of each event that hides its own */
		const hidden = new WeakMap<object, ArrayBuffer>();
		const hides = (event: unknown): boolean => {
			if (hidden.has(event as object)) return true;
			// (isTrusted is the event's own, and the page cannot change it)
			if (!(event as Event).isTrusted) return false;
			// the browser fires it from the media's bytes, which may be before
			// the element says it has any (readyState 0): the verdict is asked
			// as for an element with data
			if (!canvasTaint.taints(Reflect.apply(target, event, []), true))
				return false;
			hidden.set(event as object, new global.ArrayBuffer(0));
			return true;
		};
		for (const name of ['initDataType', 'initData'] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (get, that, args) => {
					// the native getter first: it throws for anything else
					const value = Reflect.apply(get, that, args);
					if (!hides(that)) return value;
					return name === 'initDataType' ? '' : hidden.get(that as object);
				}),
			});
		}
	}
}
