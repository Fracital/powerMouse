import { nativeStoreKey } from '../../../profile';
import { routeBinary } from '../../../routeURL';
import StompURL from '../../../StompURL';
import {
	PERMISSION,
	type MediaVerdict,
	type PermissionOp,
	type PermissionState,
	type PermissionStates,
} from '../../../transport/messages';
import { closePort, onPort, privateChannel } from '../../../transport/ports';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { withStack } from '../../nativeErrors';
import { LazyMap, LazyWeakMap, LazyWeakSet } from '../../ownCollections';
import type { Decision, GateContext, GateHooks } from '../../permissionGates';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';
import type { DeferredParts } from '../deferredParts';
import { lazyInterface } from '../lazyInterface';
import type { PermissionRequests } from './permissionCalls';

// taken when the bundle loads: a device's getters are checked by their source
const nativeToString = Function.prototype.toString;

// the permissions each site keeps that are policy-controlled features too
// (default allowlist `self`, by their own names)
const KEPT_FEATURES = [
	'geolocation',
	'camera',
	'microphone',
	'clipboard-read',
	'midi',
	'local-fonts',
	'idle-detection',
	'window-management',
	'display-capture',
	'captured-surface-control',
	'local-network-access',
];
// (lists asked with includes, the method the bundle took as it loaded: a
// Set's has is the page's to replace)
/** the permissions each site keeps (src/server/permissions.ts); push is notifications' */
const SIMULATED = [...KEPT_FEATURES, 'notifications', 'persistent-storage'];
/** the permissions that are a policy-controlled feature of their name */
const FEATURE = [
	...KEPT_FEATURES,
	'clipboard-write',
	'screen-wake-lock',
	'speaker-selection',
];

/**
 * What the browser converts as an object where it expects a dictionary: a
 * function too, and document.all, which says it is undefined
 */
export const isObject = (value: unknown): value is object =>
	value !== null &&
	(typeof value === 'object' ||
		typeof value === 'function' ||
		(typeof value === 'undefined' && value !== undefined));

/** the device ids a page names, as the browser knows them (devices()) */
export interface DeviceIds {
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
	/**
	 * Whether this document's permissions policy lets it use `feature`, as
	 * the worker recorded the policy (the browser's own is the proxy
	 * origin's), once the worker has answered
	 */
	declare documentPolicy?: (feature: string) => Promise<boolean>;
	/**
	 * Navigator's own mediaDevices getter, taken before `devices` hooks it:
	 * the inject reads the document's MediaDevices with it, so the hook's
	 * first read (which lists the devices and listens for devicechange) is
	 * the page's. Read through the hook, every document listed its devices
	 * as it started, which made Chrome start its audio and video capture
	 * services (about 37 MB) and ask them again for every frame
	 */
	#mediaOf?: Function;
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
		const addListener = global.EventTarget.prototype.addEventListener;
		const dispatch = global.EventTarget.prototype.dispatchEvent;
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;
		const EventType = global.Event;
		const site = client.topOrigin;

		// the worker's answers
		const ask = <T>(message: PermissionOp) =>
			new Promise<T | null>((resolve) => {
				if (!routed) return resolve(null);
				// the browser's own channel, and only its delivered answer: a
				// verdict the page played on this port itself would grant it
				// what the host decided for another site (src/transport/ports.ts)
				const [port, theirs] = privateChannel();
				onPort(port, 'message', (data) => {
					closePort(port);
					resolve(data as T | null);
				});
				if (
					!routed.postToWorker(
						{ [PERMISSION]: { directory: routed.directory, ...message } },
						[theirs],
					)
				)
					resolve(null);
			});

		// a copy of the site's states in the proxy origin's own localStorage
		// (unhooked; the page's is its own), for what a page reads at once
		// (Notification.permission); the worker's states replace it
		const mirrorKey = nativeStoreKey(
			`$stomp$permissions:${site}`,
			client.profile,
		);
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
			if (!FEATURE.includes(name)) return true;
			if (!browserAllows(name)) return false;
			if (features && name in features) return features[name];
			return sameOriginAsParent();
		};
		this.documentPolicy = (feature) =>
			states.then(() =>
				features && feature in features
					? features[feature]
					: sameOriginAsParent(),
			);
		const simulatedName = (name: string) =>
			name === 'push' ? 'notifications' : name;
		const siteState = (name: string): PermissionState =>
			known[simulatedName(name)] ?? 'prompt';

		// the statuses the page holds, each showing its site's state; a
		// change of the browser's own state is never theirs
		const shown = new LazyWeakMap<object, PermissionState>();
		const live = new LazyMap<string, Set<WeakRef<EventTarget>>>();
		const ours = new LazyWeakSet<Event>();
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
					// a top-level document has storage access: Chrome answers
					// granted there, unless its permissions policy turns the
					// feature off (denied, the browser's own answer here too);
					// the browser sees the proxied page as a frame, which asks
					else if (
						asked === 'storage-access' &&
						!client.nested &&
						Reflect.apply(nativeState, status, []) === 'prompt'
					)
						track(status, asked, 'granted');
					else if (SIMULATED.includes(simulatedName(asked))) {
						await states;
						track(status, asked, siteState(asked));
					}
					return status;
				},
			),
		});

		// the site's states as the worker has them now: another document of
		// the site may have been answered since this one loaded
		const refresh = async () => {
			const answer = await ask<PermissionStates>({ op: 'states' });
			if (!answer) return;
			for (const [name, state] of Object.entries(answer.states))
				remember(name, state);
			features = answer.features;
		};
		// the requests themselves are a deferred part (./permissionCalls.ts),
		// made at a page's first, before the browser is asked: without it the
		// request rejects. `request` asks for `names` (camera and microphone
		// together for getUserMedia), `direct` says whether a request reaches
		// the browser's own call without this module refusing it or the host
		// being asked
		let made: PermissionRequests | undefined;
		const requests = () =>
			(made ??= deferred('permissionRequests')({
				states,
				ask,
				remember,
				refresh,
				allowed,
				siteState,
				shown,
				live,
				ours,
				EventType,
				dispatch,
				nativeQuery,
				nativePermissions,
				nativeState,
			}));
		const request = async (names: string[]): Promise<Decision> =>
			requests().request(names);
		const direct = async (names: string[]) => requests().direct(names);
		const browserRefuses = (name: string) => !browserAllows(name);
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

		// Geolocation's prototype is hooked the first time the page reads
		// navigator.geolocation, the only way to a Geolocation object, or the
		// Geolocation interface, not here: reading global.Geolocation.prototype
		// made the Geolocation and GeolocationPositionError interfaces in every
		// frame (frame-cost), which a document that never asks for a location
		// does not use. The interface's name is an accessor until then
		// (../lazyInterface.ts): a page that took
		// Geolocation.prototype.getCurrentPosition before it read
		// navigator.geolocation called the browser's own method, which asked
		// for the proxy origin's permission, not the site's. The hooks are in
		// place before any getCurrentPosition/watchPosition; Navigator.prototype
		// is already made.
		const geolocationDescriptor = Reflect.getOwnPropertyDescriptor(
			global.Navigator.prototype,
			'geolocation',
		);
		if (geolocationDescriptor?.get && Reflect.has(global, 'Geolocation')) {
			const nativeGeolocation = geolocationDescriptor.get;
			let hooked = false;
			const hook = (geolocation: unknown) => {
				const prototype =
					geolocation !== null && typeof geolocation === 'object'
						? Reflect.getPrototypeOf(geolocation)
						: null;
				if (!hooked && prototype) {
					hooked = true;
					this.geolocation(request, allowed, prototype as Geolocation);
					settle(
						Reflect.getOwnPropertyDescriptor(prototype, 'constructor')?.value,
					);
				}
				return prototype;
			};
			const settle = lazyInterface(client, 'Geolocation', () => {
				const prototype = hook(
					Reflect.apply(nativeGeolocation, global.navigator, []),
				);
				return prototype
					? Reflect.getOwnPropertyDescriptor(prototype, 'constructor')?.value
					: undefined;
			});
			Reflect.defineProperty(global.Navigator.prototype, 'geolocation', {
				...geolocationDescriptor,
				get: proxyModule.wrapFunction(
					nativeGeolocation,
					(target, that, args) => {
						const geolocation = Reflect.apply(target, that, args);
						hook(geolocation);
						return geolocation;
					},
				),
			});
		} else this.geolocation(request, allowed, global.Geolocation?.prototype);
		this.userMedia(
			request,
			allowed,
			browserRefuses,
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
		// what the browser holds, read with its own getter: the site's state
		// replaces Notification.permission next
		const BrowserNotification = (global as { Notification?: Function })
			.Notification;
		const browserNotifications = BrowserNotification
			? Reflect.getOwnPropertyDescriptor(BrowserNotification, 'permission')?.get
			: undefined;
		this.notifications(request, allowed, siteState);
		this.gates(
			() => ({
				global,
				wrap: (fn, wrap, construct) =>
					proxyModule.wrapFunction(fn, wrap, construct),
				allowed,
				browserRefuses,
				siteState,
				request,
				direct,
				error: (message, name) =>
					withStack(new global.DOMException(message, name)),
				base: () => client.baseHref,
				route: (url) => routeBinary(new StompURL(url, client.url)),
				site,
				onOpen: (callback) => addDocumentOpenListener(global, callback),
				browserNotifications: () => {
					try {
						return Reflect.apply(
							browserNotifications!,
							BrowserNotification,
							[],
						) as string;
					} catch (error) {
						return 'default';
					}
				},
			}),
			ask,
		);
	}

	/**
	 * The other APIs a permission gates, each called only as its site may
	 * (src/inject/permissionGates.ts), and the device APIs, which list what
	 * the site chose (src/inject/deviceGrants.ts). The work is the deferred
	 * parts': what is here is the wrappers, in place before the page's first
	 * script, each hooking or asking the parts at the first call or read,
	 * and little more is kept (frame-cost): the most is the
	 * SpeechRecognition interface (about 1.7 KB a frame), which has to be
	 * made to hook its start.
	 */
	gates(
		context: () => GateContext,
		ask: (op: PermissionOp) => Promise<unknown>,
	) {
		const global = this.client.global;
		// (made at the first call or read that needs it: what a frame that
		// never uses these APIs keeps is the wrappers)
		let made: GateContext | undefined;
		const ctx = () => (made ??= context());
		const proxyModule = this.client.getModule(ProxyModule)!;
		const navigator = global.Navigator.prototype;
		const getter = (owner: object | undefined, name: string) =>
			owner && Reflect.getOwnPropertyDescriptor(owner, name)?.get;
		// one body for every hooked method and one for every hooked getter,
		// the parts' gateCall and gateGetter (which tell each by its native)
		const hooks: GateHooks = {
			context: ctx,
			ask,
			nativeToString,
			call: (target, that, args) =>
				deferred('gateCall')(hooks, target, that, args),
			read: (target, that, args) =>
				deferred('gateGetter')(hooks, target, that, args),
			navigator: global.navigator,
			mediaDevices: getter(navigator, 'mediaDevices'),
			storage: getter(navigator, 'storage'),
		};
		// (the activation gates read which navigator members a page was
		// handed: ../activationGates.ts)
		this.client.permissionHooks = hooks;
		const hook = (owner: object | undefined, name: string, get?: boolean) => {
			const descriptor = owner && Reflect.getOwnPropertyDescriptor(owner, name);
			const native = get ? descriptor?.get : descriptor?.value;
			if (typeof native !== 'function') return;
			Reflect.defineProperty(owner!, name, {
				...descriptor,
				[get ? 'get' : 'value']: proxyModule.wrapFunction(
					native,
					get ? hooks.read : hooks.call,
				),
			});
		};
		const windowOwn = Reflect.getOwnPropertyDescriptor(
			global,
			'getScreenDetails',
		)
			? global
			: global.Window?.prototype;
		hook(windowOwn, 'getScreenDetails');
		hook(windowOwn, 'queryLocalFonts');
		hook(navigator, 'requestMIDIAccess');
		hook(navigator, 'requestMediaKeySystemAccess');
		hook(global.MediaDevices?.prototype, 'getDisplayMedia');
		hook(navigator, 'getUserMedia');
		hook(navigator, 'webkitGetUserMedia');
		const storage = global.StorageManager?.prototype;
		hook(storage, 'persist');
		hook(storage, 'persisted');
		// the clipboard's methods, and a device API's grants, the first time
		// its navigator member is read
		hook(navigator, 'clipboard', true);
		hook(navigator, 'usb', true);
		hook(navigator, 'hid', true);
		hook(navigator, 'serial', true);
		hook(navigator, 'bluetooth', true);
		// SpeechRecognition's start (webkitSpeechRecognition is the same
		// interface), the only way to a recognition. The interface is made in
		// every frame (about 1.7 KB, frame-cost): holding its names behind
		// accessors does not spare it, as no other way to it is left once both
		// are deleted, so the accessors would only add to it
		const Speech = (global as unknown as { SpeechRecognition?: Function })
			.SpeechRecognition;
		if (typeof Speech === 'function') {
			hooks.brand = getter(Speech.prototype, 'continuous');
			hook(Speech.prototype, 'start');
		}
		// a notification's tag is its site's and its images are routed; one
		// the site may not show is never shown (the parts' notificationParts).
		// The constructor is the wrapper, the only way to a notification (a
		// registration's getNotifications() lists none). The interface is
		// made in every frame anyway (Notification.permission is the site's),
		// so the wrapper is in place from the start: holding the name behind
		// accessors cost more than it
		const NativeNotification = (global as { Notification?: Function })
			.Notification;
		if (typeof NativeNotification === 'function') {
			let construct:
				| ((target: Function, args: unknown[], newTarget: Function) => object)
				| null = null;
			(global as { Notification?: Function }).Notification =
				proxyModule.wrapFunction(
					NativeNotification,
					(target, that, args, newTarget) => {
						construct ??= deferred('notificationParts')(ctx(), target);
						return construct!(target, args, newTarget);
					},
					true,
				);
		}
		// the permission elements, the first time one is clicked or delivers
		if ('HTMLGeolocationElement' in global || 'HTMLCameraElement' in global) {
			const targetOf = Reflect.getOwnPropertyDescriptor(
				global.Event.prototype,
				'target',
			)!.get!;
			const localName = Reflect.getOwnPropertyDescriptor(
				global.Element.prototype,
				'localName',
			)!.get!;
			const ELEMENTS = ['geolocation', 'camera', 'microphone', 'usermedia'];
			let hooked = false;
			const first = (event: Event) => {
				if (hooked) return;
				let name: string;
				try {
					name = Reflect.apply(
						localName,
						Reflect.apply(targetOf, event, []),
						[],
					) as string;
				} catch (error) {
					return;
				}
				let element = false;
				for (let i = 0; i < ELEMENTS.length; i++)
					if (ELEMENTS[i] === name) element = true;
				if (!element) return;
				hooked = true;
				try {
					deferred('permissionElements')(ctx(), addListener, event);
				} catch (error) {
					// no parts: the browser's own
				}
			};
			// (document.open() drops a window's listeners: again after each)
			const addListener = global.EventTarget.prototype.addEventListener;
			const listen = () => {
				if (hooked) return;
				for (const type of ['click', 'location', 'track', 'stream'])
					Reflect.apply(addListener, global, [type, first, true]);
			};
			listen();
			addDocumentOpenListener(global, listen);
		}
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
		prototype: Geolocation | undefined,
	) {
		const global = this.client.global;
		const ErrorType = (global as { GeolocationPositionError?: Function })
			.GeolocationPositionError;
		if (!prototype || !ErrorType) return;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const nativeGet = prototype.getCurrentPosition;
		const nativeWatch = prototype.watchPosition;
		const nativeClear = prototype.clearWatch;
		// the request itself: a deferred part (./permissionCalls.ts)
		let made: ReturnType<DeferredParts['positionCall']> | undefined;
		const run: ReturnType<DeferredParts['positionCall']> = (...call) =>
			(made ??= deferred('positionCall')({
				global,
				ErrorType,
				request,
				allowed,
			}))(...call);
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
				// no id: the browser's own error for the call
				if (!args.length) return Reflect.apply(target, that, args);
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
		let installed: ReturnType<DeferredParts['installDeviceIds']>;
		try {
			installed = deferred('installDeviceIds')(
				this.client,
				salt,
				refresh,
				mayRead,
				speakers,
				opaque,
			);
		} catch (error) {
			// the part is made as every document starts, so without it (a
			// frame under a top of another build, whose file cannot be had)
			// the document would load nothing at all: it loads, and what
			// the part shows refuses instead (deferred-refusals)
			return this.#devicesRefused(error);
		}
		this.#mediaOf = installed.mediaOf;
		return installed.deviceIds;
	}

	/**
	 * Where the device-id part cannot be had: each member it hooks throws
	 * the part's error, or rejects with it where the call answers with a
	 * promise, so neither the browser's ids, its labels, nor a device it
	 * names reach the page as the proxy origin's (a member applied to
	 * another realm's device or track would read them). A sinkId shows
	 * only the values every site reads, an AudioContext made with a sinkId
	 * throws, and no devicechange reaches the page.
	 */
	#devicesRefused(error: unknown): DeviceIds {
		const global = this.client.global;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const PagePromise = global.Promise;
		const rejected = () =>
			Reflect.apply(PagePromise.reject, PagePromise, [error]);
		const thrown = () => {
			throw error;
		};
		const hook = (
			target: object | undefined,
			names: string[],
			wrap: (native: Function, that: unknown) => unknown,
			part: 'value' | 'get' = 'value',
		) => {
			for (const name of names) {
				const descriptor =
					target && Reflect.getOwnPropertyDescriptor(target, name);
				if (typeof descriptor?.[part] === 'function')
					Reflect.defineProperty(target!, name, {
						...descriptor,
						[part]: proxyModule.wrapFunction(descriptor[part], wrap),
					});
			}
		};
		const info = global.MediaDeviceInfo?.prototype;
		const track = global.MediaStreamTrack?.prototype;
		const element = global.HTMLMediaElement?.prototype;
		const NativeContext = global.AudioContext as
			typeof AudioContext | undefined;
		const context = NativeContext?.prototype;
		hook(global.MediaDevices?.prototype, ['enumerateDevices'], rejected);
		hook(track, ['applyConstraints'], rejected);
		hook(element, ['setSinkId'], rejected);
		hook(context, ['setSinkId'], rejected);
		hook(track, ['getSettings', 'getCapabilities', 'getConstraints'], thrown);
		hook(info, ['toJSON'], thrown);
		hook(global.InputDeviceInfo?.prototype, ['getCapabilities'], thrown);
		hook(info, ['deviceId', 'groupId', 'label'], thrown, 'get');
		const sinkId = (native: Function, that: unknown) => {
			const id: unknown = Reflect.apply(native, that, []);
			return typeof id === 'string' &&
				id !== 'default' &&
				id !== 'communications'
				? ''
				: id;
		};
		hook(element, ['sinkId'], sinkId, 'get');
		hook(context, ['sinkId'], sinkId, 'get');
		if (NativeContext) {
			const Wrapped = proxyModule.wrapFunction(
				NativeContext,
				// (a call without new is the browser's: Proxy.ts construct_)
				(target, that, args, newTarget) => {
					const options = args[0] as { sinkId?: unknown } | undefined;
					if (
						options !== null &&
						typeof options === 'object' &&
						typeof options.sinkId === 'string'
					)
						thrown();
					return Reflect.construct(target, args, newTarget!);
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
		// the inject reads the document's MediaDevices with the native
		// getter; the page's first read stops every devicechange first
		const navigator = global.Navigator.prototype;
		const mediaOf = Reflect.getOwnPropertyDescriptor(
			navigator,
			'mediaDevices',
		)?.get;
		this.#mediaOf = mediaOf;
		const addListener = global.EventTarget.prototype.addEventListener;
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;
		let watched = false;
		hook(
			navigator,
			['mediaDevices'],
			(native, that) => {
				const media = Reflect.apply(native, that, []) as object | undefined;
				if (media && !watched) {
					watched = true;
					Reflect.apply(addListener, media, [
						'devicechange',
						(event: Event) => Reflect.apply(stopImmediate, event, []),
					]);
				}
				return media;
			},
			'get',
		);
		return {
			incoming: rejected,
			learn: async () => {},
			elsewhere: () => (constraint) => constraint,
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
		// this document's own (absent outside a secure context), by the
		// native getter: the hooked one watches it for the page (#mediaOf)
		const mediaOf = this.#mediaOf;
		const mediaDevices: unknown = mediaOf
			? Reflect.apply(mediaOf, global.navigator, [])
			: global.navigator.mediaDevices;
		const enumerate = prototype.enumerateDevices;
		const kindOf = Reflect.getOwnPropertyDescriptor(
			global.MediaDeviceInfo?.prototype ?? {},
			'kind',
		)?.get;
		const Overconstrained = (
			global as unknown as {
				OverconstrainedError: new (
					constraint: string,
					message?: string,
				) => Error;
			}
		).OverconstrainedError;
		const isArray = global.Array.isArray;
		const PagePromise = global.Promise;
		// the call itself is a deferred part (./permissionCalls.ts): a page
		// rarely asks for a camera or a microphone
		let call:
			((...args: [Function, unknown, unknown[]]) => unknown) | undefined;
		Reflect.defineProperty(prototype, 'getUserMedia', {
			...Reflect.getOwnPropertyDescriptor(prototype, 'getUserMedia'),
			value: proxyModule.wrapFunction(
				prototype.getUserMedia,
				(target, that, args) => {
					try {
						call ??= deferred('userMediaCall')({
							global,
							mediaDevices,
							enumerate,
							kindOf,
							Overconstrained,
							isArray,
							request,
							allowed,
							browserRefuses,
							direct,
							verdict,
							deviceIds,
						});
					} catch (error) {
						return Reflect.apply(PagePromise.reject, PagePromise, [error]);
					}
					return call(target, that, args);
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
		const PagePromise = global.Promise;
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
					// (a deferred part, ./permissionCalls.ts; without it, the
					// promise rejects with why)
					try {
						return deferred('notificationCall')({
							request,
							allowed,
							siteState,
							toNotification,
						})(target, that, args);
					} catch (error) {
						return Reflect.apply(PagePromise.reject, PagePromise, [error]);
					}
				},
			),
		});
	}
}
