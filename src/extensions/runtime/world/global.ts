// An isolated world's global (docs/extensions.md "Isolated worlds"). The
// world's realm is an about:blank frame's, taken out of the document once
// it is made, so what its window has of the web is gone with the frame; its
// JavaScript (Object, Array, Promise, eval) stays, and is the world's own.
// Every web name of the realm's window (setTimeout, fetch, Element,
// MutationObserver, innerWidth) becomes an accessor of the window's own,
// and the first use of one makes it the page's through the membrane: a
// function or an interface as a view, an attribute as an accessor of the
// page's window. (The window's prototype chain is immutable, so no
// resolver can sit behind it.) Names the world sets are its own
// (`window.x = 1` in a world is no global of the page's, and the page's
// globals are none of the world's), as in Chrome. The unforgeable four
// (window, document, location, top) cannot be redefined, so a script runs
// in a `with` scope that answers them (./index.ts), and its `window`,
// `self`, `globalThis` and `frames` are this module's proxy of the realm's
// window, which answers those as the page's.
import type { Membrane } from './membrane';
import type { PageSide } from './page';

const {
	get,
	set,
	has,
	ownKeys,
	getPrototypeOf,
	setPrototypeOf,
	getOwnPropertyDescriptor,
	defineProperty,
	deleteProperty,
	apply,
} = Reflect;

/** the realm's own JavaScript globals: what stays the world's */
const SCRIPT_GLOBALS = new Set([
	'globalThis',
	'Infinity',
	'NaN',
	'undefined',
	'eval',
	'isFinite',
	'isNaN',
	'parseFloat',
	'parseInt',
	'decodeURI',
	'decodeURIComponent',
	'encodeURI',
	'encodeURIComponent',
	'escape',
	'unescape',
	'AggregateError',
	'Array',
	'ArrayBuffer',
	'AsyncDisposableStack',
	'Atomics',
	'BigInt',
	'BigInt64Array',
	'BigUint64Array',
	'Boolean',
	'DataView',
	'Date',
	'DisposableStack',
	'Error',
	'EvalError',
	'FinalizationRegistry',
	'Float16Array',
	'Float32Array',
	'Float64Array',
	'Function',
	'Int8Array',
	'Int16Array',
	'Int32Array',
	'Intl',
	'Iterator',
	'JSON',
	'Map',
	'Math',
	'Number',
	'Object',
	'Promise',
	'Proxy',
	'RangeError',
	'ReferenceError',
	'Reflect',
	'RegExp',
	'Set',
	'SharedArrayBuffer',
	'String',
	'SuppressedError',
	'Symbol',
	'SyntaxError',
	'Temporal',
	'TypeError',
	'Uint8Array',
	'Uint8ClampedArray',
	'Uint16Array',
	'Uint32Array',
	'URIError',
	'WeakMap',
	'WeakRef',
	'WeakSet',
]);

/** EventTarget's members, which the window's chain answers free names from */
const TARGET_MEMBERS = [
	'addEventListener',
	'removeEventListener',
	'dispatchEvent',
	'when',
];

/** the names the global answers as the page's (window, self, globalThis, frames are the world's proxy) */
const OWN_GLOBAL = new Set(['window', 'self', 'globalThis', 'frames']);

/**
 * Make the realm's window, `realm`, the world's global (while its frame is
 * still in the document), and return the proxy its code knows as `window`
 */
export function makeGlobal(
	realm: typeof globalThis & Record<string, unknown>,
	membrane: Membrane,
	page: PageSide,
	chrome: unknown,
	/** a string a timer is handed, run as the world's code */
	evaluate: (code: string) => unknown,
): object {
	const P = page.window;
	const windowProto = getPrototypeOf(realm) as object;
	const namedProto = getPrototypeOf(windowProto) as object;
	const targetProto = getPrototypeOf(namedProto) as object;
	const deadDocument = get(realm, 'document') as object | null;
	// (the window's chain cannot take another prototype: each web name is an
	// own accessor of the window's until its first use makes it the page's)
	const lazyGetters = new WeakSet<Function>();
	const lazy = (name: string, enumerable: boolean | undefined) => {
		const getter = () => {
			materialize(name);
			return get(realm, name, realm);
		};
		lazyGetters.add(getter);
		defineProperty(realm, name, {
			get: getter,
			set(value: unknown) {
				materialize(name);
				set(realm, name, value, realm);
			},
			enumerable,
			configurable: true,
		});
	};
	for (const name of ownKeys(realm)) {
		if (typeof name !== 'string' || SCRIPT_GLOBALS.has(name)) continue;
		const descriptor = getOwnPropertyDescriptor(realm, name);
		if (!descriptor?.configurable) continue;
		if (name === 'chrome') deleteProperty(realm, name);
		else lazy(name, descriptor.enumerable);
	}
	for (const name of TARGET_MEMBERS) {
		deleteProperty(targetProto, name);
		lazy(name, true);
	}
	deleteProperty(targetProto, 'constructor');
	deleteProperty(windowProto, 'constructor');
	// (nothing of the frame's DOM is left to reach from its document)
	if (deadDocument) setPrototypeOf(deadDocument, null);

	/** a web name, the page's, on the realm's window from now on */
	function materialize(name: string) {
		const descriptor = membrane.ownOf(P, name);
		if (name === 'customElements') {
			// (Chrome has none in an isolated world)
			defineProperty(realm, name, {
				value: null,
				writable: true,
				configurable: true,
			});
			return;
		}
		if (!descriptor || 'value' in descriptor) {
			// (one of the window's chain, EventTarget's: as the membrane reads it)
			let made = descriptor
				? membrane.member(descriptor.value, name)
				: membrane.read(P, name);
			if (name === 'setTimeout' || name === 'setInterval') made = timer(made);
			defineProperty(realm, name, {
				value: made,
				writable: descriptor?.writable ?? true,
				enumerable: descriptor?.enumerable ?? false,
				configurable: true,
			});
			return;
		}
		const getter = descriptor.get;
		const setter = descriptor.set;
		const handler = name.startsWith('on');
		defineProperty(realm, name, {
			get: getter
				? {
						[name]() {
							return membrane.enter(() =>
								membrane.member(page.reflect.apply(getter, P, []), name),
							);
						},
					}[name]
				: undefined,
			set: setter
				? {
						[name](value: unknown) {
							membrane.enter(() =>
								page.reflect.apply(setter, P, [
									handler && typeof value === 'function'
										? membrane.listenerOf(value)
										: membrane.toPage(value),
								]),
							);
						},
					}[name]
				: undefined,
			enumerable: descriptor.enumerable,
			configurable: true,
		});
	}

	/** a timer whose handler may be a string: the world's code, as in Chrome */
	function timer(view: Function) {
		return function (this: unknown, handler: unknown, ...rest: unknown[]) {
			const run =
				typeof handler === 'function'
					? handler
					: () => evaluate(String(handler));
			return apply(view, this, [run, ...rest]);
		};
	}

	const special = (key: PropertyKey) =>
		key === 'document' ||
		key === 'location' ||
		key === 'top' ||
		key === 'chrome' ||
		(typeof key === 'string' && OWN_GLOBAL.has(key));

	const global: object = new Proxy(realm, {
		get(target, key) {
			if (typeof key === 'string' && OWN_GLOBAL.has(key)) return global;
			switch (key) {
				case 'document':
					return membrane.toWorld(page.natives.document);
				case 'location':
				case 'top': {
					const access = page.access();
					return membrane.enter(() =>
						membrane.toWorld(access ? access.get2(P, key) : get(P, key)),
					);
				}
				case 'chrome':
					return chrome;
			}
			return get(target, key, target);
		},
		set(target, key, value) {
			if (key === 'location') {
				const access = page.access();
				membrane.enter(() =>
					access
						? access.set2(
								P,
								'location',
								(object, name, given) => (object[name] = given),
								membrane.toPage(value),
							)
						: set(P, 'location', membrane.toPage(value)),
				);
				return true;
			}
			if (special(key)) return true;
			return set(target, key, value, target);
		},
		has(target, key) {
			return special(key) || has(target, key);
		},
		getOwnPropertyDescriptor(target, key) {
			const own = getOwnPropertyDescriptor(target, key);
			// (a web name not used yet is the page's from here)
			if (typeof key !== 'string' || !own?.get || !lazyGetters.has(own.get))
				return own;
			materialize(key);
			return getOwnPropertyDescriptor(target, key);
		},
		getPrototypeOf() {
			return membrane.toWorld(getPrototypeOf(P));
		},
	});
	// the realm's own code (a `new Function`, an indirect eval) has the
	// world's global too
	defineProperty(realm, 'globalThis', {
		value: global,
		writable: true,
		configurable: true,
	});
	return global;
}
