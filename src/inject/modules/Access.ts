import { keepEmbedded } from '../../functionSource';
import { HelperNames } from '../../helperNames';
import { routeHTML } from '../../rewriteHTML';
import { isBareSpecifier, routeImport, UNDEFINABLE } from '../../scriptRoutes';
import StompURL, { urlLike } from '../../StompURL';
import Client from '../Client';
import ErrorMessages from '../errorMessages';
import Module from '../Module';
import { modifyJS } from '../rewriter';
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

type PatternSpec = { [key: string]: true | PatternSpec };

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
		const globalEval = (x: unknown) => {
			if (!isCode(x)) return x;
			return evalSnapshot(
				modifyJS(String(x), this.client.url, this.client.config, 'generic'),
			);
		};

		const globalEvalProxy = proxyModule?.wrapFunction(
			evalSnapshot,
			(target, that, [code]) => globalEval(code),
		);

		setGlobalProxy(evalSnapshot, 'eval', globalEvalProxy, this.client.names);

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
							new URL(url, baseURL || this.client.url.toString()),
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
				// key = this.normalize_key(key);
				// possibly a context

				// the client's global is not the page's to replace (see get)
				if (key === this.client.names.client) return righthand;

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
					set(
						routeHTML(
							new StompURL(
								new URL(<urlLike>value, this.client.url.toString()),
								this.client.url,
							),
							this.client.url,
							this.client.config,
							false,
							this.client.nestedRoute,
						),
					);
				} else {
					set(value);
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
			ref1: (target: any, set: (value: unknown) => unknown) => ({
				set value(value: unknown) {
					api.set1(
						target,
						'location',
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
			 * the .call / .apply / Reflect.apply forms): a Stomp window gets the
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
				const method = target.postMessage;
				if (optional && nullish(method)) return undefined;
				if (typeof method !== 'function')
					return errors.post(method, target, args, partial);
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
					: (key: any) => api.get(target[key], key, target),
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
					const method = api.get(target[key], key);
					if (optionalCall && nullish(method)) return undefined;
					return (...args: any[]) =>
						typeof method === 'function'
							? Reflect.apply(method, target, args)
							: errors.call(method, target, args, partial);
				};
			},
			poster: (
				target: any,
				partial?: string,
			): ((...args: any[]) => any) | undefined =>
				nullish(target) || nullish(target.postMessage)
					? undefined
					: (...args: any[]) => api.post(target, args, true, partial),
			evalScope: (code: unknown) => {
				// `eval(x)` with anything but a string returns x: handed back as it
				// is, the direct eval then returns it
				if (!isCode(code)) return code;
				return modifyJS(
					String(code),
					this.client.url,
					this.client.config,
					'generic',
				);
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
			// wrapped again, everything else is handed out as it is. `partial`:
			// the destructuring's source (`{ top } = o`, '' for a parameter's),
			// for the error a null or undefined source throws
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
				return new Proxy(object as object, {
					get: (target, key) => {
						const value = api.get(Reflect.get(target, key), key);
						const nested =
							spec && typeof key === 'string' ? spec[key] : undefined;
						return nested && nested !== true
							? api.pattern(value, nested)
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
