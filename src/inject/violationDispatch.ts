// A violation the inject dispatches itself where the browser's own would be
// trusted (a document's, ./dom/violations.ts, a deferred part; a worker's
// refused connection, ./worker/Client.ts). isTrusted is an own,
// non-configurable accessor Chrome puts on every event, so it cannot be set
// on the inject's event: every listener of the dispatch is handed one view
// of it instead, a Proxy whose `isTrusted` reads true and whose every other
// member is the event's own, as natively one object is handed to each
// listener and read as window.event. The listeners added with
// addEventListener are handed it by ./violationViews.ts; the on- handlers of
// the dispatch's path are swapped for the dispatch; window.event and the
// members of Event.prototype (a view handed as `this`) are hooked in place
// at a realm's first such event, which only a page whose policy refuses
// something makes.
import type ProxyModule from './modules/Proxy';
import { LazyWeakMap, LazyWeakSet } from './ownCollections';
import { NativeProxy } from './violationViews';

/** the event of each view, for a member of Event.prototype it is `this` of */
const viewed = new LazyWeakMap<object, object>();
/** the realms whose window.event and Event members read views */
const hooked = new LazyWeakSet<object>();

const HANDLER = 'onsecuritypolicyviolation';

/**
 * Dispatch `event` on `target` with the realm's views (`views`, which its
 * listeners read: ./violationViews.ts), the event's path being `path` (the
 * document and its window, a worker's global): each listener, on- handler
 * and window.event reads one view of it that is trusted.
 */
export function dispatchAsTrusted(
	global: typeof globalThis,
	proxyModule: ProxyModule,
	views: LazyWeakMap<object, object>,
	dispatch: Function,
	target: EventTarget,
	path: EventTarget[],
	event: Event,
) {
	const view = new NativeProxy(event, {
		// (receiver is the event: its getters run on it, as a Proxy receiver
		// throws "Illegal invocation")
		get: (event, key) => (key === 'isTrusted' ? true : Reflect.get(event, key)),
		set: (event, key, value) => Reflect.set(event, key, value),
	});
	views.set(event, view);
	viewed.set(view, event);
	if (!hooked.has(global)) {
		hooked.add(global);
		const prototype = global.Event.prototype as unknown as Record<
			string,
			unknown
		>;
		for (const key of Reflect.ownKeys(prototype)) {
			const value = Reflect.getOwnPropertyDescriptor(prototype, key)?.value;
			if (typeof value === 'function' && key !== 'constructor')
				prototype[key as string] = proxyModule.wrapFunction(
					value,
					(target, that, args) =>
						Reflect.apply(target, viewed.get(that as object) ?? that, args),
				);
		}
		const own = Reflect.getOwnPropertyDescriptor(global, 'event');
		if (own?.get)
			Reflect.defineProperty(global, 'event', {
				...own,
				get: proxyModule.wrapFunction(own.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					return (value && views.get(value)) ?? value;
				}),
			});
	}
	// an on- handler is handed the view, and is the page's own again once
	// it is called (or the dispatch ends): a value set in its place, or the
	// same set again, keeps the handler's place among the listeners
	const restores: (() => void)[] = [];
	for (const at of path) {
		const handler = Reflect.get(at, HANDLER);
		if (typeof handler !== 'function') continue;
		const restore = () => {
			if (Reflect.get(at, HANDLER) === swapped)
				Reflect.set(at, HANDLER, handler);
		};
		const swapped = function (this: unknown, event: Event) {
			restore();
			return Reflect.apply(handler, this, [views.get(event) ?? event]);
		};
		Reflect.set(at, HANDLER, swapped);
		restores.push(restore);
	}
	try {
		Reflect.apply(dispatch, target, [event]);
	} finally {
		for (const restore of restores) restore();
	}
}
