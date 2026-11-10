import { keepSourcesHere, originalSource } from '../../functionSource';
import Client from '../Client';
import Module from '../Module';
import { isNative } from '../nativeUtil';

// import { getOwnPropertyDescriptors, mirror_attributes } from './rewriteUtil.js';

export const cleanupPrototype = Symbol();
export const preparePrototype = Symbol();
/*
 * Sets the prototype of an object while this script is working with it. This is to ensure we are only accessing the native functions and not any traps/shims.
 */
export function usePrototype<Prototype extends object, CallbackResult>(
	target: object,
	usePrototype: Prototype,
	callback: (object: Prototype) => CallbackResult,
): CallbackResult {
	const prototype = Reflect.getPrototypeOf(target);
	Reflect.setPrototypeOf(target, usePrototype);

	// an own property shadows any prototype: OneTrust (discord.com) gives the
	// scripts it creates an own setAttribute that writes through the hooked
	// one, so a hook calling `element.setAttribute` ran the page's and
	// recursed. The own ones the hook prototype also has are set aside while
	// the hooks work (a non-configurable one cannot be, and stays)
	let hidden: [key: string | symbol, descriptor: PropertyDescriptor][] | null =
		null;
	for (const key of Reflect.ownKeys(target)) {
		if (!(key in usePrototype)) continue;
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		if (!descriptor?.configurable || !Reflect.deleteProperty(target, key))
			continue;
		(hidden ??= []).push([key, descriptor]);
	}

	const uses = <
		{ [preparePrototype]?: () => void; [cleanupPrototype]?: () => void }
	>target;

	if (uses[preparePrototype]) {
		uses[preparePrototype]();
	}

	let result: any[];

	{
		const set = <Prototype>target;

		try {
			result = [callback(set)];
		} catch (error) {
			result = [undefined, error];
		}
	}

	// restore the real prototype before cleanup: cleanup applies pending
	// attributes, which synchronously runs custom element reactions that
	// expect `this` to be the element, not our hook prototype
	const cleanup = uses[cleanupPrototype];

	Reflect.setPrototypeOf(target, prototype);

	if (hidden)
		for (const [key, descriptor] of hidden)
			Reflect.defineProperty(target, key, descriptor);

	if (cleanup) {
		cleanup.call(target);
	}

	if (result.length === 2) {
		throw result[1];
	}

	return result[0];
}

export function applyDescriptors(target: any, from: any): any {
	Object.defineProperties(target, Object.getOwnPropertyDescriptors(from));
}

export function invokeGlobal(that: any, check: any) {
	if (that !== check) {
		throw new TypeError('Illegal invocation');
	}
}

export function classConstant(target: any, key: string, value: any) {
	const descriptor = {
		configurable: false,
		writable: false,
		enumerable: true,
		value,
	};

	Reflect.defineProperty(target, key, descriptor);
	Reflect.defineProperty(target.prototype, key, descriptor);
}

export function onEventTarget(target: any, event: string) {
	const property = `on${event}`;
	const listeners = new WeakMap();

	Reflect.defineProperty(target, property, {
		enumerable: true,
		configurable: true,
		get() {
			if (listeners.has(this)) {
				return listeners.get(this);
			} else {
				return null;
			}
		},
		set(value) {
			if (typeof value === 'function') {
				if (listeners.has(this)) {
					this.removeEventListener(event, listeners.get(this));
				}

				listeners.set(this, value);
				this.addEventListener(event, value);
			}

			return value;
		},
	});
}

/**
 * Throws a generic argument error.
 * @example
 * catchRequiredArguments([].length, 1, "Window", "fetch"); // TypeError: Failed to execute 'fetch' on 'Window': 1 argument required, but only 0 present.
 */
export function catchRequiredArguments(
	args: number,
	requiredArguments: number,
	on: string,
	api: string,
) {
	if (args < requiredArguments) {
		const message = `${
			requiredArguments === 1
				? '1 argument required'
				: `${requiredArguments} required`
		}, but only ${args} present.`;

		throw new TypeError(
			on === 'constructor'
				? `Failed to construct ${api}: ${message}`
				: `Failed to execute '${api}' on '${on}: ${message}`,
		);
	}
}

export function contextThis(that: unknown, global: typeof globalThis): unknown {
	if (that === undefined || that === null) {
		return global;
	} else {
		return that;
	}
}

// the native source each wrapper shows: one table for every realm the
// bundle hooks, so a page that reads another realm's hooked function (a
// popup's document.write, a frame's fetch) through its own toString sees
// the native source too. A wrapper of a native function keeps the native
// itself, whose source is read when asked: a frame makes some 600 wrappers,
// and each kept string cost it about 50 bytes it almost never shows
const functionStrings = new WeakMap<Function, string | Function>();
// the realm's own, taken before any hook
const nativeToString = Function.prototype.toString;

/** what a wrapper's toString shows, by its entry in functionStrings */
function sourceOf(entry: string | Function): string {
	return typeof entry === 'string'
		? entry
		: Reflect.apply(nativeToString, entry, []);
}

type Wrap = (target: any, that: any, args: any[], newTarget?: any) => any;
type Shape = (
	key: string,
	fn: Function,
	wrap: Wrap,
	construct: boolean | 'callable',
) => Function;

// taken before any page script runs
const arraySlice = Array.prototype.slice;
/** a function's arguments as an array, with no iterator the page can patch */
const listOf = (args: IArguments): any[] => Reflect.apply(arraySlice, args, []);

/** a call of the wrapper `wrapped` of a constructor `fn` (see wrapFunction) */
function construct_(
	fn: Function,
	wrap: Wrap,
	construct: boolean | 'callable',
	wrapped: Function,
	that: unknown,
	args: any[],
	newTarget: Function | undefined,
) {
	if (construct === true) {
		if (!newTarget) return Reflect.apply(fn, that, args);
		if (args.length < fn.length)
			return Reflect.construct(
				fn,
				args,
				newTarget === wrapped ? fn : newTarget,
			);
	}

	// `this` is never the instance (wrap constructs it from newTarget); a
	// prototype's constructor may be read-only (GeneratorFunction's), so
	// nothing is written to it
	if (construct && newTarget === wrapped) newTarget = fn;

	return wrap(fn, that, args, newTarget);
}

/**
 * Wrappers that read as a native of their name and length: named by a
 * computed key, with that many parameters. Giving a function its `name` or
 * `length` with defineProperty makes V8 keep its properties in a dictionary
 * of its own, about 170 bytes, and a frame makes some 600 wrappers. A call
 * with as many arguments as parameters hands them on as they are (as fast
 * as the rest parameter was), any other reads them from `arguments`. Strict
 * (a class body), so a constructible one has no own `arguments` or
 * `caller`, as a native has not. Indexed by length; a longer native's
 * wrapper is named the slow way.
 */
// a rest parameter would leave the length 0
/* eslint-disable prefer-rest-params */
class Shapes {
	/** not constructible, no `prototype`: a native method's */
	static method: Shape[] = [
		(key, fn, wrap) =>
			({
				[key]() {
					return wrap(
						fn,
						this,
						arguments.length === 0 ? [] : listOf(arguments),
					);
				},
			})[key],
		(key, fn, wrap) =>
			({
				[key](_a: unknown) {
					return wrap(
						fn,
						this,
						arguments.length === 1 ? [_a] : listOf(arguments),
					);
				},
			})[key],
		(key, fn, wrap) =>
			({
				[key](_a: unknown, _b: unknown) {
					return wrap(
						fn,
						this,
						arguments.length === 2 ? [_a, _b] : listOf(arguments),
					);
				},
			})[key],
		(key, fn, wrap) =>
			({
				[key](_a: unknown, _b: unknown, _c: unknown) {
					return wrap(
						fn,
						this,
						arguments.length === 3 ? [_a, _b, _c] : listOf(arguments),
					);
				},
			})[key],
		(key, fn, wrap) =>
			({
				[key](_a: unknown, _b: unknown, _c: unknown, _d: unknown) {
					return wrap(
						fn,
						this,
						arguments.length === 4 ? [_a, _b, _c, _d] : listOf(arguments),
					);
				},
			})[key],
		(key, fn, wrap) =>
			({
				[key](_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown) {
					return wrap(
						fn,
						this,
						arguments.length === 5 ? [_a, _b, _c, _d, _e] : listOf(arguments),
					);
				},
			})[key],
		(key, fn, wrap) =>
			({
				[key](
					_a: unknown,
					_b: unknown,
					_c: unknown,
					_d: unknown,
					_e: unknown,
					_f: unknown,
				) {
					return wrap(
						fn,
						this,
						arguments.length === 6
							? [_a, _b, _c, _d, _e, _f]
							: listOf(arguments),
					);
				},
			})[key],
		(key, fn, wrap) =>
			({
				[key](
					_a: unknown,
					_b: unknown,
					_c: unknown,
					_d: unknown,
					_e: unknown,
					_f: unknown,
					_g: unknown,
				) {
					return wrap(
						fn,
						this,
						arguments.length === 7
							? [_a, _b, _c, _d, _e, _f, _g]
							: listOf(arguments),
					);
				},
			})[key],
	];
	/** constructible, with a `prototype`: a native constructor's */
	static constructor_: Shape[] = [
		(key, fn, wrap, construct) => {
			const wrapped = {
				[key]: function (this: unknown) {
					return construct_(
						fn,
						wrap,
						construct,
						wrapped,
						this,
						arguments.length === 0 ? [] : listOf(arguments),
						new.target,
					);
				},
			}[key];
			return wrapped;
		},
		(key, fn, wrap, construct) => {
			const wrapped = {
				[key]: function (this: unknown, _a: unknown) {
					return construct_(
						fn,
						wrap,
						construct,
						wrapped,
						this,
						arguments.length === 1 ? [_a] : listOf(arguments),
						new.target,
					);
				},
			}[key];
			return wrapped;
		},
		(key, fn, wrap, construct) => {
			const wrapped = {
				[key]: function (this: unknown, _a: unknown, _b: unknown) {
					return construct_(
						fn,
						wrap,
						construct,
						wrapped,
						this,
						arguments.length === 2 ? [_a, _b] : listOf(arguments),
						new.target,
					);
				},
			}[key];
			return wrapped;
		},
		(key, fn, wrap, construct) => {
			const wrapped = {
				[key]: function (this: unknown, _a: unknown, _b: unknown, _c: unknown) {
					return construct_(
						fn,
						wrap,
						construct,
						wrapped,
						this,
						arguments.length === 3 ? [_a, _b, _c] : listOf(arguments),
						new.target,
					);
				},
			}[key];
			return wrapped;
		},
		(key, fn, wrap, construct) => {
			const wrapped = {
				[key]: function (
					this: unknown,
					_a: unknown,
					_b: unknown,
					_c: unknown,
					_d: unknown,
				) {
					return construct_(
						fn,
						wrap,
						construct,
						wrapped,
						this,
						arguments.length === 4 ? [_a, _b, _c, _d] : listOf(arguments),
						new.target,
					);
				},
			}[key];
			return wrapped;
		},
		(key, fn, wrap, construct) => {
			const wrapped = {
				[key]: function (
					this: unknown,
					_a: unknown,
					_b: unknown,
					_c: unknown,
					_d: unknown,
					_e: unknown,
				) {
					return construct_(
						fn,
						wrap,
						construct,
						wrapped,
						this,
						arguments.length === 5 ? [_a, _b, _c, _d, _e] : listOf(arguments),
						new.target,
					);
				},
			}[key];
			return wrapped;
		},
		(key, fn, wrap, construct) => {
			const wrapped = {
				[key]: function (
					this: unknown,
					_a: unknown,
					_b: unknown,
					_c: unknown,
					_d: unknown,
					_e: unknown,
					_f: unknown,
				) {
					return construct_(
						fn,
						wrap,
						construct,
						wrapped,
						this,
						arguments.length === 6
							? [_a, _b, _c, _d, _e, _f]
							: listOf(arguments),
						new.target,
					);
				},
			}[key];
			return wrapped;
		},
		(key, fn, wrap, construct) => {
			const wrapped = {
				[key]: function (
					this: unknown,
					_a: unknown,
					_b: unknown,
					_c: unknown,
					_d: unknown,
					_e: unknown,
					_f: unknown,
					_g: unknown,
				) {
					return construct_(
						fn,
						wrap,
						construct,
						wrapped,
						this,
						arguments.length === 7
							? [_a, _b, _c, _d, _e, _f, _g]
							: listOf(arguments),
						new.target,
					);
				},
			}[key];
			return wrapped;
		},
	];
}
/* eslint-enable prefer-rest-params */

export default class ProxyModule extends Module<Client> {
	functionStrings = functionStrings;
	/** the constructors the page has in place of the realm's own, by the native */
	#standIns = new Map<Function, Function>();
	apply() {
		// what this bundle rewrites keeps its text here, for the hook below
		keepSourcesHere();
		const ownPrototype = this.client.global.Function.prototype;
		// a function of another realm (a same-origin frame that loaded its own
		// copy of the inject): that realm's toString, hooked by its copy, knows
		// its wrappers, which this copy never made. One hop at most: the other
		// realm's hook finds the function its own and answers natively.
		const foreignToString = (that: unknown): Function | null => {
			if (typeof that !== 'function') return null;
			try {
				// the own toString of the nearest prototype that has one, read as a
				// value (a page-defined getter never runs)
				let proto = Reflect.getPrototypeOf(that);
				let toString: unknown;
				while (proto) {
					const own = Reflect.getOwnPropertyDescriptor(proto, 'toString');
					if (own) {
						toString = own.value;
						break;
					}
					proto = Reflect.getPrototypeOf(proto);
				}
				if (!proto || proto === ownPrototype) return null;
				return typeof toString === 'function' &&
					toString !== ownPrototype.toString
					? toString
					: null;
			} catch (error) {
				return null;
			}
		};
		let delegating = false;
		this.client.global.Function.prototype.toString = this.wrapFunction(
			this.client.global.Function.prototype.toString,
			(target, that, args) => {
				const known = this.functionStrings.get(that);
				if (known !== undefined) return sourceOf(known);
				const foreign = delegating ? null : foreignToString(that);
				if (foreign) {
					delegating = true;
					try {
						return Reflect.apply(foreign, that, args);
					} finally {
						delegating = false;
					}
				}
				const string = Reflect.apply(target, that, args);
				// a page's function: its source as the page wrote it, not the
				// rewriter's output (src/functionSource.ts)
				return isNative(string) ? string : (originalSource(string) ?? string);
			},
		);
	}
	bindNatives(target: object, natives: WeakMap<object, object>) {
		const bindNative = <T extends Function>(target: T) =>
			this.wrapFunction(target, (target, that, args) =>
				Reflect.apply(
					target,
					natives.has(that) ? natives.get(that) : that,
					args,
				),
			);

		for (const prop of Object.getOwnPropertyNames(target)) {
			// the stand-in itself (standIn), not a method of the instances
			if (prop === 'constructor') continue;

			const descriptor = Reflect.getOwnPropertyDescriptor(target, prop)!;

			if (!descriptor?.configurable) continue;

			if (descriptor.value) descriptor.value = bindNative(descriptor.value);
			if (descriptor.get) descriptor.get = bindNative(descriptor.get);
			if (descriptor.set) descriptor.set = bindNative(descriptor.set);

			Reflect.defineProperty(target, prop, descriptor);
		}
	}
	mirrorClass(from: any, to: any, instances: WeakSet<any>) {
		Reflect.defineProperty(to.prototype, Symbol.toStringTag, {
			configurable: true,
			enumerable: false,
			writable: false,
			value: from.prototype[Symbol.toStringTag],
		});

		this.mirrorAttributes(from, to);

		const descriptors = Object.getOwnPropertyDescriptors(to.prototype);
		const mirrorDescriptors = Object.getOwnPropertyDescriptors(from.prototype);

		for (const key in descriptors) {
			// the stand-in's own (standIn), not a method of the instances
			if (key === 'constructor') continue;

			const descriptor = descriptors[key];

			const mirrorDescriptor = mirrorDescriptors[key];

			if (!mirrorDescriptor) {
				console.warn('Key not present in global:', key);
				continue;
			}

			if (!descriptor?.configurable) continue;

			if (typeof descriptor.value === 'function')
				mirrorDescriptor.value = this.wrapFunction(
					mirrorDescriptor.value,
					(target, that, args) => {
						if (!instances.has(that)) {
							throw new TypeError('Illegal Invocation');
						}

						return Reflect.apply(descriptor.value, that, args);
					},
				);
			else if ('value' in descriptor) mirrorDescriptor.value = descriptor.value;

			if (typeof descriptor.get === 'function')
				mirrorDescriptor.get = this.wrapFunction(
					mirrorDescriptor.get!,
					(target, that, args) => {
						if (!instances.has(that)) {
							throw new TypeError('Illegal Invocation');
						}

						return Reflect.apply(descriptor.get!, that, args);
					},
				);

			if (typeof descriptor.set === 'function')
				mirrorDescriptor.set = this.wrapFunction(
					mirrorDescriptor.set!,
					(target, that, args) => {
						if (!instances.has(that)) {
							throw new TypeError('Illegal Invocation');
						}

						return Reflect.apply(descriptor.set!, that, args);
					},
				);

			Reflect.defineProperty(to.prototype, key, mirrorDescriptor);
		}
	}
	mirrorAttributes<F extends Function, T extends Function>(from: F, to: T): T {
		this.mirrorSource(from, to);

		Reflect.defineProperty(to, 'length', {
			configurable: true,
			enumerable: false,
			value: from.length,
			writable: false,
		});

		Reflect.defineProperty(to, 'name', {
			configurable: true,
			enumerable: false,
			value: from.name,
			writable: false,
		});

		return to;
	}
	/** `to`'s toString shows `from`'s source */
	mirrorSource(from: Function, to: Function) {
		const known = this.functionStrings.get(from);
		if (known !== undefined) this.functionStrings.set(to, known);
		else {
			const source = from.toString();
			// a native the page has not dressed up reads the same later
			this.functionStrings.set(
				to,
				isNative(source) && source === Reflect.apply(nativeToString, from, [])
					? from
					: source,
			);
		}
	}
	/**
	 * `wrapper` stands in for the realm's constructor `native` (the page's
	 * global is the wrapper) and reads as it does: name, length and source,
	 * the native's own properties in its order with its descriptors (its
	 * statics, such as XMLHttpRequest.DONE, and a `prototype` that is neither
	 * writable, enumerable nor configurable), the page's stand-in for the
	 * native's parent as its prototype (Object.getPrototypeOf(XMLHttpRequest)
	 * is the page's XMLHttpRequestEventTarget) and, unless
	 * `prototypeConstructor` is false (a named constructor such as Audio,
	 * whose prototype is its element's), itself as its prototype's
	 * `constructor`.
	 */
	standIn(wrapper: Function, native: Function, prototypeConstructor = true) {
		this.mirrorAttributes(native, wrapper);
		for (const key of Reflect.ownKeys(wrapper))
			if (
				key !== 'length' &&
				key !== 'name' &&
				key !== 'prototype' &&
				!Reflect.getOwnPropertyDescriptor(native, key)
			)
				Reflect.deleteProperty(wrapper, key);
		for (const key of Reflect.ownKeys(native)) {
			if (key === 'length' || key === 'name') continue;
			const descriptor = Reflect.getOwnPropertyDescriptor(native, key)!;
			if (key === 'prototype')
				Reflect.defineProperty(wrapper, key, {
					...descriptor,
					value: (wrapper as { prototype?: unknown }).prototype,
				});
			else if (!Reflect.getOwnPropertyDescriptor(wrapper, key))
				Reflect.defineProperty(wrapper, key, descriptor);
		}

		// whichever of a constructor and its parent is replaced first
		const parent = Reflect.getPrototypeOf(native) as Function | null;
		Reflect.setPrototypeOf(
			wrapper,
			(parent && this.#standIns.get(parent)) ?? parent,
		);
		for (const [other, otherWrapper] of this.#standIns)
			if (Reflect.getPrototypeOf(other) === native)
				Reflect.setPrototypeOf(otherWrapper, wrapper);
		this.#standIns.set(native, wrapper);

		const prototype = (wrapper as { prototype?: object }).prototype;
		if (prototypeConstructor && prototype) {
			const descriptor = (native as { prototype?: object }).prototype
				? Reflect.getOwnPropertyDescriptor(
						(native as { prototype: object }).prototype,
						'constructor',
					)
				: undefined;
			Reflect.defineProperty(prototype, 'constructor', {
				writable: true,
				enumerable: false,
				configurable: true,
				...descriptor,
				value: wrapper,
			});
		}
	}
	/**
	 * The page's constructor for the realm's `native`, made by the inject's
	 * own class `Mock` (its instances are the Mock's): a stand-in (see
	 * standIn) that leaves the browser's own error to the native, for a call
	 * without `new`, too few arguments, or (`illegal`) an interface only the
	 * browser constructs (XMLHttpRequestEventTarget, Storage).
	 */
	standInClass<T extends Function>(
		Mock: T,
		native: Function,
		illegal = false,
	): T {
		const wrapper = function (this: unknown, ...args: unknown[]) {
			if (!new.target) return Reflect.apply(native, this, args);
			if (illegal || args.length < native.length)
				return Reflect.construct(native, args, new.target);
			return Reflect.construct(Mock, args, new.target);
		};
		wrapper.prototype = Mock.prototype;
		this.standIn(wrapper, native);
		return wrapper as unknown as T;
	}
	/**
	 * `fn` wrapped: the page calls `wrap` where it called `fn`, which reads
	 * as `fn` (mirrorAttributes). `construct`: `fn` is a constructor the page
	 * gets the wrapper for (see standIn); a call without `new` and one with
	 * fewer arguments than it takes get the browser's own error from `fn`
	 * unless it is `'callable'` (Function, which `wrap` handles either way).
	 */
	wrapFunction<T extends Function>(
		fn: T,
		wrap: (target: T, that: any, args: any[], newTarget?: any) => any,
		construct: boolean | 'callable' = false,
	): T {
		const constructible = 'prototype' in fn;
		const { name, length } = fn;
		const shape =
			typeof name === 'string' && typeof length === 'number'
				? (constructible ? Shapes.constructor_ : Shapes.method)[length]
				: undefined;
		let wrapped: Function;
		if (shape) {
			wrapped = shape(name, fn, wrap, construct);
			this.mirrorSource(fn, wrapped);
		} else {
			wrapped = constructible
				? function attach(this: any, ...args: any[]): any {
						return construct_(
							fn,
							wrap,
							construct,
							wrapped,
							this,
							args,
							new.target,
						);
					}
				: {
						attach(this: any, ...args: any[]) {
							return wrap(fn, this, args);
						},
					}.attach;
			this.mirrorAttributes(fn, wrapped);
		}

		if (construct) {
			wrapped.prototype = fn.prototype;
			this.standIn(wrapped, fn);
		}

		return <T>(<unknown>wrapped);
	}
}
