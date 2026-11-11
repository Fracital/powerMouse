import { partitionSite } from '../../../partition';
import type { JarCookie } from '../../../server/Cookies';
import type {
	ClientInfo,
	EmulateInfo,
	ErrorInfo,
	FetchAnswer,
	FetchInit,
	FromEmulated,
	MessageInit,
	ToEmulated,
	WireServiceWorkerResponse,
} from '../../../serviceWorkerTypes';
import { receiveBody, sendBody } from '../../../transport/bodyPort';
import { postToPort, SW_RPC } from '../../../transport/messages';
import { RpcHelper } from '../../../transport/rpc';
import { cookieStoreMethods } from '../../cookieStoreMethods';
import Module from '../../Module';
import { nativeBodyOf, recordResponse } from '../../modules/Fetch';
import ProxyModule from '../../modules/Proxy';
import ServiceWorkerObjects from '../../serviceWorkerObjects';
import type WorkerClient from '../Client';
import { getServiceWorkerPort } from '../Client';

/** an emulated event's lifetime, as ExtendableEvent keeps it */
interface Extension {
	trusted: boolean;
	dispatching: boolean;
	pending: number;
	promises: Promise<unknown>[];
	rejected: boolean;
}

interface FetchState {
	request: Request;
	clientId: string;
	resultingClientId: string;
	replacesClientId: string;
	isReload: boolean;
	preloadResponse: Promise<unknown>;
	handled: Promise<undefined>;
	resolveHandled?: () => void;
	rejectHandled?: (reason: unknown) => void;
	response?: Promise<unknown>;
}

/** what a dedicated worker has and a service worker does not */
const DEDICATED_ONLY = [
	'postMessage',
	'close',
	'name',
	'requestAnimationFrame',
	'cancelAnimationFrame',
	'DedicatedWorkerGlobalScope',
	'Worker',
	'SharedWorker',
	'XMLHttpRequest',
	'XMLHttpRequestEventTarget',
	'XMLHttpRequestUpload',
	'FileReaderSync',
];

/**
 * What a dedicated worker's global has and a service worker's lacks
 * besides (measured against Chrome 152's service worker global): device and
 * media APIs, WebCodecs, the RTC script transform, the old file system API
 */
const DEDICATED_ONLY_INTERFACES = [
	'AudioData',
	'AudioDecoder',
	'AudioEncoder',
	'EncodedAudioChunk',
	'EncodedVideoChunk',
	'FileSystemObserver',
	'FileSystemSyncAccessHandle',
	'HID',
	'HIDConnectionEvent',
	'HIDDevice',
	'HIDInputReportEvent',
	'IdleDetector',
	'ImageDecoder',
	'ImageTrack',
	'ImageTrackList',
	'MediaSource',
	'MediaSourceHandle',
	'PressureObserver',
	'PressureRecord',
	'ProgressEvent',
	'RTCDataChannel',
	'RTCEncodedAudioFrame',
	'RTCEncodedVideoFrame',
	'RTCRtpScriptTransformer',
	'RTCTransformEvent',
	'Serial',
	'SerialPort',
	'SourceBuffer',
	'SourceBufferList',
	'USB',
	'USBAlternateInterface',
	'USBConfiguration',
	'USBConnectionEvent',
	'USBDevice',
	'USBEndpoint',
	'USBInTransferResult',
	'USBInterface',
	'USBIsochronousInTransferPacket',
	'USBIsochronousInTransferResult',
	'USBIsochronousOutTransferPacket',
	'USBIsochronousOutTransferResult',
	'USBOutTransferResult',
	'VideoColorSpace',
	'VideoDecoder',
	'VideoEncoder',
	'VideoFrame',
	'onrtctransform',
	'webkitRequestFileSystem',
	'webkitRequestFileSystemSync',
	'webkitResolveLocalFileSystemSyncURL',
	'webkitResolveLocalFileSystemURL',
	'PaymentManager',
	'ContentIndex',
];

/** members the inject assigns on the global, which natively live on its prototype chain */
const INHERITED = ['fetch', 'importScripts', 'setTimeout', 'setInterval'];

/** the interfaces a service worker's global has that the object layer may stand in for */
const SERVICE_WORKER_INTERFACES = [
	'ServiceWorkerRegistration',
	'NavigationPreloadManager',
	'PushManager',
	'SyncManager',
	'PeriodicSyncManager',
	'BackgroundFetchManager',
	'BackgroundFetchRecord',
	'BackgroundFetchRegistration',
	'CookieStoreManager',
];

/** the event handler attributes a service worker's global has */
const HANDLERS = [
	'install',
	'activate',
	'fetch',
	'push',
	'pushsubscriptionchange',
	'notificationclick',
	'notificationclose',
	'sync',
	'periodicsync',
	'backgroundfetchsuccess',
	'backgroundfetchfail',
	'backgroundfetchabort',
	'backgroundfetchclick',
	'canmakepayment',
	'paymentrequest',
	'abortpayment',
	'cookiechange',
];

/**
 * The global of a page's emulated service worker (docs/service-workers.md):
 * a dedicated Worker that the `sw:` route's preamble turns into what reads
 * as a ServiceWorkerGlobalScope, talking to STomp's service worker over the
 * port its controller hands it.
 */
export default class ServiceWorkerGlobalModule extends Module<WorkerClient> {
	#evaluated?: (ok: boolean, error?: string) => void;
	apply() {}
	/** the script's top level ran to its end */
	evaluated() {
		this.#evaluated?.(true);
	}
	emulate(info: EmulateInfo) {
		const global = this.client.global as typeof globalThis &
			Record<string, unknown>;
		const proxy = this.client.getModule(ProxyModule)!;
		const nativeAddEventListener =
			global.EventTarget.prototype.addEventListener;

		// the rpc to STomp's service worker: what is called before the port
		// arrives (the script's top level runs first) waits for it, in order
		let port: MessagePort | undefined;
		const outbox: [unknown, Transferable[]][] = [];
		const send = (data: unknown, transfer: Transferable[]) => {
			if (port) postToPort(port, data, transfer);
			else outbox.push([data, transfer]);
		};

		let evaluation: { ok: boolean; error?: string } | undefined;
		const evaluated = new Promise<{ ok: boolean; error?: string }>(
			(resolve) => {
				this.#evaluated = (ok, error) => {
					if (evaluation) return;
					evaluation = { ok, error };
					resolve(evaluation);
				};
			},
		);
		// an uncaught error before the end of the top level is an evaluation
		// failure: the registration rejects
		Reflect.apply(nativeAddEventListener, global, [
			'error',
			(event: ErrorEvent) => {
				if (!evaluation) this.#evaluated?.(false, String(event.message));
			},
		]);

		const objects: ServiceWorkerObjects = new ServiceWorkerObjects(
			global,
			proxy,
			{
				update: async () => {
					const error = await rpc.call('update', null);
					if (error) throw objects.error(error);
				},
				unregister: () => rpc.call('unregister', null),
				postMessage: (worker, _registration, message, transfer) => {
					checkClone(global, message, transfer);
					const ports = portsOf(transfer);
					rpc.call(
						'postToWorker',
						{ worker: worker.id, data: message, ports },
						ports,
					);
				},
				preload: (_registration, op, value) =>
					rpc.call('preload', { op, value }),
				manager: async (_registration, kind, op, args) => {
					const answer: { value: unknown } | { error: ErrorInfo } =
						await rpc.call('manager', { kind, op, args });
					if ('error' in answer) throw objects.error(answer.error);
					return answer.value;
				},
			},
			{ inWorker: true },
		);
		const registration = objects.registration(info.registration);
		const self = objects.worker(info.version, info.registration.id)!;

		/**
		 * Put `cls` on the global as interface `name`, through the Proxy
		 * module's standInClass: a dedicated worker has no such interface, so
		 * what the stand-in leaves to the browser is a function made here that
		 * reads as the native one and throws its errors (a call without
		 * `new`, too few arguments), with a read-only prototype, the class's
		 */
		const natives = new Map<Function, Function>();
		const nativeClass = (
			cls: Function,
			name: string,
			length: number,
			parent?: Function,
		) => {
			for (const key of Reflect.ownKeys(cls.prototype)) {
				if (typeof key !== 'string' || key === 'constructor') continue;
				const descriptor = Reflect.getOwnPropertyDescriptor(
					cls.prototype,
					key,
				)!;
				if (typeof descriptor.value === 'function')
					objects.native(descriptor.value, key, descriptor.value.length);
				if (descriptor.get) objects.native(descriptor.get, `get ${key}`);
				if (descriptor.set) objects.native(descriptor.set, `set ${key}`, 1);
			}
			Reflect.defineProperty(cls.prototype, Symbol.toStringTag, {
				configurable: true,
				value: name,
			});
			const native = objects.native(
				function (this: unknown, ...args: unknown[]) {
					if (!new.target)
						throw new global.TypeError(
							`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`,
						);
					throw new global.TypeError(
						`Failed to construct '${name}': ${length} argument${length > 1 ? 's' : ''} required, but only ${args.length} present.`,
					);
				},
				name,
				length,
			);
			Reflect.defineProperty(native, 'prototype', {
				value: cls.prototype,
				writable: false,
				enumerable: false,
				configurable: false,
			});
			const above = parent && (natives.get(parent) ?? parent);
			if (above) Reflect.setPrototypeOf(native, above);
			natives.set(cls, native);
			Reflect.defineProperty(global, name, {
				configurable: true,
				writable: true,
				value: proxy.standInClass(cls, native),
			});
		};
		const invalidState = (method: string, on: string, message: string) =>
			new global.DOMException(
				`Failed to execute '${method}' on '${on}': ${message}`,
				'InvalidStateError',
			);

		// ---- events
		const extensions = new WeakMap<Event, Extension>();
		const NativeEvent = global.Event;
		class ExtendableEvent extends NativeEvent {
			constructor(type: string, init?: EventInit) {
				super(type, init);
				extensions.set(this, {
					trusted: false,
					dispatching: false,
					pending: 0,
					promises: [],
					rejected: false,
				});
			}
			waitUntil(promise: unknown) {
				const extension = extensions.get(this);
				if (!extension) throw new global.TypeError('Illegal invocation');
				if (!extension.trusted)
					throw invalidState(
						'waitUntil',
						'ExtendableEvent',
						'The event object was not dispatched by the user agent.',
					);
				if (!extension.dispatching && !extension.pending)
					throw invalidState(
						'waitUntil',
						'ExtendableEvent',
						'The event handler is already finished and no extend lifetime promises are outstanding.',
					);
				extension.pending++;
				const settled = global.Promise.resolve(promise).then(
					() => {
						extension.pending--;
					},
					() => {
						extension.pending--;
						extension.rejected = true;
					},
				);
				extension.promises.push(settled);
			}
		}
		nativeClass(ExtendableEvent, 'ExtendableEvent', 1, NativeEvent);

		class InstallEvent extends ExtendableEvent {}
		nativeClass(InstallEvent, 'InstallEvent', 1, ExtendableEvent);

		const fetches = new WeakMap<Event, FetchState>();
		class FetchEvent extends ExtendableEvent {
			constructor(type: string, init: Record<string, unknown>) {
				if (
					typeof init !== 'object' ||
					init === null ||
					!(init.request instanceof global.Request)
				)
					throw new global.TypeError(
						"Failed to construct 'FetchEvent': required member request is undefined.",
					);
				super(type, init);
				const state: FetchState = {
					request: init.request as Request,
					clientId: String(init.clientId ?? ''),
					resultingClientId: String(init.resultingClientId ?? ''),
					replacesClientId: String(init.replacesClientId ?? ''),
					isReload: !!init.isReload,
					preloadResponse:
						(init.preloadResponse as Promise<unknown>) ??
						global.Promise.resolve(undefined),
					handled: undefined as unknown as Promise<undefined>,
				};
				state.handled = new global.Promise<undefined>((resolve, reject) => {
					state.resolveHandled = () => resolve(undefined);
					state.rejectHandled = reject;
				});
				state.handled.catch(() => {});
				fetches.set(this, state);
			}
			get request() {
				return fetches.get(this)!.request;
			}
			get clientId() {
				return fetches.get(this)!.clientId;
			}
			get resultingClientId() {
				return fetches.get(this)!.resultingClientId;
			}
			get replacesClientId() {
				return fetches.get(this)!.replacesClientId;
			}
			get isReload() {
				return fetches.get(this)!.isReload;
			}
			get preloadResponse() {
				return fetches.get(this)!.preloadResponse;
			}
			get handled() {
				return fetches.get(this)!.handled;
			}
			respondWith(response: unknown) {
				const state = fetches.get(this);
				const extension = extensions.get(this);
				if (!state || !extension)
					throw new global.TypeError('Illegal invocation');
				if (!extension.trusted || !extension.dispatching)
					throw invalidState(
						'respondWith',
						'FetchEvent',
						'The event handler is already finished.',
					);
				if (state.response)
					throw invalidState(
						'respondWith',
						'FetchEvent',
						'The event has already been responded to.',
					);
				state.response = global.Promise.resolve(response);
				this.waitUntil(state.response);
				this.stopImmediatePropagation();
			}
		}
		nativeClass(FetchEvent, 'FetchEvent', 2, ExtendableEvent);

		const messages = new WeakMap<
			Event,
			{
				data: unknown;
				origin: string;
				lastEventId: string;
				source: unknown;
				ports: readonly MessagePort[];
			}
		>();
		class ExtendableMessageEvent extends ExtendableEvent {
			constructor(type: string, init: Record<string, unknown> = {}) {
				super(type, init);
				messages.set(this, {
					data: init.data ?? null,
					origin: String(init.origin ?? ''),
					lastEventId: String(init.lastEventId ?? ''),
					source: init.source ?? null,
					ports: global.Object.freeze([
						...((init.ports as MessagePort[]) ?? []),
					]),
				});
			}
			get data() {
				return messages.get(this)!.data;
			}
			get origin() {
				return messages.get(this)!.origin;
			}
			get lastEventId() {
				return messages.get(this)!.lastEventId;
			}
			get source() {
				return messages.get(this)!.source;
			}
			get ports() {
				return messages.get(this)!.ports;
			}
		}
		nativeClass(
			ExtendableMessageEvent,
			'ExtendableMessageEvent',
			1,
			ExtendableEvent,
		);

		// the events of the features a service worker has: they run (sync,
		// background fetch) or never fire here (push, notifications,
		// payments), and a page can construct each as natively
		const required = (name: string, member: string) =>
			new global.TypeError(
				`Failed to construct '${name}': required member ${member} is undefined.`,
			);
		const initOf = (init: unknown) =>
			(typeof init === 'object' && init !== null ? init : {}) as Record<
				string,
				unknown
			>;
		const fields = new WeakMap<Event, Record<string, unknown>>();
		const field = (event: Event, key: string) => fields.get(event)?.[key];

		class SyncEvent extends ExtendableEvent {
			constructor(type: string, init?: unknown) {
				const own = initOf(init);
				if (own.tag === undefined) throw required('SyncEvent', 'tag');
				super(type, own as EventInit);
				fields.set(this, {
					tag: String(own.tag),
					lastChance: !!own.lastChance,
				});
			}
			get tag() {
				return field(this, 'tag');
			}
			get lastChance() {
				return field(this, 'lastChance');
			}
		}
		nativeClass(SyncEvent, 'SyncEvent', 2, ExtendableEvent);

		class PeriodicSyncEvent extends ExtendableEvent {
			constructor(type: string, init?: unknown) {
				const own = initOf(init);
				if (own.tag === undefined) throw required('PeriodicSyncEvent', 'tag');
				super(type, own as EventInit);
				fields.set(this, { tag: String(own.tag) });
			}
			get tag() {
				return field(this, 'tag');
			}
		}
		nativeClass(PeriodicSyncEvent, 'PeriodicSyncEvent', 2, ExtendableEvent);

		const PushMessageData = objects.fakeClass('PushMessageData');
		const pushBytes = new WeakMap<object, Uint8Array>();
		const isPushData = (that: unknown) =>
			typeof that === 'object' && that !== null && pushBytes.has(that);
		const bytesOf = (that: object) => pushBytes.get(that)!;
		objects.hook(PushMessageData.prototype, 'arrayBuffer', isPushData, {
			call: (that) => bytesOf(that).slice().buffer,
		});
		objects.hook(PushMessageData.prototype, 'blob', isPushData, {
			call: (that) =>
				new global.Blob([bytesOf(that) as Uint8Array<ArrayBuffer>]),
		});
		objects.hook(PushMessageData.prototype, 'bytes', isPushData, {
			call: (that) => bytesOf(that).slice(),
		});
		objects.hook(PushMessageData.prototype, 'json', isPushData, {
			call: (that) => JSON.parse(new TextDecoder().decode(bytesOf(that))),
		});
		objects.hook(PushMessageData.prototype, 'text', isPushData, {
			call: (that) => new TextDecoder().decode(bytesOf(that)),
		});
		class PushEvent extends ExtendableEvent {
			constructor(type: string, init?: unknown) {
				const own = initOf(init);
				super(type, own as EventInit);
				let data: object | null = null;
				if (own.data !== undefined && own.data !== null) {
					data = Object.create(PushMessageData.prototype);
					const value = own.data;
					pushBytes.set(
						data!,
						typeof value === 'string'
							? new TextEncoder().encode(value)
							: ArrayBuffer.isView(value)
								? new Uint8Array(
										value.buffer.slice(
											value.byteOffset,
											value.byteOffset + value.byteLength,
										),
									)
								: new Uint8Array(value as ArrayBuffer),
					);
				}
				fields.set(this, { data });
			}
			get data() {
				return field(this, 'data');
			}
		}
		nativeClass(PushEvent, 'PushEvent', 1, ExtendableEvent);

		class PushSubscriptionChangeEvent extends ExtendableEvent {
			constructor(type: string, init?: unknown) {
				const own = initOf(init);
				super(type, own as EventInit);
				fields.set(this, {
					newSubscription: own.newSubscription ?? null,
					oldSubscription: own.oldSubscription ?? null,
				});
			}
			get newSubscription() {
				return field(this, 'newSubscription');
			}
			get oldSubscription() {
				return field(this, 'oldSubscription');
			}
		}
		nativeClass(
			PushSubscriptionChangeEvent,
			'PushSubscriptionChangeEvent',
			1,
			ExtendableEvent,
		);

		class NotificationEvent extends ExtendableEvent {
			constructor(type: string, init?: unknown) {
				const own = initOf(init);
				if (own.notification === undefined)
					throw required('NotificationEvent', 'notification');
				super(type, own as EventInit);
				fields.set(this, {
					notification: own.notification,
					action: String(own.action ?? ''),
					reply: own.reply ?? null,
				});
			}
			get notification() {
				return field(this, 'notification');
			}
			get action() {
				return field(this, 'action');
			}
			get reply() {
				return field(this, 'reply');
			}
		}
		nativeClass(NotificationEvent, 'NotificationEvent', 2, ExtendableEvent);

		class BackgroundFetchEvent extends ExtendableEvent {
			constructor(type: string, init?: unknown) {
				const own = initOf(init);
				if (own.registration === undefined)
					throw required('BackgroundFetchEvent', 'registration');
				super(type, own as EventInit);
				fields.set(this, { registration: own.registration });
			}
			get registration() {
				return field(this, 'registration');
			}
		}
		nativeClass(
			BackgroundFetchEvent,
			'BackgroundFetchEvent',
			2,
			ExtendableEvent,
		);

		class BackgroundFetchUpdateUIEvent extends BackgroundFetchEvent {
			async updateUI() {
				return undefined;
			}
		}
		nativeClass(
			BackgroundFetchUpdateUIEvent,
			'BackgroundFetchUpdateUIEvent',
			2,
			BackgroundFetchEvent,
		);

		// payments never reach a proxied page's worker: their events exist
		// to be constructed, answering with what they were given
		class CanMakePaymentEvent extends ExtendableEvent {
			respondWith(response: unknown) {
				this.waitUntil(response);
			}
		}
		nativeClass(CanMakePaymentEvent, 'CanMakePaymentEvent', 1, ExtendableEvent);
		class AbortPaymentEvent extends ExtendableEvent {
			respondWith(response: unknown) {
				this.waitUntil(response);
			}
		}
		nativeClass(AbortPaymentEvent, 'AbortPaymentEvent', 1, ExtendableEvent);
		class PaymentRequestEvent extends ExtendableEvent {
			constructor(type: string, init?: unknown) {
				const own = initOf(init);
				super(type, own as EventInit);
				fields.set(this, own);
			}
			get topOrigin() {
				return String(field(this, 'topOrigin') ?? '');
			}
			get paymentRequestOrigin() {
				return String(field(this, 'paymentRequestOrigin') ?? '');
			}
			get paymentRequestId() {
				return String(field(this, 'paymentRequestId') ?? '');
			}
			get methodData() {
				return field(this, 'methodData') ?? [];
			}
			get total() {
				return field(this, 'total') ?? null;
			}
			get modifiers() {
				return field(this, 'modifiers') ?? [];
			}
			get paymentOptions() {
				return field(this, 'paymentOptions') ?? null;
			}
			get shippingOptions() {
				return field(this, 'shippingOptions') ?? null;
			}
			async openWindow() {
				return null;
			}
			async changePaymentMethod() {
				return null;
			}
			async changeShippingAddress() {
				return null;
			}
			async changeShippingOption() {
				return null;
			}
			respondWith(response: unknown) {
				this.waitUntil(response);
			}
		}
		nativeClass(PaymentRequestEvent, 'PaymentRequestEvent', 2, ExtendableEvent);

		class ExtendableCookieChangeEvent extends ExtendableEvent {
			constructor(type: string, init?: unknown) {
				const own = initOf(init);
				super(type, own as EventInit);
				fields.set(this, {
					changed: global.Object.freeze([
						...((own.changed as unknown[]) ?? []),
					]),
					deleted: global.Object.freeze([
						...((own.deleted as unknown[]) ?? []),
					]),
				});
			}
			get changed() {
				return field(this, 'changed');
			}
			get deleted() {
				return field(this, 'deleted');
			}
		}
		nativeClass(
			ExtendableCookieChangeEvent,
			'ExtendableCookieChangeEvent',
			1,
			ExtendableEvent,
		);

		// cookieStore over the proxy's jar, the one the site's pages read and
		// write (cookieStoreMethods), with a service worker's URL rule: a
		// `url` must be the worker's own script URL, query and fragment
		// aside, as Chrome 152 checks it. It has no change events: the
		// worker's are its registration's subscriptions (cookiechange)
		const CookieStore = objects.fakeClass('CookieStore', global.EventTarget);
		const cookieStore = objects.eventTarget(CookieStore);
		const scriptURL = () => this.client.url.url;
		const stripped = (url: URL) => `${url.origin}${url.pathname}`;
		const jarRoute = (route: string) =>
			`${new URL(String(global.location.href)).origin}${this.client.directory}cookies/${route}`;
		const sender = `sw-${info.version.id}-${Math.random().toString(36).slice(2)}`;
		// the registration's partition: its Partitioned cookies are that
		// top-level site's, and a worker in one reads the jar as another
		// site's (no SameSite=Lax or Strict cookie), as a document there does
		const partitionContext = () => {
			const partitionKey = partitionSite(this.client.partition);
			return partitionKey === null
				? null
				: { partitionKey, site: 'cross-site' as const };
		};
		let sequence = 0;
		const inflight = new Set<number>();
		const cookieMethods = cookieStoreMethods({
			global,
			base: () => scriptURL().href,
			refuseURL: (url) =>
				!url || stripped(url) !== stripped(scriptURL())
					? 'URL must be within Service Worker scope'
					: null,
			host: () => scriptURL().hostname,
			jar: async () => {
				const response = await this.client.nativeFetch(jarRoute('get'), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify([scriptURL().href, partitionContext()]),
				});
				if (!response.ok)
					throw new Error(`${response.status} ${response.statusText}`);
				return ((await response.json()) as JarCookie[]).filter(
					(cookie) => !cookie.httpOnly,
				);
			},
			// in order with the worker's other writes (the jar's numbered
			// turns, as a document's)
			store: async (write) => {
				const seq = sequence++;
				inflight.add(seq);
				const url = new URL(jarRoute('ordered'));
				url.searchParams.set('sender', sender);
				url.searchParams.set('seq', String(seq));
				url.searchParams.set('base', String(Math.min(...inflight)));
				try {
					const response = await this.client.nativeFetch(url.href, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify([
							write,
							scriptURL().href,
							partitionSite(this.client.partition) ?? undefined,
						]),
					});
					if (!response.ok)
						throw new Error(`${response.status} ${response.statusText}`);
				} finally {
					inflight.delete(seq);
				}
			},
			refused: () => null,
			crossSite: () => partitionContext() !== null,
			look: async () => {},
		});
		const isCookieStore = (that: unknown) => that === cookieStore;
		for (const method of ['delete', 'get', 'getAll', 'set'] as const)
			objects.hook(CookieStore.prototype, method, isCookieStore, {
				length: method === 'get' || method === 'getAll' ? 0 : 1,
				call: (_that, args) => cookieMethods.methods[method](args),
			});
		// natively the prototype lists its methods, then constructor
		const constructor = Reflect.getOwnPropertyDescriptor(
			CookieStore.prototype,
			'constructor',
		)!;
		Reflect.deleteProperty(CookieStore.prototype, 'constructor');
		Reflect.defineProperty(CookieStore.prototype, 'constructor', constructor);
		Reflect.defineProperty(global, 'CookieStore', {
			configurable: true,
			writable: true,
			value: CookieStore,
		});
		Reflect.defineProperty(global, 'PushMessageData', {
			configurable: true,
			writable: true,
			value: PushMessageData,
		});

		/** dispatch on the global and wait for its extend lifetime promises; whether none rejected */
		const run = async (event: Event): Promise<boolean> => {
			const extension = extensions.get(event)!;
			extension.trusted = true;
			extension.dispatching = true;
			try {
				objects.dispatch(global, event);
			} finally {
				extension.dispatching = false;
			}
			// a promise added while waiting counts too
			for (let i = 0; i < extension.promises.length; i++)
				await extension.promises[i];
			return !extension.rejected;
		};

		// ---- clients
		const clientStates = new WeakMap<object, ClientInfo>();
		const illegal = () => {
			throw new global.TypeError('Illegal constructor');
		};
		const Client = objects.fakeClass('Client');
		const WindowClient = objects.fakeClass('WindowClient', Client);
		const Clients = objects.fakeClass('Clients');
		for (const [ctor, name] of [
			[Client, 'Client'],
			[WindowClient, 'WindowClient'],
			[Clients, 'Clients'],
		] as const)
			Reflect.defineProperty(global, name, {
				configurable: true,
				writable: true,
				value: ctor,
			});
		const isClient = (that: unknown) =>
			typeof that === 'object' && that !== null && clientStates.has(that);
		const clientOf = (info: ClientInfo): object => {
			const object = Object.create(
				info.type === 'window' ? WindowClient.prototype : Client.prototype,
			);
			clientStates.set(object, info);
			return object;
		};
		for (const key of ['url', 'id', 'type', 'frameType'] as const)
			objects.hook(Client.prototype, key, isClient, {
				get: (that) => clientStates.get(that)![key],
			});
		objects.hook(Client.prototype, 'postMessage', isClient, {
			length: 1,
			call: (that, args) => {
				if (args.length < 1)
					throw new global.TypeError(
						"Failed to execute 'postMessage' on 'Client': 1 argument required, but only 0 present.",
					);
				const transfer = transferOf(args[1]);
				checkClone(global, args[0], transfer);
				const ports = portsOf(transfer);
				rpc.call(
					'postToClient',
					{ id: clientStates.get(that)!.id, data: args[0], ports },
					ports,
				);
			},
		});
		const isWindowClient = (that: unknown) =>
			isClient(that) && clientStates.get(that as object)!.type === 'window';
		for (const key of ['visibilityState', 'focused'] as const)
			objects.hook(WindowClient.prototype, key, isWindowClient, {
				get: (that) => clientStates.get(that)![key],
			});
		objects.hook(WindowClient.prototype, 'focus', isWindowClient, {
			call: async () => {
				throw new global.DOMException(
					'Not allowed to focus a window.',
					'InvalidAccessError',
				);
			},
		});
		objects.hook(WindowClient.prototype, 'navigate', isWindowClient, {
			length: 1,
			call: async (that, args) => {
				const result = await rpc.call('navigate', {
					id: clientStates.get(that)!.id,
					url: new URL(String(args[0]), this.client.url.toString()).href,
				});
				if (result && 'name' in result) throw objects.error(result);
				return result ? clientOf(result) : null;
			},
		});
		const clients = Object.create(Clients.prototype);
		const isClients = (that: unknown) => that === clients;
		objects.hook(Clients.prototype, 'get', isClients, {
			length: 1,
			call: async (_that, args) => {
				const info = await rpc.call('getClient', String(args[0]));
				return info ? clientOf(info) : undefined;
			},
		});
		objects.hook(Clients.prototype, 'matchAll', isClients, {
			call: async (_that, args) => {
				const options = (args[0] ?? {}) as ClientQueryOptions;
				const list = await rpc.call('matchAll', {
					includeUncontrolled: !!options.includeUncontrolled,
					type: String(options.type ?? 'window'),
				});
				return list.map(clientOf);
			},
		});
		objects.hook(Clients.prototype, 'openWindow', isClients, {
			length: 1,
			call: async () => {
				throw new global.DOMException(
					'Not allowed to open a window.',
					'InvalidAccessError',
				);
			},
		});
		objects.hook(Clients.prototype, 'claim', isClients, {
			call: async () => {
				const error = await rpc.call('claim', null);
				if (error) throw objects.error(error);
			},
		});

		// ---- the global
		const define = (name: string, get: () => unknown) =>
			Reflect.defineProperty(global, name, {
				configurable: true,
				enumerable: true,
				get: objects.native(get, `get ${name}`),
			});
		define('registration', () => registration);
		define('serviceWorker', () => self);
		define('clients', () => clients);
		define('cookieStore', () => cookieStore);
		Reflect.defineProperty(global, 'skipWaiting', {
			configurable: true,
			enumerable: true,
			writable: true,
			value: objects.native(async function skipWaiting() {
				await rpc.call('skipWaiting', undefined as never);
			}, 'skipWaiting'),
		});
		for (const type of HANDLERS)
			Reflect.defineProperty(global, `on${type}`, {
				configurable: true,
				enumerable: true,
				get: objects.native(
					() => objects.getHandler(global, type),
					`get on${type}`,
				),
				set: objects.native(
					(value: unknown) => objects.setHandler(global, type, value),
					`set on${type}`,
					1,
				),
			});
		for (const name of [...DEDICATED_ONLY, ...DEDICATED_ONLY_INTERFACES])
			Reflect.deleteProperty(global, name);
		// a service worker cannot mint blob: URLs
		Reflect.deleteProperty(global.URL, 'createObjectURL');
		Reflect.deleteProperty(global.URL, 'revokeObjectURL');
		for (const name of SERVICE_WORKER_INTERFACES)
			if (typeof global[name] !== 'function')
				Reflect.defineProperty(global, name, {
					configurable: true,
					writable: true,
					value: objects.classFor(name),
				});
		// the hooks assigned these on the global itself; natively they are
		// inherited, so the global's own names read as a service worker's
		for (const name of INHERITED) {
			const own = Reflect.getOwnPropertyDescriptor(global, name);
			if (!own) continue;
			let holder = Reflect.getPrototypeOf(global);
			while (holder && !Reflect.getOwnPropertyDescriptor(holder, name))
				holder = Reflect.getPrototypeOf(holder);
			if (!holder) continue;
			Reflect.defineProperty(holder, name, {
				...Reflect.getOwnPropertyDescriptor(holder, name),
				value: own.value,
			});
			Reflect.deleteProperty(global, name);
		}
		const scope = Reflect.getPrototypeOf(global)!;
		const ServiceWorkerGlobalScope = objects.native(function () {
			illegal();
		}, 'ServiceWorkerGlobalScope');
		Reflect.defineProperty(ServiceWorkerGlobalScope, 'prototype', {
			value: scope,
			writable: false,
			enumerable: false,
			configurable: false,
		});
		Reflect.defineProperty(scope, 'constructor', {
			configurable: true,
			writable: true,
			value: ServiceWorkerGlobalScope,
		});
		Reflect.defineProperty(scope, Symbol.toStringTag, {
			configurable: true,
			value: 'ServiceWorkerGlobalScope',
		});
		Reflect.setPrototypeOf(
			ServiceWorkerGlobalScope,
			(global as { WorkerGlobalScope?: Function }).WorkerGlobalScope ??
				Function.prototype,
		);
		Reflect.defineProperty(global, 'ServiceWorkerGlobalScope', {
			configurable: true,
			writable: true,
			value: ServiceWorkerGlobalScope,
		});

		// Response.redirect resolves against the worker's URL, which is the
		// route: the site's URL instead
		const NativeResponse = global.Response;
		NativeResponse.redirect = proxy.wrapFunction(
			NativeResponse.redirect,
			(target, that, args) => {
				if (args.length)
					try {
						args[0] = new URL(String(args[0]), this.client.url.toString()).href;
					} catch (error) {
						// the browser's own TypeError
					}
				return Reflect.apply(target, that, args);
			},
		);

		// a FetchEvent's request shows the page's mode (a navigation's cannot
		// be constructed), destination and referrer
		const overrides = new WeakMap<
			Request,
			{ mode: string; destination: string; referrer: string }
		>();
		const RequestPrototype = global.Request.prototype;
		for (const key of ['mode', 'destination', 'referrer'] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				RequestPrototype,
				key,
			)!;
			Reflect.defineProperty(RequestPrototype, key, {
				...descriptor,
				get: proxy.wrapFunction(descriptor.get!, (target, that, args) => {
					const own = overrides.get(that);
					return own ? own[key] : Reflect.apply(target, that, args);
				}),
			});
		}
		RequestPrototype.clone = proxy.wrapFunction(
			RequestPrototype.clone,
			(target, that, args) => {
				const copy = Reflect.apply(target, that, args);
				const own = overrides.get(that);
				if (own) overrides.set(copy, own);
				return copy;
			},
		);
		const nativeResponseType = Reflect.getOwnPropertyDescriptor(
			NativeResponse.prototype,
			'type',
		)!.get!;

		const requestOf = (init: FetchInit['request']): Request => {
			const mode = init.mode === 'navigate' ? 'same-origin' : init.mode;
			const cache =
				init.cache === 'only-if-cached' && mode !== 'same-origin'
					? 'default'
					: init.cache;
			const body =
				init.method === 'GET' || init.method === 'HEAD' ? undefined : init.body;
			const options: RequestInit = {
				method: init.method,
				headers: init.headers,
				body,
				mode,
				credentials: init.credentials,
				cache,
				redirect: init.redirect,
				referrerPolicy: init.referrerPolicy,
				integrity: init.integrity,
				keepalive: init.keepalive,
			};
			let request: Request;
			try {
				request = new global.Request(init.url, options);
			} catch (error) {
				// a mode the method cannot have (no-cors with PUT): as cors
				request = new global.Request(init.url, { ...options, mode: 'cors' });
			}
			overrides.set(request, {
				mode: init.mode,
				destination: init.destination,
				referrer: init.referrer,
			});
			return request;
		};

		/**
		 * The preload responses this worker was given, by their body as the
		 * Response first had it: STomp's service worker sends the body only
		 * once something reads it, so a response passed to respondWith with
		 * that body untouched (not read, locked or teed by a clone) is the
		 * network's answer, which reaches the page without crossing over here
		 */
		const preloads = new WeakMap<
			Response,
			{ body: ReadableStream | null; pulled: () => boolean }
		>();
		const preloadOf = (event: string) =>
			rpc.call('preloadResponse', { event }).then((wire) => {
				if (!wire)
					throw new global.DOMException(
						'The service worker navigation preload request failed due to a network error. This may have been an actual network error, or caused by the browser shutting down, or the service worker crashing.',
						'NetworkError',
					);
				let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
				let pulled = false;
				const nullBody = [101, 103, 204, 205, 304].includes(wire.status);
				const body = nullBody
					? null
					: new global.ReadableStream<Uint8Array>(
							{
								pull: async (controller) => {
									if (!pulled) {
										pulled = true;
										const port = await rpc.call('preloadBody', { event });
										if (!port) {
											controller.error(new global.TypeError('Failed to fetch'));
											return;
										}
										reader = receiveBody(port).getReader();
									}
									const chunk = await reader!.read();
									if (chunk.done) controller.close();
									else controller.enqueue(chunk.value);
								},
								cancel: (reason) => reader?.cancel(reason),
							},
							{ highWaterMark: 0 },
						);
				const response = new NativeResponse(body, {
					status: wire.status,
					statusText: wire.statusText,
					headers: wire.headers,
				});
				recordResponse(response, 'basic', wire.url);
				preloads.set(response, {
					body: nativeBodyOf(response),
					pulled: () => pulled,
				});
				return response;
			});

		const answerOf = async (
			state: FetchState,
			redirect: RequestRedirect,
			mode: RequestMode,
		): Promise<[FetchAnswer, Transferable[]]> => {
			let response: unknown;
			try {
				response = await state.response;
			} catch (error) {
				return [{ kind: 'error', message: 'the promise was rejected.' }, []];
			}
			if (!(response instanceof NativeResponse))
				return [
					{
						kind: 'error',
						message:
							'an object that was not a Response was passed to respondWith().',
					},
					[],
				];
			const type = Reflect.apply(nativeResponseType, response, []);
			if (type === 'error')
				return [
					{ kind: 'error', message: 'a Response whose "type" is "error"' },
					[],
				];
			// an opaque response answers a no-cors request only; for any other
			// mode the page gets a network error (the fetch spec's handle
			// fetch). Through the proxy it is a response the worker sent
			// nothing of (the inject's fetch shows it as opaque), passed on as
			// one with nothing in it
			if (type === 'opaque') {
				if (mode !== 'no-cors')
					return [
						{
							kind: 'error',
							message: `an "opaque" response was used for a request whose type is not no-cors`,
						},
						[],
					];
				// its bytes go on (an image the page shows); the page reads
				// nothing of them
				const stream = nativeBodyOf(response);
				const opaqueBody = stream ? sendBody(stream) : null;
				return [
					{
						kind: 'response',
						response: {
							status: 200,
							statusText: '',
							headers: [],
							body: opaqueBody,
							url: '',
							redirected: false,
							type: 'opaque',
						},
					},
					opaqueBody ? [opaqueBody.$stompBodyPort] : [],
				];
			}
			if (type === 'opaqueredirect') return [{ kind: 'network' }, []];
			const preload = preloads.get(response);
			const stream = preload ? nativeBodyOf(response) : null;
			if (
				preload &&
				!response.bodyUsed &&
				!preload.pulled() &&
				stream === preload.body &&
				!stream?.locked
			) {
				stream?.cancel().catch(() => {});
				return [{ kind: 'preload' }, []];
			}
			if (response.bodyUsed)
				return [
					{
						kind: 'error',
						message:
							'a Response whose "bodyUsed" is "true" cannot be used to respond to a request.',
					},
					[],
				];
			if (redirect !== 'follow' && response.redirected)
				return [
					{
						kind: 'error',
						message:
							'a redirected response was used for a request whose redirect mode is not "follow".',
					},
					[],
				];
			const body = response.body ? sendBody(response.body) : null;
			const wire: WireServiceWorkerResponse = {
				status: response.status,
				statusText: response.statusText,
				headers: [...response.headers],
				body,
				url: response.url,
				redirected: response.redirected,
				type: type === 'cors' ? 'cors' : 'basic',
			};
			return [
				{ kind: 'response', response: wire },
				body ? [body.$stompBodyPort] : [],
			];
		};

		const sourceOf = (source: MessageInit['source']) =>
			'client' in source
				? clientOf(source.client)
				: objects.worker(source.worker, info.registration.id);

		const rpc = new RpcHelper<ToEmulated, FromEmulated>(
			{
				install: async () => [await run(new InstallEvent('install')), []],
				activate: async () => {
					await run(new ExtendableEvent('activate'));
				},
				fetch: async (init) => {
					const request = requestOf(init.request);
					const preloadResponse = init.preload ? preloadOf(init.id) : undefined;
					// one the worker never reads rejects unseen
					preloadResponse?.catch(() => {});
					const event = new FetchEvent('fetch', {
						request,
						clientId: init.clientId,
						resultingClientId: init.resultingClientId,
						isReload: init.isReload,
						...(preloadResponse ? { preloadResponse } : {}),
					});
					const state = fetches.get(event)!;
					const extension = extensions.get(event)!;
					extension.trusted = true;
					extension.dispatching = true;
					try {
						objects.dispatch(global, event);
					} finally {
						extension.dispatching = false;
					}
					if (!state.response) {
						state.resolveHandled?.();
						return [false, []];
					}
					answerOf(state, init.request.redirect, init.request.mode).then(
						([answer, transfer]) => {
							if (answer.kind === 'error') {
								console.warn(
									`The FetchEvent for "${init.request.url}" resulted in a network error response: ${answer.message}`,
								);
								state.rejectHandled?.(
									new global.DOMException(
										'The fetch was not handled.',
										'NetworkError',
									),
								);
							} else state.resolveHandled?.();
							rpc.call('respond', { event: init.id, answer }, transfer);
						},
					);
					return [true, []];
				},
				message: async (init) => {
					const event = new ExtendableMessageEvent('message', {
						data: init.data,
						origin: init.origin,
						source: sourceOf(init.source),
						ports: init.ports,
					});
					run(event);
				},
				steps: async ({ registration: snapshot, steps }) => {
					objects.apply(snapshot, steps);
				},
				cookieChange: async ({ changed, deleted }) => [
					await run(
						new ExtendableCookieChangeEvent('cookiechange', {
							changed: changed.map(cookieMethods.item),
							deleted: deleted.map(cookieMethods.deletedItem),
						}),
					),
					[],
				],
				sync: async ({ tag, lastChance }) => [
					await run(new SyncEvent('sync', { tag, lastChance })),
					[],
				],
				backgroundFetch: async ({ type, fetch }) => {
					const object = objects.backgroundFetch!(
						fetch,
						objects.snapshotOf(registration),
					);
					const Event =
						type === 'backgroundfetchabort'
							? BackgroundFetchEvent
							: BackgroundFetchUpdateUIEvent;
					return [await run(new Event(type, { registration: object })), []];
				},
			},
			SW_RPC,
			send,
		);

		const portOf = getServiceWorkerPort();
		portOf?.then(async (arrived) => {
			arrived.addEventListener('message', (event) => rpc.receive(event.data));
			arrived.start();
			port = arrived;
			for (const [data, transfer] of outbox.splice(0))
				postToPort(arrived, data, transfer);
			const result = await evaluated;
			rpc.call('hello', { evaluated: result.ok, error: result.error });
		});
	}
}

function transferOf(options: unknown): Transferable[] {
	if (Array.isArray(options)) return options;
	if (
		typeof options === 'object' &&
		options !== null &&
		Array.isArray((options as StructuredSerializeOptions).transfer)
	)
		return (options as StructuredSerializeOptions).transfer!;
	return [];
}

function portsOf(transfer: Transferable[]): MessagePort[] {
	return transfer.filter(
		(item): item is MessagePort =>
			typeof MessagePort !== 'undefined' && item instanceof MessagePort,
	);
}

/**
 * What cannot be cloned throws now, as natively (the message itself goes
 * later, once the port is there). A message that transfers ports is posted
 * as it is: cloning it here would take the ports
 */
function checkClone(
	global: typeof globalThis,
	message: unknown,
	transfer: Transferable[],
) {
	if (!transfer.length) global.structuredClone(message);
}
