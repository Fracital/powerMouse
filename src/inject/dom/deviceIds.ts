// A document's device ids (modules/Permissions.ts devices). Chrome gives
// every origin its own, so the proxy origin's would be an identifier across
// sites. The maps and the hooks that show them are installed with the
// document's permission hooks, from a deferred part, so the document bundle
// does not carry them. Where the part cannot be had, the bundle refuses what
// it hooks (modules/Permissions.ts devicesRefused), keep the two in step.
import ProxyModule from '../modules/Proxy';
import { LazyMap, LazyWeakSet } from '../ownCollections';
import type DocumentClient from './Client';
import { deferred } from './deferred';
import type { DeviceConstraints } from './modules/permissionCalls';
import type { DeviceIds } from './modules/Permissions';

type IdKey = 'deviceId' | 'groupId';

export function installDeviceIds(
	client: DocumentClient,
	salt: () => Promise<string | null>,
	refresh: () => Promise<void>,
	mayRead: (name: string) => boolean,
	speakers: () => boolean,
	opaque: boolean,
): { mediaOf: Function | undefined; deviceIds: DeviceIds } {
	const global = client.global;
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
			mediaOf: undefined,
			deviceIds: {
				incoming: async (value) => value,
				learn: async () => {},
				elsewhere: () => (constraint) => constraint,
			},
		};
	const proxyModule = client.getModule(ProxyModule)!;
	const enumerate = mediaDevices.enumerateDevices;
	const digest = subtle.digest;
	const isArray = global.Array.isArray;
	const PagePromise = global.Promise;
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
	const written = new LazyMap<string, string>();
	// an id the browser gave that was never shown is not shown as it is
	const toShown = (key: IdKey, real: unknown): unknown =>
		typeof real !== 'string' || LITERAL.has(real)
			? real
			: (shownOf[key].get(real) ??
				written.get(real) ??
				(HEX.test(real) ? '' : real));
	// what turns the ids of a constraint, an output's or a track's: a
	// deferred part (./permissionCalls.ts), made at its first use (a
	// track, a sink, getUserMedia), which a default page never makes
	let turned: DeviceConstraints | undefined;
	const constraints = () =>
		(turned ??= deferred('deviceConstraints')({
			global,
			isArray,
			LITERAL,
			shownOf,
			realOf,
			written,
			toShown,
			inputs: () => inputs,
			groups: () => groups,
			learn,
			refresh,
			mayRead,
			speakers,
			elementSinkId,
			contextSinkId,
		}));

	const hook = (
		target: object | undefined,
		name: string,
		wrap: (native: Function, that: any, args: any[]) => unknown,
		part: 'value' | 'get' = 'value',
	) => {
		const descriptor = target && Reflect.getOwnPropertyDescriptor(target, name);
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
					groupId: await show('groupId', Reflect.apply(groupIdOf, device, [])),
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
	const ours = new LazyWeakSet<Event>();
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
			constraints().shownIn(Reflect.apply(native, that, args)),
		);
	hook(trackPrototype, 'applyConstraints', async (native, that, args) => {
		const turn = constraints();
		if (turn.names(args[0])) {
			await learn();
			args[0] = turn.track(args[0], turn.toReal);
		}
		return Reflect.apply(native, that, args);
	});

	const sinkId = (native: Function, that: unknown) =>
		toShown('deviceId', Reflect.apply(native, that, []));
	const element = global.HTMLMediaElement?.prototype;
	// the native getters, before they are hooked below
	const elementSinkId =
		element && Reflect.getOwnPropertyDescriptor(element, 'sinkId')?.get;
	const contextSinkId =
		global.AudioContext &&
		Reflect.getOwnPropertyDescriptor(global.AudioContext.prototype, 'sinkId')
			?.get;
	// (without the part, the call's promise rejects with why)
	const sink =
		(context: boolean) =>
		(native: Function, that: unknown, args: unknown[]) => {
			try {
				return constraints().sink(context, native, that, args);
			} catch (error) {
				return Reflect.apply(PagePromise.reject, PagePromise, [error]);
			}
		};
	hook(element, 'setSinkId', sink(false));
	hook(element, 'sinkId', sinkId, 'get');
	const NativeContext = global.AudioContext as typeof AudioContext | undefined;
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
					args[0] = constraints().over(options, {
						sinkId: constraints().toReal('deviceId', options.sinkId),
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

	return {
		mediaOf,
		deviceIds: {
			elsewhere: (plain) => constraints().elsewhere(plain),
			incoming: (value) => constraints().incoming(value),
			learn,
		},
	};
}
