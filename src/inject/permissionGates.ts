// The browser's permission-gated APIs that each site may use only with its
// own permission (docs/permissions.md "What it covers"). To the browser
// every proxied site is the proxy origin, which holds one grant for all of
// them: once any site was let use the microphone, every site's
// SpeechRecognition listened, and so on for each API below. Each call
// reaches the browser's API as the Permissions module lets getUserMedia
// (its `request`): when its site holds the permission, or neither the site
// nor the browser decided and the browser's own prompt asks. Otherwise it
// is refused as the browser refuses a site that was not granted, in its
// words (measured, Chrome 157), and the browser's call answers itself
// whenever the browser would refuse it too.
//
// Also the Notification objects (a tag of the site's own, URLs routed, and
// a stand-in where the browser would show what the site may not) and the
// Encrypted Media Extensions' configurations.
//
// A deferred part in documents (src/inject/dom/deferredParts.ts), imported
// by the worker bundle: the top level reads no global.
import type { PermissionOp, PermissionState } from '../transport/messages';
import { hookDevices } from './deviceGrants';
import { OwnWeakMap, OwnWeakSet } from './ownCollections';

export type Decision =
	| { call: true; settle: (granted: boolean | null) => Promise<void> }
	| { call: false; dismissed: boolean; blocked?: boolean };

export interface GateContext {
	global: typeof globalThis;
	wrap: <T extends Function>(
		fn: T,
		wrap: (target: T, that: any, args: any[], newTarget?: any) => any,
		construct?: boolean,
	) => T;
	/** the document's policy lets it use `name` */
	allowed(name: string): boolean;
	/** the browser's own policy refuses `name` (its call answers as natively) */
	browserRefuses(name: string): boolean;
	siteState(name: string): PermissionState;
	request(names: string[]): Promise<Decision>;
	/** the request goes to the browser's call without the host being asked */
	direct(names: string[]): Promise<boolean>;
	/** an exception as the browser throws it */
	error(message: string, name: string): Error;
	/** the page's base URL, and a URL routed for an image */
	base(): string;
	route(url: URL): string;
	/** the proxied top's real origin */
	site: string;
	/** what the browser holds for notifications: the native
	 * Notification.permission, read before the site's state replaced it */
	browserNotifications(): string;
	/** `callback` after each document.open(), which drops a window's listeners */
	onOpen(callback: () => void): void;
}

/** what each API is refused with: its permission, and the error (or what it resolves) */
const REFUSALS: Record<string, [string, string, string]> = {
	getScreenDetails: [
		'window-management',
		'NotAllowedError',
		'Permission denied.',
	],
	queryLocalFonts: ['local-fonts', '', ''],
	requestMIDIAccess: [
		'midi',
		'NotAllowedError',
		'Permission to use Web MIDI API was not granted.',
	],
	readText: [
		'clipboard-read',
		'NotAllowedError',
		"Failed to execute 'readText' on 'Clipboard': Read permission denied.",
	],
	read: [
		'clipboard-read',
		'NotAllowedError',
		"Failed to execute 'read' on 'Clipboard': Read permission denied.",
	],
	getDisplayMedia: ['display-capture', 'NotAllowedError', 'Permission denied'],
};

/**
 * A call of a gated promise API (REFUSALS, by its name): the browser's
 * when its site may, else refused as the browser refuses it
 */
export async function gatedCall(
	ctx: GateContext,
	api: string,
	target: Function,
	that: unknown,
	args: unknown[],
): Promise<unknown> {
	const [name, errorName, message] = REFUSALS[api];
	const call = () => Reflect.apply(target, that, args);
	// what an unfocused document is told comes before the permission, as
	// the call finds it (nobody is asked)
	if (
		name === 'clipboard-read' &&
		!(ctx.global as unknown as Window).document?.hasFocus()
	)
		return call();
	const refuse = () => {
		if (!errorName) return [];
		throw ctx.error(message, errorName);
	};
	if (!ctx.allowed(name)) return ctx.browserRefuses(name) ? call() : refuse();
	const answer = await ctx.request([name]);
	if (!answer.call) return answer.blocked ? call() : refuse();
	try {
		return await call();
	} finally {
		// the browser's state says how its prompt ended
		void answer.settle(false);
	}
}

/**
 * navigator.storage.persist(): the browser decides without a prompt, so a
 * site that may not have the proxy origin's grant is told false; persisted()
 * is its own state
 */
export async function persistCall(
	ctx: GateContext,
	persist: boolean,
	target: Function,
	that: unknown,
	args: unknown[],
): Promise<unknown> {
	const name = 'persistent-storage';
	if (!persist) {
		const result = await Reflect.apply(target, that, args);
		return result === true && ctx.siteState(name) === 'granted';
	}
	if (!(await ctx.direct([name]))) return false;
	const answer = await ctx.request([name]);
	if (!answer.call) return false;
	try {
		return await Reflect.apply(target, that, args);
	} finally {
		void answer.settle(false);
	}
}

/**
 * navigator.getUserMedia and webkitGetUserMedia, the callback forms: the
 * MediaDevices method the Permissions module gates, with their own checks
 * of their arguments (measured)
 */
export function legacyUserMedia(
	ctx: GateContext,
	api: string,
	gated: (constraints: unknown) => Promise<unknown>,
	target: Function,
	that: unknown,
	args: unknown[],
) {
	if (that !== ctx.global.navigator) return Reflect.apply(target, that, args);
	const fail = (message: string) =>
		new ctx.global.TypeError(
			`Failed to execute '${api}' on 'Navigator': ${message}`,
		);
	if (args.length < 3)
		throw fail(`3 arguments required, but only ${args.length} present.`);
	for (const index of [1, 2])
		if (typeof args[index] !== 'function')
			throw fail(`parameter ${index + 1} is not of type 'Function'.`);
	const [constraints, success, failure] = args as [
		unknown,
		(stream: unknown) => void,
		(error: unknown) => void,
	];
	gated(constraints).then(
		(stream) => success(stream),
		(error) => failure(error),
	);
}

/**
 * SpeechRecognition.start(): the microphone's, at once for a site that
 * holds it; otherwise asked first, and refused with the events the browser
 * fires (`not-allowed`, then `end`)
 */
export function speechStart(
	ctx: GateContext,
	pending: OwnWeakSet<object>,
	target: Function,
	that: object,
	args: unknown[],
) {
	const name = 'microphone';
	const global = ctx.global as typeof globalThis & {
		SpeechRecognitionErrorEvent?: typeof Event;
	};
	// a track of the page's own needs no permission; a started one throws
	if (
		args.length > 0 ||
		(ctx.allowed(name) && ctx.siteState(name) === 'granted')
	)
		return Reflect.apply(target, that, args);
	if (pending.has(that))
		throw ctx.error(
			"Failed to execute 'start' on 'SpeechRecognition': recognition has already started.",
			'InvalidStateError',
		);
	pending.add(that);
	const dispatch = global.EventTarget.prototype.dispatchEvent;
	void (async () => {
		const answer = ctx.allowed(name)
			? await ctx.request([name])
			: ({
					call: false,
					dismissed: false,
					blocked: ctx.browserRefuses(name),
				} as const);
		pending.delete(that);
		if (answer.call || answer.blocked) {
			Reflect.apply(target, that, args);
			if (answer.call)
				Reflect.apply(global.EventTarget.prototype.addEventListener, that, [
					'end',
					() => void answer.settle(false),
					{ once: true },
				]);
			return;
		}
		const ErrorEvent = global.SpeechRecognitionErrorEvent ?? global.Event;
		Reflect.apply(dispatch, that, [
			new ErrorEvent('error', {
				error: 'not-allowed',
				message: '',
			} as EventInit),
		]);
		Reflect.apply(dispatch, that, [new global.Event('end')]);
	})();
}

/**
 * The Encrypted Media Extensions keep a CDM's storage and identifiers per
 * origin, the proxy origin's for every site, and no name of the site can
 * be put on them: a configuration that needs either is one this browser
 * does not support (NotSupportedError, as Chrome on Linux answers a
 * distinctive identifier), and one that may go without is made to.
 */
export function mediaKeyConfigs(
	ctx: GateContext,
	target: Function,
	that: unknown,
	args: unknown[],
) {
	const configs = args[1];
	if (
		args.length < 2 ||
		typeof configs !== 'object' ||
		configs === null ||
		typeof (configs as { length?: unknown }).length !== 'number'
	)
		return Reflect.apply(target, that, args);
	const list = configs as ArrayLike<unknown>;
	const kept: object[] = [];
	for (let i = 0; i < list.length; i++) {
		const config = list[i];
		if (typeof config !== 'object' || config === null) {
			kept[kept.length] = config as object;
			continue;
		}
		// read once, in the order the browser reads a dictionary
		const read = config as Record<string, unknown>;
		const copy: Record<string, unknown> = {};
		for (const key of [
			'audioCapabilities',
			'distinctiveIdentifier',
			'initDataTypes',
			'label',
			'persistentState',
			'sessionTypes',
			'videoCapabilities',
		]) {
			const value = read[key];
			if (value !== undefined) copy[key] = value;
		}
		const sessions = copy.sessionTypes as ArrayLike<unknown> | undefined;
		let persistent = false;
		if (typeof sessions === 'object' && sessions !== null)
			for (let j = 0; j < sessions.length; j++)
				if (`${sessions[j]}` !== 'temporary') persistent = true;
		if (
			persistent ||
			`${copy.distinctiveIdentifier}` === 'required' ||
			`${copy.persistentState}` === 'required'
		)
			continue;
		copy.distinctiveIdentifier = 'not-allowed';
		copy.persistentState = 'not-allowed';
		kept[kept.length] = copy;
	}
	// none left: one no browser supports, for the browser's own refusal
	if (!kept.length && list.length) kept[0] = { initDataTypes: ['none'] };
	return Reflect.apply(target, that, [args[0], kept]);
}

/** what a notification's members read, by name */
type Members = Record<string, unknown>;

/**
 * The Notification constructor's own work: the page's options read once
 * (as the browser reads a dictionary), the tag made the site's (a tag
 * replaces the origin's earlier notification of that tag, and every site
 * is the proxy origin), icon, image and badge resolved against the page
 * and routed (the browser fetches them); each read back as the page gave
 * it. A site that may not show a notification while the browser would
 * show it gets a stand-in, as the browser's refused one: an error event,
 * nothing shown.
 */
export function notificationParts(ctx: GateContext, Native: Function) {
	const global = ctx.global;
	const prototype = Native.prototype as object;
	const own = (name: string) =>
		Reflect.getOwnPropertyDescriptor(prototype, name);
	const shown = new OwnWeakMap<object, Members>();
	const standIns = new OwnWeakMap<object, Members>();
	const URLS = ['badge', 'icon', 'image'];
	// every member's getter answers a stand-in; tag and the URLs read as
	// the page gave them
	for (const name of Reflect.ownKeys(prototype)) {
		if (typeof name !== 'string' || name === 'constructor') continue;
		const descriptor = own(name)!;
		if (descriptor.get) {
			const getter = descriptor.get;
			const setter = descriptor.set;
			Reflect.defineProperty(prototype, name, {
				...descriptor,
				get: ctx.wrap(getter, (target, that, args) => {
					const members = standIns.get(that);
					if (members) return members[name];
					const page = shown.get(that);
					if (page && name in page) return page[name];
					return Reflect.apply(target, that, args);
				}),
				...(setter
					? {
							set: ctx.wrap(setter, (target, that, args) => {
								const members = standIns.get(that);
								if (!members) return Reflect.apply(target, that, args);
								const value = args[0];
								members[name] =
									typeof value === 'function' ||
									(typeof value === 'object' && value !== null)
										? value
										: null;
							}),
						}
					: {}),
			});
		} else if (typeof descriptor.value === 'function' && name === 'close')
			Reflect.defineProperty(prototype, name, {
				...descriptor,
				value: ctx.wrap(descriptor.value, (target, that, args) =>
					standIns.has(that) ? undefined : Reflect.apply(target, that, args),
				),
			});
	}
	const fail = (message: string) =>
		new global.TypeError(`Failed to construct 'Notification': ${message}`);
	return (target: Function, args: unknown[], newTarget: Function) => {
		const title = `${args[0]}`;
		const given = args[1];
		if (
			given !== undefined &&
			given !== null &&
			typeof given !== 'object' &&
			typeof given !== 'function'
		)
			throw fail("The provided value is not of type 'NotificationOptions'.");
		const read = (given ?? {}) as Record<string, unknown>;
		const options: Record<string, unknown> = {};
		for (const key of [
			'actions',
			'badge',
			'body',
			'data',
			'dir',
			'icon',
			'image',
			'lang',
			'renotify',
			'requireInteraction',
			'silent',
			'tag',
			'timestamp',
			'vibrate',
		]) {
			const value = read[key];
			if (value !== undefined) options[key] = value;
		}
		// (read with the dictionary, before anything is checked)
		const dir = 'dir' in options ? `${options.dir}` : 'auto';
		const badDir = dir !== 'auto' && dir !== 'ltr' && dir !== 'rtl';
		const page: Members = {};
		const base = ctx.base();
		for (const key of URLS)
			if (key in options) {
				const value = `${options[key]}`;
				let url: URL | null = null;
				try {
					url = new URL(value, base);
				} catch (failed) {
					// natively an empty URL
				}
				page[key] = url ? url.href : '';
				options[key] =
					url && /^https?:$/.test(url.protocol) ? ctx.route(url) : value;
			}
		const tag = 'tag' in options ? `${options.tag}` : '';
		page.tag = tag;
		if (tag) options.tag = `${ctx.site} ${tag}`;
		const mine =
			ctx.allowed('notifications') &&
			ctx.siteState('notifications') === 'granted';
		if (mine || ctx.browserNotifications() !== 'granted') {
			const made = Reflect.construct(target, [title, options], newTarget);
			shown.set(made, page);
			return made;
		}
		// the browser would show it: the members a refused one reads, its
		// checks first
		if (badDir)
			throw fail(
				`Failed to read the 'dir' property from 'NotificationOptions': The provided value '${dir}' is not a valid enum value of type NotificationDirection.`,
			);
		const actions = options.actions as ArrayLike<unknown> | undefined;
		if (typeof actions === 'object' && actions !== null && actions.length > 0)
			throw fail(
				'Actions are only supported for persistent notifications shown using ServiceWorkerRegistration.showNotification().',
			);
		const vibrate = options.vibrate;
		const silent = !!options.silent;
		// the pattern as the browser keeps it (the Vibration API's
		// normalization): at most ten entries of at most 10 s, no pause last
		const pattern: number[] = [];
		if (typeof vibrate === 'object' && vibrate !== null)
			for (let i = 0; i < (vibrate as ArrayLike<unknown>).length; i++)
				pattern[pattern.length] =
					Number((vibrate as ArrayLike<unknown>)[i]) >>> 0;
		else if (vibrate !== undefined) pattern[0] = Number(vibrate) >>> 0;
		if (pattern.length > 10) pattern.length = 10;
		for (let i = 0; i < pattern.length; i++)
			if (pattern[i] > 10000) pattern[i] = 10000;
		if (pattern.length % 2 === 0)
			pattern.length = pattern.length ? pattern.length - 1 : 0;
		if (silent === true && pattern.length)
			throw fail('Silent notifications must not specify vibration patterns.');
		if (options.renotify && !tag)
			throw fail(
				'Notifications which set the renotify flag must specify a non-empty tag.',
			);
		const data =
			'data' in options ? global.structuredClone(options.data) : null;
		const standIn = Reflect.construct(
			global.EventTarget,
			[],
			newTarget,
		) as EventTarget;
		standIns.set(standIn, {
			title,
			dir,
			lang: 'lang' in options ? `${options.lang}` : '',
			body: 'body' in options ? `${options.body}` : '',
			tag,
			image: page.image ?? '',
			icon: page.icon ?? '',
			badge: page.badge ?? '',
			vibrate: global.Object.freeze(pattern),
			timestamp:
				'timestamp' in options
					? Number(options.timestamp)
					: global.Math.floor(global.Date.now()),
			renotify: !!options.renotify,
			silent,
			requireInteraction: !!options.requireInteraction,
			data,
			actions: global.Object.freeze([]),
			onclick: null,
			onshow: null,
			onerror: null,
			onclose: null,
		});
		// each handler as the browser calls its event's
		for (const type of ['click', 'show', 'error', 'close'])
			Reflect.apply(global.EventTarget.prototype.addEventListener, standIn, [
				type,
				function (this: unknown, event: Event) {
					const handler = standIns.get(standIn)?.[`on${type}`];
					if (typeof handler === 'function')
						Reflect.apply(handler, this, [event]);
				},
			]);
		global.setTimeout(
			() =>
				Reflect.apply(global.EventTarget.prototype.dispatchEvent, standIn, [
					new global.Event('error'),
				]),
			0,
		);
		return standIn;
	};
}

/** the permission elements: interface, permissions, result getters, result event */
const ELEMENTS: [string, string[], string[], string][] = [
	[
		'HTMLGeolocationElement',
		['geolocation'],
		['position', 'error'],
		'location',
	],
	['HTMLCameraElement', ['camera'], ['track', 'error'], 'track'],
	['HTMLMicrophoneElement', ['microphone'], ['track', 'error'], 'track'],
	[
		'HTMLUserMediaElement',
		['camera', 'microphone'],
		['stream', 'error'],
		'stream',
	],
];

/**
 * Chrome's permission elements (<geolocation>, <camera>, <microphone>,
 * <usermedia>) ask the browser for the proxy origin itself, and with the
 * permission any site was given they hand a site that was never asked the
 * position (autolocate, on insertion) or the device (on a click). A site
 * that does not hold the permission reads its own state from them and no
 * result: what the browser delivers is held back (a track stopped), and a
 * click asks as getUserMedia does. When the browser's own prompt answered
 * the click, its answer is the site's and the result goes through as it
 * came; when the host was asked, the result follows its answer (an event
 * of the inject's, isTrusted false). Hooked when the document first meets
 * one of them (a click, a result) or reads one of their members.
 */
export function permissionElements(
	ctx: GateContext,
	addListener: Function,
	first?: Event,
) {
	const global = ctx.global as unknown as Record<
		string,
		{ prototype: object } | undefined
	> &
		typeof globalThis;
	const kinds: [object, string[], string[], string][] = [];
	for (const [iface, names, results, type] of ELEMENTS) {
		const prototype = global[iface]?.prototype;
		if (prototype) kinds[kinds.length] = [prototype, names, results, type];
	}
	const kindOf = (element: unknown) => {
		if (typeof element !== 'object' || element === null) return null;
		for (
			let proto = Reflect.getPrototypeOf(element);
			proto;
			proto = Reflect.getPrototypeOf(proto)
		)
			for (let i = 0; i < kinds.length; i++)
				if (kinds[i][0] === proto) return kinds[i];
		return null;
	};
	const mayUse = (names: string[]) => {
		for (let i = 0; i < names.length; i++)
			if (!ctx.allowed(names[i]) || ctx.siteState(names[i]) !== 'granted')
				return false;
		return true;
	};
	const natives = new OwnWeakMap<object, Record<string, Function>>();
	for (const [prototype, names, results] of kinds) {
		const getters: Record<string, Function> = {};
		natives.set(prototype, getters);
		for (const name of [
			...results,
			'permissionStatus',
			'initialPermissionStatus',
		]) {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, name);
			if (!descriptor?.get) continue;
			getters[name] = descriptor.get;
			const status = name.endsWith('ermissionStatus');
			Reflect.defineProperty(prototype, name, {
				...descriptor,
				get: ctx.wrap(descriptor.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					if (mayUse(names)) return value;
					if (!status) return null;
					// the site's own state (of both, for one asking two)
					let state: PermissionState = 'granted';
					for (let i = 0; i < names.length; i++) {
						const own = ctx.allowed(names[i])
							? ctx.siteState(names[i])
							: 'denied';
						if (own === 'denied') state = 'denied';
						else if (own === 'prompt' && state === 'granted') state = 'prompt';
					}
					return state;
				}),
			});
		}
	}
	// what a result holds: the devices it opened, to stop
	const stopAll = (
		kind: [object, string[], string[], string],
		element: object,
	) => {
		const getters = natives.get(kind[0])!;
		try {
			const result = Reflect.apply(getters[kind[2][0]], element, []) as {
				stop?: () => void;
				getTracks?: () => { stop(): void }[];
			} | null;
			if (!result) return;
			if (typeof result.getTracks === 'function') {
				const tracks = result.getTracks();
				for (let i = 0; i < tracks.length; i++) tracks[i].stop();
			} else if (typeof result.stop === 'function') result.stop();
		} catch (failed) {
			// nothing opened
		}
	};
	// a click's request, while its answer is not in
	const asked = new OwnWeakMap<object, { answer?: Decision }>();
	const held = new OwnWeakSet<object>();
	const stop = global.Event.prototype.stopImmediatePropagation;
	const targetOf = Reflect.getOwnPropertyDescriptor(
		global.Event.prototype,
		'target',
	)!.get!;
	const trusted = Reflect.getOwnPropertyDescriptor(
		global.Event.prototype,
		'isTrusted',
	)?.get;
	const typeOf = Reflect.getOwnPropertyDescriptor(
		global.Event.prototype,
		'type',
	)!.get!;
	const handlers: Record<string, (event: Event) => void> = {
		__proto__: null,
	} as never;
	const listen = (type: string) =>
		Reflect.apply(addListener, global, [
			type,
			(handlers[type] = (event: Event) => {
				const element = Reflect.apply(targetOf, event, []) as object;
				const kind = kindOf(element);
				if (!kind || mayUse(kind[1])) return;
				if (type === 'click') {
					if (trusted && !Reflect.apply(trusted, event, [])) return;
					const entry: { answer?: Decision } = {};
					asked.set(element, entry);
					void ctx.request(kind[1]).then((answer) => {
						entry.answer = answer;
						if (!held.has(element)) return;
						held.delete(element);
						if (answer.call && mayUse(kind[1]))
							Reflect.apply(
								global.EventTarget.prototype.dispatchEvent,
								element,
								[new global.Event(kind[3])],
							);
						else stopAll(kind, element);
					});
					return;
				}
				if (type !== kind[3]) return;
				const entry = asked.get(element);
				// the browser's own prompt answered the click: the site's answer
				if (entry?.answer?.call) {
					void entry.answer.settle(false);
					asked.delete(element);
					return;
				}
				Reflect.apply(stop, event, []);
				if (entry && !entry.answer) held.add(element);
				else stopAll(kind, element);
			}),
			true,
		]);
	const listenAll = () => {
		for (const type of ['click', 'location', 'track', 'stream']) listen(type);
	};
	listenAll();
	ctx.onOpen(listenAll);
	// the event that met the first element is still on its way: as theirs
	if (first) handlers[Reflect.apply(typeOf, first, []) as string]?.(first);
}

/** the methods the permission gates hook, by kind (gateCall) */
const GATE_NAMES = [
	'getScreenDetails',
	'queryLocalFonts',
	'requestMIDIAccess',
	'requestMediaKeySystemAccess',
	'getDisplayMedia',
	'getUserMedia',
	'webkitGetUserMedia',
	'read',
	'readText',
	'persist',
	'persisted',
	'start',
];

/**
 * What the document's wrappers hand the parts (the Permissions module's
 * gates): the natives taken before any page script ran, and the rest made
 * the first time a call or read needs it
 */
export interface GateHooks {
	/** the context, made the first time it is asked for */
	context(): GateContext;
	ask(op: PermissionOp): Promise<unknown>;
	nativeToString: Function;
	/** the method wrappers' body and the navigator getter wrappers' */
	call: (target: Function, that: unknown, args: unknown[]) => unknown;
	read: (target: Function, that: unknown, args: unknown[]) => unknown;
	navigator: object;
	/** Navigator's mediaDevices and storage getters, SpeechRecognition's continuous */
	mediaDevices?: Function;
	storage?: Function;
	brand?: Function;
	/** the clipboard, and its read and readText (hooked at its first read) */
	clipboard?: object;
	clipboardNatives?: Function[];
	pending?: OwnWeakSet<object>;
	/** the navigator members whose object was hooked */
	done?: string[];
}

/** `name`'s method hooked on `owner`, with the wrappers' body */
function gateHook(hooks: GateHooks, owner: object | undefined, name: string) {
	const descriptor = owner && Reflect.getOwnPropertyDescriptor(owner, name);
	if (typeof descriptor?.value !== 'function') return;
	Reflect.defineProperty(owner!, name, {
		...descriptor,
		value: hooks.context().wrap(descriptor.value, hooks.call),
	});
	return descriptor.value as Function;
}

/** the navigator members whose getters are hooked (gateGetter) */
const MEMBERS = ['clipboard', 'usb', 'hid', 'serial', 'bluetooth'];

/** a function's own name (a native the page never had: the wrapper's) */
const ownName = (fn: Function): unknown =>
	Reflect.getOwnPropertyDescriptor(fn, 'name')?.value;

/**
 * A hooked method's call: on anything but its own receiver it is the
 * browser's own (its TypeError with the page's stack), else gated. The
 * method is told by its native's name: each was hooked before the page
 * could reach it, but for the clipboard's, which are told by the natives.
 */
export function gateCall(
	hooks: GateHooks,
	target: Function,
	that: unknown,
	args: unknown[],
) {
	const ctx = hooks.context();
	const clipboard = hooks.clipboardNatives;
	let kind = -1;
	if (clipboard && target === clipboard[0]) kind = 7;
	else if (clipboard && target === clipboard[1]) kind = 8;
	else {
		const name = ownName(target);
		for (let i = 0; i < GATE_NAMES.length; i++)
			if (GATE_NAMES[i] === name && i !== 7 && i !== 8) kind = i;
	}
	const own = (get: Function | undefined) => {
		try {
			return !!get && that === Reflect.apply(get, hooks.navigator, []);
		} catch (error) {
			return false;
		}
	};
	let mine = false;
	if (kind === 0 || kind === 1)
		mine = that === undefined || that === null || that === ctx.global;
	else if (kind === 2 || kind === 3 || kind === 5 || kind === 6)
		mine = that === hooks.navigator;
	else if (kind === 4) mine = own(hooks.mediaDevices);
	else if (kind === 7 || kind === 8) mine = that === hooks.clipboard;
	else if (kind === 9 || kind === 10) mine = own(hooks.storage);
	else if (kind === 11)
		try {
			Reflect.apply(hooks.brand!, that, []);
			mine = true;
		} catch (error) {
			// not a recognition
		}
	if (!mine) return Reflect.apply(target, that, args);
	const api = GATE_NAMES[kind];
	if (kind === 3) return mediaKeyConfigs(ctx, target, that, args);
	if (kind === 5 || kind === 6) {
		const media = (ctx.global as typeof globalThis).MediaDevices?.prototype;
		const devices = hooks.mediaDevices;
		return legacyUserMedia(
			ctx,
			api,
			(constraints) =>
				Reflect.apply(media!.getUserMedia, Reflect.apply(devices!, that, []), [
					constraints,
				]),
			target,
			that,
			args,
		);
	}
	if (kind === 9 || kind === 10)
		return persistCall(ctx, kind === 9, target, that, args);
	if (kind === 11)
		return speechStart(
			ctx,
			(hooks.pending ??= new OwnWeakSet<object>()),
			target,
			that as object,
			args,
		);
	return gatedCall(ctx, api, target, that, args);
}

/**
 * A hooked navigator getter's read: the object it hands out the first time
 * is hooked (the clipboard's methods, a device API's grants), the member
 * told by its native getter's name (hooked before the page could reach it)
 */
export function gateGetter(
	hooks: GateHooks,
	target: Function,
	that: unknown,
	args: unknown[],
) {
	const object = Reflect.apply(target, that, args) as object | null;
	if (!object) return object;
	const named = ownName(target);
	let name = '';
	for (let i = 0; i < MEMBERS.length; i++)
		if (named === `get ${MEMBERS[i]}`) name = MEMBERS[i];
	const done = (hooks.done ??= []);
	for (let i = 0; i < done.length; i++) if (done[i] === name) name = '';
	if (!name) return object;
	done[done.length] = name;
	try {
		if (name === 'clipboard') {
			hooks.clipboard = object;
			const prototype = Reflect.getPrototypeOf(object) ?? undefined;
			const read = gateHook(hooks, prototype, 'read');
			const readText = gateHook(hooks, prototype, 'readText');
			hooks.clipboardNatives = [read!, readText!];
		} else {
			const ctx = hooks.context();
			hookDevices(
				{
					global: ctx.global,
					wrap: ctx.wrap,
					ask: hooks.ask,
					nativeToString: hooks.nativeToString,
					salt: () => hooks.ask({ op: 'deviceSalt' }) as Promise<string | null>,
					error: ctx.error,
				},
				name as 'usb',
				object as EventTarget,
			);
		}
	} catch (error) {
		// the browser's own
	}
	return object;
}
