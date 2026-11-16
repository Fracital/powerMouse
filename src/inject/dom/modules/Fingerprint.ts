import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

// Brave-style per-site anti-fingerprinting, opt in per surface (the Shields
// "Block fingerprinting" submenu). Every surface here is OFF by default and the
// module is added only when one is on (src/inject/dom/document.ts), so a default
// frame installs nothing and pays no heap; `performanceMemory` is the Memory
// module, not this one.
//
// The farbling surfaces (canvas, webgl, audio) add deterministic sub-perceptual
// noise seeded from a per-session value (Config.fingerprintSeed) mixed with the
// document's eTLD+1: a site sees stable values within itself (the same seed, so
// the same noise for the same input) but cannot be correlated across sites (a
// different eTLD+1, so different noise), and the whole scheme re-seeds when the
// service worker restarts. The page never reads the seed, only its noise, so it
// is no fingerprint of its own. The limiting/rounding surfaces (fonts, screen,
// hardwareConcurrency, deviceMemory, mediaDevices, locale) are deterministic.
//
// This module's readback hooks are installed before CanvasTaint's (document.ts),
// so CanvasTaint's taint check wraps them: a cross-origin-tainted canvas throws
// its SecurityError before anything is farbled, exactly as natively. Every hook
// is guarded so a failure falls back to the native value and never breaks the
// page: farbling must not break canvas/webgl/audio functionality or SOP.

/** a xorshift32 PRNG; returns a fresh uint32 each call */
function prng(seed: number): () => number {
	let state = seed >>> 0 || 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
}

/** FNV-1a mix of a 32-bit base with a string (the per-session seed and eTLD+1) */
function mixString(base: number, text: string): number {
	let hash = (base ^ 0x811c9dc5) >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/** mix a 32-bit seed with a small integer tag (per-surface, per-channel streams) */
function mixInt(base: number, tag: number): number {
	let hash = Math.imul(base ^ tag, 0x01000193) >>> 0;
	hash ^= hash >>> 15;
	return hash >>> 0;
}

const clampByte = (value: number): number =>
	value < 0 ? 0 : value > 255 ? 255 : value;

/** surface tags, so each farbling stream is independent for the same site */
const TAG = { canvas: 1, webgl: 2, audio: 3, fonts: 4 };

/**
 * Perturb an 8-bit RGBA readback in place: each pixel's R, G and B move by a
 * deterministic −1, 0 or +1 (alpha untouched), so the image is visually
 * identical but every site's readback hashes differently and a site's own
 * readback of the same pixels is stable.
 */
function farbleRGBA(data: Uint8ClampedArray, seed: number): void {
	const next = prng(seed);
	for (let i = 0; i < data.length; i += 4) {
		const bits = next();
		data[i] = clampByte(data[i] + ((bits & 0xff) % 3) - 1);
		data[i + 1] = clampByte(data[i + 1] + (((bits >>> 8) & 0xff) % 3) - 1);
		data[i + 2] = clampByte(data[i + 2] + (((bits >>> 16) & 0xff) % 3) - 1);
	}
}

/** perturb a float sample buffer in place by a tiny deterministic amount */
function farbleFloats(data: Float32Array, seed: number, scale: number): void {
	const next = prng(seed);
	for (let i = 0; i < data.length; i++)
		data[i] += (next() / 0x100000000 - 0.5) * scale;
}

// a small standard allowlist for font-availability probing (document.fonts):
// the generic families plus fonts a stock Chrome always has, lower-cased.
// (A list, not a Set: this file is a deferred part of the bundle, evaluated
// when the bundle first needs a part, maybe after the page has replaced the
// global Set, so its top level reads no global.)
const FONT_ALLOWLIST = [
	'serif',
	'sans-serif',
	'monospace',
	'cursive',
	'fantasy',
	'system-ui',
	'ui-serif',
	'ui-sans-serif',
	'ui-monospace',
	'math',
	'arial',
	'helvetica',
	'times new roman',
	'times',
	'courier new',
	'courier',
	'georgia',
	'verdana',
	'tahoma',
	'trebuchet ms',
];

export default class FingerprintModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const proxyModule = client.getModule(ProxyModule)!;

		// the document's eTLD+1 (the window membrane's site key), or its origin
		// for an opaque document: the per-site component of every seed here
		const site = client.siteKey ?? client.realOrigin();
		const siteSeed = mixString(client.fingerprintSeed >>> 0, String(site));

		/** redefine a native getter so it reads as native but returns `compute(real)` */
		const wrapGetter = (
			proto: object | undefined,
			name: string,
			compute: (real: unknown) => unknown,
		) => {
			if (!proto) return;
			const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
			const get = descriptor?.get;
			if (!get) return;
			Reflect.defineProperty(proto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(get, (target, that, args) =>
					compute(Reflect.apply(target, that, args)),
				),
			});
		};

		// --- Canvas: farble the 2D readback paths -----------------------------
		if (client.emulatesFingerprint('canvas'))
			try {
				this.#hookCanvas(proxyModule, mixInt(siteSeed, TAG.canvas));
			} catch (error) {
				// a realm without canvas, or a shape that moved: leave it native
			}

		// --- WebGL: noise readPixels, spoof the unmasked vendor/renderer ------
		if (client.emulatesFingerprint('webgl'))
			try {
				this.#hookWebGL(proxyModule, mixInt(siteSeed, TAG.webgl));
			} catch (error) {
				// no WebGL here
			}

		// --- Audio: tiny per-site noise on the readback paths -----------------
		if (client.emulatesFingerprint('audio'))
			try {
				this.#hookAudio(proxyModule, mixInt(siteSeed, TAG.audio));
			} catch (error) {
				// no Web Audio here
			}

		// --- Fonts: farble measureText, limit document.fonts.check ------------
		if (client.emulatesFingerprint('fonts'))
			try {
				this.#hookFonts(proxyModule, mixInt(siteSeed, TAG.fonts));
			} catch (error) {
				// no canvas/FontFaceSet here
			}

		// --- Screen: round the geometry to a bucket ---------------------------
		if (client.emulatesFingerprint('screen'))
			try {
				const BUCKET = 50;
				const round = (real: unknown) =>
					typeof real === 'number' && isFinite(real)
						? Math.floor(real / BUCKET) * BUCKET
						: real;
				const Screen = global.Screen?.prototype as object | undefined;
				for (const name of ['width', 'height', 'availWidth', 'availHeight'])
					wrapGetter(Screen, name, round);
				// outerWidth/outerHeight live on the window (own) or its prototype
				for (const name of ['outerWidth', 'outerHeight']) {
					let owner: object | null = global;
					while (owner && !Reflect.getOwnPropertyDescriptor(owner, name))
						owner = Reflect.getPrototypeOf(owner);
					wrapGetter(owner ?? undefined, name, round);
				}
			} catch (error) {
				// no Screen here
			}

		// --- Hardware concurrency: cap the core count low ---------------------
		if (client.emulatesFingerprint('hardwareConcurrency'))
			try {
				const CAP = 2;
				wrapGetter(
					global.Navigator?.prototype,
					'hardwareConcurrency',
					(real) => (typeof real === 'number' ? Math.min(real, CAP) : real),
				);
			} catch (error) {
				// no Navigator here
			}

		// --- Device memory: cap navigator.deviceMemory (Chrome caps it at 8;
		//     this caps it lower to drop the remaining entropy) ----------------
		if (client.emulatesFingerprint('deviceMemory'))
			try {
				const CAP = 4;
				wrapGetter(global.Navigator?.prototype, 'deviceMemory', (real) =>
					typeof real === 'number' ? Math.min(real, CAP) : real,
				);
			} catch (error) {
				// deviceMemory is Chrome-only; absent elsewhere
			}

		// --- Media devices: one of each kind, so the device count can't
		//     enumerate ------------------------------------------------------
		if (client.emulatesFingerprint('mediaDevices'))
			try {
				const proto = (
					global as unknown as { MediaDevices?: { prototype: object } }
				).MediaDevices?.prototype;
				const native = proto
					? Reflect.getOwnPropertyDescriptor(proto, 'enumerateDevices')?.value
					: undefined;
				if (typeof native === 'function')
					Reflect.defineProperty(proto!, 'enumerateDevices', {
						...Reflect.getOwnPropertyDescriptor(proto!, 'enumerateDevices'),
						value: proxyModule.wrapFunction(native, (target, that, args) =>
							(Reflect.apply(target, that, args) as Promise<unknown[]>).then(
								(list: unknown[]) => {
									const seen = new Set<unknown>();
									const kept: unknown[] = [];
									for (const device of list) {
										const kind = (device as { kind?: unknown })?.kind;
										if (seen.has(kind)) continue;
										seen.add(kind);
										kept.push(device);
									}
									return kept;
								},
							),
						),
					});
			} catch (error) {
				// no MediaDevices here
			}

		// --- Locale: a standard language list and timezone --------------------
		if (client.emulatesFingerprint('locale'))
			try {
				this.#hookLocale(proxyModule, wrapGetter);
			} catch (error) {
				// no Navigator/Intl here
			}
	}

	/** farble getImageData for a 2D context prototype, and toDataURL/toBlob/convertToBlob via a farbled copy */
	#hookCanvas(proxyModule: ProxyModule, seed: number) {
		const global = this.client.global;
		const doc = global.document;

		const value = (
			proto: object | undefined,
			name: string,
		): Function | undefined =>
			proto
				? (Reflect.getOwnPropertyDescriptor(proto, name)?.value as Function)
				: undefined;
		const getterOf = (proto: object | undefined, name: string) =>
			proto ? Reflect.getOwnPropertyDescriptor(proto, name)?.get : undefined;

		const C2D = global.CanvasRenderingContext2D?.prototype as
			object | undefined;
		const Off2D = (
			global as unknown as {
				OffscreenCanvasRenderingContext2D?: { prototype: object };
			}
		).OffscreenCanvasRenderingContext2D?.prototype;
		const HTMLCanvas = global.HTMLCanvasElement?.prototype as
			object | undefined;
		const OffCanvas = (
			global as unknown as {
				OffscreenCanvas?: {
					prototype: object;
					new (w: number, h: number): object;
				};
			}
		).OffscreenCanvas;

		// the true natives, for the copy-canvas path (before CanvasTaint wraps them)
		const nativeGetImageData = value(C2D, 'getImageData');
		const nativeGetImageDataOff = value(Off2D, 'getImageData');
		const nativePutImageData = value(C2D, 'putImageData');
		const nativePutImageDataOff = value(Off2D, 'putImageData');
		const nativeDrawImage = value(C2D, 'drawImage');
		const nativeDrawImageOff = value(Off2D, 'drawImage');
		const nativeGetContext = value(HTMLCanvas, 'getContext');
		const nativeGetContextOff = OffCanvas
			? value(OffCanvas.prototype, 'getContext')
			: undefined;
		const canvasWidth = getterOf(HTMLCanvas, 'width');
		const canvasHeight = getterOf(HTMLCanvas, 'height');
		const canvasWidthSet = Reflect.getOwnPropertyDescriptor(
			HTMLCanvas!,
			'width',
		)?.set;
		const canvasHeightSet = Reflect.getOwnPropertyDescriptor(
			HTMLCanvas!,
			'height',
		)?.set;
		const offWidth = OffCanvas
			? getterOf(OffCanvas.prototype, 'width')
			: undefined;
		const offHeight = OffCanvas
			? getterOf(OffCanvas.prototype, 'height')
			: undefined;

		// getImageData: call the native (CanvasTaint's taint check wraps this and
		// throws first for a tainted canvas), then farble the returned pixels
		const hookGetImageData = (proto: object | undefined, native?: Function) => {
			if (!proto || !native) return;
			Reflect.defineProperty(proto, 'getImageData', {
				...Reflect.getOwnPropertyDescriptor(proto, 'getImageData'),
				value: proxyModule.wrapFunction(
					native as (...a: unknown[]) => unknown,
					(target, that, args) => {
						const image = Reflect.apply(target, that, args) as ImageData;
						try {
							farbleRGBA(image.data, seed);
						} catch (error) {
							// an odd ImageData: leave it
						}
						return image;
					},
				),
			});
		};
		hookGetImageData(C2D, nativeGetImageData);
		hookGetImageData(Off2D, nativeGetImageDataOff);

		// a farbled same-size copy of `canvas`, drawn and read back with the true
		// natives (so neither the farble nor the taint wrapper runs on the copy)
		const farbledCopy = (
			canvas: object,
			width: number,
			height: number,
		): object | null => {
			if (!width || !height) return null;
			if (
				canvas instanceof global.HTMLCanvasElement &&
				nativeGetContext &&
				nativeDrawImage &&
				nativeGetImageData &&
				nativePutImageData &&
				canvasWidthSet &&
				canvasHeightSet
			) {
				const copy = doc.createElement('canvas');
				Reflect.apply(canvasWidthSet, copy, [width]);
				Reflect.apply(canvasHeightSet, copy, [height]);
				const ctx = Reflect.apply(nativeGetContext, copy, ['2d']) as object;
				Reflect.apply(nativeDrawImage, ctx, [canvas, 0, 0]);
				const image = Reflect.apply(nativeGetImageData, ctx, [
					0,
					0,
					width,
					height,
				]) as ImageData;
				farbleRGBA(image.data, seed);
				Reflect.apply(nativePutImageData, ctx, [image, 0, 0]);
				return copy;
			}
			if (
				OffCanvas &&
				nativeGetContextOff &&
				nativeDrawImageOff &&
				nativeGetImageDataOff &&
				nativePutImageDataOff
			) {
				const copy = new OffCanvas(width, height);
				const ctx = Reflect.apply(nativeGetContextOff, copy, ['2d']) as object;
				Reflect.apply(nativeDrawImageOff, ctx, [canvas, 0, 0]);
				const image = Reflect.apply(nativeGetImageDataOff, ctx, [
					0,
					0,
					width,
					height,
				]) as ImageData;
				farbleRGBA(image.data, seed);
				Reflect.apply(nativePutImageDataOff, ctx, [image, 0, 0]);
				return copy;
			}
			return null;
		};

		// toDataURL / toBlob (HTMLCanvasElement) and convertToBlob (OffscreenCanvas):
		// encode a farbled copy instead of the original. CanvasTaint wraps these
		// too, so a tainted canvas throws before this runs.
		const hookEncoder = (
			proto: object | undefined,
			name: string,
			widthGet?: Function,
			heightGet?: Function,
		) => {
			const native = value(proto, name);
			if (!proto || !native || !widthGet || !heightGet) return;
			Reflect.defineProperty(proto, name, {
				...Reflect.getOwnPropertyDescriptor(proto, name),
				value: proxyModule.wrapFunction(
					native as (...a: unknown[]) => unknown,
					(target, that, args) => {
						try {
							const width = Reflect.apply(widthGet, that, []) as number;
							const height = Reflect.apply(heightGet, that, []) as number;
							const copy = farbledCopy(that as object, width, height);
							if (copy) return Reflect.apply(target, copy, args);
						} catch (error) {
							// fall through to the native call (which also throws for taint)
						}
						return Reflect.apply(target, that, args);
					},
				),
			});
		};
		hookEncoder(HTMLCanvas, 'toDataURL', canvasWidth, canvasHeight);
		hookEncoder(HTMLCanvas, 'toBlob', canvasWidth, canvasHeight);
		if (OffCanvas)
			hookEncoder(OffCanvas.prototype, 'convertToBlob', offWidth, offHeight);
	}

	/** noise readPixels and spoof the unmasked WebGL strings on first use of a context */
	#hookWebGL(proxyModule: ProxyModule, seed: number) {
		const global = this.client.global;
		const hooked = new WeakSet<object>();
		// the debug-renderer-info pnames, by value (the extension's own constants)
		const UNMASKED_VENDOR = 0x9245;
		const UNMASKED_RENDERER = 0x9246;
		const VENDOR_SPOOF = 'Google Inc. (Google)';
		const RENDERER_SPOOF =
			'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)';

		const hookContextProto = (proto: object) => {
			if (!proto || hooked.has(proto)) return;
			hooked.add(proto);
			const readPixels = Reflect.getOwnPropertyDescriptor(
				proto,
				'readPixels',
			)?.value;
			if (typeof readPixels === 'function')
				Reflect.defineProperty(proto, 'readPixels', {
					...Reflect.getOwnPropertyDescriptor(proto, 'readPixels'),
					value: proxyModule.wrapFunction(readPixels, (target, that, args) => {
						const result = Reflect.apply(target, that, args);
						try {
							const pixels = args[6];
							if (
								pixels instanceof Uint8Array ||
								pixels instanceof Uint8ClampedArray
							) {
								const next = prng(seed);
								for (let i = 0; i < pixels.length; i++)
									pixels[i] = clampByte(pixels[i] + ((next() & 0xff) % 3) - 1);
							}
						} catch (error) {
							// an unexpected buffer: leave it
						}
						return result;
					}),
				});
			const getParameter = Reflect.getOwnPropertyDescriptor(
				proto,
				'getParameter',
			)?.value;
			if (typeof getParameter === 'function')
				Reflect.defineProperty(proto, 'getParameter', {
					...Reflect.getOwnPropertyDescriptor(proto, 'getParameter'),
					value: proxyModule.wrapFunction(
						getParameter,
						(target, that, args) => {
							if (args[0] === UNMASKED_VENDOR) return VENDOR_SPOOF;
							if (args[0] === UNMASKED_RENDERER) return RENDERER_SPOOF;
							return Reflect.apply(target, that, args);
						},
					),
				});
		};

		// hook on first getContext of a webgl kind, reaching the prototype through
		// the returned context (so the two WebGL interface objects are never named
		// here, which would materialize them for every frame, docs frame-cost)
		const webglKinds = new Set([
			'webgl',
			'webgl2',
			'experimental-webgl',
			'experimental-webgl2',
		]);
		const wrapGetContext = (proto: object | undefined) => {
			const native = proto
				? (Reflect.getOwnPropertyDescriptor(proto, 'getContext')
						?.value as Function)
				: undefined;
			if (!proto || typeof native !== 'function') return;
			Reflect.defineProperty(proto, 'getContext', {
				...Reflect.getOwnPropertyDescriptor(proto, 'getContext'),
				value: proxyModule.wrapFunction(native, (target, that, args) => {
					const context = Reflect.apply(target, that, args);
					try {
						if (context && webglKinds.has(String(args[0])))
							hookContextProto(Reflect.getPrototypeOf(context) as object);
					} catch (error) {
						// nothing to hook
					}
					return context;
				}),
			});
		};
		wrapGetContext(global.HTMLCanvasElement?.prototype);
		wrapGetContext(
			(global as unknown as { OffscreenCanvas?: { prototype: object } })
				.OffscreenCanvas?.prototype,
		);
	}

	/** tiny per-site noise on AudioBuffer and AnalyserNode readbacks */
	#hookAudio(proxyModule: ProxyModule, seed: number) {
		const global = this.client.global as unknown as Record<string, any>;
		const AudioBuffer = global.AudioBuffer;
		const AnalyserNode = global.AnalyserNode;
		const SCALE = 1e-7;
		// farble each channel of a buffer once, so playback is not perturbed twice
		const done = new WeakMap<object, Set<number>>();

		if (AudioBuffer?.prototype?.getChannelData) {
			const native = AudioBuffer.prototype.getChannelData;
			AudioBuffer.prototype.getChannelData = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					const data = Reflect.apply(target, that, args) as Float32Array;
					try {
						const channel = Number(args[0]) || 0;
						let channels = done.get(that as object);
						if (!channels) done.set(that as object, (channels = new Set()));
						if (!channels.has(channel)) {
							channels.add(channel);
							farbleFloats(data, mixInt(seed, 100 + channel), SCALE);
						}
					} catch (error) {
						// leave the data
					}
					return data;
				},
			);
		}
		if (AudioBuffer?.prototype?.copyFromChannel) {
			const native = AudioBuffer.prototype.copyFromChannel;
			AudioBuffer.prototype.copyFromChannel = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					const result = Reflect.apply(target, that, args);
					try {
						const destination = args[0];
						if (destination instanceof Float32Array)
							farbleFloats(
								destination,
								mixInt(seed, 200 + (Number(args[1]) || 0)),
								SCALE,
							);
					} catch (error) {
						// leave it
					}
					return result;
				},
			);
		}
		if (AnalyserNode?.prototype?.getFloatFrequencyData) {
			const native = AnalyserNode.prototype.getFloatFrequencyData;
			AnalyserNode.prototype.getFloatFrequencyData = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					const result = Reflect.apply(target, that, args);
					try {
						if (args[0] instanceof Float32Array)
							farbleFloats(args[0], mixInt(seed, 300), SCALE);
					} catch (error) {
						// leave it
					}
					return result;
				},
			);
		}
	}

	/** farble measureText metrics, and limit document.fonts.check to a standard allowlist */
	#hookFonts(proxyModule: ProxyModule, seed: number) {
		const global = this.client.global;
		const C2D = global.CanvasRenderingContext2D?.prototype as
			Record<string, any> | undefined;
		if (C2D?.measureText) {
			const native = C2D.measureText;
			C2D.measureText = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					const metrics = Reflect.apply(target, that, args) as TextMetrics;
					try {
						const text = String(args[0] ?? '');
						const font = String((that as { font?: unknown })?.font ?? '');
						const width = metrics.width;
						// noise keyed by the font *and* the text, so font-probing (the
						// same text measured under different fonts) cannot read a stable
						// width even when the fonts render identically, while the same
						// font+text stays stable for layout
						const hash = mixString(
							mixInt(seed, Math.round(width * 64)),
							font + '\0' + text,
						);
						const noise = (hash / 0x100000000 - 0.5) * 2 * 0.05;
						Reflect.defineProperty(metrics, 'width', {
							value: width + noise,
							configurable: true,
							enumerable: true,
						});
					} catch (error) {
						// an odd TextMetrics: leave it
					}
					return metrics;
				},
			);
		}

		const fonts = (
			global.document as unknown as { fonts?: Record<string, any> }
		).fonts;
		const FontFaceSet = (
			global as unknown as { FontFaceSet?: { prototype: Record<string, any> } }
		).FontFaceSet;
		const checkProto = FontFaceSet?.prototype;
		if (fonts && checkProto?.check) {
			const native = checkProto.check;
			// read the family tokens out of a CSS font shorthand and judge them
			const familiesAllowed = (shorthand: string): boolean => {
				// the family list is everything after the last size/line-height token;
				// cheap heuristic: split on commas, take the trailing word of the
				// first chunk and the whole of the rest
				const families = shorthand.split(',');
				for (let i = 0; i < families.length; i++) {
					let family = families[i].trim().replace(/^["']|["']$/g, '');
					if (i === 0) {
						// strip the leading "<style> <variant> <weight> <size>" run
						const parts = family.split(/\s+/);
						family = parts[parts.length - 1];
					}
					family = family.replace(/^["']|["']$/g, '').toLowerCase();
					if (family && !FONT_ALLOWLIST.includes(family)) return false;
				}
				return true;
			};
			checkProto.check = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					try {
						if (!familiesAllowed(String(args[0] ?? ''))) return false;
					} catch (error) {
						// fall through to native
					}
					return Reflect.apply(target, that, args);
				},
			);
		}
	}

	/** a standard language list and a stable timezone */
	#hookLocale(
		proxyModule: ProxyModule,
		wrapGetter: (
			proto: object | undefined,
			name: string,
			compute: (real: unknown) => unknown,
		) => void,
	) {
		const global = this.client.global;
		const Navigator = global.Navigator?.prototype as object | undefined;
		const LANGUAGES = Object.freeze(['en-US', 'en']);
		wrapGetter(Navigator, 'languages', () => LANGUAGES);
		wrapGetter(Navigator, 'language', () => 'en-US');

		// timezone: report UTC through Intl and Date, a stable standard value
		const Intl = (global as unknown as { Intl?: { DateTimeFormat?: any } })
			.Intl;
		const DateTimeFormat = Intl?.DateTimeFormat;
		if (DateTimeFormat?.prototype?.resolvedOptions) {
			const native = DateTimeFormat.prototype.resolvedOptions;
			DateTimeFormat.prototype.resolvedOptions = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					const options = Reflect.apply(target, that, args) as {
						timeZone?: string;
					};
					try {
						options.timeZone = 'UTC';
					} catch (error) {
						// leave it
					}
					return options;
				},
			);
		}
		const DateProto = global.Date?.prototype as object | undefined;
		const getOffset = DateProto
			? Reflect.getOwnPropertyDescriptor(DateProto, 'getTimezoneOffset')?.value
			: undefined;
		if (typeof getOffset === 'function')
			Reflect.defineProperty(DateProto!, 'getTimezoneOffset', {
				...Reflect.getOwnPropertyDescriptor(DateProto!, 'getTimezoneOffset'),
				value: proxyModule.wrapFunction(getOffset, () => 0),
			});
	}
}
