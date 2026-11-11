import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';
import CanvasTaintModule from './CanvasTaint';

type Method = (this: unknown, ...args: unknown[]) => unknown;

/**
 * What leaves a canvas or a media element as a stream or as sound. Every
 * route is same-origin to the browser, so it captures a tainted canvas, a
 * video of another site, and lets Web Audio hear another site's sound. The
 * browser's rule, applied to the real origins (CanvasTaint's verdicts):
 *
 * - `captureStream` of a tainted canvas, or of a media element that plays
 *   another origin's data not loaded with CORS, is the browser's
 *   SecurityError. A stream captured earlier ends when its canvas is tainted
 *   or its element loads such data (Chrome keeps a canvas's track live and
 *   sends it no more frames; here it ends): every track that carries the
 *   source, so its clones too.
 * - A MediaElementAudioSourceNode of such an element is silent. A gain node
 *   the page cannot reach sits between the source node and what the page
 *   connected it to, and the source is connected to it only while the
 *   element plays data the page may read.
 *
 * While an element loads, what it will play is not known (its own URL can
 * redirect to another site): from `loadstart` until the load's metadata is
 * in and judged, its captured tracks are disabled and its sound is off,
 * where natively there is nothing to carry either.
 */
export default class MediaTaintModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const canvasTaint = this.client.getModule(CanvasTaintModule);
		const mediaProto = global.HTMLMediaElement?.prototype;
		const trackProto = global.MediaStreamTrack?.prototype;
		const streamProto = global.MediaStream?.prototype;
		if (!canvasTaint || !mediaProto || !trackProto || !streamProto) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const shared = this.client.canvasTaints;
		const taints = (source: unknown) => canvasTaint.taints(source);
		const securityError = (message: string) =>
			new global.DOMException(message, 'SecurityError');
		const getter = (proto: object, name: string) =>
			Reflect.getOwnPropertyDescriptor(proto, name)!.get as Method;
		const call = (method: Method, that: unknown, ...args: unknown[]) =>
			Reflect.apply(method, that, args);

		const getTracks = streamProto.getTracks as Method;
		const stop = trackProto.stop as Method;
		const enabled = Reflect.getOwnPropertyDescriptor(trackProto, 'enabled')!;
		shared.stopTrack ??= (track) => {
			try {
				call(stop, track);
			} catch (error) {
				// not a track any more
			}
		};
		/** `tracks` carry what `source` (a canvas, a media element) shows */
		const derive = (source: object, tracks: object[]) => {
			let all = shared.sourceTracks.get(source);
			if (!all) shared.sourceTracks.set(source, (all = new Set()));
			for (const track of tracks) {
				all.add(track);
				shared.trackSources.set(track, source);
			}
		};
		const end = (source: object) => {
			const tracks = shared.sourceTracks.get(source);
			if (tracks) for (const track of tracks) shared.stopTrack!(track);
		};
		// a clone carries what its original does
		trackProto.clone = proxyModule.wrapFunction(
			trackProto.clone,
			(target, that, args) => {
				const clone = Reflect.apply(target, that, args);
				const source = shared.trackSources.get(that as object);
				if (source) derive(source, [clone]);
				return clone;
			},
		);
		streamProto.clone = proxyModule.wrapFunction(
			streamProto.clone,
			(target, that, args) => {
				const clone = Reflect.apply(target, that, args);
				// a stream's clone holds a clone of each track, in its order
				const from = call(getTracks, that) as object[];
				const to = call(getTracks, clone) as object[];
				for (let i = 0; i < from.length && i < to.length; i++) {
					const source = shared.trackSources.get(from[i]);
					if (source) derive(source, [to[i]]);
				}
				return clone;
			},
		);

		// the tracks the inject disabled while their element loads, and what
		// the page set them to: the page reads and writes its own value
		const held = new WeakMap<object, boolean>();
		Reflect.defineProperty(trackProto, 'enabled', {
			...enabled,
			get: proxyModule.wrapFunction(enabled.get!, (target, that, args) => {
				const value = Reflect.apply(target, that, args);
				const own = held.get(that as object);
				return own === undefined ? value : own;
			}),
			set: proxyModule.wrapFunction(enabled.set!, (target, that, args) => {
				if (!held.has(that as object)) return Reflect.apply(target, that, args);
				// validated and converted as natively, and kept off
				const before = Reflect.apply(enabled.get!, that as object, []);
				Reflect.apply(target, that, args);
				held.set(
					that as object,
					Reflect.apply(enabled.get!, that as object, []) as boolean,
				);
				Reflect.apply(target, that, [before]);
				return undefined;
			}),
		});

		const canvasProto = global.HTMLCanvasElement?.prototype;
		if (canvasProto && typeof canvasProto.captureStream === 'function')
			canvasProto.captureStream = proxyModule.wrapFunction(
				canvasProto.captureStream,
				(target, that, args) => {
					if (
						that !== null &&
						typeof that === 'object' &&
						shared.canvases.has(that)
					)
						throw securityError(
							"Failed to execute 'captureStream' on 'HTMLCanvasElement': Canvas is not origin-clean.",
						);
					const stream = Reflect.apply(target, that, args);
					derive(that as object, call(getTracks, stream) as object[]);
					return stream;
				},
			);

		// --- media elements ---------------------------------------------------
		const readyState = getter(mediaProto, 'readyState');
		/** per element: its captured streams and its source nodes' gates */
		const followed = new WeakMap<
			object,
			{ streams: Set<object>; gates: Set<object> }
		>();
		/** lets a source node's sound through its gate, or not (set with Web Audio's hooks) */
		const gating: { set?: (gate: object, open: boolean) => void } = {};
		/** nothing of the element flows until its load is judged */
		const close = (element: object) => {
			const state = followed.get(element)!;
			for (const gate of state.gates) gating.set!(gate, false);
			for (const track of shared.sourceTracks.get(element) ?? [])
				if (!held.has(track)) {
					held.set(track, Reflect.apply(enabled.get!, track, []) as boolean);
					Reflect.apply(enabled.set!, track, [false]);
				}
		};
		/** the element has a load's data: its own flows on, another origin's does not */
		const settle = (element: object) => {
			const state = followed.get(element)!;
			// the browser gave the streams the new load's tracks
			for (const stream of state.streams)
				derive(element, call(getTracks, stream) as object[]);
			if ((call(readyState, element) as number) < 1) return;
			const tainted = taints(element);
			for (const gate of state.gates) gating.set!(gate, !tainted);
			if (tainted) return end(element);
			for (const track of shared.sourceTracks.get(element) ?? []) {
				const own = held.get(track);
				if (own === undefined) continue;
				held.delete(track);
				Reflect.apply(enabled.set!, track, [own]);
			}
		};
		const follow = (element: object) => {
			let state = followed.get(element);
			if (state) return state;
			followed.set(element, (state = { streams: new Set(), gates: new Set() }));
			canvasTaint.watch(element, ['loadstart', 'emptied'], () =>
				close(element),
			);
			canvasTaint.watch(
				element,
				['loadedmetadata', 'loadeddata', 'canplay', 'playing'],
				() => settle(element),
			);
			return state;
		};
		const isMedia = (value: unknown): value is object => {
			if (value === null || typeof value !== 'object') return false;
			try {
				call(readyState, value);
				return true;
			} catch (error) {
				return false;
			}
		};
		const capturing = mediaProto as unknown as { captureStream?: Method };
		if (typeof capturing.captureStream === 'function')
			capturing.captureStream = proxyModule.wrapFunction(
				capturing.captureStream,
				(target, that, args) => {
					if (!isMedia(that)) return Reflect.apply(target, that, args);
					if (taints(that))
						throw securityError(
							"Failed to execute 'captureStream' on 'HTMLMediaElement': Cannot capture from element with cross-origin data",
						);
					const stream = Reflect.apply(target, that, args);
					// (after the native call: the browser's own listener, which
					// gives the stream a new load's tracks, runs before this one)
					follow(that).streams.add(stream as object);
					settle(that);
					return stream;
				},
			);

		// --- Web Audio --------------------------------------------------------
		const AudioContext = global.AudioContext;
		const nodeProto = global.AudioNode?.prototype;
		const NativeSource = global.MediaElementAudioSourceNode;
		if (!AudioContext || !nodeProto || !NativeSource) return;
		const connect = nodeProto.connect as Method;
		const disconnect = nodeProto.disconnect as Method;
		const context = getter(nodeProto, 'context');
		const createGain = global.BaseAudioContext.prototype.createGain as Method;
		const mediaElement = getter(NativeSource.prototype, 'mediaElement');
		// (the gate is a gain node left at 1, open while the source node is
		// connected to it: the GainNode and AudioParam interfaces cost a frame
		// heap, and are not made for a page that has no such source)
		const sources = new WeakMap<object, { node: object; open: boolean }>();
		gating.set = (gate, open) => {
			const source = sources.get(gate)!;
			if (source.open === open) return;
			source.open = open;
			call(open ? connect : disconnect, source.node, gate);
		};
		/** a source node of a media element: gated from its first connection on */
		const adopt = (node: object) => {
			const element = call(mediaElement, node) as object;
			const gate = call(createGain, call(context, node)) as object;
			sources.set(gate, { node, open: false });
			shared.gates.set(node, gate);
			follow(element).gates.add(gate);
			settle(element);
		};
		AudioContext.prototype.createMediaElementSource = proxyModule.wrapFunction(
			AudioContext.prototype.createMediaElementSource,
			(target, that, args) => {
				const node = Reflect.apply(target, that, args);
				adopt(node);
				return node;
			},
		);
		global.MediaElementAudioSourceNode = proxyModule.wrapFunction(
			NativeSource,
			(target, that, args, newTarget) => {
				if (!newTarget) return Reflect.apply(target, that, args);
				const node = Reflect.construct(target, args, newTarget);
				adopt(node);
				return node;
			},
			true,
		);
		// what the page connects a gated source to is connected to its gate
		for (const name of ['connect', 'disconnect'] as const)
			nodeProto[name] = proxyModule.wrapFunction(
				nodeProto[name] as Method,
				(target, that, args) => {
					const gate =
						that !== null && typeof that === 'object'
							? shared.gates.get(that)
							: undefined;
					return Reflect.apply(target, gate ?? that, args);
				},
			) as never;
	}
}
