import type {
	ApiReply,
	ControlInfo,
	PageEvent,
	RegistrationSnapshot,
	UpdateViaCache,
	WorkerType,
} from '../../../serviceWorkerTypes';
import { SW_API, SW_CONTROL, SW_EVENT } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import ServiceWorkerObjects from '../../serviceWorkerObjects';
import DocumentClient from '../Client';

const UPDATE_VIA_CACHE: UpdateViaCache[] = ['imports', 'all', 'none'];

interface ContainerState {
	controller: object | null;
	ready?: Promise<object>;
	readyResolve?: (registration: object) => void;
	/** messages held until the page starts them (startMessages, onmessage, the end of parsing) */
	queue: MessageEvent[] | null;
}

/**
 * `navigator.serviceWorker` for a proxied page, backed by the emulated
 * service workers Stomp's own worker runs (docs/service-workers.md). Only
 * with `serviceWorkers` on; otherwise the Navigator module removes the API.
 */
export default class ServiceWorkerModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const control = Reflect.get(global, SW_CONTROL) as ControlInfo | undefined;
		Reflect.deleteProperty(global, SW_CONTROL);
		if (!this.client.serviceWorkers) return;
		if (
			typeof global.ServiceWorkerContainer !== 'function' ||
			!('serviceWorker' in global.Navigator.prototype)
		)
			return;
		// a page of a plain http site is no secure context: natively it has
		// no service workers at all
		if (!trustworthy(this.client.url.url)) {
			for (const name of [
				'ServiceWorkerContainer',
				'ServiceWorkerRegistration',
				'ServiceWorker',
				'NavigationPreloadManager',
			])
				Reflect.deleteProperty(global, name);
			Reflect.deleteProperty(global.Navigator.prototype, 'serviceWorker');
			return;
		}
		const proxyModule = this.client.getModule(ProxyModule)!;
		const origin = () => this.client.url.url.origin;
		// an event of this document's registrations: its origin's, in its
		// partition (a site framed by another has registrations of its own)
		const ownEvent = (event: PageEvent) =>
			event.origin === origin() &&
			(event.partition ?? '') === this.client.partition;

		// Calls in flight: every event that arrives meanwhile waits for the
		// call's answer, in the order it came. The answer travels on a port of
		// its own, so it can overtake events Stomp's service worker sent
		// before it (and a register's `updatefound` must follow its
		// resolution). An answer that includes steps a registration object of
		// this page has not applied resolves only once those steps are here
		// (each registration's steps are numbered without gaps) and applied,
		// so the object it hands over shows what natively it would (ready's
		// `active`, update's `installing`); the later ones follow the
		// resolution
		let pending = 0;
		const held: [PageEvent, MessagePort[]][] = [];
		/** a call that never answers (the worker went) stops holding the events after this */
		const CALL_GIVE_UP_MS = 120_000;
		/** an answer waits at most this long for the steps it includes */
		const STEPS_WAIT_MS = 3_000;
		const isSnapshot = (value: unknown): value is RegistrationSnapshot =>
			typeof value === 'object' &&
			value !== null &&
			typeof (value as RegistrationSnapshot).id === 'string' &&
			typeof (value as RegistrationSnapshot).serial === 'number';
		const snapshotsOf = (value: unknown) =>
			(Array.isArray(value) ? value : [value]).filter(isSnapshot);
		/** the held steps of a registration up to `serial` */
		const heldSteps = (id: string, serial: number) =>
			held.flatMap(([event]) =>
				event.kind === 'steps' &&
				ownEvent(event) &&
				event.registration.id === id
					? event.steps.filter((step) => step.serial <= serial)
					: [],
			);
		/** whether every step `snapshot` includes is applied or held */
		const complete = (snapshot: RegistrationSnapshot) => {
			const object = objects.known(snapshot.id);
			if (!object) return true;
			const have = objects.snapshotOf(object).serial;
			if (have >= snapshot.serial) return true;
			const serials = new Set(
				heldSteps(snapshot.id, snapshot.serial)
					.map((step) => step.serial)
					.filter((serial) => serial > have),
			);
			return serials.size >= snapshot.serial - have;
		};
		/** apply the held steps the snapshots already include, in one pass each */
		const catchUp = (snapshots: RegistrationSnapshot[]) => {
			for (const snapshot of snapshots) {
				const steps = heldSteps(snapshot.id, snapshot.serial);
				if (steps.length) objects.apply(snapshot, steps);
			}
		};
		/** answers waiting for their steps */
		const answers = new Set<() => boolean>();
		const release = () => {
			pending--;
			if (pending) return;
			for (const [event, ports] of held.splice(0)) handle(event, ports);
		};

		const call = (
			method: string,
			args: unknown,
			transfer: Transferable[] = [],
		): Promise<unknown> =>
			new Promise((resolve, reject) => {
				const client = this.client.routedClient();
				const channel = new global.MessageChannel();
				if (
					!client ||
					!client.postToWorker(
						{
							[SW_API]: { directory: client.directory, method, args },
						},
						[channel.port2, ...transfer],
					)
				) {
					reject(
						new global.DOMException(
							'The document is in an invalid state.',
							'InvalidStateError',
						),
					);
					return;
				}
				pending++;
				let answered = false;
				const giveUp = global.setTimeout(() => {
					if (answered) return;
					answered = true;
					channel.port1.close();
					reject(
						new global.DOMException(
							'The document is in an invalid state.',
							'InvalidStateError',
						),
					);
					release();
				}, CALL_GIVE_UP_MS);
				channel.port1.onmessage = (event) => {
					if (answered) return;
					answered = true;
					global.clearTimeout(giveUp);
					channel.port1.close();
					const reply = event.data as ApiReply;
					if ('error' in reply) {
						reject(objects.error(reply.error));
						// after the page's continuation (a microtask) has run
						global.setTimeout(release);
						return;
					}
					const snapshots = snapshotsOf(reply.value);
					let settled = false;
					const finish = () => {
						if (settled) return true;
						settled = true;
						answers.delete(attempt);
						global.clearTimeout(late);
						catchUp(snapshots);
						resolve(reply.value);
						global.setTimeout(release);
						return true;
					};
					const attempt = () => snapshots.every(complete) && finish();
					const late = global.setTimeout(finish, STEPS_WAIT_MS);
					if (!attempt()) answers.add(attempt);
				};
			});

		const objects = new ServiceWorkerObjects(global, proxyModule, {
			update: async (registration) => {
				await call('update', { scope: registration.scope });
			},
			unregister: async (registration) =>
				(await call('unregister', { scope: registration.scope })) as boolean,
			postMessage: (worker, registration, message, transfer) => {
				// posted now, so what cannot be cloned throws here, as natively
				const client = this.client.routedClient();
				const channel = new global.MessageChannel();
				client?.postToWorker(
					{
						[SW_API]: {
							directory: client.directory,
							method: 'postMessage',
							args: {
								worker: worker.id,
								scope: registration.scope,
								data: message,
							},
						},
					},
					[channel.port2, ...transfer],
					true,
				);
				channel.port1.onmessage = () => channel.port1.close();
			},
			preload: (registration, op, value) =>
				call('preload', { scope: registration.scope, op, value }),
			manager: (registration, kind, op, args) =>
				call('manager', { scope: registration.scope, kind, op, args }),
		});

		const Container = global.ServiceWorkerContainer;
		const container = objects.eventTarget(Container);
		const state: ContainerState = { controller: null, queue: [] };
		const isContainer = (that: unknown) => that === container;
		if (control && control.registration.scope.startsWith(origin())) {
			objects.registration(control.registration);
			state.controller = objects.worker(
				control.worker,
				control.registration.id,
			);
		}

		const registrationOf = (snapshot: RegistrationSnapshot | null) =>
			snapshot ? objects.registration(snapshot) : undefined;

		// ready: the registration whose scope is the document's, once the
		// registration object itself shows an active worker (a snapshot that
		// says so ahead of the object's own steps waits for them)
		const checkReady = (snapshot: RegistrationSnapshot) => {
			if (!state.readyResolve || !snapshot.active) return;
			if (!this.client.url.toString().startsWith(snapshot.scope)) return;
			const registration = objects.registration(snapshot);
			if (!objects.snapshotOf(registration).active) return;
			state.readyResolve(registration);
			state.readyResolve = undefined;
		};

		// the source the page sees on a message from an emulated worker
		const sources = new WeakMap<Event, object>();
		const sourceDescriptor = Reflect.getOwnPropertyDescriptor(
			global.MessageEvent.prototype,
			'source',
		)!;
		Reflect.defineProperty(global.MessageEvent.prototype, 'source', {
			...sourceDescriptor,
			get: proxyModule.wrapFunction(
				sourceDescriptor.get!,
				(target, that, args) =>
					sources.has(that)
						? sources.get(that)
						: Reflect.apply(target, that, args),
			),
		});

		const startMessages = () => {
			const queue = state.queue;
			if (!queue) return;
			state.queue = null;
			for (const event of queue) objects.dispatch(container, event);
		};
		const deliver = (event: MessageEvent) => {
			if (state.queue && global.document.readyState !== 'loading')
				startMessages();
			if (!state.queue) {
				objects.dispatch(container, event);
				return;
			}
			state.queue.push(event);
			// the end of parsing starts them
			if (waiting) return;
			waiting = true;
			global.document.addEventListener('readystatechange', () => {
				if (global.document.readyState !== 'loading') startMessages();
			});
		};
		let waiting = false;

		const handle = (event: PageEvent, ports: MessagePort[] = []) => {
			if (!ownEvent(event)) return;
			if (pending) {
				held.push([event, ports]);
				for (const attempt of [...answers]) attempt();
				return;
			}
			switch (event.kind) {
				case 'steps':
					objects.apply(event.registration, event.steps);
					checkReady(event.registration);
					break;
				case 'removed':
					objects.remove(event.registration);
					break;
				case 'controller': {
					objects.registration(event.registration);
					const worker = objects.worker(event.worker, event.registration.id);
					if (state.controller === worker) break;
					state.controller = worker;
					objects.dispatch(container, new global.Event('controllerchange'));
					break;
				}
				case 'message': {
					objects.registration(event.registration);
					const message = new global.MessageEvent('message', {
						data: event.data,
						origin: event.origin,
						ports,
					});
					const source = objects.worker(event.source, event.registration.id);
					if (source) sources.set(message, source);
					deliver(message);
					break;
				}
			}
		};
		this.client.onServiceWorkerEvent((message) => {
			const data = message.data as Record<string, unknown> | null;
			if (typeof data !== 'object' || data === null || !(SW_EVENT in data))
				return;
			handle(data[SW_EVENT] as PageEvent, [...message.ports]);
		});

		const proto = Container.prototype;
		const failed = (verb: string, detail: string) =>
			`Failed to ${verb} a ServiceWorker: ${detail}`;
		this.hook(objects, proto, 'register', isContainer, 1, async (args) => {
			if (args.length < 1)
				throw new global.TypeError(
					"Failed to execute 'register' on 'ServiceWorkerContainer': 1 argument required, but only 0 present.",
				);
			const base = this.client.url.toString();
			const text = String(args[0]);
			let script: URL;
			try {
				script = new URL(text, global.document.baseURI || base);
			} catch (error) {
				throw new global.TypeError(
					failed('register', `The URL provided ('${text}') is invalid.`),
				);
			}
			if (!/^https?:$/.test(script.protocol))
				throw new global.TypeError(
					failed(
						'register',
						`The URL protocol of the script ('${script.href}') is not supported.`,
					),
				);
			if (script.origin !== origin())
				throw new global.DOMException(
					failed(
						'register',
						`The origin of the provided scriptURL ('${script.origin}') does not match the current origin ('${origin()}').`,
					),
					'SecurityError',
				);
			const options = (args[1] ?? {}) as RegistrationOptions;
			if (typeof options !== 'object')
				throw new global.TypeError(
					"Failed to execute 'register' on 'ServiceWorkerContainer': The provided value is not of type 'RegistrationOptions'.",
				);
			let scope: URL;
			try {
				scope =
					options.scope === undefined
						? new URL('./', script)
						: new URL(String(options.scope), global.document.baseURI || base);
			} catch (error) {
				throw new global.TypeError(
					failed(
						'register',
						`The scope provided ('${String(options.scope)}') is invalid.`,
					),
				);
			}
			if (!/^https?:$/.test(scope.protocol))
				throw new global.TypeError(
					failed(
						'register',
						`The URL protocol of the scope ('${scope.href}') is not supported.`,
					),
				);
			if (scope.origin !== origin())
				throw new global.DOMException(
					failed(
						'register',
						`The origin of the provided scope ('${scope.origin}') does not match the current origin ('${origin()}').`,
					),
					'SecurityError',
				);
			for (const [name, url] of [
				['script', script],
				['scope', scope],
			] as const)
				if (/%2f|%5c/i.test(url.pathname))
					throw new global.TypeError(
						failed(
							'register',
							`The provided ${name} ('${url.href}') includes a disallowed escape character.`,
						),
					);
			scope.hash = '';
			script.hash = '';
			const type = (options.type ?? 'classic') as WorkerType;
			if (type !== 'classic' && type !== 'module')
				throw new global.TypeError(
					`Failed to execute 'register' on 'ServiceWorkerContainer': Failed to read the 'type' property from 'RegistrationOptions': The provided value '${String(type)}' is not a valid enum value of type WorkerType.`,
				);
			const updateViaCache = (options.updateViaCache ??
				'imports') as UpdateViaCache;
			if (!UPDATE_VIA_CACHE.includes(updateViaCache))
				throw new global.TypeError(
					`Failed to execute 'register' on 'ServiceWorkerContainer': Failed to read the 'updateViaCache' property from 'RegistrationOptions': The provided value '${String(updateViaCache)}' is not a valid enum value of type ServiceWorkerUpdateViaCache.`,
				);
			const snapshot = (await call('register', {
				scriptURL: script.href,
				scope: scope.href,
				type,
				updateViaCache,
			})) as RegistrationSnapshot;
			return objects.registration(snapshot);
		});
		this.hook(
			objects,
			proto,
			'getRegistration',
			isContainer,
			0,
			async (args) => {
				const base = this.client.url.toString();
				let url: URL;
				try {
					url = new URL(
						args[0] === undefined ? '' : String(args[0]),
						global.document.baseURI || base,
					);
				} catch (error) {
					throw new global.TypeError(
						`Failed to get a ServiceWorkerRegistration: The URL provided ('${String(args[0])}') is invalid.`,
					);
				}
				if (url.origin !== origin())
					throw new global.DOMException(
						`Failed to get a ServiceWorkerRegistration: The origin of the provided documentURL ('${url.origin}') does not match the current origin ('${origin()}').`,
						'SecurityError',
					);
				url.hash = '';
				return registrationOf(
					(await call('getRegistration', {
						url: url.href,
					})) as RegistrationSnapshot | null,
				);
			},
		);
		this.hook(objects, proto, 'getRegistrations', isContainer, 0, async () =>
			((await call('getRegistrations', {})) as RegistrationSnapshot[]).map(
				(snapshot) => objects.registration(snapshot),
			),
		);
		objects.hook(proto, 'startMessages', isContainer, {
			call: () => startMessages(),
		});
		objects.hook(proto, 'controller', isContainer, {
			get: () => state.controller,
		});
		objects.hook(proto, 'ready', isContainer, {
			get: () => {
				if (!state.ready) {
					state.ready = new global.Promise<object>((resolve) => {
						state.readyResolve = resolve;
					});
					call('getRegistration', { url: this.client.url.toString() }).then(
						(snapshot) => {
							if (snapshot) checkReady(snapshot as RegistrationSnapshot);
						},
						() => {},
					);
				}
				return state.ready;
			},
		});
		objects.handler(proto, 'controllerchange', isContainer);
		objects.handler(proto, 'messageerror', isContainer);
		// assigning onmessage starts the messages
		objects.hook(proto, 'onmessage', isContainer, {
			get: () => objects.getHandler(container, 'message'),
			set: (_that, value) => {
				objects.setHandler(container, 'message', value);
				startMessages();
			},
		});

		// the native container's own calls never register anything: only
		// this module's container answers them
		const navigatorDescriptor = Reflect.getOwnPropertyDescriptor(
			global.Navigator.prototype,
			'serviceWorker',
		)!;
		Reflect.defineProperty(global.Navigator.prototype, 'serviceWorker', {
			...navigatorDescriptor,
			get: proxyModule.wrapFunction(navigatorDescriptor.get!, () => {
				// an opaque origin has no service workers
				if (this.client.opaqueRequests)
					throw new global.DOMException(
						"Failed to read the 'serviceWorker' property from 'Navigator': The document is sandboxed and lacks the 'allow-same-origin' flag.",
						'SecurityError',
					);
				return container;
			}),
		});
	}

	/** a container method: the emulated call for our container, a rejection for any other (the native one never registers) */
	hook(
		objects: ServiceWorkerObjects,
		proto: object,
		name: string,
		brand: (that: unknown) => boolean,
		length: number,
		call: (args: unknown[]) => Promise<unknown>,
	) {
		objects.hook(proto, name, brand, {
			length,
			call: (_that, args) => call(args),
			foreign: () =>
				Promise.reject(new objects.global.TypeError('Illegal invocation')),
		});
	}
}

/** what Chrome counts as a secure context's origin: https, and the loopback hosts */
export function trustworthy(url: URL): boolean {
	if (url.protocol === 'https:') return true;
	const host = url.hostname;
	return (
		url.protocol === 'http:' &&
		(host === 'localhost' ||
			host.endsWith('.localhost') ||
			host === '[::1]' ||
			/^127(\.\d{1,3}){3}$/.test(host))
	);
}
