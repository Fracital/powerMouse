import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import ResourceTimingModule from '../../modules/ResourceTiming';
import { unrouteURL } from '../../modules/Unroute';
import { blobLoads, opaqueCopies } from '../blobLoads';
import type DocumentClient from '../Client';
import type { CanvasTaints } from '../Client';
import SyncModule from './Sync';

// taken when the bundle loads, before page code can replace it
const nativeListen = EventTarget.prototype.addEventListener;

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
 * A page can name them before any context exists (and keep
 * `WebGLRenderingContext.prototype.texImage2D` unhooked), so the two names
 * are accessors on the window until first read: the read gets a context
 * of the kind from the native getContext of an OffscreenCanvas, hooks its
 * prototype, and makes the name the data property it natively is, before
 * the page has the interface. A frame that never names them pays nothing.
 */
export default class CanvasTaintModule extends Module<DocumentClient> {
	/** whether drawing `source` taints a canvas: it holds another origin's data the page may not read */
	taints: (source: unknown) => boolean = () => false;
	/**
	 * Run `callback` when `element` fires an event of one of `types`, whatever
	 * the page's own listeners do: one that stops the event before the
	 * inject's listener runs it first.
	 */
	watch(element: object, types: string[], callback: () => void) {
		const watched = this.client.canvasTaints.watched;
		let byType = watched.get(element);
		if (!byType) watched.set(element, (byType = new Map()));
		for (const type of types) {
			const callbacks = byType.get(type);
			if (callbacks) callbacks.push(callback);
			else byType.set(type, [callback]);
			Reflect.apply(nativeListen, element, [type, callback, true]);
		}
	}
	apply() {
		const global = this.client.global;
		if (typeof global.CanvasRenderingContext2D !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		// What a canvas has drawn, kept for every proxied document that can
		// reach this one, whichever bundle runs it: a page draws a frame's
		// canvas (an srcdoc frame runs a bundle of its own) or a popup's, with
		// either realm's methods
		const shared = this.client.canvasTaints;
		const {
			canvases: taintedCanvases,
			contexts: taintedContexts,
			sources: taintedSources,
			bitmaps: taintedBitmaps,
		} = shared;
		/** a canvas now holds another origin's data: what was captured from it ends */
		const taintCanvas = (canvas: object) => {
			taintedCanvases.add(canvas);
			const tracks = shared.sourceTracks.get(canvas);
			if (tracks && shared.stopTrack)
				for (const track of tracks) shared.stopTrack(track);
		};
		const taintBitmap = (bitmap: object) => {
			taintedSources.add(bitmap);
			if (!taintedBitmaps.has(bitmap)) {
				taintedBitmaps.add(bitmap);
				shared.bitmapCount++;
			}
		};

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
			// a copy of a load that came through another origin
			if (opaqueCopies.has(loaded)) return true;
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
		// a load of the page's own URL the worker marked as another origin's
		// (redirected through one, or answered opaque by the page's emulated
		// service worker)
		const opaqueLoad = this.client
			.getModule(ResourceTimingModule)!
			.opaqueLoads();
		/**
		 * per element: the URL it was judged by, whether that is another
		 * origin's, the URL its marks are asked by ('' for none), and the
		 * verdict
		 */
		const judged = new WeakMap<
			object,
			{ url: string; cross: boolean; real: string; taints: boolean }
		>();
		// A video or sound of the page's own URL: its load is over (and its
		// mark readable) when its last byte has come, so the worker is asked
		// whether it came through another origin (server/mediaLoads.ts), once
		// a load, when the element first has anything to draw, hear or capture
		const mediaReady = getter(global.HTMLMediaElement?.prototype, 'readyState');
		const asked = new WeakMap<object, { url: string; crossed: boolean }>();
		const mediaCrossed = (element: object, url: string): boolean => {
			if (!mediaReady || (Reflect.apply(mediaReady, element, []) as number) < 1)
				return false;
			const known = asked.get(element);
			if (known && known.url === url) return known.crossed;
			// no answer: another origin's
			let crossed = true;
			try {
				crossed =
					this.client
						.getModule(SyncModule)!
						.jsonAPI(`${this.client.directory}media/crossed`, url) !== false;
			} catch (error) {
				// a document with no bridge
			}
			if (!known)
				this.watch(element, ['emptied', 'loadstart'], () =>
					asked.delete(element),
				);
			asked.set(element, { url, crossed });
			return crossed;
		};
		const elementTaints = (
			element: object,
			url: string,
			cors: ((this: unknown) => unknown) | undefined,
			media = false,
		): boolean => {
			let last = judged.get(element);
			if (!last || last.url !== url) {
				const cross = crossOrigin(url);
				last = {
					url,
					cross,
					real: !cross && /^https?:/.test(url) ? url : '',
					// a crossorigin load reached the page only past the CORS check
					taints:
						cross && (cors ? Reflect.apply(cors, element, []) === null : true),
				};
				judged.set(element, last);
			}
			if (last.taints || last.cross || last.real === '') return last.taints;
			// a load of the page's own URL: another origin's when the worker
			// marked it, which is not known until it has loaded (an element
			// drawn while it loads draws nothing, and is asked again)
			if (opaqueLoad(last.real)) last.taints = true;
			else if (media) return mediaCrossed(element, last.real);
			return last.taints;
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
						true,
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

		this.taints = taints;
		// the inject's listeners run even for an event a page listener stops
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;
		const eventTarget = getter(global.Event.prototype, 'target');
		const eventType = getter(global.Event.prototype, 'type');
		global.Event.prototype.stopImmediatePropagation = proxyModule.wrapFunction(
			stopImmediate,
			(target, that, args) => {
				let callbacks: (() => void)[] | undefined;
				try {
					const element = Reflect.apply(eventTarget!, that, []) as object;
					callbacks =
						element === null
							? undefined
							: shared.watched
									.get(element)
									?.get(String(Reflect.apply(eventType!, that, [])));
				} catch (error) {
					// not an event: the native call throws
				}
				if (callbacks) for (const callback of callbacks) callback();
				return Reflect.apply(target, that, args);
			},
		);
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
							taintCanvas(Reflect.apply(canvasOf, that, []) as object);
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
									taintCanvas(Reflect.apply(canvasOf, that, []) as object);
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
		// a lazy WebGL global the page's first context of its kind settles
		const resolvers = new Map<string, (value: unknown) => void>();
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
						if (typeof name === 'string') {
							hookTextures(proto, name);
							resolvers.get(name)?.(
								Reflect.getOwnPropertyDescriptor(proto, 'constructor')?.value,
							);
						}
					}
					return context;
				},
			);
		};
		hookGetContext(canvasProto);

		// The WebGL interfaces, behind accessors until first read: whoever
		// reads one gets it with its texture uploads hooked already
		const offscreenGetContext = global.OffscreenCanvas?.prototype.getContext;
		const lazyInterface = (name: string, type: string) => {
			let pending = true;
			const settle = (value: unknown, present: boolean) => {
				pending = false;
				this.client.lazyGlobals.delete(name);
				if (present)
					Reflect.defineProperty(global, name, {
						value,
						writable: true,
						enumerable: false,
						configurable: true,
					});
				else Reflect.deleteProperty(global, name);
			};
			const resolve = () => {
				if (!pending) return;
				let found: unknown;
				try {
					const context =
						offscreenGetContext &&
						(Reflect.apply(
							offscreenGetContext,
							new global.OffscreenCanvas(1, 1),
							[type],
						) as object | null);
					if (context) {
						const proto = Reflect.getPrototypeOf(context);
						if (proto) {
							if (!seen.has(proto)) {
								seen.add(proto);
								hookTextures(proto, name);
							}
							found = Reflect.getOwnPropertyDescriptor(
								proto,
								'constructor',
							)?.value;
						}
						// a throwaway context gives its resources back
						(
							context as {
								getExtension?: (
									name: string,
								) => { loseContext?: () => void } | null;
							}
						)
							.getExtension?.('WEBGL_lose_context')
							?.loseContext?.();
					}
				} catch (error) {
					// no WebGL here: then no page has a context to upload to
				}
				// without WebGL the interface cannot be had (so the name goes)
				settle(found, found !== undefined);
			};
			resolvers.set(name, (value) => {
				if (pending) settle(value, true);
			});
			this.client.lazyGlobals.set(name, resolve);
			// deleted first: redefining the browser's lazy property in place
			// makes the interface (about 85 KB a frame for the two, measured
			// with frame-cost), deleting it does not, and the context hands it
			// out again
			const keys = Reflect.ownKeys(global);
			const after = keys[keys.indexOf(name) - 1];
			if (after !== undefined) this.client.globalKeyAfter.set(name, after);
			Reflect.deleteProperty(global, name);
			Reflect.defineProperty(global, name, {
				get: proxyModule.wrapFunction(
					function WebGLInterface() {} as () => unknown,
					() => {
						resolve();
						return Reflect.get(global, name);
					},
				),
				set: proxyModule.wrapFunction(
					function WebGLInterface(_value: unknown) {} as (
						value: unknown,
					) => void,
					(_target, _that, args) => settle(args[0], true),
				),
				enumerable: false,
				configurable: true,
			});
		};
		lazyInterface('WebGLRenderingContext', 'webgl');
		lazyInterface('WebGL2RenderingContext', 'webgl2');

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
						if (taintedCanvases.has(that as object)) taintBitmap(bitmap);
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
					if (tainted) taintBitmap(bitmap);
					return bitmap;
				},
			);
		this.#hookClones(shared, proxyModule);
		// a VideoFrame of a tainting source is refused, as natively
		const NativeVideoFrame = (global as { VideoFrame?: Function }).VideoFrame;
		if (typeof NativeVideoFrame === 'function')
			(global as { VideoFrame?: Function }).VideoFrame =
				proxyModule.wrapFunction(
					NativeVideoFrame,
					(target, that, args, newTarget) => {
						if (newTarget && args.length && taints(args[0]))
							throw securityError(
								"Failed to construct 'VideoFrame': VideoFrames can't be created from tainted sources.",
							);
						return newTarget
							? Reflect.construct(target, args, newTarget)
							: Reflect.apply(target, that, args);
					},
					true,
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
						taintCanvas(Reflect.apply(rendererCanvas, that, []) as object);
					return result;
				},
			);
		}
	}
	/**
	 * A tainted ImageBitmap never leaves its realm: a message that holds one
	 * (postMessage to a window, worker, port or channel, structuredClone, a
	 * history state) or transfers one is the browser's DataCloneError. Every
	 * route is same-origin to the browser, so it clones them all. Only looked
	 * for once a tainted bitmap exists under the proxied top.
	 */
	#hookClones(shared: CanvasTaints, proxyModule: ProxyModule) {
		const global = this.client.global;
		const bitmaps = shared.bitmaps;
		const isView = global.ArrayBuffer.isView;
		const mapForEach = global.Map.prototype.forEach;
		const setForEach = global.Set.prototype.forEach;
		/** what of a message is a tainted bitmap: transferred, held, or neither */
		const taintIn = (
			data: unknown,
			transfer: unknown,
		): 'transferred' | 'cloned' | null => {
			if (!shared.bitmapCount) return null;
			// one the message holds and also transfers is refused as
			// transferred; one only in the transfer list goes (measured)
			const how = (bitmap: object) => {
				if (Array.isArray(transfer))
					for (let i = 0; i < transfer.length; i++)
						if (transfer[i] === bitmap) return 'transferred';
				return 'cloned';
			};
			const stack: unknown[] = [data];
			const seen = new Set<object>();
			// a bound on the work: past it, the browser's own clone decides
			let budget = 100_000;
			const push = (value: unknown) => {
				if (value !== null && typeof value === 'object') stack.push(value);
			};
			while (stack.length && budget-- > 0) {
				const value = stack.pop() as object;
				if (seen.has(value)) continue;
				seen.add(value);
				if (bitmaps.has(value)) return how(value);
				try {
					if (isView(value)) continue;
					try {
						Reflect.apply(mapForEach, value, [
							(entry: unknown, key: unknown) => {
								push(key);
								push(entry);
							},
						]);
						continue;
					} catch (error) {
						// not a Map
					}
					try {
						Reflect.apply(setForEach, value, [push]);
						continue;
					} catch (error) {
						// not a Set
					}
					// what a clone reads: own enumerable data properties (a getter
					// is left to the browser, which runs it once)
					for (const key of Reflect.ownKeys(value)) {
						if (typeof key !== 'string') continue;
						budget--;
						const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
						if (descriptor?.enumerable && 'value' in descriptor)
							push(descriptor.value);
					}
				} catch (error) {
					// a revoked proxy or the like: the browser's clone throws
				}
			}
			return null;
		};
		const check = (
			iface: string,
			method: string,
			data: unknown,
			transfer?: unknown,
		) => {
			const how = taintIn(data, transfer);
			if (how)
				throw new global.DOMException(
					`Failed to execute '${method}' on '${iface}': Non-origin-clean ImageBitmap cannot be ${how}.`,
					'DataCloneError',
				);
		};
		this.client.cloneCheck = check;
		/** the transfer list of postMessage's second argument, either form */
		const transferOf = (option: unknown) =>
			Array.isArray(option)
				? option
				: option !== null && typeof option === 'object'
					? Reflect.get(option, 'transfer')
					: undefined;
		for (const [iface, proto] of [
			['Worker', global.Worker?.prototype],
			['MessagePort', global.MessagePort?.prototype],
			['BroadcastChannel', global.BroadcastChannel?.prototype],
		] as const)
			if (proto && typeof proto.postMessage === 'function')
				proto.postMessage = proxyModule.wrapFunction(
					proto.postMessage,
					(target, that, args) => {
						if (args.length)
							check(iface, 'postMessage', args[0], transferOf(args[1]));
						return Reflect.apply(target, that, args);
					},
				);
		if (typeof global.structuredClone === 'function')
			global.structuredClone = proxyModule.wrapFunction(
				global.structuredClone,
				(target, that, args) => {
					if (args.length)
						check('Window', 'structuredClone', args[0], transferOf(args[1]));
					return Reflect.apply(target, that, args);
				},
			);
		const history = global.History?.prototype;
		if (history)
			for (const name of ['pushState', 'replaceState'] as const)
				if (typeof history[name] === 'function')
					history[name] = proxyModule.wrapFunction(
						history[name],
						(target, that, args) => {
							if (args.length) check('History', name, args[0]);
							return Reflect.apply(target, that, args);
						},
					);
	}
}
