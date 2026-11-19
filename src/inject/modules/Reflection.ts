import Client from '../Client';
import Module from '../Module';
import { OwnWeakSet } from '../ownCollections';
import { windowArrayParts } from '../windowArrayParts';
import type { WindowArrays } from '../windowArrays';
import { accessHolders } from './Access';
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
		const moduleClient = this.client;
		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const global = moduleClient.global as typeof globalThis &
			Record<string, unknown>;
		// (the client's own: the global of that name is the page's to write)
		const api = () => moduleClient.accessApi as Api;
		const document = (global as { document?: unknown }).document;

		// (the names of UNDEFINABLE, asked without a method a page could have
		// replaced on Array.prototype)
		const unforgeable = (key: unknown): key is string =>
			key === 'eval' || key === 'location' || key === 'top';
		// the helper names (the access API and client key on the window, the
		// stand-in tags on location and eval) never show in an enumeration of
		// those objects and are not "own" to any reflective question, nor have
		// a descriptor, nor are found by the `in` operator (which the rewriter
		// routes to the access API's `has`)
		const hidden = new Set<PropertyKey>([
			moduleClient.names.access,
			moduleClient.names.client,
			moduleClient.names.globalProxy,
			moduleClient.names.globalName,
		]);
		// A Number.prototype with the access API on it (where rewritten code
		// reaches it: src/helperNames.ts accessExpression): this realm's, or
		// that of a frame this bundle hooked. A page that listed a frame's
		// Number.prototype through this window's Reflect.ownKeys or
		// Object.getOwnPropertyDescriptors saw the API's name, its descriptor
		// and its helpers' sources (asked of a set of the bundle's, so no
		// trap of a page's Proxy runs)
		const holdsAccess = (target: unknown): target is object =>
			typeof target === 'object' &&
			target !== null &&
			accessHolders.has(target);
		// a window (this one, another, a Proxy over one), the document, a
		// worker scope or a prototype of the scope (WorkerGlobalScope.prototype
		// holds a worker's `location`): the objects whose `top`, `location`
		// and `eval` the page must not see raw
		const nativeDefaultView = (global as { Document?: { prototype: object } })
			.Document
			? Reflect.getOwnPropertyDescriptor(
					(global as unknown as { Document: { prototype: object } }).Document
						.prototype,
					'defaultView',
				)?.get
			: undefined;
		const nativeNodeType = (global as { Node?: { prototype: object } }).Node
			? Reflect.getOwnPropertyDescriptor(
					(global as unknown as { Node: { prototype: object } }).Node.prototype,
					'nodeType',
				)?.get
			: undefined;
		const scopePrototypes = new Set<object>();
		for (
			let prototype = Object.getPrototypeOf(global);
			prototype && prototype !== global.Object.prototype;
			prototype = Object.getPrototypeOf(prototype)
		)
			scopePrototypes.add(prototype);
		// what the browser's nodeType getter refused (an interface's
		// prototype, HTMLElement.prototype, is no node): that never changes.
		// The page's own read of `nodeType` threw for each of them, so every
		// descriptor asked of such a prototype made an exception, about 2 us
		// against 0.05 natively, and a frame its parent had injected spent
		// some 4.5 ms of its bundle's evaluation on them (Chrome 157)
		const notNodes = new OwnWeakSet<object>();
		const windowLike = (target: unknown): boolean => {
			if (typeof target !== 'object' || target === null) return false;
			if (target === global || target === document) return true;
			if (scopePrototypes.has(target)) return true;
			try {
				const scope = target as {
					window?: unknown;
					self?: unknown;
				};
				if (scope.window === target || scope.self === target) return true;
				// the document of another window (a frame's contentDocument):
				// its `location` is that window's, and its descriptor's getter
				// handed out the frame's real Location, the proxy's URL and a
				// way to navigate the frame past the rewriter. Told by the
				// browser's getters, which run no code of the page's; most of
				// what reflection is asked about has no nodeType at all
				if (!nativeNodeType || !nativeDefaultView || !('nodeType' in target))
					return false;
				if (notNodes.has(target)) return false;
				let type: unknown;
				try {
					type = Reflect.apply(nativeNodeType, target, []);
				} catch (error) {
					notNodes.add(target);
					return false;
				}
				return (
					type === 9 && Reflect.apply(nativeDefaultView, target, []) !== null
				);
			} catch (error) {
				return false;
			}
		};

		// The globals a module defines only when they are first looked at
		// (lazyGlobals), of this window or of another this bundle or its own
		// hooked: until then such a global is an accessor of the inject's,
		// and a page that read its descriptor on a frame's window from
		// outside (the parent's Object.getOwnPropertyDescriptor) saw the
		// accessor and its source. Another window is told by the browser
		// (the native `window` getter, which no Proxy answers), so the
		// client's name is read from nothing a page made.
		const nativeWindow = Reflect.getOwnPropertyDescriptor(
			global,
			'window',
		)?.get;
		const lazyOf = (target: unknown): Map<string, () => void> | undefined => {
			if (target === global) return moduleClient.lazyGlobals;
			if (!nativeWindow || typeof target !== 'object' || target === null)
				return undefined;
			try {
				// (a plain read first: the native getter throws for every
				// object that is no window, and reflection is asked of many)
				if (
					(target as { window?: unknown }).window !== target ||
					Reflect.apply(nativeWindow, target, []) !== target
				)
					return undefined;
				return (
					Reflect.getOwnPropertyDescriptor(target, moduleClient.names.client)
						?.value as Client | undefined
				)?.lazyGlobals;
			} catch (error) {
				// no window, or another origin's
				return undefined;
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
					if (typeof args[1] === 'string') lazyOf(args[0])?.get(args[1])?.();
					const descriptor = Reflect.apply(target, that, args) as
						PropertyDescriptor | undefined;
					if (
						descriptor &&
						args[1] === moduleClient.names.access &&
						holdsAccess(args[0])
					)
						return undefined;
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

		// a global a module redefined is listed where the browser lists it
		const inNativeOrder = (keys: PropertyKey[]) => {
			for (const [name, after] of moduleClient.globalKeyAfter) {
				const at = keys.indexOf(name);
				const before = keys.indexOf(after);
				if (at === -1 || before === -1 || at === before + 1) continue;
				keys.splice(at, 1);
				keys.splice(keys.indexOf(after) + 1, 0, name);
			}
			return keys;
		};
		global.Object.getOwnPropertyDescriptors = proxyModule.wrapFunction(
			global.Object.getOwnPropertyDescriptors,
			(target, that, args) => {
				const lazy = lazyOf(args[0]);
				if (lazy) for (const resolve of [...lazy.values()]) resolve();
				let descriptors = Reflect.apply(target, that, args) as Record<
					PropertyKey,
					PropertyDescriptor
				>;
				if (args[0] === global && moduleClient.globalKeyAfter.size) {
					const ordered: Record<PropertyKey, PropertyDescriptor> = {};
					for (const key of inNativeOrder(Reflect.ownKeys(descriptors)))
						ordered[key as string] = descriptors[key as string];
					descriptors = ordered;
				}
				if (windowLike(args[0]))
					for (const key of Reflect.ownKeys(descriptors))
						if (hidden.has(key)) Reflect.deleteProperty(descriptors, key);
						else
							descriptors[key] = unforgeable(key)
								? spoofed(descriptors[key], key)
								: restricted(descriptors[key], key, args[0]);
				// (where rewritten code reaches the access API: src/helperNames.ts
				// accessExpression)
				if (holdsAccess(args[0]))
					Reflect.deleteProperty(descriptors, moduleClient.names.access);
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

		this.applyWindowChildren(windowLike);

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

		// a stand-in carries its name under the tag (setGlobalProxy), never
		// enumerable, where a page's own object with that key has its own
		const tagged = (target: unknown): boolean => {
			if (
				(typeof target !== 'object' && typeof target !== 'function') ||
				target === null
			)
				return false;
			try {
				const tag = Reflect.getOwnPropertyDescriptor(
					target,
					moduleClient.names.globalName,
				);
				return (
					tag !== undefined && !tag.enumerable && typeof tag.value === 'string'
				);
			} catch (error) {
				return false;
			}
		};
		// (and Number.prototype, where rewritten code reaches the access API:
		// src/helperNames.ts accessExpression)
		const ours = (target: unknown) =>
			windowLike(target) || holdsAccess(target) || tagged(target);
		// a number object finds the access API's name on its prototype
		const inherits = (target: unknown) => {
			try {
				return (
					typeof target === 'object' &&
					target !== null &&
					holdsAccess(Reflect.getPrototypeOf(target)) &&
					!Reflect.getOwnPropertyDescriptor(target, moduleClient.names.access)
				);
			} catch (error) {
				return false;
			}
		};
		// the `in` operator asks the same (access API `has`)
		moduleClient.hidesName = (target, key) =>
			hidden.has(key as PropertyKey) &&
			(ours(target) || (key === moduleClient.names.access && inherits(target)));
		for (const [holder, name] of [
			[global.Object, 'getOwnPropertyNames'],
			[global.Reflect, 'ownKeys'],
		] as const)
			(holder as Record<string, any>)[name] = proxyModule.wrapFunction(
				(holder as Record<string, any>)[name],
				(target, that, args) => {
					const keys = Reflect.apply(target, that, args) as PropertyKey[];
					if (args[0] === global) inNativeOrder(keys);
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
						if (typeof args[0] === 'string') lazyOf(that)?.get(args[0])?.();
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

	/**
	 * The rest of a window's array-likeness. The browser's own methods that
	 * read an array-like read a window's children with no hook in the way:
	 * Array.prototype's (`Array.prototype.at.call(window, 0)`, `values`,
	 * `find`, `slice` and the rest, which a window has as `this` only by
	 * `call`, `apply`, `bind` or `Reflect.apply`), a `concat` of a window the
	 * page made spreadable, and a window given as the arguments of a call
	 * (`f.apply(null, window)`, `Reflect.apply`, `Reflect.construct`). A
	 * child of another site came out of them as the proxy's own window. Such
	 * a call reads the window as the page may see it: each child as the
	 * access API hands out `window[i]` (a view of the window, read as late
	 * as natively, so an iterator of it is live), and a callback is given the
	 * window itself where natively it is given the receiver.
	 *
	 * The methods are not wrapped on Array.prototype: many interfaces hold
	 * the same functions (NodeList.prototype.forEach is
	 * Array.prototype.forEach, every iterable list's `@@iterator` is its
	 * `values`), and V8 keeps one flag for the whole process that an array's
	 * `@@iterator` is the browser's: another function written there turns
	 * off the fast path of every spread and `Array.from` of an array in
	 * every page of the process for good, about thirty times slower
	 * (measured, Chrome 157). The calls that give a method another `this`
	 * are where a window becomes the receiver.
	 */
	applyWindowChildren(windowLike: (target: unknown) => boolean) {
		const client = this.client;
		const global = client.global as typeof globalThis & Record<string, any>;
		// a scope without windows (a worker) has no children to read
		if (!Reflect.getOwnPropertyDescriptor(global, 'window')?.get) return;
		const proxyModule = client.getModule(ProxyModule)!;
		const api = () => client.accessApi as Api;
		const isArray = global.Array.isArray;
		const isWindow = (value: unknown): boolean =>
			typeof value === 'object' &&
			value !== null &&
			!isArray(value) &&
			(client.isWindowObject
				? client.isWindowObject(value)
				: windowLike(value));
		// what reads the window as the page may (../windowArrays.ts), made at
		// a document's first such call
		let arrays: WindowArrays | undefined;
		const windowArrays = () =>
			(arrays ??= windowArrayParts.make!()({
				get: (object, key, container) => api().get(object, key, container),
				isWindow,
				proxyModule,
			}));
		const listOf = (list: unknown) =>
			isWindow(list) ? windowArrays().childrenOf(list) : list;

		const arrayPrototype = global.Array.prototype as any;
		for (const name in READERS) {
			const native = Reflect.getOwnPropertyDescriptor(
				arrayPrototype,
				name,
			)?.value;
			if (typeof native === 'function')
				Reflect.apply(weakMapSet, arrayReaders, [native, name]);
		}
		const route = (
			native: Function,
			name: string,
			window: object,
			args: unknown[],
		): unknown => windowArrays().route(native, name, window, args);

		// (`length`: a hook with a rest parameter where the native counts one)
		const install = (holder: any, hook: Function, length = false) => {
			const { name } = hook;
			if (length) proxyModule.mirrorAttributes(holder[name], hook);
			else proxyModule.mirrorSource(holder[name], hook);
			proxyModule.adopt(hook);
			holder[name] = hook;
		};
		// (each hook as light as can be: these are among the calls a page
		// makes most, and one that the engine inlines costs next to nothing;
		// a misuse is the browser's to refuse, the realm's own native's)
		const functionPrototype = global.Function.prototype as any;
		const { call, apply, bind } = functionPrototype as {
			call: Function;
			apply: Function;
			bind: Function;
		};
		const functionHooks = {
			call(this: unknown, thisArg: unknown, ...args: unknown[]) {
				const name = readerOf(this);
				if (name !== undefined && isWindow(thisArg))
					return route(this as Function, name, thisArg as object, args);
				return typeof this === 'function'
					? Reflect.apply(this, thisArg, args)
					: Reflect.apply(call, this, before(thisArg, args));
			},
			apply(this: unknown, thisArg: unknown, list: unknown) {
				const empty = list === undefined || list === null;
				if (empty || typeof list === 'object') {
					const name = readerOf(this);
					if (name !== undefined && isWindow(thisArg))
						return route(
							this as Function,
							name,
							thisArg as object,
							empty
								? []
								: Reflect.apply(gather, undefined, listOf(list) as unknown[]),
						);
					if (typeof this === 'function')
						return Reflect.apply(
							this,
							thisArg,
							empty ? EMPTY : (listOf(list) as unknown[]),
						);
				}
				return Reflect.apply(apply, this, [thisArg, list]);
			},
			bind(this: unknown, thisArg: unknown, ...args: unknown[]) {
				const name = readerOf(this);
				return Reflect.apply(
					bind,
					name !== undefined && isWindow(thisArg)
						? windowArrays().routerOf(this as Function)
						: this,
					before(thisArg, args),
				);
			},
		};
		install(functionPrototype, functionHooks.call);
		install(functionPrototype, functionHooks.apply);
		install(functionPrototype, functionHooks.bind);

		const reflect = global.Reflect as any;
		const realmReflectApply = reflect.apply as Function;
		const realmReflectConstruct = reflect.construct as Function;
		const reflectHooks = {
			apply(target: unknown, thisArg: unknown, list: unknown) {
				const name = readerOf(target);
				if (
					name !== undefined &&
					typeof list === 'object' &&
					list !== null &&
					isWindow(thisArg)
				)
					return route(
						target as Function,
						name,
						thisArg as object,
						Reflect.apply(gather, undefined, listOf(list) as unknown[]),
					);
				return Reflect.apply(realmReflectApply, undefined, [
					target,
					thisArg,
					listOf(list),
				]);
			},
			construct(target: unknown, list: unknown, ...newTarget: unknown[]) {
				return Reflect.apply(
					realmReflectConstruct,
					undefined,
					newTarget.length
						? [target, listOf(list), newTarget[0]]
						: [target, listOf(list)],
				);
			},
		};
		install(reflect, reflectHooks.apply);
		install(reflect, reflectHooks.construct);

		// what reads a window's own properties and hands each to the page's
		// function: JSON.stringify's replacer is given a window's children,
		// its `top`, `parent` and `location` as a member read hands them out
		const stringify = global.JSON.stringify as Function;
		install(
			global.JSON,
			{
				stringify(value: unknown, replacer: unknown, space: unknown) {
					if (typeof replacer === 'function') {
						const pages = replacer;
						replacer = function (this: unknown, key: string, member: unknown) {
							return Reflect.apply(pages, this, [
								key,
								isWindow(this) ? api().get(member, key, this) : member,
							]);
						};
					}
					return Reflect.apply(stringify, undefined, [value, replacer, space]);
				},
			}.stringify,
		);
		// and what reads an array-like as Array.from does (which the access
		// API's Array.from hook covers): a typed array's `from` (a window
		// has no number in it, but the map function sees each child) and
		// Array.fromAsync
		const typedArray = Reflect.getPrototypeOf(global.Int8Array) as any;
		for (const [holder, name] of [
			[typedArray, 'from'],
			[global.Array, 'fromAsync'],
		] as const) {
			const native = holder?.[name];
			if (typeof native !== 'function') continue;
			install(
				holder,
				{
					[name](this: unknown, items: unknown, ...rest: unknown[]) {
						return Reflect.apply(
							native,
							this,
							before(
								isWindow(items) ? windowArrays().viewOf(items) : items,
								rest,
							),
						);
					},
				}[name],
				true,
			);
		}

		// `[].concat(window)` spreads a window that the page made spreadable
		// (`window[Symbol.isConcatSpreadable] = true`), as natively, by its
		// children
		const concat = arrayPrototype.concat as Function;
		const spreadable = (value: unknown) =>
			isWindow(value) && !!(value as any)[SPREADABLE];
		install(
			arrayPrototype,
			{
				concat(this: unknown, ...items: unknown[]) {
					for (let index = 0; index < items.length; index++) {
						const item = items[index];
						if (!isArray(item) && spreadable(item))
							items[index] = windowArrays().viewOf(item);
					}
					return Reflect.apply(
						concat,
						!isArray(this) && spreadable(this)
							? windowArrays().viewOf(this)
							: this,
						items,
					);
				},
			}.concat,
			true,
		);
	}
}

export const SPREADABLE = Symbol.isConcatSpreadable;
const EMPTY: unknown[] = [];
/** `first`, then `rest`: a list made with no iterator a page could replace */
const before = (first: unknown, rest: unknown[]): unknown[] => {
	const list = [first];
	for (let index = 0; index < rest.length; index++)
		list[index + 1] = rest[index];
	return list;
};
/** a function to spread a list into: the list as a browser's call reads it */
const gather = (...items: unknown[]) => items;
/**
 * Array.prototype's methods that read the elements of what they are called
 * on, each with where its callback is given that object (the receiver, as
 * its last argument) or -1. The ones that only write (`push`, `fill`) the
 * browser refuses on a window, and `keys` reads only its length.
 */
export const READERS: Record<string, number> = {
	at: -1,
	entries: -1,
	every: 2,
	filter: 2,
	find: 2,
	findIndex: 2,
	findLast: 2,
	findLastIndex: 2,
	flat: -1,
	flatMap: 2,
	forEach: 2,
	includes: -1,
	indexOf: -1,
	join: -1,
	lastIndexOf: -1,
	map: 2,
	reduce: 3,
	reduceRight: 3,
	slice: -1,
	some: 2,
	sort: -1,
	toLocaleString: -1,
	toReversed: -1,
	toSorted: -1,
	toSpliced: -1,
	values: -1,
	with: -1,
};
/** those natives, of every realm this bundle hooked, by name */
const arrayReaders = new WeakMap<object, string>();
// the collections' own methods, taken when the bundle loads: a page that
// replaced WeakMap.prototype.get and called the one it replaced by `call`
// (hooked here) had every call of its own ask its function again
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
/**
 * the name of one of those, asked of anything a page calls `call` on (the
 * map's own `get` bound to it: no list made per call)
 */
export const readerOf = Reflect.apply(Function.prototype.bind, weakMapGet, [
	arrayReaders,
]) as (fn: unknown) => string | undefined;
