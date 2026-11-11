import {
	PERMISSION,
	type MediaVerdict,
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
	'speaker-selection': 'speaker-selection',
};

/**
 * What the browser converts as an object where it expects a dictionary: a
 * function too, and document.all, which says it is undefined
 */
const isObject = (value: unknown): value is object =>
	value !== null &&
	(typeof value === 'object' ||
		typeof value === 'function' ||
		(typeof value === 'undefined' && value !== undefined));

type IdKey = 'deviceId' | 'groupId';
/** the device ids a page names, as the browser knows them (devices()) */
interface DeviceIds {
	/** getUserMedia's constraints with the site's ids turned into the browser's */
	incoming(constraints: unknown): Promise<unknown>;
	/** learn the browser's ids now, so a track's are shown as the site's */
	learn(): Promise<void>;
	/**
	 * Make `plain` (a copy of what `incoming` gave, as plain data) mean the
	 * same to another document of this origin: a groupId, which is one
	 * document's, becomes the ids of that group's devices. Returns what the
	 * constraint that document says failed is called in this one.
	 */
	elsewhere(plain: unknown): (constraint: string) => string;
}

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
		// the browser's own policy for this document: the host's
		// Permissions-Policy header and the allow of the frames above decide
		// it, and what it refuses no proxied page can have, whatever its own
		// policy says. A page under such a policy natively reads `denied` and
		// is refused as a frame without allow is, so that is what this is
		const policyOf = Reflect.getOwnPropertyDescriptor(
			global.Document.prototype,
			'featurePolicy',
		)?.get;
		const browserPolicy = new Map<string, boolean>();
		const browserAllows = (feature: string): boolean => {
			let allows = browserPolicy.get(feature);
			if (allows === undefined) {
				allows = true;
				try {
					const policy = Reflect.apply(policyOf!, global.document, []) as {
						features(): string[];
						allowsFeature(feature: string): boolean;
					};
					// a feature this browser does not know is not its to refuse
					if (policy.features().includes(feature))
						allows = policy.allowsFeature(feature);
				} catch (error) {
					// no featurePolicy (not Chrome): the browser's call says
				}
				browserPolicy.set(feature, allows);
			}
			return allows;
		};
		const allowed = (name: string): boolean => {
			// Chrome asks for notifications from a top-level site only, or a
			// frame of its own origin
			if (name === 'notifications' || name === 'push')
				return client.url.url.origin === site;
			const feature = FEATURE[name];
			if (!feature) return true;
			if (!browserAllows(feature)) return false;
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

		// the site's states as the worker has them now: another document of
		// the site may have been answered since this one loaded
		const refresh = async () => {
			const answer = await ask<PermissionStates>({ op: 'states' });
			if (!answer) return;
			for (const [name, state] of Object.entries(answer.states))
				remember(name, state);
			features = answer.features;
		};
		const mayRead = (name: string) =>
			allowed(name) && siteState(name) === 'granted';
		// whether the document may choose an AudioContext's output. Chrome
		// 156 has a policy feature for it (speaker-selection, default
		// allowlist self) that an allow attribute gives a frame; before, no
		// frame of another origin could, whatever its allow (measured on 152)
		let speakerPolicy: boolean | null = null;
		const speakers = (): boolean => {
			if (speakerPolicy === null)
				try {
					speakerPolicy = (
						Reflect.apply(policyOf!, global.document, []) as {
							features(): string[];
						}
					)
						.features()
						.includes('speaker-selection');
				} catch (error) {
					speakerPolicy = false;
				}
			return speakerPolicy
				? allowed('speaker-selection')
				: sameOriginAsParent();
		};

		this.geolocation(request, allowed);
		// whether a request for `names` reaches the browser's own call without
		// this module refusing it or the host being asked: the site holds the
		// permission, or neither it nor the browser has decided and the
		// browser's own prompt asks
		const direct = async (names: string[]) => {
			await refresh();
			for (const name of names) {
				if (!allowed(name)) return false;
				const state = siteState(name);
				if (state === 'granted') continue;
				if (state !== 'prompt' || (await realState(name)) !== 'prompt')
					return false;
			}
			return true;
		};
		this.userMedia(
			request,
			allowed,
			(name) => !browserAllows(FEATURE[name]),
			direct,
			(constraints) => ask<MediaVerdict>({ op: 'media', constraints }),
			this.devices(
				() => ask<string>({ op: 'deviceSalt' }),
				refresh,
				mayRead,
				speakers,
				mirror === null,
			),
		);
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

	/**
	 * The devices a site reads (docs/permissions.md). Chrome gives every
	 * origin its own deviceIds (the same in any top-level site, kept until
	 * the origin's cookies are cleared), every document its own groupIds, and
	 * shows ids and labels only where the site may use the microphone (audio
	 * inputs and outputs) or the camera: one nameless entry per kind
	 * otherwise. To the browser every proxied site is the proxy origin, so a
	 * page would read the ids every other site reads (an identifier across
	 * sites), with their labels, as soon as any site was granted, and one
	 * site's id opened the device for another. A page reads ids made from the
	 * browser's with its origin's salt (the worker keeps it) instead, and
	 * names devices by them: they are turned back on the way in
	 * (getUserMedia, applyConstraints, setSinkId, AudioContext) and made on
	 * the way out (enumerateDevices, a track's settings, capabilities and
	 * constraints, sinkId). An id of another site, or the browser's own,
	 * names no device.
	 */
	devices(
		salt: () => Promise<string | null>,
		refresh: () => Promise<void>,
		mayRead: (name: string) => boolean,
		speakers: () => boolean,
		opaque: boolean,
	): DeviceIds {
		const global = this.client.global;
		const mediaDevices = global.MediaDevices?.prototype;
		const info = global.MediaDeviceInfo?.prototype;
		const subtle = global.crypto?.subtle;
		const read = (name: string) =>
			info && Reflect.getOwnPropertyDescriptor(info, name)?.get;
		const kindOf = read('kind');
		const deviceIdOf = read('deviceId');
		const groupIdOf = read('groupId');
		const labelOf = read('label');
		if (
			!mediaDevices?.enumerateDevices ||
			!subtle ||
			!kindOf ||
			!deviceIdOf ||
			!groupIdOf ||
			!labelOf
		)
			return {
				incoming: async (value) => value,
				learn: async () => {},
				elsewhere: () => (constraint) => constraint,
			};
		const proxyModule = this.client.getModule(ProxyModule)!;
		const enumerate = mediaDevices.enumerateDevices;
		const digest = subtle.digest;
		const isArray = global.Array.isArray;
		// the document's own MediaDevices, read when a list is first needed
		const navigator = global.navigator;
		const mediaOf = Reflect.getOwnPropertyDescriptor(
			global.Navigator.prototype,
			'mediaDevices',
		)?.get;
		const hex = (bytes: Uint8Array) => {
			let out = '';
			for (let i = 0; i < bytes.length; i++)
				out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
			return out;
		};
		const random = () =>
			hex(global.crypto.getRandomValues(new global.Uint8Array(32)));
		// an origin's salt is the worker's, kept with the origin's data; an
		// opaque origin and a document have one of their own
		let originSalt: Promise<string> | null = null;
		let groupSalt: string | null = null;
		const saltOf = (key: IdKey) =>
			key === 'groupId'
				? (groupSalt ??= random())
				: (originSalt ??= opaque
						? Promise.resolve(random())
						: salt().then(
								(value) => (typeof value === 'string' ? value : random()),
								random,
							));
		// the browser's ids and the site's, both ways; these name the same
		// device everywhere and are never made into another
		const LITERAL = new Set(['', 'default', 'communications']);
		const HEX = /^[0-9a-f]{64}$/;
		const shownOf = { deviceId: new Map(), groupId: new Map() } as Record<
			IdKey,
			Map<string, string>
		>;
		const realOf = { deviceId: new Map(), groupId: new Map() } as Record<
			IdKey,
			Map<string, string>
		>;
		const show = async (key: IdKey, real: string): Promise<string> => {
			if (LITERAL.has(real)) return real;
			let shown = shownOf[key].get(real);
			if (shown === undefined) {
				shown = hex(
					new global.Uint8Array(
						await Reflect.apply(digest, subtle, [
							'SHA-256',
							new global.TextEncoder().encode(`${await saltOf(key)} ${real}`),
						]),
					),
				);
				shownOf[key].set(real, shown);
				realOf[key].set(shown, real);
			}
			return shown;
		};
		// the browser's devices as last read: the ids of each kind, and of each
		// group's members by kind
		let inputs: Record<string, Set<string>> = {};
		let groups = new Map<string, Record<string, string[]>>();
		/** the browser's devices, their ids known both ways */
		const learn = async (): Promise<void> => {
			try {
				const ofKind: Record<string, Set<string>> = {};
				const ofGroup = new Map<string, Record<string, string[]>>();
				for (const device of (await Reflect.apply(
					enumerate,
					Reflect.apply(mediaOf!, navigator, []),
					[],
				)) as MediaDeviceInfo[]) {
					const kind = Reflect.apply(kindOf, device, []) as string;
					const id = Reflect.apply(deviceIdOf, device, []) as string;
					const group = Reflect.apply(groupIdOf, device, []) as string;
					await show('deviceId', id);
					await show('groupId', group);
					if (id === '') continue;
					(ofKind[kind] ??= new Set()).add(id);
					let members = ofGroup.get(group);
					if (!members) ofGroup.set(group, (members = {}));
					(members[kind] ??= []).push(id);
				}
				inputs = ofKind;
				groups = ofGroup;
			} catch (error) {
				// no list: no id is known, and none names a device
			}
		};
		// what the page named that is no id of its site, by what the browser
		// was told: read back (a track's constraints, a sinkId) as the page
		// wrote it
		const written = new Map<string, string>();
		// an id the browser gave that was never shown is not shown as it is
		const toShown = (key: IdKey, real: unknown): unknown =>
			typeof real !== 'string' || LITERAL.has(real)
				? real
				: (shownOf[key].get(real) ??
					written.get(real) ??
					(HEX.test(real) ? '' : real));
		// an id that is not this site's stays what it is, and names nothing:
		// the browser's own id, which a page was never shown, must not either
		const toReal = (key: IdKey, shown: unknown): unknown => {
			if (typeof shown !== 'string' || LITERAL.has(shown)) return shown;
			const real = realOf[key].get(shown);
			if (real !== undefined) return real;
			const told = shownOf[key].has(shown) ? `${shown.slice(1)}0` : shown;
			written.set(told, shown);
			return told;
		};

		// a constraint's ids, one way or the other: a string, a list, or
		// { exact, ideal } of either. A changed object is a new one over the
		// page's (its other members are read from the page's as they were)
		const over = (value: object, changes: Record<string, unknown>) => {
			const out = Object.create(value) as Record<string, unknown>;
			for (const name in changes)
				Reflect.defineProperty(out, name, {
					value: changes[name],
					writable: true,
					enumerable: true,
					configurable: true,
				});
			return out;
		};
		type Turn = (key: IdKey, id: unknown) => unknown;
		const constrained = (key: IdKey, value: unknown, turn: Turn): unknown => {
			if (isArray(value)) {
				const out: unknown[] = [];
				for (let i = 0; i < value.length; i++) out[i] = turn(key, value[i]);
				return out;
			}
			if (value === null || typeof value !== 'object') return turn(key, value);
			const changes: Record<string, unknown> = {};
			for (const name of ['exact', 'ideal'])
				if (name in value)
					changes[name] = constrained(
						key,
						(value as Record<string, unknown>)[name],
						turn,
					);
			return over(value, changes);
		};
		const names = (set: unknown): boolean =>
			set !== null &&
			typeof set === 'object' &&
			('deviceId' in set ||
				'groupId' in set ||
				'advanced' in set ||
				'mandatory' in set ||
				'optional' in set);
		/** a track's constraints (or one of its `advanced` sets) with its ids turned */
		const track = (set: unknown, turn: Turn): unknown => {
			if (!names(set)) return set;
			const from = set as Record<string, unknown>;
			const changes: Record<string, unknown> = {};
			for (const key of ['deviceId', 'groupId'] as IdKey[])
				if (key in from) changes[key] = constrained(key, from[key], turn);
			// Chrome's older spelling: mandatory: { sourceId }, optional: [{ sourceId }]
			const source = (entry: unknown) =>
				entry !== null && typeof entry === 'object' && 'sourceId' in entry
					? over(entry, {
							sourceId: turn(
								'deviceId',
								(entry as Record<string, unknown>).sourceId,
							),
						})
					: entry;
			if ('mandatory' in from) changes.mandatory = source(from.mandatory);
			for (const list of ['advanced', 'optional'])
				if (list in from) {
					const entries = from[list];
					if (isArray(entries)) {
						const out: unknown[] = [];
						for (let i = 0; i < entries.length; i++)
							out[i] =
								list === 'advanced'
									? track(entries[i], turn)
									: source(entries[i]);
						changes[list] = out;
					} else changes[list] = entries;
				}
			return over(from, changes);
		};
		/** the same, written into the browser's own answer */
		const shownIn = (value: Record<string, unknown> | undefined) => {
			if (value === null || typeof value !== 'object') return value;
			for (const key of ['deviceId', 'groupId'] as IdKey[])
				if (key in value) {
					const ids = value[key];
					if (isArray(ids))
						for (let i = 0; i < ids.length; i++) ids[i] = toShown(key, ids[i]);
					else if (ids !== null && typeof ids === 'object') {
						for (const name of ['exact', 'ideal'])
							if (name in ids)
								(ids as Record<string, unknown>)[name] = isArray(
									(ids as Record<string, unknown>)[name],
								)
									? ((ids as Record<string, unknown>)[name] as unknown[]).map(
											(id) => toShown(key, id),
										)
									: toShown(key, (ids as Record<string, unknown>)[name]);
					} else value[key] = toShown(key, ids);
				}
			if (isArray(value.advanced))
				for (const set of value.advanced as Record<string, unknown>[])
					shownIn(set);
			return value;
		};

		const hook = (
			target: object | undefined,
			name: string,
			wrap: (native: Function, that: any, args: any[]) => unknown,
			part: 'value' | 'get' = 'value',
		) => {
			const descriptor =
				target && Reflect.getOwnPropertyDescriptor(target, name);
			if (typeof descriptor?.[part] !== 'function') return;
			Reflect.defineProperty(target!, name, {
				...descriptor,
				[part]: proxyModule.wrapFunction(descriptor[part], wrap),
			});
		};

		// what a page reads of each device the list gave it
		const listed = new WeakMap<
			object,
			{ deviceId: string; groupId: string; label: string; named: boolean }
		>();
		/** the devices of the browser's `list` a page is shown, each with what it reads of it */
		const shownList = async (list: object[]) => {
			const audio = mayRead('microphone');
			const video = mayRead('camera');
			const out: object[] = [];
			const nameless = new Set<string>();
			for (const device of list) {
				const kind = Reflect.apply(kindOf, device, []) as string;
				if (kind === 'videoinput' ? video : audio)
					listed.set(device, {
						deviceId: await show(
							'deviceId',
							Reflect.apply(deviceIdOf, device, []),
						),
						groupId: await show(
							'groupId',
							Reflect.apply(groupIdOf, device, []),
						),
						label: Reflect.apply(labelOf, device, []),
						named: true,
					});
				else {
					// one entry of the kind, saying only that there is one
					if (nameless.has(kind)) continue;
					nameless.add(kind);
					listed.set(device, {
						deviceId: '',
						groupId: '',
						label: '',
						named: false,
					});
				}
				out.push(device);
			}
			return out;
		};
		hook(mediaDevices, 'enumerateDevices', async (native, that, args) => {
			const list = (await Reflect.apply(native, that, args)) as object[];
			await refresh();
			return shownList(list);
		});

		// devicechange: Chrome fires it only where the site may read the
		// devices that changed (measured: an output plugged in is an event
		// for a site that may use the microphone and for a frame allowed it,
		// none for a site that has not asked or a frame its policy refuses).
		// The browser fires it for the proxy origin, which may read them all.
		// A site that may read every device gets the browser's event; one
		// that may read some gets an event when the devices it reads differ
		// from before; one that may read none gets none
		const addListener = global.EventTarget.prototype.addEventListener;
		const dispatch = global.EventTarget.prototype.dispatchEvent;
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;
		const EventType = global.Event;
		const ours = new WeakSet<Event>();
		const watch = (media: object) => {
			const reads = async () => {
				try {
					let out = '';
					for (const device of await shownList(
						(await Reflect.apply(enumerate, media, [])) as object[],
					)) {
						const shown = listed.get(device)!;
						if (shown.named)
							out += `${Reflect.apply(kindOf, device, [])} ${shown.deviceId}\n`;
					}
					return out;
				} catch (error) {
					return '';
				}
			};
			let last = reads();
			Reflect.apply(addListener, media, [
				'devicechange',
				(event: Event) => {
					if (ours.has(event)) return;
					const before = last;
					last = reads();
					if (mayRead('microphone') && mayRead('camera')) return;
					Reflect.apply(stopImmediate, event, []);
					void Promise.all([before, last]).then(([one, other]) => {
						if (one === other) return;
						const change = new EventType('devicechange');
						ours.add(change);
						Reflect.apply(dispatch, media, [change]);
					});
				},
			]);
		};
		// the page's MediaDevices is watched from the moment it first has it,
		// before any listener of its own
		let watched = false;
		hook(
			global.Navigator.prototype,
			'mediaDevices',
			(native, that) => {
				const media = Reflect.apply(native, that, []) as object | undefined;
				if (media && !watched) {
					watched = true;
					watch(media);
				}
				return media;
			},
			'get',
		);
		for (const name of ['deviceId', 'groupId', 'label'] as const)
			hook(
				info,
				name,
				(native, that) => {
					const shown = listed.get(that);
					return shown ? shown[name] : Reflect.apply(native, that, []);
				},
				'get',
			);
		hook(info, 'toJSON', (native, that, args) => {
			const json = Reflect.apply(native, that, args) as Record<string, string>;
			const shown = listed.get(that);
			if (shown)
				for (const name of ['deviceId', 'groupId', 'label'] as const)
					json[name] = shown[name];
			return json;
		});
		hook(
			global.InputDeviceInfo?.prototype,
			'getCapabilities',
			(native, that, args) => {
				const capabilities = Reflect.apply(native, that, args) as Record<
					string,
					unknown
				>;
				const shown = listed.get(that);
				if (!shown) return capabilities;
				if (!shown.named) return {};
				for (const key of ['deviceId', 'groupId'] as IdKey[])
					if (key in capabilities) capabilities[key] = shown[key];
				return capabilities;
			},
		);

		const trackPrototype = global.MediaStreamTrack?.prototype;
		for (const name of ['getSettings', 'getCapabilities', 'getConstraints'])
			hook(trackPrototype, name, (native, that, args) =>
				shownIn(Reflect.apply(native, that, args)),
			);
		hook(trackPrototype, 'applyConstraints', async (native, that, args) => {
			if (names(args[0])) {
				await learn();
				args[0] = track(args[0], toReal);
			}
			return Reflect.apply(native, that, args);
		});

		// an output is named by its id too. Chrome lets a site choose one only
		// where it may use the microphone: an element's setSinkId is refused
		// (SecurityError) for any id but the default's, and an AudioContext
		// finds no device but '' (measured, with the messages)
		const sink =
			(context: boolean) =>
			async (native: Function, that: unknown, args: unknown[]) => {
				const id: unknown = args[0];
				// the policy comes first, whatever is asked for
				if (context && args.length && !speakers())
					throw new global.DOMException(
						'Permissions-Policy disallows speaker selection.',
						'NotAllowedError',
					);
				if (
					typeof id === 'string' &&
					(context ? id !== '' : !LITERAL.has(id))
				) {
					const missing = () =>
						new global.DOMException(
							context
								? `AudioContext.setSinkId(): failed: the device ${id} is not found.`
								: 'Requested device not found',
							'NotFoundError',
						);
					await refresh();
					if (!mayRead('microphone'))
						throw context
							? missing()
							: new global.DOMException(
									'No permission to use requested device',
									'SecurityError',
								);
					if (!LITERAL.has(id)) {
						// an id that is not this site's names no device, whatever
						// the browser would say of it
						await learn();
						const real = realOf.deviceId.get(id);
						if (real === undefined) throw missing();
						args[0] = real;
					}
				}
				return Reflect.apply(native, that, args);
			};
		const sinkId = (native: Function, that: unknown) =>
			toShown('deviceId', Reflect.apply(native, that, []));
		const element = global.HTMLMediaElement?.prototype;
		hook(element, 'setSinkId', sink(false));
		hook(element, 'sinkId', sinkId, 'get');
		const NativeContext = global.AudioContext as
			typeof AudioContext | undefined;
		hook(NativeContext?.prototype, 'setSinkId', sink(true));
		hook(NativeContext?.prototype, 'sinkId', sinkId, 'get');
		if (NativeContext && 'sinkId' in NativeContext.prototype) {
			const Wrapped = proxyModule.wrapFunction(
				NativeContext,
				(target, that, args, newTarget) => {
					// called without new: the browser's own TypeError
					if (!newTarget) return Reflect.apply(target, that, args);
					const options = args[0] as { sinkId?: unknown } | undefined;
					if (
						options !== null &&
						typeof options === 'object' &&
						typeof options.sinkId === 'string'
					)
						args[0] = over(options, {
							sinkId: toReal('deviceId', options.sinkId),
						});
					return Reflect.construct(target, args, newTarget);
				},
				true,
			);
			for (const name of ['AudioContext', 'webkitAudioContext']) {
				const descriptor = Reflect.getOwnPropertyDescriptor(global, name);
				if (descriptor?.value === NativeContext)
					Reflect.defineProperty(global, name, {
						...descriptor,
						value: Wrapped,
					});
			}
		}

		// the ids a constraint requires, as the browser reads them: text
		const exactOf = (value: unknown): string[] | null => {
			if (value === null || typeof value !== 'object' || isArray(value))
				return null;
			const exact = (value as Record<string, unknown>).exact;
			if (exact === undefined || exact === null) return null;
			const out: string[] = [];
			if (isArray(exact))
				for (let i = 0; i < exact.length; i++) out[i] = `${exact[i]}`;
			else out[0] = `${exact}`;
			return out.length ? out : null;
		};
		const KINDS = [
			['audio', 'audioinput'],
			['video', 'videoinput'],
		];
		// names no device anywhere: only ever said to the other document
		const NO_DEVICE = 'no device of that group';
		const elsewhere = (plain: unknown) => {
			// the kinds whose deviceId now stands for a groupId
			const stands: string[] = [];
			const known = (kind: string, id: string) =>
				inputs[kind]?.has(id) || LITERAL.has(id);
			const sets = (
				plain !== null && typeof plain === 'object' ? plain : {}
			) as Record<string, Record<string, unknown> | null | undefined>;
			for (const [member, kind] of KINDS) {
				const set = sets[member];
				if (set === null || typeof set !== 'object') continue;
				// an advanced set fails no request
				if (isArray(set.advanced))
					for (const entry of set.advanced)
						if (entry !== null && typeof entry === 'object')
							delete (entry as Record<string, unknown>).groupId;
				const required = exactOf(set.groupId);
				delete set.groupId;
				if (!required) continue;
				const own = exactOf(set.deviceId);
				// a deviceId that names no device fails first, as it is
				if (own && !own.some((id) => known(kind, id))) continue;
				const ids: string[] = [];
				for (const group of required)
					for (const id of groups.get(group)?.[kind] ?? [])
						if (!own || own.includes(id)) ids.push(id);
				set.deviceId = { exact: ids.length ? ids : [NO_DEVICE] };
				stands.push(member);
			}
			return (constraint: string) => {
				if (constraint !== 'deviceId' || !stands.length) return constraint;
				// the browser settles audio before video
				for (const [member, kind] of KINDS) {
					const required = exactOf(sets[member]?.deviceId);
					if (required && !required.some((id) => known(kind, id)))
						return stands.includes(member) ? 'groupId' : constraint;
				}
				return constraint;
			};
		};

		return {
			elsewhere,
			incoming: async (constraints) => {
				if (!isObject(constraints)) return constraints;
				const { audio, video } = constraints as Record<string, unknown>;
				if (names(audio) || names(video)) await learn();
				return over(constraints, {
					audio: track(audio, toReal),
					video: track(video, toReal),
				});
			},
			learn,
		};
	}

	/**
	 * getUserMedia asks for the camera and the microphone it names first.
	 * Chrome settles a request in this order (measured, docs/permissions.md):
	 * malformed constraints (TypeError), the devices and the constraints
	 * against them (NotFoundError with no device of a kind,
	 * OverconstrainedError), the policy, the permission. With no microphone
	 * the request ends in NotFoundError for a site that may ask, one that
	 * was denied and a frame its policy refuses alike, nobody is asked and
	 * no state changes. So the refusals here, and the host's prompt, come
	 * after the browser's own answer to those first checks (`verdict`, the
	 * controller's mediaVerdict).
	 */
	userMedia(
		request: (
			names: string[],
		) => Promise<
			| { call: true; settle: (granted: boolean | null) => Promise<void> }
			| { call: false; dismissed: boolean }
		>,
		allowed: (name: string) => boolean,
		browserRefuses: (name: string) => boolean,
		direct: (names: string[]) => Promise<boolean>,
		verdict: (constraints: unknown) => Promise<MediaVerdict | null>,
		deviceIds: DeviceIds,
	) {
		const global = this.client.global;
		const prototype = global.MediaDevices?.prototype;
		if (!prototype?.getUserMedia) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const enumerate = prototype.enumerateDevices;
		const kindOf = Reflect.getOwnPropertyDescriptor(
			global.MediaDeviceInfo?.prototype ?? {},
			'kind',
		)?.get;
		const KIND: Record<string, string> = {
			camera: 'videoinput',
			microphone: 'audioinput',
		};
		// whether the browser has no device for one of `names`: its list
		// names every kind it has, whatever the policy and the permission
		const missing = async (that: unknown, names: string[]) => {
			if (!enumerate || !kindOf) return false;
			try {
				const kinds = new Set<string>();
				for (const device of (await Reflect.apply(
					enumerate,
					that,
					[],
				)) as MediaDeviceInfo[])
					kinds.add(Reflect.apply(kindOf, device, []) as string);
				return names.some((name) => !kinds.has(KIND[name]));
			} catch (error) {
				// no list: the browser's own call says what is wrong
				return false;
			}
		};
		const Overconstrained = (
			global as unknown as {
				OverconstrainedError: new (
					constraint: string,
					message?: string,
				) => Error;
			}
		).OverconstrainedError;
		const isArray = global.Array.isArray;
		// the constraints as plain data a message carries, read as the browser
		// reads them (inherited members too); undefined when they hold
		// anything else
		const plainOf = (value: unknown): unknown => {
			const copy = (from: unknown, depth: number): unknown => {
				if (from === null || typeof from !== 'object') {
					if (
						typeof from === 'function' ||
						typeof from === 'symbol' ||
						typeof from === 'bigint'
					)
						throw new RangeError('not plain');
					return from;
				}
				if (depth > 8) throw new RangeError('not plain');
				if (isArray(from)) {
					const list: unknown[] = [];
					for (let i = 0; i < from.length; i++)
						list[i] = copy(from[i], depth + 1);
					return list;
				}
				const out: Record<string, unknown> = {};
				for (const key in from)
					out[key] = copy((from as Record<string, unknown>)[key], depth + 1);
				return out;
			};
			try {
				return copy(value, 0);
			} catch (error) {
				return undefined;
			}
		};
		Reflect.defineProperty(prototype, 'getUserMedia', {
			...Reflect.getOwnPropertyDescriptor(prototype, 'getUserMedia'),
			value: proxyModule.wrapFunction(
				prototype.getUserMedia,
				async (target, that, args) => {
					// the ids the page names are its site's: the browser's own go in
					const constraints = (await deviceIds.incoming(args[0])) as
						MediaStreamConstraints | undefined;
					if (args.length) args[0] = constraints;
					// the kinds asked for, as the browser reads the members: null
					// and any object are a set of constraints (measured: `audio:
					// null` opens the microphone), anything else a boolean
					const asks = (member: unknown) =>
						member === null || isObject(member) || !!member;
					const names: string[] = [];
					if (isObject(constraints)) {
						if (asks(constraints.video)) names.push('camera');
						if (asks(constraints.audio)) names.push('microphone');
					}
					// the browser rejects a request for nothing with its own TypeError
					if (!names.length) return Reflect.apply(target, that, args);
					// kinds the browser's own policy refuses this document (the
					// host's Permissions-Policy, the allow of a frame above):
					// its call can neither prompt nor open a device, and answers
					// as it does natively under that policy, in its order and
					// with its line in this document's console
					if (names.every(browserRefuses))
						return Reflect.apply(target, that, args);
					const refused = (dismissed = false) =>
						new global.DOMException(
							dismissed ? 'Permission dismissed' : 'Permission denied',
							'NotAllowedError',
						);
					// what the browser answers before its policy and its permission
					// (in a frame of the controller's document: `elsewhere`)
					const checks = async () => {
						const plain = plainOf(constraints);
						// kinds with no constraints on them (true, null): no set
						// of them is malformed and none can fail a device, so only
						// a missing device ends the request before the policy.
						// The controller is not asked, and its console gets no
						// line
						const bare =
							plain !== undefined &&
							!isObject((plain as MediaStreamConstraints).audio) &&
							!isObject((plain as MediaStreamConstraints).video);
						const here =
							plain === undefined || bare ? null : deviceIds.elsewhere(plain);
						const first = here ? await verdict(plain) : null;
						if (first?.name === 'TypeError')
							throw new global.TypeError(first.message);
						if (first?.name === 'OverconstrainedError')
							throw new Overconstrained(
								here!(first.constraint ?? ''),
								first.message,
							);
						if (
							first?.name === 'NotFoundError' ||
							// no verdict (none needed, a host without the check,
							// constraints no message carries): the devices at least
							(first?.name !== 'NotAllowedError' &&
								(await missing(that, names)))
						)
							throw new global.DOMException(
								'Requested device not found',
								'NotFoundError',
							);
					};
					// a request that goes straight to the browser's call gets the
					// browser's order from it; one this module answers, or the
					// host is asked about, gets those checks first
					const straight = await direct(names);
					if (!straight) {
						await checks();
						if (!names.every(allowed)) throw refused();
					}
					const answer = await request(names);
					if (!answer.call) {
						// refused after all (the site was answered meanwhile)
						if (straight) await checks();
						throw refused(answer.dismissed);
					}
					try {
						const stream = await Reflect.apply(target, that, args);
						void answer.settle(true);
						// what its tracks say of their device is read at once
						await deviceIds.learn();
						return stream;
					} catch (error) {
						// the site's states are what the refusal made them by the
						// time the page hears of it, as the browser's are
						await answer.settle(
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
