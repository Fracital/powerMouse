// snapshots of classes that are replaced/modified during module apply time
// exports automatically provided to modules in bundle

// (the realm's Reflect, named once: each method is bound to it)
const nativeReflect = globalThis.Reflect;

export const Reflect: typeof globalThis.Reflect = {
	apply: nativeReflect.apply.bind(nativeReflect),
	construct: nativeReflect.construct.bind(nativeReflect),
	defineProperty: nativeReflect.defineProperty.bind(nativeReflect),
	deleteProperty: nativeReflect.deleteProperty.bind(nativeReflect),
	get: nativeReflect.get.bind(nativeReflect),
	has: nativeReflect.has.bind(nativeReflect),
	getOwnPropertyDescriptor:
		nativeReflect.getOwnPropertyDescriptor.bind(nativeReflect),
	getPrototypeOf: nativeReflect.getPrototypeOf.bind(nativeReflect),
	isExtensible: nativeReflect.isExtensible.bind(nativeReflect),
	ownKeys: nativeReflect.ownKeys.bind(nativeReflect),
	preventExtensions: nativeReflect.preventExtensions.bind(nativeReflect),
	set: nativeReflect.set.bind(nativeReflect),
	setPrototypeOf: nativeReflect.setPrototypeOf.bind(nativeReflect),
};

// The same methods under names of their own: build.js defines each
// `Reflect.<method>` of the inject bundles as one of these, so a call is a
// short name rather than a member of the object above (the same function)
export const reflectApply = Reflect.apply;
export const reflectConstruct = Reflect.construct;
export const reflectDefineProperty = Reflect.defineProperty;
export const reflectDeleteProperty = Reflect.deleteProperty;
export const reflectGet = Reflect.get;
export const reflectHas = Reflect.has;
export const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
export const reflectGetPrototypeOf = Reflect.getPrototypeOf;
export const reflectIsExtensible = Reflect.isExtensible;
export const reflectOwnKeys = Reflect.ownKeys;
export const reflectPreventExtensions = Reflect.preventExtensions;
export const reflectSet = Reflect.set;
export const reflectSetPrototypeOf = Reflect.setPrototypeOf;

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
