import type {
	ChannelOptions,
	ConnectionConfig,
	Reply,
	Request,
	RtcWorkerConnection,
	RtcWorkerInit,
	Unsequenced,
	WorkerEvent,
	WorkerMessage,
} from '../../rtc/protocol';
import { isReply } from '../../rtc/protocol';
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
 * The browser checks what an object is, not which document's prototype a
 * member came from: another document's addIceCandidate works on this
 * document's connection. Documents that can reach each other (a frame and
 * its parent, a popup and its opener) therefore share one set of tables
 * from each object to its own document's implementation, and every member
 * a page calls looks its object up there.
 */

// taken before any hook or page script, by the inject module (modules/WebRTC.ts)
let stringIndexOf: typeof String.prototype.indexOf;
let stringSlice: typeof String.prototype.slice;
let mapEntries: typeof Map.prototype.entries;
let mapNext: () => IteratorResult<[string, unknown]>;

/** a class's members as the document that made an object implements them */
type Members = Record<PropertyKey, PropertyDescriptor | undefined>;
interface Shared {
	peers: WeakMap<object, Members>;
	channels: WeakMap<object, Members>;
	channelEvents: WeakMap<object, Members>;
	reports: WeakMap<object, Members>;
}
// an about:blank child (a frame, a popup) runs its creator's bundle: its
// worker when the child has no controller
let bundleWorker: (() => Worker) | null = null;

/** `sdp` without its candidate lines, with no method a page can patch */
function withoutCandidates(sdp: string): string {
	let out = '';
	for (let at = 0; at < sdp.length;) {
		const found: number = Reflect.apply(stringIndexOf, sdp, ['\n', at]);
		const end = found === -1 ? sdp.length : found + 1;
		const line: string = Reflect.apply(stringSlice, sdp, [at, end]);
		if (Reflect.apply(stringIndexOf, line, ['a=candidate']) !== 0) out += line;
		at = end;
	}
	return out;
}

const MAX_MESSAGE_SIZE = 262144;

type Description = { type: RTCSdpType; sdp: string };

const method = (name: string, what: string) =>
	`Failed to execute '${name}' on 'RTCPeerConnection': ${what}`;

export default class WebRTCStack {
	install(ctx: RtcContext) {
		const client = ctx.client;
		stringIndexOf = ctx.captures.stringIndexOf;
		stringSlice = ctx.captures.stringSlice;
		mapEntries = ctx.captures.mapEntries;
		mapNext = ctx.captures.mapNext;
		const withStack = ctx.withStack;
		const global = client.global as unknown as typeof globalThis &
			Record<string, any>;
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
		const addListener = RealmEventTarget.prototype.addEventListener;
		const removeListener = RealmEventTarget.prototype.removeEventListener;
		const RealmMessageEvent = global.MessageEvent as typeof MessageEvent;
		const RealmBlob = global.Blob as typeof Blob;
		const NativeIceCandidate = global.RTCIceCandidate as typeof RTCIceCandidate;
		const NativeSessionDescription =
			global.RTCSessionDescription as typeof RTCSessionDescription;
		const NativeIceEvent =
			global.RTCPeerConnectionIceEvent as typeof RTCPeerConnectionIceEvent;
		const NativeIceErrorEvent =
			global.RTCPeerConnectionIceErrorEvent as typeof RTCPeerConnectionIceErrorEvent;
		const NativeDataChannel = ctx.natives
			.RTCDataChannel as unknown as typeof RTCDataChannel;
		const NativeDataChannelEvent = ctx.natives
			.RTCDataChannelEvent as unknown as typeof RTCDataChannelEvent;
		const NativeStatsReport = ctx.natives
			.RTCStatsReport as unknown as typeof RTCStatsReport;

		const domException = (message: string, name: string) =>
			withStack(new RealmDOMException(message, name));
		const rejected = (message: string, name: string) =>
			RealmPromise.reject(new RealmDOMException(message, name));

		// --- the tables: the inject module's, shared by the documents that reach each other ---

		const shared = ctx.shared as unknown as Shared;
		shared.peers ??= new WeakMap();
		shared.channels ??= new WeakMap();
		shared.channelEvents ??= new WeakMap();
		shared.reports ??= new WeakMap();

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
			worker = new NativeWorker(ctx.workerURL());
			worker.postMessage(
				{
					kind: 'init',
					transport,
					module: ctx.moduleURL(),
				} satisfies RtcWorkerInit,
				[transport],
			);
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
		/**
		 * `config` for a probe: the page's own members, with no candidate
		 * pool (the browser gathers for a pool at once, with or without a
		 * local description, whatever the policy)
		 */
		const poolless = (config: unknown) =>
			isObject(config)
				? Object.create(config, {
						iceCandidatePoolSize: { value: 0, enumerable: true },
					})
				: config;
		/** the pool as the browser converts it (an octet, range enforced) */
		const poolOf = (config: unknown, context: string): number => {
			const given = isObject(config) ? config.iceCandidatePoolSize : undefined;
			if (given === undefined) return 0;
			const number = Math.trunc(+(given as number));
			const finite = number - number === 0;
			if (!finite || number < 0 || number > 255)
				throw new RealmTypeError(
					`${context}: Failed to read the 'iceCandidatePoolSize' property from 'RTCConfiguration': Value is ${finite ? "outside the 'octet' value range" : "not of type 'octet'"}.`,
				);
			return number + 0;
		};
		/**
		 * The page's configuration through the browser: `read` constructs a
		 * probe, or sets it on one, and answers what it reads back; its
		 * errors are the browser's own. The browser converts the members in
		 * name order, so a bad pool is reported after a bad bundle policy
		 * or certificate and before anything else.
		 */
		const normalise = (
			config: unknown,
			context: string,
			read: (config: unknown) => RTCConfiguration,
		): { shown: RTCConfiguration; forWorker: ConnectionConfig } => {
			let shown: RTCConfiguration;
			try {
				shown = read(poolless(config));
			} catch (error) {
				if (
					!(error instanceof RealmTypeError) ||
					!/'(?:bundlePolicy|certificates)' property/.test(error.message)
				)
					poolOf(config, context);
				throw error;
			}
			shown.iceCandidatePoolSize = poolOf(config, context);
			const servers = [];
			for (const server of shown.iceServers ?? [])
				servers.push({
					urls: Array.isArray(server.urls) ? [...server.urls] : [server.urls],
					...(server.username !== undefined
						? { username: server.username }
						: {}),
					...(server.credential !== undefined
						? { credential: server.credential }
						: {}),
				});
			return {
				shown,
				forWorker: {
					iceServers: servers,
					iceTransportPolicy: shown.iceTransportPolicy ?? 'all',
					iceCandidatePoolSize: shown.iceCandidatePoolSize ?? 0,
				},
			};
		};
		/** a probe: the browser's own connection, which never gets a local description */
		const probed = <T>(
			config: unknown,
			use: (probe: RTCPeerConnection) => T,
		) => {
			const probe = Reflect.construct(NativePeerConnection, [
				config,
			]) as RTCPeerConnection;
			try {
				return use(probe);
			} finally {
				probe.close();
			}
		};

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
				if (text !== 'blob' && text !== 'arraybuffer')
					throw domException(
						`Failed to set the 'binaryType' property on 'RTCDataChannel': Unknown binary type : ${text}`,
						'TypeMismatchError',
					);
				state.binaryType = text;
			}
			send(data: string | Blob | ArrayBuffer | ArrayBufferView) {
				const state = channelOf(this);
				if (state.readyState !== 'open')
					throw domException(
						"Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
						'InvalidStateError',
					);
				if (data instanceof RealmBlob) {
					const size = data.size;
					if (size > messageLimit(state.pc)) throw tooLarge();
					state.unreported += size;
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
		const mapIterator = Reflect.getPrototypeOf(new global.Map().entries())!;
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
			config: RTCConfiguration;
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
			negotiated: boolean;
			needsNegotiation: boolean;
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

		class MockPeerConnection extends based(
			RealmEventTarget,
			ctx.standIns.RTCPeerConnection,
		) {
			constructor(configuration?: RTCConfiguration) {
				super();
				shared.peers.set(this, peerMembers);
				const { shown, forWorker } = normalise(
					configuration,
					"Failed to construct 'RTCPeerConnection'",
					(config) => probed(config, (probe) => probe.getConfiguration()),
				);
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
							state.port.postMessage({ seq, ...request }, transfer);
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
					negotiated: false,
					needsNegotiation: false,
					chain: RealmPromise.resolve(),
					closed: false,
				};
				peerStates.set(this, state);
				const channel = new MessageChannel();
				state.port = channel.port1;
				channel.port1.onmessage = ({ data }: MessageEvent<WorkerMessage>) =>
					onWorkerMessage(state, data);
				startWorker().postMessage(
					{
						kind: 'connection',
						port: channel.port2,
						config: forWorker,
					} satisfies RtcWorkerConnection,
					[channel.port2],
				);
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
				return state.currentRemote || state.pendingRemote ? true : null;
			}
			get sctp() {
				peerOf(this);
				return null;
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
				const state = peerOf(this);
				const config = state.config;
				return {
					...config,
					iceServers: (config.iceServers ?? []).map((server) => ({
						...server,
						urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
					})),
					certificates: [...(config.certificates ?? [])],
				};
			}
			setConfiguration(configuration?: RTCConfiguration) {
				const state = peerOf(this);
				if (state.closed)
					throw domException(
						method(
							'setConfiguration',
							"RTCPeerConnection's signalingState is 'closed'.",
						),
						'InvalidStateError',
					);
				// what the browser makes of the change, on a probe configured as
				// this connection is
				const { shown, forWorker } = normalise(
					configuration,
					method('setConfiguration', '').slice(0, -2),
					(config) =>
						probed(poolless(state.config), (probe) => {
							probe.setConfiguration(config as RTCConfiguration);
							return probe.getConfiguration();
						}),
				);
				if (
					shown.iceCandidatePoolSize !== state.config.iceCandidatePoolSize &&
					(state.pendingLocal || state.currentLocal)
				)
					throw domException(
						method(
							'setConfiguration',
							"Attempted to modify the PeerConnection's configuration in an unsupported way.",
						),
						'InvalidModificationError',
					);
				state.config = shown;
				state
					.call({ op: 'setConfiguration', config: forWorker })
					.catch(() => {});
			}

			createOffer(...args: any[]) {
				const state = peerOf(this);
				const legacy = typeof args[0] === 'function';
				const options = (legacy ? args[2] : args[0]) as
					RTCOfferOptions | undefined;
				const result = chained(state, 'createOffer', async () => {
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
						await state.call({ op: 'setLocal', type: 'rollback' });
						state.pendingLocal = null;
						state.pendingRemote = null;
						setSignaling(state, 'stable');
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
						await state.call({ op: 'setLocal', type: 'offer' });
						// the rendering with its candidates comes as they are
						// gathered; the last description's is not this one's
						state.liveLocal = null;
						state.pendingLocal = { type: 'offer', sdp };
						state.negotiated = true;
						setSignaling(state, 'have-local-offer');
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
					await state.call({ op: 'setLocal', type: 'answer' });
					state.liveLocal = null;
					if (type === 'pranswer') {
						state.pendingLocal = { type: 'pranswer', sdp };
						setSignaling(state, 'have-local-pranswer');
						return;
					}
					state.currentLocal = { type: 'answer', sdp };
					state.pendingLocal = null;
					state.currentRemote = state.pendingRemote ?? state.currentRemote;
					state.pendingRemote = null;
					state.negotiated = true;
					setSignaling(state, 'stable');
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
				const init = args[0];
				const legacy = typeof args[1] === 'function';
				const result = chained(state, 'setRemoteDescription', async () => {
					if (init === null || init === undefined || typeof init !== 'object')
						throw new TypeError(
							method(
								'setRemoteDescription',
								`1 argument required, but only ${args.length} present.`,
							),
						);
					const type = init.type === undefined ? undefined : String(init.type);
					const sdp = init.sdp === undefined ? '' : String(init.sdp);
					// no type: the browser has nothing to parse the text as
					if (type === undefined)
						throw new RealmDOMException(
							method(
								'setRemoteDescription',
								'Failed to parse SessionDescription.  ',
							),
							'OperationError',
						);
					if (
						type !== 'offer' &&
						type !== 'answer' &&
						type !== 'rollback' &&
						type !== 'pranswer'
					)
						throw new TypeError(
							method(
								'setRemoteDescription',
								`The provided value '${type}' is not a valid enum value of type RTCSdpType.`,
							),
						);
					if (type === 'rollback') {
						if (
							state.signalingState !== 'have-local-offer' &&
							state.signalingState !== 'have-remote-offer'
						)
							throw wrongState(
								'setRemoteDescription',
								'remote',
								'rollback',
								state.signalingState,
							);
						await state.call({ op: 'setRemote', type: 'rollback', sdp: '' });
						state.pendingLocal = null;
						state.pendingRemote = null;
						setSignaling(state, 'stable');
						return;
					}
					const offer = type === 'offer';
					if (
						offer
							? state.signalingState !== 'stable' &&
								state.signalingState !== 'have-remote-offer'
							: state.signalingState !== 'have-local-offer' &&
								state.signalingState !== 'have-remote-pranswer'
					) {
						// the browser parses the text before it looks at the state
						const refusal = await refused(type, sdp);
						throw refusal && PARSE.test(refusal.message)
							? refusal
							: wrongState(
									'setRemoteDescription',
									'remote',
									type,
									state.signalingState,
								);
					}
					try {
						await stackCall(state, 'setRemoteDescription', `remote ${type}`, {
							op: 'setRemote',
							type: offer ? 'offer' : 'answer',
							sdp,
						});
					} catch (error) {
						// the browser's own words for a description it refuses too
						// (a probe is in no state for an answer: its parser's only)
						const refusal = await refused(type, sdp);
						throw refusal && (offer || PARSE.test(refusal.message))
							? refusal
							: error;
					}
					state.remoteMids = midsOf(sdp);
					state.remoteCandidates = [];
					if (offer) {
						state.pendingRemote = { type: 'offer', sdp };
						setSignaling(state, 'have-remote-offer');
						return;
					}
					if (type === 'pranswer') {
						state.pendingRemote = { type: 'pranswer', sdp };
						setSignaling(state, 'have-remote-pranswer');
						return;
					}
					state.currentRemote = { type: 'answer', sdp };
					state.pendingRemote = null;
					state.currentLocal = state.pendingLocal ?? state.currentLocal;
					state.pendingLocal = null;
					setSignaling(state, 'stable');
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
				const init = args[0];
				const legacy = typeof args[1] === 'function';
				const result = chained(state, 'addIceCandidate', async () => {
					let candidate = '';
					let sdpMid: string | null = null;
					let sdpMLineIndex: number | null = null;
					if (init !== null && init !== undefined) {
						if (init.candidate !== undefined)
							candidate = String(init.candidate);
						if (init.sdpMid !== undefined && init.sdpMid !== null)
							sdpMid = String(init.sdpMid);
						if (init.sdpMLineIndex !== undefined && init.sdpMLineIndex !== null)
							sdpMLineIndex = Number(init.sdpMLineIndex);
					}
					// a candidate for no section, before anything else is looked at
					if (candidate !== '' && sdpMid === null && sdpMLineIndex === null)
						throw new RealmTypeError(
							method(
								'addIceCandidate',
								'Candidate missing values for both sdpMid and sdpMLineIndex',
							),
						);
					if (!state.currentRemote && !state.pendingRemote)
						throw new RealmDOMException(
							method('addIceCandidate', 'The remote description was null'),
							'InvalidStateError',
						);
					if (candidate === '') return;
					const section =
						sdpMid !== null
							? state.remoteMids.indexOf(sdpMid)
							: sdpMLineIndex! < state.remoteMids.length
								? sdpMLineIndex!
								: -1;
					// a section the remote description does not have, or text the
					// stack cannot read
					if (
						section < 0 ||
						!(await state.call({ op: 'addCandidate', candidate, sdpMid }).then(
							() => true,
							() => false,
						))
					)
						throw new RealmDOMException(
							method('addIceCandidate', 'Error processing ICE candidate'),
							'OperationError',
						);
					// as the remote description lists it from now on: no ufrag,
					// always a generation
					let line = candidate.replace(/^a=/, '').replace(/ ufrag \S+/, '');
					if (!/ generation \d/.test(line)) line += ' generation 0';
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
				state.needsNegotiation = true;
				queue(() => fireNegotiationNeeded(state));
			}
			// no media through the proxy yet: a connection has none of these
			getSenders() {
				peerOf(this);
				return new RealmArray();
			}
			getReceivers() {
				peerOf(this);
				return new RealmArray();
			}
			getTransceivers() {
				peerOf(this);
				return new RealmArray();
			}
			createDataChannel(label: string, init?: RTCDataChannelInit) {
				const state = peerOf(this);
				if (arguments.length < 1)
					throw new TypeError(
						method(
							'createDataChannel',
							'1 argument required, but only 0 present.',
						),
					);
				if (state.closed)
					throw domException(
						method(
							'createDataChannel',
							"RTCPeerConnection's signalingState is 'closed'.",
						),
						'InvalidStateError',
					);
				const options = channelOptions(String(label), init);
				const channel = new MockDataChannel(
					state,
					-1,
					options,
					options.negotiated ? options.id : null,
				);
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
				if (!state.negotiated && !state.needsNegotiation) {
					state.needsNegotiation = true;
					queue(() => fireNegotiationNeeded(state));
				}
				return channel;
			}
			getStats(...args: any[]) {
				const state = peerOf(this);
				if (args.length && args[0] !== null && args[0] !== undefined)
					return rejected(
						method(
							'getStats',
							'The track is not associated with this RTCPeerConnection',
						),
						'InvalidAccessError',
					);
				return state
					.call({ op: 'stats' })
					.then((info) =>
						Reflect.construct(MockStatsReport, [
							statsEntries(
								state,
								info as { ice: string; connection: string; local: string[] },
							),
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
				state.signalingState = 'closed';
				state.iceConnectionState = 'closed';
				state.connectionState = 'closed';
				for (const { reject } of state.pending.values())
					reject(
						new RealmDOMException(
							'The RTCPeerConnection is closed',
							'InvalidStateError',
						),
					);
				state.pending.clear();
				state.port?.close();
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
		const midsOf = (sdp: string) => {
			const mids: (string | null)[] = [];
			for (const line of sdp.split(/\r?\n/))
				if (line.startsWith('m=')) mids.push(null);
				else if (mids.length && line.startsWith('a=mid:'))
					mids[mids.length - 1] = line.slice(6);
			return mids;
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
		const PARSE = /Failed to parse SessionDescription/;
		/**
		 * What the browser says to a remote description (null: it takes it),
		 * from a connection of its own that gets no local description, so no
		 * socket, and no candidate, so no name to look up
		 */
		const refused = async (type: string, sdp: string) => {
			const probe = Reflect.construct(
				NativePeerConnection,
				[],
			) as RTCPeerConnection;
			try {
				await probe.setRemoteDescription({
					type: type as RTCSdpType,
					sdp: withoutCandidates(sdp),
				});
				return null;
			} catch (error) {
				return error as DOMException;
			} finally {
				probe.close();
			}
		};
		const setSignaling = (state: PeerState, next: RTCSignalingState) => {
			if (state.closed || state.signalingState === next) return;
			state.signalingState = next;
			state.target.dispatchEvent(new RealmEvent('signalingstatechange'));
			if (next === 'stable' && state.needsNegotiation)
				queue(() => fireNegotiationNeeded(state));
		};
		const fireNegotiationNeeded = (state: PeerState) => {
			if (
				state.closed ||
				state.signalingState !== 'stable' ||
				!state.needsNegotiation
			)
				return;
			state.needsNegotiation = false;
			state.target.dispatchEvent(new RealmEvent('negotiationneeded'));
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
					`Failed to set ${side} ${type} sdp: Called in wrong state: ${signaling}`,
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
					method(name, "RTCPeerConnection's signalingState is 'closed'."),
					'InvalidStateError',
				) as Promise<T>;
			const run = state.chain.then(operation, operation);
			state.chain = run.then(
				() => {},
				() => {},
			);
			return new RealmPromise<T>((resolve, reject) =>
				run.then(resolve, reject),
			);
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
					if (typeof failure === 'function')
						Reflect.apply(failure, undefined, [error]);
				},
			);
		};
		const channelOptions = (
			label: string,
			init?: RTCDataChannelInit,
		): ChannelOptions => {
			const options: ChannelOptions = {
				label,
				ordered: true,
				maxPacketLifeTime: null,
				maxRetransmits: null,
				protocol: '',
				negotiated: false,
				id: null,
			};
			if (init === null || init === undefined) return options;
			if (typeof init !== 'object')
				throw new TypeError(
					method(
						'createDataChannel',
						"The provided value is not of type 'RTCDataChannelInit'.",
					),
				);
			if (init.ordered !== undefined) options.ordered = !!init.ordered;
			if (
				init.maxPacketLifeTime !== undefined &&
				init.maxPacketLifeTime !== null
			)
				options.maxPacketLifeTime = Number(init.maxPacketLifeTime) & 0xffff;
			if (init.maxRetransmits !== undefined && init.maxRetransmits !== null)
				options.maxRetransmits = Number(init.maxRetransmits) & 0xffff;
			if (options.maxPacketLifeTime !== null && options.maxRetransmits !== null)
				throw domException(
					method(
						'createDataChannel',
						'RTCDataChannel cannot have both max retransmits and max lifetime',
					),
					'TypeError',
				);
			if (init.protocol !== undefined) options.protocol = String(init.protocol);
			if (init.negotiated !== undefined) options.negotiated = !!init.negotiated;
			if (init.id !== undefined && init.id !== null)
				options.id = Number(init.id) & 0xffff;
			if (options.negotiated && options.id === null)
				throw new TypeError(
					method(
						'createDataChannel',
						'RTCDataChannel cannot be negotiated without an id',
					),
				);
			return options;
		};
		const statsEntries = (
			state: PeerState,
			info: { ice: string; connection: string; local: string[] },
		) => {
			const timestamp = performance.timeOrigin + performance.now();
			const entries = new Map<string, unknown>();
			let opened = 0;
			let closed = 0;
			for (const channel of state.channels.values()) {
				const channelState = channelStates.get(channel)!;
				if (
					channelState.readyState === 'open' ||
					channelState.readyState === 'closing'
				)
					opened++;
				if (channelState.readyState === 'closed') closed++;
				entries.set(`D${channelState.index}`, {
					id: `D${channelState.index}`,
					timestamp,
					type: 'data-channel',
					label: channelState.options.label,
					protocol: channelState.options.protocol,
					dataChannelIdentifier: channelState.id ?? undefined,
					state: channelState.readyState,
				});
			}
			entries.set('P', {
				id: 'P',
				timestamp,
				type: 'peer-connection',
				dataChannelsOpened: opened,
				dataChannelsClosed: closed,
			});
			entries.set('T01', {
				id: 'T01',
				timestamp,
				type: 'transport',
				dtlsState:
					state.connectionState === 'connected'
						? 'connected'
						: state.connectionState === 'new'
							? 'new'
							: 'connecting',
				iceState: info.ice,
				selectedCandidatePairChanges:
					state.connectionState === 'connected' ? 1 : 0,
			});
			return entries;
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
							hostCandidate: event.error.hostCandidate,
						} as RTCPeerConnectionIceErrorEventInit),
					);
					break;
				case 'gathering':
					if (state.iceGatheringState !== event.state) {
						state.iceGatheringState = event.state;
						target.dispatchEvent(new RealmEvent('icegatheringstatechange'));
					}
					break;
				case 'ice':
					if (state.iceConnectionState !== event.state) {
						state.iceConnectionState = event.state;
						target.dispatchEvent(new RealmEvent('iceconnectionstatechange'));
					}
					break;
				case 'connection':
					if (state.connectionState !== event.state) {
						state.connectionState = event.state;
						target.dispatchEvent(new RealmEvent('connectionstatechange'));
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
					channel.dispatchEvent(new RealmEvent('open'));
					break;
				}
				case 'channelMessage': {
					const channel = state.channels.get(event.channel);
					if (!channel) break;
					const channelState = channelStates.get(channel)!;
					let data: unknown = event.data;
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
					channel.dispatchEvent(new RealmEvent('close'));
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
