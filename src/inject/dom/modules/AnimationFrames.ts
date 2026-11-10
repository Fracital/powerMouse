import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';

/**
 * Chrome stops updating the rendering of a frame that is cross-origin to the
 * main frame while it is not rendered (a `display:none` frame, or one inside
 * such a frame): its animation frame callbacks wait until it is shown. A
 * same-origin frame keeps running them, and it is not laid out either, so
 * every element in it measures 0. Through the proxy every frame is
 * same-origin with the page, so a hidden frame of another site ran callbacks
 * it never runs natively and measured nothing: Google Sign-In's button frame,
 * which LinkedIn keeps in a hidden layout, measured its button after a double
 * requestAnimationFrame, read 0, and its retry (`setTimeout(this.u, 50)`, an
 * unbound method) threw "Cannot read properties of undefined (reading
 * 'Db')". In a document of another origin than the proxied top, a callback
 * that comes due while its frame is not rendered is parked until the frame is
 * shown, then all parked callbacks run in one animation frame, in order.
 * Measured in Chrome 152: a same-site frame of another origin is held too,
 * `visibility: hidden` holds nothing.
 *
 * Whether the frame is rendered is followed with an IntersectionObserver per
 * frame element up to the proxied top, rooted at that element's document with
 * a margin wide enough that only having no box (or being clipped away
 * entirely, which Chrome holds as well) counts: a game in a frame calls
 * requestAnimationFrame at 60 fps or more, and each call only reads a flag,
 * never the parent's layout. A ResizeObserver would not do: a shown frame of
 * 0x0 (Google Sign-In's, until it has measured) reports the size a hidden one
 * does.
 */
export default class AnimationFramesModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		if (typeof global.requestAnimationFrame !== 'function') return;
		if (typeof global.IntersectionObserver !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const NativeObserver = global.IntersectionObserver;
		const nativeRequest = global.requestAnimationFrame;
		const nativeCancel = global.cancelAnimationFrame;
		const reportError = global.reportError;

		// a frame of the page's that is cross-origin to the proxied top,
		// decided once per document (an origin never changes within one)
		let decided: { document: Document; throttled: boolean } | undefined;
		const throttled = () => {
			const document = global.document;
			if (decided?.document === document) return decided.throttled;
			let value: boolean;
			try {
				value =
					this.client.nested &&
					(this.client.sandboxedOpaque ||
						this.client.url.url.origin !== this.client.topOrigin);
			} catch (error) {
				value = false;
			}
			decided = { document, throttled: value };
			if (value) watch();
			return value;
		};

		// the frame elements, from this window's up to the proxied top's
		// child, that are not rendered now; until an observer has reported, a
		// frame counts as shown (Chrome too runs a hidden frame's first frames)
		const unrendered = new Set<Element>();
		let watching = false;
		const observed = (entries: IntersectionObserverEntry[]) => {
			for (const entry of entries)
				if (entry.isIntersecting) unrendered.delete(entry.target);
				else unrendered.add(entry.target);
			if (unrendered.size === 0) flushSoon();
		};
		const watch = () => {
			if (watching) return;
			watching = true;
			let client: DocumentClient = this.client;
			for (let depth = 0; depth < 64 && client.nested; depth++) {
				const frame = client.nativeFrameElement();
				if (!frame) break;
				// each element against its own document: the observer of this
				// realm, so a page that replaced its IntersectionObserver
				// changes nothing
				new NativeObserver(observed, {
					root: frame.ownerDocument,
					rootMargin: '100000px',
				}).observe(frame);
				try {
					client = (client.parent as Record<string, any>)[
						this.client.names.client
					] as DocumentClient;
				} catch (error) {
					break;
				}
			}
		};

		// the page's callbacks by the id it was given (the native id of their
		// first request), and the ids parked while the frame is not rendered,
		// in the order they came due
		const callbacks = new Map<number, Function>();
		let parked: number[] = [];
		let flushing = false;
		const run = (id: number, time: number) => {
			const callback = callbacks.get(id);
			if (!callback) return;
			callbacks.delete(id);
			try {
				Reflect.apply(callback, undefined, [time]);
			} catch (error) {
				// natively each callback's exception is reported on its own
				// and the rest still run
				if (typeof reportError === 'function')
					Reflect.apply(reportError, global, [error]);
				else throw error;
			}
		};
		const flush = (time: number) => {
			flushing = false;
			const ids = parked;
			parked = [];
			for (const id of ids) {
				if (!callbacks.has(id)) continue;
				if (unrendered.size) parked.push(id);
				else run(id, time);
			}
		};
		const flushSoon = () => {
			if (flushing || parked.length === 0) return;
			flushing = true;
			Reflect.apply(nativeRequest, global, [flush]);
		};

		global.requestAnimationFrame = proxyModule.wrapFunction(
			nativeRequest,
			(target, that, args) => {
				const callback = args[0];
				if (typeof callback !== 'function' || !throttled())
					return Reflect.apply(target, that, args);
				const id = Reflect.apply(target, that, [
					(time: number) => {
						if (!callbacks.has(id)) return;
						// behind the parked ones, which came due first
						if (unrendered.size || parked.length) {
							parked.push(id);
							if (!unrendered.size) flushSoon();
							return;
						}
						run(id, time);
					},
				]) as number;
				callbacks.set(id, callback);
				return id;
			},
		);
		global.cancelAnimationFrame = proxyModule.wrapFunction(
			nativeCancel,
			(target, that, args) => {
				// a parked callback is dropped from the map; its place in the
				// queue is skipped when the queue runs
				if (typeof args[0] === 'number') callbacks.delete(args[0]);
				return Reflect.apply(target, that, args);
			},
		);
		// watched from the start, so the observers have reported before the
		// page's first callbacks come due after it starts (Chrome decides as
		// the document starts too)
		throttled();
	}
}
