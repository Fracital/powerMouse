import { TRANSFORM_KEY, type TransformFrame } from '../../../rtc/protocol';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { OwnWeakMap } from '../../ownCollections';
import WorkerClient from '../Client';

/**
 * The worker side of a proxied page's encoded transforms (an
 * RTCRtpScriptTransform given to a sender or a receiver, as Discord's end
 * to end encryption does it). The page's connections are STomp's
 * (src/inject/dom/rtcStack.ts), whose frames the browser never sees: the
 * browser still fires its rtctransform event here, for the transform the
 * page made, but nothing would ever come on its transformer's streams. The
 * inject made that transform with a port among its options
 * (TRANSFORM_KEY), on which the document's WebRTC worker sends each frame
 * of the sender or receiver the transform was given to
 * (src/rtc/connection.ts). Here the transformer reads as the browser's:
 * its `options` are the page's, its `readable` gives those frames as
 * RTCEncodedAudioFrame and RTCEncodedVideoFrame objects (on the browser's
 * prototypes, `instanceof` holds), and what the page writes to its
 * `writable` goes back on the port to be sent or decoded. A transformer
 * without the port (a transform the inject did not make) is the
 * browser's.
 */
export default class EncodedTransformModule extends Module<WorkerClient> {
	apply() {
		const global = this.client.global as unknown as Record<string, any>;
		// Most workers never get a transform: the interfaces and their
		// members are taken on the first rtctransform event, which this
		// listener (the worker's first) hears before the page's
		if (!('onrtctransform' in global)) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		// the browser's, taken before the page runs
		const NativeReadable = global.ReadableStream as typeof ReadableStream;
		const NativeWritable = global.WritableStream as typeof WritableStream;
		const NativePort = global.MessagePort as typeof MessagePort;
		const portPost = NativePort.prototype.postMessage;
		const portStart = NativePort.prototype.start;
		const portClose = NativePort.prototype.close;
		const listen = (global.EventTarget as typeof EventTarget).prototype
			.addEventListener;
		const eventData = Reflect.getOwnPropertyDescriptor(
			(global.MessageEvent as typeof MessageEvent).prototype,
			'data',
		)!.get!;
		const bufferLength = Reflect.getOwnPropertyDescriptor(
			(global.ArrayBuffer as typeof ArrayBuffer).prototype,
			'byteLength',
		)!.get!;
		const bufferSlice = (global.ArrayBuffer as typeof ArrayBuffer).prototype
			.slice;
		const enqueue = (global.ReadableStreamDefaultController as Function)
			.prototype.enqueue as Function;
		const objectCreate = Object.create;
		const RealmArray = global.Array as ArrayConstructor;
		const RealmObject = global.Object as ObjectConstructor;
		const RealmTypeError = global.TypeError as TypeErrorConstructor;
		const objectKeys = Object.keys;
		const performance = global.performance as Performance;
		const timeOrigin = Reflect.getOwnPropertyDescriptor(
			Performance.prototype,
			'timeOrigin',
		)!.get!;
		let installed = false;
		const install = () => {
			const Transformer = global.RTCRtpScriptTransformer as
				Function | undefined;
			const AudioFrame = global.RTCEncodedAudioFrame as Function | undefined;
			if (typeof Transformer !== 'function' || typeof AudioFrame !== 'function')
				return;
			const VideoFrame = global.RTCEncodedVideoFrame as Function | undefined;
			const nativeGetter = (Native: Function, key: string) =>
				Reflect.getOwnPropertyDescriptor(Native.prototype, key)?.get;
			const nativeOptions = nativeGetter(Transformer, 'options');
			if (!nativeOptions) return;

			interface TransformerState {
				options: unknown;
				readable: ReadableStream;
				writable: WritableStream;
			}
			interface FrameState {
				kind: 'audio' | 'video';
				data: ArrayBuffer;
				meta: Record<string, unknown>;
				type?: 'key' | 'delta';
				back: unknown;
			}
			const transformers = new OwnWeakMap<object, TransformerState | null>();
			const frames = new OwnWeakMap<object, FrameState>();

			const isBuffer = (value: unknown) => {
				try {
					Reflect.apply(bufferLength, value, []);
					return true;
				} catch (error) {
					return false;
				}
			};
			/** a frame of the port's as the page reads it */
			const frameOf = (message: TransformFrame): object | null => {
				const Class = message.kind === 'video' ? VideoFrame : AudioFrame;
				if (!Class || !isBuffer(message.data)) return null;
				const made = objectCreate(Class.prototype) as object;
				frames.set(made, {
					kind: message.kind,
					data: message.data,
					meta: message.meta,
					type: message.type,
					back: message.back,
				});
				return made;
			};
			/** the transformer's state: made the first time a page reads it, null when it is the browser's */
			const stateOf = (transformer: unknown): TransformerState | null => {
				if (typeof transformer !== 'object' || transformer === null)
					return null;
				const known = transformers.get(transformer);
				if (known !== undefined) return known;
				let options: unknown;
				try {
					options = Reflect.apply(nativeOptions, transformer, []);
				} catch (error) {
					return null;
				}
				const port =
					typeof options === 'object' && options !== null
						? (Reflect.getOwnPropertyDescriptor(options, TRANSFORM_KEY)
								?.value as unknown)
						: undefined;
				if (!(port instanceof NativePort)) {
					transformers.set(transformer, null);
					return null;
				}
				let controller: ReadableStreamDefaultController | null = null;
				const readable = new NativeReadable(
					{
						start: (made) => {
							controller = made;
						},
					},
					{ highWaterMark: 0 },
				);
				const writable = new NativeWritable({
					write: (frame: unknown) => {
						const own =
							typeof frame === 'object' && frame !== null
								? frames.get(frame)
								: undefined;
						// what the page writes that is no frame of these is not sent
						if (!own) return;
						// a copy: the page may read the frame it wrote
						const data = Reflect.apply(
							bufferSlice,
							own.data,
							[0],
						) as ArrayBuffer;
						const message: TransformFrame = {
							kind: own.kind,
							data,
							meta: own.meta,
							back: own.back,
						};
						Reflect.apply(portPost, port, [message, [data]]);
					},
					close: () => Reflect.apply(portClose, port, []),
				});
				Reflect.apply(listen, port, [
					'message',
					(event: MessageEvent) => {
						const message = Reflect.apply(
							eventData,
							event,
							[],
						) as TransformFrame;
						const made = message && frameOf(message);
						if (made && controller)
							try {
								Reflect.apply(enqueue, controller, [made]);
							} catch (error) {
								// the page cancelled the readable
							}
					},
				]);
				Reflect.apply(portStart, port, []);
				const state: TransformerState = {
					options: (options as Record<string, unknown>).options,
					readable,
					writable,
				};
				transformers.set(transformer, state);
				return state;
			};

			const hook = (
				prototype: object,
				key: string,
				part: 'get' | 'set' | 'value',
				run: (
					that: unknown,
					args: unknown[],
				) => { value: unknown } | null | undefined,
			) => {
				const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
				const native = descriptor?.[part];
				if (!descriptor || typeof native !== 'function') return;
				descriptor[part] = proxyModule.wrapFunction(
					native as Function,
					(target, that, args) => {
						const own = run(that, args);
						return own ? own.value : Reflect.apply(target, that, args);
					},
				);
				Reflect.defineProperty(prototype, key, descriptor);
			};

			for (const key of ['options', 'readable', 'writable'] as const)
				hook(Transformer.prototype, key, 'get', (that) => {
					const state = stateOf(that);
					return state && { value: state[key] };
				});

			// --- the frames ---

			const own = (that: unknown) =>
				typeof that === 'object' && that !== null
					? frames.get(that)
					: undefined;
			/** getMetadata()'s answer: a new object each time, its times on this worker's clock */
			const metadata = (state: FrameState) => {
				const out = new RealmObject() as Record<string, unknown>;
				const origin = Reflect.apply(timeOrigin, performance, []) as number;
				const keys = objectKeys(state.meta);
				for (let i = 0; i < keys.length; i++) {
					const key = keys[i];
					let value = state.meta[key];
					if (key === 'captureTime' || key === 'receiveTime')
						value = (value as number) - origin;
					else if (key === 'contributingSources' || key === 'dependencies') {
						const list = value as number[];
						const copy = new RealmArray<number>();
						for (let at = 0; at < list.length; at++) copy[at] = list[at];
						value = copy;
					}
					out[key] = value;
				}
				return out;
			};
			for (const Class of [AudioFrame, VideoFrame]) {
				if (!Class) continue;
				const name =
					Class === AudioFrame
						? 'RTCEncodedAudioFrame'
						: 'RTCEncodedVideoFrame';
				const prototype = Class.prototype as object;
				hook(prototype, 'data', 'get', (that) => {
					const state = own(that);
					return state && { value: state.data };
				});
				hook(prototype, 'data', 'set', (that, args) => {
					const state = own(that);
					if (!state) return null;
					if (!isBuffer(args[0]))
						throw new RealmTypeError(
							`Failed to set the 'data' property on '${name}': Failed to convert value to 'ArrayBuffer'.`,
						);
					state.data = args[0] as ArrayBuffer;
					return { value: undefined };
				});
				hook(prototype, 'timestamp', 'get', (that) => {
					const state = own(that);
					return state && { value: state.meta.rtpTimestamp };
				});
				hook(prototype, 'type', 'get', (that) => {
					const state = own(that);
					return state && { value: state.type };
				});
				hook(prototype, 'getMetadata', 'value', (that) => {
					const state = own(that);
					return state && { value: metadata(state) };
				});
				hook(prototype, 'toString', 'value', (that) => {
					const state = own(that);
					if (!state) return null;
					const size = Reflect.apply(bufferLength, state.data, []) as number;
					return {
						value:
							Class === AudioFrame
								? `${name}{rtpTimestamp: ${state.meta.rtpTimestamp}, size: ${size}}`
								: `${name}{rtpTimestamp: ${state.meta.rtpTimestamp}, size: ${size} bytes, type: ${state.type}}`,
					};
				});
			}
		};
		Reflect.apply(listen, global, [
			'rtctransform',
			() => {
				if (installed) return;
				installed = true;
				try {
					install();
				} catch (error) {
					// a worker whose interfaces are not what Chrome's are
				}
			},
			true,
		]);
	}
}
