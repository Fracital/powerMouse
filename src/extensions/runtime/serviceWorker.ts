// An MV3 extension's service worker as its own script and its pages meet it
// (docs/extensions.md "Service worker"). The worker runs in a page the hub
// keeps (entry.ts backgroundPage), so its global gets what a
// ServiceWorkerGlobalScope has and a window has not: the install, activate,
// fetch and message events with their handler attributes and classes,
// `clients`, `registration` and `serviceWorker`. The extension's other
// pages get a `navigator.serviceWorker` whose controller is that worker.
// Messages both ways go over the extension's BroadcastChannel, cloned as
// postMessage clones them (a transfer list is cloned too: the channel
// carries no ports); the fetch events come from STomp's worker
// (src/server/extensions/fetchEvents.ts), which Chrome's rules decide.
// Measured in Chrome 157 (the worker probe of the extensions suite).
import { displayExtensionURL } from '../origin';
import type { BusMessage, Context, Presence } from './context';
import { backgroundOf } from './messaging';
import { call, masking, natives } from './natives';
import { getterLike, methodLike, setterLike } from './present';

const global = globalThis as typeof globalThis & Record<string, unknown>;
// (read at each call: the runtime's natives are filled after its modules load)
const defineProperty = (
	object: object,
	key: PropertyKey,
	descriptor: PropertyDescriptor,
) => natives.defineProperty(object, key, descriptor);
const getOwnPropertyDescriptor = (object: object, key: PropertyKey) =>
	natives.getOwnPropertyDescriptor(object, key);
const apply = (fn: Function, that: unknown, args: ArrayLike<unknown>) =>
	natives.Reflect.apply(fn, that, args);

const member = { configurable: true, enumerable: true };

/** an own getter of `target`, shown as the native */
function ownGetter(target: object, name: string, get: () => unknown) {
	defineProperty(target, name, { ...member, get: getterLike(name, get) });
}

/** an own method of `target`, shown as the native */
function ownMethod(
	target: object,
	name: string,
	length: number,
	run: (args: unknown[]) => unknown,
) {
	defineProperty(target, name, {
		...member,
		writable: true,
		value: methodLike({ name, length }, function (args) {
			return run(args);
		}),
	});
}

/**
 * An event handler attribute (`onmessage`) of `target`: a function set is
 * called, as the native's, for each event of `type` that `takes` (all of
 * them by default) from where the attribute was first set
 */
function handlerAttribute(
	target: EventTarget,
	type: string,
	takes: (event: Event) => boolean = () => true,
	set?: () => void,
) {
	let handler: Function | null = null;
	let listening = false;
	const name = `on${type}`;
	defineProperty(target, name, {
		...member,
		get: getterLike(name, () => handler),
		set: setterLike(name, (value) => {
			handler = typeof value === 'function' ? value : null;
			if (handler && !listening) {
				listening = true;
				call(natives.addEventListener, target, type, (event: Event) => {
					if (handler && takes(event)) apply(handler, target, [event]);
				});
			}
			set?.();
		}),
	});
}

/** an object of the realm's interface `name` that is an EventTarget, its members its own */
function eventTargetOf(name: string): EventTarget {
	const target = new natives.EventTarget();
	const prototype = (global[name] as { prototype?: object } | undefined)
		?.prototype;
	if (prototype) natives.setPrototypeOf(target, prototype);
	return target;
}

/** a class of the runtime's shown as the native interface `name` */
function asInterface(type: Function, name: string, length: number) {
	defineProperty(type, 'name', { value: name, configurable: true });
	defineProperty(type, 'length', { value: length, configurable: true });
	masking.native(type, name);
	const prototype = type.prototype as object;
	for (const key of natives.ownKeys(prototype)) {
		if (key === 'constructor' || typeof key !== 'string') continue;
		const descriptor = getOwnPropertyDescriptor(prototype, key)!;
		if (descriptor.get) masking.native(descriptor.get, `get ${key}`);
		if (typeof descriptor.value === 'function')
			masking.native(descriptor.value, key);
		defineProperty(prototype, key, { ...descriptor, enumerable: true });
	}
	defineProperty(prototype, Symbol.toStringTag, {
		value: name,
		configurable: true,
	});
	defineProperty(global, name, {
		value: type,
		writable: true,
		configurable: true,
	});
}

const illegal = () => new natives.TypeError('Illegal constructor');

/** what an emulated worker's page and the extension's other pages share: its registration and the worker itself */
function workerObjects(ctx: Context, script: string) {
	const scope = `chrome-extension://${ctx.ext.id}/`;
	const scriptURL = displayExtensionURL(script);
	const worker = eventTargetOf('ServiceWorker');
	const registration = eventTargetOf('ServiceWorkerRegistration');
	ownGetter(worker, 'scriptURL', () => scriptURL);
	ownGetter(worker, 'state', () => 'activated');
	handlerAttribute(worker, 'statechange');
	handlerAttribute(worker, 'error');
	ownGetter(registration, 'installing', () => null);
	ownGetter(registration, 'waiting', () => null);
	ownGetter(registration, 'active', () => worker);
	ownGetter(registration, 'scope', () => scope);
	ownGetter(registration, 'updateViaCache', () => 'imports');
	const preload = {};
	for (const name of ['enable', 'disable', 'setHeaderValue'])
		ownMethod(preload, name, name === 'setHeaderValue' ? 1 : 0, () =>
			natives.Promise.resolve(),
		);
	ownMethod(preload, 'getState', 0, () =>
		natives.Promise.resolve({ enabled: false, headerValue: 'true' }),
	);
	ownGetter(registration, 'navigationPreload', () => preload);
	handlerAttribute(registration, 'updatefound');
	ownMethod(registration, 'update', 0, () =>
		natives.Promise.resolve(registration),
	);
	ownMethod(registration, 'unregister', 0, () =>
		natives.Promise.resolve(false),
	);
	ownMethod(registration, 'showNotification', 1, ([title, options]) =>
		ctx
			.hub('notify', natives.randomUUID(), {
				title,
				...(options as object),
			})
			.then(() => undefined),
	);
	ownMethod(registration, 'getNotifications', 0, () =>
		natives.Promise.resolve([]),
	);
	return { worker, registration, scope, scriptURL };
}

/** a message's data as postMessage takes it: cloned now (a DataCloneError is thrown here, as natively) */
const cloned = (data: unknown) => natives.structuredClone(data);

// the SW-side events

interface FetchState {
	request: Request;
	clientId: string;
	resultingClientId: string;
	dispatching: boolean;
	response: Promise<unknown> | null;
	handled: Promise<void>;
	done: () => void;
}
const extensions = new WeakMap<object, Promise<unknown>[]>();
const fetches = new WeakMap<object, FetchState>();
const messages = new WeakMap<object, Record<string, unknown>>();
const clientStates = new WeakMap<object, Record<string, unknown>>();

/** the classes a ServiceWorkerGlobalScope has, on the page's global */
function defineEventClasses() {
	const NativeEvent = natives.Event;
	class ExtendableEvent extends NativeEvent {
		constructor(type: string, init?: EventInit) {
			super(type, init);
			extensions.set(this, []);
		}
		waitUntil(promise: unknown) {
			extensions.get(this)?.push(natives.Promise.resolve(promise));
		}
	}
	class FetchEvent extends ExtendableEvent {
		constructor(type: string, init: Record<string, unknown>) {
			super(type, init as EventInit);
			let done!: () => void;
			const handled = new natives.Promise<void>((resolve) => {
				done = resolve;
			});
			fetches.set(this, {
				request: init.request as Request,
				clientId: String(init.clientId ?? ''),
				resultingClientId: String(init.resultingClientId ?? ''),
				dispatching: true,
				response: null,
				handled,
				done,
			});
		}
		get request() {
			return fetches.get(this)?.request;
		}
		get clientId() {
			return fetches.get(this)?.clientId;
		}
		get resultingClientId() {
			return fetches.get(this)?.resultingClientId;
		}
		get replacesClientId() {
			return '';
		}
		get preloadResponse() {
			return natives.Promise.resolve(undefined);
		}
		get handled() {
			return fetches.get(this)?.handled;
		}
		respondWith(response: unknown) {
			const state = fetches.get(this);
			if (!state) throw illegal();
			if (!state.dispatching || state.response)
				throw new natives.DOMException(
					`Failed to execute 'respondWith' on 'FetchEvent': ${
						state.response
							? 'The event has already been responded to.'
							: 'The event handler is already finished.'
					}`,
					'InvalidStateError',
				);
			state.response = natives.Promise.resolve(response);
			this.waitUntil(state.response);
			call(natives.stopImmediatePropagation, this);
		}
	}
	class ExtendableMessageEvent extends ExtendableEvent {
		constructor(type: string, init: Record<string, unknown> = {}) {
			super(type, init as EventInit);
			messages.set(this, init);
		}
		get data() {
			return messages.get(this)?.data ?? null;
		}
		get origin() {
			return String(messages.get(this)?.origin ?? '');
		}
		get lastEventId() {
			return String(messages.get(this)?.lastEventId ?? '');
		}
		get source() {
			return messages.get(this)?.source ?? null;
		}
		get ports() {
			return (messages.get(this)?.ports as unknown[]) ?? [];
		}
	}
	class Client {
		constructor() {
			throw illegal();
		}
		get id() {
			return clientStates.get(this)?.id;
		}
		get url() {
			return clientStates.get(this)?.url;
		}
		get type() {
			return clientStates.get(this)?.type;
		}
		get frameType() {
			return clientStates.get(this)?.frameType;
		}
		get lifecycleState() {
			return 'active';
		}
		postMessage(message: unknown) {
			const state = clientStates.get(this);
			if (!state) throw illegal();
			(state.post as (data: unknown) => void)(cloned(message));
		}
	}
	class WindowClient extends Client {
		get focused() {
			return clientStates.get(this)?.focused ?? false;
		}
		get visibilityState() {
			return clientStates.get(this)?.visibilityState ?? 'visible';
		}
		get ancestorOrigins() {
			return [];
		}
		focus() {
			return natives.Promise.resolve(this);
		}
		navigate() {
			return natives.Promise.resolve(null);
		}
	}
	asInterface(ExtendableEvent, 'ExtendableEvent', 1);
	asInterface(FetchEvent, 'FetchEvent', 2);
	asInterface(ExtendableMessageEvent, 'ExtendableMessageEvent', 1);
	asInterface(Client, 'Client', 0);
	asInterface(WindowClient, 'WindowClient', 0);
	return { ExtendableEvent, FetchEvent, ExtendableMessageEvent, WindowClient };
}

/** the page's frame as a WindowClient reads it */
const frameTypeOf = (top: boolean) => (top ? 'top-level' : 'nested');

/**
 * The worker's page: its global as a ServiceWorkerGlobalScope reads, its
 * install and activate events once its script ran, then the fetch events
 * and the messages of the extension's pages
 */
export function workerGlobal(ctx: Context, script: string) {
	const { worker, registration } = workerObjects(ctx, script);
	const classes = defineEventClasses();
	const own = `chrome-extension://${ctx.ext.id}`;
	const define = (name: string, value: unknown) =>
		defineProperty(global, name, {
			value,
			writable: true,
			configurable: true,
		});
	define('registration', registration);
	define('serviceWorker', worker);
	// the handler attributes a worker's global has; a window's own message
	// events are not the worker's (its clients' are)
	const ours = (event: Event) => event instanceof classes.ExtendableEvent;
	for (const type of ['install', 'activate', 'fetch', 'message'])
		handlerAttribute(global as unknown as EventTarget, type, ours);
	// whether the script listens for fetch events, which Chrome reads once
	// it ran: it is told none it does not
	let onfetch = false;
	const fetchListeners = new Set<unknown>();
	const listening = () => onfetch || fetchListeners.size > 0;
	const nativeAdd = natives.addEventListener;
	const nativeRemove = natives.removeEventListener;
	for (const [name, native, added] of [
		['addEventListener', nativeAdd, true],
		['removeEventListener', nativeRemove, false],
	] as const)
		defineProperty(global, name, {
			value: methodLike(native, function (args) {
				if (args[0] === 'fetch')
					if (added) fetchListeners.add(args[1]);
					else fetchListeners.delete(args[1]);
				return apply(native, this ?? global, args);
			}),
			writable: true,
			configurable: true,
		});
	const fetchAttribute = getOwnPropertyDescriptor(global, 'onfetch')!;
	defineProperty(global, 'onfetch', {
		...fetchAttribute,
		set: setterLike('onfetch', function (value) {
			onfetch = typeof value === 'function';
			apply(fetchAttribute.set!, this, [value]);
		}),
	});

	// the extension's pages, as the worker's clients
	const clientOf = (info: {
		id: string;
		url: string;
		top: boolean;
	}): object => {
		const client = Object.create(classes.WindowClient.prototype) as object;
		clientStates.set(client, {
			id: info.id,
			url: displayExtensionURL(info.url),
			type: 'window',
			frameType: frameTypeOf(info.top),
			post: (data: unknown) => ctx.post({ t: 'swc', to: info.id, data }),
		});
		return client;
	};
	const pages = () =>
		[...ctx.peers.values()].filter(
			(presence) =>
				presence.kind !== 'content' && presence.kind !== 'background',
		);
	const asClient = (presence: Presence) =>
		clientOf({
			id: presence.ctx,
			url: presence.url,
			top: presence.frameId <= 0,
		});
	// (a page that started before the worker's says where it is)
	const announced = () =>
		new natives.Promise<void>((resolve) => {
			ctx.post({ t: 'roll' });
			natives.setTimeout(resolve, 60);
		});
	const clients = {};
	ownMethod(clients, 'get', 1, async ([id]) => {
		await announced();
		const found = pages().find((presence) => presence.ctx === String(id));
		return found ? asClient(found) : undefined;
	});
	ownMethod(clients, 'matchAll', 0, async ([options]) => {
		const type = (options as { type?: string } | undefined)?.type ?? 'window';
		await announced();
		return type === 'window' || type === 'all' ? pages().map(asClient) : [];
	});
	ownMethod(clients, 'openWindow', 1, ([url]) =>
		ctx.hub('tabs.create', { url }).then(() => null),
	);
	ownMethod(clients, 'claim', 0, () => natives.Promise.resolve());
	define('clients', clients);
	define(
		'skipWaiting',
		methodLike({ name: 'skipWaiting', length: 0 }, () =>
			natives.Promise.resolve(),
		),
	);

	/** dispatch one of the worker's events; settles once its waitUntil promises do */
	const run = (event: Event) => {
		call(natives.dispatchEvent, global, event);
		return natives.Promise.allSettled(extensions.get(event) ?? []);
	};
	let activate!: () => void;
	const activated = new natives.Promise<void>((resolve) => {
		activate = resolve;
	});
	call(natives.addEventListener, global, 'load', async () => {
		try {
			await run(new classes.ExtendableEvent('install'));
			await run(new classes.ExtendableEvent('activate'));
		} finally {
			activate();
			// STomp's worker gives it fetch events only when it listens
			ctx.worker('serviceWorker', 'fetch', listening()).catch(() => {});
		}
	});

	const seen = new Set<string>();
	ctx.on('fetch', (message) => {
		const id = String(message.id);
		if (seen.has(id)) return;
		seen.add(id);
		activated.then(() => answerFetch(ctx, classes.FetchEvent, message, id));
	});
	ctx.on('swm', (message) => {
		if (message.to !== ctx.id) return;
		activated.then(() =>
			run(
				new classes.ExtendableMessageEvent('message', {
					data: message.data,
					origin: own,
					source: clientOf({
						id: String(message.from),
						url: String(message.url),
						top: !!message.top,
					}),
					ports: [],
				}),
			),
		);
	});
}

/** a fetch event from STomp's worker: whether the worker takes it, then the response it made */
async function answerFetch(
	ctx: Context,
	FetchEvent: new (type: string, init: Record<string, unknown>) => Event,
	message: BusMessage,
	id: string,
) {
	const reply = (more: Record<string, unknown>) =>
		ctx.post({ t: 'fetch-r', id, ctx: ctx.id, ...more });
	const given = message.request as Record<string, unknown>;
	let request: Request;
	try {
		const method = String(given.method);
		request = new natives.Request(String(given.url), {
			method,
			headers: given.headers as [string, string][],
			body:
				method === 'GET' || method === 'HEAD' ? null : (given.body as BodyInit),
			credentials: given.credentials as RequestCredentials,
			cache: given.cache as RequestCache,
			redirect: given.redirect as RequestRedirect,
			integrity: String(given.integrity ?? ''),
			keepalive: !!given.keepalive,
			referrerPolicy: given.referrerPolicy as ReferrerPolicy,
		});
		// what a page's Request cannot be made with: the navigation's mode,
		// the destination, a referrer of another origin than the page's real one
		for (const name of ['mode', 'destination', 'referrer'])
			defineProperty(request, name, {
				value: String(given[name] ?? ''),
				configurable: true,
			});
	} catch (error) {
		return reply({ take: false });
	}
	const event = new FetchEvent('fetch', {
		request,
		clientId: message.clientId,
		resultingClientId: message.resultingClientId,
		cancelable: true,
	});
	call(natives.dispatchEvent, global, event);
	const state = fetches.get(event)!;
	state.dispatching = false;
	if (!state.response) {
		state.done();
		return reply({ take: false });
	}
	reply({ take: true });
	let answer: Record<string, unknown> | null = null;
	try {
		const response = (await state.response) as Response;
		if (
			response &&
			typeof response === 'object' &&
			typeof response.arrayBuffer === 'function' &&
			response.type !== 'error' &&
			response.status
		)
			answer = {
				status: response.status,
				statusText: response.statusText,
				headers: [...response.headers],
				body: await response.arrayBuffer(),
			};
	} catch (error) {
		// a rejected respondWith: the page's network error
	}
	state.done();
	reply(answer ? { answer } : {});
}

/**
 * An extension page's `navigator.serviceWorker`: the extension's worker
 * controls it from the start, as Chrome's does every page of the extension
 * once the worker is active
 */
export function workerContainer(ctx: Context, script: string, top: boolean) {
	const { worker, registration, scope } = workerObjects(ctx, script);
	const own = `chrome-extension://${ctx.ext.id}`;
	const container = eventTargetOf('ServiceWorkerContainer');
	ownGetter(container, 'controller', () => worker);
	const ready = natives.Promise.resolve(registration);
	ownGetter(container, 'ready', () => ready);
	// the worker's messages wait until the page listens (onmessage,
	// startMessages) or its document is parsed, as Chrome's client message
	// queue does
	let started = false;
	let queued: unknown[] = [];
	const deliver = (data: unknown) => {
		const event = new natives.MessageEvent('message', { data });
		defineProperty(event, 'origin', { value: own, configurable: true });
		defineProperty(event, 'source', { value: worker, configurable: true });
		call(natives.dispatchEvent, container, event);
	};
	const start = () => {
		if (started) return;
		started = true;
		const waiting = queued;
		queued = [];
		natives.setTimeout(() => waiting.forEach(deliver), 0);
	};
	handlerAttribute(container, 'controllerchange');
	handlerAttribute(container, 'message', undefined, start);
	handlerAttribute(container, 'messageerror');
	ownMethod(container, 'startMessages', 0, start);
	call(natives.addEventListener, natives.document, 'DOMContentLoaded', start, {
		once: true,
	});
	ctx.on('swc', (message) => {
		if (message.to !== ctx.id) return;
		if (started) deliver(message.data);
		else queued.push(message.data);
	});
	ownMethod(container, 'register', 1, () =>
		natives.Promise.resolve(registration),
	);
	ownMethod(container, 'getRegistration', 0, ([url]) => {
		const href = url === undefined ? scope : new URL(String(url), scope).href;
		return natives.Promise.resolve(
			href.startsWith(scope) ? registration : undefined,
		);
	});
	ownMethod(container, 'getRegistrations', 0, () =>
		natives.Promise.resolve([registration]),
	);
	// the worker's page, woken when it is not up; one message after another
	let line: Promise<unknown> = natives.Promise.resolve();
	ownMethod(worker, 'postMessage', 1, ([message]) => {
		const data = cloned(message);
		line = line.then(async () => {
			const background = await backgroundOf(ctx);
			if (background)
				ctx.post({
					t: 'swm',
					to: background.ctx,
					from: ctx.id,
					url: ctx.url,
					top,
					data,
				});
		});
	});
	const navigatorPrototype = Object.getPrototypeOf(navigator) as object;
	const native = getOwnPropertyDescriptor(navigatorPrototype, 'serviceWorker');
	const page = navigator;
	if (native?.get && native.configurable)
		defineProperty(navigatorPrototype, 'serviceWorker', {
			...native,
			get: getterLike('serviceWorker', function (this: unknown) {
				return this === page ? container : apply(native.get!, this, []);
			}),
		});
}
