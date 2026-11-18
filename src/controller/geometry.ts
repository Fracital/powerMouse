// The host's browser window as a proxied page sees it. A page the host
// frames is a top-level page to itself, so its window is the browser's
// window less what the host's own UI takes around the frame: its outer size
// is its viewport plus the browser's UI (outerWidth - innerWidth of the
// host's page, a few pixels wide and a toolbar tall in a normal window,
// nothing in a fullscreen or headless one), and its screen position is the
// browser window's moved by where the frame is in the host's viewport, so a
// mouse event's screenX - clientX is that position plus the browser's UI as
// natively. Read the browser window's outer size in the frame instead (any
// frame reads the top-level window's) and the host's bars are browser UI:
// the demo's two 48 px bars made outerHeight - innerHeight about 200 in a
// normal window, which Discord takes for its devtools docked and logs out.
//
// Measured here, in the host's page, and kept on the hub's window and on
// each slot's agent window (HOST_GEOMETRY), where a proxied document of
// their origin reads it whenever its page asks
// (src/inject/dom/hostGeometry.ts). Measured again on every change of the
// host's viewport or of a frame's size.
import { HOST_GEOMETRY, type HostGeometry } from '../config';

/** the geometry of `elements`, frames of this page (the real top) */
export function measureGeometry(
	elements: Iterable<HTMLIFrameElement>,
): HostGeometry {
	const width = window.innerWidth;
	const height = window.innerHeight;
	const frames: (readonly [number, number, number, number] | null)[] = [];
	// a page in a frame of another page: its frames' documents read their
	// real top's frames, which this page cannot measure
	if (window.top === window)
		for (const element of elements) {
			const win = element.contentWindow;
			if (!win || !element.isConnected) continue;
			let index = -1;
			for (let i = 0; i < window.length; i++)
				if (window[i] === win) {
					index = i;
					break;
				}
			if (index === -1) continue;
			// the frame's viewport is its content box
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			const left = parseFloat(style.paddingLeft) || 0;
			const top = parseFloat(style.paddingTop) || 0;
			const right = parseFloat(style.paddingRight) || 0;
			const bottom = parseFloat(style.paddingBottom) || 0;
			while (frames.length < index) frames.push(null);
			frames[index] = [
				Math.round(rect.left + element.clientLeft + left),
				Math.round(rect.top + element.clientTop + top),
				Math.max(0, Math.round(width - (element.clientWidth - left - right))),
				Math.max(0, Math.round(height - (element.clientHeight - top - bottom))),
			];
		}
	return {
		chrome: [
			Math.max(0, Math.round(window.outerWidth - width)),
			Math.max(0, Math.round(window.outerHeight - height)),
		],
		frames,
	};
}

/** keep `geometry` on `target` (HOST_GEOMETRY), frozen, for the documents of its origin */
export function shareGeometry(target: Window, geometry: HostGeometry) {
	const frames = Array.isArray(geometry?.frames) ? geometry.frames : [];
	const chrome = Array.isArray(geometry?.chrome) ? geometry.chrome : [0, 0];
	const number = (value: unknown) =>
		typeof value === 'number' && isFinite(value) ? value : 0;
	Reflect.defineProperty(target, HOST_GEOMETRY, {
		value: Object.freeze({
			chrome: Object.freeze([number(chrome[0]), number(chrome[1])]),
			frames: Object.freeze(
				Array.from(frames, (frame) =>
					Array.isArray(frame) && frame.length === 4
						? Object.freeze(frame.map(number))
						: null,
				),
			),
		}),
		configurable: true,
	});
}

/** what `target` holds (HOST_GEOMETRY), if anything */
export function sharedGeometry(target: Window): HostGeometry | undefined {
	return Reflect.getOwnPropertyDescriptor(target, HOST_GEOMETRY)?.value as
		HostGeometry | undefined;
}

/**
 * Measures a controller's frames whenever the host's viewport or one of
 * them changes size (a resize, a fullscreen change, the host's layout) and
 * hands each new geometry to `deliver`
 */
export class GeometryWatch {
	#last = '';
	#delivered: Promise<void> = Promise.resolve();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#observer: ResizeObserver | null = null;
	constructor(
		private elements: () => Iterable<HTMLIFrameElement>,
		private deliver: (geometry: HostGeometry) => unknown,
	) {}
	/** measure `element` too, from now on */
	observe(element: HTMLIFrameElement) {
		if (!this.#observer) {
			if (typeof ResizeObserver !== 'function') return;
			this.#observer = new ResizeObserver(() => this.#schedule());
			const schedule = () => this.#schedule();
			window.addEventListener('resize', schedule);
			document.addEventListener('fullscreenchange', schedule);
		}
		this.#observer.observe(element);
		this.#schedule();
	}
	#schedule() {
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.update();
		}, 0);
	}
	/** measure now; settles once a changed geometry was delivered */
	update(): Promise<void> {
		let geometry: HostGeometry;
		try {
			geometry = measureGeometry(this.elements());
		} catch (error) {
			return this.#delivered;
		}
		const text = JSON.stringify(geometry);
		if (text === this.#last) return this.#delivered;
		this.#last = text;
		let delivered: unknown;
		try {
			delivered = this.deliver(geometry);
		} catch (error) {
			// nowhere to keep it: the documents read the browser's own
		}
		this.#delivered = Promise.resolve(delivered).then(
			() => {},
			() => {},
		);
		return this.#delivered;
	}
}
