import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { withStack } from '../../nativeErrors';
import { LazyWeakMap } from '../../ownCollections';
import {
	bindDescriptors,
	EventSource,
	fetch,
	Request,
	Response,
	URL,
	WebSocket,
	XMLHttpRequestEventTarget,
} from '../../snapshot';
import type DocumentClient from '../Client';
import { deferred } from '../deferred';
import type {
	Installed,
	Members,
	RtcContext,
	SharedTables,
	StandIns,
} from '../rtcLazy';
import { DOMParser, navigator, postMessage } from '../snapshot';

/*
 * WebRTC over wisp (docs/webrtc-over-wisp.md). The browser's own
 * RTCPeerConnection sends its packets itself, from the user's address, to
 * whatever a page names; through the proxy that is a leak, so a page never
 * gets it. RTCPeerConnection, RTCDataChannel, RTCDataChannelEvent and
 * RTCStatsReport are classes of STomp's own that read as native, whose
 * members are messages to the document's WebRTC worker (src/rtc/worker.ts),
 * which runs the stack (str0m in wasm) over wisp streams.
 *
 * What every document carries is this: the four classes, with the
 * browser's prototypes (each member one that reads as the browser's and
 * runs the member of the document that made the object), and nothing
 * behind them. What they do is a library of its own (../rtcStack.ts, the
 * asset `rtcStack`), which a document loads the first time its page makes
 * a connection or an event of a channel, or calls a member on an object
 * that only that library makes: a synchronous request for the file, from
 * the HTTP cache after the first, evaluated in the bundle's realm with the
 * globals this bundle took when it loaded. Most documents never make a
 * connection and pay for none of it.
 *
 * The browser checks what an object is, not which document's prototype a
 * member came from: another document's addIceCandidate works on this
 * document's connection. Documents that can reach each other (a frame and
 * its parent, a popup and its opener) therefore share one set of tables
 * from each object to its own document's implementation, and once one of
 * them installs the library every one of them does (its members on the
 * browser's own prototypes need it).
 */

// taken before any hook or page script, in the bundle's own realm
const openerGet = Reflect.getOwnPropertyDescriptor(globalThis, 'opener')?.get;
const objectCreate = Object.create;
const captures: RtcContext['captures'] = {
	mapEntries: Map.prototype.entries,
	mapNext: (Reflect.getPrototypeOf(new Map().entries()) as { next: Function })
		.next as () => IteratorResult<[string, unknown]>,
	objectCreate,
	weakDeref: WeakRef.prototype.deref,
	stringIndexOf: String.prototype.indexOf,
	stringSlice: String.prototype.slice,
	addListener: EventTarget.prototype.addEventListener,
	removeListener: EventTarget.prototype.removeEventListener,
	portPost: MessagePort.prototype.postMessage,
	workerPost: Worker.prototype.postMessage,
	performanceNow: Performance.prototype.now,
};
/** the document's globals the library uses: see RtcContext.realm */
const REALM = [
	'Array',
	'Blob',
	'DOMException',
	'Event',
	'EventTarget',
	'Map',
	'MessageEvent',
	'Object',
	'Promise',
	'TypeError',
	'WeakRef',
	'Worker',
	'performance',
	'setTimeout',
	'structuredClone',
];
const NativeWeakRef = WeakRef;
const NativeProxy = Proxy;
const setAdd = Set.prototype.add;
const setDelete = Set.prototype.delete;
const setValues = Set.prototype.values;
const setIteratorNext = (
	Reflect.getPrototypeOf(new Set().values()) as { next: Function }
).next;
const realmEval = globalThis.eval;
const requestOpen = XMLHttpRequest.prototype.open;
const requestSend = XMLHttpRequest.prototype.send;
const requestStatus = Reflect.getOwnPropertyDescriptor(
	XMLHttpRequest.prototype,
	'status',
)!.get!;
const requestText = Reflect.getOwnPropertyDescriptor(
	XMLHttpRequest.prototype,
	'responseText',
)!.get!;
// what the library's globals are (rtcStackGlobals.ts): this bundle's own
const snapshot = {
	Reflect,
	Function,
	fetch,
	URL,
	Request,
	Response,
	XMLHttpRequest,
	XMLHttpRequestEventTarget,
	EventSource,
	WebSocket,
	bindDescriptors,
	DOMParser,
	navigator,
	postMessage,
	ownIterable,
	isArray,
	// (its String and Array method calls, scripts/ownMethods.mjs)
	get ownMethods() {
		return ownMethodHelpers();
	},
};

/** what loading the library takes: this bundle's own, from before the page ran */
const loading = {
	requestOpen,
	requestSend,
	requestStatus,
	requestText,
	realmEval,
	snapshot,
	setValues,
	setIteratorNext,
};
export type RtcLoading = typeof loading;

/** the client of a document that has the tables */
interface Linked {
	rtc?: SharedTables;
}
// an about:blank child (a frame, a popup) runs its creator's bundle: the
// creator's tables
let bundleShared: SharedTables | null = null;
export default class WebRTCModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global as unknown as typeof globalThis &
			Record<string, any>;
		const NativePeerConnection = global.RTCPeerConnection as
			typeof RTCPeerConnection | undefined;
		if (typeof NativePeerConnection !== 'function') return;
		const proxyModule = client.getModule(ProxyModule)!;
		const RealmEventTarget = global.EventTarget as typeof EventTarget;
		const RealmEvent = global.Event as typeof Event;
		const RealmDOMException = global.DOMException as typeof DOMException;
		const RealmTypeError = global.TypeError as TypeErrorConstructor;
		const natives: StandIns = {
			RTCPeerConnection: NativePeerConnection,
			RTCDataChannel: global.RTCDataChannel as Function,
			RTCDataChannelEvent: global.RTCDataChannelEvent as Function,
			RTCStatsReport: global.RTCStatsReport as Function,
		};

		// --- the tables: the creator's, a parent's, an opener's, or new ones ---

		const tablesOf = (reach: () => unknown): SharedTables | undefined => {
			try {
				const other = reach() as Record<string, Linked | undefined> | null;
				if (!other || other === (global as unknown)) return undefined;
				return other[client.names.client]?.rtc;
			} catch (error) {
				// a window of another origin
				return undefined;
			}
		};
		const shared: SharedTables = bundleShared ??
			tablesOf(() => client.parent) ??
			tablesOf(() => openerGet && Reflect.apply(openerGet, global, [])) ?? {
				peers: new WeakMap(),
				channels: new WeakMap(),
				channelEvents: new WeakMap(),
				reports: new WeakMap(),
				installs: new Set(),
				weakRef: NativeWeakRef,
			};
		bundleShared ??= shared;
		(client as unknown as Linked).rtc = shared;

		// --- prototypes that read as the browser's ---

		const illegal = () => new RealmTypeError('Illegal invocation');
		const unsupported = (name: string) => (key: string, getter: boolean) => {
			if (getter) return undefined;
			throw withStack(
				new RealmDOMException(
					`Failed to execute '${key}' on '${name}': not supported through the proxy yet`,
					'NotSupportedError',
				),
			);
		};
		/**
		 * `prototype` made to read as `Native`'s: the browser's own keys in
		 * its order with its descriptors, each function one that reads as
		 * the browser's and runs the member of the document that made the
		 * object (`table`), or `missing` where there is none yet
		 */
		const dress = (
			prototype: object,
			Native: Function,
			table: WeakMap<object, Members>,
			missing: (key: string, getter: boolean) => unknown,
			/** the stand-in's own `constructor`, which takes the browser's place */
			own?: PropertyDescriptor,
		) => {
			// one stand-in for each of the browser's functions: a maplike's
			// @@iterator is its entries
			const made = new Map<Function, Function>();
			const member = (
				key: string | symbol,
				part: 'value' | 'get' | 'set',
				native: Function,
			): any => {
				let wrapped = made.get(native);
				if (!wrapped) {
					wrapped = proxyModule.wrapFunction(native, (target, that, args) => {
						const own = table.get(that);
						// not an object of these stand-ins: the browser's own
						// refusal (thrown, or a rejected promise where the
						// method answers with one), in its words
						if (!own) return Reflect.apply(target, that, args);
						const implemented = own[key]?.[part];
						return implemented
							? Reflect.apply(implemented, that, args)
							: missing(String(key), part !== 'value');
					});
					made.set(native, wrapped);
				}
				return wrapped;
			};
			for (const key of Reflect.ownKeys(Native.prototype)) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					Native.prototype,
					key,
				)!;
				if (key === 'constructor') {
					if (own) {
						Reflect.defineProperty(prototype, key, own);
						continue;
					}
				} else {
					if (typeof descriptor.value === 'function')
						descriptor.value = member(key, 'value', descriptor.value);
					if (descriptor.get)
						descriptor.get = member(key, 'get', descriptor.get);
					if (descriptor.set)
						descriptor.set = member(key, 'set', descriptor.set);
				}
				Reflect.defineProperty(prototype, key, descriptor);
			}
		};
		// each prototype not dressed yet: its stand-in's name, its table and
		// the `constructor` the stand-in gives it, and the one handler of the
		// proxies of all of them (a handler of its own for each was a dozen
		// closures in every frame)
		const pendings = new LazyWeakMap<
			object,
			{
				name: keyof StandIns;
				table: WeakMap<object, Members>;
				own: PropertyDescriptor | undefined;
			}
		>();
		const ready = (target: object) => {
			const pending = pendings.get(target);
			if (!pending) return;
			pendings.delete(target);
			dress(
				target,
				natives[pending.name],
				pending.table,
				unsupported(pending.name),
				pending.own,
			);
		};
		const lazyHandler: ProxyHandler<object> = {
			get: (t, key, receiver) => (ready(t), Reflect.get(t, key, receiver)),
			set: (t, key, value, receiver) => (
				ready(t),
				Reflect.set(t, key, value, receiver)
			),
			has: (t, key) => (ready(t), Reflect.has(t, key)),
			ownKeys: (t) => (ready(t), Reflect.ownKeys(t)),
			getOwnPropertyDescriptor: (t, key) => (
				ready(t),
				Reflect.getOwnPropertyDescriptor(t, key)
			),
			defineProperty: (t, key, descriptor) => {
				// the stand-in's constructor, set as it is made
				const pending = pendings.get(t);
				if (pending && key === 'constructor') {
					pending.own = descriptor;
					return true;
				}
				ready(t);
				return Reflect.defineProperty(t, key, descriptor);
			},
			deleteProperty: (t, key) => (ready(t), Reflect.deleteProperty(t, key)),
			preventExtensions: (t) => (ready(t), Reflect.preventExtensions(t)),
			isExtensible: (t) => (ready(t), Reflect.isExtensible(t)),
			setPrototypeOf: (t, value) => (
				ready(t),
				Reflect.setPrototypeOf(t, value)
			),
		};
		/**
		 * A prototype dressed (as `dress`) the first time anything looks at
		 * it or at an object made on it, not when the document loads: the
		 * browser's functions of a class are some dozens of stand-ins each,
		 * which most documents never touch. Until then it is a proxy of an
		 * empty object that holds only the `constructor` the stand-in gives
		 * it; every operation on it dresses it and is then the target's.
		 */
		const lazyPrototype = (
			Base: object,
			name: keyof StandIns,
			table: WeakMap<object, Members>,
		): object => {
			const target = objectCreate(Base) as object;
			pendings.set(target, { name, table, own: undefined });
			return new NativeProxy(target, lazyHandler);
		};
		const standIn = (
			name: keyof StandIns,
			Base: object,
			table: WeakMap<object, Members>,
			construct: (args: unknown[], newTarget: Function) => object,
			illegalConstructor = false,
		): Function => {
			const prototype = lazyPrototype(Base, name, table);
			const made = function (this: unknown, ...args: unknown[]) {
				return construct(args, new.target);
			};
			made.prototype = prototype;
			return proxyModule.standInClass(made, natives[name], illegalConstructor);
		};

		// --- the library, installed for this document when it is first needed ---

		// (a deferred part, ../rtcInstall.ts: most documents never make a
		// connection)
		let installed: Installed | null = null;
		const install = (): Installed =>
			installed ??
			deferred().rtcInstall(
				{
					client,
					realm,
					shared,
					proxyModule,
					natives,
					standIns,
					captures,
					installNow,
					loading,
				},
				(made) => (installed = made),
			);
		const installNow = () => void install();
		// the entries of documents that are gone go first, then this one's,
		// made by the tables' own realm: one made by this document's WeakRef
		// would keep this document alive with the tables
		const entries = Reflect.apply(setValues, shared.installs, []);
		for (;;) {
			const step = Reflect.apply(setIteratorNext, entries, []) as {
				done: boolean;
				value: WeakRef<() => void>;
			};
			if (step.done) break;
			if (!Reflect.apply(captures.weakDeref, step.value, []))
				Reflect.apply(setDelete, shared.installs, [step.value]);
		}
		Reflect.apply(setAdd, shared.installs, [
			Reflect.construct(shared.weakRef, [installNow]),
		]);

		const standIns: StandIns = {
			RTCPeerConnection: standIn(
				'RTCPeerConnection',
				RealmEventTarget.prototype,
				shared.peers,
				(args, newTarget) =>
					Reflect.construct(install().RTCPeerConnection, args, newTarget),
			),
			RTCDataChannel: standIn(
				'RTCDataChannel',
				RealmEventTarget.prototype,
				shared.channels,
				() => {
					throw illegal();
				},
				true,
			),
			// the browser's own argument errors (it takes no channel but its
			// own, which no page has), then an event of ours around a channel
			// of ours
			RTCDataChannelEvent: standIn(
				'RTCDataChannelEvent',
				RealmEvent.prototype,
				shared.channelEvents,
				(args, newTarget) => {
					const init = args[1] as RTCDataChannelEventInit;
					if (
						init === null ||
						typeof init !== 'object' ||
						!shared.channels.has(init.channel)
					)
						return Reflect.construct(natives.RTCDataChannelEvent, args);
					return Reflect.construct(
						install().RTCDataChannelEvent,
						args,
						newTarget,
					);
				},
			),
			RTCStatsReport: standIn(
				'RTCStatsReport',
				global.Object.prototype,
				shared.reports,
				() => {
					throw illegal();
				},
				true,
			),
		};
		const realm = objectCreate(null) as Record<string, any>;
		for (const name of REALM) realm[name] = global[name];

		const page = global as unknown as Record<string, unknown>;
		page.RTCPeerConnection = standIns.RTCPeerConnection;
		if ('webkitRTCPeerConnection' in global)
			page.webkitRTCPeerConnection = standIns.RTCPeerConnection;
		page.RTCDataChannel = standIns.RTCDataChannel;
		page.RTCDataChannelEvent = standIns.RTCDataChannelEvent;
		page.RTCStatsReport = standIns.RTCStatsReport;
	}
}
