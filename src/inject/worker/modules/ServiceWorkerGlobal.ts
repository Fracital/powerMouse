import type {
	ClientInfo,
	EmulateInfo,
	FetchAnswer,
	FetchInit,
	FromEmulated,
	MessageInit,
	ToEmulated,
	WireServiceWorkerResponse,
} from '../../../serviceWorkerTypes';
import { sendBody } from '../../../transport/bodyPort';
import { postToPort, SW_RPC } from '../../../transport/messages';
import { RpcHelper } from '../../../transport/rpc';
import Module from '../../Module';
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

/** the event handler attributes a service worker's global has (those of the features it lacks are absent) */
const HANDLERS = [
	'install',
	'activate',
	'fetch',
	'push',
	'pushsubscriptionchange',
	'notificationclick',
	'notificationclose',
];

/**
 * The global of a page's emulated service worker (docs/service-workers.md):
 * a dedicated Worker that the `sw:` route's preamble turns into what reads
 * as a ServiceWorkerGlobalScope, talking to Stomp's service worker over the
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

		// the rpc to Stomp's service worker: what is called before the port
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

		const objects = new ServiceWorkerObjects(global, proxy, {
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
			preload: (_registration, op, value) => rpc.call('preload', { op, value }),
		});
		const registration = objects.registration(info.registration);
		const self = objects.worker(info.version, info.registration.id)!;

		const nativeClass = (
			cls: Function,
			name: string,
			length: number,
			parent?: Function,
		) => {
			objects.native(cls, name, length);
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
			if (parent) Reflect.setPrototypeOf(cls, parent);
			Reflect.defineProperty(global, name, {
				configurable: true,
				writable: true,
				value: cls,
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
		const Client = objects.native(
			function Client() {
				illegal();
			} as unknown as Function,
			'Client',
		);
		const WindowClient = objects.native(
			function WindowClient() {
				illegal();
			} as unknown as Function,
			'WindowClient',
		);
		const Clients = objects.native(
			function Clients() {
				illegal();
			} as unknown as Function,
			'Clients',
		);
		Client.prototype = {};
		WindowClient.prototype = Object.create(Client.prototype);
		Reflect.setPrototypeOf(WindowClient, Client);
		Clients.prototype = {};
		for (const [ctor, name] of [
			[Client, 'Client'],
			[WindowClient, 'WindowClient'],
			[Clients, 'Clients'],
		] as const) {
			Reflect.defineProperty(ctor.prototype, 'constructor', {
				configurable: true,
				writable: true,
				value: ctor,
			});
			Reflect.defineProperty(ctor.prototype, Symbol.toStringTag, {
				configurable: true,
				value: name,
			});
			Reflect.defineProperty(global, name, {
				configurable: true,
				writable: true,
				value: ctor,
			});
		}
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
		for (const name of DEDICATED_ONLY) Reflect.deleteProperty(global, name);
		const scope = Reflect.getPrototypeOf(global)!;
		const ServiceWorkerGlobalScope = objects.native(function () {
			illegal();
		}, 'ServiceWorkerGlobalScope');
		ServiceWorkerGlobalScope.prototype = scope;
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

		const answerOf = async (
			state: FetchState,
			redirect: RequestRedirect,
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
			if (type === 'opaque' || type === 'opaqueredirect')
				return [{ kind: 'network' }, []];
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
					const event = new FetchEvent('fetch', {
						request,
						clientId: init.clientId,
						resultingClientId: init.resultingClientId,
						isReload: init.isReload,
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
					answerOf(state, init.request.redirect).then(([answer, transfer]) => {
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
					});
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
