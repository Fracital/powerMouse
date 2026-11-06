// snapshots of classes that are replaced/modified during module apply time
// exports automatically provided to modules in bundle

export const Reflect: typeof globalThis.Reflect = {
	apply: globalThis.Reflect.apply.bind(globalThis.Reflect),
	construct: globalThis.Reflect.construct.bind(globalThis.Reflect),
	defineProperty: globalThis.Reflect.defineProperty.bind(globalThis.Reflect),
	deleteProperty: globalThis.Reflect.deleteProperty.bind(globalThis.Reflect),
	get: globalThis.Reflect.get.bind(globalThis.Reflect),
	has: globalThis.Reflect.has.bind(globalThis.Reflect),
	getOwnPropertyDescriptor: globalThis.Reflect.getOwnPropertyDescriptor.bind(
		globalThis.Reflect,
	),
	getPrototypeOf: globalThis.Reflect.getPrototypeOf.bind(globalThis.Reflect),
	isExtensible: globalThis.Reflect.isExtensible.bind(globalThis.Reflect),
	ownKeys: globalThis.Reflect.ownKeys.bind(globalThis.Reflect),
	preventExtensions: globalThis.Reflect.preventExtensions.bind(
		globalThis.Reflect,
	),
	set: globalThis.Reflect.set.bind(globalThis.Reflect),
	setPrototypeOf: globalThis.Reflect.setPrototypeOf.bind(globalThis.Reflect),
};

export const fetch = globalThis.fetch;

export const URL = globalThis.URL;

export const Request = globalThis.Request;

export const Response = globalThis.Response;

export const XMLHttpRequest = globalThis.XMLHttpRequest;

export const XMLHttpRequestEventTarget = globalThis.XMLHttpRequestEventTarget;

export const EventSource = globalThis.EventSource;

export const WebSocket = globalThis.WebSocket;

export const Function = globalThis.Function;

export function bindDescriptors<T extends object>(
	to: object,
	bind: T,
	...inherit: object[]
): T {
	for (const object of inherit) {
		const descriptors = Object.getOwnPropertyDescriptors(object);

		for (const key in descriptors) {
			const { get, set, value, writable } = descriptors[key];
			const define: PropertyDescriptor = {};

			if (get) define.get = get.bind(bind);

			if (set) define.set = set.bind(bind);

			if (value)
				define.value = typeof value === 'function' ? value.bind(bind) : value;

			if (typeof writable === 'boolean') define.writable = writable;

			Reflect.defineProperty(to, key, define);
		}
	}

	return <T>to;
}
