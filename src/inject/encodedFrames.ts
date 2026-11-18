import type { TransformFrame } from '../rtc/protocol';
import { OwnWeakMap, OwnWeakSet } from './ownCollections';

/**
 * The encoded frames of a proxied page's calls as a realm reads them (a
 * worker given an RTCRtpScriptTransform's frames, src/inject/worker/
 * modules/EncodedTransform.ts, or a document's createEncodedStreams(),
 * src/inject/dom/rtcStack.ts). The page's connections are STomp's, whose
 * frames the browser never makes: each comes from the document's WebRTC
 * worker on a port (TransformFrame, src/rtc/connection.ts) and is an
 * object of the realm's RTCEncodedAudioFrame or RTCEncodedVideoFrame
 * prototype here, whose members read as Chrome 157's. What Chrome does
 * with its own frames is done with these: copied by the classes'
 * constructors, cloned by structuredClone() and posted to another
 * context (a worker, a port), where they arrive as frames again; the
 * streams that carry them can be transferred too.
 *
 * Crossing to another context, a frame goes as a marker object with its
 * bytes and metadata, and a stream as a marker with a port it is pumped
 * through (as the browser itself pipes a transferred stream from the realm
 * it was made in); the message is wrapped in one more marker, which the
 * receiving realm's `MessageEvent.data` turns back. A realm that never had
 * a frame or one of these streams posts and clones as the browser does.
 */
export const FRAME_MARK = '$stomp$frame';

type WrapFunction = <T extends Function>(
	fn: T,
	wrap: (target: T, that: any, args: any[], newTarget?: any) => any,
	construct?: boolean,
) => T;

interface FrameState {
	kind: 'audio' | 'video';
	side: 'send' | 'receive';
	data: ArrayBuffer;
	/** getMetadata()'s answer, its captureTime and receiveTime in ms since 1970 */
	meta: Record<string, unknown>;
	type?: 'key' | 'delta';
	back: unknown;
}

export interface FrameRealm {
	/**
	 * A readable of the frames that come on `port` (TransformFrame) and a
	 * writable whose frames go back on it, as the realm's own streams
	 */
	streams(port: MessagePort): {
		readable: ReadableStream;
		writable: WritableStream;
	};
}

// getMetadata()'s members in Chrome 157's order
const AUDIO_KEYS = [
	'captureTime',
	'contributingSources',
	'mimeType',
	'payloadType',
	'receiveTime',
	'rtpTimestamp',
	'synchronizationSource',
	'audioLevel',
	'sequenceNumber',
];
const VIDEO_KEYS = [
	'contributingSources',
	'mimeType',
	'payloadType',
	'receiveTime',
	'rtpTimestamp',
	'synchronizationSource',
	'dependencies',
	'frameId',
	'height',
	'spatialIndex',
	'temporalIndex',
	'width',
];

/**
 * Installs the realm's frames: `global` is the realm's global object, as
 * the page sees it; `natives` its globals as they were before any page
 * script (the same object in a worker, whose inject runs first). Null where
 * the realm has no encoded frames.
 */
export function frameRealm(
	global: Record<string, any>,
	natives: Record<string, any>,
	wrapFunction: WrapFunction,
): FrameRealm | null {
	const AudioFrame = natives.RTCEncodedAudioFrame as Function | undefined;
	const VideoFrame = natives.RTCEncodedVideoFrame as Function | undefined;
	if (typeof AudioFrame !== 'function') return null;
	const NativeReadable = natives.ReadableStream as typeof ReadableStream;
	const NativeWritable = natives.WritableStream as typeof WritableStream;
	const NativeChannel = natives.MessageChannel as typeof MessageChannel;
	const NativePort = natives.MessagePort as typeof MessagePort;
	const RealmObject = natives.Object as ObjectConstructor;
	const RealmArray = natives.Array as ArrayConstructor;
	const RealmMap = natives.Map as MapConstructor;
	const RealmSet = natives.Set as SetConstructor;
	const RealmTypeError = natives.TypeError as TypeErrorConstructor;
	const RealmDOMException = natives.DOMException as typeof DOMException;
	const { apply, getOwnPropertyDescriptor: describe } = Reflect;
	const getter = (Class: Function | undefined, key: string) =>
		Class && describe(Class.prototype, key)?.get;
	const portPost = NativePort.prototype.postMessage;
	const portStart = NativePort.prototype.start;
	const portClose = NativePort.prototype.close;
	const listen = (natives.EventTarget as typeof EventTarget).prototype
		.addEventListener;
	const channelPort1 = getter(NativeChannel, 'port1')!;
	const channelPort2 = getter(NativeChannel, 'port2')!;
	const MessageEventClass = natives.MessageEvent as typeof MessageEvent;
	const eventData = getter(MessageEventClass, 'data')!;
	const bufferLength = getter(natives.ArrayBuffer, 'byteLength')!;
	const bufferSlice = (natives.ArrayBuffer as typeof ArrayBuffer).prototype
		.slice;
	const enqueue = (natives.ReadableStreamDefaultController as Function)
		.prototype.enqueue as Function;
	const closeController = (natives.ReadableStreamDefaultController as Function)
		.prototype.close as Function;
	const getReader = NativeReadable.prototype.getReader;
	const readerRead = (natives.ReadableStreamDefaultReader as Function).prototype
		.read as Function;
	const getWriter = NativeWritable.prototype.getWriter;
	const writerWrite = (natives.WritableStreamDefaultWriter as Function)
		.prototype.write as Function;
	const writerClose = (natives.WritableStreamDefaultWriter as Function)
		.prototype.close as Function;
	const promiseThen = (natives.Promise as PromiseConstructor).prototype.then;
	const isArray = RealmArray.isArray;
	const objectCreate = RealmObject.create;
	const objectFreeze = RealmObject.freeze;
	const ownKeys = RealmObject.keys;
	const hasOwn = RealmObject.prototype.hasOwnProperty;
	const objectTag = RealmObject.prototype.toString;
	const arraySlice = RealmArray.prototype.slice;
	const arrayIndexOf = RealmArray.prototype.indexOf;
	const arrayPush = RealmArray.prototype.push;
	const arraySplice = RealmArray.prototype.splice;
	const mapForEach = RealmMap.prototype.forEach;
	const mapSet = RealmMap.prototype.set;
	const setForEach = RealmSet.prototype.forEach;
	const setAdd = RealmSet.prototype.add;
	const setDelete = RealmSet.prototype.delete;
	const isMap = (value: object) => {
		try {
			apply(getter(RealmMap, 'size')!, value, []);
			return true;
		} catch (error) {
			return false;
		}
	};
	const isSet = (value: object) => {
		try {
			apply(getter(RealmSet, 'size')!, value, []);
			return true;
		} catch (error) {
			return false;
		}
	};
	const performance = natives.performance as Performance;
	const timeOrigin = getter(natives.Performance, 'timeOrigin')!;
	const origin = () => apply(timeOrigin, performance, []) as number;
	const isBuffer = (value: unknown) => {
		try {
			apply(bufferLength, value, []);
			return true;
		} catch (error) {
			return false;
		}
	};
	const copyBuffer = (buffer: ArrayBuffer) =>
		apply(bufferSlice, buffer, [0]) as ArrayBuffer;
	const post = (port: MessagePort, message: unknown, transfer: unknown[]) =>
		apply(portPost, port, [message, transfer]);
	const onMessage = (port: MessagePort, listener: (data: any) => void) => {
		apply(listen, port, [
			'message',
			(event: MessageEvent) => listener(apply(eventData, event, [])),
		]);
		apply(portStart, port, []);
	};
	const channel = (): [MessagePort, MessagePort] => {
		const made = new NativeChannel();
		return [apply(channelPort1, made, []), apply(channelPort2, made, [])];
	};

	const frames = new OwnWeakMap<object, FrameState>();
	/** the streams made here that carry frames */
	const ours = new OwnWeakMap<object, 'readable' | 'writable'>();
	/** a frame or a stream of these has been made: messages are looked through */
	let live = false;

	const make = (state: FrameState, prototype?: object): object => {
		const Class = state.kind === 'video' ? VideoFrame : AudioFrame;
		const made = apply(objectCreate, RealmObject, [
			prototype ?? Class!.prototype,
		]) as object;
		frames.set(made, state);
		live = true;
		return made;
	};
	/** a frame of the port's (or of another context's) */
	const frameOf = (message: TransformFrame & { side?: string }) => {
		if (
			!message ||
			(message.kind === 'video' ? !VideoFrame : message.kind !== 'audio') ||
			!isBuffer(message.data)
		)
			return null;
		return make({
			kind: message.kind,
			side:
				message.side === 'send' || message.side === 'receive'
					? message.side
					: 'receiveTime' in message.meta
						? 'receive'
						: 'send',
			data: message.data,
			meta: message.meta,
			type: message.type,
			back: message.back,
		});
	};
	/**
	 * A frame as another context or a copy gets it: its own bytes, and
	 * (Chrome 157) a received video frame without its receiveTime
	 */
	const copyOf = (state: FrameState): FrameState => {
		const meta = { ...state.meta };
		if (state.kind === 'video' && state.side === 'receive')
			delete meta.receiveTime;
		return { ...state, data: copyBuffer(state.data), meta };
	};

	// --- the streams ---

	const streams = (port: MessagePort) => {
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
				const data = copyBuffer(own.data);
				const message: TransformFrame = {
					kind: own.kind,
					data,
					meta: own.meta,
					back: own.back,
				};
				if (own.type) message.type = own.type;
				post(port, message, [data]);
			},
			close: () => apply(portClose, port, []),
		});
		onMessage(port, (message: TransformFrame) => {
			const made = frameOf(message);
			if (made && controller)
				try {
					apply(enqueue, controller, [made]);
				} catch (error) {
					// the page cancelled the readable
				}
		});
		ours.set(readable, 'readable');
		ours.set(writable, 'writable');
		live = true;
		return { readable, writable };
	};

	/**
	 * One of these streams the page transfers: pumped through a port of its
	 * own (the readable read here, its frames posted; what comes back
	 * written to the writable), the stream itself locked as a transferred
	 * one is. Its marker, which the other realm makes a stream again.
	 */
	const pump = (stream: object, kind: 'readable' | 'writable') => {
		const [here, there] = channel();
		if (kind === 'readable') {
			const reader = apply(getReader, stream, []) as object;
			const next = () =>
				apply(promiseThen, apply(readerRead, reader, []), [
					(result: { done: boolean; value: unknown }) => {
						if (result.done) {
							post(here, { [FRAME_MARK]: 'done' }, []);
							return;
						}
						const own =
							typeof result.value === 'object' && result.value !== null
								? frames.get(result.value)
								: undefined;
						if (own) {
							const sent = copyOf(own);
							post(here, { [FRAME_MARK]: 'frame', ...sent }, [sent.data]);
						}
						next();
					},
					() => post(here, { [FRAME_MARK]: 'done' }, []),
				]);
			next();
		} else {
			const writer = apply(getWriter, stream, []) as object;
			onMessage(here, (message) => {
				if (message?.[FRAME_MARK] === 'done')
					apply(promiseThen, apply(writerClose, writer, []), [
						undefined,
						() => {},
					]);
				else {
					const made = frameOf(message);
					if (made)
						apply(promiseThen, apply(writerWrite, writer, [made]), [
							undefined,
							() => {},
						]);
				}
			});
		}
		return { [FRAME_MARK]: kind, port: there };
	};
	/** a stream another realm transferred: the other end of its pump */
	const pumped = (kind: 'readable' | 'writable', port: MessagePort) => {
		let made: ReadableStream | WritableStream;
		if (kind === 'readable') {
			let controller: ReadableStreamDefaultController | null = null;
			made = new NativeReadable(
				{
					start: (started) => {
						controller = started;
					},
				},
				{ highWaterMark: 0 },
			);
			onMessage(port, (message) => {
				if (!controller) return;
				try {
					if (message?.[FRAME_MARK] === 'done')
						apply(closeController, controller, []);
					else {
						const frame = frameOf(message);
						if (frame) apply(enqueue, controller, [frame]);
					}
				} catch (error) {
					// cancelled
				}
			});
		} else
			made = new NativeWritable({
				write: (frame: unknown) => {
					const own =
						typeof frame === 'object' && frame !== null
							? frames.get(frame)
							: undefined;
					if (!own) return;
					const sent = copyOf(own);
					post(port, { [FRAME_MARK]: 'frame', ...sent }, [sent.data]);
				},
				close: () => post(port, { [FRAME_MARK]: 'done' }, []),
			});
		ours.set(made, kind);
		live = true;
		return made;
	};

	// --- crossing to another context ---

	/** an object structured clone looks into: an array, a Map, a Set or an ordinary object */
	const container = (value: object) =>
		isArray(value)
			? 'array'
			: isMap(value)
				? 'map'
				: isSet(value)
					? 'set'
					: apply(objectTag, value, []) === '[object Object]' &&
						  !frames.has(value)
						? 'object'
						: null;
	/** whether a message has a frame or a transferred stream of these in it */
	const carries = (value: unknown, transfer: unknown[]) => {
		const seen = new OwnWeakSet<object>();
		const visit = (value: unknown): boolean => {
			if (typeof value !== 'object' || value === null || seen.has(value))
				return false;
			seen.add(value);
			if (frames.has(value)) return true;
			if (ours.has(value) && apply(arrayIndexOf, transfer, [value]) >= 0)
				return true;
			let found = false;
			const kind = container(value);
			if (kind === 'array' || kind === 'object') {
				const keys = ownKeys(value);
				for (let i = 0; i < keys.length && !found; i++)
					found = visit((value as Record<string, unknown>)[keys[i]]);
			} else if (kind === 'map')
				apply(mapForEach, value, [
					(item: unknown, key: unknown) => {
						found ||= visit(key) || visit(item);
					},
				]);
			else if (kind === 'set')
				apply(setForEach, value, [
					(item: unknown) => {
						found ||= visit(item);
					},
				]);
			return found;
		};
		return visit(value);
	};
	/**
	 * The message as it is posted: a copy of its containers in which each
	 * frame is a marker with its bytes, and each stream of these that is
	 * transferred one with a port (taken from the transfer list, the port
	 * put on it), in the marker the other realm looks for
	 */
	const wrap = (message: unknown, transfer: unknown[]) => {
		const memo = new OwnWeakMap<object, unknown>();
		const added: unknown[] = [];
		const buffers: unknown[] = [];
		const visit = (value: unknown): unknown => {
			if (typeof value !== 'object' || value === null) return value;
			if (memo.has(value)) return memo.get(value);
			const frame = frames.get(value);
			if (frame) {
				const sent = copyOf(frame);
				const marker = { [FRAME_MARK]: 'frame', ...sent };
				apply(arrayPush, buffers, [sent.data]);
				memo.set(value, marker);
				return marker;
			}
			const stream = ours.get(value);
			const at = stream ? apply(arrayIndexOf, transfer, [value]) : -1;
			if (stream && at >= 0) {
				apply(arraySplice, transfer, [at, 1]);
				const marker = pump(value, stream);
				apply(arrayPush, added, [marker.port]);
				memo.set(value, marker);
				return marker;
			}
			const kind = container(value);
			if (kind === 'array' || kind === 'object') {
				const copy = (kind === 'array' ? new RealmArray() : {}) as Record<
					string,
					unknown
				>;
				memo.set(value, copy);
				if (kind === 'array') copy.length = (value as unknown[]).length;
				const keys = ownKeys(value);
				for (let i = 0; i < keys.length; i++)
					copy[keys[i]] = visit((value as Record<string, unknown>)[keys[i]]);
				return copy;
			}
			if (kind === 'map') {
				const copy = new RealmMap();
				memo.set(value, copy);
				apply(mapForEach, value, [
					(item: unknown, key: unknown) =>
						apply(mapSet, copy, [visit(key), visit(item)]),
				]);
				return copy;
			}
			if (kind === 'set') {
				const copy = new RealmSet();
				memo.set(value, copy);
				apply(setForEach, value, [
					(item: unknown) => apply(setAdd, copy, [visit(item)]),
				]);
				return copy;
			}
			return value;
		};
		const wrapped = {
			[FRAME_MARK]: 'message',
			message: visit(message),
			ports: added.length,
		};
		for (let i = 0; i < added.length; i++)
			apply(arrayPush, transfer, [added[i]]);
		// (a frame's bytes are its own copy: moved, not copied again)
		for (let i = 0; i < buffers.length; i++)
			apply(arrayPush, transfer, [buffers[i]]);
		return wrapped;
	};
	const marked = (value: unknown, kind: string) =>
		typeof value === 'object' &&
		value !== null &&
		apply(hasOwn, value, [FRAME_MARK]) &&
		(value as Record<string, unknown>)[FRAME_MARK] === kind;
	/** a wrapped message as it arrived, its markers frames and streams again (it is the clone's: changed in place) */
	const unwrap = (wrapped: Record<string, unknown>) => {
		const seen = new OwnWeakSet<object>();
		// (a frame or a stream the message has twice is one object twice)
		const made = new OwnWeakMap<object, unknown>();
		const revive = (value: unknown): unknown => {
			if (typeof value !== 'object' || value === null) return value;
			const record = value as Record<string, any>;
			if (apply(hasOwn, value, [FRAME_MARK])) {
				if (made.has(value)) return made.get(value);
				const kind = record[FRAME_MARK];
				let revived: unknown = value;
				if (kind === 'frame') revived = frameOf(record as TransformFrame);
				else if ((kind === 'readable' || kind === 'writable') && record.port)
					revived = pumped(kind, record.port);
				if (revived !== value) {
					made.set(value, revived);
					return revived;
				}
			}
			if (seen.has(value)) return value;
			seen.add(value);
			const kind = container(value);
			if (kind === 'array' || kind === 'object') {
				const keys = ownKeys(value);
				for (let i = 0; i < keys.length; i++)
					record[keys[i]] = revive(record[keys[i]]);
			} else if (kind === 'map') {
				const entries: unknown[][] = [];
				apply(mapForEach, value, [
					(item: unknown, key: unknown) =>
						apply(arrayPush, entries, [[key, item]]),
				]);
				for (const [key, item] of entries) {
					const revived = revive(key);
					if (revived !== key) (value as Map<unknown, unknown>).delete(key);
					apply(mapSet, value, [revived, revive(item)]);
				}
			} else if (kind === 'set') {
				const items: unknown[] = [];
				apply(setForEach, value, [
					(item: unknown) => apply(arrayPush, items, [item]),
				]);
				for (const item of items) {
					const revived = revive(item);
					if (revived !== item) {
						apply(setDelete, value, [item]);
						apply(setAdd, value, [revived]);
					}
				}
			}
			return value;
		};
		return revive(wrapped.message);
	};

	/** postMessage(message, transfer | { transfer }), as the page called it, made ready to post */
	const posting = (args: unknown[], at: number) => {
		if (!live || args.length <= at) return args;
		const options = args[at + 1];
		let transfer: unknown[] = [];
		let viaOptions = false;
		if (isArray(options)) transfer = apply(arraySlice, options, []);
		else if (typeof options === 'object' && options !== null) {
			const given = (options as { transfer?: unknown }).transfer;
			if (isArray(given)) {
				transfer = apply(arraySlice, given, []);
				viaOptions = true;
			}
		}
		if (!carries(args[at], transfer)) return args;
		const message = wrap(args[at], transfer);
		const out = apply(arraySlice, args, []) as unknown[];
		out[at] = message;
		out[at + 1] = viaOptions ? { ...(options as object), transfer } : transfer;
		return out;
	};
	// (a worker's global has its postMessage itself: the members of a
	// global's interface are the global's own)
	const scope = natives.DedicatedWorkerGlobalScope as Function | undefined;
	for (const [prototype, at] of [
		[(natives.MessagePort as Function | undefined)?.prototype, 0],
		[(natives.Worker as Function | undefined)?.prototype, 0],
		[scope && global instanceof scope ? global : undefined, 0],
	] as const) {
		const descriptor = prototype && describe(prototype, 'postMessage');
		if (!prototype || typeof descriptor?.value !== 'function') continue;
		descriptor.value = wrapFunction(
			descriptor.value as Function,
			(target, that, args) => apply(target, that, posting(args, at)),
		);
		Reflect.defineProperty(prototype, 'postMessage', descriptor);
	}
	// structuredClone where the global has it (its own, or a prototype's in
	// a worker), over what is there (the document's other hooks)
	let cloneOwner: object | null = global;
	while (cloneOwner && !describe(cloneOwner, 'structuredClone'))
		cloneOwner = Reflect.getPrototypeOf(cloneOwner);
	const cloneDescriptor = cloneOwner && describe(cloneOwner, 'structuredClone');
	if (
		cloneOwner &&
		cloneDescriptor &&
		typeof cloneDescriptor.value === 'function'
	) {
		cloneDescriptor.value = wrapFunction(
			cloneDescriptor.value as Function,
			(target, that, args) => {
				const given = posting(args, 0);
				const cloned = apply(target, that, given);
				return given === args
					? cloned
					: unwrap(cloned as Record<string, unknown>);
			},
		);
		Reflect.defineProperty(cloneOwner, 'structuredClone', cloneDescriptor);
	}

	// a message's data and ports, the wrapping undone
	const received = new OwnWeakMap<object, { data: unknown; ports: number }>();
	const arrival = (event: unknown, data: unknown) => {
		// (the browser's delivery: a page's own event with such data is its data)
		if (
			!marked(data, 'message') ||
			typeof event !== 'object' ||
			!event ||
			(event as Event).isTrusted !== true
		)
			return null;
		let known = received.get(event);
		if (!known) {
			known = {
				data: unwrap(data as Record<string, unknown>),
				ports: Number((data as Record<string, unknown>).ports) || 0,
			};
			received.set(event, known);
		}
		return known;
	};
	const dataDescriptor = describe(MessageEventClass.prototype, 'data')!;
	dataDescriptor.get = wrapFunction(
		dataDescriptor.get!,
		(target, that, args) => {
			const data = apply(target, that, args);
			const known = arrival(that, data);
			return known ? known.data : data;
		},
	);
	Reflect.defineProperty(MessageEventClass.prototype, 'data', dataDescriptor);
	const portsDescriptor = describe(MessageEventClass.prototype, 'ports');
	if (portsDescriptor?.get) {
		const portsOf = new OwnWeakMap<object, unknown>();
		portsDescriptor.get = wrapFunction(
			portsDescriptor.get,
			(target, that, args) => {
				const ports = apply(target, that, args) as unknown[];
				const known = arrival(that, apply(eventData, that, []));
				if (!known?.ports) return ports;
				let kept = portsOf.get(that);
				if (!kept) {
					kept = apply(objectFreeze, RealmObject, [
						apply(arraySlice, ports, [0, ports.length - known.ports]),
					]);
					portsOf.set(that, kept);
				}
				return kept;
			},
		);
		Reflect.defineProperty(
			MessageEventClass.prototype,
			'ports',
			portsDescriptor,
		);
	}

	// --- the frames' members ---

	const hook = (
		prototype: object,
		key: string,
		part: 'get' | 'set' | 'value',
		run: (
			that: unknown,
			args: unknown[],
		) => { value: unknown } | null | undefined,
	) => {
		const descriptor = describe(prototype, key);
		const native = descriptor?.[part];
		if (!descriptor || typeof native !== 'function') return;
		descriptor[part] = wrapFunction(
			native as Function,
			(target, that, args) => {
				const own = run(that, args);
				return own ? own.value : apply(target, that, args);
			},
		);
		Reflect.defineProperty(prototype, key, descriptor);
	};
	const own = (that: unknown) =>
		typeof that === 'object' && that !== null ? frames.get(that) : undefined;
	/** getMetadata()'s answer: a new object each time, its times on this realm's clock */
	const metadata = (state: FrameState) => {
		const out = new RealmObject() as Record<string, unknown>;
		const at = origin();
		const keys = ownKeys(state.meta);
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			let value = state.meta[key];
			if (key === 'captureTime' || key === 'receiveTime')
				value = (value as number) - at;
			else if (key === 'contributingSources' || key === 'dependencies') {
				const list = value as number[];
				const copy = new RealmArray<number>();
				for (let n = 0; n < list.length; n++) copy[n] = list[n];
				value = copy;
			}
			out[key] = value;
		}
		return out;
	};

	/**
	 * A copy's metadata, `given` read as Chrome 157 reads its dictionary
	 * and checked as it checks it: what a copy may change (a sent sound's
	 * payload type, capture time and level, any frame's RTP time and a
	 * received sound's level, a picture's id and dependencies) is changed,
	 * anything else that differs is refused with Chrome's words
	 */
	const modified = (state: FrameState, given: unknown, name: string) => {
		const audio = state.kind === 'audio';
		const keys = audio ? AUDIO_KEYS : VIDEO_KEYS;
		const read: Record<string, unknown> = {};
		const dictionary = given as Record<string, unknown>;
		// (a dictionary's members are read in their names' order)
		const sorted = [...keys, 'senderCaptureTimeOffset'].sort();
		for (const key of sorted) {
			const value = dictionary[key];
			if (value === undefined) continue;
			read[key] = isArray(value)
				? [...(value as unknown[])].map(Number)
				: key === 'mimeType'
					? String(value)
					: Number(value);
		}
		const at = origin();
		const base = state.meta;
		const has = (key: string) => key in read;
		const equal = (key: string) => {
			if (has(key) !== key in base) return false;
			if (!has(key)) return true;
			const a = read[key];
			const b = base[key];
			if (key === 'receiveTime' || key === 'captureTime')
				return Math.abs((a as number) + at - (b as number)) < 0.001;
			return isArray(a)
				? (a as number[]).length === (b as number[]).length &&
						(a as number[]).every((item, i) => item === (b as number[])[i])
				: a === b;
		};
		const refuse = (message: string) =>
			new RealmDOMException(
				`Failed to construct '${name}': Cannot create a new ${audio ? 'Audio' : 'Video'}Frame: ${message}`,
				'InvalidModificationError',
			);
		const out: Record<string, unknown> = { ...base };
		if (audio) {
			for (const key of [
				'synchronizationSource',
				'contributingSources',
				'sequenceNumber',
				'receiveTime',
				'senderCaptureTimeOffset',
			])
				if (!equal(key))
					throw refuse(
						`Invalid modification of RTCEncodedAudioFrameMetadata. Bad ${key}`,
					);
			if (state.side === 'receive') {
				if (has('payloadType') && !equal('payloadType'))
					throw refuse('payloadType cannot be modified');
				if (has('captureTime') && !equal('captureTime'))
					throw refuse('captureTime cannot be modified');
			} else {
				if (has('payloadType')) out.payloadType = read.payloadType;
				if (has('captureTime'))
					out.captureTime = (read.captureTime as number) + at;
			}
			if (has('audioLevel')) {
				// as the RTP extension carries it: whole dB below full scale
				const level = Math.min(
					127,
					Math.max(0, Math.round(-20 * Math.log10(read.audioLevel as number))),
				);
				out.audioLevel = level >= 127 ? 0 : 10 ** (-level / 20);
			}
		} else {
			for (const key of [
				'contributingSources',
				'height',
				'payloadType',
				'rtpTimestamp',
				'spatialIndex',
				'synchronizationSource',
				'temporalIndex',
				'width',
			])
				if (key in base && !has(key))
					throw refuse('new metadata has member(s) missing.');
			if (!has('frameId') && has('dependencies'))
				throw refuse('new metadata has frameID missing, but has dependencies');
			if (has('dependencies')) {
				const id = read.frameId as number;
				const deps = read.dependencies as number[];
				if (deps.length > 8 || deps.some((dep) => !(dep >= 0 && dep < id)))
					throw refuse('new metadata has invalid frame dependencies.');
			}
			if (!equal('payloadType'))
				throw refuse(
					'invalid modification of payloadType in RTCEncodedVideoFrameMetadata.',
				);
			for (const key of [
				'synchronizationSource',
				'contributingSources',
				'width',
				'height',
				'spatialIndex',
				'temporalIndex',
			])
				if (!equal(key))
					throw refuse('invalid modification of RTCEncodedVideoFrameMetadata.');
			if (has('frameId')) out.frameId = read.frameId;
			if (has('dependencies')) out.dependencies = read.dependencies;
		}
		if (has('rtpTimestamp'))
			out.rtpTimestamp = (read.rtpTimestamp as number) >>> 0;
		// in Chrome's order
		const ordered: Record<string, unknown> = {};
		for (const key of keys) if (key in out) ordered[key] = out[key];
		return ordered;
	};

	for (const Class of [AudioFrame, VideoFrame]) {
		if (!Class) continue;
		const audio = Class === AudioFrame;
		const name = audio ? 'RTCEncodedAudioFrame' : 'RTCEncodedVideoFrame';
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
			const size = apply(bufferLength, state.data, []) as number;
			return {
				value: audio
					? `${name}{rtpTimestamp: ${state.meta.rtpTimestamp}, size: ${size}}`
					: `${name}{rtpTimestamp: ${state.meta.rtpTimestamp}, size: ${size} bytes, type: ${state.type}}`,
			};
		});
		// new RTCEncodedAudioFrame(frame, { metadata }): a copy of one of
		// these (the browser's own for any other argument)
		const constructor = wrapFunction(
			Class,
			(target, that, args, newTarget) => {
				const state = own(args[0]);
				if (!state || state.kind !== (audio ? 'audio' : 'video'))
					return Reflect.construct(target, args, newTarget);
				const options = args[1];
				if (
					options !== undefined &&
					options !== null &&
					typeof options !== 'object' &&
					typeof options !== 'function'
				)
					return Reflect.construct(target, args, newTarget);
				const given = (options as { metadata?: unknown } | null | undefined)
					?.metadata;
				const copy = copyOf(state);
				if (given !== undefined && given !== null)
					copy.meta = modified(copy, given, name);
				let prototype = newTarget?.prototype;
				if (typeof prototype !== 'object' || prototype === null)
					prototype = Class.prototype;
				return make(copy, prototype as object);
			},
			true,
		);
		if (global[name] === Class) global[name] = constructor;
	}

	return { streams };
}
