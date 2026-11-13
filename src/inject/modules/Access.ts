import { keepEmbedded } from '../../functionSource';
import { HelperNames } from '../../helperNames';
import { routeHTML } from '../../rewriteHTML';
import { isBareSpecifier, routeImport, UNDEFINABLE } from '../../scriptRoutes';
import StompURL, { urlLike } from '../../StompURL';
import Client from '../Client';
import ErrorMessages from '../errorMessages';
import Module from '../Module';
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

		const route = (
			baseURL: string | undefined,
			url: string,
			moduleType: unknown,
		): string =>
			isBareSpecifier(String(url))
				? url
				: routeImport(
						new StompURL(
							new URL(url, baseURL || this.client.baseURL.toString()),
							this.client.url,
						),
						this.client.url,
						this.client.config,
						'genericModule',
						moduleType,
					);
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
		const iterated = (source: any, specs: unknown[]): unknown => {
			const method = source[Symbol.iterator];
			// not iterable: the pattern's own error
			if (typeof method !== 'function') return source;
			return {
				[Symbol.iterator]: () => {
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
							if (Array.isArray(spec)) {
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
			};
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
					if (
						typeof target === 'object' &&
						target !== null &&
						target.window === target
					)
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
		const api = {
			get2: (
				target: any,
				key: any,
				_partial?: string,
				optional?: boolean,
			): unknown => {
				if (nullish(target)) {
					// a?.[k]
					if (optional) return undefined;
					throw errors.read(target, key);
				}

				key = keyOf(key);
				target = live(target, key);
				return api.get(target[key], key, target);
			},
			// `container`: what `object` was read from, when the read is a member
			// read (a window's child is injected before the page gets it)
			get: (object: any, key: any, container?: unknown): any => {
				// the client, by its name, is nothing to a page: it holds the
				// real windows the inject works with, and a page that read it
				// would reach every proxied site that frames it. The rewriter
				// routes every mention of the name here, and reflection's reads
				// come here too, so knowing the name (a same-site frame's shell
				// shows it while it loads) gives a page nothing
				if (key === this.client.names.client) return undefined;
				// another window's postMessage, read and not called: the page
				// gets a function of this realm for it, so a call of it later
				// (bound, detached, handed to `call`) posts from this realm,
				// which the browser names as the source
				if (key === 'postMessage' && container !== undefined) {
					const own = this.client.postMessageOf?.(container);
					if (own) return own;
				}
				try {
					if (key === 'top' && this.client.resolveTop)
						return this.client.resolveTop(object);

					if (
						typeof key === 'string' &&
						UNDEFINABLE.includes(key) &&
						((typeof object === 'object' && object !== null) ||
							typeof object === 'function') &&
						this.client.names.globalProxy in object
					) {
						const standIn = object[this.client.names.globalProxy];
						return key === 'location' && this.client.gateLocation
							? this.client.gateLocation(object, standIn)
							: standIn;
					}
				} catch (error) {
					// error was thrown during an accessor
					// should not be introduced into normal execution
				}

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

				if (typeof key === 'string') {
					// `document.location = url` is `window.location = url`
					const isDocument =
						typeof target === 'object' &&
						target !== null &&
						target === (this.client.global as any).document;
					if (target === this.client.global || isDocument) {
						if (key === 'location') {
							// this client's location: an about:blank child runs its
							// creator's bundle, whose free `location` is the creator's
							target = (this.client.global.location as any)[
								this.client.names.globalProxy
							];
							key = 'href';
						}
					} else {
						let foreign = false;
						try {
							foreign =
								((typeof target === 'object' && target !== null) ||
									typeof target === 'function') &&
								this.client.names.access in target &&
								target[this.client.names.access]!.set2 !== api.set2;
						} catch (error) {
							// a cross-origin window: nothing of ours to delegate to
						}
						if (foreign && key === 'location')
							this.client.gateNavigation?.(target, righthand);
						if (foreign)
							return target[this.client.names.access]!.set2(
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
					(typeof key === 'number'
						? Number.isInteger(key) && key >= 0
						: typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) &&
					!Array.isArray(target) &&
					'selectedIndex' in target
				)
					return this.client.landIndexed(target, righthand, () =>
						operate(api.get(target, key), key, righthand),
					);

				return operate(api.get(target, key), key, righthand);
			},
			set1: (
				target: any,
				name: any,
				operate: any,
				set: any,
				righthand: any,
			) => {
				// name = normalizeKey(name);
				const property = Symbol();
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
			/** `[top.location] = a`: the member form of `ref1`, routed by set2 */
			ref2: (target: any, key: any) => ({
				set value(value: unknown) {
					api.set2(
						target,
						key,
						(object: any, property: any, v: unknown) => {
							object[property] = v;
						},
						value,
					);
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
				const property = Symbol();
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
				target = live(target, key);
				const object = api.get(target[key], key, target);
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
				optional?: boolean,
				partial?: string,
			): any => {
				if (nullish(target)) {
					if (optional) return undefined;
					throw errors.read(target, 'postMessage');
				}
				target = live(target);
				return posted(target.postMessage, target, args, optional, partial);
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
				target = live(target, key);

				const method = api.get(target[key], key);

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
			poster: (
				target: any,
				partial?: string,
			): ((...args: any[]) => any) | undefined =>
				nullish(target) || nullish(target.postMessage)
					? undefined
					: (...args: any[]) => api.post(target, args, true, partial),
			// `with (o) body` whose body says `postMessage` is printed
			// `{ const w = scope(o); with (w[0]) with (w[1]) body }`: the head
			// as written, and inside it a scope that answers that one name
			// when the head is a window of another realm (see get), nothing
			// otherwise
			scope: (object: unknown): [unknown, object] => [
				object,
				this.client.postScope?.(object) ?? NO_SCOPE,
			],
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
				const elements = spec?.['[]'];
				if (Array.isArray(elements)) return iterated(object, elements);
				const positions = spec?.['{}'];
				const ordered = Array.isArray(positions) ? positions : undefined;
				// (the pattern reads each of its properties once, in order)
				let position = 0;
				return new Proxy(object as object, {
					get: (target, key) => {
						const value = api.get(
							Reflect.get(target, key),
							key,
							// (`{ postMessage } = parent`: a read of the window's)
							key === 'postMessage' ? target : undefined,
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
				});
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

		// not enumerable: Object.keys(window) must not name it
		Reflect.defineProperty(this.client.global, this.client.names.access, {
			value: api,
			configurable: true,
			writable: true,
			enumerable: false,
		});
	}
}
