// The ServiceWorkerRegistration, ServiceWorker, NavigationPreloadManager and
// PushManager objects of an emulated service worker (docs/service-workers.md),
// over the realm's own native prototypes: each member is replaced by a
// wrapper of the native one (its source still reads as native code) that
// answers for the objects made here. The page module and the emulated
// worker's global both use it; a realm without a native `ServiceWorker` (a
// dedicated worker) gets one that looks like it.

import type {
	ErrorInfo,
	NavigationPreloadState,
	RegistrationSnapshot,
	StateStep,
	UpdateViaCache,
	WorkerSnapshot,
	WorkerState,
} from '../serviceWorkerTypes';
import type ProxyModule from './modules/Proxy';
import { nativeFunction } from './nativeUtil';

/** what the objects ask of whoever talks to Stomp's service worker */
export interface ObjectsBackend {
	update(registration: RegistrationSnapshot): Promise<void>;
	unregister(registration: RegistrationSnapshot): Promise<boolean>;
	/** post to an emulated worker; throws synchronously for what cannot be cloned */
	postMessage(
		worker: WorkerSnapshot,
		registration: RegistrationSnapshot,
		message: unknown,
		transfer: Transferable[],
	): void;
	preload(
		registration: RegistrationSnapshot,
		op: 'enable' | 'disable' | 'setHeaderValue' | 'getState',
		value?: unknown,
	): Promise<unknown>;
}

interface RegistrationState {
	snapshot: RegistrationSnapshot;
	installing: object | null;
	waiting: object | null;
	active: object | null;
	preload: object;
	push: object;
	removed: boolean;
}

interface WorkerObjectState {
	snapshot: WorkerSnapshot;
	registration: string;
}

/** the registration members a browser without the feature lacks (with their interfaces) */
const ABSENT_MEMBERS = [
	'sync',
	'periodicSync',
	'backgroundFetch',
	'paymentManager',
	'cookies',
	'index',
];
const ABSENT_GLOBALS = [
	'SyncManager',
	'PeriodicSyncManager',
	'BackgroundFetchManager',
	'BackgroundFetchRecord',
	'BackgroundFetchRegistration',
	'PaymentManager',
	'CookieStoreManager',
	'ContentIndex',
];

export default class ServiceWorkerObjects {
	readonly global: typeof globalThis;
	readonly #proxy: ProxyModule;
	readonly #backend: ObjectsBackend;
	readonly #registrations = new Map<string, object>();
	readonly #workers = new Map<string, object>();
	readonly #registrationStates = new WeakMap<object, RegistrationState>();
	readonly #workerStates = new WeakMap<object, WorkerObjectState>();
	readonly #preloads = new WeakMap<object, RegistrationState>();
	readonly #pushes = new WeakSet<object>();
	readonly #handlers = new WeakMap<object, Map<string, unknown>>();
	readonly #addEventListener: typeof EventTarget.prototype.addEventListener;
	readonly #dispatchEvent: typeof EventTarget.prototype.dispatchEvent;
	readonly #Registration: Function;
	readonly #ServiceWorker: Function;
	constructor(
		global: typeof globalThis,
		proxy: ProxyModule,
		backend: ObjectsBackend,
	) {
		this.global = global;
		this.#proxy = proxy;
		this.#backend = backend;
		this.#addEventListener = global.EventTarget.prototype.addEventListener;
		this.#dispatchEvent = global.EventTarget.prototype.dispatchEvent;
		this.#Registration = global.ServiceWorkerRegistration;
		this.#ServiceWorker =
			(global as { ServiceWorker?: Function }).ServiceWorker ??
			this.#fakeServiceWorker();
		this.#hookRegistration();
		this.#hookServiceWorker();
		this.#hookPreload();
		this.#hookPush();
		for (const name of ABSENT_GLOBALS) Reflect.deleteProperty(global, name);
	}

	/** an error of this realm for what Stomp's service worker reported */
	error(info: ErrorInfo): Error {
		const { global } = this;
		if (info.name === 'TypeError') return new global.TypeError(info.message);
		return new global.DOMException(info.message, info.name);
	}

	/** a function whose source reads as the native `name`'s */
	native<T extends Function>(fn: T, name: string, length = 0): T {
		this.#proxy.functionStrings.set(fn, nativeFunction(name));
		Reflect.defineProperty(fn, 'name', {
			configurable: true,
			value: name,
		});
		Reflect.defineProperty(fn, 'length', {
			configurable: true,
			value: length,
		});
		return fn;
	}

	/**
	 * Replace `proto[name]` (an accessor or a method) with a wrapper that runs
	 * `get`/`set`/`call` for `brand`ed objects and the native member for any
	 * other. A member the realm lacks is defined anew.
	 */
	hook(
		proto: object,
		name: string,
		brand: (that: unknown) => boolean,
		impl: {
			get?: (that: any) => unknown;
			set?: (that: any, value: unknown) => void;
			call?: (that: any, args: unknown[]) => unknown;
			length?: number;
			/** for a non-branded receiver (default: the native member) */
			foreign?: (that: unknown, args: unknown[]) => unknown;
		},
	) {
		const descriptor = Reflect.getOwnPropertyDescriptor(proto, name);
		const illegal = () => {
			throw new this.global.TypeError('Illegal invocation');
		};
		if (impl.call) {
			const native =
				(descriptor?.value as Function | undefined) ??
				this.native(function () {}, name, impl.length ?? 0);
			Reflect.defineProperty(proto, name, {
				configurable: true,
				enumerable: descriptor?.enumerable ?? true,
				writable: true,
				value: this.#proxy.wrapFunction(native, (target, that, args) => {
					if (brand(that)) return impl.call!(that, args);
					if (impl.foreign) return impl.foreign(that, args);
					return descriptor?.value
						? Reflect.apply(target, that, args)
						: illegal();
				}),
			});
			return;
		}
		const get = descriptor?.get ?? this.native(function () {}, `get ${name}`);
		const set =
			descriptor?.set ??
			(impl.set ? this.native(function () {}, `set ${name}`, 1) : undefined);
		Reflect.defineProperty(proto, name, {
			configurable: true,
			enumerable: descriptor?.enumerable ?? true,
			get: this.#proxy.wrapFunction(get, (target, that, args) => {
				if (brand(that)) return impl.get!(that);
				return descriptor?.get ? Reflect.apply(target, that, args) : illegal();
			}),
			...(set
				? {
						set: this.#proxy.wrapFunction(set, (target, that, args) => {
							if (brand(that)) return impl.set!(that, args[0]);
							return descriptor?.set
								? Reflect.apply(target, that, args)
								: illegal();
						}),
					}
				: {}),
		});
	}

	/** an `on<type>` attribute for branded objects */
	handler(proto: object, type: string, brand: (that: unknown) => boolean) {
		this.hook(proto, `on${type}`, brand, {
			get: (that) => this.#handlers.get(that)?.get(type) ?? null,
			set: (that, value) => this.setHandler(that, type, value),
		});
	}

	/** set an event handler: called from one listener added the first time */
	setHandler(target: object, type: string, value: unknown) {
		let map = this.#handlers.get(target);
		if (!map) this.#handlers.set(target, (map = new Map()));
		const first = !map.has(type);
		map.set(
			type,
			typeof value === 'function' || (typeof value === 'object' && value)
				? value
				: null,
		);
		if (!first) return;
		const handlers = map;
		Reflect.apply(this.#addEventListener, target, [
			type,
			(event: Event) => {
				const handler = handlers.get(type);
				if (typeof handler !== 'function') return;
				const result = Reflect.apply(handler, target, [event]);
				if (result === false) event.preventDefault();
			},
		]);
	}

	getHandler(target: object, type: string): unknown {
		return this.#handlers.get(target)?.get(type) ?? null;
	}

	dispatch(target: object, event: Event) {
		Reflect.apply(this.#dispatchEvent, target, [event]);
	}

	/** a real EventTarget whose prototype is `ctor`'s */
	eventTarget(ctor: Function): object {
		return Reflect.construct(this.global.EventTarget, [], ctor);
	}

	isRegistration = (that: unknown): boolean =>
		typeof that === 'object' &&
		that !== null &&
		this.#registrationStates.has(that);

	isWorker = (that: unknown): boolean =>
		typeof that === 'object' && that !== null && this.#workerStates.has(that);

	/** the registration object of `snapshot`'s id, made from it when new */
	registration(snapshot: RegistrationSnapshot): object {
		let object = this.#registrations.get(snapshot.id);
		if (object) {
			const state = this.#registrationStates.get(object)!;
			// a reply newer than the steps this realm heard: only what no step
			// has told yet (the steps in flight still fire their events)
			if (state.removed) state.removed = false;
			return object;
		}
		object = this.eventTarget(this.#Registration);
		const preload = Object.create(
			(this.global as { NavigationPreloadManager?: Function })
				.NavigationPreloadManager?.prototype ?? Object.prototype,
		);
		const push = Object.create(
			(this.global as { PushManager?: Function }).PushManager?.prototype ??
				Object.prototype,
		);
		const state: RegistrationState = {
			snapshot: { ...snapshot },
			installing: this.worker(snapshot.installing, snapshot.id),
			waiting: this.worker(snapshot.waiting, snapshot.id),
			active: this.worker(snapshot.active, snapshot.id),
			preload,
			push,
			removed: false,
		};
		this.#registrationStates.set(object, state);
		this.#preloads.set(preload, state);
		this.#pushes.add(push);
		this.#registrations.set(snapshot.id, object);
		return object;
	}

	/** a registration object this realm already has */
	known(id: string): object | undefined {
		return this.#registrations.get(id);
	}

	snapshotOf(registration: object): RegistrationSnapshot {
		return this.#registrationStates.get(registration)!.snapshot;
	}

	/** the ServiceWorker object of a version (null for none) */
	worker(snapshot: WorkerSnapshot | null, registration: string): object | null {
		if (!snapshot) return null;
		let object = this.#workers.get(snapshot.id);
		if (object) return object;
		object = this.eventTarget(this.#ServiceWorker);
		this.#workerStates.set(object, {
			snapshot: { ...snapshot },
			registration,
		});
		this.#workers.set(snapshot.id, object);
		return object;
	}

	workerSnapshot(worker: object): WorkerSnapshot {
		return this.#workerStates.get(worker)!.snapshot;
	}

	/**
	 * Apply the steps of a registration this realm has an object for, in
	 * order, firing `statechange` and `updatefound` as each takes effect;
	 * steps the object already includes are skipped
	 */
	apply(snapshot: RegistrationSnapshot, steps: StateStep[]) {
		const object = this.#registrations.get(snapshot.id);
		if (!object) return;
		const state = this.#registrationStates.get(object)!;
		for (const step of steps) {
			if (step.serial <= state.snapshot.serial) continue;
			state.snapshot.serial = step.serial;
			if (step.op === 'slot') {
				state.snapshot[step.slot] = step.worker;
				state[step.slot] = this.worker(step.worker, snapshot.id);
			} else if (step.op === 'state') {
				const worker = this.worker(step.worker, snapshot.id)!;
				const workerState = this.#workerStates.get(worker)!;
				if (workerState.snapshot.state === step.worker.state) continue;
				workerState.snapshot.state = step.worker.state;
				for (const slot of ['installing', 'waiting', 'active'] as const)
					if (state.snapshot[slot]?.id === step.worker.id)
						state.snapshot[slot] = { ...step.worker };
				this.dispatch(worker, new this.global.Event('statechange'));
			} else if (step.op === 'updatefound') {
				this.dispatch(object, new this.global.Event('updatefound'));
			}
		}
		state.snapshot.updateViaCache = snapshot.updateViaCache;
		state.snapshot.navigationPreload = snapshot.navigationPreload;
		if (snapshot.serial > state.snapshot.serial)
			state.snapshot.serial = snapshot.serial;
	}

	/** the registration is gone: its object stays, as natively, with nothing in it */
	remove(id: string) {
		const object = this.#registrations.get(id);
		if (!object) return;
		const state = this.#registrationStates.get(object)!;
		state.removed = true;
		this.#registrations.delete(id);
	}

	setWorkerState(id: string, value: WorkerState) {
		const object = this.#workers.get(id);
		if (object) this.#workerStates.get(object)!.snapshot.state = value;
	}

	#fakeServiceWorker(): Function {
		const global = this.global;
		const ServiceWorker = this.native(function () {
			throw new global.TypeError('Illegal constructor');
		}, 'ServiceWorker');
		ServiceWorker.prototype = Object.create(global.EventTarget.prototype);
		Reflect.defineProperty(ServiceWorker.prototype, 'constructor', {
			configurable: true,
			writable: true,
			value: ServiceWorker,
		});
		Reflect.defineProperty(ServiceWorker.prototype, Symbol.toStringTag, {
			configurable: true,
			value: 'ServiceWorker',
		});
		Reflect.setPrototypeOf(ServiceWorker, global.EventTarget);
		Reflect.defineProperty(global, 'ServiceWorker', {
			configurable: true,
			writable: true,
			value: ServiceWorker,
		});
		return ServiceWorker;
	}

	#hookRegistration() {
		const proto = this.#Registration.prototype;
		const brand = this.isRegistration;
		const state = (that: object) => this.#registrationStates.get(that)!;
		for (const slot of ['installing', 'waiting', 'active'] as const)
			this.hook(proto, slot, brand, {
				get: (that) => (state(that).removed ? null : state(that)[slot]),
			});
		this.hook(proto, 'navigationPreload', brand, {
			get: (that) => state(that).preload,
		});
		this.hook(proto, 'scope', brand, {
			get: (that) => state(that).snapshot.scope,
		});
		this.hook(proto, 'updateViaCache', brand, {
			get: (that) => state(that).snapshot.updateViaCache as UpdateViaCache,
		});
		this.handler(proto, 'updatefound', brand);
		this.hook(proto, 'update', brand, {
			call: async (that) => {
				await this.#backend.update(state(that).snapshot);
				return that;
			},
		});
		this.hook(proto, 'unregister', brand, {
			call: (that) => this.#backend.unregister(state(that).snapshot),
		});
		this.hook(proto, 'pushManager', brand, {
			get: (that) => state(that).push,
		});
		this.hook(proto, 'showNotification', brand, {
			length: 1,
			call: async (that, args) => {
				if (args.length < 1)
					throw new this.global.TypeError(
						"Failed to execute 'showNotification' on 'ServiceWorkerRegistration': 1 argument required, but only 0 present.",
					);
				throw new this.global.TypeError(
					"Failed to execute 'showNotification' on 'ServiceWorkerRegistration': No notification permission has been granted for this origin.",
				);
			},
		});
		this.hook(proto, 'getNotifications', brand, {
			call: async () => [],
		});
		for (const name of ABSENT_MEMBERS) Reflect.deleteProperty(proto, name);
	}

	#hookServiceWorker() {
		const proto = this.#ServiceWorker.prototype;
		const brand = this.isWorker;
		const state = (that: object) => this.#workerStates.get(that)!;
		this.hook(proto, 'scriptURL', brand, {
			get: (that) => state(that).snapshot.scriptURL,
		});
		this.hook(proto, 'state', brand, {
			get: (that) => state(that).snapshot.state,
		});
		this.handler(proto, 'statechange', brand);
		this.handler(proto, 'error', brand);
		this.hook(proto, 'postMessage', brand, {
			length: 1,
			call: (that, args) => {
				if (args.length < 1)
					throw new this.global.TypeError(
						"Failed to execute 'postMessage' on 'ServiceWorker': 1 argument required, but only 0 present.",
					);
				const own = state(that);
				// a worker that is gone takes nothing, silently
				if (own.snapshot.state === 'redundant') return;
				const options = args[1];
				const transfer: Transferable[] = Array.isArray(options)
					? options
					: typeof options === 'object' &&
						  options !== null &&
						  Array.isArray((options as StructuredSerializeOptions).transfer)
						? (options as StructuredSerializeOptions).transfer!
						: [];
				const registration = this.#registrations.get(own.registration);
				if (!registration) return;
				this.#backend.postMessage(
					own.snapshot,
					this.snapshotOf(registration),
					args[0],
					transfer,
				);
			},
		});
	}

	#hookPreload() {
		const Manager = (this.global as { NavigationPreloadManager?: Function })
			.NavigationPreloadManager;
		if (!Manager) return;
		const brand = (that: unknown) =>
			typeof that === 'object' && that !== null && this.#preloads.has(that);
		const of = (that: object) => this.#preloads.get(that)!.snapshot;
		const run = async (
			that: object,
			op: 'enable' | 'disable' | 'setHeaderValue' | 'getState',
			value?: unknown,
		) => {
			const snapshot = of(that);
			const result = await this.#backend.preload(snapshot, op, value);
			if (op !== 'getState') {
				snapshot.navigationPreload = result as NavigationPreloadState;
				return undefined;
			}
			return { ...(result as NavigationPreloadState) };
		};
		const proto = Manager.prototype;
		this.hook(proto, 'enable', brand, { call: (that) => run(that, 'enable') });
		this.hook(proto, 'disable', brand, {
			call: (that) => run(that, 'disable'),
		});
		this.hook(proto, 'setHeaderValue', brand, {
			length: 1,
			call: async (that, args) => {
				if (args.length < 1)
					throw new this.global.TypeError(
						"Failed to execute 'setHeaderValue' on 'NavigationPreloadManager': 1 argument required, but only 0 present.",
					);
				return run(that, 'setHeaderValue', String(args[0]));
			},
		});
		this.hook(proto, 'getState', brand, {
			call: (that) => run(that, 'getState'),
		});
	}

	/** push as with the notification permission denied */
	#hookPush() {
		const Push = (this.global as { PushManager?: Function }).PushManager;
		if (!Push) return;
		const brand = (that: unknown) =>
			typeof that === 'object' && that !== null && this.#pushes.has(that);
		const proto = Push.prototype;
		this.hook(proto, 'subscribe', brand, {
			call: async () => {
				throw new this.global.DOMException(
					'Registration failed - permission denied',
					'NotAllowedError',
				);
			},
		});
		this.hook(proto, 'getSubscription', brand, { call: async () => null });
		this.hook(proto, 'permissionState', brand, {
			call: async () => 'denied',
		});
	}
}
