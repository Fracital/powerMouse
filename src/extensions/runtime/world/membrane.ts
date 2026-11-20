// An isolated world's view of the page (docs/extensions.md "Isolated
// worlds"). The world's code runs in a realm of its own (./index.ts), so its
// objects, prototypes and globals are its own, as in Chrome's isolated
// world; the page's objects reach it through this membrane, as Chrome gives
// each world wrappers of its own for one DOM:
// - a platform object of the page's (a node, an event, a window) is a view,
//   one per object, whose prototype chain is the views of the page's
//   prototypes (`instanceof HTMLElement` holds with the world's
//   `HTMLElement`, the view of the page's). Its members are the page's, so
//   every hook of the inject (URLs, cookies, origins) runs as for the page.
//   What the world writes on a node that no member of its takes stays with
//   the view (an expando of one world), and what the page wrote on a node
//   is not seen;
// - a function of the page's is a view that calls it with the world's
//   values made the page's, and makes what comes back the world's;
// - a function of the world's handed to the page is a function of the page's
//   realm that calls it (the browser drops a call into a realm whose frame
//   is gone), an exception it throws while the browser dispatches is
//   reported and goes no further, as Chrome reports one of a world's;
// - data (a dictionary, an array, an event's detail or a message) is copied
//   into the realm it goes to, as Chrome clones a value between worlds, so
//   neither realm holds an object of the other's: no page gets a way into
//   the world's realm, and no world into the page's.
// The page's Trusted Types do not hold for a world (Chrome's isolated
// world has its own policy): a string the world writes to a sink goes as a
// trusted value of the world's own policy, which the page's sink takes as
// any trusted value.
import type { PageSide } from './page';

// the world realm's own, taken as the world's bundle runs there
const {
	apply,
	get,
	set,
	ownKeys,
	getPrototypeOf,
	getOwnPropertyDescriptor,
	defineProperty,
	deleteProperty,
} = Reflect;
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const WorldObjectProto = Object.prototype;
const WorldFunctionProto = Function.prototype;
const WorldPromise = Promise;
const worldThen = Promise.prototype.then;
const objectCreate = Object.create;
const WorldError = Error;
const errors: Record<string, ErrorConstructor> = {
	Error,
	TypeError,
	RangeError,
	SyntaxError,
	ReferenceError,
	EvalError,
	URIError,
};
const arrayPush = Array.prototype.push;
const hasOwn = (object: object, key: PropertyKey) =>
	Object.prototype.hasOwnProperty.call(object, key);
const bind = Function.prototype.bind;
const ArrayBufferProto = ArrayBuffer.prototype;
const SharedArrayBufferProto = (
	globalThis as { SharedArrayBuffer?: { prototype: object } }
).SharedArrayBuffer?.prototype;

/** the world's Trusted Types policy, made while its frame is in the document */
type Trusted = {
	createHTML(text: string): unknown;
	createScript(text: string): unknown;
	createScriptURL(text: string): unknown;
};

/** at most this many values in one copy, and this deep: what is past it goes as a view */
const COPY_LIMIT = 20000;
const COPY_DEPTH = 64;

/** the members that write markup or script, by name, and the arguments that are */
const METHOD_SINKS: Record<string, { at: number | 'all'; kind: 0 | 1 | 2 }> = {
	insertAdjacentHTML: { at: 1, kind: 0 },
	setHTMLUnsafe: { at: 0, kind: 0 },
	parseHTMLUnsafe: { at: 0, kind: 0 },
	write: { at: 'all', kind: 0 },
	writeln: { at: 'all', kind: 0 },
	parseFromString: { at: 0, kind: 0 },
	createContextualFragment: { at: 0, kind: 0 },
};

export type Membrane = ReturnType<typeof createMembrane>;

export function createMembrane(page: PageSide, trusted: Trusted | null) {
	const P = page.window;
	const protos = page.protos;
	// what the world does to the page's objects runs in the page's realm:
	// the browser takes a call's realm for the one a listener, a channel or
	// an observer belongs to, and drops what belongs to the world's
	const R = page.reflect;
	/** page object -> its view */
	const views = new WeakMap<object, object>();
	/** a view's proxy target -> the page's object */
	const realOf = new WeakMap<object, any>();
	/** a view -> the page's object */
	const targets = new WeakMap<object, any>();
	/** what the page holds of the world's (functions, copies) -> the world's own */
	const worldOf = new WeakMap<object, unknown>();
	/** the world's functions -> the page's functions that call them */
	const pageOf = new WeakMap<object, Function>();
	const listenerOf = new WeakMap<object, Function>();
	/** a page function -> the name it was read by (the sinks are known by name) */
	const nameOf = new WeakMap<object, PropertyKey>();
	/** an object a class of the world's made: its view's prototype (construct) */
	const protoOf = new WeakMap<object, object>();
	/** a setter of the page's read from a descriptor -> the property it sets */
	const setterOf = new WeakMap<object, PropertyKey>();
	/** the page's constructors whose first argument is a script's URL (Trusted Types' TrustedScriptURL) */
	const scriptURLConstructors = new Set<unknown>();
	for (const name of ['Worker', 'SharedWorker']) {
		scriptURLConstructors.add(
			(page.original(P) as Record<string, PropertyDescriptor> | undefined)?.[
				name
			]?.value,
		);
		scriptURLConstructors.add(R.get(P, name));
	}
	scriptURLConstructors.delete(undefined);
	/** what a view is: a node (expandos hidden), a window, a document, a named setter's */
	const kindOf = new WeakMap<object, number>();
	/** the world's global, a view of the page's window (./global.ts) */
	let worldGlobal: object | null = null;
	/** the world's error console, told each error reported */
	let onError: ((error: unknown) => void) | null = null;
	/** calls of the page's under way, from the world */
	let depth = 0;

	const KIND_NODE = 1;
	const KIND_WINDOW = 2;
	const KIND_DOCUMENT = 4;
	const KIND_NAMED = 8;
	const KIND_PLATFORM = 16;
	const KIND_SCRIPT = 32;

	function inherits(object: object, proto: object): boolean {
		let at: object | null = object;
		for (let i = 0; at && i < 64; i++) {
			at = getPrototypeOf(at);
			if (at === proto) return true;
		}
		return false;
	}

	function isWindowObject(value: object): boolean {
		try {
			return R.get(value, 'window') === value;
		} catch (error) {
			return false;
		}
	}

	function kind(real: object): number {
		let found = kindOf.get(real);
		if (found !== undefined) return found;
		found = 0;
		if (real === P || isWindowObject(real)) found = KIND_WINDOW | KIND_PLATFORM;
		// an interface's prototype or constructor: its members are no expandos
		else if (page.original(real) || hasOwn(real, 'constructor'))
			found = KIND_PLATFORM;
		else if (inherits(real, protos.Node)) {
			found = KIND_NODE | KIND_PLATFORM;
			if (inherits(real, protos.Document)) found |= KIND_DOCUMENT;
			if (inherits(real, protos.HTMLScriptElement)) found |= KIND_SCRIPT;
			if (
				inherits(real, protos.HTMLSelectElement) ||
				inherits(real, protos.HTMLFormElement)
			)
				found |= KIND_NAMED;
		} else if (
			inherits(real, protos.Storage) ||
			inherits(real, protos.DOMStringMap) ||
			inherits(real, protos.CSSStyleDeclaration) ||
			inherits(real, protos.HTMLOptionsCollection)
		)
			found = KIND_NAMED | KIND_PLATFORM;
		kindOf.set(real, found);
		return found;
	}

	/** whether `value` is the world realm's own */
	function isWorld(value: object): boolean {
		let at: object | null = value;
		for (let i = 0; at && i < 64; i++) {
			if (at === WorldObjectProto || at === WorldFunctionProto) return true;
			at = getPrototypeOf(at);
		}
		return false;
	}

	const isBuffer = (value: object) =>
		isView(value) ||
		inheritsBuffer(value, ArrayBufferProto) ||
		(SharedArrayBufferProto !== undefined &&
			inheritsBuffer(value, SharedArrayBufferProto));
	function inheritsBuffer(value: object, proto: object) {
		// (a buffer of either realm: ArrayBuffer.isView does not say)
		const own = getPrototypeOf(value);
		if (own === proto) return true;
		return (
			own !== null &&
			typeof own === 'object' &&
			get(own, Symbol.toStringTag) === get(proto, Symbol.toStringTag) &&
			get(proto, Symbol.toStringTag) !== undefined
		);
	}

	// ---- the page's values, for the world ----------------------------------

	/** a member of the page's read by its name (a sink's function is known by it) */
	function member(value: unknown, key: PropertyKey): any {
		if (typeof value === 'function' && !nameOf.has(value))
			nameOf.set(value, key);
		return toWorld(value);
	}

	/** what the page is handed for `key`: an event handler property's function reports what it throws */
	function handlerValue(key: PropertyKey, value: unknown): unknown {
		return typeof value === 'function' &&
			typeof key === 'string' &&
			key.startsWith('on')
			? callbackOf(value, true)
			: toPage(value);
	}

	function toWorld(value: unknown): any {
		if (
			value === null ||
			(typeof value !== 'object' && typeof value !== 'function')
		)
			return value;
		if (value === P) return worldGlobal ?? value;
		// the page's roots of every chain are the world's: a node is an Object
		// and an Error of the world's, as a wrapper of its is in Chrome
		if (value === protos.Object) return WorldObjectProto;
		if (value === protos.Function) return WorldFunctionProto;
		if (value === protos.Error) return WorldError.prototype;
		const object = value as object;
		const back = worldOf.get(object);
		if (back !== undefined) return back;
		const view = views.get(object);
		if (view) return view;
		return fromPage(object, new Map(), 0);
	}

	function fromPage(object: object, seen: Map<object, unknown>, at: number) {
		const copied = seen.get(object);
		if (copied !== undefined) return copied;
		if (isWorld(object) || isBuffer(object)) return object;
		if (typeof object === 'function') return viewOf(object);
		const proto = getPrototypeOf(object);
		if (proto === protos.Promise) return promiseFrom(object);
		if (
			at < COPY_DEPTH &&
			seen.size < COPY_LIMIT &&
			(isArray(object) || proto === protos.Object || proto === null) &&
			isData(object)
		)
			return copyIn(object, seen, at);
		if (
			inherits(object, protos.Error) &&
			!inherits(object, protos.DOMException)
		)
			return errorFrom(object);
		return viewOf(object);
	}

	/**
	 * Whether a plain object of the page's is data to copy. An interface's
	 * or a class's prototype is the page's own (its getters would throw for
	 * a copy), and a window or location of another origin has nothing to
	 * read: those are views
	 */
	function isData(object: object) {
		try {
			return !page.original(object) && !hasOwn(object, 'constructor');
		} catch (error) {
			return false;
		}
	}

	function copyIn(object: object, seen: Map<object, unknown>, at: number) {
		if (isArray(object)) {
			const copy: unknown[] = [];
			seen.set(object, copy);
			const length = (object as unknown[]).length;
			for (let i = 0; i < length; i++)
				copy[i] = copyMember((object as unknown[])[i], seen, at);
			return copy;
		}
		const copy: Record<PropertyKey, unknown> =
			getPrototypeOf(object) === null ? objectCreate(null) : {};
		seen.set(object, copy);
		for (const key of ownKeys(object)) {
			const descriptor = getOwnPropertyDescriptor(object, key);
			if (!descriptor?.enumerable) continue;
			copy[key as string] = copyMember(get(object, key), seen, at);
		}
		return copy;
	}

	function copyMember(value: unknown, seen: Map<object, unknown>, at: number) {
		if (
			value === null ||
			(typeof value !== 'object' && typeof value !== 'function')
		)
			return value;
		if (value === P) return worldGlobal ?? value;
		const object = value as object;
		const back = worldOf.get(object);
		if (back !== undefined) return back;
		const view = views.get(object);
		if (view) return view;
		return fromPage(object, seen, at + 1);
	}

	/** a promise of the page's as the world's, settled with the world's values */
	function promiseFrom(promise: object) {
		const made = new WorldPromise((resolve, reject) => {
			R.apply(page.then, promise, [
				page.natives.callback((value: unknown) => resolve(toWorld(value))),
				page.natives.callback((error: unknown) => reject(toWorld(error))),
			]);
		});
		views.set(promise, made);
		worldOf.set(made, made);
		return made;
	}

	/** a JavaScript error of the page's realm (a TypeError a member threw) as the world's */
	function errorFrom(error: object): Error {
		let name = 'Error';
		let message = '';
		let stack: unknown;
		try {
			name = String(get(error, 'name'));
			message = String(get(error, 'message'));
			stack = get(error, 'stack');
		} catch (thrown) {
			// a getter of the page's threw: the error's kind is enough
		}
		const Made = errors[name] ?? WorldError;
		const made = new Made(message);
		if (typeof stack === 'string')
			defineProperty(made, 'stack', {
				value: stack,
				writable: true,
				configurable: true,
			});
		return made;
	}

	function viewOf(real: object): object {
		const found = views.get(real);
		if (found) return found;
		let shadow: object;
		if (typeof real === 'function') {
			// (a constructor's view has a prototype, as its target must)
			// (a bound function has no own prototype, so the target has nothing
			// of its own the page's function has not)
			shadow = getOwnPropertyDescriptor(real, 'prototype')
				? apply(bind, function () {}, [null])
				: () => {};
			// a function's own name and length are its target's to start with
			deleteProperty(shadow, 'name');
			deleteProperty(shadow, 'length');
		} else shadow = objectCreate(null);
		realOf.set(shadow, real);
		const view = new Proxy(shadow, handler);
		views.set(real, view);
		targets.set(view, real);
		return view;
	}

	// ---- the world's values, for the page -----------------------------------

	function toPage(value: unknown): any {
		if (
			value === null ||
			(typeof value !== 'object' && typeof value !== 'function')
		)
			return value;
		if (value === worldGlobal) return P;
		const object = value as object;
		const real = targets.get(object);
		if (real !== undefined) return real;
		const made = pageOf.get(object);
		if (made) return made;
		return intoPage(object, new Map(), 0, true);
	}

	function intoPage(
		object: object,
		seen: Map<object, unknown>,
		at: number,
		top: boolean,
	): unknown {
		const copied = seen.get(object);
		if (copied !== undefined) return copied;
		if (typeof object === 'function') return callbackOf(object as Function);
		if (!isWorld(object)) {
			// a trusted value of the world's policy, a buffer: what the page's
			// members take as they are
			if (top || !isBuffer(object)) return object;
			return clone(object);
		}
		if (getPrototypeOf(object) === WorldPromise.prototype)
			return promiseInto(object as Promise<unknown>);
		if (at >= COPY_DEPTH || seen.size >= COPY_LIMIT) return undefined;
		const proto = getPrototypeOf(object);
		if (isArray(object)) {
			const copy = page.array();
			seen.set(object, copy);
			const length = (object as unknown[]).length;
			for (let i = 0; i < length; i++)
				copy[i] = memberInto((object as unknown[])[i], seen, at);
			return copy;
		}
		if (
			proto === WorldObjectProto ||
			proto === null ||
			isListenerLike(object)
		) {
			const copy = page.object();
			seen.set(object, copy);
			worldOf.set(copy, object);
			for (const key of ownKeys(object)) {
				const descriptor = getOwnPropertyDescriptor(object, key);
				if (!descriptor?.enumerable) continue;
				copy[key] = memberInto(get(object, key), seen, at);
			}
			// a callback interface's method may be on the object's prototype
			for (const key of CALLBACK_MEMBERS)
				if (!(key in copy)) {
					const method = get(object, key);
					if (typeof method === 'function')
						copy[key] = methodOf(method, object);
				}
			return copy;
		}
		// a Map, a Set, a Date, an Error, an instance of a class of the
		// world's: what a structured clone of it is
		return clone(object);
	}

	function memberInto(value: unknown, seen: Map<object, unknown>, at: number) {
		if (
			value === null ||
			(typeof value !== 'object' && typeof value !== 'function')
		)
			return value;
		if (value === worldGlobal) return P;
		const object = value as object;
		const real = targets.get(object);
		if (real !== undefined) return real;
		const made = pageOf.get(object);
		if (made) return made;
		return intoPage(object, seen, at + 1, false);
	}

	function clone(object: object): unknown {
		try {
			return page.natives.structuredClone?.(object);
		} catch (error) {
			return undefined;
		}
	}

	const CALLBACK_MEMBERS = ['handleEvent', 'acceptNode', 'lookupNamespaceURI'];
	const isListenerLike = (object: object) =>
		CALLBACK_MEMBERS.some((key) => typeof get(object, key) === 'function');

	function methodOf(method: Function, owner: object): Function {
		return page.natives.callback(function (this: unknown, ...args: unknown[]) {
			return invoke(method, owner, args, false);
		});
	}

	/** a promise of the world's as the page's */
	function promiseInto(promise: Promise<unknown>) {
		const made = page.promise((resolve, reject) => {
			apply(worldThen, promise, [
				(value: unknown) => resolve(toPage(value)),
				(error: unknown) => reject(toPage(error)),
			]);
		});
		pageOf.set(promise, made as unknown as Function);
		worldOf.set(made, promise);
		return made;
	}

	/**
	 * A world's function as the page's: what the browser calls it with
	 * comes as the world's. An exception the browser's dispatch would see
	 * (an event's listener, an observer's or a timer's callback) is reported
	 * and goes no further, as Chrome reports one of a world's; one inside a
	 * call the world made of the page's (a forEach) goes on to that call.
	 */
	function callbackOf(fn: Function, listener = false): Function {
		const table = listener ? listenerOf : pageOf;
		const found = table.get(fn);
		if (found) return found;
		const made = page.natives.callback(
			function (this: unknown, ...args: unknown[]) {
				return invoke(fn, this, args, listener);
			},
			// (named and sized as the world's function)
			fn,
		);
		table.set(fn, made);
		worldOf.set(made, fn);
		return made;
	}

	function invoke(
		fn: Function,
		that: unknown,
		args: unknown[],
		listener: boolean,
	): unknown {
		const outer = depth;
		depth = 0;
		try {
			const worldArgs: unknown[] = [];
			for (let i = 0; i < args.length; i++)
				apply(arrayPush, worldArgs, [toWorld(args[i])]);
			return toPage(apply(fn, toWorld(that), worldArgs));
		} catch (error) {
			if (outer > 0 && !listener) throw toPage(error);
			report(error);
			return undefined;
		} finally {
			depth = outer;
		}
	}

	function report(error: unknown) {
		try {
			onError?.(error);
		} catch (thrown) {
			// the error console's trouble is none of the script's
		}
		try {
			// (a page's error, a DOMException say, as itself: no view's Proxy)
			page.natives.console.error(
				(error !== null && typeof error === 'object' && targets.get(error)) ||
					error,
			);
		} catch (thrown) {
			// nothing to report to
		}
	}

	// ---- the page's calls, from the world ------------------------------------

	/** a string for a sink of markup or script, as a trusted value of the world's */
	function sinkValue(value: unknown, sink: 0 | 1 | 2): unknown {
		if (typeof value !== 'string' || !trusted) return value;
		try {
			return sink === 0
				? trusted.createHTML(value)
				: sink === 1
					? trusted.createScript(value)
					: trusted.createScriptURL(value);
		} catch (error) {
			return value;
		}
	}

	/** what Trusted Types call a property of `real`, by name */
	function propertySink(real: object, key: PropertyKey): 0 | 1 | 2 | -1 {
		if (key === 'innerHTML' || key === 'outerHTML' || key === 'srcdoc')
			return 0;
		if (kind(real) & KIND_SCRIPT) {
			if (key === 'text' || key === 'textContent' || key === 'innerText')
				return 1;
			if (key === 'src') return 2;
		}
		return -1;
	}

	/** what Trusted Types call an attribute of an element */
	function attributeSink(element: object, name: unknown): 0 | 1 | 2 | -1 {
		const attribute = String(name).toLowerCase();
		if (attribute.startsWith('on')) return 1;
		let local: string;
		try {
			local = page.localName(element);
		} catch (error) {
			return -1;
		}
		if (
			local === 'script' &&
			(attribute === 'src' ||
				attribute === 'href' ||
				attribute === 'xlink:href')
		)
			return 2;
		if (local === 'iframe' && attribute === 'srcdoc') return 0;
		if (
			(local === 'embed' && attribute === 'src') ||
			(local === 'object' && (attribute === 'data' || attribute === 'codebase'))
		)
			return 2;
		return -1;
	}

	function pageArgs(fn: object, that: unknown, args: unknown[]): unknown[] {
		const made: unknown[] = page.array();
		const name = nameOf.get(fn);
		const listener =
			name === 'addEventListener' || name === 'removeEventListener';
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			made[i] =
				listener && i === 1 && arg !== null && typeof arg === 'object'
					? listenerInto(arg)
					: listener && i === 1 && typeof arg === 'function'
						? callbackOf(arg, true)
						: toPage(arg);
		}
		const setter = setterOf.get(fn);
		if (setter !== undefined && typeof that === 'object' && that !== null) {
			// a setter called for itself (a descriptor's `set.call(node, html)`)
			const sink = propertySink(that, setter);
			if (sink >= 0) made[0] = sinkValue(made[0], sink as 0 | 1 | 2);
			else if (typeof setter === 'string' && setter.startsWith('on'))
				made[0] = handlerValue(setter, args[0]);
			return made;
		}
		if (typeof name !== 'string') return made;
		const real = that as object;
		const sink = METHOD_SINKS[name];
		if (sink) {
			const fits =
				name === 'write' || name === 'writeln'
					? typeof real === 'object' &&
						real !== null &&
						inherits(real, protos.Document)
					: name === 'parseFromString'
						? typeof real === 'object' &&
							real !== null &&
							inherits(real, protos.DOMParser)
						: name === 'createContextualFragment'
							? typeof real === 'object' &&
								real !== null &&
								inherits(real, protos.Range)
							: true;
			if (fits)
				for (let i = 0; i < made.length; i++)
					if (sink.at === 'all' || sink.at === i)
						made[i] = sinkValue(made[i], sink.kind);
		} else if (
			(name === 'setAttribute' || name === 'setAttributeNS') &&
			typeof real === 'object' &&
			real !== null &&
			inherits(real, protos.Element)
		) {
			const at = name === 'setAttribute' ? 0 : 1;
			const type = attributeSink(real, made[at]);
			if (type >= 0) made[at + 1] = sinkValue(made[at + 1], type as 0 | 1 | 2);
		}
		return made;
	}

	/** an EventListener object of the world's: the page calls its handleEvent */
	function listenerInto(listener: object): unknown {
		const real = targets.get(listener);
		if (real !== undefined) return real;
		const found = listenerOf.get(listener);
		if (found) return found;
		const made = page.natives.callback(function (
			this: unknown,
			event: unknown,
		) {
			const handle = get(listener, 'handleEvent');
			if (typeof handle !== 'function') return undefined;
			return invoke(handle, listener, [event], true);
		});
		listenerOf.set(listener, made);
		worldOf.set(made, listener);
		return made;
	}

	function enter<T>(run: () => T): T {
		depth++;
		try {
			return run();
		} catch (error) {
			throw toWorld(error);
		} finally {
			depth--;
		}
	}

	/** the value of `real`'s own property `key`, unless it is an expando the page wrote on a node */
	function hidden(real: object, key: PropertyKey, flags: number): boolean {
		// (a form's or a select's named and indexed members look as one)
		if (!(flags & KIND_NODE) || flags & KIND_NAMED || typeof key !== 'string')
			return false;
		const descriptor = R.getOwnPropertyDescriptor(real, key);
		return (
			!!descriptor &&
			'value' in descriptor &&
			!!descriptor.writable &&
			!!descriptor.enumerable &&
			!!descriptor.configurable
		);
	}

	/**
	 * An object's own property as the world finds it: as the page's
	 * snapshot kept it, for an interface's prototype or the window (what
	 * the page and its MAIN world changed later is theirs alone), else as it
	 * is
	 */
	function ownOf(
		object: object,
		key: PropertyKey,
	): PropertyDescriptor | undefined {
		const kept = page.original(object);
		if (kept) return hasOwn(kept, key) ? kept[key as string] : undefined;
		return R.getOwnPropertyDescriptor(object, key);
	}

	/** the keys of an object's own properties as the world finds them */
	const keysOf = (object: object) => {
		const kept = page.original(object);
		return R.ownKeys(kept ?? object);
	};

	/** a property as the page's members find it, past an expando of the page's */
	function lookup(
		real: object,
		key: PropertyKey,
		flags: number,
	): PropertyDescriptor | undefined {
		let at: object | null = hidden(real, key, flags)
			? getPrototypeOf(real)
			: real;
		for (let i = 0; at && i < 64; i++) {
			const descriptor = ownOf(at, key);
			if (descriptor) return descriptor;
			at = getPrototypeOf(at);
		}
		return undefined;
	}

	/** whether no member says what `key` of `real` is: a named or an indexed property, the page's, or an exotic object's */
	const exotic = (flags: number) =>
		!!(flags & KIND_NAMED) || !(flags & KIND_PLATFORM);

	/** a window's or a document's `location` and a window's `top`, which no hook of the page's can take */
	function unforgeable(real: object, key: PropertyKey, flags: number) {
		if (key === 'location' && flags & (KIND_WINDOW | KIND_DOCUMENT)) {
			const access = page.access();
			if (access) return { value: access.get2(real, 'location') };
		}
		if (key === 'top' && flags & KIND_WINDOW) {
			const access = page.access();
			if (access) return { value: access.get2(real, 'top') };
		}
		return null;
	}

	/**
	 * A member's getter called for `that`. An object the inject hands the
	 * page as a Proxy of a platform object (a style declaration, a mutation
	 * record it reshapes, a Storage) is no receiver its getters take: its
	 * traps say what it reads
	 */
	function viaGetter(getter: Function, that: object, key: PropertyKey) {
		try {
			return R.apply(getter, that, []);
		} catch (error) {
			if (
				typeof error !== 'object' ||
				error === null ||
				R.get(error, 'name') !== 'TypeError'
			)
				throw error;
			return R.get(that, key, that);
		}
	}

	const handler: ProxyHandler<any> = {
		get(shadow, key, receiver) {
			if (getOwnPropertyDescriptor(shadow, key))
				return get(shadow, key, receiver);
			const real = realOf.get(shadow);
			const flags = kind(real);
			const override = protoOf.get(real);
			if (override !== undefined && key !== '__proto__')
				return get(override, key, receiver);
			// (a prototype's view read for an instance: the instance's getter call)
			const that = targets.get(receiver) ?? real;
			return enter(() => {
				const special = unforgeable(real, key, flags);
				if (special) return toWorld(special.value);
				const descriptor = lookup(real, key, flags);
				if (!descriptor)
					return exotic(flags)
						? member(R.get(real, key, that), key)
						: undefined;
				const value =
					'value' in descriptor
						? descriptor.value
						: descriptor.get
							? viaGetter(descriptor.get, that, key)
							: undefined;
				return member(value, key);
			});
		},
		set(shadow, key, value, receiver) {
			const real = realOf.get(shadow);
			if (receiver !== views.get(real))
				return defineProperty(receiver, key, {
					value,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			if (getOwnPropertyDescriptor(shadow, key))
				return set(shadow, key, value, receiver);
			const flags = kind(real);
			return enter(() => {
				if (key === 'location' && flags & (KIND_WINDOW | KIND_DOCUMENT)) {
					const access = page.access();
					if (access) {
						access.set2(
							real,
							'location',
							(target, name, given) => (target[name] = given),
							toPage(value),
						);
						return true;
					}
				}
				const sink = propertySink(real, key);
				const given =
					sink >= 0
						? sinkValue(toPage(value), sink as 0 | 1 | 2)
						: handlerValue(key, value);
				if (!(flags & KIND_PLATFORM) || flags & KIND_NAMED)
					return R.set(real, key, given);
				const descriptor = lookup(real, key, flags);
				if (descriptor && 'set' in descriptor) {
					if (!descriptor.set) return false;
					R.apply(descriptor.set, real, [given]);
					return true;
				}
				if (descriptor && ownOf(real, key) === undefined)
					// (a method or a constant of a prototype: an own property of the
					// world's, as an assignment of one makes on a wrapper)
					return defineProperty(shadow, key, {
						value,
						writable: true,
						enumerable: true,
						configurable: true,
					});
				if (descriptor && !hidden(real, key, flags))
					return R.set(real, key, toPage(value));
				return defineProperty(shadow, key, {
					value,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			});
		},
		has(shadow, key) {
			if (getOwnPropertyDescriptor(shadow, key)) return true;
			const real = realOf.get(shadow);
			const flags = kind(real);
			return (
				lookup(real, key, flags) !== undefined ||
				(exotic(flags) && R.has(real, key))
			);
		},
		deleteProperty(shadow, key) {
			if (getOwnPropertyDescriptor(shadow, key))
				return deleteProperty(shadow, key);
			const real = realOf.get(shadow);
			const flags = kind(real);
			if (!(flags & KIND_PLATFORM) || flags & KIND_NAMED)
				return enter(() => R.deleteProperty(real, key));
			return true;
		},
		defineProperty(shadow, key, descriptor) {
			const real = realOf.get(shadow);
			const flags = kind(real);
			if (!(flags & KIND_PLATFORM) || flags & KIND_NAMED)
				return enter(() =>
					R.defineProperty(real, key, pageDescriptor(descriptor)),
				);
			return defineProperty(shadow, key, descriptor);
		},
		getOwnPropertyDescriptor(shadow, key) {
			const own = getOwnPropertyDescriptor(shadow, key);
			if (own) return own;
			const real = realOf.get(shadow);
			const flags = kind(real);
			if (hidden(real, key, flags)) return undefined;
			const descriptor = enter(() => ownOf(real, key));
			if (!descriptor) return undefined;
			const made = worldDescriptor(descriptor, key);
			// (one the page cannot change is the target's too, as a proxy's must be)
			if (!descriptor.configurable) {
				defineProperty(shadow, key, made);
				return getOwnPropertyDescriptor(shadow, key);
			}
			return made;
		},
		ownKeys(shadow) {
			const real = realOf.get(shadow);
			const flags = kind(real);
			const keys: (string | symbol)[] = [];
			const seen = new Set<string | symbol>();
			for (const key of ownKeys(shadow)) {
				seen.add(key);
				keys.push(key);
			}
			for (const key of enter(() => keysOf(real))) {
				if (seen.has(key) || hidden(real, key, flags)) continue;
				const descriptor = ownOf(real, key);
				if (descriptor && !descriptor.configurable) {
					defineProperty(shadow, key, worldDescriptor(descriptor, key));
				}
				keys.push(key);
			}
			return keys;
		},
		getPrototypeOf(shadow) {
			const real = realOf.get(shadow);
			const override = protoOf.get(real);
			if (override !== undefined) return override;
			const proto = getPrototypeOf(real);
			return proto === null ? null : toWorld(proto);
		},
		setPrototypeOf() {
			return false;
		},
		isExtensible() {
			return true;
		},
		preventExtensions() {
			return false;
		},
		apply(shadow, that, args) {
			const real = realOf.get(shadow);
			return enter(() => {
				const pageThis = toPage(that);
				return toWorld(R.apply(real, pageThis, pageArgs(real, pageThis, args)));
			});
		},
		construct(shadow, args, newTarget) {
			const real = realOf.get(shadow);
			return enter(() => {
				const own = targets.get(newTarget);
				const made = pageArgs(real, undefined, args);
				if (scriptURLConstructors.has(real) && made.length)
					made[0] = sinkValue(made[0], 2);
				if (own !== undefined) return toWorld(R.construct(real, made, own));
				// a class of the world's that extends one of the page's (an
				// EventTarget of its own): the page's object, whose view has the
				// class's prototype
				const instance = R.construct(real, made);
				const proto: unknown = get(newTarget, 'prototype');
				if (proto !== null && typeof proto === 'object')
					protoOf.set(instance as object, proto);
				return toWorld(instance);
			});
		},
	};

	function worldDescriptor(
		descriptor: PropertyDescriptor,
		key: PropertyKey,
	): PropertyDescriptor {
		const made: PropertyDescriptor = {
			enumerable: descriptor.enumerable,
			configurable: descriptor.configurable,
		};
		if ('value' in descriptor) {
			made.value = toWorld(descriptor.value);
			made.writable = descriptor.writable;
		} else {
			made.get = descriptor.get ? toWorld(descriptor.get) : undefined;
			if (descriptor.set && !setterOf.has(descriptor.set))
				setterOf.set(descriptor.set, key);
			made.set = descriptor.set ? toWorld(descriptor.set) : undefined;
		}
		return made;
	}

	function pageDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
		const made = page.object() as PropertyDescriptor;
		if ('enumerable' in descriptor) made.enumerable = descriptor.enumerable;
		if ('configurable' in descriptor)
			made.configurable = descriptor.configurable;
		if ('writable' in descriptor) made.writable = descriptor.writable;
		if ('value' in descriptor) made.value = toPage(descriptor.value);
		if ('get' in descriptor) made.get = toPage(descriptor.get);
		if ('set' in descriptor) made.set = toPage(descriptor.set);
		return made;
	}

	return {
		toWorld,
		toPage,
		member,
		enter,
		ownOf,
		/** `real[key]` as the world reads it, a value of the world's */
		read: (real: object, key: PropertyKey): unknown =>
			enter(() => {
				const descriptor = lookup(real, key, kind(real));
				if (!descriptor) return member(R.get(real, key), key);
				return member(
					'value' in descriptor
						? descriptor.value
						: descriptor.get && R.apply(descriptor.get, real, []),
					key,
				);
			}),
		/** set the world's global, which the page's window is in the world */
		useGlobal(global: object) {
			worldGlobal = global;
			worldOf.set(P, global);
		},
		/** a page's function that calls a world's, for the page's members to take */
		callbackOf,
		/** a world's function as the browser calls it (its exceptions reported) */
		listenerOf: (fn: Function) => callbackOf(fn, true),
		report,
		/** who hears what is reported (the world's error console) */
		set onError(listener: ((error: unknown) => void) | null) {
			onError = listener;
		},
		/** whether the world is inside a call of the page's */
		get depth() {
			return depth;
		},
	};
}
