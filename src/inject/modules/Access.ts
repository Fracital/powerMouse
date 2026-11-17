import { keepEmbedded } from '../../functionSource';
import { HelperNames } from '../../helperNames';
import { routeHTML } from '../../rewriteHTML';
import { routeRefused } from '../../routeURL';
import { isBareSpecifier, routeImport } from '../../scriptRoutes';
import StompURL, { urlLike } from '../../StompURL';
import Client from '../Client';
import ErrorMessages from '../errorMessages';
import Module from '../Module';
import { OwnWeakSet } from '../ownCollections';
import { requestRefused } from '../requestVerdict';
import { modifyJS } from '../rewriter';
import { trustedScript } from '../trusted';
import ProxyModule from './Proxy';
import { unrouteText } from './Unroute';

/*
// why was this necessary?
function normalizeKey(key: unknown): string|unknown {
	if (typeof key === 'string') {
		return key;
	} else if(typeof key === 'u') {
		return '';
	}
}*/

export function setGlobalProxy(
	object: any,
	name: string,
	proxy: unknown,
	names: HelperNames,
) {
	// the tags never show in the page's own enumeration
	for (const [key, value] of [
		[names.globalProxy, proxy],
		[names.globalName, name],
	] as const)
		Reflect.defineProperty(object, key, {
			value,
			configurable: true,
			writable: true,
			enumerable: false,
		});
}

// taken when the bundle loads, before any page code could replace them: a
// helper that asked the page's `Array.isArray`, its `Proxy` or a method of
/**
 * Every Number.prototype this bundle defined an access API on: its own
 * realm's and that of each frame it hooked (one read before it loaded),
 * whose reflection is this realm's for the page that lists that frame's
 * objects from here (src/inject/modules/Reflection.ts).
 */
export const accessHolders = new OwnWeakSet<object>();

// its `Array.prototype` would decide what the page told it to
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const NativeProxy = Proxy;
const NativeSymbol = Symbol;
const ITERATOR = Symbol.iterator;
const create = Object.create;
const ownKeys = Reflect.ownKeys;
const ownDescriptor = Reflect.getOwnPropertyDescriptor;
// (a worklet's global has none: nothing is remembered there, see `brandless`)
const enqueue: ((callback: () => void) => void) | undefined =
	typeof queueMicrotask === 'function' ? queueMicrotask : undefined;

/**
 * Whether `value` is an array or a typed array (or a DataView), by the
 * natives' own brand checks: nothing of the value is read and no trap of a
 * page's Proxy runs. Such a value is no window, no stand-in of one and no
 * element, whatever the page did to its globals, so a read or a write of
 * it by a number needs none of what the helpers do for those (a window's
 * numbers are its child frames). Array.isArray answers for a Proxy's
 * target, as the member access will, and throws for a revoked Proxy: that
 * one goes the long way, where the access throws its own error.
 */
const indexed = (value: unknown): boolean => isView(value) || array(value);
/** an array, or a Proxy of one that is not revoked */
const array = (value: unknown): boolean => {
	try {
		return isArray(value);
	} catch (error) {
		return false;
	}
};

/**
 * Whether `key` names an element the way an array index does (`0`, `'17'`;
 * not `'01'`, not `1.5`), asked with operators alone: a write lands through
 * the hooks by this answer, and Number.isInteger and a RegExp's methods are
 * the page's to replace.
 */
const indexKey = (key: unknown): boolean => {
	if (typeof key === 'number') return key >= 0 && key % 1 === 0;
	if (typeof key !== 'string') return false;
	// (a name is told by its first character, without converting it)
	const first = key[0];
	if (!(first >= '0' && first <= '9')) return false;
	const index = +key;
	return index >= 0 && index % 1 === 0 && `${index}` === key;
};

type PatternSpec = {
	[key: string]: true | PatternSpec | (0 | PatternSpec | [PatternSpec])[];
};

export default class AccessModule extends Module<Client> {
	apply() {
		const evalSnapshot = this.client.global.eval;

		const proxyModule = this.client.getModule(ProxyModule);

		// eval returns anything that is not a string unchanged; a TrustedScript
		// (Trusted Types) is code, as for the browser
		const isCode = (x: unknown): x is string | object => {
			if (typeof x === 'string') return true;
			const Trusted = (this.client.global as { TrustedScript?: unknown })
				.TrustedScript;
			return typeof Trusted === 'function' && x instanceof Trusted;
		};
		/**
		 * The page's code `x` that an eval runs, rewritten (null where the
		 * page's Trusted Types refuse it: `refuse`, the native eval of it, threw
		 * as natively): a trusted value where they are in use (trusted.ts)
		 */
		const evaluated = (x: string | object, refuse: () => unknown) => {
			// the page's Trusted Types judge the string first (its default policy
			// may change it, and refuse it with Chrome's EvalError); then its
			// script-src, which may refuse code made from a string (src/csp.ts
			// codeEval). Both a direct eval (evalScope) and an indirect one reach
			// here.
			const page = this.client.trustedValue(x, 'TrustedScript', 'eval', refuse);
			if (page === null) return null;
			const refusal = this.client.codeEval('eval', page);
			if (refusal) {
				if (refusal.error) throw refusal.error;
				return null;
			}
			const code = modifyJS(
				page,
				this.client.baseURL,
				this.client.config,
				'generic',
			);
			this.client.noteCodeSample(code, page);
			return trustedScript(code);
		};
		const globalEval = (x: unknown) => {
			if (!isCode(x)) return x;
			// (eval refused by the page's script-src throws in `evaluated`)
			const code = evaluated(x, () => evalSnapshot(x as string));
			return code === null ? undefined : evalSnapshot(code);
		};

		const globalEvalProxy = proxyModule?.wrapFunction(
			evalSnapshot,
			(target, that, [code]) => globalEval(code),
		);

		setGlobalProxy(evalSnapshot, 'eval', globalEvalProxy, this.client.names);
		/**
		 * What a write of `eval` stores: a page that assigns the eval it read
		 * (`eval = eval`, one it saved and puts back) holds the stand-in a read
		 * answers, and the name takes the eval itself, the only value whose
		 * call is a direct eval
		 */
		const evalWritten = (value: unknown): unknown =>
			globalEvalProxy !== undefined && value === globalEvalProxy
				? evalSnapshot
				: value;

		/** the routed URL of a module `url` imports (bare specifiers are the import map's), by its kind */
		/**
		 * A failed import rejects with the browser's TypeError, "Failed to
		 * fetch dynamically imported module: <URL>", naming the route it was
		 * given: the same error comes back naming the page's URL, before
		 * anything of the page's sees it (a rejection handler, an
		 * unhandledrejection listener, the console).
		 */
		const promiseThen = Promise.prototype.then;
		const imported = (promise: Promise<unknown>): Promise<unknown> =>
			Reflect.apply(promiseThen, promise, [
				undefined,
				(error: unknown) => {
					const message =
						typeof error === 'object' && error !== null
							? Reflect.getOwnPropertyDescriptor(error, 'message')
							: undefined;
					if (message && typeof message.value === 'string')
						Reflect.defineProperty(error as object, 'message', {
							...message,
							value: unrouteText(this.client, message.value),
						});
					throw error;
				},
			]);

		/**
		 * What `import()` is handed for a specifier that cannot be routed (its
		 * conversion to a string threw): the browser's import converts it
		 * again, gets the same error and answers a rejected promise, where a
		 * throw here would leave the page's `import()` throwing
		 */
		const failing = (error: unknown) => ({
			toString() {
				throw error;
			},
		});
		const route = (
			baseURL: string | undefined,
			url: unknown,
			moduleType: unknown,
		): string => {
			let specifier: string;
			try {
				// (converted once, as the import converts it)
				specifier = `${url as string}`;
			} catch (error) {
				return failing(error) as unknown as string;
			}
			// a page's service worker imports nothing so, natively: the
			// emulated one is a worker that would
			if (
				(this.client as { serviceWorkerVersion?: string }).serviceWorkerVersion
			)
				return failing(
					new this.client.global.TypeError(
						'import() is disallowed on ServiceWorkerGlobalScope by the HTML specification. See https://github.com/w3c/ServiceWorker/issues/1356.',
					),
				) as unknown as string;
			if (isBareSpecifier(specifier)) return specifier;
			let resource: URL;
			try {
				resource = new URL(
					specifier,
					baseURL || this.client.baseURL.toString(),
				);
			} catch (error) {
				// no URL: the browser's import fails on it as it does natively
				return specifier;
			}
			const module = new StompURL(resource, this.client.url);
			// one a worker's script-src refuses fails to load, as the browser
			// fails it (requestVerdict reports it), and its TypeError names it
			if (requestRefused(this.client, 'script-src-elem', resource))
				return routeRefused(module);
			return routeImport(
				module,
				this.client.url,
				this.client.config,
				'genericModule',
				moduleType,
			);
		};
		// (the helpers below run on every computed access of a page: its names
		// are read once)
		const names = this.client.names;
		// the errors a helper throws in the page's place, with the message V8
		// gives the page's expression (`partial`, its source)
		const errors = new ErrorMessages(this.client);
		const nullish = (value: unknown): value is null | undefined =>
			value === null || value === undefined;
		/**
		 * The property key a computed member's key is (`o[k]`): an object
		 * there is converted, once, as the member read would. The helpers
		 * know a name by its string, and `window[{ toString: () => 'top' }]`
		 * was no name to them: it read the real top.
		 */
		const keyOf = (key: any): any =>
			(typeof key === 'object' && key !== null) || typeof key === 'function'
				? Reflect.ownKeys({ [key]: 0 })[0]
				: key;
		const isObject = (value: unknown): value is object =>
			(typeof value === 'object' && value !== null) ||
			typeof value === 'function';
		/**
		 * The source of an array pattern (`[a, { top: t }] = source`), whose
		 * elements the pattern takes from its iterator: an iterable that hands
		 * out the same values, the ones the pattern destructures further
		 * (`specs`, by index) wrapped by `pattern`. The source's iterator is
		 * driven as the pattern would drive it: `next` read once, a result
		 * that needs no wrapping handed over as it came, `return` passed on.
		 * An entry that is an array is the rest (`...[{ top: t }]`, which the
		 * rewriter printed as a plain last element): the values left, as an
		 * array, wrapped for the pattern that takes it.
		 */
		// what a pattern's source was wrapped in, by the wrapper: the value of
		// an assignment is its source (`r = ({ top: t } = o)`, access API
		// `source`)
		const wrapped = new WeakMap<object, unknown>();
		const wraps = <T extends object>(wrapper: T, source: unknown): T => {
			wrapped.set(wrapper, source);
			return wrapper;
		};
		const iterated = (source: any, specs: unknown[]): unknown => {
			const method = source[ITERATOR];
			// not iterable: the pattern's own error
			if (typeof method !== 'function') return source;
			return wraps(
				{
					[ITERATOR]: () => {
						const iterator = Reflect.apply(method, source, []);
						if (!isObject(iterator)) return iterator;
						const next = (iterator as any).next;
						const step = () => {
							const result = Reflect.apply(next, iterator, []);
							if (!isObject(result))
								throw new TypeError(
									`Iterator result ${String(result)} is not an object`,
								);
							return result as IteratorResult<unknown>;
						};
						let index = 0;
						let drained = false;
						return {
							next: () => {
								if (drained) return { done: true, value: undefined };
								const spec = specs[index++];
								if (!spec) return Reflect.apply(next, iterator, []);
								if (isArray(spec)) {
									const rest: unknown[] = [];
									for (let result = step(); !result.done; result = step())
										rest.push(result.value);
									drained = true;
									return { done: false, value: api.pattern(rest, spec[0]) };
								}
								const result = step();
								if (result.done) {
									drained = true;
									return { done: true, value: undefined };
								}
								return {
									done: false,
									value: api.pattern(result.value, spec as PatternSpec),
								};
							},
							return: () => {
								if (drained) return {};
								const close = (iterator as any).return;
								if (close === undefined || close === null) return {};
								return Reflect.apply(close, iterator, []);
							},
						};
					},
				},
				source,
			);
		};
		/**
		 * `target.postMessage(...args)` with the method the page's read gave:
		 * see `post`
		 */
		const posted = (
			method: any,
			target: any,
			args: any[],
			optional?: boolean,
			partial?: string,
		): any => {
			if (optional && nullish(method)) return undefined;
			if (typeof method !== 'function')
				return errors.call(method, target, args, partial);
			if (this.client.postToWindow) {
				let receiver: Client | undefined;
				try {
					// (asked of a window alone: a Proxy of the page's with a
					// postMessage of its own sees no question)
					if (isWindowObject(target))
						receiver = target[this.client.names.client];
				} catch (error) {
					// a cross-origin window: called as written
				}
				// only while the receiver's postMessage is still the hook: a
				// page that assigned its own function gets that function
				if (
					receiver?.nativePostMessage &&
					method === receiver.hookedPostMessage
				)
					return this.client.postToWindow(target, args);
			}
			if (this.client.postToRestricted?.(target, args)) return undefined;
			return Reflect.apply(method, target, args);
		};
		// the scope of a `with` whose head needs none: no name is found in it
		// (no prototype), and a page that gets hold of it converts it like any
		// object (by a symbol, which no name finds)
		const NO_SCOPE = Object.freeze(
			Object.create(null, {
				[Symbol.toPrimitive]: { value: () => '[object Object]' },
			}),
		) as object;
		// the scope `scoped` hands the `with` that follows a head (`scope`)
		let pendingScope: object = NO_SCOPE;
		// Whether a value is a window, asked without a property read a Proxy
		// of the page's would see: the browser's own getter of `window` (an
		// unforgeable property, so no hook's and no page's) answers for a
		// window and throws for anything else. A worker has no windows.
		const windowGetter = Reflect.getOwnPropertyDescriptor(
			this.client.global,
			'window',
		)?.get;
		// The browser's own `onmouseenter` getter answers a receiver that is
		// no window with undefined instead of throwing ([LegacyLenientThis]),
		// and asks nothing of it either: a window's is its handler or null
		// (the setter makes undefined null), a window of another origin
		// throws. Asked first, so that what is no window costs no exception:
		// every computed read that lands on an object asks this (a throw
		// costs about 3 us, which made a loop over an array of objects about
		// sixty times slower)
		const lenient = Reflect.getOwnPropertyDescriptor(
			this.client.global,
			'onmouseenter',
		)?.get;
		const isWindowObject = (value: unknown): boolean => {
			if (!windowGetter || !isObject(value)) return false;
			if (lenient)
				try {
					if (Reflect.apply(lenient, value, []) === undefined) return false;
				} catch (error) {
					// a window of another origin: asked below
				}
			try {
				return Reflect.apply(windowGetter, value, []) === value;
			} catch (error) {
				return false;
			}
		};
		this.client.isWindowObject = isWindowObject;
		// A document's own `location` is the window's (unforgeable, so an own
		// property of each document), and Document.prototype's own
		// `onmouseenter` getter is as lenient as the window's: it answers
		// undefined for anything that is no document and asks nothing of it
		const documentLenient = (
			this.client.global as { Document?: { prototype: object } }
		).Document
			? Reflect.getOwnPropertyDescriptor(
					(this.client.global as unknown as { Document: { prototype: object } })
						.Document.prototype,
					'onmouseenter',
				)?.get
			: undefined;
		// The objects the browser's brand check last found to be no window at
		// all (the lenient getter answered undefined, as it does for nothing
		// that is a window, attached or not, or a stand-in of one): two of
		// the receivers and two of the values a computed access had. A loop
		// reads and writes one object, or two side by side, by many keys,
		// and reads one value more than once (`a[i].x === b[i].x`, then
		// `f(a[i], b[i])`): the check is asked once of each. Nothing the
		// page does changes what an object is; they are let go when the
		// microtasks are done, so that nothing of the page's is kept alive
		// longer than the page keeps it.
		let seenReceiver: object | undefined;
		let seenReceiverBefore: object | undefined;
		let seenValue: object | undefined;
		let seenValueBefore: object | undefined;
		let forgetting = false;
		const forget = () => {
			seenReceiver =
				seenReceiverBefore =
				seenValue =
				seenValueBefore =
					undefined;
			forgetting = false;
		};
		const remembered = () => {
			if (forgetting) return;
			forgetting = true;
			try {
				enqueue?.(forget);
			} catch (error) {
				// a realm whose window is gone: what it remembers stays
			}
		};
		/** whether the browser's brand check says `object` is no window at all */
		const brandless = (object: object): boolean => {
			if (!lenient || !enqueue) return false;
			try {
				return Reflect.apply(lenient, object, []) === undefined;
			} catch (error) {
				// a window of another origin
				return false;
			}
		};
		/**
		 * Whether an object spread (`{ ...value }`) of `value` copies what a
		 * page must not hold raw: a window's children, `top`, `location`
		 * (its own properties), a document's `location`. Asked by the
		 * browser's brand checks alone, so nothing of the value is read and
		 * no trap of a page's Proxy runs. (An object's own `location` would
		 * tell most objects apart in a third of the time, but a Proxy's trap
		 * would see the question; a cache of the objects found to be
		 * neither, as `brandless` keeps, made a loop of spreads slower.)
		 */
		const copiesGuarded = (value: object): boolean => {
			if (documentLenient)
				try {
					if (Reflect.apply(documentLenient, value, []) !== undefined)
						return true;
				} catch (error) {
					// (nothing that is no document makes it throw)
				}
			return isWindowObject(value);
		};
		/**
		 * Whether `target`, the receiver of a computed access, is no window
		 * (so it is no window `live` knows, and nothing restrictForeign
		 * changes): a function, an array, a typed array are none (a window
		 * is an object, not callable, and no array), anything else by the
		 * brand check
		 */
		const noWindow = (target: object): boolean => {
			if (
				target === seenReceiver ||
				target === seenReceiverBefore ||
				typeof target === 'function' ||
				indexed(target)
			)
				return true;
			if (!brandless(target)) return false;
			seenReceiverBefore = seenReceiver;
			seenReceiver = target;
			remembered();
			return true;
		};
		/**
		 * Whether `got`, the value of a computed read, is handed to the page
		 * as it is by `get` past its names (restrictForeign changes only a
		 * window): anything that is no object is (a function, an array, a
		 * typed array as well), anything else by the brand check
		 */
		const plain = (got: unknown): boolean => {
			if (
				typeof got !== 'object' ||
				got === null ||
				got === seenValue ||
				got === seenValueBefore ||
				indexed(got) ||
				!this.client.restrictForeign
			)
				return true;
			if (brandless(got)) {
				seenValueBefore = seenValue;
				seenValue = got;
				remembered();
				return true;
			}
			return !isWindowObject(got);
		};
		/**
		 * A key that is a name `get` knows (the client's, postMessage, and
		 * the names of UNDEFINABLE), or that a write knows (eval, location):
		 * those take the long way, every other string the short one
		 */
		const named = (key: string): boolean =>
			key === names.client ||
			key === 'postMessage' ||
			key === 'top' ||
			key === 'eval' ||
			key === 'location';
		// a window the page held whose frame got a fresh browsing context since
		// stands for the frame's window now (src/inject/dom/freshContext.ts):
		// what the page does to it is done to that window as the page has it,
		// a stand-in when it is of another origin. Its identity is its own
		// (`self`, `window` and `frames` are it)
		const live = (target: unknown, key?: unknown): any => {
			if (
				(typeof target !== 'object' && typeof target !== 'function') ||
				target === null ||
				!this.client.liveWindow ||
				key === 'self' ||
				key === 'window' ||
				key === 'frames'
			)
				return target;
			return this.client.liveWindow(target) ?? target;
		};
		// `target[key] = righthand` and its kin (`operate`): set2 past its
		// short path. Under set2's own name, which is the name V8 gives its
		// frame: the page's write is done by a function of the page's script
		// (`operate`), and the stack cleaner (Unroute) takes that function's
		// frame out by the name of the helper that called it.
		const long = {
			set2: (
				target: any,
				key: any,
				operate: (target: any, property: any, value: any) => any,
				righthand: any,
			): any => {
				// a number, or a string that is no name a write or `get` knows,
				// on an object, whose write lands through no hook (an object
				// value written by an index may be an option landing in a
				// select): what is left of the way below is `live` and the look
				// at the target (a window of another origin is written through
				// its stand-in), both not for an object the browser's brand check
				// found no window, and the look at a compound write's answer
				if (
					typeof target === 'object' &&
					target !== null &&
					(typeof key === 'number' ||
						(typeof key === 'string' && !named(key))) &&
					(typeof righthand !== 'object' ||
						righthand === null ||
						!this.client.landIndexed ||
						!indexKey(key))
				) {
					const maybeWindow = !noWindow(target);
					const object = maybeWindow ? live(target, key) : target;
					const result = operate(
						!maybeWindow || plain(object) ? object : api.get(object, key),
						key,
						righthand,
					);
					return result === righthand || plain(result)
						? result
						: api.get(result, key, object);
				}
				// (a null or undefined target throws before the key is converted,
				// as natively)
				if (!nullish(target)) {
					key = keyOf(key);
					target = live(target, key);
				}

				// the client's global is not the page's to replace (see get)
				if (key === this.client.names.client) return righthand;
				// `window.eval = saved`
				if (key === 'eval' && target === this.client.global)
					righthand = evalWritten(righthand);

				// (asked of these two names alone: reading the document is a
				// call of its getter, on every write of a computed key)
				if (key === 'location' || key === 'eval') {
					// `document.location = url` is `window.location = url`
					const isDocument =
						typeof target === 'object' &&
						target !== null &&
						target === (this.client.global as any).document;
					if (target === this.client.global || isDocument) {
						if (key === 'location') {
							// this client's location: an about:blank child runs its
							// creator's bundle, whose free `location` is the creator's.
							// The operator reads the Location (`w.location ||= u`
							// answers it, `w.location += u` makes it a string) and
							// writes its href
							const standIn = (this.client.global.location as any)[
								this.client.names.globalProxy
							];
							const property = NativeSymbol();
							return operate(
								{
									get [property]() {
										return standIn;
									},
									set [property](value: unknown) {
										standIn.href = value;
									},
								},
								property,
								righthand,
							);
						}
					} else {
						// (another window's own API writes its location and its
						// eval; asked only for those keys: the question is a
						// `has` and a `get` a Proxy of the page's would see on
						// every write of a computed key)
						// Its API is its client's (the global of the API's name is
						// its page's to replace, and what it was handed here is
						// this realm's write of a member). Only a window is asked
						// anything, so a Proxy of the page's sees no question
						let theirs: { set2?: unknown } | undefined;
						try {
							if (isWindowObject(target))
								theirs = target[this.client.names.client]?.accessApi;
						} catch (error) {
							// a cross-origin window: nothing of ours to delegate to
						}
						const foreign =
							typeof theirs?.set2 === 'function' && theirs.set2 !== api.set2;
						// another proxied window's location: navigated as this
						// document's navigation (Context navigateWindow), with the
						// value the assignment makes (`w.location += '#x'` too)
						if (foreign && key === 'location' && this.client.navigateWindow) {
							let value: unknown;
							let assigned = false;
							const property = NativeSymbol();
							const result = operate(
								{
									get [property]() {
										return api.get(target.location, 'location', target);
									},
									set [property](next: unknown) {
										value = next;
										assigned = true;
									},
								},
								property,
								righthand,
							);
							if (!assigned) return result;
							// (converted once, as the setter would)
							const url = String(value);
							if (this.client.navigateWindow(target, url, 'href'))
								return result;
							righthand = url;
							operate = (object: any, property: any, next: any) =>
								(object[property] = next);
						}
						if (foreign)
							return (theirs as { set2: (...args: unknown[]) => unknown }).set2(
								target,
								key,
								operate,
								righthand,
							);
					}
				}

				// `select[0] = option`, `select.options[i] = option`: the node
				// lands through the hooks, as `select.add(option)` does (the
				// indexed setter is no function a hook could wrap). An array
				// is asked nothing.
				if (
					typeof righthand === 'object' &&
					righthand !== null &&
					typeof target === 'object' &&
					target !== null &&
					this.client.landIndexed &&
					indexKey(key) &&
					!isArray(target) &&
					'selectedIndex' in target
				)
					return this.client.landIndexed(target, righthand, () =>
						operate(api.get(target, key), key, righthand),
					);

				// a compound or logical write answers what it read when it
				// assigned nothing (`w.top ||= v`, `w.eval ??= v`, `w[0] ||= v`),
				// and its operator read the member off the object itself: the
				// real top, the eval, a window of another origin. The page gets
				// what a read of the member answers
				const result = operate(api.get(target, key), key, righthand);
				return result === righthand || !isObject(result)
					? result
					: api.get(result, key, target);
			},
		};
		/** `target[key]`, a computed member read: get2 past its short path */
		const read = (target: any, key: any, optional?: boolean): unknown => {
			// a number, or a string that is no name of `get`'s, on an object:
			// what is left of the long way is `live` (not for an object the
			// browser's brand check found no window) and the look at the
			// value (the key needs no conversion, and `get` knows no such key)
			if (
				typeof target === 'object' &&
				target !== null &&
				(typeof key === 'number' || (typeof key === 'string' && !named(key)))
			) {
				const object = noWindow(target) ? target : live(target, key);
				const value = object[key];
				return plain(value) ? value : api.get(value, key, object);
			}
			if (nullish(target)) {
				// a?.[k]
				if (optional) return undefined;
				throw errors.read(target, key);
			}

			key = keyOf(key);
			target = live(target, key);
			return api.get(target[key], key, target);
		};
		// a window's or a document's own enumerable properties, each as a
		// member read hands it out (`spread`): a copy with no prototype, so
		// that no setter of Object.prototype's takes a key
		const copyOf = (value: object): object => {
			const source = live(value);
			const copy = create(null) as Record<PropertyKey, unknown>;
			const keys = ownKeys(source);
			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];
				if (!ownDescriptor(source, key)?.enumerable) continue;
				copy[key] = api.get(source[key], key, source);
			}
			return copy;
		};
		const api = {
			get2: (
				target: any,
				key: any,
				_partial?: string,
				optional?: boolean,
			): unknown => {
				// an element of an array, a typed array or a string, by a number:
				// the loops of a page's own computing, which pay this helper per
				// element. Such a receiver is no window (see `indexed`), so it is
				// nothing `live` knows, and a number is no name `get` knows; what
				// is left of the long way is `get`'s look at a value that is an
				// object, which only a window passes (`restrictForeign`), kept
				// for one that is not itself an array. (Each kind is read where
				// only its kind is read: one read for all of them would know no
				// shape and be the slowest the engine has. One call of `read` in
				// the body, so that the engine inlines the helper into a loop of
				// the page's that reads an arguments object.)
				short: if (typeof key === 'number') {
					let value;
					if (typeof target === 'string') value = target[key as any];
					else if (isView(target)) value = (target as any)[key];
					else if (array(target)) value = target[key];
					else break short;
					return typeof value !== 'object' ||
						value === null ||
						indexed(value) ||
						!this.client.restrictForeign ||
						!isWindowObject(value)
						? value
						: api.get(value, key, target);
				}
				return read(target, key, optional);
			},
			/**
			 * `arguments[k]` of a function's own arguments object, as the
			 * rewriter knows it (nothing in reach can rebind the name:
			 * rust/rwjs/src/args.rs): the loop a downlevelled rest parameter
			 * is, and every variadic helper's. That object is no window, no
			 * stand-in and nothing `live` knows, and a number is no name `get`
			 * knows: what is left of get2 is the look at a value that is an
			 * object (a window handed in as an argument is restricted as a
			 * read of it is). Small, so that the engine takes it into the
			 * page's loop: anything but a number is get2's.
			 */
			arg: (target: any, key: any, partial?: string): unknown => {
				if (typeof key === 'number') {
					const value = target[key];
					return typeof value !== 'object' ||
						value === null ||
						indexed(value) ||
						!this.client.restrictForeign ||
						!isWindowObject(value)
						? value
						: api.get(value, key, target);
				}
				return api.get2(target, key, partial);
			},
			/**
			 * What an object spread spreads (`{ ...value }`, the rewriter
			 * routes it unless it can be no window). The spread copies its
			 * own enumerable properties with no call the inject can wrap, and
			 * a window's are its child frames, its `top` and its `location`, a
			 * document's its `location`: those come out as a member read hands
			 * them out, in a copy the spread copies again (the properties in
			 * the same order, each read once, as the spread reads them).
			 * Anything else is handed back as it is: this is on the way of
			 * every spread of a page's objects.
			 */
			spread: (value: unknown): unknown =>
				typeof value !== 'object' || value === null || !copiesGuarded(value)
					? value
					: copyOf(value),
			// `container`: what `object` was read from, when the read is a member
			// read (a window's child is injected before the page gets it)
			get: (object: any, key: any, container?: unknown): any => {
				// (this runs on every computed read, and most keys are numbers or
				// names of the page's own: only a string is a name known here)
				if (typeof key === 'string') {
					// the client, by its name, is nothing to a page: it holds the
					// real windows the inject works with, and a page that read it
					// would reach every proxied site that frames it. The rewriter
					// routes every mention of the name here, and reflection's reads
					// come here too, so knowing the name (a same-site frame's shell
					// shows it while it loads) gives a page nothing
					if (key === names.client) return undefined;
					// another window's postMessage, read and not called: the page
					// gets a function of this realm for it, so a call of it later
					// (bound, detached, handed to `call`) posts from this realm,
					// which the browser names as the source
					if (key === 'postMessage') {
						if (container !== undefined) {
							const own = this.client.postMessageOf?.(container);
							if (own) return own;
						}
					} else if (key === 'top' || key === 'eval' || key === 'location') {
						// (the names of UNDEFINABLE, spelled out: this is asked of
						// every other name a page reads by a computed key)
						try {
							if (key === 'top' && this.client.resolveTop)
								return this.client.resolveTop(object, container);

							if (
								((typeof object === 'object' && object !== null) ||
									typeof object === 'function') &&
								names.globalProxy in object
							) {
								const standIn = object[names.globalProxy];
								return key === 'location' && this.client.gateLocation
									? this.client.gateLocation(object, standIn, container)
									: standIn;
							}
						} catch (error) {
							// error was thrown during an accessor
							// should not be introduced into normal execution
						}
					}
				}

				// (anything that is no object is handed back as it is)
				if (typeof object !== 'object' || object === null) return object;

				if (this.client.restrictForeign)
					return this.client.restrictForeign(object, container);

				return object;
			},
			set2: (
				target: any,
				key: any,
				operate: (target: any, property: any, value: any) => any,
				righthand: any,
			) => {
				// an element of an array or a typed array, written by a number (see
				// get2): no window, no document, no select, and no name of ours.
				// What the long way reads of the target first (`get`) is the
				// target itself, and a compound write's answer is looked at as
				// there
				if (typeof key === 'number' && indexed(target)) {
					const result = operate(target, key, righthand);
					return result === righthand || !isObject(result)
						? result
						: api.get(result, key, target);
				}
				return long.set2(target, key, operate, righthand);
			},
			set1: (
				target: any,
				name: any,
				operate: any,
				set: any,
				righthand: any,
			) => {
				// name = normalizeKey(name);
				const property = NativeSymbol();
				let value = api.get(target, name);
				let assigned = false;
				const object = {
					get [property]() {
						return value;
					},
					set [property](v: unknown) {
						value = v;
						assigned = true;
					},
				};

				const result = operate(object, property, righthand);
				// `location ||= v` and `location ??= v` assign nothing (a
				// location is always set): navigating to it again would reload
				// the page, forever when the write is in its own script
				if (!assigned) return result;

				// (`top = v` reads this off the real top, which may be of another
				// origin: the read throws a SecurityError naming the key, where the
				// page's write throws its own TypeError)
				let isLocation = false;
				try {
					isLocation =
						typeof target === 'object' &&
						target !== null &&
						target[this.client.names.globalName] === 'location';
				} catch (error) {
					// a cross-origin window: no location of ours
				}
				if (isLocation) {
					const destination = new URL(
						<urlLike>value,
						this.client.baseURL.toString(),
					);
					set(
						// this document's own location: a navigation the browser's
						// history records (another window's is that window's)
						target === this.client.global.location
							? this.client.navigationRoute(destination)
							: routeHTML(
									new StompURL(destination, this.client.url),
									this.client.url,
									this.client.config,
									false,
									this.client.nestedRoute,
								),
					);
				} else {
					set(name === 'eval' ? evalWritten(value) : value);
				}

				return result;
			},
			/**
			 * `[location] = a`, `for (location of a)`: the target of a pattern
			 * or a loop head is a reference, which the rewriter makes the
			 * `value` of this object; writing it routes like `location = v`.
			 * `target` is what the name held, `set` assigns the name in the
			 * page's own scope (a local, a `with` object, the window).
			 */
			ref1: (
				target: any,
				set: (value: unknown) => unknown,
				// `location`, or `eval` (`[eval] = [saved]`)
				name = 'location',
			) => ({
				// (`location ||= f()`, `top += f()`: the operator reads the
				// name, then evaluates its value, then writes)
				get value() {
					return api.get(target, name);
				},
				set value(value: unknown) {
					api.set1(
						target,
						name,
						(object: any, property: any, v: unknown) => (object[property] = v),
						set,
						value,
					);
				},
			}),
			/**
			 * `[top.location] = a`: the member form of `ref1`, routed by set2,
			 * and `o[k] ||= f()`, `o[k] += f()`, whose operator reads the member
			 * (as get2 reads it), then evaluates its value, then writes. `write`
			 * is the plain write as the page's code makes it (it fails as the
			 * page's own would: silently in sloppy code). A key that is an
			 * object is converted by the read and again by the write, as V8
			 * converts it.
			 */
			ref2: (
				target: any,
				key: any,
				write: (target: any, property: any, value: any) => any = (
					object,
					property,
					v,
				) => {
					object[property] = v;
				},
			) => ({
				get value() {
					return api.get2(target, key);
				},
				set value(value: unknown) {
					api.set2(target, key, write, value);
				},
			}),
			/** the property key a computed `super[k]` reads (see keyOf) */
			key: (key: any): any => keyOf(key),
			/**
			 * `super.eval(code)`, `super[k](...)`: `super` is no value to hand a
			 * helper, so the rewriter hands over the method it read (through
			 * `get`: the eval's stand-in, not the eval) and the method's `this`.
			 * The function this answers is called with the arguments.
			 */
			smethod: (
				method: any,
				that: any,
				partial?: string,
				optional?: boolean,
			): ((...args: any[]) => any) | undefined => {
				if (optional && nullish(method)) return undefined;
				return (...args: any[]) =>
					typeof method === 'function'
						? Reflect.apply(method, that, args)
						: errors.call(method, that, args, partial);
			},
			/**
			 * `super.location = v`, `super[k] += v`, `super[k]++`: `read` and
			 * `write` are the member itself (`k => super[k]`,
			 * `(k, v) => super[k] = v`), `operate` the operator, as for set2. A
			 * window's location, which `super` reaches when the home object's
			 * prototype is the window and `this` is, is written through its
			 * stand-in; anything else through the member, read by `get`.
			 */
			sset: (
				key: any,
				that: any,
				read: (key: any) => any,
				write: (key: any, value: any) => any,
				operate: (target: any, property: any, value: any) => any,
				righthand: any,
			): any => {
				if (key === this.client.names.client) return righthand;
				if (key === 'location') {
					const real = read(key);
					const standIn = api.get(real, key);
					if (standIn !== real) return operate(standIn, 'href', righthand);
				}
				const property = NativeSymbol();
				return operate(
					{
						get [property]() {
							return api.get(read(key), key);
						},
						set [property](value: unknown) {
							write(
								key,
								key === 'eval' && that === this.client.global
									? evalWritten(value)
									: value,
							);
						},
					},
					property,
					righthand,
				);
			},
			/** `[super.location] = a`: the pattern-target form of `sset` (see ref2) */
			sref: (
				key: any,
				that: any,
				read: (key: any) => any,
				write: (key: any, value: any) => any,
			) => ({
				// (`super[k] ||= f()`: read as `super[k]` is)
				get value() {
					return api.get(read(key), key);
				},
				set value(value: unknown) {
					api.sset(
						key,
						that,
						read,
						write,
						(object: any, property: any, v: unknown) => {
							object[property] = v;
						},
						value,
					);
				},
			}),
			/**
			 * `key in target`: the rewriter routes here every `in` whose key is
			 * or may be a helper name. A helper name is not on the window, a
			 * worker scope or a stand-in, as for `Reflect.has`; anything else is
			 * the operator itself, its TypeError for a primitive target included.
			 */
			has: (key: any, target: any): boolean => {
				if (
					((typeof key === 'object' && key !== null) ||
						typeof key === 'function') &&
					((typeof target === 'object' && target !== null) ||
						typeof target === 'function')
				) {
					// the key the operator would look up, converted once
					const holder = { [key]: 0 };
					key = Reflect.ownKeys(holder)[0];
				}
				return this.client.hidesName?.(target, key) ? false : key in target;
			},
			new2: (target: any, key: any, args: any, partial?: string): any => {
				if (nullish(target)) throw errors.read(target, key);
				key = keyOf(key);
				return errors.construct(api.get(target[key], key), args, partial);
			},
			/**
			 * `o[k].name(...)`: get2 and the call of its value's method in one
			 * (the call is the access API's so that its error names `o[k]`, and
			 * one helper costs half of two)
			 */
			call3: (
				target: any,
				key: any,
				name: any,
				args: any[],
				partial?: string,
			): any => {
				if (nullish(target)) throw errors.read(target, key);
				key = keyOf(key);
				// (a key `get` knows no name of, on an object that is no window:
				// see get2)
				const known =
					typeof key === 'number' || (typeof key === 'string' && !named(key));
				target =
					known && isObject(target) && noWindow(target)
						? target
						: live(target, key);
				const value = target[key];
				const object =
					known && plain(value) ? value : api.get(value, key, target);
				if (nullish(object)) throw errors.read(object, name);
				const method = object[name];
				if (typeof method === 'function')
					return Reflect.apply(method, object, args);
				return errors.call(method, object, args, partial);
			},
			/**
			 * `f(...)` and `new f(...)` of a value a helper made (`location()`,
			 * `o[k](a)(b)`, `new top.x()`): the browser's message would print
			 * the helper's call where the page's expression is
			 */
			fcall: (callee: any, args: any[], partial?: string): any =>
				errors.callValue(callee, args, partial),
			fnew: (callee: any, args: any[], partial?: string): any =>
				errors.construct(callee, args, partial),
			/**
			 * The value a page's code iterates (`for (x of v)`, `[...v]`,
			 * `f(...v)`, `[a] = v`) or destructures (`{ a } = v`), when it came
			 * out of a helper: one that cannot be fails here, with the message
			 * the page's expression gets
			 */
			iter: (value: unknown, shape: string, partial?: string): unknown =>
				errors.iterate(value, shape, partial),
			coerce: (value: unknown, partial?: string): unknown =>
				errors.coerce(value, partial),
			/**
			 * `x.postMessage(...)` (the rewriter routes every such call here, and
			 * a call by a computed key that names it): a STomp window gets the
			 * message through its own native postMessage called from this realm,
			 * so this context is the incumbent the browser reports as the
			 * source, with an envelope carrying this context's real origin;
			 * anything else (a port, a worker, a plain object, a restricted
			 * window) is called as written.
			 */
			post: (
				target: any,
				args: any[],
				// which links may short-circuit: 1 none, 2 the object's
				// (`w?.postMessage(m)`), 3 the call's (`w.postMessage?.(m)`),
				// 0 both; `true` and `false` (code rewritten before the two
				// were told apart) for both and none
				links?: boolean | number,
				partial?: string,
			): any => {
				const none = links === false || links === 1;
				if (nullish(target)) {
					if (!none && links !== 3) return undefined;
					throw errors.read(target, 'postMessage');
				}
				target = live(target);
				return posted(
					target.postMessage,
					target,
					args,
					!none && links !== 2,
					partial,
				);
			},
			call2: (
				target: any,
				key: any,
				args: any,
				partial?: string,
				optional?: boolean | number,
			): any => {
				// which links short-circuit: 1 the object's (a?.[k](...)), 2 the
				// call's (a[k]?.(...)); `true` (code rewritten before the two were
				// told apart) for both
				const links = optional === true ? 3 : optional || 0;
				if (nullish(target)) {
					if (links & 1) return undefined;
					throw errors.read(target, key);
				}

				key = keyOf(key);
				// `w['post' + 'Message'](m)` posts like `w.postMessage(m)`
				if (key === 'postMessage')
					return api.post(target, args, !!(links & 2), partial);
				// (see call3)
				const known =
					typeof key === 'number' || (typeof key === 'string' && !named(key));
				target =
					known && isObject(target) && noWindow(target)
						? target
						: live(target, key);
				const value = target[key];
				const method = known && plain(value) ? value : api.get(value, key);

				if (typeof method === 'function')
					return Reflect.apply(method, target, args);
				if (links & 2 && nullish(method)) return undefined;
				return errors.call(method, target, args, partial);
			},
			// The lazy forms of get2, call2 and post, for a chain that can
			// short-circuit when its computed key or its arguments do work: the
			// rewriter emits `lazy(o)?.(k)`, `method(o, ...)?.(k)?.(...args)` and
			// `poster(o)?.(...args)`, so the browser's own optional call skips the
			// key and the arguments as the original chain did. Discord's login
			// renders `t?.messages[s.current % t.messages.length]` with `t`
			// undefined, which threw reading `t.messages` as a get2 argument.
			lazy: (target: any): ((key: any) => unknown) | undefined =>
				target === null || target === undefined
					? undefined
					: (key: any) => api.get2(target, key),
			method: (
				target: any,
				chained: boolean,
				optionalCall: boolean,
				partial?: string,
			): ((key: any) => ((...args: any[]) => any) | undefined) | undefined => {
				if (nullish(target)) {
					if (chained) return undefined;
					// the read throws once the key is known, as natively
					return (key: any) => {
						throw errors.read(target, key);
					};
				}
				return (key: any) => {
					key = keyOf(key);
					const holder = live(target, key);
					// (`w?.['post' + 'Message'](f())` posts like `w.postMessage`)
					const post = key === 'postMessage';
					const method = post ? holder[key] : api.get(holder[key], key);
					if (optionalCall && nullish(method)) return undefined;
					if (post)
						return (...args: any[]) =>
							posted(method, holder, args, optionalCall, partial);
					return (...args: any[]) =>
						typeof method === 'function'
							? Reflect.apply(method, holder, args)
							: errors.call(method, holder, args, partial);
				};
			},
			// `links` as for `post` (none given: both, as code rewritten
			// before they were told apart has it). The method is read once,
			// before the arguments are evaluated, as natively
			poster: (
				target: any,
				partial?: string,
				links?: number,
			): ((...args: any[]) => any) | undefined => {
				if (nullish(target)) {
					if (links === 1 || links === 3)
						throw errors.read(target, 'postMessage');
					return undefined;
				}
				const holder = live(target);
				const method = holder.postMessage;
				if (nullish(method) && links !== 1 && links !== 2) return undefined;
				return (...args: any[]) => posted(method, holder, args, false, partial);
			},
			/**
			 * `o[k](f())`, and `o[k]` as a template's tag: the method is read
			 * before the arguments are evaluated (what they do to the member
			 * comes too late for this call, and a null `o` throws before any of
			 * them runs), and called on the object
			 */
			fn2: (
				target: any,
				key: any,
				partial?: string,
			): ((...args: any[]) => any) => {
				if (nullish(target)) throw errors.read(target, key);
				key = keyOf(key);
				const holder = live(target, key);
				if (key === 'postMessage') {
					const method = holder[key];
					return (...args: any[]) =>
						posted(method, holder, args, false, partial);
				}
				const method = api.get(holder[key], key);
				return (...args: any[]) =>
					typeof method === 'function'
						? Reflect.apply(method, holder, args)
						: errors.call(method, holder, args, partial);
			},
			// `with (o) body` whose body says `postMessage` is printed
			// `with (scope(o)) with (scoped()) body`: the head as written, and
			// inside it a scope that answers that one name when the head is a
			// window of another realm (see get), nothing otherwise. `scoped`
			// is called as soon as the head is entered, with nothing of the
			// page's in between (no name is looked up to call it)
			scope: (object: unknown): unknown => {
				pendingScope = this.client.postScope?.(object) ?? NO_SCOPE;
				return object;
			},
			scoped: (): object => {
				const scope = pendingScope;
				pendingScope = NO_SCOPE;
				return scope;
			},
			evalScope: (code: unknown) => {
				// `eval(x)` with anything but a string returns x: handed back as it
				// is, the direct eval then returns it
				if (!isCode(code)) return code;
				return evaluated(code, () => evalSnapshot(code as string));
			},
			import: (baseURL: string | undefined, url: string): Promise<unknown> =>
				imported(
					// @ts-ignore
					import(/* webpackIgnore: true */ route(baseURL, url, undefined)),
				),
			// an import the page's code makes itself (with options)
			imported: (promise: Promise<unknown>): Promise<unknown> =>
				imported(promise),
			// the URL `import(url, options)` loads: the rewriter keeps the import
			// itself, with its options, in the page (see modifyJS)
			importRoute: (
				baseURL: string | undefined,
				url: string,
				options: unknown,
			): string => {
				let moduleType: unknown;
				try {
					moduleType = (options as { with?: { type?: unknown } } | undefined)
						?.with?.type;
				} catch (error) {
					// options that throw: the browser's import throws the same
				}
				return route(baseURL, url, moduleType);
			},
			// `const { top: t } = o`: a pattern cannot be rewritten key by key,
			// so the source is wrapped and every read of an unforgeable through
			// it resolves like a member read would. `spec` names the keys whose
			// values are destructured further (`{ a: { top } }`): those are
			// wrapped again, everything else is handed out as it is. A spec
			// `{ '{}': [...] }` tells the properties apart by their order (one
			// of them has a computed key), and `{ '[]': [...] }` is an array
			// pattern's, whose source is iterated. `partial`: the
			// destructuring's source (`{ top } = o`, '' for a parameter's), for
			// the error a null or undefined source throws
			pattern: (
				object: unknown,
				spec?: PatternSpec,
				partial?: string,
			): unknown => {
				if (partial !== undefined) errors.coerce(object, partial);
				if (
					(typeof object !== 'object' && typeof object !== 'function') ||
					object === null
				)
					return object;
				// `{ ...rest } = o`, `{ 0: w } = o`: a pattern that reads nothing
				// of any other object the helpers look at reads a window's
				// children (and its rest a window's `top` and `location`, a
				// document's `location`), so only those are wrapped
				if (spec?.['...'] === true && !copiesGuarded(object as object))
					return object;
				const elements = spec?.['[]'];
				if (isArray(elements)) return iterated(object, elements);
				const positions = spec?.['{}'];
				const ordered = isArray(positions) ? positions : undefined;
				// (the pattern reads each of its properties once, in order)
				let position = 0;
				const source = object as object;
				// The Proxy is over an object of its own, not over the source: a
				// Proxy asks its target for a property's descriptor after each
				// get, which a source that is a Proxy of the page's would see.
				// A pattern asks only these three things of what it destructures
				// (a rest element lists the keys and reads each descriptor), and
				// each is asked of the source once, as the pattern would ask it
				return wraps(
					new NativeProxy(create(null) as object, {
						ownKeys: () => Reflect.ownKeys(source),
						getOwnPropertyDescriptor: (_, key) => {
							const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
							// (as the Proxy's own target could have it: only whether it
							// is enumerable is read)
							if (descriptor) descriptor.configurable = true;
							return descriptor;
						},
						get: (_, key) => {
							const target = source;
							const value = api.get(
								Reflect.get(target, key),
								key,
								// (`{ postMessage } = parent`: a read of the window's, as
								// `{ 0: w } = window` is of a child it injects first)
								key === 'postMessage' || indexKey(key) ? target : undefined,
							);
							const nested = ordered
								? ordered[position++]
								: spec && typeof key === 'string'
									? spec[key]
									: undefined;
							return nested && nested !== true
								? api.pattern(value, nested as PatternSpec)
								: value;
						},
					}),
					source,
				);
			},
			/**
			 * The value of a pattern assignment whose source the access API
			 * wrapped (`r = ({ top: t } = o)`, `f([a, { top: t }] = list)`): the
			 * source itself, as the page's assignment answers it
			 */
			source: (value: unknown): unknown => {
				let source = value;
				// (an array pattern's is wrapped by `iter` and by `pattern`)
				while (isObject(source) && wrapped.has(source))
					source = wrapped.get(source);
				return source;
			},
			// whether a direct `eval(...)` calls the real eval (the rewriter's
			// test before it rewrites the code): a predicate, never the native
			// itself, which would run a page's code unrewritten, where its
			// `top` is the real one and reaches every proxied window
			isEval: (fn: unknown): boolean => fn === evalSnapshot,
			// the text a script the service worker rewrote hands over, for its
			// functions' sources (src/functionSource.ts)
			src: (key: unknown, subs: unknown, holder: unknown): void =>
				keepEmbedded(key, subs, holder),
		};

		// the realm's own to look at, where the bundle is another realm's
		// (before the freeze: adopt gives the object and its functions the
		// realm's prototypes)
		this.client.getModule(ProxyModule)?.adopt(api);
		// The helpers are not the page's to replace: a rewritten script hands
		// them the arrows it writes a member with, and a page that swapped one
		// would be handed a write nothing routes
		Object.freeze(api);
		this.client.accessApi = api;
		// Where a rewritten script reaches it (src/helperNames.ts
		// accessExpression): a property of the realm's Number.prototype, for
		// good. A page can neither redefine it nor bind a name in its way
		Reflect.defineProperty(
			this.client.global.Number.prototype,
			this.client.names.access,
			{ value: api, configurable: false, writable: false, enumerable: false },
		);
		accessHolders.add(this.client.global.Number.prototype);
		// and the global of that name, which hosts' hooks read (src/hooks.ts)
		// and nothing of the inject's does. Not enumerable: Object.keys(window)
		// must not name it
		Reflect.defineProperty(this.client.global, this.client.names.access, {
			value: api,
			configurable: true,
			writable: true,
			enumerable: false,
		});
	}
}
