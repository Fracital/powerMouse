import { TRANSFORM_KEY } from '../../../rtc/protocol';
import { frameRealm, type FrameRealm } from '../../encodedFrames';
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
 * RTCEncodedAudioFrame and RTCEncodedVideoFrame objects and what the page
 * writes to its `writable` goes back on the port to be sent or decoded
 * (src/inject/encodedFrames.ts, which also lets the frames be copied,
 * cloned and posted on as Chrome's are). A transformer without the port
 * (a transform the inject did not make) is the browser's.
 */
export default class EncodedTransformModule extends Module<WorkerClient> {
	apply() {
		const global = this.client.global as unknown as Record<string, any>;
		// a dedicated worker: the one kind a transform's frames reach, given
		// or posted to it
		if (!('onrtctransform' in global)) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const Transformer = global.RTCRtpScriptTransformer as Function | undefined;
		const NativePort = global.MessagePort as typeof MessagePort;
		const nativeOptions =
			typeof Transformer === 'function'
				? Reflect.getOwnPropertyDescriptor(Transformer.prototype, 'options')
						?.get
				: undefined;
		let realm: FrameRealm | null = null;
		try {
			realm = frameRealm(global, global, (fn, wrap, construct) =>
				proxyModule.wrapFunction(fn, wrap, construct),
			);
		} catch (error) {
			// a worker whose interfaces are not what Chrome's are
		}
		if (!realm || !Transformer || !nativeOptions) return;
		const frames = realm;

		interface TransformerState {
			options: unknown;
			readable: ReadableStream;
			writable: WritableStream;
		}
		const transformers = new OwnWeakMap<object, TransformerState | null>();
		/** the transformer's state: made the first time a page reads it, null when it is the browser's */
		const stateOf = (transformer: unknown): TransformerState | null => {
			if (typeof transformer !== 'object' || transformer === null) return null;
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
			const state: TransformerState = {
				options: (options as Record<string, unknown>).options,
				...frames.streams(port),
			};
			transformers.set(transformer, state);
			return state;
		};
		for (const key of ['options', 'readable', 'writable'] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				Transformer.prototype,
				key,
			);
			if (typeof descriptor?.get !== 'function') continue;
			descriptor.get = proxyModule.wrapFunction(
				descriptor.get,
				(target, that, args) => {
					const state = stateOf(that);
					return state ? state[key] : Reflect.apply(target, that, args);
				},
			);
			Reflect.defineProperty(Transformer.prototype, key, descriptor);
		}
	}
}
