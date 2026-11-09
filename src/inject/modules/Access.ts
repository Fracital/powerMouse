import { HelperNames } from '../../helperNames';
import { routeHTML } from '../../rewriteHTML';
import {
	isBareSpecifier,
	modifyJS,
	postMessageMethod,
	routeImport,
	UNDEFINABLE,
} from '../../rewriteJS';
import StompURL, { urlLike } from '../../StompURL';
import Client from '../Client';
import Module from '../Module';
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
		const api = {
			get2: (
				target: any,
				key: any,
				_partial?: string,
				optional?: boolean,
			): unknown => {
				// a?.[k]
				if (optional && (target === null || target === undefined))
					return undefined;

				return api.get(target[key], key, target);
			},
			// `container`: what `object` was read from, when the read is a member
			// read (a window's child is injected before the page gets it)
			get: (object: any, key: any, container?: unknown): any => {
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
						return object[this.client.names.globalProxy];
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

				if (
					typeof target === 'object' &&
					target !== null &&
					target[this.client.names.globalName] === 'location'
				) {
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
			new2: (target: any, key: any, args: any): any => {
				// key = normalizeKey(key);
				return Reflect.construct(api.get(target[key], key), args);
			},
			/**
			 * `x.postMessage(...)` (the rewriter routes every such call here, and
			 * the .call / .apply / Reflect.apply forms): a Stomp window gets the
			 * message through its own native postMessage called from this realm,
			 * so this context is the incumbent the browser reports as the
			 * source, with an envelope carrying this context's real origin;
			 * anything else (a port, a worker, a plain object, a restricted
			 * window) is called as written.
			 */
			post: (target: any, args: any[], optional?: boolean): any => {
				const method = postMessageMethod(target, optional);
				if (method === undefined) return undefined;
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
				_partial?: string,
				optional?: boolean,
			): any => {
				// a?.[k](...) / a[k]?.(...)
				if (optional && (target === null || target === undefined))
					return undefined;

				const method = api.get(target[key], key);

				if (optional && (method === null || method === undefined))
					return undefined;

				return Reflect.apply(method, target, args);
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
			): ((key: any) => ((...args: any[]) => any) | undefined) | undefined => {
				if (chained && (target === null || target === undefined))
					return undefined;
				return (key: any) => {
					const method = api.get(target[key], key);
					if (optionalCall && (method === null || method === undefined))
						return undefined;
					return (...args: any[]) => Reflect.apply(method, target, args);
				};
			},
			poster: (target: any): ((...args: any[]) => any) | undefined =>
				postMessageMethod(target, true) === undefined
					? undefined
					: (...args: any[]) => api.post(target, args, true),
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
			// wrapped again, everything else is handed out as it is
			pattern: (object: unknown, spec?: PatternSpec): unknown => {
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
			evalSnapshot,
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
