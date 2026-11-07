import { routeHTML } from '../../rewriteHTML';
import {
	ACCESS_KEY,
	CLIENT_KEY,
	GLOBAL_NAME,
	GLOBAL_PROXY,
	isBareSpecifier,
	modifyJS,
	routeJS,
	UNDEFINABLE,
} from '../../rewriteJS';
import StompURL, { urlLike } from '../../StompURL';
import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

/*
// why was this necessary?
function normalizeKey(key: unknown): string|unknown {
	if (typeof key === 'string') {
		return key;
	} else if(typeof key === 'u') {
		return '';
	}
}*/

export function setGlobalProxy(object: any, name: string, proxy: unknown) {
	// the tags never show in the page's own enumeration
	for (const [key, value] of [
		[GLOBAL_PROXY, proxy],
		[GLOBAL_NAME, name],
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

		setGlobalProxy(evalSnapshot, 'eval', globalEvalProxy);

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

				return api.get(target[key], key);
			},
			get: (object: any, key: any): any => {
				try {
					if (key === 'top' && this.client.resolveTop)
						return this.client.resolveTop(object);

					if (
						typeof key === 'string' &&
						UNDEFINABLE.includes(key) &&
						((typeof object === 'object' && object !== null) ||
							typeof object === 'function') &&
						GLOBAL_PROXY in object
					) {
						return object[GLOBAL_PROXY];
					}
				} catch (error) {
					// error was thrown during an accessor
					// should not be introduced into normal execution
				}

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
							target = (this.client.global.location as any)[GLOBAL_PROXY];
							key = 'href';
						}
					} else {
						let foreign = false;
						try {
							foreign =
								((typeof target === 'object' && target !== null) ||
									typeof target === 'function') &&
								ACCESS_KEY in target &&
								target[ACCESS_KEY]!.set2 !== api.set2;
						} catch (error) {
							// a cross-origin window: nothing of ours to delegate to
						}
						if (foreign)
							return target[ACCESS_KEY]!.set2(target, key, operate, righthand);
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
				const proxy = api.get(target, name);

				const property = Symbol();
				const object = {
					[property]: proxy,
				};

				const result = operate(object, property, righthand);
				const value = object[property];

				if (
					typeof target === 'object' &&
					target !== null &&
					target[GLOBAL_NAME] === 'location'
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
				if (optional && (target === null || target === undefined))
					return undefined;
				const method = target?.postMessage;
				if (optional && (method === null || method === undefined))
					return undefined;
				if (this.client.postToWindow) {
					let receiver: Client | undefined;
					try {
						if (
							typeof target === 'object' &&
							target !== null &&
							target.window === target
						)
							receiver = target[CLIENT_KEY];
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
			import: (baseURL: string | undefined, url: string): Promise<unknown> => {
				// bare specifiers belong to the page's import map
				if (isBareSpecifier(String(url)))
					return import(/* webpackIgnore: true */ url);
				// @ts-ignore
				return import(
					/* webpackIgnore: true */
					routeJS(
						new StompURL(
							new URL(url, baseURL || this.client.url.toString()),
							this.client.url,
						),
						this.client.url,
						this.client.config,
						'genericModule',
					)
				);
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
		Reflect.defineProperty(this.client.global, ACCESS_KEY, {
			value: api,
			configurable: true,
			writable: true,
			enumerable: false,
		});
	}
}
