import type ProxyModule from './modules/Proxy';
import { LazyWeakMap } from './ownCollections';

/** the realm's Proxy as the bundle loaded, for the views ./violationDispatch.ts makes */
export const NativeProxy = Proxy;

/**
 * Hand the realm's securitypolicyviolation listeners the view `views` holds
 * of an event: a violation the inject dispatches itself where the browser's
 * own would be trusted (./violationDispatch.ts). Every listener added with
 * addEventListener, a function or an object's handleEvent, is handed it
 * (the on- handlers are swapped as the event is dispatched). A real
 * violation, and every other event, is handed as it is.
 */
export function trustTaggedViolations(
	global: typeof globalThis,
	proxyModule: ProxyModule,
	views: { get(event: object): object | undefined },
) {
	const wraps = new LazyWeakMap<object, EventListener>();
	const wrap = (listener: object): EventListener => {
		let wrapped = wraps.get(listener);
		if (!wrapped) {
			wrapped =
				typeof listener === 'function'
					? function (this: EventTarget, event: Event) {
							return Reflect.apply(listener, this, [views.get(event) ?? event]);
						}
					: (event: Event) =>
							// (looked up at each dispatch, as natively)
							(listener as EventListenerObject).handleEvent(
								(views.get(event) ?? event) as Event,
							);
			wraps.set(listener, wrapped);
		}
		return wrapped;
	};
	const proto = global.EventTarget.prototype as EventTarget & {
		addEventListener: Function;
		removeEventListener: Function;
	};
	const hook = (key: 'addEventListener' | 'removeEventListener') => {
		proto[key] = proxyModule.wrapFunction(proto[key], (target, that, args) => {
			const listener = args[1];
			return Reflect.apply(
				target,
				that,
				args[0] === 'securitypolicyviolation' &&
					(typeof listener === 'function' ||
						(typeof listener === 'object' && listener !== null)) &&
					(key === 'addEventListener' || wraps.has(listener))
					? [args[0], wrap(listener), args[2]]
					: args,
			);
		});
	};
	hook('addEventListener');
	hook('removeEventListener');
}
