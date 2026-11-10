import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';

type Transition = { skipTransition(): void };
type Update = (...args: unknown[]) => unknown;

/**
 * View transitions in a frame. Chrome (152 to at least 159) kills the
 * renderer, "Aw, Snap!" error code 4, on a CHECK in
 * cc::draw_property_utils::CalculateDrawProperties when a transition that
 * captures the root runs in a subframe whose viewport has a forced scrollbar
 * (`overflow: scroll` on the root, or on the body when it propagates) and no
 * scrollable overflow at some frame of the transition. A top-level document
 * is unaffected, so the site works natively and dies through the proxy, which
 * always frames it: YouTube's watch page does exactly this (its body is
 * `overflow-y: scroll`, it starts a transition on every page load) and took the
 * whole host tab down in same-origin mode.
 *
 * A transition that could hit it is skipped: the update callback still runs,
 * `ready` rejects and `finished` resolves, as for any skipped transition. The
 * check is the viewport's overflow style, not its current overflow, since
 * content that shrinks during the animation crashes too; it runs when the
 * transition starts (old state) and when the update callback is done (new
 * state). A cross-document transition is skipped in a frame whatever the
 * styles: the next document's are not known when it starts, and its forced
 * scrollbar is enough to crash.
 */
export default class ViewTransitionModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const documentProto = global.Document.prototype as Document & {
			startViewTransition?: unknown;
		};
		const native = documentProto.startViewTransition;
		const nativeSkip = (
			global as unknown as {
				ViewTransition?: { prototype: Transition };
			}
		).ViewTransition?.prototype.skipTransition;
		if (typeof native !== 'function' || typeof nativeSkip !== 'function')
			return;

		// natives taken before the other modules hook them and the page runs
		const getter = (owner: object, name: string) =>
			Reflect.getOwnPropertyDescriptor(owner, name)?.get as
				(() => unknown) | undefined;
		const defaultViewGet = getter(documentProto, 'defaultView')!;
		const documentElementGet = getter(documentProto, 'documentElement')!;
		const bodyGet = getter(documentProto, 'body')!;
		const getComputedStyle = global.getComputedStyle;
		const getPropertyValue =
			global.CSSStyleDeclaration.prototype.getPropertyValue;
		const topGet = Reflect.getOwnPropertyDescriptor(global, 'top')!.get!;
		const promiseResolve = global.Promise.resolve;
		const promiseThen = global.Promise.prototype.then;
		const NativePromise = global.Promise;
		const skip = (transition: unknown) =>
			Reflect.apply(nativeSkip, transition, []);

		const inFrame = (view: typeof globalThis) => {
			try {
				return (Reflect.apply(topGet, view, []) as unknown) !== view;
			} catch (error) {
				// no top to compare: assume the worst
				return true;
			}
		};
		const style = (view: typeof globalThis, element: Element, name: string) =>
			Reflect.apply(
				getPropertyValue,
				Reflect.apply(getComputedStyle, view, [element]),
				[name],
			) as string;
		const forcedScrollbar = (view: typeof globalThis, element: Element) =>
			style(view, element, 'overflow-x') === 'scroll' ||
			style(view, element, 'overflow-y') === 'scroll';
		// whether a transition on `document` now could crash the renderer
		const hazard = (document: Document) => {
			const view = Reflect.apply(defaultViewGet, document, []) as
				typeof globalThis | null;
			if (!view || !inFrame(view)) return false;
			const root = Reflect.apply(
				documentElementGet,
				document,
				[],
			) as Element | null;
			if (!root) return false;
			// a root that is not captured does not crash
			if (style(view, root, 'view-transition-name') === 'none') return false;
			if (forcedScrollbar(view, root)) return true;
			// the body's overflow is the viewport's when the root's is visible
			const body = Reflect.apply(bodyGet, document, []) as Element | null;
			return (
				!!body &&
				style(view, root, 'overflow-x') === 'visible' &&
				style(view, root, 'overflow-y') === 'visible' &&
				forcedScrollbar(view, body)
			);
		};

		documentProto.startViewTransition = proxyModule.wrapFunction(
			native,
			(target, that, args) => {
				// set once the browser has made it; the update callback runs later
				const started: { transition?: unknown } = {};
				const check = () => {
					try {
						if (started.transition && hazard(that)) skip(started.transition);
					} catch (error) {
						// not a document the checks understand: leave it be
					}
				};
				// the new state is captured once the update callback is done
				const wrap = (update: unknown) =>
					typeof update === 'function'
						? function (this: unknown, ...a: unknown[]) {
								const result = Reflect.apply(update as Update, this, a);
								return Reflect.apply(
									promiseThen,
									Reflect.apply(promiseResolve, NativePromise, [result]),
									[
										(value: unknown) => {
											check();
											return value;
										},
									],
								);
							}
						: update;
				const next = [...args];
				if (typeof next[0] === 'function') next[0] = wrap(next[0]);
				else if (next[0] !== null && typeof next[0] === 'object') {
					// each member read once, in the browser's (dictionary) order
					const options = next[0] as { types?: unknown; update?: unknown };
					const types = options.types;
					const update = options.update;
					next[0] =
						types === undefined
							? { update: wrap(update) }
							: { types, update: wrap(update) };
				}
				started.transition = Reflect.apply(target, that, next);
				check();
				return started.transition;
			},
		);

		const PageSwap = (
			global as unknown as {
				PageSwapEvent?: { prototype: object };
			}
		).PageSwapEvent;
		const viewTransitionGet =
			PageSwap && getter(PageSwap.prototype, 'viewTransition');
		if (!viewTransitionGet || !inFrame(global)) return;
		const onSwap = (event: Event) => {
			const transition = Reflect.apply(viewTransitionGet, event, []);
			if (transition) skip(transition);
		};
		const install = () =>
			global.addEventListener('pageswap', onSwap, { capture: true });
		install();
		addDocumentOpenListener(global, install);
	}
}
