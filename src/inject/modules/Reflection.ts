import { ACCESS_KEY, UNDEFINABLE } from '../../rewriteJS';
import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

type Api = {
	get(object: unknown, key: unknown): unknown;
	set2(
		target: unknown,
		key: unknown,
		operate: (target: any, property: any, value: any) => unknown,
		righthand: unknown,
	): unknown;
};

/**
 * The rewriter routes the names `top`, `location` and `eval` it can see in
 * source. Reflection reaches the same unforgeable properties without naming
 * them in a member expression: `Object.getOwnPropertyDescriptor(window,
 * 'top').get.call(window)`, `Reflect.get(window, 'location')`,
 * `__lookupGetter__`, `Object.entries(window)`. Those APIs hand back the same
 * values the member read would: descriptors whose accessors resolve through
 * the access API (writes to `location` route), and values resolved by what
 * they are, so a Proxy over the window is covered too.
 */
export default class ReflectionModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global as typeof globalThis &
			Record<string, unknown>;
		const api = () => global[ACCESS_KEY] as Api;
		const document = (global as { document?: unknown }).document;

		const unforgeable = (key: unknown): key is string =>
			typeof key === 'string' && UNDEFINABLE.includes(key);
		// a window (this one, another, a Proxy over one), the document, a
		// worker scope or a prototype of the scope (WorkerGlobalScope.prototype
		// holds a worker's `location`): the objects whose `top`, `location`
		// and `eval` the page must not see raw
		const scopePrototypes = new Set<object>();
		for (
			let prototype = Object.getPrototypeOf(global);
			prototype && prototype !== global.Object.prototype;
			prototype = Object.getPrototypeOf(prototype)
		)
			scopePrototypes.add(prototype);
		const windowLike = (target: unknown): boolean => {
			if (typeof target !== 'object' || target === null) return false;
			if (target === global || target === document) return true;
			if (scopePrototypes.has(target)) return true;
			try {
				const scope = target as { window?: unknown; self?: unknown };
				return scope.window === target || scope.self === target;
			} catch (error) {
				return false;
			}
		};

		const spoofed = (descriptor: PropertyDescriptor, key: string) => {
			const result: PropertyDescriptor = { ...descriptor };
			if (descriptor.get)
				result.get = proxyModule.wrapFunction(
					descriptor.get,
					(target, that, args) =>
						api().get(Reflect.apply(target, that, args), key),
				);
			if (descriptor.set)
				result.set = proxyModule.wrapFunction(
					descriptor.set,
					(target, that, args) => {
						// a location write routes like `window.location = v`
						api().set2(
							that,
							key,
							(object, property, value) => {
								object[property] = value;
							},
							args[0],
						);
					},
				);
			if ('value' in descriptor)
				result.value = api().get(descriptor.value, key);
			return result;
		};

		const wrapDescriptorGetter = (
			holder: Record<string, any>,
			name: string,
		) => {
			holder[name] = proxyModule.wrapFunction(
				holder[name],
				(target, that, args) => {
					const descriptor = Reflect.apply(target, that, args) as
						PropertyDescriptor | undefined;
					return descriptor && windowLike(args[0]) && unforgeable(args[1])
						? spoofed(descriptor, args[1])
						: descriptor;
				},
			);
		};
		wrapDescriptorGetter(global.Object, 'getOwnPropertyDescriptor');
		wrapDescriptorGetter(global.Reflect, 'getOwnPropertyDescriptor');

		global.Object.getOwnPropertyDescriptors = proxyModule.wrapFunction(
			global.Object.getOwnPropertyDescriptors,
			(target, that, args) => {
				const descriptors = Reflect.apply(target, that, args) as Record<
					string,
					PropertyDescriptor
				>;
				if (windowLike(args[0]))
					for (const key of UNDEFINABLE)
						if (key in descriptors)
							descriptors[key] = spoofed(descriptors[key], key);
				return descriptors;
			},
		);

		global.Reflect.get = proxyModule.wrapFunction(
			global.Reflect.get,
			(target, that, args) => {
				const value = Reflect.apply(target, that, args);
				return unforgeable(args[1]) ? api().get(value, args[1]) : value;
			},
		);

		// writes: a location written reflectively routes like `location = v`
		const assign = (target: object, key: string, value: unknown) =>
			api().set2(
				target,
				key,
				(object, property, v) => {
					object[property] = v;
				},
				value,
			);
		global.Reflect.set = proxyModule.wrapFunction(
			global.Reflect.set,
			(target, that, args) => {
				if (windowLike(args[0]) && args[1] === 'location') {
					assign(args[0] as object, 'location', args[2]);
					return true;
				}
				return Reflect.apply(target, that, args);
			},
		);
		global.Object.assign = proxyModule.wrapFunction(
			global.Object.assign,
			(target, that, args) => {
				const [to, ...sources] = args;
				if (!windowLike(to)) return Reflect.apply(target, that, args);
				for (const source of sources) {
					if (source === null || source === undefined) continue;
					for (const key of Reflect.ownKeys(Object(source))) {
						const value = (source as Record<PropertyKey, unknown>)[key];
						if (key === 'location') assign(to as object, 'location', value);
						else (to as Record<PropertyKey, unknown>)[key] = value;
					}
				}
				return to;
			},
		);

		for (const name of ['entries', 'values'] as const)
			global.Object[name] = proxyModule.wrapFunction(
				global.Object[name],
				(target, that, args) => {
					const result = Reflect.apply(target, that, args) as unknown[];
					if (!windowLike(args[0])) return result;
					const keys = Object.keys(args[0] as object);
					return result.map((entry, index) => {
						const key =
							name === 'entries'
								? (entry as [string, unknown])[0]
								: keys[index];
						if (!unforgeable(key)) return entry;
						return name === 'entries'
							? [key, api().get((entry as [string, unknown])[1], key)]
							: api().get(entry, key);
					});
				},
			);

		// the access API's own name never shows in an enumeration of the window
		const hidden = new Set<PropertyKey>([ACCESS_KEY]);
		for (const [holder, name] of [
			[global.Object, 'getOwnPropertyNames'],
			[global.Reflect, 'ownKeys'],
		] as const)
			(holder as Record<string, any>)[name] = proxyModule.wrapFunction(
				(holder as Record<string, any>)[name],
				(target, that, args) => {
					const keys = Reflect.apply(target, that, args) as PropertyKey[];
					return windowLike(args[0])
						? keys.filter((key) => !hidden.has(key))
						: keys;
				},
			);

		const objectPrototype = global.Object.prototype as Record<string, any>;
		for (const name of ['__lookupGetter__', '__lookupSetter__'])
			if (typeof objectPrototype[name] === 'function')
				objectPrototype[name] = proxyModule.wrapFunction(
					objectPrototype[name],
					(target, that, args) => {
						const accessor = Reflect.apply(target, that, args);
						if (!accessor || !windowLike(that) || !unforgeable(args[0]))
							return accessor;
						const descriptor = spoofed(
							(name === '__lookupGetter__'
								? { get: accessor }
								: { set: accessor }) as PropertyDescriptor,
							args[0],
						);
						return name === '__lookupGetter__'
							? descriptor.get
							: descriptor.set;
					},
				);
	}
}
