import type ProxyModule from './modules/Proxy';
import { LazyWeakMap } from './ownCollections';

/**
 * Hand the realm's securitypolicyviolation listeners a view of each event
 * of `tagged` that reads isTrusted true: a violation the inject dispatches
 * itself where the browser's own would be trusted (an enforced Trusted
 * Types violation in a document, which the browser never gets the
 * directive for; a worker's refused connection, which no worker sees).
 * isTrusted is an own, non-configurable accessor Chrome puts on every
 * event, so it cannot be set on the inject's own event: the listener is
 * handed a Proxy whose `isTrusted` reads true, and every other member is
 * the event's own. A real violation, and every other event, is handed as
 * it is.
 */
export function trustTaggedViolations(
	global: typeof globalThis,
	proxyModule: ProxyModule,
	tagged: { has(event: object): boolean },
) {
	const Proxy = global.Proxy;
	const views = new LazyWeakMap<object, object>();
	const view = (event: object): object => {
		let proxy = views.get(event);
		if (!proxy) {
			proxy = new Proxy(event, {
				get(target, key) {
					if (key === 'isTrusted') return true;
					// receiver is the real event, so its getters and methods run
					// on it (a Proxy receiver throws "Illegal invocation")
					const value = Reflect.get(target, key);
					return typeof value === 'function'
						? (value as Function).bind(target)
						: value;
				},
			});
			views.set(event, proxy);
		}
		return proxy;
	};
	const wraps = new LazyWeakMap<object, EventListener>();
	const wrap = (listener: EventListener): EventListener => {
		let wrapped = wraps.get(listener as unknown as object);
		if (!wrapped) {
			wrapped = function (this: EventTarget, event: Event) {
				return listener.call(
					this,
					tagged.has(event) ? (view(event) as unknown as Event) : event,
				);
			};
			wraps.set(listener as unknown as object, wrapped);
		}
		return wrapped;
	};
	const proto = global.EventTarget.prototype as EventTarget & {
		addEventListener: Function;
		removeEventListener: Function;
	};
	const nativeAdd = proto.addEventListener;
	const nativeRemove = proto.removeEventListener;
	proto.addEventListener = proxyModule.wrapFunction(
		nativeAdd,
		(target, that, args) => {
			if (
				args[0] === 'securitypolicyviolation' &&
				typeof args[1] === 'function'
			)
				return Reflect.apply(target, that, [
					args[0],
					wrap(args[1] as EventListener),
					args[2],
				]);
			return Reflect.apply(target, that, args);
		},
	);
	proto.removeEventListener = proxyModule.wrapFunction(
		nativeRemove,
		(target, that, args) => {
			if (
				args[0] === 'securitypolicyviolation' &&
				typeof args[1] === 'function' &&
				wraps.has(args[1] as unknown as object)
			)
				return Reflect.apply(target, that, [
					args[0],
					wraps.get(args[1] as unknown as object),
					args[2],
				]);
			return Reflect.apply(target, that, args);
		},
	);
}
