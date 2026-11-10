// The ServiceWorkerRegistration, ServiceWorker, NavigationPreloadManager and
// PushManager objects of an emulated service worker (docs/service-workers.md),
// over the realm's own native prototypes: each member is replaced by a
// wrapper of the native one (its source still reads as native code) that
// answers for the objects made here. The page module and the emulated
// worker's global both use it; a realm without a native `ServiceWorker` (a
// dedicated worker) gets one that looks like it.

import type {
	BackgroundFetchRecordWire,
	BackgroundFetchSnapshot,
	ErrorInfo,
	ManagerKind,
	NavigationPreloadState,
	RegistrationSnapshot,
	StateStep,
	UpdateViaCache,
	WorkerSnapshot,
	WorkerState,
} from '../serviceWorkerTypes';
import type ProxyModule from './modules/Proxy';
import { nativeFunction } from './nativeUtil';

/** what the objects ask of whoever talks to STomp's service worker */
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
	/** a call of one of the registration's managers (sync, periodicSync, backgroundFetch, paymentManager, cookies) */
	manager(
		registration: RegistrationSnapshot,
		kind: ManagerKind,
		op: string,
		args: Record<string, unknown>,
	): Promise<unknown>;
}

export interface ObjectsOptions {
	/** the realm is the emulated worker's (push answers and backgroundFetch.fetch differ there) */
	inWorker?: boolean;
}

/** ServiceWorkerRegistration.prototype's members in Chrome 152's order */
const REGISTRATION_ORDER = [
	'installing',
	'waiting',
	'active',
	'navigationPreload',
	'scope',
	'updateViaCache',
	'onupdatefound',
	'unregister',
	'update',
	'paymentManager',
	'constructor',
	'backgroundFetch',
	'periodicSync',
	'sync',
	'cookies',
	'pushManager',
	'getNotifications',
	'showNotification',
];

/** a manager a registration has, by the member that holds it */
const MANAGERS = {
	sync: 'SyncManager',
	periodicSync: 'PeriodicSyncManager',
	backgroundFetch: 'BackgroundFetchManager',
	paymentManager: 'PaymentManager',
	cookies: 'CookieStoreManager',
} as const;

interface RegistrationState {
	snapshot: RegistrationSnapshot;
	installing: object | null;
	waiting: object | null;
	active: object | null;
	preload: object;
	push: object;
	managers: Map<ManagerKind, object>;
	/** paymentManager.userHint, as the page last set it */
	userHint: string;
	removed: boolean;
}

interface FetchState {
	snapshot: BackgroundFetchSnapshot;
	registration: RegistrationSnapshot;
}

interface WorkerObjectState {
	snapshot: WorkerSnapshot;
	registration: string;
}

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
	readonly #managers = new WeakMap<
		object,
		{ kind: ManagerKind; state: RegistrationState }
	>();
	readonly #fetches = new WeakMap<object, FetchState>();
	readonly #records = new WeakMap<
		object,
		{ request: Request; response: Promise<Response> }
	>();
	readonly #inWorker: boolean;
	/** the interfaces this realm uses, its own or stand-ins (the worker exposes the ones a service worker has) */
	readonly classes = new Map<string, Function>();
	/** a background fetch registration object of this realm (the worker's events carry one) */
	backgroundFetch?: (
		snapshot: BackgroundFetchSnapshot,
		registration: RegistrationSnapshot,
	) => object;
	readonly #handlers = new WeakMap<object, Map<string, unknown>>();
	readonly #addEventListener: typeof EventTarget.prototype.addEventListener;
	readonly #dispatchEvent: typeof EventTarget.prototype.dispatchEvent;
	readonly #Registration: Function;
	readonly #ServiceWorker: Function;
	constructor(
		global: typeof globalThis,
		proxy: ProxyModule,
		backend: ObjectsBackend,
		options: ObjectsOptions = {},
	) {
		this.global = global;
		this.#proxy = proxy;
		this.#backend = backend;
		this.#inWorker = !!options.inWorker;
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
		this.#hookManagers();
	}

	/**
	 * The realm's interface `name`, or a stand-in that reads as one: an
	 * illegal constructor whose source reads as native code, with a
	 * read-only prototype under `parent`'s. Kept in `classes`, never put on
	 * the global here
	 */
	classFor(name: string, parent?: Function): Function {
		const known = this.classes.get(name);
		if (known) return known;
		const own = (this.global as unknown as Record<string, unknown>)[name];
		const ctor =
			typeof own === 'function'
				? (own as Function)
				: this.fakeClass(name, parent);
		this.classes.set(name, ctor);
		return ctor;
	}

	/** an illegal constructor named `name` (see classFor) */
	fakeClass(name: string, parent?: Function): Function {
		const global = this.global;
		const ctor = this.native(function () {
			throw new global.TypeError('Illegal constructor');
		}, name);
		const proto = Object.create(
			parent ? parent.prototype : global.Object.prototype,
		);
		Reflect.defineProperty(proto, 'constructor', {
			configurable: true,
			writable: true,
			value: ctor,
		});
		Reflect.defineProperty(proto, Symbol.toStringTag, {
			configurable: true,
			value: name,
		});
		// natively an interface's prototype is read-only
		Reflect.defineProperty(ctor, 'prototype', {
			value: proto,
			writable: false,
			enumerable: false,
			configurable: false,
		});
		if (parent) Reflect.setPrototypeOf(ctor, parent);
		return ctor;
	}

	/** an error of this realm for what STomp's service worker reported */
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
			managers: new Map(),
			userHint: '',
			removed: false,
		};
		this.#registrationStates.set(object, state);
		this.#preloads.set(preload, state);
		this.#pushes.add(push);
		for (const [kind, name] of Object.entries(MANAGERS) as [
			ManagerKind,
			string,
		][]) {
			const manager = Object.create(this.classFor(name).prototype);
			state.managers.set(kind, manager);
			this.#managers.set(manager, { kind, state });
		}
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
		const ServiceWorker = this.fakeClass(
			'ServiceWorker',
			this.global.EventTarget,
		);
		this.classes.set('ServiceWorker', ServiceWorker);
		Reflect.defineProperty(this.global, 'ServiceWorker', {
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
		for (const kind of Object.keys(MANAGERS) as ManagerKind[])
			this.hook(proto, kind, brand, {
				get: (that) => state(that).managers.get(kind),
			});
		// a member the realm lacked was added last: the members in Chrome's
		// order, as the prototype lists them natively
		const order = Reflect.ownKeys(proto).filter(
			(key): key is string => typeof key === 'string',
		);
		const wanted = REGISTRATION_ORDER.filter((key) => order.includes(key));
		const current = order.filter((key) => REGISTRATION_ORDER.includes(key));
		if (wanted.join() !== current.join())
			for (const key of wanted) {
				const descriptor = Reflect.getOwnPropertyDescriptor(proto, key)!;
				Reflect.deleteProperty(proto, key);
				Reflect.defineProperty(proto, key, descriptor);
			}
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

	/**
	 * push as Chrome answers without the notification permission (measured:
	 * `prompt` in a page, `denied` in a worker, and a subscribe that fails)
	 */
	#hookPush() {
		const Push = this.classFor('PushManager');
		const brand = (that: unknown) =>
			typeof that === 'object' && that !== null && this.#pushes.has(that);
		const proto = Push.prototype;
		this.hook(proto, 'subscribe', brand, {
			call: async () => {
				throw new this.global.DOMException(
					'Registration failed - permission denied',
					'AbortError',
				);
			},
		});
		this.hook(proto, 'getSubscription', brand, { call: async () => null });
		this.hook(proto, 'permissionState', brand, {
			call: async () => (this.#inWorker ? 'denied' : 'prompt'),
		});
	}

	/** a manager method's missing-argument error, as the browser words it */
	#required(method: string, on: string, count: number, got: number) {
		if (got >= count) return;
		throw new this.global.TypeError(
			`Failed to execute '${method}' on '${on}': ${count} argument${count > 1 ? 's' : ''} required, but only ${got} present.`,
		);
	}

	/**
	 * The registration's managers, each over STomp's service worker
	 * (docs/service-workers.md): sync runs (its event reaches the worker),
	 * periodic sync is refused as Chrome refuses it without the permission,
	 * background fetch downloads through the proxy and tells the worker,
	 * the payment manager and cookie change subscriptions keep what they
	 * are given
	 */
	#hookManagers() {
		const global = this.global;
		const of = (that: object) => this.#managers.get(that)!;
		const brandOf = (kind: ManagerKind) => (that: unknown) =>
			typeof that === 'object' &&
			that !== null &&
			this.#managers.get(that)?.kind === kind;
		const run = (
			that: object,
			op: string,
			args: Record<string, unknown> = {},
		) => {
			const { kind, state } = of(that);
			return this.#backend.manager(state.snapshot, kind, op, args);
		};
		const method = (
			kind: ManagerKind,
			name: string,
			required: number,
			call: (that: object, args: unknown[]) => Promise<unknown>,
		) => {
			const on = MANAGERS[kind];
			this.hook(this.classFor(on).prototype, name, brandOf(kind), {
				length: required,
				call: async (that, args) => {
					this.#required(name, on, required, args.length);
					return call(that, args);
				},
			});
		};

		method('sync', 'register', 1, (that, [tag]) =>
			run(that, 'register', { tag: String(tag) }),
		);
		method('sync', 'getTags', 0, (that) => run(that, 'getTags'));

		method('periodicSync', 'register', 1, (that, [tag, options]) =>
			run(that, 'register', {
				tag: String(tag),
				minInterval: Number(
					(options as { minInterval?: unknown } | undefined)?.minInterval ?? 0,
				),
			}),
		);
		method('periodicSync', 'getTags', 0, (that) => run(that, 'getTags'));
		method('periodicSync', 'unregister', 1, (that, [tag]) =>
			run(that, 'unregister', { tag: String(tag) }),
		);

		this.hook(
			this.classFor('PaymentManager').prototype,
			'userHint',
			brandOf('paymentManager'),
			{
				get: (that) => of(that).state.userHint,
				set: (that, value) => {
					const state = of(that).state;
					state.userHint = String(value);
					run(that, 'userHint', { value: state.userHint }).catch(() => {});
				},
			},
		);
		method('paymentManager', 'enableDelegations', 1, (that, [list]) =>
			run(that, 'enableDelegations', {
				delegations: [...((list as Iterable<unknown>) ?? [])].map(String),
			}),
		);

		const subscriptions = (list: unknown) =>
			[...((list as Iterable<{ name?: unknown; url?: unknown }>) ?? [])].map(
				(item) => ({
					...(item?.name !== undefined ? { name: String(item.name) } : {}),
					...(item?.url !== undefined ? { url: String(item.url) } : {}),
				}),
			);
		method('cookies', 'subscribe', 1, (that, [list]) =>
			run(that, 'subscribe', { subscriptions: subscriptions(list) }),
		);
		method('cookies', 'getSubscriptions', 0, (that) =>
			run(that, 'getSubscriptions'),
		);
		method('cookies', 'unsubscribe', 1, (that, [list]) =>
			run(that, 'unsubscribe', { subscriptions: subscriptions(list) }),
		);

		// background fetch: the registrations it makes, and their records
		const Registration = this.classFor(
			'BackgroundFetchRegistration',
			global.EventTarget,
		);
		const Record = this.classFor('BackgroundFetchRecord');
		const fetchOf = (that: object) => this.#fetches.get(that)!;
		const isFetch = (that: unknown) =>
			typeof that === 'object' && that !== null && this.#fetches.has(that);
		const made = new Map<string, object>();
		const fetchObject = (
			snapshot: BackgroundFetchSnapshot,
			registration: RegistrationSnapshot,
		) => {
			const key = `${registration.id} ${snapshot.id}`;
			let object = made.get(key);
			if (!object) {
				object = this.eventTarget(Registration);
				made.set(key, object);
				this.#fetches.set(object, { snapshot, registration });
			} else this.#fetches.get(object)!.snapshot = snapshot;
			return object;
		};
		this.backgroundFetch = fetchObject;
		const requestsOf = (value: unknown) =>
			(Array.isArray(value) ? value : [value]).map((item) => {
				const request =
					item instanceof global.Request
						? item
						: new global.Request(String(item));
				return {
					url: request.url,
					method: request.method,
					headers: [...request.headers] as [string, string][],
				};
			});
		method(
			'backgroundFetch',
			'fetch',
			2,
			async (that, [id, requests, options]) => {
				if (this.#inWorker)
					throw new global.DOMException(
						"Failed to execute 'fetch' on 'BackgroundFetchManager': backgroundFetch.fetch() is not allowed in service worker environments.",
						'NotAllowedError',
					);
				const opts = (options ?? {}) as {
					title?: unknown;
					downloadTotal?: unknown;
				};
				const snapshot = (await run(that, 'fetch', {
					id: String(id),
					requests: requestsOf(requests),
					title: opts.title === undefined ? '' : String(opts.title),
					downloadTotal: Number(opts.downloadTotal ?? 0),
				})) as BackgroundFetchSnapshot;
				return fetchObject(snapshot, of(that).state.snapshot);
			},
		);
		method('backgroundFetch', 'get', 1, async (that, [id]) => {
			const snapshot = (await run(that, 'get', {
				id: String(id),
			})) as BackgroundFetchSnapshot | null;
			return snapshot
				? fetchObject(snapshot, of(that).state.snapshot)
				: undefined;
		});
		method('backgroundFetch', 'getIds', 0, (that) => run(that, 'getIds'));

		const proto = Registration.prototype;
		for (const key of [
			'id',
			'uploadTotal',
			'uploaded',
			'downloadTotal',
			'downloaded',
			'result',
			'failureReason',
			'recordsAvailable',
		] as const)
			this.hook(proto, key, isFetch, {
				get: (that) => fetchOf(that).snapshot[key],
			});
		this.handler(proto, 'progress', isFetch);
		const fetchCall = (
			that: object,
			op: string,
			args: Record<string, unknown>,
		) => {
			const { snapshot, registration } = fetchOf(that);
			return this.#backend.manager(registration, 'backgroundFetch', op, {
				...args,
				id: snapshot.id,
			});
		};
		this.hook(proto, 'abort', isFetch, {
			call: (that) => fetchCall(that, 'abort', {}),
		});
		const records = async (that: object, args: unknown[], all: boolean) => {
			if (!fetchOf(that).snapshot.recordsAvailable)
				throw new global.DOMException(
					'The records associated with this background fetch are no longer available.',
					'InvalidStateError',
				);
			const filter = args[0] === undefined ? undefined : requestsOf(args[0])[0];
			const found = (await fetchCall(that, 'records', {
				...(filter ? { url: filter.url } : {}),
			})) as BackgroundFetchRecordWire[];
			const objects = found.map((record) => {
				const object = Object.create(Record.prototype);
				const response = record.response
					? Promise.resolve(
							new global.Response(record.response.body, {
								status: record.response.status,
								statusText: record.response.statusText,
								headers: record.response.headers,
							}),
						)
					: Promise.reject(
							new global.DOMException(
								'The response is not available.',
								'UnknownError',
							),
						);
				response.catch(() => {});
				this.#records.set(object, {
					request: new global.Request(record.request.url, {
						method: record.request.method,
						headers: record.request.headers,
					}),
					response,
				});
				return object;
			});
			return all ? objects : objects[0];
		};
		this.hook(proto, 'match', isFetch, {
			length: 1,
			call: (that, args) => records(that, args, false),
		});
		this.hook(proto, 'matchAll', isFetch, {
			call: (that, args) => records(that, args, true),
		});
		const isRecord = (that: unknown) =>
			typeof that === 'object' && that !== null && this.#records.has(that);
		this.hook(Record.prototype, 'request', isRecord, {
			get: (that) => this.#records.get(that)!.request,
		});
		this.hook(Record.prototype, 'responseReady', isRecord, {
			get: (that) => this.#records.get(that)!.response,
		});
	}
}
