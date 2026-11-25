import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';
import type { DeferredParts } from '../deferredParts';

type Transition = { skipTransition(): void };

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

		// the checks and the update callback's wrapper: a deferred part
		// (../viewTransitions.ts), made at the page's first call; without it
		// the call throws and starts no transition
		let call: ReturnType<DeferredParts['viewTransitionCall']> | undefined;
		documentProto.startViewTransition = proxyModule.wrapFunction(
			native,
			(target, that, args) =>
				(call ??= deferred('viewTransitionCall')({
					defaultViewGet,
					documentElementGet,
					bodyGet,
					getComputedStyle,
					getPropertyValue,
					NativePromise,
					promiseResolve,
					promiseThen,
					inFrame,
					skip,
				}))(target, that, args),
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
			let transition: unknown;
			try {
				transition = Reflect.apply(viewTransitionGet, event, []);
			} catch (error) {
				// an event the page made (`dispatchEvent(new Event('pageswap'))`)
				// is no PageSwapEvent: the getter's throw reached the page's
				// onerror as an error of its own
				return;
			}
			if (transition) skip(transition);
		};
		const install = () =>
			global.addEventListener('pageswap', onSwap, { capture: true });
		install();
		addDocumentOpenListener(global, install);
	}
}
