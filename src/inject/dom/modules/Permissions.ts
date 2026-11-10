import {
	PERMISSION,
	type PermissionDecision,
	type PermissionOp,
	type PermissionState,
	type PermissionStates,
} from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

/** the permissions each site keeps (src/server/permissions.ts); push is notifications' */
const SIMULATED = new Set([
	'geolocation',
	'camera',
	'microphone',
	'notifications',
	'clipboard-read',
	'midi',
	'persistent-storage',
	'local-fonts',
	'idle-detection',
	'window-management',
	'display-capture',
	'captured-surface-control',
	'local-network-access',
]);
/** a permission's policy-controlled feature (default allowlist `self`), by its name */
const FEATURE: Record<string, string> = {
	geolocation: 'geolocation',
	camera: 'camera',
	microphone: 'microphone',
	'clipboard-read': 'clipboard-read',
	'clipboard-write': 'clipboard-write',
	midi: 'midi',
	'local-fonts': 'local-fonts',
	'idle-detection': 'idle-detection',
	'window-management': 'window-management',
	'display-capture': 'display-capture',
	'captured-surface-control': 'captured-surface-control',
	'local-network-access': 'local-network-access',
	'screen-wake-lock': 'screen-wake-lock',
};

/**
 * Permissions per proxied site (docs/permissions.md). Every proxied site
 * is the proxy origin to the browser, which keeps one permission for all of
 * them, and the host's frame decides what the proxy origin may ask for at
 * all. A page sees its own site's state instead (the worker keeps it, by
 * the proxied top's real origin, as Chrome delegates a frame's permission
 * to its top), under its own permissions policy (a frame of another site
 * gets a powerful feature only through its element's allow attribute):
 * `permissions.query`, `Notification.permission`. Asking (geolocation,
 * getUserMedia, Notification.requestPermission) reaches the browser's API
 * only when the worker says this site may: granted before, or undecided by
 * the site and by the browser, whose own prompt then asks the user. When
 * the browser already gave the proxy origin the permission for another
 * site, the host asks the user (StompController onPermissionRequest).
 */
export default class PermissionsModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const permissions = global.Permissions?.prototype;
		const statusPrototype = global.PermissionStatus?.prototype;
		if (!permissions || !statusPrototype) return;
		const proxyModule = client.getModule(ProxyModule)!;
		const routed = client.routedClient() as DocumentClient | null;
		const nativeQuery = permissions.query;
		const stateDescriptor = Reflect.getOwnPropertyDescriptor(
			statusPrototype,
			'state',
		);
		if (!stateDescriptor?.get) return;
		const nativeState = stateDescriptor.get;
		const nativePermissions = global.navigator.permissions;
		const Channel = global.MessageChannel;
		const addListener = global.EventTarget.prototype.addEventListener;
		const dispatch = global.EventTarget.prototype.dispatchEvent;
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;
		const EventType = global.Event;
		const site = client.topOrigin;

		// the worker's answers
		const ask = <T>(message: PermissionOp) =>
			new Promise<T | null>((resolve) => {
				if (!routed) return resolve(null);
				const channel = new Channel();
				channel.port1.onmessage = (event) => {
					channel.port1.close();
					resolve(event.data as T | null);
				};
				if (
					!routed.postToWorker(
						{ [PERMISSION]: { directory: routed.directory, ...message } },
						[channel.port2],
					)
				)
					resolve(null);
			});

		// a copy of the site's states in the proxy origin's own localStorage
		// (unhooked; the page's is its own), for what a page reads at once
		// (Notification.permission); the worker's states replace it
		const mirrorKey = `$stomp$permissions:${site}`;
		let mirror: Storage | null = null;
		try {
			mirror =
				(Reflect.getOwnPropertyDescriptor(global, 'localStorage')?.get?.call(
					global,
				) as Storage | undefined) ?? null;
		} catch (error) {
			// an opaque origin: no copy
		}
		const getItem = global.Storage?.prototype.getItem;
		const setItem = global.Storage?.prototype.setItem;
		let known: Record<string, PermissionState> = {};
		try {
			if (mirror && getItem)
				known = JSON.parse(Reflect.apply(getItem, mirror, [mirrorKey]) ?? '{}');
		} catch (error) {
			known = {};
		}
		const remember = (name: string, state: PermissionState) => {
			if ((known[name] ?? 'prompt') === state) return;
			if (state === 'prompt') delete known[name];
			else known[name] = state;
			try {
				// only a site that decided something has a copy
				if (mirror && setItem)
					Reflect.apply(setItem, mirror, [mirrorKey, JSON.stringify(known)]);
			} catch (error) {
				// a full store: the worker still knows
			}
		};
		let features: Record<string, boolean> | null = null;
		const states = ask<PermissionStates>({ op: 'states' }).then((answer) => {
			if (answer) {
				for (const [name, state] of Object.entries(answer.states))
					remember(name, state);
				features = answer.features;
			}
			return answer;
		});

		// whether this document may use a feature at all: what the worker
		// recorded of its policy, else the default allowlist (self): a frame
		// of another origin than its parent's has none
		const sameOriginAsParent = () => {
			if (!client.nested) return true;
			try {
				const parent = (client.parent as Record<string, any>)[
					client.names.client
				] as DocumentClient;
				return parent.url.url.origin === client.url.url.origin;
			} catch (error) {
				return false;
			}
		};
		const allowed = (name: string): boolean => {
			// Chrome asks for notifications from a top-level site only, or a
			// frame of its own origin
			if (name === 'notifications' || name === 'push')
				return client.url.url.origin === site;
			const feature = FEATURE[name];
			if (!feature) return true;
			if (features && feature in features) return features[feature];
			return sameOriginAsParent();
		};
		const simulatedName = (name: string) =>
			name === 'push' ? 'notifications' : name;
		const siteState = (name: string): PermissionState =>
			known[simulatedName(name)] ?? 'prompt';

		// the browser's own state for the proxy origin
		const realState = async (name: string): Promise<PermissionState> => {
			try {
				const status = await Reflect.apply(nativeQuery, nativePermissions, [
					{ name },
				]);
				return Reflect.apply(nativeState, status, []) as PermissionState;
			} catch (error) {
				return 'prompt';
			}
		};

		// the statuses the page holds, each showing its site's state; a
		// change of the browser's own state is never theirs
		const shown = new WeakMap<object, PermissionState>();
		const live = new Map<string, Set<WeakRef<EventTarget>>>();
		const ours = new WeakSet<Event>();
		const track = (
			status: EventTarget,
			name: string,
			state: PermissionState,
		) => {
			shown.set(status, state);
			if (!live.has(name)) live.set(name, new Set());
			live.get(name)!.add(new WeakRef(status));
			Reflect.apply(addListener, status, [
				'change',
				(event: Event) => {
					if (!ours.has(event)) Reflect.apply(stopImmediate, event, []);
				},
			]);
		};
		const changed = (name: string, state: PermissionState) => {
			remember(name, state);
			for (const shownName of name === 'notifications'
				? ['notifications', 'push']
				: [name])
				for (const ref of live.get(shownName) ?? []) {
					const status = ref.deref();
					if (!status) {
						live.get(shownName)!.delete(ref);
						continue;
					}
					if (shown.get(status) === state) continue;
					shown.set(status, state);
					const event = new EventType('change');
					ours.add(event);
					Reflect.apply(dispatch, status, [event]);
				}
		};

		Reflect.defineProperty(statusPrototype, 'state', {
			...stateDescriptor,
			get: proxyModule.wrapFunction(nativeState, (target, that, args) =>
				shown.has(that) ? shown.get(that) : Reflect.apply(target, that, args),
			),
		});
		Reflect.defineProperty(permissions, 'query', {
			...Reflect.getOwnPropertyDescriptor(permissions, 'query'),
			value: proxyModule.wrapFunction(
				nativeQuery,
				async (target, that, args) => {
					// the browser checks the descriptor and makes the status
					const status = await Reflect.apply(target, that, args);
					const asked = String((args[0] as { name?: string })?.name);
					if (!allowed(asked)) track(status, asked, 'denied');
					else if (SIMULATED.has(simulatedName(asked))) {
						await states;
						track(status, asked, siteState(asked));
					}
					return status;
				},
			),
		});

		/**
		 * Ask for `names` (camera and microphone together for getUserMedia):
		 * whether the browser's API may be called, and how to report its
		 * outcome. `false`: refused as the site's denial
		 */
		const request = async (
			names: string[],
		): Promise<
			| { call: true; settle: (granted: boolean | null) => Promise<void> }
			| { call: false; dismissed: boolean }
		> => {
			await states;
			const tokens: [string, string][] = [];
			let dismissed = false;
			for (const name of names) {
				const real = await realState(name);
				const answer = await ask<PermissionDecision>({
					op: 'request',
					name,
					real,
				});
				const decision = answer?.decision ?? 'blocked';
				if (decision === 'denied') {
					changed(name, 'denied');
					return { call: false, dismissed: false };
				}
				if (decision === 'dismissed' || decision === 'blocked') {
					dismissed ||= decision === 'dismissed';
					return { call: false, dismissed };
				}
				if (decision === 'granted') changed(name, 'granted');
				if (answer && answer.decision === 'browser')
					tokens.push([name, answer.token]);
			}
			return {
				call: true,
				// how the browser's prompt ended: granted on success, else the
				// browser's own state now (still prompt when it was dismissed)
				settle: async (granted) => {
					for (const [name, token] of tokens) {
						const state =
							granted === true
								? 'granted'
								: granted === false
									? await realState(name)
									: 'prompt';
						void ask({ op: 'result', name, token, state });
						if (state !== 'prompt') changed(name, state);
					}
				},
			};
		};

		this.geolocation(request, allowed);
		this.userMedia(request, allowed);
		this.notifications(request, allowed, siteState);
	}

	/** getCurrentPosition and watchPosition ask first */
	geolocation(
		request: (
			names: string[],
		) => Promise<
			| { call: true; settle: (granted: boolean | null) => Promise<void> }
			| { call: false; dismissed: boolean }
		>,
		allowed: (name: string) => boolean,
	) {
		const global = this.client.global;
		const prototype = global.Geolocation?.prototype;
		const ErrorType = (global as { GeolocationPositionError?: Function })
			.GeolocationPositionError;
		if (!prototype || !ErrorType) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const nativeGet = prototype.getCurrentPosition;
		const nativeWatch = prototype.watchPosition;
		const nativeClear = prototype.clearWatch;
		// what the browser hands an error callback: code 1 with its message
		const denial = (message: string) =>
			Object.create(ErrorType.prototype, {
				code: { value: 1 },
				message: { value: message },
			});
		const POLICY =
			'Geolocation has been disabled in this document by permissions policy.';
		const DENIED = 'User denied Geolocation';
		const run = (
			that: Geolocation,
			args: unknown[],
			start: (success: unknown, failure: unknown) => void,
		) => {
			const [success, failure] = args as [
				((position: GeolocationPosition) => void) | undefined,
				((error: GeolocationPositionError) => void) | null | undefined,
			];
			const fail = (message: string) => {
				if (typeof failure === 'function')
					global.setTimeout(() => failure(denial(message)), 0);
			};
			if (!allowed('geolocation')) return fail(POLICY);
			void request(['geolocation']).then((answer) => {
				if (!answer.call) return fail(DENIED);
				let settled = false;
				const settle = (granted: boolean | null) => {
					if (settled) return;
					settled = true;
					void answer.settle(granted);
				};
				start(
					(position: GeolocationPosition) => {
						settle(true);
						if (typeof success === 'function') success(position);
					},
					(error: GeolocationPositionError) => {
						settle(error?.code === 1 ? false : null);
						if (typeof failure === 'function') failure(error);
					},
				);
			});
			void that;
		};
		Reflect.defineProperty(prototype, 'getCurrentPosition', {
			...Reflect.getOwnPropertyDescriptor(prototype, 'getCurrentPosition'),
			value: proxyModule.wrapFunction(nativeGet, (target, that, args) => {
				// the browser checks the arguments first
				if (typeof args[0] !== 'function')
					return Reflect.apply(target, that, args);
				run(that, args, (success, failure) =>
					Reflect.apply(target, that, [success, failure, ...args.slice(2)]),
				);
			}),
		});
		// a watch's id is handed out at once: the browser's comes later
		let nextId = 1;
		const watches = new Map<number, number | null>();
		Reflect.defineProperty(prototype, 'watchPosition', {
			...Reflect.getOwnPropertyDescriptor(prototype, 'watchPosition'),
			value: proxyModule.wrapFunction(nativeWatch, (target, that, args) => {
				if (typeof args[0] !== 'function')
					return Reflect.apply(target, that, args);
				const id = nextId++;
				watches.set(id, null);
				run(that, args, (success, failure) => {
					if (!watches.has(id)) return;
					watches.set(
						id,
						Reflect.apply(target, that, [success, failure, ...args.slice(2)]),
					);
				});
				return id;
			}),
		});
		Reflect.defineProperty(prototype, 'clearWatch', {
			...Reflect.getOwnPropertyDescriptor(prototype, 'clearWatch'),
			value: proxyModule.wrapFunction(nativeClear, (target, that, args) => {
				const id = Number(args[0]);
				const real = watches.get(id);
				watches.delete(id);
				if (real !== null && real !== undefined)
					return Reflect.apply(target, that, [real]);
				return Reflect.apply(target, that, [-1]);
			}),
		});
	}

	/** getUserMedia asks for the camera and the microphone it names first */
	userMedia(
		request: (
			names: string[],
		) => Promise<
			| { call: true; settle: (granted: boolean | null) => Promise<void> }
			| { call: false; dismissed: boolean }
		>,
		allowed: (name: string) => boolean,
	) {
		const global = this.client.global;
		const prototype = global.MediaDevices?.prototype;
		if (!prototype?.getUserMedia) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		Reflect.defineProperty(prototype, 'getUserMedia', {
			...Reflect.getOwnPropertyDescriptor(prototype, 'getUserMedia'),
			value: proxyModule.wrapFunction(
				prototype.getUserMedia,
				async (target, that, args) => {
					const constraints = args[0] as MediaStreamConstraints | undefined;
					const names: string[] = [];
					if (constraints && typeof constraints === 'object') {
						if (constraints.video) names.push('camera');
						if (constraints.audio) names.push('microphone');
					}
					// the browser rejects a request for nothing with its own TypeError
					if (!names.length) return Reflect.apply(target, that, args);
					const refused = (dismissed = false) =>
						new global.DOMException(
							dismissed ? 'Permission dismissed' : 'Permission denied',
							'NotAllowedError',
						);
					if (!names.every(allowed)) throw refused();
					const answer = await request(names);
					if (!answer.call) throw refused(answer.dismissed);
					try {
						const stream = await Reflect.apply(target, that, args);
						void answer.settle(true);
						return stream;
					} catch (error) {
						void answer.settle(
							(error as DOMException)?.name === 'NotAllowedError'
								? false
								: null,
						);
						throw error;
					}
				},
			),
		});
	}

	/** Notification.permission reads the site's state; requestPermission asks first */
	notifications(
		request: (
			names: string[],
		) => Promise<
			| { call: true; settle: (granted: boolean | null) => Promise<void> }
			| { call: false; dismissed: boolean }
		>,
		allowed: (name: string) => boolean,
		siteState: (name: string) => PermissionState,
	) {
		const global = this.client.global as typeof globalThis & {
			Notification?: typeof Notification;
		};
		const NativeNotification = global.Notification;
		if (typeof NativeNotification !== 'function') return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const toNotification = (state: PermissionState): NotificationPermission =>
			state === 'prompt' ? 'default' : state;
		const permission = Reflect.getOwnPropertyDescriptor(
			NativeNotification,
			'permission',
		);
		if (permission?.get)
			Reflect.defineProperty(NativeNotification, 'permission', {
				...permission,
				get: proxyModule.wrapFunction(permission.get, () =>
					allowed('notifications')
						? toNotification(siteState('notifications'))
						: 'denied',
				),
			});
		const requestPermission = NativeNotification.requestPermission;
		Reflect.defineProperty(NativeNotification, 'requestPermission', {
			...Reflect.getOwnPropertyDescriptor(
				NativeNotification,
				'requestPermission',
			),
			value: proxyModule.wrapFunction(
				requestPermission,
				(target, that, args) => {
					const callback = args[0];
					const decided = (async (): Promise<NotificationPermission> => {
						if (!allowed('notifications')) return 'denied';
						const answer = await request(['notifications']);
						if (!answer.call)
							return answer.dismissed
								? 'default'
								: toNotification(siteState('notifications'));
						const result = (await Reflect.apply(
							target,
							that,
							[],
						)) as NotificationPermission;
						await answer.settle(
							result === 'granted' ? true : result === 'denied' ? false : null,
						);
						return result;
					})();
					return decided.then((result) => {
						if (typeof callback === 'function') callback(result);
						return result;
					});
				},
			),
		});
	}
}
