import { UNDEFINABLE } from '../../rewriteJS';
import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

type Api = {
	get(object: unknown, key: unknown, container?: unknown): unknown;
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
		const api = () => global[this.client.names.access] as Api;
		const document = (global as { document?: unknown }).document;

		const unforgeable = (key: unknown): key is string =>
			typeof key === 'string' && UNDEFINABLE.includes(key);
		// the helper names (the access API and client key on the window, the
		// stand-in tags on location and eval) never show in an enumeration of
		// those objects and are not "own" to any reflective question, nor have
		// a descriptor; the bare `in` operator remains a tell (rewriting every
		// `in` would cost more)
		const hidden = new Set<PropertyKey>([
			this.client.names.access,
			this.client.names.client,
			this.client.names.globalProxy,
			this.client.names.globalName,
		]);
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

		// a window's own children are its indexed properties (`window[0]`),
		// which reflection reads too: another proxied site's comes back as the
		// restricted stand-in a member read gives (the access API decides)
		const restricted = (
			descriptor: PropertyDescriptor,
			key: unknown,
			target: unknown,
		) => {
			if ('value' in descriptor)
				descriptor.value = api().get(descriptor.value, key, target);
			return descriptor;
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
					if (!descriptor || !windowLike(args[0])) return descriptor;
					if (hidden.has(args[1] as PropertyKey)) return undefined;
					return unforgeable(args[1])
						? spoofed(descriptor, args[1])
						: restricted(descriptor, args[1], args[0]);
				},
			);
		};
		wrapDescriptorGetter(global.Object, 'getOwnPropertyDescriptor');
		wrapDescriptorGetter(global.Reflect, 'getOwnPropertyDescriptor');

		global.Object.getOwnPropertyDescriptors = proxyModule.wrapFunction(
			global.Object.getOwnPropertyDescriptors,
			(target, that, args) => {
				const descriptors = Reflect.apply(target, that, args) as Record<
					PropertyKey,
					PropertyDescriptor
				>;
				if (windowLike(args[0]))
					for (const key of Reflect.ownKeys(descriptors))
						if (hidden.has(key)) Reflect.deleteProperty(descriptors, key);
						else
							descriptors[key] = unforgeable(key)
								? spoofed(descriptors[key], key)
								: restricted(descriptors[key], key, args[0]);
				return descriptors;
			},
		);

		global.Reflect.get = proxyModule.wrapFunction(
			global.Reflect.get,
			(target, that, args) => {
				// any key: what it reads is handed out like a member read's value
				return api().get(Reflect.apply(target, that, args), args[1], args[0]);
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
				if (!windowLike(to) && !sources.some(windowLike))
					return Reflect.apply(target, that, args);
				for (const source of sources) {
					if (source === null || source === undefined) continue;
					const from = windowLike(source);
					for (const key of Reflect.ownKeys(Object(source))) {
						if (
							!Reflect.getOwnPropertyDescriptor(Object(source), key)?.enumerable
						)
							continue;
						const value = from
							? api().get(
									(source as Record<PropertyKey, unknown>)[key],
									key,
									source,
								)
							: (source as Record<PropertyKey, unknown>)[key];
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
						return name === 'entries'
							? [key, api().get((entry as [string, unknown])[1], key, args[0])]
							: api().get(entry, key, args[0]);
					});
				},
			);

		// `Array.from(frames)`: a window is array-like by its children
		global.Array.from = proxyModule.wrapFunction(
			global.Array.from,
			(target, that, args) => {
				if (!windowLike(args[0])) return Reflect.apply(target, that, args);
				const [items, map, thisArg] = args as [
					unknown,
					((value: unknown, index: number) => unknown) | undefined,
					unknown,
				];
				// the map function sees what the page may see, as the result does
				return Reflect.apply(target, that, [
					items,
					(value: unknown, index: number) => {
						const child = api().get(value, index, items);
						return map === undefined
							? child
							: Reflect.apply(map, thisArg, [child, index]);
					},
				]);
			},
		);

		const nativeHasOwn = global.Object.prototype.hasOwnProperty;
		const tagged = (target: unknown): boolean => {
			if (
				(typeof target !== 'object' && typeof target !== 'function') ||
				target === null
			)
				return false;
			try {
				return Reflect.apply(nativeHasOwn, target, [
					this.client.names.globalName,
				]) as boolean;
			} catch (error) {
				return false;
			}
		};
		const ours = (target: unknown) => windowLike(target) || tagged(target);
		for (const [holder, name] of [
			[global.Object, 'getOwnPropertyNames'],
			[global.Reflect, 'ownKeys'],
		] as const)
			(holder as Record<string, any>)[name] = proxyModule.wrapFunction(
				(holder as Record<string, any>)[name],
				(target, that, args) => {
					const keys = Reflect.apply(target, that, args) as PropertyKey[];
					return ours(args[0]) ? keys.filter((key) => !hidden.has(key)) : keys;
				},
			);
		for (const name of ['hasOwnProperty', 'propertyIsEnumerable'] as const)
			objectPrototypeMethod(name);
		function objectPrototypeMethod(name: string) {
			const prototype = global.Object.prototype as Record<string, any>;
			prototype[name] = proxyModule.wrapFunction(
				prototype[name],
				(target, that, args) =>
					hidden.has(args[0] as PropertyKey) && ours(that)
						? false
						: Reflect.apply(target, that, args),
			);
		}
		for (const [holder, name] of [
			[global.Object, 'hasOwn'],
			[global.Reflect, 'has'],
		] as const) {
			const record = holder as Record<string, any>;
			if (typeof record[name] !== 'function') continue;
			record[name] = proxyModule.wrapFunction(
				record[name],
				(target, that, args) =>
					hidden.has(args[1] as PropertyKey) && ours(args[0])
						? false
						: Reflect.apply(target, that, args),
			);
		}

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
