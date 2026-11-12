import type {
	ChannelOptions,
	CodecCapability,
	CodecStats,
	ConnectionConfig,
	Direction,
	MediaSection,
	MediaStats,
	Negotiated,
	Reply,
	Request,
	RtcWorkerConnection,
	RtcWorkerInit,
	RtcWorkerTemplate,
	StatsReply,
	Unsequenced,
	WorkerEvent,
	WorkerMessage,
} from '../../rtc/protocol';
import { isReply } from '../../rtc/protocol';
import {
	candidateLine,
	channelChecked,
	channelInit,
	codecList,
	codecPreferences,
	configuration,
	parseDescription,
	Refusal,
	remoteRefusal,
	serversRefusal,
	type Configuration,
	type Description as Parsed,
} from '../rtcValidation';
import type { RtcContext } from './rtcLazy';

/*
 * WebRTC over wisp (docs/webrtc-over-wisp.md). The browser's own
 * RTCPeerConnection sends its packets itself, from the user's address, to
 * whatever a page names; through the proxy that is a leak, so a page never
 * gets it. RTCPeerConnection and RTCDataChannel here are classes of STomp's
 * own that read as native: every method is a message to the document's
 * WebRTC worker (src/rtc/worker.ts), which runs the stack (str0m in wasm)
 * over wisp UDP and TCP streams, and every event is a message back. The
 * worker is started the first time a document constructs a connection, and
 * the stack's module is fetched then, so a document that never does costs
 * nothing more than these classes.
 *
 * The native constructor is kept for what sends nothing: validating a
 * configuration (Chrome's own errors and its normalised getConfiguration
 * shape, from an instance closed at once, with no candidate pool so it
 * gathers nothing), its own words for a description the stack refuses
 * (from an instance that never gets a local description, so never a socket)
 * and generateCertificate. RTCIceCandidate and RTCSessionDescription stay
 * native: they parse and hold text.
 *
 * Media (section 16 of the document): a transceiver, its sender and its
 * receiver are objects of STomp's own on the browser's own prototypes,
 * whose members answer for them and are the browser's for anything else.
 * A track the page sends is read through a MediaStreamTrackProcessor whose
 * stream goes to the worker; a track the page receives is a
 * MediaStreamTrackGenerator's, which the worker writes and the page reads
 * as the remote track Chrome would have made (its prototype, id, label
 * and muted state).
 *
 * The browser checks what an object is, not which document's prototype a
 * member came from: another document's addIceCandidate works on this
 * document's connection. Documents that can reach each other (a frame and
 * its parent, a popup and its opener) therefore share one set of tables
 * from each object to its own document's implementation, and every member
 * a page calls looks its object up there.
 */

// taken before any hook or page script, by the inject module (modules/WebRTC.ts)
let objectCreate: typeof Object.create;
let mapEntries: typeof Map.prototype.entries;
let mapNext: () => IteratorResult<[string, unknown]>;

/** a class's members as the document that made an object implements them */
type Members = Record<PropertyKey, PropertyDescriptor | undefined>;
interface Shared {
	peers: WeakMap<object, Members>;
	channels: WeakMap<object, Members>;
	channelEvents: WeakMap<object, Members>;
	reports: WeakMap<object, Members>;
	/** every connection made and not yet collected, a closed one included */
	made: WeakRef<object>[];
	transceivers: WeakMap<object, Members>;
	senders: WeakMap<object, Members>;
	receivers: WeakMap<object, Members>;
	trackEvents: WeakMap<object, Members>;
	/** pc.sctp, its RTCDtlsTransport and their RTCIceTransport */
	transports: WeakMap<object, Members>;
	dtmf: WeakMap<object, Members>;
	/** a received track as the page reads it: Chrome's id, label and muted state for one */
	tracks: WeakMap<object, { id?: string; label: string; muted: boolean }>;
	/** the id of a stream a peer named */
	streams: WeakMap<object, string>;
}
// an about:blank child (a frame, a popup) runs its creator's bundle: its
// worker when the child has no controller
let bundleWorker: (() => Worker) | null = null;

const MAX_MESSAGE_SIZE = 262144;
/** Chrome numbers a renderer's channels as they are made: their stats ids */
let channelSerial = 0;
/** and the tracks its senders are given, as they are given them: their media-source ids */
let sourceSerial = 0;
/** Blink's: a tone's default length and gap, and the pause a ',' is, in ms */
const DTMF_DURATION = 100;
const DTMF_GAP = 70;
const DTMF_COMMA_MS = 2000;
/** Chrome's: connections a renderer holds at once, closed ones until collected */
const MAX_CONNECTIONS = 500;
let weakDeref: typeof WeakRef.prototype.deref;

type Description = { type: RTCSdpType; sdp: string };

const method = (name: string, what: string) =>
	`Failed to execute '${name}' on 'RTCPeerConnection': ${what}`;

export default class WebRTCStack {
	install(ctx: RtcContext) {
		const client = ctx.client;
		objectCreate = ctx.captures.objectCreate;
		mapEntries = ctx.captures.mapEntries;
		mapNext = ctx.captures.mapNext;
		weakDeref = ctx.captures.weakDeref;
		const withStack = ctx.withStack;
		// taken when the document started (RtcContext.realm): this library
		// runs on the first use, when the page may have replaced them
		const global = ctx.realm as typeof globalThis & Record<string, any>;
		// The WebRTC and media interfaces are read now, from the document:
		// the browser makes an interface's objects the first time it is
		// named, and taking these when every document starts would make
		// them in every frame
		const live = client.global as unknown as typeof globalThis &
			Record<string, any>;
		const { captures } = ctx;
		// the browser's, taken before the page runs: a page that hooks
		// them never sees ours
		const { portPost, workerPost } = captures;
		const { privateChannel, onPort, closePort } = ctx.ports;
		const NativePeerConnection = ctx.natives
			.RTCPeerConnection as unknown as typeof RTCPeerConnection;
		const proxyModule = ctx.proxyModule;
		const workerModule = ctx.workerModule;
		const RealmEventTarget = global.EventTarget as typeof EventTarget;
		const RealmEvent = global.Event as typeof Event;
		const RealmPromise = global.Promise as PromiseConstructor;
		const RealmDOMException = global.DOMException as typeof DOMException;
		const RealmTypeError = global.TypeError as TypeErrorConstructor;
		const RealmArray = global.Array as ArrayConstructor;
		const addListener = captures.addListener;
		const removeListener = captures.removeListener;
		const RealmMessageEvent = global.MessageEvent as typeof MessageEvent;
		const RealmBlob = global.Blob as typeof Blob;
		const NativeIceCandidate = live.RTCIceCandidate as typeof RTCIceCandidate;
		const NativeSessionDescription =
			live.RTCSessionDescription as typeof RTCSessionDescription;
		const NativeIceEvent =
			live.RTCPeerConnectionIceEvent as typeof RTCPeerConnectionIceEvent;
		const NativeIceErrorEvent =
			live.RTCPeerConnectionIceErrorEvent as typeof RTCPeerConnectionIceErrorEvent;
		const NativeDataChannel = ctx.natives
			.RTCDataChannel as unknown as typeof RTCDataChannel;
		const NativeDataChannelEvent = ctx.natives
			.RTCDataChannelEvent as unknown as typeof RTCDataChannelEvent;
		const NativeStatsReport = ctx.natives
			.RTCStatsReport as unknown as typeof RTCStatsReport;
		const NativeError = live.RTCError as typeof RTCError;
		const NativeErrorEvent = live.RTCErrorEvent as typeof RTCErrorEvent;
		const RealmWeakRef = global.WeakRef as WeakRefConstructor;
		const realmClone = global.structuredClone as typeof structuredClone;

		// a candidate the connection gathered tells the server it came from;
		// one a page makes has none to tell, as the browser's
		const candidateOrigins = new WeakMap<
			object,
			{ url: string; relayProtocol: string | null }
		>();
		for (const key of ['url', 'relayProtocol'] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				NativeIceCandidate.prototype,
				key,
			);
			if (!descriptor?.get) continue;
			descriptor.get = proxyModule.wrapFunction(
				descriptor.get,
				(target, that, args) => {
					const own = candidateOrigins.get(that);
					return own ? own[key] : Reflect.apply(target, that, args);
				},
			);
			Reflect.defineProperty(NativeIceCandidate.prototype, key, descriptor);
		}

		const domException = (message: string, name: string) =>
			withStack(new RealmDOMException(message, name));
		const rejected = (message: string, name: string) =>
			RealmPromise.reject(new RealmDOMException(message, name));
		const rejectedWith = (error: unknown) => RealmPromise.reject(error);

		// --- the tables: the inject module's, shared by the documents that reach each other ---

		const shared = ctx.shared as unknown as Shared;
		shared.peers ??= new WeakMap();
		shared.channels ??= new WeakMap();
		shared.channelEvents ??= new WeakMap();
		shared.reports ??= new WeakMap();
		shared.made ??= [];
		shared.transceivers ??= new WeakMap();
		shared.senders ??= new WeakMap();
		shared.receivers ??= new WeakMap();
		shared.trackEvents ??= new WeakMap();
		shared.transports ??= new WeakMap();
		shared.dtmf ??= new WeakMap();
		shared.tracks ??= new WeakMap();
		shared.streams ??= new WeakMap();

		// --- the document's worker, started on the first connection ---

		let worker: Worker | null = null;
		const startWorker = (): Worker => {
			if (worker) return worker;
			const controlled = client.controlledClient();
			// an about:blank popup has no controller and no parent to ask
			if (!controlled && bundleWorker && bundleWorker !== startWorker)
				return bundleWorker();
			const NativeWorker = workerModule?.nativeWorker ?? global.Worker;
			const transport = (controlled ?? client).requestTransportPort();
			const started = new NativeWorker(ctx.workerURL());
			worker = started;
			Reflect.apply(workerPost, started, [
				{
					kind: 'init',
					transport,
					module: ctx.moduleURL(),
					template: true,
				} satisfies RtcWorkerInit,
				[transport],
			]);
			// What this browser offers for audio and video, from a connection
			// of its own that is closed with nothing set on it (no socket):
			// the stack negotiates these formats, and the sections a page
			// reads are written in this shape.
			const probe = Reflect.construct(
				NativePeerConnection,
				[],
			) as RTCPeerConnection;
			const template = (sdp: string) => {
				probe.close();
				Reflect.apply(workerPost, started, [
					{ kind: 'template', sdp } satisfies RtcWorkerTemplate,
				]);
			};
			try {
				probe.addTransceiver('audio');
				probe.addTransceiver('video');
				probe.createOffer().then(
					(offer) => template(offer.sdp ?? ''),
					() => template(''),
				);
			} catch (error) {
				template('');
			}
			return worker;
		};
		bundleWorker ??= startWorker;

		// --- prototypes that read as the browser's ---

		const illegal = () => new RealmTypeError('Illegal invocation');
		/**
		 * The base of a class of this library whose objects the page sees:
		 * an object made on the prototype of the inject module's class
		 * (`made`), or on a subclass's when the page made it (`new.target`)
		 */
		const ours = new Set<Function>();
		const based = (Base: Function, made: Function) => {
			const base = function (this: unknown, ...args: unknown[]) {
				return Reflect.construct(
					Base,
					args,
					!new.target || ours.has(new.target) ? made : new.target,
				);
			} as unknown as { new (...args: any[]): any };
			return base;
		};
		/** an event handler attribute (`onopen`), as the browser keeps one */
		interface Slot {
			handler: Function;
			listener: (event: Event) => unknown;
		}
		const slots = new WeakMap<object, Record<string, Slot | undefined>>();
		const handlerAttribute = (type: string): PropertyDescriptor => ({
			get(this: object) {
				return slots.get(this)?.[type]?.handler ?? null;
			},
			set(this: object, value: unknown) {
				let own = slots.get(this);
				if (!own) {
					own = { __proto__: null } as unknown as Record<
						string,
						Slot | undefined
					>;
					slots.set(this, own);
				}
				const slot = own[type];
				if (typeof value !== 'function') {
					if (!slot) return;
					own[type] = undefined;
					Reflect.apply(removeListener, this, [type, slot.listener]);
				} else if (slot) slot.handler = value;
				else {
					// the listener keeps the place the first handler took
					const made: Slot = {
						handler: value,
						listener(this: unknown, event) {
							return Reflect.apply(made.handler, this, [event]);
						},
					};
					own[type] = made;
					Reflect.apply(addListener, this, [type, made.listener]);
				}
			},
		});
		/**
		 * `Mock`'s prototype made to read as `Native`'s: the browser's own
		 * keys in its order with its descriptors, each function one that
		 * reads as the browser's and runs the member of the document that
		 * made the object (`table`), or `missing` where there is none yet.
		 * `members` is filled with this document's, for the objects it makes.
		 */
		const dress = (
			Mock: Function,
			Native: Function,
			// the prototype the inject module dressed dispatches on these
			_table: WeakMap<object, Members>,
			members: Members,
			_missing: (key: string, getter: boolean) => unknown,
		) => {
			const prototype = Mock.prototype as object;
			for (const key of Reflect.ownKeys(prototype))
				if (key !== 'constructor')
					members[key] = Reflect.getOwnPropertyDescriptor(prototype, key);
			for (const key of Reflect.ownKeys(Native.prototype)) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					Native.prototype,
					key,
				)!;
				if (
					typeof key === 'string' &&
					key.startsWith('on') &&
					descriptor.set &&
					!members[key]
				)
					members[key] = handlerAttribute(key.slice(2));
			}
		};
		const noMembers = () => ({ __proto__: null }) as unknown as Members;

		// --- the configuration, as Chrome validates and reads it back ---

		const isObject = (value: unknown): value is Record<string, unknown> =>
			(typeof value === 'object' && value !== null) ||
			typeof value === 'function';
		const certificateExpires =
			typeof live.RTCCertificate === 'function'
				? Reflect.getOwnPropertyDescriptor(
						live.RTCCertificate.prototype,
						'expires',
					)?.get
				: undefined;
		/** an RTCCertificate's expiry: throws for anything else */
		const expires = (certificate: unknown): number =>
			Reflect.apply(certificateExpires!, certificate, []);
		/**
		 * Whether this browser still reads `iceTransports` (Chrome 152 does,
		 * 156 does not), asked of its own constructor with a configuration
		 * whose last member throws, so it never makes a connection. The
		 * browsers that stopped reading it also check the range of
		 * `maxRetransmits` and `maxPacketLifeTime` where the older ones wrap
		 * them, and nothing but a connection of the browser's could tell
		 * that apart, so this answers for both.
		 */
		let legacy: boolean | null = null;
		const isLegacy = () => {
			if (legacy === null) {
				legacy = false;
				try {
					(
						Reflect.construct(NativePeerConnection, [
							{
								get iceTransports() {
									legacy = true;
									return undefined;
								},
								get rtcpMuxPolicy() {
									throw new RealmTypeError();
								},
							},
						]) as RTCPeerConnection
					).close();
				} catch (error) {
					// the last member's getter, every time
				}
			}
			return legacy;
		};
		/** a refusal as this realm's error, `context` before its words */
		const raised = (refusal: Refusal, context: string) =>
			refusal.name === 'TypeError'
				? new RealmTypeError(`${context}: ${refusal.message}`)
				: domException(`${context}: ${refusal.message}`, refusal.name);
		const refusing = <T>(context: string, run: () => T): T => {
			try {
				return run();
			} catch (error) {
				throw error instanceof Refusal ? raised(error, context) : error;
			}
		};
		/** counts `made` among the connections alive, unless they are too many */
		const counted = (made: object) => {
			if (shared.made.length >= MAX_CONNECTIONS) {
				const alive: WeakRef<object>[] = [];
				for (let i = 0; i < shared.made.length; i++)
					if (Reflect.apply(weakDeref, shared.made[i], []))
						alive[alive.length] = shared.made[i];
				shared.made = alive;
			}
			// the refused one counts as well, until it is collected
			shared.made[shared.made.length] = new RealmWeakRef(made);
			if (shared.made.length > MAX_CONNECTIONS)
				throw domException(
					"Failed to construct 'RTCPeerConnection': Cannot create so many PeerConnections",
					'UnknownError',
				);
		};
		const forWorker = (config: Configuration): ConnectionConfig => ({
			iceServers: config.iceServers.map(({ urls, username, credential }) => ({
				urls,
				username,
				credential,
			})),
			iceTransportPolicy: config.iceTransportPolicy as 'all' | 'relay',
			iceCandidatePoolSize: config.iceCandidatePoolSize,
			tlsErrorsAtEnd: !isLegacy(),
		});

		// --- RTCDataChannel ---

		const unsupported = (name: string) => (key: string, getter: boolean) => {
			if (getter) return undefined;
			throw domException(
				`Failed to execute '${key}' on '${name}': not supported through the proxy yet`,
				'NotSupportedError',
			);
		};
		const channelMembers = noMembers();
		interface ChannelState {
			pc: PeerState;
			index: number;
			options: ChannelOptions;
			id: number | null;
			readyState: RTCDataChannelState;
			bufferedAmount: number;
			/** bytes of the sends the worker has not answered yet */
			unreported: number;
			bufferedAmountLowThreshold: number;
			binaryType: BinaryType;
			/** for getStats(): its id, and what went through it */
			serial: number;
			opened: boolean;
			messagesSent: number;
			bytesSent: number;
			messagesReceived: number;
			bytesReceived: number;
		}
		const channelStates = new WeakMap<object, ChannelState>();
		const channelOf = (that: unknown): ChannelState => {
			const state = channelStates.get(that as object);
			if (!state) throw illegal();
			return state;
		};

		class MockDataChannel extends based(
			RealmEventTarget,
			ctx.standIns.RTCDataChannel,
		) {
			constructor(
				pc: PeerState,
				index: number,
				options: ChannelOptions,
				id: number | null,
			) {
				super();
				shared.channels.set(this, channelMembers);
				channelStates.set(this, {
					pc,
					index,
					options,
					id,
					readyState: 'connecting',
					bufferedAmount: 0,
					unreported: 0,
					bufferedAmountLowThreshold: 0,
					binaryType: 'arraybuffer',
					serial: ++channelSerial,
					opened: false,
					messagesSent: 0,
					bytesSent: 0,
					messagesReceived: 0,
					bytesReceived: 0,
				});
			}
			get label() {
				return channelOf(this).options.label;
			}
			get ordered() {
				return channelOf(this).options.ordered;
			}
			get maxPacketLifeTime() {
				return channelOf(this).options.maxPacketLifeTime;
			}
			get maxRetransmits() {
				return channelOf(this).options.maxRetransmits;
			}
			get protocol() {
				return channelOf(this).options.protocol;
			}
			get negotiated() {
				return channelOf(this).options.negotiated;
			}
			get reliable() {
				const { maxPacketLifeTime, maxRetransmits } = channelOf(this).options;
				return maxPacketLifeTime === null && maxRetransmits === null;
			}
			get id() {
				return channelOf(this).id;
			}
			get readyState() {
				return channelOf(this).readyState;
			}
			get bufferedAmount() {
				const state = channelOf(this);
				return state.bufferedAmount + state.unreported;
			}
			get bufferedAmountLowThreshold() {
				return channelOf(this).bufferedAmountLowThreshold;
			}
			set bufferedAmountLowThreshold(value: number) {
				const state = channelOf(this);
				state.bufferedAmountLowThreshold = Number(value) >>> 0;
				state.pc
					.call({
						op: 'lowThreshold',
						channel: state.index,
						value: state.bufferedAmountLowThreshold,
					})
					.catch(() => {});
			}
			get binaryType() {
				return channelOf(this).binaryType;
			}
			set binaryType(value: BinaryType) {
				const state = channelOf(this);
				const text = String(value);
				// an unknown one is ignored (the browser warns in the console)
				if (text !== 'blob' && text !== 'arraybuffer') return;
				state.binaryType = text;
			}
			send(data: string | Blob | ArrayBuffer | ArrayBufferView) {
				const state = channelOf(this);
				if (!arguments.length)
					throw new RealmTypeError(
						"Failed to execute 'send' on 'RTCDataChannel': 1 argument required, but only 0 present.",
					);
				if (state.readyState !== 'open')
					throw domException(
						"Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
						'InvalidStateError',
					);
				if (data instanceof RealmBlob) {
					const size = data.size;
					if (size > messageLimit(state.pc)) throw tooLarge();
					state.unreported += size;
					state.messagesSent++;
					state.bytesSent += size;
					const reported = () => {
						state.unreported -= size;
					};
					data
						.arrayBuffer()
						.then((buffer) =>
							state.pc.call(
								{
									op: 'send',
									channel: state.index,
									data: buffer,
									binary: true,
								},
								[buffer],
							),
						)
						.then(reported, reported);
					return;
				}
				let payload: string | ArrayBuffer;
				let binary: boolean;
				if (typeof data === 'string') {
					payload = data;
					binary = false;
				} else if (data instanceof ArrayBuffer) {
					payload = data.slice(0);
					binary = true;
				} else if (ArrayBuffer.isView(data)) {
					payload = (data.buffer as ArrayBuffer).slice(
						data.byteOffset,
						data.byteOffset + data.byteLength,
					);
					binary = true;
				} else {
					payload = String(data);
					binary = false;
				}
				const size =
					typeof payload === 'string'
						? utf8Length(payload)
						: payload.byteLength;
				if (size > messageLimit(state.pc)) throw tooLarge();
				state.unreported += size;
				state.messagesSent++;
				state.bytesSent += size;
				const reported = () => {
					state.unreported -= size;
				};
				state.pc
					.call(
						{ op: 'send', channel: state.index, data: payload, binary },
						typeof payload === 'string' ? [] : [payload],
					)
					.then(reported, reported);
			}
			close() {
				const state = channelOf(this);
				if (state.readyState === 'closing' || state.readyState === 'closed')
					return;
				state.readyState = 'closing';
				state.pc
					.call({ op: 'closeChannel', channel: state.index })
					.catch(() => {});
			}
		}
		const tooLarge = () =>
			new RealmTypeError(
				"Failed to execute 'send' on 'RTCDataChannel': Trying to send message larger than max-message-size",
			);
		/**
		 * The largest message the peer takes, as the browser reads it from
		 * the peer's description: what it says, 64 KiB when it says nothing,
		 * and never more than the browser itself sends
		 */
		const messageLimit = (pc: PeerState) => {
			const sdp = (pc.currentRemote ?? pc.pendingRemote)?.sdp ?? '';
			const said = /^a=max-message-size:(\d+)/m.exec(sdp)?.[1];
			const size = said === undefined ? 65536 : Number(said);
			return size === 0 ? MAX_MESSAGE_SIZE : Math.min(size, MAX_MESSAGE_SIZE);
		};
		const utf8Length = (text: string) => new TextEncoder().encode(text).length;

		dress(
			MockDataChannel,
			NativeDataChannel,
			shared.channels,
			channelMembers,
			unsupported('RTCDataChannel'),
		);

		// --- RTCDataChannelEvent (its channel is one of ours) ---

		const channelEventChannels = new WeakMap<object, RTCDataChannel>();
		const channelEventMembers = noMembers();
		class MockDataChannelEvent extends based(
			RealmEvent,
			ctx.standIns.RTCDataChannelEvent,
		) {
			constructor(type: string, init: RTCDataChannelEventInit) {
				super(type, init);
				shared.channelEvents.set(this, channelEventMembers);
				channelEventChannels.set(this, init.channel);
			}
			get channel() {
				const channel = channelEventChannels.get(this);
				if (!channel) throw illegal();
				return channel;
			}
		}
		dress(
			MockDataChannelEvent,
			NativeDataChannelEvent,
			shared.channelEvents,
			channelEventMembers,
			unsupported('RTCDataChannelEvent'),
		);

		// --- RTCStatsReport ---

		const reportMaps = new WeakMap<object, Map<string, unknown>>();
		const reportMembers = noMembers();
		const reportOf = (that: unknown) => {
			const map = reportMaps.get(that as object);
			if (!map) throw illegal();
			return map;
		};
		// a report's iterators are the browser's own kind, not a Map's: a
		// prototype of their own with `next` and a tag
		const steps = new WeakMap<object, () => IteratorResult<unknown>>();
		const mapIterator = Reflect.getPrototypeOf(
			Reflect.apply(mapEntries, new global.Map(), []) as object,
		)!;
		const reportIterator = global.Object.create(
			Reflect.getPrototypeOf(mapIterator),
			{
				next: {
					value: proxyModule.wrapFunction(
						(mapIterator as { next: Function }).next,
						(target, that) => {
							const step = steps.get(that);
							if (!step) throw illegal();
							return step();
						},
					),
					writable: true,
					enumerable: true,
					configurable: true,
				},
				[Symbol.toStringTag]: {
					value: 'RTCStatsReport Iterator',
					configurable: true,
				},
			},
		) as object;
		const iterate = (
			report: unknown,
			pick: (key: string, value: unknown) => unknown,
		) => {
			const source = Reflect.apply(mapEntries, reportOf(report), []);
			const iterator = Object.create(reportIterator) as object;
			steps.set(iterator, () => {
				const step = Reflect.apply(mapNext, source, []);
				return step.done
					? { value: undefined, done: true }
					: { value: pick(step.value[0], step.value[1]), done: false };
			});
			return iterator;
		};
		const pair = (key: string, value: unknown) => new RealmArray(key, value);
		class MockStatsReport extends based(
			global.Object,
			ctx.standIns.RTCStatsReport,
		) {
			constructor(entries: Map<string, unknown>) {
				super();
				shared.reports.set(this, reportMembers);
				reportMaps.set(this, entries);
			}
			get size() {
				return reportOf(this).size;
			}
			get(key: string) {
				return reportOf(this).get(String(key));
			}
			has(key: string) {
				return reportOf(this).has(String(key));
			}
			forEach(
				callback: (value: unknown, key: string, map: unknown) => void,
				thisArg?: unknown,
			) {
				const source = Reflect.apply(mapEntries, reportOf(this), []);
				for (;;) {
					const step = Reflect.apply(mapNext, source, []);
					if (step.done) break;
					Reflect.apply(callback, thisArg, [
						step.value[1],
						step.value[0],
						this,
					]);
				}
			}
			entries() {
				return iterate(this, pair);
			}
			keys() {
				return iterate(this, (key) => key);
			}
			values() {
				return iterate(this, (key, value) => value);
			}
			[Symbol.iterator]() {
				return iterate(this, pair);
			}
		}
		dress(
			MockStatsReport,
			NativeStatsReport,
			shared.reports,
			reportMembers,
			unsupported('RTCStatsReport'),
		);

		// --- media: transceivers, senders, receivers and their tracks ---

		const NativeTrack = live.MediaStreamTrack as Function | undefined;
		const NativeStream = live.MediaStream as Function | undefined;
		const Processor = live.MediaStreamTrackProcessor as Function | undefined;
		const Generator = live.MediaStreamTrackGenerator as Function | undefined;
		const NativeTransceiver = live.RTCRtpTransceiver as Function | undefined;
		const NativeSender = live.RTCRtpSender as Function | undefined;
		const NativeReceiver = live.RTCRtpReceiver as Function | undefined;
		const NativeTrackEvent = live.RTCTrackEvent as Function | undefined;
		const NativeDtmfSender = live.RTCDTMFSender as Function | undefined;
		const NativeToneEvent = live.RTCDTMFToneChangeEvent as
			typeof RTCDTMFToneChangeEvent | undefined;
		const realmTimeout = global.setTimeout as typeof setTimeout;
		const realmPerformance = global.performance as Performance;
		const performanceNow = captures.performanceNow;
		const NativeStreamTrackEvent = live.MediaStreamTrackEvent as
			typeof MediaStreamTrackEvent | undefined;
		/** the browser has what media through the worker takes */
		const hasMedia = [
			NativeTrack,
			NativeStream,
			Processor,
			Generator,
			NativeTransceiver,
			NativeSender,
			NativeReceiver,
			NativeTrackEvent,
			NativeStreamTrackEvent,
		].every((made) => typeof made === 'function');
		// the browser's own accessors, taken before anything is hooked: what
		// an object is, is asked of them
		const getterOf = (Class: Function | undefined, key: string) =>
			(Class && Reflect.getOwnPropertyDescriptor(Class.prototype, key)?.get) as
				(() => any) | undefined;
		const trackKind = getterOf(NativeTrack, 'kind');
		const trackId = getterOf(NativeTrack, 'id');
		const trackState = getterOf(NativeTrack, 'readyState');
		const streamId = getterOf(NativeStream, 'id');
		const writableOf = getterOf(Generator, 'writable');
		const readableOf = getterOf(Processor, 'readable');
		const stopTrack = NativeTrack?.prototype.stop as Function;
		const streamAdd = NativeStream?.prototype.addTrack as Function;
		const streamRemove = NativeStream?.prototype.removeTrack as Function;
		const kindOf = (value: unknown): 'audio' | 'video' | null => {
			try {
				return Reflect.apply(trackKind!, value, []);
			} catch (error) {
				return null;
			}
		};
		const streamIdOf = (value: unknown): string | null => {
			try {
				return (
					shared.streams.get(value as object) ??
					Reflect.apply(streamId!, value, [])
				);
			} catch (error) {
				return null;
			}
		};
		/** an id as the browser makes them */
		const uuid = (): string =>
			Reflect.apply(streamId!, Reflect.construct(NativeStream!, []), []);
		const sends = (direction: Direction) =>
			direction === 'sendrecv' || direction === 'sendonly';
		const receives = (direction: Direction) =>
			direction === 'sendrecv' || direction === 'recvonly';
		const directionOf = (send: boolean, receive: boolean): Direction =>
			send
				? receive
					? 'sendrecv'
					: 'sendonly'
				: receive
					? 'recvonly'
					: 'inactive';
		const DIRECTIONS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];

		/** a transceiver, with its sender and its receiver */
		interface MediaSlot {
			pc: PeerState;
			/** the worker's name for it (protocol.ts, MediaSection) */
			handle: number;
			kind: 'audio' | 'video';
			mid: string | null;
			direction: Direction;
			current: Direction | 'stopped' | null;
			/** stop() was called, or the peer stopped it */
			stopping: boolean;
			/** and a negotiation has taken it out of the connection */
			stopped: boolean;
			transceiver: object;
			sender: object;
			receiver: object;
			/** what the sender sends */
			track: MediaStreamTrack | null;
			/** the receiver's track: what the worker plays into */
			remote: MediaStreamTrack;
			/** the peer's streams the receiver's track is in */
			remoteStreams: MediaStream[];
			/** the peer's description has the section send */
			receptive: boolean;
			/** media has arrived on it */
			live: boolean;
			/** a description has had it send: addTrack leaves it alone */
			sent: boolean;
			/** its direction in this side's last offer, and the peer's in its last description */
			offered: Direction | null;
			theirs: Direction | null;
			/** setStreams since the last local description */
			restated: boolean;
			encoding: Record<string, unknown>;
			/** the transactionId getParameters last gave */
			transaction: string | null;
			jitter: unknown;
			/** what it sends with has a telephone-event payload (the worker's word) */
			events: boolean;
			/** the sender's RTCDTMFSender, once it is read */
			dtmf: object | null;
			/** its track's media-source number in the stats (SA<n>), 0 for none */
			source: number;
		}
		const mediaSlots = new WeakMap<object, MediaSlot>();
		const slotOf = (that: unknown): MediaSlot => {
			const slot = mediaSlots.get(that as object);
			if (!slot) throw illegal();
			return slot;
		};
		/**
		 * What the browser sends and receives of a kind, as its own
		 * RTCRtpSender and RTCRtpReceiver tell it (static: no connection)
		 */
		const senderCapabilities = (NativeSender as typeof RTCRtpSender | undefined)
			?.getCapabilities;
		const receiverCapabilities = (
			NativeReceiver as typeof RTCRtpReceiver | undefined
		)?.getCapabilities;
		const capabilitiesOf = (kind: string): CodecCapability[] => {
			const out: CodecCapability[] = [];
			const seen = new Set<string>();
			for (const [ask, Class] of [
				[senderCapabilities, NativeSender],
				[receiverCapabilities, NativeReceiver],
			] as const) {
				const told = ask
					? (Reflect.apply(ask, Class, [kind]) as RTCRtpCapabilities | null)
					: null;
				for (const codec of told?.codecs ?? []) {
					const own: CodecCapability = {
						mimeType: codec.mimeType,
						clockRate: codec.clockRate,
						...(codec.channels !== undefined && { channels: codec.channels }),
						...(codec.sdpFmtpLine !== undefined && {
							sdpFmtpLine: codec.sdpFmtpLine,
						}),
					};
					const key = JSON.stringify(own);
					if (seen.has(key)) continue;
					seen.add(key);
					out.push(own);
				}
			}
			return out;
		};
		const emptyReport = () =>
			RealmPromise.resolve(Reflect.construct(MockStatsReport, [new Map()]));
		/** a sender's or a receiver's own report (statsEntries, `picked`) */
		const pickedReport = (slot: MediaSlot, side: 'sender' | 'receiver') => {
			const state = slot.pc;
			if (state.closed || slot.stopped) return emptyReport();
			const heard = new Set(state.heard);
			return state
				.call({ op: 'stats' })
				.then((info) =>
					Reflect.construct(MockStatsReport, [
						statsEntries(state, info as StatsReply, heard, { slot, side }),
					]),
				);
		};
		const SET_DIRECTION =
			"Failed to set the 'direction' property on 'RTCRtpTransceiver': ";
		const onSender = (name: string, what: string) =>
			`Failed to execute '${name}' on 'RTCRtpSender': ${what}`;

		class TransceiverMembers {
			get mid() {
				return slotOf(this).mid;
			}
			get sender() {
				return slotOf(this).sender;
			}
			get receiver() {
				return slotOf(this).receiver;
			}
			get stopped() {
				return slotOf(this).stopping;
			}
			get direction(): any {
				const slot = slotOf(this);
				return slot.stopping ? 'stopped' : slot.direction;
			}
			set direction(value: any) {
				const slot = slotOf(this);
				const direction = String(value);
				if (slot.pc.closed)
					throw domException(
						`${SET_DIRECTION}The peer connection is closed.`,
						'InvalidStateError',
					);
				if (slot.stopping)
					throw domException(
						`${SET_DIRECTION}The transceiver is stopping.`,
						'InvalidStateError',
					);
				if (direction === 'stopped')
					throw new RealmTypeError(
						`${SET_DIRECTION}Invalid RTCRtpTransceiverDirection.`,
					);
				// any other word: the browser warns and leaves it
				if (!DIRECTIONS.includes(direction) || direction === slot.direction)
					return;
				setDirection(slot, direction as Direction);
				negotiate(slot.pc);
			}
			get currentDirection() {
				return slotOf(this).current;
			}
			stop() {
				const slot = slotOf(this);
				if (slot.pc.closed)
					throw domException(
						"Failed to execute 'stop' on 'RTCRtpTransceiver': The peer connection is closed.",
						'InvalidStateError',
					);
				if (slot.stopping) return;
				slot.stopping = true;
				slot.pc.call({ op: 'stopMedia', handle: slot.handle }).catch(() => {});
				queue(() => endRemote(slot));
				negotiate(slot.pc);
			}
			// What the section's descriptions list, in the page's order: the
			// worker writes them so. What is sent is the first codec of the
			// peer's description, as natively, whatever the page prefers.
			setCodecPreferences(...args: any[]) {
				const slot = slotOf(this);
				const context =
					"Failed to execute 'setCodecPreferences' on 'RTCRtpTransceiver'";
				if (!args.length)
					throw new RealmTypeError(
						`${context}: 1 argument required, but only 0 present.`,
					);
				const codecs = refusing(context, () =>
					codecPreferences(
						codecList(args[0]),
						slot.kind,
						capabilitiesOf(slot.kind),
						isLegacy(),
					),
				);
				slot.pc
					.call({
						op: 'codecPreferences',
						handle: slot.handle,
						codecs,
						legacy: isLegacy(),
					})
					.catch(() => {});
			}
		}
		class SenderMembers {
			get track() {
				return slotOf(this).track;
			}
			get transport() {
				slotOf(this);
				return null;
			}
			get rtcpTransport() {
				slotOf(this);
				return null;
			}
			get dtmf() {
				const slot = slotOf(this);
				if (slot.kind !== 'audio' || !NativeDtmfSender) return null;
				slot.dtmf ??= makeDtmf(slot);
				return slot.dtmf;
			}
			getParameters() {
				const slot = slotOf(this);
				slot.transaction = uuid();
				const encodings = new RealmArray();
				if (!slot.stopping) encodings.push({ ...slot.encoding });
				return {
					codecs: new RealmArray(),
					headerExtensions: new RealmArray(),
					rtcp: { cname: '', reducedSize: false },
					encodings,
					transactionId: slot.transaction,
				};
			}
			setParameters(...args: any[]) {
				const slot = slotOf(this);
				if (!args.length)
					return RealmPromise.reject(
						new RealmTypeError(
							onSender(
								'setParameters',
								'1 argument required, but only 0 present.',
							),
						),
					);
				if (slot.stopping)
					return rejected(
						onSender(
							'setParameters',
							// Chrome 156 words it anew; isLegacy() tells 152 from it
							isLegacy()
								? 'Cannot set parameters on a stopped sender.'
								: 'setParameters cannot be called on a stopped sender.',
						),
						'InvalidStateError',
					);
				if (slot.transaction === null)
					return rejected(
						onSender(
							'setParameters',
							'getParameters() needs to be called before setParameters().',
						),
						'InvalidStateError',
					);
				const given = args[0];
				if (!isObject(given) || given.transactionId !== slot.transaction)
					return rejected(
						onSender(
							'setParameters',
							'Read-only field modified in setParameters().',
						),
						'InvalidModificationError',
					);
				slot.transaction = null;
				const encoding = isObject(given.encodings)
					? (given.encodings as Record<number, unknown>)[0]
					: undefined;
				if (isObject(encoding)) {
					slot.encoding = encodingOf(encoding);
					slot.pc
						.call({
							op: 'mediaEncoding',
							handle: slot.handle,
							active: slot.encoding.active !== false,
						})
						.catch(() => {});
				}
				return RealmPromise.resolve(undefined);
			}
			replaceTrack(...args: any[]) {
				const slot = slotOf(this);
				const track = args[0] ?? null;
				let refusal: string | null = null;
				if (!args.length) refusal = '1 argument required, but only 0 present.';
				else if (track !== null && !kindOf(track))
					refusal = "parameter 1 is not of type 'MediaStreamTrack'.";
				if (refusal)
					return RealmPromise.reject(
						new RealmTypeError(onSender('replaceTrack', refusal)),
					);
				if (slot.pc.closed)
					return rejected(
						onSender('replaceTrack', 'The peer connection is closed.'),
						'InvalidStateError',
					);
				if (slot.stopping)
					return rejected(
						onSender(
							'replaceTrack',
							'replaceTrack cannot be called on a stopped sender',
						),
						'InvalidStateError',
					);
				if (track !== null && kindOf(track) !== slot.kind)
					return RealmPromise.reject(
						new RealmTypeError(
							onSender('replaceTrack', 'Track kind does not match Sender kind'),
						),
					);
				if (track !== slot.track) slot.source = track ? ++sourceSerial : 0;
				slot.track = track;
				return new RealmPromise<void>((resolve) => {
					const done = () => resolve();
					sendTrack(slot).then(done, done);
				});
			}
			getStats() {
				return pickedReport(slotOf(this), 'sender');
			}
			setStreams(...streams: unknown[]) {
				const slot = slotOf(this);
				const ids = streamIds(streams, 0, 'setStreams', 'RTCRtpSender');
				if (slot.pc.closed)
					throw domException(
						onSender('setStreams', 'The peer connection is closed.'),
						'InvalidStateError',
					);
				slot.restated = true;
				slot.pc
					.call({ op: 'mediaStreams', handle: slot.handle, streams: ids })
					.catch(() => {});
				negotiate(slot.pc);
			}
		}
		class ReceiverMembers {
			get track() {
				return slotOf(this).remote;
			}
			get transport() {
				slotOf(this);
				return null;
			}
			get rtcpTransport() {
				slotOf(this);
				return null;
			}
			get jitterBufferTarget(): any {
				return slotOf(this).jitter;
			}
			set jitterBufferTarget(value: any) {
				slotOf(this).jitter = value;
			}
			getParameters() {
				slotOf(this);
				return {
					codecs: new RealmArray(),
					headerExtensions: new RealmArray(),
					rtcp: { reducedSize: false },
					encodings: new RealmArray(),
				};
			}
			getStats() {
				return pickedReport(slotOf(this), 'receiver');
			}
			getContributingSources() {
				slotOf(this);
				return new RealmArray();
			}
			getSynchronizationSources() {
				slotOf(this);
				return new RealmArray();
			}
		}
		interface TrackEventParts {
			receiver: object;
			track: MediaStreamTrack;
			streams: readonly MediaStream[];
			transceiver: object;
		}
		const trackEvents = new WeakMap<object, TrackEventParts>();
		const trackEventOf = (that: unknown): TrackEventParts => {
			const parts = trackEvents.get(that as object);
			if (!parts) throw illegal();
			return parts;
		};
		class TrackEventMembers {
			get receiver() {
				return trackEventOf(this).receiver;
			}
			get track() {
				return trackEventOf(this).track;
			}
			get streams() {
				return trackEventOf(this).streams;
			}
			get transceiver() {
				return trackEventOf(this).transceiver;
			}
		}

		// --- RTCDTMFSender (docs/webrtc-over-wisp.md, section 16) ---

		/**
		 * Blink's tone player: the tones a page inserted, played one at a
		 * time from a task of their own, each a request to the worker, which
		 * sends it on the wire with the frames of its time
		 */
		interface DtmfState {
			slot: MediaSlot;
			buffer: string;
			duration: number;
			gap: number;
			scheduled: boolean;
		}
		const dtmfStates = new WeakMap<object, DtmfState>();
		const dtmfOf = (that: unknown): DtmfState => {
			const state = dtmfStates.get(that as object);
			if (!state) throw illegal();
			return state;
		};
		/**
		 * Chrome's answer: the transceiver sends on a connection that is up,
		 * as the last negotiation settled it, with a telephone-event payload
		 */
		const canInsert = (slot: MediaSlot) =>
			!slot.stopping &&
			!slot.pc.closed &&
			slot.events &&
			slot.pc.connectionState === 'connected' &&
			(slot.current === 'sendrecv' || slot.current === 'sendonly');
		const onDtmf = (what: string) =>
			`Failed to execute 'insertDTMF' on 'RTCDTMFSender': ${what}`;
		/** WebIDL's DOMString */
		const toText = (value: unknown) => {
			if (typeof value === 'symbol')
				throw new RealmTypeError(
					onDtmf(`Cannot convert a Symbol value to a string`),
				);
			return String(value);
		};
		/** WebIDL's unsigned long */
		const toUnsigned = (value: unknown) => {
			if (typeof value === 'symbol')
				throw new RealmTypeError(
					onDtmf('Cannot convert a Symbol value to a number'),
				);
			if (typeof value === 'bigint')
				throw new RealmTypeError(
					onDtmf('Cannot convert a BigInt value to a number'),
				);
			const number = Number(value);
			if (!Number.isFinite(number)) return 0;
			const whole = Math.trunc(number) % 2 ** 32;
			return whole < 0 ? whole + 2 ** 32 : whole;
		};
		const later = (run: () => void, ms: number) =>
			Reflect.apply(realmTimeout, client.global, [run, Math.max(0, ms)]);
		const now = (): number =>
			Reflect.apply(performanceNow, realmPerformance, []);
		// The first tone plays in a task of its own, ahead of a timer or a
		// message the page queues after the call (as Chrome's does): a
		// message on a channel of the document's own
		const queued: (() => void)[] = [];
		let channel: MessagePort | null = null;
		const soon = (run: () => void) => {
			if (!channel) {
				const [heard, sent] = privateChannel();
				onPort(heard, 'message', () => queued.shift()?.());
				channel = sent;
			}
			queued.push(run);
			Reflect.apply(portPost, channel, [null]);
		};
		const toneEvent = (tone: string) =>
			new NativeToneEvent!('tonechange', { tone });
		const playTones = (target: object) => {
			const state = dtmfStates.get(target)!;
			state.scheduled = false;
			const { slot } = state;
			if (slot.stopping) return;
			if (!state.buffer) {
				(target as EventTarget).dispatchEvent(toneEvent(''));
				return;
			}
			const tone = state.buffer[0];
			state.buffer = state.buffer.slice(1);
			// The next tone comes after this one, its gap, and the gap again
			// (measured on Chrome 152 and 156: duration + 2 x gap, and 2000 ms
			// + gap after a ','), the second gap as it is then: a page that
			// inserts again while a tone plays moves only that one
			let delay = DTMF_COMMA_MS;
			if (tone !== ',') {
				if (!canInsert(slot)) return;
				slot.pc
					.call({
						op: 'dtmf',
						handle: slot.handle,
						tone,
						duration: state.duration,
					})
					.catch(() => {});
				delay = state.duration + state.gap;
			}
			state.scheduled = true;
			// the second wait is counted from when the first should have
			// ended, so a late timer does not push the next tone back
			const due = now() + delay;
			later(
				() => later(() => playTones(target), due + state.gap - now()),
				delay,
			);
			(target as EventTarget).dispatchEvent(toneEvent(tone));
		};
		class DtmfMembers {
			get canInsertDTMF() {
				return canInsert(dtmfOf(this).slot);
			}
			get toneBuffer() {
				return dtmfOf(this).buffer;
			}
			insertDTMF(...args: any[]) {
				const state = dtmfOf(this);
				if (!args.length)
					throw new RealmTypeError(
						onDtmf('1 argument required, but only 0 present.'),
					);
				const tones = toText(args[0]);
				const duration =
					args[1] === undefined ? DTMF_DURATION : toUnsigned(args[1]);
				const gap = args[2] === undefined ? DTMF_GAP : toUnsigned(args[2]);
				if (!canInsert(state.slot))
					throw domException(
						onDtmf(
							"The 'canInsertDTMF' attribute is false: this sender cannot send DTMF.",
						),
						'InvalidStateError',
					);
				if (!/^[0-9a-dA-D#*,]*$/.test(tones))
					throw domException(
						onDtmf('Illegal characters in InsertDTMF tone argument'),
						'InvalidCharacterError',
					);
				// Blink clamps them as signed numbers: 2 ** 31 and up is the least
				state.duration = Math.min(Math.max(duration | 0, 40), 6000);
				state.gap = Math.min(Math.max(gap | 0, 30), 6000);
				state.buffer = tones.toUpperCase();
				if (!state.buffer || state.scheduled) return;
				state.scheduled = true;
				soon(() => playTones(this));
			}
		}

		/**
		 * The browser's own prototype answering for objects of ours: each of
		 * its functions is one that reads as it, runs `Mock`'s member for an
		 * object in `table` (`missing` where there is none) and is the
		 * browser's own for anything else, so its errors for a stranger are
		 * the browser's. The members are returned, for the objects this
		 * document makes.
		 */
		const adopt = (
			Native: Function,
			Mock: Function,
			table: WeakMap<object, Members>,
			name: string,
		): Members => {
			const members = noMembers();
			const missing = unsupported(name);
			for (const key of Reflect.ownKeys(Mock.prototype))
				if (key !== 'constructor')
					members[key] = Reflect.getOwnPropertyDescriptor(Mock.prototype, key);
			const prototype = Native.prototype as object;
			for (const key of Reflect.ownKeys(prototype)) {
				if (key === 'constructor') continue;
				const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key)!;
				for (const part of ['value', 'get', 'set'] as const) {
					const native = descriptor[part];
					if (typeof native !== 'function') continue;
					descriptor[part] = proxyModule.wrapFunction(
						native as Function,
						(target, that, args) => {
							const own = table.get(that);
							if (!own) return Reflect.apply(target, that, args);
							const implemented = own[key]?.[part];
							return implemented
								? Reflect.apply(implemented, that, args)
								: missing(String(key), part !== 'value');
						},
					);
				}
				Reflect.defineProperty(prototype, key, descriptor);
			}
			return members;
		};
		/** a getter of the browser's that answers `read` where it has an answer */
		const override = (
			Native: Function,
			key: string,
			read: (that: object) => unknown,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				Native.prototype,
				key,
			)!;
			descriptor.get = proxyModule.wrapFunction(
				descriptor.get!,
				(target, that, args) => {
					const value = read(that);
					return value === undefined
						? Reflect.apply(target, that, args)
						: value;
				},
			);
			Reflect.defineProperty(Native.prototype, key, descriptor);
		};
		let transceiverMembers = noMembers();
		let senderMembers = noMembers();
		let receiverMembers = noMembers();
		let trackEventMembers = noMembers();
		let dtmfMembers = noMembers();
		/** a sender's RTCDTMFSender: an EventTarget on the browser's prototype */
		const makeDtmf = (slot: MediaSlot): object => {
			const made = Reflect.construct(
				RealmEventTarget,
				[],
				NativeDtmfSender!,
			) as object;
			shared.dtmf.set(made, dtmfMembers);
			dtmfStates.set(made, {
				slot,
				buffer: '',
				duration: DTMF_DURATION,
				gap: DTMF_GAP,
				scheduled: false,
			});
			return made;
		};
		if (hasMedia) {
			transceiverMembers = adopt(
				NativeTransceiver!,
				TransceiverMembers,
				shared.transceivers,
				'RTCRtpTransceiver',
			);
			senderMembers = adopt(
				NativeSender!,
				SenderMembers,
				shared.senders,
				'RTCRtpSender',
			);
			receiverMembers = adopt(
				NativeReceiver!,
				ReceiverMembers,
				shared.receivers,
				'RTCRtpReceiver',
			);
			trackEventMembers = adopt(
				NativeTrackEvent!,
				TrackEventMembers,
				shared.trackEvents,
				'RTCTrackEvent',
			);
			if (NativeDtmfSender && NativeToneEvent) {
				dtmfMembers = adopt(
					NativeDtmfSender,
					DtmfMembers,
					shared.dtmf,
					'RTCDTMFSender',
				);
				dtmfMembers.ontonechange = handlerAttribute('tonechange');
			}
			override(NativeTrack!, 'id', (that) => shared.tracks.get(that)?.id);
			override(NativeTrack!, 'label', (that) => shared.tracks.get(that)?.label);
			override(NativeTrack!, 'muted', (that) => shared.tracks.get(that)?.muted);
			override(NativeStream!, 'id', (that) => shared.streams.get(that));
			// A remote track's source is named by the track's id, in its
			// settings and its capabilities, and a remote sound says what
			// it carries (Chrome 152 and 156): the generator's name its own
			// source, and state no capabilities
			const describes = (key: 'getSettings' | 'getCapabilities') => {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					NativeTrack!.prototype,
					key,
				)!;
				descriptor.value = proxyModule.wrapFunction(
					descriptor.value,
					(target, that, args) => {
						const read = Reflect.apply(target, that, args);
						const shown = shared.tracks.get(that);
						if (!shown || !isObject(read)) return read;
						read.deviceId = shown.id ?? Reflect.apply(trackId!, that, []);
						if (key === 'getCapabilities' && 'autoGainControl' in read) {
							const off = () => {
								const list = new RealmArray();
								list.push(false);
								return list;
							};
							read.autoGainControl = off();
							read.echoCancellation = off();
							read.noiseSuppression = off();
							Reflect.deleteProperty(read, 'voiceIsolation');
							read.sampleSize = { max: 16, min: 16 };
							read.voiceIsolation = off();
						}
						return read;
					},
				);
				Reflect.defineProperty(NativeTrack!.prototype, key, descriptor);
			};
			describes('getSettings');
			describes('getCapabilities');
		}

		/** the ids of `args` from `from` on, each a MediaStream */
		const streamIds = (
			args: unknown[],
			from: number,
			name: string,
			on: string,
		): string[] => {
			const ids: string[] = [];
			for (let at = from; at < args.length; at++) {
				const id = streamIdOf(args[at]);
				if (id === null)
					throw new RealmTypeError(
						`Failed to execute '${name}' on '${on}': parameter ${at + 1} is not of type 'MediaStream'.`,
					);
				if (!ids.includes(id)) ids.push(id);
			}
			return ids;
		};
		/** an encoding as getParameters lists one: the members in name order */
		const encodingOf = (given: Record<string, unknown>) => {
			const encoding: Record<string, unknown> = {
				active: given.active !== false,
				adaptivePtime: !!given.adaptivePtime,
			};
			if (given.maxBitrate !== undefined)
				encoding.maxBitrate = Number(given.maxBitrate);
			encoding.networkPriority = given.networkPriority ?? 'low';
			encoding.priority = given.priority ?? 'low';
			return encoding;
		};
		/**
		 * A transceiver. `added` is what the worker hears of one the page
		 * made (the sender's streams and name); one the peer offered first is
		 * the worker's already. `remoteId` is the id the peer gave what it
		 * sends: the receiver's track has it.
		 */
		const makeSlot = (
			state: PeerState,
			handle: number,
			kind: 'audio' | 'video',
			direction: Direction,
			track: MediaStreamTrack | null,
			added: { streams: string[]; id: string; byTrack: boolean } | null,
			remoteId?: string,
		): MediaSlot => {
			const remote = Reflect.construct(Generator!, [
				{ kind },
			]) as MediaStreamTrack;
			const writable = Reflect.apply(writableOf!, remote, []) as WritableStream;
			Reflect.setPrototypeOf(remote, NativeTrack!.prototype);
			shared.tracks.set(remote, {
				id: remoteId,
				label: `remote ${kind}`,
				muted: true,
			});
			const part = (
				Native: Function,
				table: WeakMap<object, Members>,
				members: Members,
			) => {
				const object = objectCreate(Native.prototype) as object;
				table.set(object, members);
				return object;
			};
			const slot: MediaSlot = {
				pc: state,
				handle,
				kind,
				mid: null,
				direction,
				current: null,
				stopping: false,
				stopped: false,
				transceiver: part(
					NativeTransceiver!,
					shared.transceivers,
					transceiverMembers,
				),
				sender: part(NativeSender!, shared.senders, senderMembers),
				receiver: part(NativeReceiver!, shared.receivers, receiverMembers),
				track,
				remote,
				remoteStreams: [],
				receptive: false,
				live: false,
				sent: false,
				offered: null,
				theirs: null,
				restated: false,
				encoding: encodingOf({}),
				transaction: null,
				jitter: null,
				events: false,
				dtmf: null,
				source: track ? ++sourceSerial : 0,
			};
			mediaSlots.set(slot.transceiver, slot);
			mediaSlots.set(slot.sender, slot);
			mediaSlots.set(slot.receiver, slot);
			state.slots.push(slot);
			if (added)
				state
					.call({
						op: 'addMedia',
						handle,
						kind,
						direction,
						streams: added.streams,
						track: added.id,
						byTrack: added.byTrack,
					})
					.catch(() => {});
			state
				.call({ op: 'receiveTrack', handle, writable }, [writable])
				.catch(() => {});
			return slot;
		};
		/** the sender's track to the worker: a stream of its frames, or none */
		const sendTrack = (slot: MediaSlot) => {
			let readable: ReadableStream | null = null;
			if (slot.track)
				try {
					if (Reflect.apply(trackState!, slot.track, []) === 'live')
						readable = Reflect.apply(
							readableOf!,
							Reflect.construct(Processor!, [{ track: slot.track }]),
							[],
						);
				} catch (error) {
					// a track the browser will not read: nothing is sent
				}
			return slot.pc.call(
				{ op: 'sendTrack', handle: slot.handle, readable },
				readable ? [readable] : [],
			);
		};
		const setDirection = (slot: MediaSlot, direction: Direction) => {
			slot.direction = direction;
			slot.pc
				.call({ op: 'mediaDirection', handle: slot.handle, direction })
				.catch(() => {});
		};
		/** the receiver's track is over: `ended`, as the browser fires it for a stopped transceiver */
		const endRemote = (slot: MediaSlot) => {
			if (Reflect.apply(trackState!, slot.remote, []) === 'ended') return;
			Reflect.apply(stopTrack, slot.remote, []);
			slot.remote.dispatchEvent(new RealmEvent('ended'));
		};
		const setMuted = (slot: MediaSlot, muted: boolean) => {
			const shown = shared.tracks.get(slot.remote)!;
			if (shown.muted === muted) return;
			shown.muted = muted;
			slot.remote.dispatchEvent(new RealmEvent(muted ? 'mute' : 'unmute'));
		};
		/** the transceivers call for an offer (the specification's check, for what a page can change here) */
		const mediaNeeds = (state: PeerState) =>
			state.slots.some((slot) => {
				if (slot.stopped) return false;
				if (slot.stopping) return slot.mid !== null;
				if (slot.mid === null) return true;
				if (slot.current === null) return false;
				if (slot.restated && sends(slot.direction)) return true;
				if (state.localOffer)
					return (
						slot.direction !== slot.offered && slot.direction !== slot.current
					);
				const theirs = slot.theirs ?? 'inactive';
				return (
					slot.current !==
					directionOf(
						sends(slot.direction) && receives(theirs),
						receives(slot.direction) && sends(theirs),
					)
				);
			});
		const ufragOf = (description: { sdp: string } | null) =>
			description
				? (/^a=ice-ufrag:(.*)$/m.exec(description.sdp)?.[1] ?? '')
				: '';
		/** the specification's check: an offer is called for */
		const needs = (state: PeerState) =>
			(state.restart !== null &&
				state.restart === ufragOf(state.currentLocal)) ||
			!state.currentLocal ||
			// a channel counts from createDataChannel on, before the worker
			// has numbered it
			((state.created.length > 0 || state.channels.size > 0) &&
				!/^m=application /m.test(state.currentLocal.sdp)) ||
			mediaNeeds(state);
		/**
		 * The specification's "update the negotiation-needed flag": the event
		 * comes once for whatever calls for an offer, and not again until a
		 * negotiation has ended and something still does
		 */
		const negotiate = (state: PeerState) => {
			if (state.closed) return;
			// the operations under way come first: the flag is updated when
			// the last of them is done
			if (state.busy) {
				state.updateOnEmpty = true;
				return;
			}
			if (state.signalingState !== 'stable') return;
			if (!needs(state)) {
				state.needsNegotiation = false;
				return;
			}
			if (state.needsNegotiation) return;
			state.needsNegotiation = true;
			queue(() => {
				if (state.closed) return;
				if (state.busy) {
					state.needsNegotiation = false;
					state.updateOnEmpty = true;
					return;
				}
				if (state.signalingState !== 'stable') return;
				if (!needs(state)) {
					state.needsNegotiation = false;
					return;
				}
				state.target.dispatchEvent(new RealmEvent('negotiationneeded'));
			});
		};
		/**
		 * A description was set: the worker's sections onto the transceivers
		 * (`remote`: the peer's description; `answer`: it ends a negotiation).
		 * What the page is told of it comes after the signaling state has
		 * changed, in the browser's order: tracks muted, tracks out of
		 * streams, tracks into streams, then a `track` event for each
		 * receiver the peer now sends to.
		 */
		const settle = (
			state: PeerState,
			reply: unknown,
			remote: boolean,
			answer: boolean,
		): (() => void) => {
			const muted: MediaSlot[] = [];
			const leaves: [MediaStream, MediaSlot][] = [];
			const joins: [MediaStream, MediaSlot][] = [];
			const announced: MediaSlot[] = [];
			const fresh = new Set<MediaStream>();
			const medias: MediaSection[] = (reply as Negotiated | null)?.medias ?? [];
			for (const section of medias) {
				let slot = state.slots.find((known) => known.handle === section.handle);
				if (!slot) {
					// a section the peer offered first
					if (!hasMedia || section.handle >= 0 || section.stopped) continue;
					slot = makeSlot(
						state,
						section.handle,
						section.kind,
						'recvonly',
						null,
						null,
						section.remote?.track ?? undefined,
					);
				}
				slot.mid = section.mid;
				slot.events = !!section.dtmf;
				if (section.mid === null) continue;
				if (section.stopped) {
					if (!slot.stopping) {
						slot.stopping = true;
						endRemote(slot);
					}
					if (remote || answer) slot.current = 'stopped';
					// out of the connection: it has no name any more
					if (answer) {
						slot.stopped = true;
						slot.mid = null;
					}
					slot.receptive = false;
					for (const stream of slot.remoteStreams) leaves.push([stream, slot]);
					continue;
				}
				if (answer) {
					slot.current = section.direction;
					if (section.direction && sends(section.direction)) slot.sent = true;
				}
				if (!remote) {
					if (!answer) slot.offered = slot.direction;
					slot.restated = false;
					continue;
				}
				const theirs = section.remote;
				if (!theirs) continue;
				slot.theirs = theirs.direction;
				if (sends(theirs.direction)) {
					for (const stream of slot.remoteStreams)
						if (!theirs.streams.includes(streamIdOf(stream)!))
							leaves.push([stream, slot]);
					for (const id of theirs.streams) {
						let stream = state.remoteStreams.get(id);
						if (!stream) {
							stream = Reflect.construct(NativeStream!, []) as MediaStream;
							shared.streams.set(stream, id);
							state.remoteStreams.set(id, stream);
							fresh.add(stream);
						}
						if (!slot.remoteStreams.includes(stream))
							joins.push([stream, slot]);
					}
					if (!slot.receptive) {
						slot.receptive = true;
						announced.push(slot);
					}
				} else if (slot.receptive) {
					slot.receptive = false;
					slot.live = false;
					muted.push(slot);
					for (const stream of slot.remoteStreams) leaves.push([stream, slot]);
				}
			}
			if (answer) {
				state.localOffer = !remote;
				state.slots = state.slots.filter((slot) => !slot.stopped);
			}
			return () => {
				for (const slot of muted) setMuted(slot, true);
				for (const [stream, slot] of leaves) {
					slot.remoteStreams = slot.remoteStreams.filter(
						(known) => known !== stream,
					);
					Reflect.apply(streamRemove, stream, [slot.remote]);
					stream.dispatchEvent(
						new NativeStreamTrackEvent!('removetrack', { track: slot.remote }),
					);
					// a stream nothing is left in is not the peer's stream of
					// that name any more
					if (
						!state.slots.some((other) => other.remoteStreams.includes(stream))
					)
						state.remoteStreams.delete(streamIdOf(stream)!);
				}
				for (const [stream, slot] of joins) {
					slot.remoteStreams.push(stream);
					Reflect.apply(streamAdd, stream, [slot.remote]);
					if (!fresh.has(stream))
						stream.dispatchEvent(
							new NativeStreamTrackEvent!('addtrack', { track: slot.remote }),
						);
				}
				for (const slot of announced) {
					const event = new RealmEvent('track');
					Reflect.setPrototypeOf(event, NativeTrackEvent!.prototype);
					shared.trackEvents.set(event, trackEventMembers);
					const streams = new RealmArray();
					for (const stream of slot.remoteStreams) streams.push(stream);
					trackEvents.set(event, {
						receiver: slot.receiver,
						track: slot.remote,
						streams: Object.freeze(streams),
						transceiver: slot.transceiver,
					});
					state.target.dispatchEvent(event);
					// media that came before the description did
					if (slot.live) queue(() => setMuted(slot, false));
				}
			};
		};
		const noMedia = (name: string) =>
			domException(
				method(name, 'not supported through the proxy yet'),
				'NotSupportedError',
			);
		const closedState = (name: string) =>
			domException(
				method(name, "The RTCPeerConnection's signalingState is 'closed'."),
				'InvalidStateError',
			);

		// --- RTCPeerConnection ---

		const peerMembers = noMembers();
		interface PeerState {
			target: MockPeerConnection;
			port: MessagePort | null;
			seq: number;
			pending: Map<
				number,
				{ resolve: (value: unknown) => void; reject: (error: Error) => void }
			>;
			call(
				request: Unsequenced<Request>,
				transfer?: Transferable[],
			): Promise<unknown>;
			config: Configuration;
			signalingState: RTCSignalingState;
			iceGatheringState: RTCIceGatheringState;
			iceConnectionState: RTCIceConnectionState;
			connectionState: RTCPeerConnectionState;
			currentLocal: Description | null;
			pendingLocal: Description | null;
			currentRemote: Description | null;
			pendingRemote: Description | null;
			/** the local description the stack renders now (candidates included) */
			liveLocal: string | null;
			/** what createOffer/createAnswer last handed the page */
			generatedLocal: string | null;
			/** the remote description's sections: each one's mid */
			remoteMids: (string | null)[];
			/** candidates the page added, as the remote description shows them */
			remoteCandidates: { section: number; line: string }[];
			channels: Map<number, MockDataChannel>;
			/** the channels createDataChannel made */
			created: MockDataChannel[];
			/** the transceivers, in the order they were made */
			slots: MediaSlot[];
			/** the number of the next transceiver the page makes */
			nextHandle: number;
			/** this side made the offer of the last negotiation */
			localOffer: boolean;
			/** the peer's streams, by the id it gave them */
			remoteStreams: Map<string, MediaStream>;
			/** the ICE user name restartIce() wants replaced, until it is */
			restart: string | null;
			/** the specification's negotiation-needed flag */
			needsNegotiation: boolean;
			/** operations on the chain: the flag is updated once it empties */
			busy: number;
			/** the flag was to be updated while operations were under way */
			updateOnEmpty: boolean;
			/** channels that opened, and those of them that closed before the connection did */
			channelsOpened: number;
			channelsClosed: number;
			/** the candidates the page has heard of, as their lines read */
			heard: Set<string>;
			net: NetState;
			chain: Promise<unknown>;
			closed: boolean;
		}
		const peerStates = new WeakMap<object, PeerState>();
		const peerOf = (that: unknown): PeerState => {
			const state = peerStates.get(that as object);
			if (!state) throw illegal();
			return state;
		};

		const queue = (fn: () => void) => RealmPromise.resolve().then(fn);

		// --- pc.sctp: the RTCSctpTransport, its RTCDtlsTransport and RTCIceTransport ---

		/**
		 * What the transports read, kept from the connection's start; their
		 * objects are made when the page first asks for pc.sctp, as event
		 * targets on the browser's own prototypes. As measured on Chrome 152
		 * and 156: the ICE transport's role and parameters are null and it
		 * lists no remote candidates; the SCTP and DTLS transports say
		 * closed inside close(), the ICE transport too, without an event.
		 * Where the two versions differ (the DTLS transport's event on
		 * close) isLegacy() tells them apart, as for the configuration.
		 */
		interface NetState {
			sctp: EventTarget | null;
			dtls: EventTarget | null;
			ice: EventTarget | null;
			sctpState: RTCSctpTransportState;
			dtlsState: RTCDtlsTransportState;
			iceState: RTCIceTransportState;
			gathering: RTCIceGathererState;
			maxChannels: number | null;
			/** the peer's certificate (DER), once the handshake showed it */
			certificates: ArrayBuffer[];
			/** the DTLS handshake is done: the transports say so after the connection does */
			handshaken: boolean;
			/** the gathered candidates, as getLocalCandidates() lists them */
			locals: RTCIceCandidate[];
			pair: { local: RTCIceCandidate; remote: RTCIceCandidate } | null;
		}
		const freshNet = (): NetState => ({
			sctp: null,
			dtls: null,
			ice: null,
			sctpState: 'connecting',
			dtlsState: 'new',
			iceState: 'new',
			gathering: 'new',
			maxChannels: null,
			certificates: [],
			handshaken: false,
			locals: [],
			pair: null,
		});
		const NativeSctp = live.RTCSctpTransport as Function | undefined;
		const NativeDtls = live.RTCDtlsTransport as Function | undefined;
		const NativeIceTransport = live.RTCIceTransport as Function | undefined;
		const hasTransports = [NativeSctp, NativeDtls, NativeIceTransport].every(
			(made) => typeof made === 'function',
		);
		const netOf = new WeakMap<object, PeerState>();
		const ownerOf = (that: unknown): PeerState => {
			const state = netOf.get(that as object);
			if (!state) throw illegal();
			return state;
		};
		/** a candidate as the transport hands one out: no section, and the server it came from */
		const transportCandidate = (
			line: string,
			usernameFragment: string,
			url: string,
			relayProtocol: string | null,
		) => {
			const candidate = new NativeIceCandidate({
				candidate: line,
				sdpMid: '',
				sdpMLineIndex: 0,
				usernameFragment,
			});
			candidateOrigins.set(candidate, { url, relayProtocol });
			return candidate;
		};
		const realmList = <T>(items: T[]) => {
			const list = new RealmArray() as T[];
			for (const item of items) list[list.length] = item;
			return list;
		};
		class SctpMembers {
			get transport() {
				const state = ownerOf(this);
				return state.net.dtls;
			}
			get state() {
				return ownerOf(this).net.sctpState;
			}
			// the peer's limit once both descriptions are there
			get maxMessageSize() {
				const state = ownerOf(this);
				return (state.currentLocal ?? state.pendingLocal) &&
					(state.currentRemote ?? state.pendingRemote)
					? messageLimit(state)
					: null;
			}
			get maxChannels() {
				return ownerOf(this).net.maxChannels;
			}
		}
		class DtlsMembers {
			get iceTransport() {
				return ownerOf(this).net.ice;
			}
			get state() {
				return ownerOf(this).net.dtlsState;
			}
			getRemoteCertificates() {
				return realmList(
					ownerOf(this).net.certificates.map((der) => der.slice(0)),
				);
			}
		}
		class IceTransportMembers {
			get role() {
				ownerOf(this);
				return null;
			}
			get state() {
				return ownerOf(this).net.iceState;
			}
			get gatheringState() {
				return ownerOf(this).net.gathering;
			}
			getLocalCandidates() {
				return realmList(ownerOf(this).net.locals);
			}
			getRemoteCandidates() {
				ownerOf(this);
				return new RealmArray();
			}
			getLocalParameters() {
				ownerOf(this);
				return null;
			}
			getRemoteParameters() {
				ownerOf(this);
				return null;
			}
			getSelectedCandidatePair() {
				const { pair } = ownerOf(this).net;
				return pair && { local: pair.local, remote: pair.remote };
			}
		}
		const transportMembers = (
			Native: Function | undefined,
			Mock: Function,
			name: string,
		) => {
			if (!hasTransports) return noMembers();
			const members = adopt(Native!, Mock, shared.transports, name);
			for (const key of Reflect.ownKeys(Native!.prototype))
				if (typeof key === 'string' && key.startsWith('on'))
					members[key] = handlerAttribute(key.slice(2));
			return members;
		};
		const sctpMembers = transportMembers(
			NativeSctp,
			SctpMembers,
			'RTCSctpTransport',
		);
		const dtlsMembers = transportMembers(
			NativeDtls,
			DtlsMembers,
			'RTCDtlsTransport',
		);
		const iceTransportMembers = transportMembers(
			NativeIceTransport,
			IceTransportMembers,
			'RTCIceTransport',
		);
		const transportObject = (
			state: PeerState,
			Native: Function,
			members: Members,
		) => {
			const object = Reflect.construct(RealmEventTarget, []) as EventTarget;
			Reflect.setPrototypeOf(object, Native.prototype);
			shared.transports.set(object, members);
			netOf.set(object, state);
			return object;
		};
		/** pc.sctp: there while a description has a data section */
		const sctpOf = (state: PeerState): EventTarget | null => {
			const net = state.net;
			const described = [
				state.pendingLocal,
				state.currentLocal,
				state.pendingRemote,
				state.currentRemote,
			].some(
				(description) =>
					description && /^m=application /m.test(description.sdp),
			);
			if (!hasTransports || !described) {
				// a rollback of the first offer takes them away
				net.sctp = net.dtls = net.ice = null;
				return null;
			}
			if (!net.sctp) {
				net.gathering = state.iceGatheringState;
				net.ice = transportObject(
					state,
					NativeIceTransport!,
					iceTransportMembers,
				);
				net.dtls = transportObject(state, NativeDtls!, dtlsMembers);
				net.sctp = transportObject(state, NativeSctp!, sctpMembers);
			}
			return net.sctp;
		};
		const changed = (target: EventTarget | null, type = 'statechange') =>
			target?.dispatchEvent(new RealmEvent(type));

		class MockPeerConnection extends based(
			RealmEventTarget,
			ctx.standIns.RTCPeerConnection,
		) {
			constructor(configurationInit?: RTCConfiguration) {
				super();
				shared.peers.set(this, peerMembers);
				const shown = refusing(
					"Failed to construct 'RTCPeerConnection'",
					() => {
						const converted = configuration(
							configurationInit,
							isLegacy(),
							expires,
						);
						const refusal = serversRefusal(converted.iceServers);
						if (refusal) throw refusal;
						return converted;
					},
				);
				counted(this);
				const state: PeerState = {
					target: this,
					port: null,
					seq: 0,
					pending: new Map(),
					call: (request, transfer = []) =>
						new RealmPromise((resolve, reject) => {
							if (!state.port) {
								reject(new RealmDOMException('closed', 'InvalidStateError'));
								return;
							}
							const seq = ++state.seq;
							state.pending.set(seq, { resolve, reject });
							Reflect.apply(portPost, state.port, [
								{ seq, ...request },
								transfer,
							]);
						}),
					config: shown,
					signalingState: 'stable',
					iceGatheringState: 'new',
					iceConnectionState: 'new',
					connectionState: 'new',
					currentLocal: null,
					pendingLocal: null,
					currentRemote: null,
					pendingRemote: null,
					liveLocal: null,
					generatedLocal: null,
					remoteMids: [],
					remoteCandidates: [],
					channels: new Map(),
					created: [],
					slots: [],
					nextHandle: 0,
					localOffer: false,
					remoteStreams: new Map(),
					restart: null,
					needsNegotiation: false,
					busy: 0,
					updateOnEmpty: false,
					channelsOpened: 0,
					channelsClosed: 0,
					heard: new Set(),
					net: freshNet(),
					chain: RealmPromise.resolve(),
					closed: false,
				};
				peerStates.set(this, state);
				const [kept, handed] = privateChannel();
				state.port = kept;
				onPort(kept, 'message', (data) =>
					onWorkerMessage(state, data as WorkerMessage),
				);
				Reflect.apply(workerPost, startWorker(), [
					{
						kind: 'connection',
						port: handed,
						config: forWorker(shown),
					} satisfies RtcWorkerConnection,
					[handed],
				]);
			}

			get signalingState() {
				return peerOf(this).signalingState;
			}
			get iceGatheringState() {
				return peerOf(this).iceGatheringState;
			}
			get iceConnectionState() {
				return peerOf(this).iceConnectionState;
			}
			get connectionState() {
				return peerOf(this).connectionState;
			}
			get canTrickleIceCandidates() {
				const state = peerOf(this);
				const remote = state.pendingRemote ?? state.currentRemote;
				// nothing to say of a description without a section
				if (!remote || !/^m=/m.test(remote.sdp)) return null;
				return /^a=ice-options:(?:.* )?trickle(?: |\r?$)/m.test(remote.sdp);
			}
			get sctp() {
				return sctpOf(peerOf(this));
			}
			get localDescription() {
				const state = peerOf(this);
				return describe(state, state.pendingLocal ?? state.currentLocal, true);
			}
			get currentLocalDescription() {
				const state = peerOf(this);
				return describe(state, state.currentLocal, true);
			}
			get pendingLocalDescription() {
				const state = peerOf(this);
				return describe(state, state.pendingLocal, true);
			}
			get remoteDescription() {
				const state = peerOf(this);
				return describe(
					state,
					state.pendingRemote ?? state.currentRemote,
					false,
				);
			}
			get currentRemoteDescription() {
				const state = peerOf(this);
				return describe(state, state.currentRemote, false);
			}
			get pendingRemoteDescription() {
				const state = peerOf(this);
				return describe(state, state.pendingRemote, false);
			}

			getConfiguration() {
				const { config } = peerOf(this);
				return {
					...config,
					// each reading has objects of its own for the certificates
					certificates: config.certificates.map((certificate) =>
						realmClone(certificate),
					),
					iceServers: config.iceServers.map((server) => ({
						...server,
						urls: [...server.urls],
					})),
				};
			}
			setConfiguration(configurationInit?: RTCConfiguration) {
				const state = peerOf(this);
				const context = method('setConfiguration', '').slice(0, -2);
				const next = refusing(context, () => {
					// the dictionary's own errors come before a closed connection's
					const read = () =>
						configuration(configurationInit, isLegacy(), expires);
					if (!state.closed) return read();
					try {
						read();
					} catch (error) {
						if (
							!(error instanceof Refusal) ||
							/^Failed to read |^The provided value is not of type/.test(
								error.message,
							)
						)
							throw error;
					}
					throw new Refusal(
						'InvalidStateError',
						"The RTCPeerConnection's signalingState is 'closed'.",
					);
				});
				const now = state.config;
				// what a connection keeps for life, and the pool once it has
				// a local description
				if (
					next.certificates.length ||
					next.bundlePolicy !== now.bundlePolicy ||
					next.rtcpMuxPolicy !== now.rtcpMuxPolicy ||
					next.encodedInsertableStreams !== now.encodedInsertableStreams ||
					// Chrome 152 lets this one change, 156 does not
					(!isLegacy() &&
						next.alwaysNegotiateDataChannels !==
							now.alwaysNegotiateDataChannels) ||
					(next.iceCandidatePoolSize !== now.iceCandidatePoolSize &&
						(state.pendingLocal || state.currentLocal))
				)
					throw domException(
						`${context}: Attempted to modify the PeerConnection's configuration in an unsupported way.`,
						'InvalidModificationError',
					);
				const refusal = serversRefusal(next.iceServers);
				if (refusal)
					throw domException(
						`${context}: The given configuration has ${refusal.name === 'SyntaxError' ? 'a syntax error' : 'invalid parameters'}.`,
						refusal.name,
					);
				next.certificates = now.certificates;
				state.config = next;
				state
					.call({ op: 'setConfiguration', config: forWorker(next) })
					.catch(() => {});
			}

			createOffer(...args: any[]) {
				const state = peerOf(this);
				const legacy = typeof args[0] === 'function';
				const options = (legacy ? args[2] : args[0]) as
					RTCOfferOptions | undefined;
				const result = chained(state, 'createOffer', async () => {
					// the legacy options: a transceiver to receive on where
					// there is none of the kind, or none that receives
					if (hasMedia && isObject(options))
						for (const kind of ['audio', 'video'] as const) {
							const receive = (options as Record<string, unknown>)[
								kind === 'audio' ? 'offerToReceiveAudio' : 'offerToReceiveVideo'
							];
							if (receive === undefined) continue;
							const slots = state.slots.filter(
								(slot) => slot.kind === kind && !slot.stopping,
							);
							if (!receive) {
								for (const slot of slots)
									if (receives(slot.direction))
										setDirection(
											slot,
											directionOf(sends(slot.direction), false),
										);
							} else if (!slots.length)
								makeSlot(state, state.nextHandle++, kind, 'recvonly', null, {
									streams: [],
									id: uuid(),
									byTrack: false,
								});
						}
					const sdp = (await state.call({
						op: 'createOffer',
						iceRestart: !!options?.iceRestart,
					})) as string;
					state.generatedLocal = sdp;
					return { type: 'offer', sdp } as RTCSessionDescriptionInit;
				});
				return legacyForm(
					result,
					legacy ? args[0] : null,
					legacy ? args[1] : null,
				);
			}
			createAnswer(...args: any[]) {
				const state = peerOf(this);
				const legacy = typeof args[0] === 'function';
				const result = chained(state, 'createAnswer', async () => {
					if (
						state.signalingState !== 'have-remote-offer' &&
						state.signalingState !== 'have-local-pranswer'
					)
						throw new RealmDOMException(
							method(
								'createAnswer',
								`PeerConnection cannot create an answer in a state other than have-remote-offer or have-local-pranswer.`,
							),
							'InvalidStateError',
						);
					const sdp = (await state.call({ op: 'createAnswer' })) as string;
					state.generatedLocal = sdp;
					return { type: 'answer', sdp } as RTCSessionDescriptionInit;
				});
				return legacyForm(
					result,
					legacy ? args[0] : null,
					legacy ? args[1] : null,
				);
			}
			setLocalDescription(...args: any[]) {
				const state = peerOf(this);
				const init = args[0];
				const legacy = typeof args[1] === 'function';
				const result = chained(state, 'setLocalDescription', async () => {
					let type: string | undefined;
					let sdp: string | undefined;
					if (init !== null && init !== undefined && typeof init === 'object') {
						type = init.type === undefined ? undefined : String(init.type);
						sdp = init.sdp === undefined ? undefined : String(init.sdp);
					}
					if (type === undefined || type === '') {
						// the implicit form: what the state calls for
						type =
							state.signalingState === 'have-remote-offer' ||
							state.signalingState === 'have-local-pranswer'
								? 'answer'
								: 'offer';
						if (state.signalingState === 'have-local-offer') type = 'offer';
					}
					if (
						type !== 'offer' &&
						type !== 'answer' &&
						type !== 'rollback' &&
						type !== 'pranswer'
					)
						throw new TypeError(
							method(
								'setLocalDescription',
								`The provided value '${type}' is not a valid enum value of type RTCSdpType.`,
							),
						);
					if (type === 'rollback') {
						if (
							state.signalingState !== 'have-local-offer' &&
							state.signalingState !== 'have-remote-offer'
						)
							throw wrongState(
								'setLocalDescription',
								'local',
								'rollback',
								state.signalingState,
							);
						const after = settle(
							state,
							await state.call({ op: 'setLocal', type: 'rollback' }),
							false,
							false,
						);
						state.pendingLocal = null;
						state.pendingRemote = null;
						setSignaling(state, 'stable');
						after();
						return;
					}
					if (type === 'offer') {
						if (
							state.signalingState !== 'stable' &&
							state.signalingState !== 'have-local-offer'
						)
							throw wrongState(
								'setLocalDescription',
								'local',
								'offer',
								state.signalingState,
							);
						if (sdp === undefined || sdp === '') {
							sdp = (await state.call({
								op: 'createOffer',
								iceRestart: false,
							})) as string;
							state.generatedLocal = sdp;
						}
						const after = settle(
							state,
							await state.call({ op: 'setLocal', type: 'offer' }),
							false,
							false,
						);
						// the rendering with its candidates comes as they are
						// gathered; the last description's is not this one's
						state.liveLocal = null;
						state.pendingLocal = { type: 'offer', sdp };
						setSignaling(state, 'have-local-offer');
						after();
						return;
					}
					// answer, pranswer
					if (
						state.signalingState !== 'have-remote-offer' &&
						state.signalingState !== 'have-local-pranswer'
					)
						throw wrongState(
							'setLocalDescription',
							'local',
							type,
							state.signalingState,
						);
					if (sdp === undefined || sdp === '') {
						sdp = (await state.call({ op: 'createAnswer' })) as string;
						state.generatedLocal = sdp;
					}
					const after = settle(
						state,
						await state.call({ op: 'setLocal', type: 'answer' }),
						false,
						type === 'answer',
					);
					state.liveLocal = null;
					if (type === 'pranswer') {
						state.pendingLocal = { type: 'pranswer', sdp };
						setSignaling(state, 'have-local-pranswer');
						after();
						return;
					}
					state.currentLocal = { type: 'answer', sdp };
					state.pendingLocal = null;
					state.currentRemote = state.pendingRemote ?? state.currentRemote;
					state.pendingRemote = null;
					setSignaling(state, 'stable');
					after();
				});
				return legacyForm(
					result,
					legacy ? args[1] : null,
					legacy ? args[2] : null,
					true,
				);
			}
			setRemoteDescription(...args: any[]) {
				const state = peerOf(this);
				const name = 'setRemoteDescription';
				const legacy = typeof args[1] === 'function';
				// the dictionary first, a closed connection next, then the text:
				// all three before the operation takes its turn
				let type: string | undefined;
				let sdp = '';
				const init = args[0];
				if (!args.length)
					return rejectedWith(
						new RealmTypeError(
							method(name, '1 argument required, but only 0 present.'),
						),
					);
				if (init !== undefined && init !== null) {
					if (!isObject(init))
						return rejectedWith(
							new RealmTypeError(
								method(
									name,
									"The provided value is not of type 'RTCSessionDescriptionInit'.",
								),
							),
						);
					try {
						if (init.sdp !== undefined) sdp = `${init.sdp}`;
						if (init.type !== undefined) type = `${init.type}`;
					} catch (error) {
						return rejectedWith(error);
					}
					if (
						type !== undefined &&
						type !== 'offer' &&
						type !== 'answer' &&
						type !== 'rollback' &&
						type !== 'pranswer'
					)
						return rejectedWith(
							new RealmTypeError(
								method(
									name,
									`Failed to read the 'type' property from 'RTCSessionDescriptionInit': The provided value '${type}' is not a valid enum value of type RTCSdpType.`,
								),
							),
						);
				}
				if (state.closed) return chained(state, name, async () => {});
				let parsed: Parsed | null = null;
				if (type !== 'rollback') {
					const read =
						type === undefined
							? { line: '', description: '' }
							: parseDescription(sdp);
					if ('description' in read) {
						const words = `Failed to parse SessionDescription. ${read.line} ${read.description}`;
						if (!legacy) return rejected(method(name, words), 'OperationError');
						// the old form is told at once, in its own words
						if (typeof args[2] === 'function')
							Reflect.apply(args[2], undefined, [
								new RealmDOMException(words, 'OperationError'),
							]);
						return RealmPromise.resolve();
					}
					parsed = read;
				}
				const result = chained(state, name, async () => {
					if (type === 'rollback') {
						if (
							state.signalingState !== 'have-local-offer' &&
							state.signalingState !== 'have-remote-offer'
						)
							throw wrongState(
								name,
								'remote',
								'rollback',
								state.signalingState,
							);
						const after = settle(
							state,
							await state.call({ op: 'setRemote', type: 'rollback', sdp: '' }),
							false,
							false,
						);
						state.pendingLocal = null;
						state.pendingRemote = null;
						setSignaling(state, 'stable');
						after();
						return;
					}
					const offer = type === 'offer';
					if (
						offer
							? state.signalingState !== 'stable' &&
								state.signalingState !== 'have-local-offer' &&
								state.signalingState !== 'have-remote-offer'
							: state.signalingState !== 'have-local-offer' &&
								state.signalingState !== 'have-remote-pranswer'
					)
						throw wrongState(name, 'remote', type!, state.signalingState);
					// an offer over the connection's own takes that one back first
					if (offer && state.signalingState === 'have-local-offer') {
						const back = settle(
							state,
							await state.call({ op: 'setRemote', type: 'rollback', sdp: '' }),
							false,
							false,
						);
						state.pendingLocal = null;
						setSignaling(state, 'stable');
						back();
					}
					const refusal = remoteRefusal(
						parsed!,
						offer,
						parsedOf(
							offer
								? (state.pendingLocal ?? state.currentLocal)
								: state.pendingLocal,
						),
						parsedOf(state.pendingRemote ?? state.currentRemote),
					);
					if (refusal)
						throw new RealmDOMException(
							method(name, `Failed to set remote ${type} sdp: ${refusal}`),
							'InvalidAccessError',
						);
					const after = settle(
						state,
						await stackCall(state, name, `remote ${type}`, {
							op: 'setRemote',
							type: offer ? 'offer' : 'answer',
							sdp,
						}),
						true,
						type === 'answer',
					);
					state.remoteMids = parsed!.sections.map((section) => section.mid);
					state.remoteCandidates = [];
					if (offer) {
						state.pendingRemote = { type: 'offer', sdp };
						setSignaling(state, 'have-remote-offer');
						after();
						return;
					}
					if (type === 'pranswer') {
						state.pendingRemote = { type: 'pranswer', sdp };
						setSignaling(state, 'have-remote-pranswer');
						after();
						return;
					}
					state.currentRemote = { type: 'answer', sdp };
					state.pendingRemote = null;
					state.currentLocal = state.pendingLocal ?? state.currentLocal;
					state.pendingLocal = null;
					setSignaling(state, 'stable');
					after();
				});
				return legacyForm(
					result,
					legacy ? args[1] : null,
					legacy ? args[2] : null,
					true,
				);
			}
			addIceCandidate(...args: any[]) {
				const state = peerOf(this);
				const name = 'addIceCandidate';
				const init = args[0];
				const legacy = typeof args[1] === 'function';
				let candidate = '';
				let sdpMid: string | null = null;
				let sdpMLineIndex: number | null = null;
				if (init !== undefined && init !== null) {
					if (!isObject(init))
						return rejectedWith(
							new RealmTypeError(
								method(
									name,
									"The provided value is not of type 'RTCIceCandidateInit'.",
								),
							),
						);
					try {
						if (init.candidate !== undefined) candidate = `${init.candidate}`;
						if (init.sdpMLineIndex !== undefined && init.sdpMLineIndex !== null)
							sdpMLineIndex = (+init.sdpMLineIndex & 0xffff) >>> 0;
						if (init.sdpMid !== undefined && init.sdpMid !== null)
							sdpMid = `${init.sdpMid}`;
					} catch (error) {
						return rejectedWith(error);
					}
				}
				const result = chained(state, name, async () => {
					// the end of candidates, with or without a remote description
					if (candidate === '') return;
					// a candidate for no section, before anything else is looked at
					if (sdpMid === null && sdpMLineIndex === null)
						throw new RealmTypeError(
							method(
								name,
								'Candidate missing values for both sdpMid and sdpMLineIndex',
							),
						);
					if (!state.currentRemote && !state.pendingRemote)
						throw new RealmDOMException(
							method(name, 'The remote description was null'),
							'InvalidStateError',
						);
					// the section a mid names, or the one at the index (the
					// first without one)
					const section = sdpMid
						? state.remoteMids.indexOf(sdpMid)
						: (sdpMLineIndex ?? 0) < state.remoteMids.length
							? (sdpMLineIndex ?? 0)
							: -1;
					const line = candidateLine(candidate);
					if (section < 0 || typeof line !== 'string')
						throw new RealmDOMException(
							method(name, 'Error processing ICE candidate'),
							'OperationError',
						);
					// one the browser takes and the stack cannot read (a third
					// component, ssltcp) pairs with nothing there either
					await state
						.call({
							op: 'addCandidate',
							candidate: line,
							sdpMid: state.remoteMids[section],
						})
						.catch(() => {});
					if (
						!state.remoteCandidates.some(
							(known) => known.section === section && known.line === line,
						)
					)
						state.remoteCandidates.push({ section, line });
				});
				return legacyForm(
					result,
					legacy ? args[1] : null,
					legacy ? args[2] : null,
					true,
				);
			}
			restartIce() {
				const state = peerOf(this);
				if (state.closed) return;
				state.call({ op: 'restartIce' }).catch(() => {});
				state.restart = ufragOf(state.currentLocal);
				negotiate(state);
			}
			getSenders() {
				const list = new RealmArray();
				for (const slot of peerOf(this).slots) list.push(slot.sender);
				return list;
			}
			getReceivers() {
				const list = new RealmArray();
				for (const slot of peerOf(this).slots) list.push(slot.receiver);
				return list;
			}
			getTransceivers() {
				const list = new RealmArray();
				for (const slot of peerOf(this).slots) list.push(slot.transceiver);
				return list;
			}
			addTrack(...args: unknown[]) {
				const state = peerOf(this);
				if (!hasMedia) throw noMedia('addTrack');
				if (!args.length)
					throw new RealmTypeError(
						method('addTrack', '1 argument required, but only 0 present.'),
					);
				const track = args[0] as MediaStreamTrack;
				const kind = kindOf(track);
				if (!kind)
					throw new RealmTypeError(
						method(
							'addTrack',
							"parameter 1 is not of type 'MediaStreamTrack'.",
						),
					);
				const streams = streamIds(args, 1, 'addTrack', 'RTCPeerConnection');
				if (state.closed) throw closedState('addTrack');
				if (state.slots.some((slot) => slot.track === track))
					throw domException(
						method('addTrack', 'A sender already exists for the track.'),
						'InvalidAccessError',
					);
				// a transceiver that has sent nothing takes the track: the one
				// the peer's offer made, most of all
				let slot = state.slots.find(
					(known) =>
						!known.track &&
						known.kind === kind &&
						!known.stopping &&
						!known.sent,
				);
				if (slot) {
					slot.track = track;
					slot.source = ++sourceSerial;
					state
						.call({ op: 'mediaStreams', handle: slot.handle, streams })
						.catch(() => {});
					if (!sends(slot.direction))
						setDirection(slot, directionOf(true, receives(slot.direction)));
				} else
					slot = makeSlot(state, state.nextHandle++, kind, 'sendrecv', track, {
						streams,
						id:
							shared.tracks.get(track)?.id ??
							Reflect.apply(trackId!, track, []),
						byTrack: true,
					});
				sendTrack(slot).catch(() => {});
				negotiate(state);
				return slot.sender;
			}
			addTransceiver(...args: unknown[]) {
				const state = peerOf(this);
				if (!hasMedia) throw noMedia('addTransceiver');
				if (!args.length)
					throw new RealmTypeError(
						method(
							'addTransceiver',
							'1 argument required, but only 0 present.',
						),
					);
				let track: MediaStreamTrack | null = null;
				let kind = kindOf(args[0]);
				if (kind) track = args[0] as MediaStreamTrack;
				else {
					const word = String(args[0]);
					if (word !== 'audio' && word !== 'video')
						throw new RealmTypeError(
							method(
								'addTransceiver',
								"The argument provided as parameter 1 is not a valid MediaStreamTrack kind ('audio' or 'video').",
							),
						);
					kind = word;
				}
				const init = args[1];
				if (init !== undefined && init !== null && !isObject(init))
					throw new RealmTypeError(
						method(
							'addTransceiver',
							"The provided value is not of type 'RTCRtpTransceiverInit'.",
						),
					);
				let direction: Direction = 'sendrecv';
				let streams: string[] = [];
				let encoding: unknown;
				if (isObject(init)) {
					if (init.direction !== undefined) {
						const word = String(init.direction);
						if (!DIRECTIONS.includes(word))
							throw new RealmTypeError(
								method(
									'addTransceiver',
									`Failed to read the 'direction' property from 'RTCRtpTransceiverInit': The provided value '${word}' is not a valid enum value of type RTCRtpTransceiverDirection.`,
								),
							);
						direction = word as Direction;
					}
					if (isObject(init.streams))
						streams = streamIds(
							[...(init.streams as unknown as unknown[])],
							0,
							'addTransceiver',
							'RTCPeerConnection',
						);
					if (isObject(init.sendEncodings))
						encoding = (init.sendEncodings as unknown as unknown[])[0];
				}
				if (state.closed) throw closedState('addTransceiver');
				const slot = makeSlot(
					state,
					state.nextHandle++,
					kind,
					direction,
					track,
					{
						streams,
						id: track
							? (shared.tracks.get(track)?.id ??
								Reflect.apply(trackId!, track, []))
							: uuid(),
						byTrack: false,
					},
				);
				if (isObject(encoding)) slot.encoding = encodingOf(encoding);
				if (track) sendTrack(slot).catch(() => {});
				negotiate(state);
				return slot.transceiver;
			}
			removeTrack(...args: unknown[]) {
				const state = peerOf(this);
				if (!args.length)
					throw new RealmTypeError(
						method('removeTrack', '1 argument required, but only 0 present.'),
					);
				if (!shared.senders.has(args[0] as object))
					throw new RealmTypeError(
						method('removeTrack', "parameter 1 is not of type 'RTCRtpSender'."),
					);
				if (state.closed) throw closedState('removeTrack');
				const slot = mediaSlots.get(args[0] as object);
				if (slot?.pc !== state)
					throw domException(
						method(
							'removeTrack',
							'The sender was not created by this peer connection.',
						),
						'InvalidAccessError',
					);
				if (!slot.track || slot.stopping) return;
				slot.track = null;
				slot.source = 0;
				sendTrack(slot).catch(() => {});
				if (sends(slot.direction))
					setDirection(slot, directionOf(false, receives(slot.direction)));
				negotiate(state);
			}
			createDataChannel(...args: any[]) {
				const state = peerOf(this);
				const context = method('createDataChannel', '').slice(0, -2);
				if (!args.length)
					throw new RealmTypeError(
						`${context}: 1 argument required, but only 0 present.`,
					);
				const options = refusing(context, () => {
					const init = channelInit(args[0], args[1], !isLegacy());
					if (state.closed)
						throw new Refusal(
							'InvalidStateError',
							"The RTCPeerConnection's signalingState is 'closed'.",
						);
					return channelChecked(init);
				});
				// an id another channel of the connection has
				if (options.id !== null)
					for (const other of [...state.created, ...state.channels.values()]) {
						const its = channelStates.get(other)!;
						if (its.id === options.id && its.readyState !== 'closed')
							throw domException(
								`${context}: RTCDataChannel creation failed`,
								'OperationError',
							);
					}
				const channel = new MockDataChannel(
					state,
					-1,
					options,
					options.negotiated ? options.id : null,
				);
				state.created.push(channel);
				const promise = state.call({ op: 'createChannel', options });
				promise.then(
					(index) => {
						const channelState = channelStates.get(channel)!;
						channelState.index = index as number;
						state.channels.set(index as number, channel);
					},
					() => {
						const channelState = channelStates.get(channel)!;
						channelState.readyState = 'closed';
						channel.dispatchEvent(new RealmEvent('error'));
						channel.dispatchEvent(new RealmEvent('close'));
					},
				);
				// the first channel wants an offer (an SCTP section); later ones ride on it
				negotiate(state);
				return channel;
			}
			getStats(...args: any[]) {
				const state = peerOf(this);
				if (args.length && args[0] !== null && args[0] !== undefined) {
					// a track: the report of its sender or its receiver
					const track = args[0];
					if (kindOf(track) && !state.closed) {
						const slot = state.slots.find(
							(known) => known.track === track || known.remote === track,
						);
						if (slot)
							return pickedReport(
								slot,
								slot.track === track ? 'sender' : 'receiver',
							);
						return rejected(
							method(
								'getStats',
								'There is no sender or receiver for the track.',
							),
							'InvalidAccessError',
						);
					}
					return rejected(
						method(
							'getStats',
							'The track is not associated with this RTCPeerConnection',
						),
						'InvalidAccessError',
					);
				}
				// a closed connection still answers, with its own entry alone
				if (state.closed)
					return RealmPromise.resolve(
						Reflect.construct(MockStatsReport, [statsEntries(state, null)]),
					);
				// the candidates gathered by then, as the browser's report has
				// them: none yet when it is asked as setLocalDescription resolves
				const heard = new Set(state.heard);
				return state
					.call({ op: 'stats' })
					.then((info) =>
						Reflect.construct(MockStatsReport, [
							statsEntries(state, info as StatsReply, heard),
						]),
					);
			}
			close() {
				const state = peerOf(this);
				if (state.closed) return;
				state.closed = true;
				state.call({ op: 'close' }).catch(() => {});
				for (const channel of state.channels.values()) {
					const channelState = channelStates.get(channel)!;
					if (channelState.readyState === 'closed') continue;
					channelState.readyState = 'closed';
					channel.dispatchEvent(new RealmEvent('close'));
				}
				for (const slot of state.slots) {
					slot.stopping = true;
					slot.current = 'stopped';
					slot.mid = null;
				}
				state.signalingState = 'closed';
				state.iceConnectionState = 'closed';
				state.connectionState = 'closed';
				// the transports close with it, the SCTP one saying so at once
				// (and the DTLS one in Chrome 152, not in 156), the ICE one not
				const net = state.net;
				net.pair = null;
				net.certificates = [];
				net.iceState = 'closed';
				if (net.sctpState !== 'closed') {
					net.sctpState = 'closed';
					changed(net.sctp);
				}
				if (net.dtlsState !== 'closed') {
					net.dtlsState = 'closed';
					if (isLegacy()) changed(net.dtls);
				}
				for (const { reject } of state.pending.values())
					reject(
						new RealmDOMException(
							'The RTCPeerConnection is closed',
							'InvalidStateError',
						),
					);
				state.pending.clear();
				if (state.port) closePort(state.port);
				state.port = null;
			}
		}

		// --- helpers ---

		const describe = (
			state: PeerState,
			description: Description | null,
			local: boolean,
		) => {
			if (!description) return null;
			let sdp = description.sdp;
			// the live rendering carries the candidates gathered since; a page
			// that set a munged description reads its own text back
			if (local && state.liveLocal && sdp === state.generatedLocal)
				sdp = state.liveLocal;
			if (!local) sdp = withAdded(sdp, state.remoteCandidates);
			return new NativeSessionDescription({ type: description.type, sdp });
		};
		/** a description in force, parsed: its sections for the order checks */
		const parsedOf = (description: Description | null): Parsed | null => {
			if (!description) return null;
			const read = parseDescription(description.sdp);
			return 'sections' in read ? read : null;
		};
		/**
		 * A remote description with the candidates the page added since, as
		 * the browser writes it: their lines after the section's connection
		 * line (and the candidates it came with), and the section's port and
		 * connection line name its default candidate. The browser's choice
		 * of that one (UDP, the first component, relay over reflexive over
		 * host within an address family, never IPv6 over IPv4) lets a
		 * candidate at a name take over from one at an address, and then the
		 * lines say 0.0.0.0 and port 9.
		 */
		const withAdded = (sdp: string, added: PeerState['remoteCandidates']) => {
			if (!added.length) return sdp;
			const lines = sdp.split('\r\n');
			const out: string[] = [];
			let section = -1;
			for (let at = 0; at < lines.length;) {
				out.push(lines[at++]);
				if (!lines[at - 1].startsWith('m=')) continue;
				section++;
				const head = out.length - 1;
				const candidates: string[] = [];
				let connection = -1;
				for (
					;
					at < lines.length &&
					/^(?:[cb]=|a=rtcp:|a=candidate:)/.test(lines[at]);
					at++
				) {
					if (lines[at].startsWith('c=')) connection = out.length;
					if (lines[at].startsWith('a=c')) candidates.push(lines[at].slice(2));
					out.push(lines[at]);
				}
				let fresh = false;
				for (const entry of added)
					if (entry.section === section && !candidates.includes(entry.line)) {
						fresh = true;
						candidates.push(entry.line);
						out.push(`a=${entry.line}`);
					}
				if (!fresh) continue;
				let rank = 0;
				let family = 0;
				let address = '';
				let port = '';
				for (const candidate of candidates) {
					const fields = candidate.split(' ');
					if (
						fields.length < 8 ||
						fields[1] !== '1' ||
						fields[2].toLowerCase() !== 'udp'
					)
						continue;
					const type = fields[7];
					const its =
						type === 'host'
							? 1
							: type === 'srflx'
								? 2
								: type === 'relay'
									? 3
									: 0;
					const kind = /^[\d.]+$/.test(fields[4])
						? 4
						: fields[4].includes(':')
							? 6
							: 0;
					if ((its <= rank && kind === family) || (family === 4 && kind === 6))
						continue;
					rank = its;
					family = kind;
					address = fields[4];
					port = fields[5];
				}
				if (!family) {
					address = '0.0.0.0';
					port = '9';
				}
				out[head] = out[head].replace(/^(m=\S+) \d+/, `$1 ${port}`);
				if (connection !== -1)
					out[connection] = `c=IN IP${family === 6 ? 6 : 4} ${address}`;
			}
			return out.join('\r\n');
		};
		const setSignaling = (state: PeerState, next: RTCSignalingState) => {
			if (state.closed || state.signalingState === next) return;
			state.signalingState = next;
			state.target.dispatchEvent(new RealmEvent('signalingstatechange'));
			// a negotiation has ended: what still calls for an offer says so
			if (next === 'stable') {
				if (
					state.restart !== null &&
					state.restart !== ufragOf(state.currentLocal)
				)
					state.restart = null;
				state.needsNegotiation = false;
				negotiate(state);
			}
		};
		const wrongState = (
			name: string,
			side: string,
			type: string,
			signaling: string,
		) =>
			new RealmDOMException(
				method(
					name,
					`Failed to set ${side} ${type} sdp: Called in wrong ${type === 'rollback' ? 'signalingState' : 'state'}: ${signaling}`,
				),
				'InvalidStateError',
			);
		/** a call the stack may refuse: its error in Chrome's wording */
		const stackCall = async (
			state: PeerState,
			name: string,
			what: string,
			request: Unsequenced<Request>,
		) => {
			try {
				return await state.call(request);
			} catch (error) {
				const message = (error as Error)?.message ?? String(error);
				if ((error as Error)?.name === 'OperationError')
					throw new RealmDOMException(
						method(name, `Failed to set ${what} sdp: ${message}`),
						'InvalidAccessError',
					);
				throw error;
			}
		};
		/** operations run one after another, as the browser chains them */
		const chained = <T>(
			state: PeerState,
			name: string,
			operation: () => Promise<T>,
		): Promise<T> => {
			if (state.closed)
				return rejected(
					method(name, "The RTCPeerConnection's signalingState is 'closed'."),
					'InvalidStateError',
				) as Promise<T>;
			state.busy++;
			const run = state.chain.then(operation, operation);
			const done = () => {
				if (--state.busy || !state.updateOnEmpty) return;
				state.updateOnEmpty = false;
				negotiate(state);
			};
			// the caller hears the result before the event is thought of: what
			// it does next (the next operation, as a rule) is under way by then
			const result = new RealmPromise<T>((resolve, reject) =>
				run.then(resolve, reject),
			);
			state.chain = run.then(done, done);
			return result;
		};
		/** the legacy callback forms resolve the callbacks and answer an undefined promise */
		const legacyForm = <T>(
			promise: Promise<T>,
			success: Function | null,
			failure: Function | null,
			voidResult = false,
		): Promise<T | void> => {
			if (!success) return promise;
			return promise.then(
				(value) => {
					Reflect.apply(success, undefined, voidResult ? [] : [value]);
				},
				(error) => {
					if (typeof failure !== 'function') return;
					// the old form hears the words without the method's name
					const told =
						error instanceof RealmDOMException
							? new RealmDOMException(
									error.message.replace(
										/^Failed to execute '\w+' on 'RTCPeerConnection': /,
										'',
									),
									error.name,
								)
							: error;
					Reflect.apply(failure, undefined, [told]);
				},
			);
		};
		/** a stats selector: the sender's or the receiver's streams of one transceiver */
		interface StatsPick {
			slot: MediaSlot;
			side: 'sender' | 'receiver';
		}
		const statsEntries = (
			state: PeerState,
			info: StatsReply | null,
			heard = new Set<string>(),
			pick: StatsPick | null = null,
		) => {
			const timestamp = performance.timeOrigin + performance.now();
			const list: [string, Record<string, unknown>][] = [];
			/**
			 * An entry as Chrome writes one: id, timestamp, type, then the
			 * members it has, each dictionary's (the base's first) by name
			 */
			const add = (
				id: string,
				type: string,
				...levels: Record<string, unknown>[]
			) => {
				const entry: Record<string, unknown> = { id, timestamp, type };
				for (const members of levels)
					for (const key of Reflect.ownKeys(members).sort() as string[])
						if (members[key] !== undefined && members[key] !== null)
							entry[key] = members[key];
				list[list.length] = [id, entry];
				return entry;
			};
			add('P', 'peer-connection', {
				dataChannelsOpened: state.channelsOpened,
				dataChannelsClosed: state.channelsClosed,
			});
			if (info) {
				for (const channel of state.channels.values()) {
					const channelState = channelStates.get(channel)!;
					if (channelState.readyState === 'closed') continue;
					add(`D${channelState.serial}`, 'data-channel', {
						label: channelState.options.label,
						protocol: channelState.options.protocol,
						dataChannelIdentifier: channelState.id,
						state: channelState.readyState,
						messagesSent: channelState.messagesSent,
						bytesSent: channelState.bytesSent,
						messagesReceived: channelState.messagesReceived,
						bytesReceived: channelState.bytesReceived,
					});
				}
				// the transport is there once a description has a section for it
				const described =
					state.pendingLocal ??
					state.currentLocal ??
					state.pendingRemote ??
					state.currentRemote;
				if (described && /^m=/m.test(described.sdp)) {
					const { transport } = info;
					const certificateId = (fingerprint: string) =>
						`CF${fingerprint.slice(fingerprint.indexOf(' ') + 1)}`;
					const certificate = (fingerprint: string, base64: string) =>
						add(certificateId(fingerprint), 'certificate', {
							fingerprint: fingerprint.slice(fingerprint.indexOf(' ') + 1),
							fingerprintAlgorithm: fingerprint.slice(
								0,
								fingerprint.indexOf(' '),
							),
							base64Certificate: base64,
						});
					certificate(info.fingerprint, info.certificate);
					if (info.remoteCertificate)
						certificate(
							info.remoteCertificate.fingerprint,
							info.remoteCertificate.base64,
						);
					const paired = new Set(transport.pairs.map((pair) => pair.local));
					const locals = transport.locals.filter(
						(candidate) =>
							heard.has(candidate.line) || paired.has(candidate.id),
					);
					for (const [candidates, remote] of [
						[locals, false],
						[transport.remotes, true],
					] as const)
						for (const candidate of candidates)
							add(
								candidate.id,
								remote ? 'remote-candidate' : 'local-candidate',
								{
									transportId: 'T01',
									isRemote: remote,
									// what a browser behind mDNS names tells of the network
									networkType: remote ? undefined : 'unknown',
									address: candidate.address,
									ip: candidate.address,
									port: candidate.port,
									protocol: candidate.protocol,
									candidateType: candidate.type,
									priority: candidate.priority,
									foundation: candidate.foundation,
									usernameFragment: candidate.usernameFragment,
									url: candidate.url,
									relayProtocol: candidate.relayProtocol,
								},
							);
					const pairId = (pair: { local: string; remote: string }) =>
						`CP${pair.local.slice(1)}_${pair.remote.slice(1)}`;
					let sent = 0;
					let received = 0;
					let packetsSent = 0;
					let packetsReceived = 0;
					for (const pair of transport.pairs) {
						const { local, remote, ...counters } = pair;
						sent += pair.bytesSent;
						received += pair.bytesReceived;
						packetsSent += pair.packetsSent;
						packetsReceived += pair.packetsReceived;
						add(pairId(pair), 'candidate-pair', {
							...counters,
							transportId: 'T01',
							localCandidateId: local,
							remoteCandidateId: remote,
							bytesDiscardedOnSend: 0,
							packetsDiscardedOnSend: 0,
						});
					}
					const selected =
						transport.selected === null
							? null
							: transport.pairs[transport.selected];
					add('T01', 'transport', {
						bytesSent: sent,
						bytesReceived: received,
						packetsSent,
						packetsReceived,
						dtlsState: state.net.dtlsState,
						dtlsRole: transport.dtlsRole,
						dtlsCipher: transport.dtlsCipher,
						srtpCipher: transport.srtpCipher,
						tlsVersion: transport.tlsVersion,
						iceRole: transport.iceRole,
						iceState: info.ice,
						iceLocalUsernameFragment: info.ufrag,
						localCertificateId: certificateId(info.fingerprint),
						remoteCertificateId: info.remoteCertificate
							? certificateId(info.remoteCertificate.fingerprint)
							: undefined,
						selectedCandidatePairId: selected ? pairId(selected) : undefined,
						selectedCandidatePairChanges: transport.selectedChanges,
					});
				}
			}
			if (info) mediaEntries(state, info, add);
			// in the order of their ids, as the browser's report has them
			list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			if (!pick) return new Map<string, unknown>(list);
			return new Map<string, unknown>(picked(list, pick));
		};

		/**
		 * The sound's entries (docs/webrtc-over-wisp.md, section 16), as
		 * Chrome 152 and 156 write them for audio: for each sending
		 * section its `outbound-rtp` (once both descriptions are applied),
		 * the `codec` it sends and the peer's `remote-inbound-rtp` (once
		 * its first report came); for each receiving one its `inbound-rtp`
		 * (once a packet came), its codec and `remote-outbound-rtp`; a
		 * `media-source` for each sender's track and one `media-playout`
		 * for the connection.
		 */
		const mediaEntries = (
			state: PeerState,
			info: StatsReply,
			add: (
				id: string,
				type: string,
				...levels: Record<string, unknown>[]
			) => Record<string, unknown>,
		) => {
			const codecs = new Set<string>();
			const codec = (direction: 'I' | 'O', stats: CodecStats | null) => {
				if (!stats) return undefined;
				const id = `C${direction}T01_${stats.payloadType}${stats.sdpFmtpLine === undefined ? '' : `_${stats.sdpFmtpLine}`}`;
				if (!codecs.has(id)) {
					codecs.add(id);
					add(id, 'codec', { ...stats, transportId: 'T01' });
				}
				return id;
			};
			const stream = (codecId: string | undefined, ssrc: number) => ({
				codecId,
				kind: 'audio',
				mediaType: 'audio',
				ssrc,
				transportId: 'T01',
			});
			let playout: NonNullable<
				NonNullable<MediaStats['inbound']>['played']
			>['playout'] = {
				totalSamplesCount: 0,
				totalSamplesDuration: 0,
				totalPlayoutDelay: 0,
			};
			let playing = false;
			for (const slot of state.slots) {
				if (slot.kind !== 'audio' || slot.stopped) continue;
				// Chrome 152 has the playout once a transceiver of sound is
				// there, 156 once one receives
				if (
					isLegacy() ||
					(slot.current !== null &&
						slot.current !== 'stopped' &&
						receives(slot.current))
				)
					playing = true;
				const media = info.media.find((entry) => entry.handle === slot.handle);
				if (slot.track && slot.source && !slot.stopping)
					add(
						`SA${slot.source}`,
						'media-source',
						{
							kind: 'audio',
							trackIdentifier: Reflect.apply(trackId!, slot.track, []),
						},
						{ ...media?.source },
					);
				if (!media) continue;
				const { outbound, remoteInbound, inbound, remoteOutbound } = media;
				if (outbound) {
					const id = `OT01A${outbound.ssrc}`;
					const codecId = codec('O', outbound.codec);
					add(
						id,
						'outbound-rtp',
						stream(codecId, outbound.ssrc),
						{ bytesSent: outbound.bytes, packetsSent: outbound.packets },
						{
							active: outbound.active,
							headerBytesSent: outbound.header,
							mediaSourceId: `SA${slot.track ? slot.source : 0}`,
							mid: slot.mid,
							nackCount: 0,
							packetsSentWithEct1: 0,
							remoteId: remoteInbound ? `RIA${outbound.ssrc}` : undefined,
							retransmittedBytesSent: 0,
							retransmittedPacketsSent: 0,
							targetBitrate: outbound.bitrate,
							totalPacketSendDelay: 0,
						},
					);
					if (remoteInbound)
						add(
							`RIA${outbound.ssrc}`,
							'remote-inbound-rtp',
							stream(codecId, outbound.ssrc),
							{
								jitter:
									remoteInbound.jitter / (outbound.codec?.clockRate ?? 48000),
								packetsLost: remoteInbound.packetsLost,
							},
							{
								fractionLost: remoteInbound.fractionLost,
								localId: id,
								roundTripTime: remoteInbound.roundTripTime,
								roundTripTimeMeasurements: remoteInbound.measurements,
								totalRoundTripTime: remoteInbound.totalRoundTripTime,
							},
						).timestamp = remoteInbound.at;
				}
				if (inbound) {
					const id = `IT01A${inbound.ssrc}`;
					const codecId = codec('I', inbound.codec);
					const played = inbound.played;
					if (played) {
						playout = {
							totalSamplesCount:
								playout.totalSamplesCount + played.playout.totalSamplesCount,
							totalSamplesDuration:
								playout.totalSamplesDuration +
								played.playout.totalSamplesDuration,
							totalPlayoutDelay:
								playout.totalPlayoutDelay + played.playout.totalPlayoutDelay,
						};
					}
					const shown = shared.tracks.get(slot.remote)?.id;
					add(
						id,
						'inbound-rtp',
						stream(codecId, inbound.ssrc),
						{
							jitter: inbound.jitter,
							packetsLost: inbound.lost,
							packetsReceived: inbound.packets,
							packetsReceivedWithCe: 0,
							packetsReceivedWithEct1: 0,
						},
						{
							audioLevel: played?.audioLevel ?? 0,
							bytesReceived: inbound.bytes,
							concealedSamples: played?.concealedSamples ?? 0,
							concealmentEvents: played?.concealmentEvents ?? 0,
							fecPacketsDiscarded: played?.fecPacketsDiscarded ?? 0,
							fecPacketsReceived: played?.fecPacketsReceived ?? 0,
							headerBytesReceived: inbound.header,
							insertedSamplesForDeceleration:
								played?.insertedSamplesForDeceleration ?? 0,
							jitterBufferDelay: played?.jitterBufferDelay ?? 0,
							jitterBufferEmittedCount: played?.jitterBufferEmittedCount ?? 0,
							jitterBufferMinimumDelay: played?.jitterBufferMinimumDelay ?? 0,
							jitterBufferTargetDelay: played?.jitterBufferTargetDelay ?? 0,
							lastPacketReceivedTimestamp: inbound.last,
							mid: slot.mid,
							packetsDiscarded: played?.packetsDiscarded ?? 0,
							playoutId: 'AP',
							remoteId: remoteOutbound ? `ROA${inbound.ssrc}` : undefined,
							removedSamplesForAcceleration:
								played?.removedSamplesForAcceleration ?? 0,
							silentConcealedSamples: played?.silentConcealedSamples ?? 0,
							totalAudioEnergy: played?.totalAudioEnergy ?? 0,
							totalProcessingDelay: played?.totalProcessingDelay ?? 0,
							totalSamplesDuration: played?.totalSamplesDuration ?? 0,
							totalSamplesReceived: played?.totalSamplesReceived ?? 0,
							trackIdentifier:
								shown ?? Reflect.apply(trackId!, slot.remote, []),
						},
					);
					if (remoteOutbound)
						add(
							`ROA${inbound.ssrc}`,
							'remote-outbound-rtp',
							stream(codecId, inbound.ssrc),
							{
								bytesSent: remoteOutbound.bytes,
								packetsSent: remoteOutbound.packets,
							},
							{
								localId: id,
								remoteTimestamp: remoteOutbound.remoteTimestamp,
								reportsSent: remoteOutbound.reports,
								roundTripTime: remoteOutbound.roundTripTime,
								roundTripTimeMeasurements: remoteOutbound.measurements,
								totalRoundTripTime: remoteOutbound.totalRoundTripTime,
							},
						).timestamp = remoteOutbound.at;
				}
			}
			if (playing)
				add('AP', 'media-playout', {
					kind: 'audio',
					synthesizedSamplesDuration: 0,
					synthesizedSamplesEvents: 0,
					...playout,
				});
		};

		/**
		 * What a sender's or a receiver's getStats() has of the report: its
		 * stream, the stream's codec and the peer's report of it, its
		 * track's source or the playout, and the transport with its
		 * certificates and selected pair (none of it when the stream is not
		 * there yet)
		 */
		const picked = (
			list: [string, Record<string, unknown>][],
			{ slot, side }: StatsPick,
		) => {
			const type = side === 'sender' ? 'outbound-rtp' : 'inbound-rtp';
			const own = list.find(
				([, entry]) => entry.type === type && entry.mid === slot.mid,
			)?.[1];
			if (!own) return [];
			const transport = list.find(([id]) => id === 'T01')?.[1];
			const pair = list.find(
				([id]) => id === transport?.selectedCandidatePairId,
			)?.[1];
			const wanted = new Set(
				[
					own.id,
					own.codecId,
					own.remoteId,
					side === 'sender' ? own.mediaSourceId : own.playoutId,
					transport?.id,
					transport?.localCertificateId,
					transport?.remoteCertificateId,
					pair?.id,
					pair?.localCandidateId,
					pair?.remoteCandidateId,
				].filter((id) => typeof id === 'string'),
			);
			return list.filter(([id]) => wanted.has(id));
		};

		// --- what the worker says ---

		const onWorkerMessage = (state: PeerState, message: WorkerMessage) => {
			if (isReply(message)) {
				const waiting = state.pending.get(message.seq);
				if (!waiting) return;
				state.pending.delete(message.seq);
				const reply = message as Reply;
				if (reply.ok) waiting.resolve(reply.value);
				else {
					const error = new RealmDOMException(reply.message, reply.name);
					waiting.reject(error);
				}
				return;
			}
			if (state.closed) return;
			const target = state.target;
			const event = message as WorkerEvent;
			switch (event.ev) {
				case 'local':
					state.liveLocal = event.sdp;
					break;
				case 'icecandidate': {
					if (event.candidate) {
						const candidate = new NativeIceCandidate(event.candidate);
						const { url, relayProtocol } = event.candidate;
						candidateOrigins.set(candidate, { url, relayProtocol });
						state.heard.add(event.candidate.candidate);
						state.net.locals.push(
							transportCandidate(
								event.candidate.candidate,
								event.candidate.usernameFragment,
								url,
								relayProtocol,
							),
						);
						target.dispatchEvent(
							new NativeIceEvent('icecandidate', { candidate }),
						);
					}
					// the end of candidates: null (Chrome sends no empty candidate)
					else
						target.dispatchEvent(
							new NativeIceEvent('icecandidate', { candidate: null }),
						);
					break;
				}
				case 'icecandidateerror':
					target.dispatchEvent(
						new NativeIceErrorEvent('icecandidateerror', {
							address: event.error.address,
							port: event.error.port ?? undefined,
							url: event.error.url,
							errorCode: event.error.errorCode,
							errorText: event.error.errorText,
							// Chrome 152 writes a TLS connection that failed as
							// on the address it hides, 156 as on none
							hostCandidate:
								event.error.url.startsWith('turns:') &&
								event.error.errorText === 'Failed to establish connection' &&
								isLegacy()
									? '0.0.0.x:0'
									: event.error.hostCandidate,
						} as RTCPeerConnectionIceErrorEventInit),
					);
					break;
				case 'gathering':
					if (state.iceGatheringState !== event.state) {
						state.iceGatheringState = event.state;
						// the ICE transport's says so first
						if (state.net.ice) {
							state.net.gathering = event.state;
							changed(state.net.ice, 'gatheringstatechange');
						}
						target.dispatchEvent(new RealmEvent('icegatheringstatechange'));
					}
					break;
				case 'ice':
					if (state.iceConnectionState !== event.state) {
						state.iceConnectionState = event.state;
						target.dispatchEvent(new RealmEvent('iceconnectionstatechange'));
						const iceState =
							event.state === 'completed' ? 'connected' : event.state;
						if (state.net.iceState !== iceState) {
							state.net.iceState = iceState;
							changed(state.net.ice);
						}
					}
					break;
				case 'pair': {
					const net = state.net;
					const origin = (line: string) =>
						net.locals.find((known) => known.candidate === line);
					const local = origin(event.local);
					const from = local && candidateOrigins.get(local);
					const remoteFields = /\bufrag (\S+)/.exec(event.remote);
					net.pair = {
						local: transportCandidate(
							event.local,
							local?.usernameFragment ?? '',
							from?.url ?? '',
							from?.relayProtocol ?? null,
						),
						remote: transportCandidate(
							event.remote,
							remoteFields?.[1] ?? '',
							'',
							null,
						),
					};
					changed(net.ice, 'selectedcandidatepairchange');
					if (net.dtlsState === 'new') {
						net.dtlsState = 'connecting';
						changed(net.dtls);
					}
					break;
				}
				case 'dtls': {
					const net = state.net;
					if (event.state === 'connected') {
						net.certificates = event.certificate ? [event.certificate] : [];
						net.handshaken = true;
						break;
					}
					// the peer closed: the SCTP transport, then the DTLS one
					net.certificates = [];
					if (net.sctpState !== 'closed') {
						net.sctpState = 'closed';
						changed(net.sctp);
					}
					if (net.dtlsState !== 'closed') {
						net.dtlsState = 'closed';
						changed(net.dtls);
					}
					break;
				}
				case 'connection':
					if (state.connectionState !== event.state) {
						state.connectionState = event.state;
						target.dispatchEvent(new RealmEvent('connectionstatechange'));
					}
					// the transports say they are connected after the connection does
					if (event.state === 'connected' && state.net.handshaken) {
						const net = state.net;
						net.handshaken = false;
						if (net.dtlsState !== 'connected') {
							net.dtlsState = 'connected';
							changed(net.dtls);
						}
						if (net.sctpState === 'connecting') {
							net.sctpState = 'connected';
							net.maxChannels = 65535;
							changed(net.sctp);
						}
					}
					break;
				case 'datachannel': {
					const channel = new MockDataChannel(
						state,
						event.channel,
						event.options,
						event.id,
					);
					channelStates.get(channel)!.readyState = 'open';
					state.channels.set(event.channel, channel);
					target.dispatchEvent(
						Reflect.construct(MockDataChannelEvent, [
							'datachannel',
							{ channel },
						]) as Event,
					);
					break;
				}
				case 'channelOpen': {
					const channel = state.channels.get(event.channel);
					if (!channel) break;
					const channelState = channelStates.get(channel)!;
					if (channelState.readyState !== 'connecting') break;
					channelState.id = event.id;
					channelState.readyState = 'open';
					channelState.opened = true;
					state.channelsOpened++;
					channel.dispatchEvent(new RealmEvent('open'));
					break;
				}
				case 'channelMessage': {
					const channel = state.channels.get(event.channel);
					if (!channel) break;
					const channelState = channelStates.get(channel)!;
					let data: unknown = event.data;
					channelState.messagesReceived++;
					channelState.bytesReceived += event.binary
						? (event.data as ArrayBuffer).byteLength
						: utf8Length(event.data as string);
					if (event.binary && channelState.binaryType === 'blob')
						data = new RealmBlob([event.data as ArrayBuffer]);
					channel.dispatchEvent(
						new RealmMessageEvent('message', { data, origin: '' }),
					);
					break;
				}
				case 'buffered': {
					const channel = state.channels.get(event.channel);
					if (!channel) break;
					const channelState = channelStates.get(channel)!;
					channelState.bufferedAmount = event.amount;
					break;
				}
				case 'channelLow': {
					const channel = state.channels.get(event.channel);
					channel?.dispatchEvent(new RealmEvent('bufferedamountlow'));
					break;
				}
				case 'channelClosing': {
					const channel = state.channels.get(event.channel);
					if (!channel) break;
					const channelState = channelStates.get(channel)!;
					if (channelState.readyState === 'open') {
						channelState.readyState = 'closing';
						channel.dispatchEvent(new RealmEvent('closing'));
					}
					break;
				}
				case 'channelClose': {
					const channel = state.channels.get(event.channel);
					if (!channel) break;
					const channelState = channelStates.get(channel)!;
					if (channelState.readyState === 'closed') break;
					// the peer closed it: closing, then closed
					if (channelState.readyState === 'open') {
						channelState.readyState = 'closing';
						channel.dispatchEvent(new RealmEvent('closing'));
					}
					channelState.readyState = 'closed';
					if (channelState.opened) state.channelsClosed++;
					// a peer that aborted the association: each channel hears why
					// between its closing and its close, already closed
					if (event.abort)
						channel.dispatchEvent(
							new NativeErrorEvent('error', {
								error: new NativeError(
									{
										errorDetail: 'sctp-failure',
										sctpCauseCode: event.abort.cause,
									},
									event.abort.message,
								),
							}),
						);
					channel.dispatchEvent(new RealmEvent('close'));
					break;
				}
				case 'unmute': {
					const slot = state.slots.find(
						(known) => known.handle === event.handle,
					);
					if (!slot) break;
					slot.live = true;
					if (slot.receptive) setMuted(slot, false);
					break;
				}
				case 'error':
					console.warn('STomp: WebRTC', event.message);
					break;
			}
		};

		// --- install ---

		dress(
			MockPeerConnection,
			NativePeerConnection,
			shared.peers,
			peerMembers,
			unsupported('RTCPeerConnection'),
		);
		for (const made of [
			MockPeerConnection,
			MockDataChannel,
			MockDataChannelEvent,
			MockStatsReport,
		])
			ours.add(made);
		return {
			RTCPeerConnection: MockPeerConnection as unknown as Function,
			RTCDataChannelEvent: MockDataChannelEvent as unknown as Function,
		};
	}
}
