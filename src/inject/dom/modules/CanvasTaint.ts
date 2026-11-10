import { OPAQUE_MARKER } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { hasProxyMetric } from '../../modules/ResourceTiming';
import { unrouteURL } from '../../modules/Unroute';
import { blobLoads } from '../blobLoads';
import type DocumentClient from '../Client';

// What a canvas has drawn, kept for every realm of the bundle (a canvas of a
// frame the page reaches into is drawn with that realm's methods)
const taintedCanvases = new WeakSet<object>();
const taintedContexts = new WeakSet<object>();
/** ImageBitmaps and CanvasPatterns made from a cross-origin source */
const taintedSources = new WeakSet<object>();

type Kind = 'image' | 'svgImage' | 'video' | 'canvas' | 'other';

const toStringTag = Symbol.toStringTag;

/**
 * Canvas tainting. Every route is same-origin to the browser, so an image of
 * another site drawn into a canvas never taints it and the page reads its
 * pixels back. The browser's rule, applied to the real origins: a canvas
 * that drew an image, video, SVG image, ImageBitmap, pattern or canvas
 * holding another origin's data that was not loaded with CORS (a
 * `crossorigin` load the worker let through passed its CORS check) refuses
 * every readback (`toDataURL`, `toBlob`, `getImageData`, an OffscreenCanvas's
 * `convertToBlob`) with the browser's SecurityError, WebGL refuses such a
 * source as a texture, and what is made from it (a bitmap, a pattern, a
 * canvas it is drawn into) is tainted too.
 *
 * Hot path: a draw costs a WeakSet lookup when the canvas is tainted
 * already, else a WeakMap lookup and a native getter call for the source.
 *
 * WebGL's methods are hooked the first time a `getContext` of the realm
 * hands out a WebGL context, which is the only way to one: the browser
 * makes an interface the first time anything names it, and the two WebGL
 * ones cost every frame about 90 KB of heap (an ad frame that never draws).
 */
export default class CanvasTaintModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		if (typeof global.CanvasRenderingContext2D !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;

		const getter = (proto: object | undefined, name: string) =>
			proto
				? (Reflect.getOwnPropertyDescriptor(proto, name)?.get as
						((this: unknown) => unknown) | undefined)
				: undefined;
		const imageSrc = getter(global.HTMLImageElement?.prototype, 'currentSrc');
		const imageCrossOrigin = getter(
			global.HTMLImageElement?.prototype,
			'crossOrigin',
		);
		const mediaSrc = getter(global.HTMLMediaElement?.prototype, 'currentSrc');
		const mediaCrossOrigin = getter(
			global.HTMLMediaElement?.prototype,
			'crossOrigin',
		);
		const svgHref = getter(global.SVGImageElement?.prototype, 'href');
		const animatedValue = getter(
			global.SVGAnimatedString?.prototype,
			'animVal',
		);
		const canvasWidth = getter(global.HTMLCanvasElement?.prototype, 'width');
		const offscreenWidth = getter(global.OffscreenCanvas?.prototype, 'width');
		const contextCanvas = getter(
			global.CanvasRenderingContext2D.prototype,
			'canvas',
		);
		const offscreenContextCanvas = getter(
			global.OffscreenCanvasRenderingContext2D?.prototype,
			'canvas',
		);

		/** an object's kind, by the native getters it answers (once per object) */
		const kinds = new WeakMap<object, Kind>();
		const answers = (
			get: ((this: unknown) => unknown) | undefined,
			value: object,
		) => {
			if (!get) return false;
			try {
				Reflect.apply(get, value, []);
				return true;
			} catch (error) {
				return false;
			}
		};
		const kindOf = (value: object): Kind => {
			let kind = kinds.get(value);
			if (kind === undefined) {
				kind = answers(imageSrc, value)
					? 'image'
					: answers(canvasWidth, value) || answers(offscreenWidth, value)
						? 'canvas'
						: answers(mediaSrc, value)
							? 'video'
							: answers(svgHref, value)
								? 'svgImage'
								: 'other';
				kinds.set(value, kind);
			}
			return kind;
		};

		const own = () =>
			this.client.opaqueRequests ? 'null' : this.client.url.url.origin;
		/** whether a loaded URL (as the browser has it) is another origin's */
		const crossOrigin = (loaded: string): boolean => {
			if (loaded === '' || loaded.startsWith('data:')) return false;
			// a copy the inject made for a document no worker controls stands
			// for the page's URL; any other blob: URL is the page's own
			const real = loaded.startsWith('blob:')
				? blobLoads.get(loaded)
				: (unrouteURL(this.client, loaded) ?? loaded);
			if (real === undefined || real.startsWith('blob:')) return false;
			try {
				const origin = new URL(real).origin;
				return origin !== own();
			} catch (error) {
				return false;
			}
		};
		const answeredOpaque = (loaded: string): boolean => {
			if (!/^https?:/.test(loaded)) return false;
			const real = unrouteURL(this.client, loaded) ?? loaded;
			try {
				return global.performance
					.getEntriesByName(real)
					.some((entry) => hasProxyMetric(entry, OPAQUE_MARKER));
			} catch (error) {
				return false;
			}
		};
		/** per element: the URL it was judged by and the verdict */
		const judged = new WeakMap<object, { url: string; taints: boolean }>();
		const elementTaints = (
			element: object,
			url: string,
			cors: ((this: unknown) => unknown) | undefined,
		): boolean => {
			const last = judged.get(element);
			if (last && last.url === url) return last.taints;
			// a crossorigin load reached the page only past the CORS check; a
			// load of the page's own URL its emulated service worker answered
			// with another origin's opaque response taints too (the worker
			// marked its timing entry)
			const taints = crossOrigin(url)
				? cors
					? Reflect.apply(cors, element, []) === null
					: true
				: answeredOpaque(url);
			judged.set(element, { url, taints });
			return taints;
		};
		/** whether drawing `source` taints the canvas it is drawn into */
		const taints = (source: unknown): boolean => {
			if (source === null || typeof source !== 'object') return false;
			if (taintedSources.has(source) || taintedCanvases.has(source))
				return true;
			switch (kindOf(source)) {
				case 'image':
					return elementTaints(
						source,
						String(Reflect.apply(imageSrc!, source, [])),
						imageCrossOrigin,
					);
				case 'video':
					return elementTaints(
						source,
						String(Reflect.apply(mediaSrc!, source, [])),
						mediaCrossOrigin,
					);
				case 'svgImage': {
					const href = Reflect.apply(svgHref!, source, []) as object;
					return elementTaints(
						source,
						String(animatedValue ? Reflect.apply(animatedValue, href, []) : ''),
						undefined,
					);
				}
				default:
					return false;
			}
		};

		const securityError = (message: string) =>
			new global.DOMException(message, 'SecurityError');

		/** a 2D context draws: a tainting source taints it and its canvas */
		const hookDraw = (
			proto: object,
			canvasOf: ((this: unknown) => unknown) | undefined,
			method: string,
		) => {
			const native = (proto as Record<string, unknown>)[method];
			if (typeof native !== 'function') return;
			(proto as Record<string, unknown>)[method] = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					if (
						that !== null &&
						typeof that === 'object' &&
						!taintedContexts.has(that) &&
						taints(args[0])
					) {
						// the native call validates first: a bad call throws as natively
						const result = Reflect.apply(target, that, args);
						taintedContexts.add(that);
						if (canvasOf)
							taintedCanvases.add(Reflect.apply(canvasOf, that, []) as object);
						return result;
					}
					return Reflect.apply(target, that, args);
				},
			);
		};
		/** a pattern of a tainting source is tainted, and taints where it is used */
		const hookPattern = (
			proto: object,
			canvasOf: ((this: unknown) => unknown) | undefined,
		) => {
			const native = (proto as Record<string, unknown>).createPattern;
			if (typeof native === 'function')
				(proto as Record<string, unknown>).createPattern =
					proxyModule.wrapFunction(native, (target, that, args) => {
						const pattern = Reflect.apply(target, that, args);
						if (pattern && taints(args[0])) taintedSources.add(pattern);
						return pattern;
					});
			for (const name of ['fillStyle', 'strokeStyle']) {
				const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
				if (!descriptor?.set) continue;
				Reflect.defineProperty(proto, name, {
					...descriptor,
					set: proxyModule.wrapFunction(
						descriptor.set,
						(target, that, args) => {
							const result = Reflect.apply(target, that, args);
							if (
								args[0] !== null &&
								typeof args[0] === 'object' &&
								taintedSources.has(args[0])
							) {
								taintedContexts.add(that as object);
								if (canvasOf)
									taintedCanvases.add(
										Reflect.apply(canvasOf, that, []) as object,
									);
							}
							return result;
						},
					),
				});
			}
		};
		/** a readback of a tainted context or canvas throws */
		const hookRead = (
			proto: object | undefined,
			method: string,
			tainted: WeakSet<object>,
			message: string | (() => Promise<string>),
			async = false,
		) => {
			const native = proto && (proto as Record<string, unknown>)[method];
			if (typeof native !== 'function') return;
			(proto as Record<string, unknown>)[method] = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					if (that !== null && typeof that === 'object' && tainted.has(that)) {
						if (typeof message !== 'string')
							return message().then((text) => {
								throw securityError(text);
							});
						const error = securityError(message);
						if (async) return global.Promise.reject(error);
						throw error;
					}
					return Reflect.apply(target, that, args);
				},
			);
		};

		const context2D = global.CanvasRenderingContext2D.prototype;
		hookDraw(context2D, contextCanvas, 'drawImage');
		hookPattern(context2D, contextCanvas);
		hookRead(
			context2D,
			'getImageData',
			taintedContexts,
			"Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.",
		);
		const canvasProto = global.HTMLCanvasElement?.prototype;
		for (const method of ['toDataURL', 'toBlob'])
			hookRead(
				canvasProto,
				method,
				taintedCanvases,
				`Failed to execute '${method}' on 'HTMLCanvasElement': Tainted canvases may not be exported.`,
			);

		// WebGL refuses a tainting source as a texture
		const sourceName: Record<Kind, string> = {
			image: 'The image element',
			svgImage: 'The image element',
			video: 'The video element',
			canvas: 'The canvas element',
			other: 'The source image',
		};
		/** a WebGL context's prototype, by its interface's name */
		const hookTextures = (proto: object, name: string) => {
			const methods =
				name === 'WebGLRenderingContext'
					? ['texImage2D', 'texSubImage2D']
					: name === 'WebGL2RenderingContext'
						? ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']
						: [];
			for (const method of methods) {
				const native = (proto as Record<string, unknown>)[method];
				if (typeof native !== 'function') continue;
				(proto as Record<string, unknown>)[method] = proxyModule.wrapFunction(
					native,
					(target, that, args) => {
						// the source is the last argument of every overload that takes one
						const source = args[args.length - 1];
						if (taints(source))
							throw securityError(
								`Failed to execute '${method}' on '${name}': ${
									sourceName[kindOf(source as object)]
								} contains cross-origin data, and may not be loaded.`,
							);
						return Reflect.apply(target, that, args);
					},
				);
			}
		};
		// the context prototypes looked at already: each is hooked (or not) on
		// the first context of it a getContext hands out
		const seen = new WeakSet<object>();
		const hookGetContext = (proto: object | undefined) => {
			const native = proto && (proto as Record<string, unknown>).getContext;
			if (typeof native !== 'function') return;
			(proto as Record<string, unknown>).getContext = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					const context = Reflect.apply(target, that, args);
					if (context === null || typeof context !== 'object') return context;
					const proto = Reflect.getPrototypeOf(context);
					if (proto && !seen.has(proto)) {
						seen.add(proto);
						const name = Reflect.getOwnPropertyDescriptor(
							proto,
							toStringTag,
						)?.value;
						if (typeof name === 'string') hookTextures(proto, name);
					}
					return context;
				},
			);
		};
		hookGetContext(canvasProto);

		const offscreen2D = global.OffscreenCanvasRenderingContext2D?.prototype;
		if (offscreen2D) {
			hookDraw(offscreen2D, offscreenContextCanvas, 'drawImage');
			hookPattern(offscreen2D, offscreenContextCanvas);
			hookRead(
				offscreen2D,
				'getImageData',
				taintedContexts,
				"Failed to execute 'getImageData' on 'OffscreenCanvasRenderingContext2D': The canvas has been tainted by cross-origin data.",
			);
			hookGetContext(global.OffscreenCanvas.prototype);
			// Chrome 153 reworded its OffscreenCanvas errors: 'Tainted
			// "OffscreenCanvas" may not be exported.' became 'A tainted
			// OffscreenCanvas may not be exported.'. No canvas is tainted natively
			// in proxy space, so the wording is told by a sibling message of the
			// same change: the no-context rejection quotes "OffscreenCanvas" only
			// in the old one. Asked once, on the first tainted export.
			const convertToBlob = global.OffscreenCanvas.prototype.convertToBlob;
			let taintedWording: Promise<string> | undefined;
			const convertTainted = () =>
				(taintedWording ??= (
					Reflect.apply(
						convertToBlob,
						new global.OffscreenCanvas(1, 1),
						[],
					).then(
						() => '',
						(error: unknown) => String((error as Error)?.message),
					) as Promise<string>
				).then(
					(probe) =>
						`Failed to execute 'convertToBlob' on 'OffscreenCanvas': ${
							probe.includes('"OffscreenCanvas"')
								? 'Tainted "OffscreenCanvas" may not be exported.'
								: 'A tainted OffscreenCanvas may not be exported.'
						}`,
				));
			hookRead(
				global.OffscreenCanvas.prototype,
				'convertToBlob',
				taintedCanvases,
				convertTainted,
				true,
			);
			// a bitmap of a tainted offscreen canvas carries its taint
			const transfer = global.OffscreenCanvas.prototype.transferToImageBitmap;
			if (typeof transfer === 'function')
				global.OffscreenCanvas.prototype.transferToImageBitmap =
					proxyModule.wrapFunction(transfer, (target, that, args) => {
						const bitmap = Reflect.apply(target, that, args);
						if (taintedCanvases.has(that as object)) taintedSources.add(bitmap);
						return bitmap;
					});
		}

		// a bitmap made from a tainting source is tainted
		if (typeof global.createImageBitmap === 'function')
			global.createImageBitmap = proxyModule.wrapFunction(
				global.createImageBitmap,
				async (target, that, args) => {
					const tainted = taints(args[0]);
					const bitmap = await Reflect.apply(target, that, args);
					if (tainted) taintedSources.add(bitmap);
					return bitmap;
				},
			);
		const bitmapRenderer = global.ImageBitmapRenderingContext?.prototype;
		if (bitmapRenderer) {
			const native = bitmapRenderer.transferFromImageBitmap;
			const rendererCanvas = getter(bitmapRenderer, 'canvas');
			bitmapRenderer.transferFromImageBitmap = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					const result = Reflect.apply(target, that, args);
					if (
						args[0] &&
						taintedSources.has(args[0] as object) &&
						rendererCanvas
					)
						taintedCanvases.add(
							Reflect.apply(rendererCanvas, that, []) as object,
						);
					return result;
				},
			);
		}
	}
}
