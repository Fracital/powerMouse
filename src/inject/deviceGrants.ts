// The devices a site chose (docs/permissions.md "Devices"): WebUSB, WebHID,
// Web Serial and Web Bluetooth, in documents and (but Bluetooth) workers.
// The browser keeps every grant per origin, and every proxied site is the
// proxy origin: getDevices() listed the devices any site was given,
// forget() revoked one for every site, connect and disconnect fired for all
// of them, a Bluetooth device's id (per origin) was one identifier across
// sites, and its services were the union every site named. The worker
// keeps each site's own (src/server/permissions.ts deviceGrants), and a
// page sees only what its site chose: a list filtered to it, a choice
// recorded for it, forget() for it alone (the browser's own when no other
// site holds the device), events of its devices only, ids of its origin and
// the services it named.
//
// A device is known to the worker by a key made of what the browser shows
// of it, read with the browser's getters. They are checked to be the
// browser's own first (their source names them): a page that replaced one
// could make every device read as one it was granted. When they are not,
// the site lists nothing, as a site that chose nothing does. What else the
// page could replace (a prototype's method, an iterator) is never asked: a
// page whose Set.prototype.has answered true would have had every device.
//
// Evaluated after page scripts may have run (a deferred part in documents,
// src/inject/dom/deferredParts.ts): the top level reads no global.
import type {
	DeviceGrant,
	DeviceKind,
	PermissionOp,
} from '../transport/messages';
import { OwnWeakMap, OwnWeakSet } from './ownCollections';

export interface DeviceHooks {
	global: typeof globalThis;
	wrap: <T extends Function>(
		fn: T,
		wrap: (target: T, that: any, args: any[]) => any,
	) => T;
	/** the worker's answer, null when there is none */
	ask: (op: PermissionOp) => Promise<unknown>;
	/** Function.prototype.toString as the bundle loaded */
	nativeToString: Function;
	/** the salt of this document's origin (Bluetooth ids), null for none */
	salt: () => Promise<string | null>;
	/** an exception as the browser throws it */
	error: (message: string, name: string) => Error;
}

interface Kind {
	iface: string;
	list: string;
	request: string;
	device: string;
	/** the getters a key is made of */
	fields: string[];
	/** a connection event's device getter (by event interface); Serial's is the target */
	event?: string;
}

const KINDS: Record<DeviceKind, Kind> = {
	usb: {
		iface: 'USB',
		list: 'getDevices',
		request: 'requestDevice',
		device: 'USBDevice',
		fields: [
			'vendorId',
			'productId',
			'serialNumber',
			'manufacturerName',
			'productName',
			'deviceClass',
			'deviceSubclass',
			'deviceProtocol',
			'deviceVersionMajor',
			'deviceVersionMinor',
			'deviceVersionSubminor',
		],
		event: 'USBConnectionEvent',
	},
	hid: {
		iface: 'HID',
		list: 'getDevices',
		request: 'requestDevice',
		device: 'HIDDevice',
		fields: ['vendorId', 'productId', 'productName'],
		event: 'HIDConnectionEvent',
	},
	serial: {
		iface: 'Serial',
		list: 'getPorts',
		request: 'requestPort',
		device: 'SerialPort',
		fields: [],
	},
	bluetooth: {
		iface: 'Bluetooth',
		list: 'getDevices',
		request: 'requestDevice',
		device: 'BluetoothDevice',
		fields: ['id'],
	},
};

/** Chrome's words for a service a site did not name, and for a device
 * whose site named none (measured, Chrome 157) */
const NOT_ALLOWED_SERVICE =
	"Origin is not allowed to access the service. Tip: Add the service UUID to 'optionalServices' in requestDevice() options. https://goo.gl/HxfxSQ";
const NOT_ALLOWED_ANY =
	"Origin is not allowed to access any service. Tip: Add the service UUID to 'optionalServices' in requestDevice() options. https://goo.gl/HxfxSQ";
/** none of the services the site named is on the device (Chrome's
 * bluetooth_error.cc words; not measured) */
const NO_SERVICES = 'No Services found in device.';

/** a 128-bit hash of `text` (cyrb128), as 16 bytes */
function hash128(text: string): number[] {
	let h1 = 1779033703;
	let h2 = 3144134277;
	let h3 = 1013904242;
	let h4 = 2773480762;
	for (let i = 0; i < text.length; i++) {
		const k = text.charCodeAt(i);
		h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
		h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
		h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
		h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
	}
	h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
	h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
	h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
	h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
	h1 ^= h2 ^ h3 ^ h4;
	h2 ^= h1;
	h3 ^= h1;
	h4 ^= h1;
	const bytes: number[] = [];
	for (const word of [h1, h2, h3, h4])
		for (let shift = 24; shift >= 0; shift -= 8)
			bytes[bytes.length] = (word >>> shift) & 255;
	return bytes;
}

const BASE64 =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** 16 bytes as Chrome writes a Bluetooth device id: base64, 24 characters */
function base64(bytes: number[]): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const n =
			(bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
		out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
		out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
		out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
	}
	return out;
}

/**
 * Hook `kind`'s object (navigator.usb, .hid, .serial, .bluetooth) of this
 * realm, once, the first time the page reads it
 */
export function hookDevices(
	hooks: DeviceHooks,
	kind: DeviceKind,
	object: EventTarget,
) {
	const { global, wrap, ask, error } = hooks;
	const spec = KINDS[kind];
	const realm = global as unknown as Record<string, { prototype: object }>;
	const prototype = realm[spec.iface]?.prototype;
	const devicePrototype = realm[spec.device]?.prototype;
	if (!prototype || !devicePrototype) return;
	const own = (target: object, name: string) =>
		Reflect.getOwnPropertyDescriptor(target, name);
	// the browser's own function, by its source
	const isNative = (fn: unknown, name: string): fn is Function => {
		try {
			return (
				typeof fn === 'function' &&
				Reflect.apply(hooks.nativeToString, fn, []) ===
					`function ${name}() { [native code] }`
			);
		} catch (failed) {
			return false;
		}
	};
	const getters: Function[] = [];
	let trusted = true;
	for (let i = 0; i < spec.fields.length; i++) {
		const getter = own(devicePrototype, spec.fields[i])?.get;
		if (isNative(getter, `get ${spec.fields[i]}`))
			getters[getters.length] = getter;
		else trusted = false;
	}
	const getInfo = own(devicePrototype, 'getInfo')?.value;
	if (kind === 'serial' && !isNative(getInfo, 'getInfo')) trusted = false;
	const eventDevice = spec.event
		? own(realm[spec.event]?.prototype ?? {}, 'device')?.get
		: undefined;
	if (spec.event && !isNative(eventDevice, 'get device')) trusted = false;

	// a device's key: what the browser shows of it, the same in every
	// document; null when it cannot be read with the browser's getters
	const keys = new OwnWeakMap<object, string>();
	const keyOf = (device: unknown): string | null => {
		if (
			!trusted ||
			(typeof device !== 'object' && typeof device !== 'function')
		)
			return null;
		const kept = keys.get(device as object);
		if (kept !== undefined) return kept;
		let key = '';
		try {
			if (kind === 'serial') {
				const info = Reflect.apply(getInfo, device, []) as Record<
					string,
					unknown
				>;
				key = `${info.usbVendorId}|${info.usbProductId}|${info.bluetoothServiceClassId}`;
			} else
				for (let i = 0; i < getters.length; i++)
					key += `${Reflect.apply(getters[i], device, [])}|`;
		} catch (failed) {
			return null;
		}
		keys.set(device as object, key);
		return key;
	};

	// what the site was granted, as the worker last said; a device this
	// document forgot while another site holds it is out of its lists
	// (by key, each with its services, in objects of no prototype)
	type Services = Record<string, true>;
	let granted = { __proto__: null } as unknown as Record<string, Services>;
	const forgotten = new OwnWeakSet<object>();
	const listed = (value: unknown): value is ArrayLike<unknown> =>
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { length?: unknown }).length === 'number';
	const addServices = (to: Services, names: ArrayLike<unknown>) => {
		for (let i = 0; i < names.length; i++)
			if (typeof names[i] === 'string') to[names[i] as string] = true;
	};
	const refresh = async () => {
		const answer = await ask({ op: 'devices', kind });
		const next = { __proto__: null } as unknown as Record<string, Services>;
		if (listed(answer))
			for (let i = 0; i < answer.length; i++) {
				const grant = answer[i] as DeviceGrant;
				if (!grant || typeof grant.key !== 'string') continue;
				const services = { __proto__: null } as unknown as Services;
				if (listed(grant.services)) addServices(services, grant.services);
				next[grant.key] = services;
			}
		granted = next;
	};
	void refresh();
	const isGranted = (device: unknown) => {
		const key = keyOf(device);
		return key !== null && key in granted && !forgotten.has(device as object);
	};

	// a Bluetooth device's id is its origin's: the browser's, hashed with
	// the origin's salt, made before the page is handed the device
	let salt: Promise<string | null> | null = null;
	const ids = new OwnWeakMap<object, string>();
	const nativeId = kind === 'bluetooth' ? getters[0] : undefined;
	const learnId = async (device: object) => {
		if (!nativeId || ids.has(device)) return;
		salt ??= hooks.salt();
		const real = Reflect.apply(nativeId, device, []) as string;
		ids.set(device, base64(hash128(`${(await salt) ?? ''}\n${real}`)));
	};
	if (nativeId)
		Reflect.defineProperty(devicePrototype, 'id', {
			...own(devicePrototype, 'id'),
			get: wrap(nativeId, (target, that, args) => {
				const id = Reflect.apply(target, that, args);
				return ids.get(that) ?? id;
			}) as () => string,
		});

	const list = (prototype as Record<string, Function>)[spec.list];
	if (typeof list === 'function')
		Reflect.defineProperty(prototype, spec.list, {
			...own(prototype, spec.list),
			value: wrap(list, async (target, that, args) => {
				const devices = (await Reflect.apply(target, that, args)) as object[];
				if (that !== object) return devices;
				await refresh();
				const out: object[] = [];
				for (let i = 0; i < devices.length; i++)
					if (isGranted(devices[i])) {
						await learnId(devices[i]);
						out[out.length] = devices[i];
					}
				return out;
			}),
		});

	// a Bluetooth request's services: what its filters and optionalServices
	// name, as the browser's own UUIDs
	const getService = (
		global as unknown as {
			BluetoothUUID?: { getService(name: unknown): string };
		}
	).BluetoothUUID?.getService;
	const uuid = (name: unknown): string | null => {
		try {
			return getService
				? (Reflect.apply(getService, undefined, [name]) as string)
				: null;
		} catch (failed) {
			return null;
		}
	};
	const servicesOf = (options: unknown): string[] => {
		const out: string[] = [];
		const add = (names: unknown) => {
			if (!listed(names)) return;
			for (let i = 0; i < names.length; i++) {
				const service = uuid(names[i]);
				if (service) out[out.length] = service;
			}
		};
		try {
			const { filters, optionalServices } = (options ?? {}) as {
				filters?: { services?: unknown }[];
				optionalServices?: unknown;
			};
			if (listed(filters))
				for (let i = 0; i < filters.length; i++) add(filters[i]?.services);
			add(optionalServices);
		} catch (failed) {
			// what the browser took is all it was given
		}
		return out;
	};
	const request = (prototype as Record<string, Function>)[spec.request];
	if (typeof request === 'function')
		Reflect.defineProperty(prototype, spec.request, {
			...own(prototype, spec.request),
			// called at once: the browser's chooser needs the page's gesture
			value: wrap(request, async (target, that, args) => {
				const device = (await Reflect.apply(target, that, args)) as object;
				const key = that === object ? keyOf(device) : null;
				if (key === null) return device;
				const services = kind === 'bluetooth' ? servicesOf(args[0]) : [];
				await ask({ op: 'grant', kind, key, services });
				const had = (granted[key] ??= {
					__proto__: null,
				} as unknown as Services);
				addServices(had, services);
				forgotten.delete(device);
				await learnId(device);
				return device;
			}),
		});

	const forget = (devicePrototype as Record<string, Function>).forget;
	if (typeof forget === 'function')
		Reflect.defineProperty(devicePrototype, 'forget', {
			...own(devicePrototype, 'forget'),
			value: wrap(forget, async (target, that, args) => {
				const key = keyOf(that);
				if (key === null) return Reflect.apply(target, that, args);
				const elsewhere = await ask({ op: 'forget', kind, key });
				delete granted[key];
				// the browser's own when no other site holds it
				if (elsewhere !== true) return Reflect.apply(target, that, args);
				forgotten.add(that);
				// what the browser's does to the device this document holds
				try {
					if (kind === 'bluetooth')
						(that as { gatt?: { disconnect(): void } }).gatt?.disconnect();
					else await (that as { close(): Promise<void> }).close();
				} catch (failed) {
					// not open
				}
				return undefined;
			}),
		});

	// connect and disconnect of the site's devices only
	if (kind !== 'bluetooth') {
		const stop = global.Event.prototype.stopImmediatePropagation;
		const target = own(global.Event.prototype, 'target')?.get;
		const listen = (type: string) =>
			Reflect.apply(global.EventTarget.prototype.addEventListener, object, [
				type,
				(event: Event) => {
					let device: unknown;
					try {
						device = spec.event
							? Reflect.apply(eventDevice!, event, [])
							: Reflect.apply(target!, event, []);
					} catch (failed) {
						device = null;
					}
					if (!isGranted(device)) Reflect.apply(stop, event, []);
				},
				true,
			]);
		listen('connect');
		listen('disconnect');
	}

	// a Bluetooth device's services are the ones its site named
	const server = (
		realm.BluetoothRemoteGATTServer as { prototype: object } | undefined
	)?.prototype;
	const serverDevice = server ? own(server, 'device')?.get : undefined;
	const serviceUUID = own(
		realm.BluetoothRemoteGATTService?.prototype ?? {},
		'uuid',
	)?.get;
	if (
		kind === 'bluetooth' &&
		server &&
		isNative(serverDevice, 'get device') &&
		isNative(serviceUUID, 'get uuid')
	) {
		// the services the site named for the server's device
		const namedFor = (that: unknown): Services | null => {
			try {
				const key = keyOf(Reflect.apply(serverDevice!, that, []));
				return key !== null && key in granted ? granted[key] : null;
			} catch (failed) {
				return null;
			}
		};
		const count = (names: Services | null) => {
			let n = 0;
			if (names) for (const name in names) if (names[name] === true) n++;
			return n;
		};
		// what the browser answers before it looks: a device whose site named
		// no service, and a service the site did not name (a name that is no
		// service is the browser's own TypeError)
		const refuse = (that: unknown, args: unknown[]) => {
			const names = namedFor(that);
			if (!count(names)) return error(NOT_ALLOWED_ANY, 'SecurityError');
			if (args.length && args[0] !== undefined) {
				const service = uuid(args[0]);
				if (service !== null && names![service] !== true)
					return error(NOT_ALLOWED_SERVICE, 'SecurityError');
			}
			return null;
		};
		const one = (server as Record<string, Function>).getPrimaryService;
		if (typeof one === 'function')
			Reflect.defineProperty(server, 'getPrimaryService', {
				...own(server, 'getPrimaryService'),
				value: wrap(one, async (target, that, args) => {
					const refused = refuse(that, args);
					if (refused) throw refused;
					return Reflect.apply(target, that, args);
				}),
			});
		const all = (server as Record<string, Function>).getPrimaryServices;
		if (typeof all === 'function')
			Reflect.defineProperty(server, 'getPrimaryServices', {
				...own(server, 'getPrimaryServices'),
				value: wrap(all, async (target, that, args) => {
					const refused = refuse(that, args);
					if (refused) throw refused;
					const services = (await Reflect.apply(
						target,
						that,
						args,
					)) as object[];
					const names = namedFor(that);
					const out: object[] = [];
					for (let i = 0; i < services.length; i++) {
						let service: string;
						try {
							service = Reflect.apply(serviceUUID!, services[i], []) as string;
						} catch (failed) {
							continue;
						}
						if (names?.[service] === true) out[out.length] = services[i];
					}
					if (!out.length) throw error(NO_SERVICES, 'NotFoundError');
					return out;
				}),
			});
	}
}
