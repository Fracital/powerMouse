import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { LazyMap, LazySet } from '../../ownCollections';
import type DocumentClient from '../Client';
import { addDocumentOpenListener } from '../Client';
import { Pool } from '../pool';
import { mainFrameElsewhere } from '../siteWindows';

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
 * The other way round, Chrome holds a hidden frame of the proxied top's
 * own origin when the browser's main frame is of another origin, as it is
 * under a site pool (the proxied top is a slot's origin in the hub's page,
 * docs/site-pool.md) and in isolated mode (the proxied top is the proxy's
 * origin in the host's page): measured in Chrome 152 and 156, a page framed
 * by a top of another origin, of another port of the same host or of another
 * site, gets its own hidden frames held. Natively the proxied top is the
 * main frame and they run (and measure 0). While such a frame is not
 * rendered, its callbacks are run by the proxied top's animation frames,
 * which run as long as the page is shown; the frame's own request still
 * stands, and whichever comes first runs a callback, once.
 *
 * Whether the frame is rendered is followed with an IntersectionObserver per
 * frame element up to the proxied top (for a lifted frame, from its first
 * request on: most frames never make one, and until its observers have
 * reported, a frame element without a box counts as not rendered, so a
 * hidden frame's first callback is lifted at once, as the watch from the
 * start lifted it), rooted at that element's document with
 * a margin wide enough that only having no box (or being clipped away
 * entirely, which Chrome holds as well) counts: a game in a frame calls
 * requestAnimationFrame at 60 fps or more, and each call only reads a flag,
 * never the parent's layout. A ResizeObserver would not do: a shown frame of
 * 0x0 (Google Sign-In's, until it has measured) reports the size a hidden one
 * does.
 *
 * An observer rooted at another document is that document's to keep: Blink
 * holds it, with its callback and so the realm that made it, until it is
 * disconnected, whatever became of the frame. The observers are
 * disconnected when the document is left (its frame removed or navigated),
 * or every frame of another site the page ever had stayed in memory with
 * its whole realm, about a megabyte each, for as long as the page.
 */
export default class AnimationFramesModule extends Module<DocumentClient> {
	apply() {
		const moduleClient = this.client;
		const global = moduleClient.global;
		if (typeof global.requestAnimationFrame !== 'function') return;
		if (typeof global.IntersectionObserver !== 'function') return;
		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const NativeObserver = global.IntersectionObserver;
		const nativeObserve = NativeObserver.prototype.observe;
		const nativeDisconnect = NativeObserver.prototype.disconnect;
		const nativeAdd = global.EventTarget.prototype.addEventListener;
		const nativeRequest = global.requestAnimationFrame;
		const nativeCancel = global.cancelAnimationFrame;
		const reportError = global.reportError;
		const timeOrigin = global.performance?.timeOrigin ?? 0;
		const nativeRects = global.Element.prototype.getClientRects;
		const pool = this.client.pool;
		pool[Pool.AnimationRequest] = nativeRequest;
		pool[Pool.TimeOrigin] = timeOrigin;

		// a frame of the page's that is cross-origin to the proxied top,
		// decided once per document (an origin never changes within one)
		// (a document and its answer, kept apart: an object for the two cost
		// every frame two shapes)
		let decidedFor: Document | undefined;
		let decided = false;
		const throttled = () => {
			const document = global.document;
			if (decidedFor === document) return decided;
			let value: boolean;
			try {
				value =
					moduleClient.nested &&
					(moduleClient.sandboxedOpaque ||
						moduleClient.url.url.origin !== moduleClient.topOrigin);
			} catch (error) {
				value = false;
			}
			decidedFor = document;
			decided = value;
			if (value) watch();
			return value;
		};

		// a frame of the proxied top's origin whose main frame (the browser's)
		// is of another origin: the proxied top's client, whose animation
		// frames run the callbacks while the frame is not rendered; decided
		// once per document
		let liftingFor: Document | undefined;
		let lifting: DocumentClient | null = null;
		const lifted = () => {
			const document = global.document;
			if (liftingFor === document) return lifting;
			let top: DocumentClient | null = null;
			try {
				const client = this.client;
				if (
					client.nested &&
					!client.sandboxedOpaque &&
					client.url.url.origin === client.topOrigin
				) {
					const candidate = (client.proxiedTop as Record<string, any>)[
						client.names.client
					] as DocumentClient | undefined;
					if (
						mainFrameElsewhere(global, client.realOrigin()) &&
						candidate &&
						candidate !== client &&
						!candidate.nested &&
						candidate.pool?.[Pool.AnimationRequest]
					)
						top = candidate;
				}
			} catch (error) {
				top = null;
			}
			liftingFor = document;
			lifting = top;
			return top;
		};

		// the frame elements, from this window's up to the proxied top's
		// child, that are not rendered now; until an observer has reported, a
		// frame counts as shown (Chrome too runs a hidden frame's first frames)
		const unrendered = new LazySet<Element>();
		let watching = false;
		const observers: IntersectionObserver[] = [];
		// One observer per element, which its callback names from here, never
		// by `entry.target`: an entry is an object of this realm, and its
		// target getter makes the element's wrapper in this realm when the
		// one of the element's own page was collected (nothing of the page
		// referenced it). That wrapper is the page's from then on, with this
		// realm's HTMLIFrameElement.prototype, so the page's
		// `iframe.contentWindow` ran this frame's hooks and handed out this
		// frame's stand-in for its own window, not the page's: a sandboxed
		// frame's messages reached its parent from a window that was none of
		// its frames (sandbox-messages). Holding the element here keeps the
		// page's wrapper alive besides.
		const observed =
			(frame: Element) => (entries: IntersectionObserverEntry[]) => {
				const last = entries[entries.length - 1];
				if (!last) return;
				if (last.isIntersecting) unrendered.delete(frame);
				else unrendered.add(frame);
				if (unrendered.size === 0) flushSoon();
				else liftPending();
			};
		// `boxes`: until the observers report, an element with no box counts
		// as not rendered (read now, a layout of its document)
		const watch = (boxes = false) => {
			if (watching) return;
			watching = true;
			let client: DocumentClient = moduleClient;
			for (let depth = 0; depth < 64 && client.nested; depth++) {
				const frame = client.nativeFrameElement();
				if (!frame) break;
				if (boxes)
					try {
						if (
							(Reflect.apply(nativeRects, frame, []) as DOMRectList).length ===
							0
						)
							unrendered.add(frame);
					} catch (error) {
						// an element of a document going away
					}
				// each element against its own document: the observer of this
				// realm, so a page that replaced its IntersectionObserver
				// changes nothing
				const observer = new NativeObserver(observed(frame), {
					root: frame.ownerDocument,
					rootMargin: '100000px',
				});
				Reflect.apply(nativeObserve, observer, [frame]);
				observers.push(observer);
				try {
					client = (client.parent as Record<string, any>)[
						moduleClient.names.client
					] as DocumentClient;
				} catch (error) {
					break;
				}
			}
		};

		// the page's callbacks by the id it was given (the native id of their
		// first request), and the ids parked while the frame is not rendered,
		// in the order they came due
		const callbacks = new LazyMap<number, Function>();
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
		// the callbacks of a lifted frame not run yet, by the proxied top's
		// next animation frame (its time in this document's time origin)
		const lift = (id: number) => {
			const top = liftingFor === global.document && lifting;
			const request = top && top.pool?.[Pool.AnimationRequest];
			if (!request) return;
			const offset = top.pool[Pool.TimeOrigin] - timeOrigin;
			Reflect.apply(request, top.global, [
				(time: number) => {
					if (unrendered.size) run(id, time + offset);
				},
			]);
		};
		const liftPending = () => {
			if (!lifting || liftingFor !== global.document) return;
			for (const id of callbacks.keys()) lift(id);
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
				if (typeof callback !== 'function')
					return Reflect.apply(target, that, args);
				if (!throttled()) {
					if (!lifted()) return Reflect.apply(target, that, args);
					watch(true);
					const id = Reflect.apply(target, that, [
						(time: number) => run(id, time),
					]) as number;
					callbacks.set(id, callback);
					if (unrendered.size) lift(id);
					return id;
				}
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
		// the document is left: no observer outlives it. A document the
		// back-forward cache restores is watched again from its next
		// callback (it decides again)
		const unwatch = () => {
			for (const observer of observers)
				Reflect.apply(nativeDisconnect, observer, []);
			observers.length = 0;
			unrendered.clear();
			watching = false;
			decidedFor = undefined;
			liftingFor = undefined;
		};
		const listen = () =>
			Reflect.apply(nativeAdd, global, ['pagehide', unwatch]);
		listen();
		// document.open() drops a window's listeners
		addDocumentOpenListener(global, listen);
		// a frame held as Chrome holds one of another origin is watched from
		// the start, so the observers have reported before the page's first
		// callbacks come due after it starts (Chrome decides as the document
		// starts too, and runs a hidden frame's first frames); a lifted one is
		// decided and watched from its first request (most frames make none,
		// and a frame compiles what it runs)
		throttled();
	}
}
