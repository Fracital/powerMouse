import { keepSourcesHere, originalSource } from '../../functionSource';
import Client from '../Client';
import Module from '../Module';
import { isNative } from '../nativeUtil';
import { LazyWeakMap } from '../ownCollections';

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
	// the hooks work (a non-configurable one cannot be, and stays). An
	// interface's prototype object is no such element: a hook called on
	// Element.prototype itself set its constructor and @@toStringTag aside
	// and back, which listed them after the rest (@@toStringTag after
	// @@unscopables) once a page had called a hooked method on it
	let hidden: [key: string | symbol, descriptor: PropertyDescriptor][] | null =
		null;
	if (!isInterfacePrototype(target))
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
		Reflect.apply(cleanup, target, []);
	}

	if (result.length === 2) {
		throw result[1];
	}

	return result[0];
}

/** whether `object` is the prototype its own `constructor` names (read as data, no getter run) */
function isInterfacePrototype(object: object): boolean {
	const constructor = Reflect.getOwnPropertyDescriptor(
		object,
		'constructor',
	)?.value;
	return (
		typeof constructor === 'function' &&
		Reflect.getOwnPropertyDescriptor(constructor, 'prototype')?.value === object
	);
}

/** an event handler attribute's name (`onclick`, `onpagereveal`) */
const HANDLER_NAME = /^on[a-z]+$/;

/**
 * Copy `from`'s own members onto `target`: a copy of a native prototype,
 * made as the bundle loads, that the hooks read the browser's members from
 * (usePrototype, nativeGetter) whatever the page does to the real one. The
 * event handler attributes are left out: no hook reads a handler through a
 * copy, and reading their descriptors made the getter and setter of every
 * handler of Element, HTMLElement and SVGElement (some 300) in every frame,
 * which no native frame makes until its page reads one (about 19 KB a
 * frame, frame-cost)
 */
export function applyDescriptors(target: object, from: object): void {
	for (const key of Reflect.ownKeys(from)) {
		if (typeof key === 'string' && HANDLER_NAME.test(key)) continue;
		Reflect.defineProperty(
			target,
			key,
			Reflect.getOwnPropertyDescriptor(from, key)!,
		);
	}
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
	// the prototype's copy can still be moved: mirrorClass lists the
	// prototype's members in the browser's order, with its descriptors
	Reflect.defineProperty(target.prototype, key, {
		...descriptor,
		configurable: true,
	});
}

export function onEventTarget(target: any, event: string) {
	const property = `on${event}`;
	const listeners = new LazyWeakMap();

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
 * The member a native function of a prototype is, by its name: a method's
 * is its key, an accessor's (`get status`, `set src`) is its key after the
 * prefix. A hook that wraps several members with one call reads which one
 * it was called as from the native it wraps (a call of its own for each
 * member was a closure and its scope in every frame).
 */
export function memberName(target: Function): string {
	const name: string = target.name;
	return name.startsWith('get ') || name.startsWith('set ')
		? name.slice(4)
		: name;
}

/**
 * The message of the browser's error for a call with too few arguments, as
 * Blink words it ("1 argument required", "2 arguments required").
 */
export function requiredArgumentsMessage(
	args: number,
	requiredArguments: number,
	on: string,
	api: string,
): string {
	const message = `${
		requiredArguments === 1 ? '1 argument' : `${requiredArguments} arguments`
	} required, but only ${args} present.`;
	return api === 'constructor'
		? `Failed to construct '${on}': ${message}`
		: `Failed to execute '${api}' on '${on}': ${message}`;
}

/**
 * Throws the browser's error for a call with too few arguments: a TypeError
 * of `realm` (the realm of the function called, the bundle's when not given).
 * @example
 * catchRequiredArguments([].length, 1, "Window", "fetch"); // TypeError: Failed to execute 'fetch' on 'Window': 1 argument required, but only 0 present.
 */
export function catchRequiredArguments(
	args: number,
	requiredArguments: number,
	on: string,
	api: string,
	realm: { TypeError: TypeErrorConstructor } = globalThis,
) {
	if (args < requiredArguments)
		throw new realm.TypeError(
			requiredArgumentsMessage(args, requiredArguments, on, api),
		);
}

/**
 * The object `key` is an own property of: `target`, or the prototype above
 * it that has it. A window's functions are its own, a worker's are its
 * scope's prototypes' (WorkerGlobalScope.prototype.fetch), and a hook that
 * assigned to the global made the worker's an own property of the global,
 * which a page that lists the global's keys reads.
 */
export function ownerOf<T extends object>(target: T, key: PropertyKey): T {
	for (
		let owner: object | null = target;
		owner;
		owner = Reflect.getPrototypeOf(owner)
	)
		if (Reflect.getOwnPropertyDescriptor(owner, key)) return owner as T;
	return target;
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
// and each kept string cost it about 50 bytes it almost never shows.
// The table is asked through WeakMap's own get and set, bound to it as the
// bundle loads: a page that replaced WeakMap.prototype.get was called with
// the table at its first read of a hooked function's source, and read every
// native out of it. (Bound, not an OwnWeakMap, which asks the natives
// through methods of its own: with one, a frame of frame-cost was about
// 4 KB larger.)
const stringsTable = new WeakMap<Function, string | Function>();
const functionStrings = {
	get: Reflect.apply(Function.prototype.bind, WeakMap.prototype.get, [
		stringsTable,
	]) as (key: unknown) => string | Function | undefined,
	set: Reflect.apply(Function.prototype.bind, WeakMap.prototype.set, [
		stringsTable,
	]) as (key: Function, value: string | Function) => unknown,
};
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
	/**
	 * The Function.prototype and Object.prototype of the realm this client
	 * hooks when it is not the bundle's own: a frame its parent read before
	 * it loaded has the parent's bundle for its hooks, and every function
	 * the bundle makes is the parent realm's. Null in the bundle's own realm.
	 */
	#foreign: { function: object; object: object } | null | undefined;
	#foreignRealm() {
		if (this.#foreign === undefined) {
			const global = this.client.global;
			// (read from natives the page cannot have replaced yet, and that
			// no module replaces: a constructor's prototype is its realm's
			// Function.prototype)
			const realm = Reflect.getPrototypeOf(global.Object) as object;
			this.#foreign =
				realm === Function.prototype
					? null
					: { function: realm, object: global.Object.prototype };
		}
		return this.#foreign;
	}
	/**
	 * `value` (a function, or an object and the functions it holds) made
	 * the hooked realm's to look at, where that is not the bundle's own: a
	 * function made here is the bundle realm's, with that realm's
	 * Function.prototype above it, so in a frame the parent's bundle hooked
	 * `frame.fetch instanceof frame.Function` was false, and
	 * `frame.fetch.constructor` was the parent's Function, which makes code
	 * for the parent's window. Its prototype is the hooked realm's instead.
	 */
	adopt<T extends object>(value: T): T {
		const foreign = this.#foreignRealm();
		if (!foreign) return value;
		if (typeof value === 'function') {
			Reflect.setPrototypeOf(value, foreign.function);
			return value;
		}
		Reflect.setPrototypeOf(value, foreign.object);
		for (const key of Reflect.ownKeys(value)) {
			const member = Reflect.getOwnPropertyDescriptor(value, key)?.value;
			if (typeof member === 'function')
				Reflect.setPrototypeOf(member, foreign.function);
		}
		return value;
	}
	/** the constructors the page has in place of the realm's own, by the native */
	#standIns = new Map<Function, Function>();
	apply() {
		const global = this.client.global;
		// what this bundle rewrites keeps its text here, for the hook below
		keepSourcesHere();
		const ownPrototype = global.Function.prototype;
		// a function of another realm (a same-origin frame that loaded its own
		// copy of the inject): that realm's toString, hooked by its copy, knows
		// its wrappers, which this copy never made. One hop at most: the other
		// realm's hook finds the function its own and answers natively.
		const foreignToString = (that: unknown): Function | null => {
			if (typeof that !== 'function') return null;
			try {
				// its realm's Function.prototype: the last function on its
				// prototype chain (a class's parent is a function too, and may
				// have a toString of the page's, which the native never calls;
				// Function.prototype itself, or a function given a plain object
				// for a prototype, has none and is answered natively)
				let proto = Reflect.getPrototypeOf(that);
				let functionPrototype: object | null = null;
				while (proto) {
					if (typeof proto === 'function') functionPrototype = proto;
					proto = Reflect.getPrototypeOf(proto);
				}
				if (!functionPrototype || functionPrototype === ownPrototype)
					return null;
				// its own toString, read as a value (a page-defined getter
				// never runs)
				const toString: unknown = Reflect.getOwnPropertyDescriptor(
					functionPrototype,
					'toString',
				)?.value;
				return typeof toString === 'function' &&
					toString !== ownPrototype.toString
					? toString
					: null;
			} catch (error) {
				return null;
			}
		};
		let delegating = false;
		global.Function.prototype.toString = this.wrapFunction(
			global.Function.prototype.toString,
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
	/**
	 * The stand-in class `to` reads as the realm's `from`: its prototype
	 * lists the native prototype's members in the native order with the
	 * native descriptors, each function a wrapper of the native one that
	 * runs the stand-in's. A member the stand-in does not have is the
	 * native's own. A call on anything but an instance of the stand-in is
	 * the browser's to answer (the native, called as the page called it:
	 * its Illegal invocation, thrown or as a rejected promise, with its
	 * message), and so is a call with fewer arguments than the native takes
	 * (its wording, as a TypeError of this realm).
	 */
	mirrorClass(from: any, to: any, instances: { has(value: unknown): boolean }) {
		const native = from.prototype as object;
		const mock = to.prototype as object;
		const realm = this.client.global;
		const own = new Map<PropertyKey, PropertyDescriptor>();
		for (const key of Reflect.ownKeys(mock)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(mock, key)!;
			own.set(key, descriptor);
			if (descriptor.configurable) Reflect.deleteProperty(mock, key);
		}
		// the stand-in's member each native runs, and the one call every
		// wrapper makes: a call of its own for each member was a closure and
		// its scope, some 50 bytes of every frame for each of some 70 members.
		// A member's key is its native's name (`open`, `get status`).
		const mines = new LazyWeakMap<Function, Function>();
		const call = (target: Function, that: unknown, args: unknown[]) => {
			if (!instances.has(that)) return Reflect.apply(target, that, args);
			if (args.length < target.length)
				catchRequiredArguments(
					args.length,
					target.length,
					from.name,
					memberName(target),
					realm,
				);
			return Reflect.apply(mines.get(target)!, that, args);
		};
		const mirror = <T extends Function>(
			nativeFn: T,
			mine: Function,
			key: string,
		): T => {
			// (a native that is two members, each its own call)
			if (mines.has(nativeFn))
				return this.wrapFunction(nativeFn, (target, that, args) => {
					if (!instances.has(that)) return Reflect.apply(target, that, args);
					catchRequiredArguments(
						args.length,
						target.length,
						from.name,
						key,
						realm,
					);
					return Reflect.apply(mine, that, args);
				});
			mines.set(nativeFn, mine);
			return this.wrapFunction(nativeFn, call);
		};
		for (const key of Reflect.ownKeys(native)) {
			const nativeDescriptor = Reflect.getOwnPropertyDescriptor(native, key)!;
			const mine = own.get(key);
			own.delete(key);
			if (key === 'constructor') {
				// the stand-in itself (standIn)
				if (mine) Reflect.defineProperty(mock, key, mine);
				continue;
			}
			if (!mine || typeof key === 'symbol') {
				Reflect.defineProperty(mock, key, nativeDescriptor);
				continue;
			}
			// one that cannot be moved stays as and where it is
			if (!mine.configurable) continue;
			const mirrored = { ...nativeDescriptor };
			if ('value' in nativeDescriptor) {
				if (
					typeof mine.value === 'function' &&
					typeof nativeDescriptor.value === 'function'
				)
					mirrored.value = mirror(nativeDescriptor.value, mine.value, key);
			} else {
				if (typeof mine.get === 'function' && nativeDescriptor.get)
					mirrored.get = mirror(nativeDescriptor.get, mine.get, key);
				if (typeof mine.set === 'function' && nativeDescriptor.set)
					mirrored.set = mirror(nativeDescriptor.set, mine.set, key);
			}
			Reflect.defineProperty(mock, key, mirrored);
		}
		// what only the stand-in has, after the native's
		for (const [key, descriptor] of own)
			if (descriptor.configurable)
				Reflect.defineProperty(mock, key, descriptor);
		// The prototype above it is the one above the native's (the page's
		// stand-in for that interface, where it has one): the stand-in is a
		// class of the bundle's, whose prototype had the bundle realm's
		// Object.prototype or EventTarget.prototype above it, another
		// realm's in a frame the parent's bundle hooks.
		const above = Reflect.getPrototypeOf(native);
		const aboveConstructor =
			above && Reflect.getOwnPropertyDescriptor(above, 'constructor')?.value;
		const standIn =
			typeof aboveConstructor === 'function'
				? this.#standIns.get(aboveConstructor)
				: undefined;
		const wanted =
			(standIn as { prototype?: object } | undefined)?.prototype ?? above;
		if (Reflect.getPrototypeOf(mock) !== wanted)
			Reflect.setPrototypeOf(mock, wanted);
	}
	/**
	 * `target`'s own properties listed in the order `native` lists the same
	 * keys, then any of its own: a stand-in prototype is built member by
	 * member, in the order the code defines them, and a page that lists it
	 * reads the order.
	 */
	orderLike(target: object, native: object) {
		const order = Reflect.ownKeys(native);
		const own = Reflect.ownKeys(target);
		const wanted = [
			...order.filter((key) => own.includes(key)),
			...own.filter((key) => !order.includes(key)),
		];
		if (wanted.every((key, index) => key === own[index])) return;
		const descriptors = wanted.map(
			(key) => [key, Reflect.getOwnPropertyDescriptor(target, key)!] as const,
		);
		// only what can be put back is taken out
		if (descriptors.some(([, descriptor]) => !descriptor.configurable)) return;
		for (const [key] of descriptors) Reflect.deleteProperty(target, key);
		for (const [key, descriptor] of descriptors)
			Reflect.defineProperty(target, key, descriptor);
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

		// (a constructor's place in its realm is the native's: standIn)
		if (construct) {
			wrapped.prototype = fn.prototype;
			this.standIn(wrapped, fn);
		} else this.adopt(wrapped);

		return <T>(<unknown>wrapped);
	}
}
