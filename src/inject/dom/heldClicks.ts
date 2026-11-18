// A click whose default action the inject carries out itself (a link the
// host opens as a tab, a same-origin download saved from a copy). The
// browser decides a link's default action once the click has gone through
// every listener, and a page's listener may cancel it then, from any phase
// (an SPA router's root listener cancels a target=_blank link it routes
// itself, and stops the click's propagation). So the browser's own action
// is cancelled as the click starts, the page reads `defaultPrevented` and
// `returnValue` as its own calls left them, and the inject's action runs
// once the click has gone through the page, unless a listener of the page
// cancelled it.
import ProxyModule from '../modules/Proxy';
import { LazyWeakMap, LazyWeakSet } from '../ownCollections';
import type DocumentClient from './Client';

export interface HeldClicks {
	/**
	 * cancels the browser's default action of `event` and runs `then` after
	 * the page had it, unless the page cancelled it
	 */
	hold(event: Event, then: () => void): void;
	/** whether `event` is held already */
	held(event: Event): boolean;
}

const made = new LazyWeakMap<DocumentClient, HeldClicks>();

/** the held clicks of `client`'s realm (its hooks are made at the first call) */
export function heldClicks(client: DocumentClient): HeldClicks {
	const existing = made.get(client);
	if (existing) return existing;
	const global = client.global;
	const proxyModule = client.getModule(ProxyModule)!;
	const nativePreventDefault = global.Event.prototype.preventDefault;
	const setTimeout = global.setTimeout;
	// the clicks held, and which of them the page cancelled
	const ours = new LazyWeakSet<Event>();
	const cancelledByPage = new LazyWeakSet<Event>();
	global.Event.prototype.preventDefault = proxyModule.wrapFunction(
		nativePreventDefault,
		(target, that, args) => {
			if (that instanceof global.Event && ours.has(that) && that.cancelable)
				cancelledByPage.add(that);
			return Reflect.apply(target, that, args);
		},
	);
	for (const [property, read] of [
		['defaultPrevented', (event: Event) => cancelledByPage.has(event)],
		['returnValue', (event: Event) => !cancelledByPage.has(event)],
	] as const) {
		const descriptor = Reflect.getOwnPropertyDescriptor(
			global.Event.prototype,
			property,
		);
		if (!descriptor?.get) continue;
		Reflect.defineProperty(global.Event.prototype, property, {
			...descriptor,
			get: proxyModule.wrapFunction(descriptor.get, (target, that, args) =>
				that instanceof global.Event && ours.has(that)
					? read(that)
					: Reflect.apply(target, that, args),
			),
			...(descriptor.set && property === 'returnValue'
				? {
						set: proxyModule.wrapFunction(
							descriptor.set,
							(target, that, args) => {
								if (that instanceof global.Event && ours.has(that) && !args[0])
									cancelledByPage.add(that);
								return Reflect.apply(target, that, args);
							},
						),
					}
				: {}),
		});
	}
	const holder: HeldClicks = {
		hold(event, then) {
			ours.add(event);
			Reflect.apply(nativePreventDefault, event, []);
			// after the click has gone through every listener of the page
			Reflect.apply(setTimeout, global, [
				() => {
					if (!cancelledByPage.has(event)) then();
				},
				0,
			]);
		},
		held: (event) => ours.has(event),
	};
	made.set(client, holder);
	return holder;
}
