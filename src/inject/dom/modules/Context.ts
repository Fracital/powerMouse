import { routeHTML } from '../../../rewriteHTML';
import StompURL, { urlLike } from '../../../StompURL';
import Client from '../../Client';
import Module from '../../Module';
import ProxyModule, {
	applyDescriptors,
	catchRequiredArguments,
	usePrototype,
} from '../../modules/Proxy';
import { routedPrefix } from '../../modules/Unroute';
import { withStack } from '../../nativeErrors';
import { nativeFunction } from '../../nativeUtil';
import { getDomain } from '../../rewriter';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { siteKeyOf } from '../site';

export function sameHost(first: string, second: string): boolean {
	const a = getDomain(first);
	const b = getDomain(second);
	// tldts returns null for IPs / localhost; fall back to exact host match
	return a !== null && b !== null ? a === b : first === second;
}

function removeBlob(protocol: string): string {
	return protocol.startsWith('blob:') ? protocol.slice(5) : protocol;
}

export function sameOrigin(first: string, second: string): boolean {
	const firstURL = new URL(first);
	const secondURL = new URL(second);
	return (
		removeBlob(firstURL.protocol) === removeBlob(secondURL.protocol) &&
		firstURL.port === secondURL.port &&
		sameHost(firstURL.host, secondURL.host)
	);
}

// taken before the page runs: a page may replace the global
const NativeWeakRef = WeakRef;

/** whether a frame's window is still on the initial about:blank its creation gave it */
export function initialBlank(context: typeof globalThis): boolean {
	try {
		return context.location.href === 'about:blank';
	} catch (error) {
		return false;
	}
}

/** whether a window runs Stomp (a cross-origin one throws on the check) */
export function isStomp(value: unknown, client: string): boolean {
	try {
		return (
			typeof value === 'object' && value !== null && client in (value as object)
		);
	} catch (error) {
		return false;
	}
}

/**
 * The child window `context` exposes by `name` (its browsing context name),
 * read from the named properties object, so neither a global of that window
 * nor an accessor the Context module put on its Window.prototype answers.
 */
function childNamed(context: Context, name: string): Context | undefined {
	try {
		const prototype = Reflect.getPrototypeOf(context);
		const named = prototype && Reflect.getPrototypeOf(prototype);
		if (!named) return undefined;
		const value = Reflect.getOwnPropertyDescriptor(named, name)?.value;
		if (typeof value !== 'object' || value === null) return undefined;
		for (let index = 0; index < context.length; index++)
			if ((context as unknown as Record<number, unknown>)[index] === value)
				return value as Context;
	} catch (error) {
		// a window of another real origin
	}
	return undefined;
}

function findTop(global: typeof globalThis, client: string): Context {
	let context: Context = global;

	// walk up while the parent is still a Stomp context; the controller page
	// (or anything cross-origin) ends the proxied world
	while (true) {
		try {
			const parent = (
				(context as Record<string, any>)[client] as DocumentClient
			).parent;
			if (parent === context || !(client in parent)) return context;
			context = parent;
		} catch (error) {
			return context;
		}
	}
}

type PostMessageArgs = [
	message: any,
	targetOrigin: string,
	transfer?: Transferable[],
];

type PostMessageArgs2 = [message: any, options?: WindowPostMessageOptions];

function isPostMessageArgs2(
	args: PostMessageArgs | PostMessageArgs2,
): args is PostMessageArgs2 {
	return args.length === 2;
}

type Context = typeof globalThis;

/** the nested route marker of a Stomp window (its top origin when it is a child of a proxied page) */
function nestedRouteOf(context: Context, client: string): string | false {
	try {
		return (
			((context as Record<string, any>)[client] as DocumentClient | undefined)
				?.nestedRoute ?? false
		);
	} catch (error) {
		return false;
	}
}
type RestrictedContext = typeof globalThis;

const nativeMessageEvent: MessageEvent = Object.create({});

applyDescriptors(nativeMessageEvent, MessageEvent.prototype);

/** a message between Stomp contexts: the envelope key is the deployment's globalName helper */
interface MessageData {
	data: any;
	origin: string;
	[marker: string]: unknown;
}

function isMessageData(data: any, globalName: string): data is MessageData {
	return (
		typeof data === 'object' &&
		data !== null &&
		data[globalName] === 'stompMessage'
	);
}

interface ParsedPostMessageArgs {
	data: any;
	transfer: Transferable[];
	targetOrigin: string;
}

export default class ContextModule extends Module<DocumentClient> {
	restricted: WeakMap<Context, RestrictedContext>;
	restrictedContexts: WeakMap<RestrictedContext, Context>;
	/**
	 * Windows this realm already holds as themselves (one it opened, a frame
	 * it reached while that frame was of its origin): a window keeps its
	 * identity when it navigates, so `event.source`, `contentWindow` and
	 * `opener` stay the object the page compares them with. The page holds
	 * that object already; handing it out again gives it nothing new.
	 */
	held: WeakSet<Context>;
	constructor(client: DocumentClient) {
		super(client);
		this.restricted = new WeakMap();
		this.restrictedContexts = new WeakMap();
		this.held = new WeakSet();
	}
	/** a window this realm now holds as itself (see `held`) */
	hold(context: Context) {
		this.held.add(context);
	}
	restrictObject(
		// the interface the browser names in its errors
		name: 'Window' | 'Location',
		interfaces: PropertyDescriptorMap,
		// a cross-origin window's child browsing contexts by index
		indexed?: (index: number) => unknown,
		// and by name, which the browser lets another origin read too
		named?: (name: string) => unknown,
	) {
		const restricted = {};

		Reflect.setPrototypeOf(restricted, null);

		for (const unknown of [
			'then',
			Symbol.toStringTag,
			Symbol.hasInstance,
			Symbol.isConcatSpreadable,
		])
			Reflect.defineProperty(restricted, unknown, {
				value: undefined,
				writable: false,
				enumerable: false,
				configurable: false,
			});

		// the browser's SecurityError: a read or a write names the property,
		// anything else only the frame
		const accessError = (access?: 'read' | 'set', prop?: string | symbol) => {
			const blocked = `Blocked a frame with origin "${this.client.origin}" from accessing a cross-origin frame.`;
			const key =
				typeof prop === 'symbol' ? `[${prop.description ?? ''}]` : prop;
			return withStack(
				new this.client.global.DOMException(
					access === 'read'
						? `Failed to read a named property '${key}' from '${name}': ${blocked}`
						: access === 'set'
							? `Failed to set a named property '${key}' on '${name}': ${blocked}`
							: blocked,
					'SecurityError',
				),
				access ? 1 : 0,
			);
		};
		const indexOf = (prop: string | symbol): number | undefined =>
			indexed && typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)
				? Number(prop)
				: undefined;
		const child = (prop: string | symbol): unknown => {
			const index = indexOf(prop);
			if (index !== undefined) return indexed!(index);
			return named && typeof prop === 'string' ? named(prop) : undefined;
		};

		for (const key in interfaces) {
			const descriptor = interfaces[key];

			if (descriptor.value) {
				descriptor.writable = false;

				if (typeof descriptor.value === 'function')
					this.restrictFunction(descriptor.value);
			}

			if (descriptor.get)
				descriptor.get = this.restrictFunction(descriptor.get);

			if (descriptor.set)
				descriptor.set = this.restrictFunction(descriptor.set);

			Reflect.defineProperty(restricted, key, descriptor);
		}

		const proxy = new Proxy(restricted, {
			get: (target, prop, receiver) => {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);

				if (
					!descriptor ||
					(!('value' in descriptor) && typeof descriptor.get !== 'function')
				) {
					const found = descriptor ? undefined : child(prop);
					if (found !== undefined) return found;
					throw accessError('read', prop);
				}

				return Reflect.get(target, prop, receiver);
			},
			set: (target, prop, value) => {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);

				if (!descriptor || typeof descriptor.set !== 'function') {
					throw accessError('set', prop);
				}

				return Reflect.set(target, prop, value);
			},
			defineProperty: () => {
				throw accessError();
			},
			getOwnPropertyDescriptor: (target, prop) => {
				if (!(prop in target)) throw accessError('read', prop);
				return Reflect.getOwnPropertyDescriptor(target, prop);
			},
			setPrototypeOf: () => {
				throw accessError();
			},
			has: (target, prop) => {
				if (!(prop in target)) {
					if (child(prop) !== undefined) return true;
					throw accessError();
				}
				return true;
			},
		});

		return proxy;
	}

	restrictFunction<T extends Function>(target: T): T {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const wrapped = proxyModule.wrapFunction(target, (target, that, args) => {
			return Reflect.apply(target, that, args);
		});

		proxyModule.functionStrings.set(wrapped, nativeFunction(target.name));

		return wrapped;
	}
	/**
	 * The target origin the proxy's own delivery names to the browser, which
	 * checks it against the receiver's real origin: the receiver's own (the
	 * proxy origin every proxied window shares, an about:srcdoc or
	 * about:blank child's inherited one), so the envelope reaches nothing
	 * outside the proxied world, and "*" for a receiver the browser made
	 * opaque, which no origin names. It was the realm's location.origin,
	 * which reads "null" in an opaque or about:srcdoc document: Chrome
	 * refuses that ("Invalid target origin 'null'"), and LinkedIn's frames
	 * threw it. A receiver this realm cannot reach is named by the proxy
	 * origin. Whether the page's own target origin lets the message through
	 * is decided by the real origins (targetAllows).
	 */
	deliveryOrigin(receiver: Context): string {
		let origin: string | undefined;
		try {
			const client = (receiver as Record<string, any>)[
				this.client.names.client
			] as DocumentClient | undefined;
			origin = client?.realOrigin();
		} catch (error) {
			// a window of another real origin
		}
		if (origin === undefined) return new URL(routedPrefix(this.client)).origin;
		return origin === 'null' ? '*' : origin;
	}
	postMessage(
		args: PostMessageArgs | PostMessageArgs2,
		receiver: Context,
	): PostMessageArgs | PostMessageArgs2 {
		/*if (!this.RestrictedContexts.has(targetWindow)) {
			throw new TypeError('Illegal invocation');
		}*/

		// const window = this.RestrictedContexts.get(targetWindow)!;

		/*window.dispatchEvent(new MessageEvent('message', {
			data: message,
			origin: this.client.base.toOrigin(),
			source: global,
		}));*/

		/*if (targetOrigin !== undefined) {
			const { origin } = new URL(targetOrigin, this.client.url.toString());

			console.assert(
				(window as Record<string, any>)[this.client.names.client].url.url.toOrigin() === origin,
				'Bad origin',
				window[global_client].base.toOrigin(),
				origin
			);
		}*/

		const message: ParsedPostMessageArgs = isPostMessageArgs2(args)
			? {
					data: args[0],
					transfer: Array.isArray(args[1]?.transfer) ? args[1]!.transfer : [],
					targetOrigin: args[1] ? String(args[1]) : '*',
				}
			: {
					data: args[0],
					transfer: Array.isArray(args[2]) ? args[2] : [],
					targetOrigin: args[1] ? String(args[1]) : '*',
				};

		return <PostMessageArgs2>[
			<MessageData>{
				[this.client.names.globalName]: 'stompMessage',
				data: message.data,
				origin: this.client.origin,
			},
			{
				targetOrigin: this.deliveryOrigin(receiver),
				transfer: message.transfer,
			},
		];
	}
	/**
	 * Whether a message with these arguments reaches `receiver`, judged by
	 * the real origins the way the browser judges real ones (every proxied
	 * window shares the proxy origin, so the browser's own check passes them
	 * all): `*` reaches any, `/` the sender's own origin, anything else must
	 * be the receiver's origin. An opaque origin is the same only as itself:
	 * "/" from an opaque document reaches that document alone, and a named
	 * origin never reaches an opaque one. An unparsable target origin
	 * ("null" included) is the browser's SyntaxError.
	 */
	targetAllows(args: unknown[], receiver: Context): boolean {
		const second = args[1];
		const requested =
			typeof second === 'object' && second !== null
				? (second as WindowPostMessageOptions).targetOrigin
				: second;
		const target = requested === undefined ? '/' : String(requested);
		if (target === '*') return true;
		let receiverOrigin: string;
		let receiverClient: DocumentClient;
		try {
			const client = (receiver as Record<string, any>)[
				this.client.names.client
			] as DocumentClient | undefined;
			if (!client) return true;
			receiverClient = client;
			receiverOrigin = client.origin;
		} catch (error) {
			return true;
		}
		if (target === '/' && this.client.origin === 'null')
			return receiverClient === this.client;
		const wanted =
			target === '/'
				? this.client.origin
				: (() => {
						try {
							return new URL(target).origin;
						} catch (error) {
							throw new this.client.global.DOMException(
								"Failed to execute 'postMessage' on 'Window': Invalid target origin '" +
									target +
									"' in a call to 'postMessage'.",
								'SyntaxError',
							);
						}
					})();
		return wanted !== 'null' && wanted === receiverOrigin;
	}
	/**
	 * Navigate `context` (a window behind a restricted stand-in) to the
	 * page's `value`. A sandboxed document navigates only what it may
	 * (DocumentClient.mayNavigate); the one it may but the browser would not
	 * let it (the proxied top, an ancestor of its real frame) is navigated by
	 * that window's own realm, as a navigation the target starts.
	 */
	#navigate(context: Context, value: urlLike, member: 'replace' | 'href') {
		const destination = new URL(value, this.client.url.toString());
		if (!this.client.mayNavigate(context))
			throw this.client.navigationRefused(
				member,
				member === 'replace',
				destination,
			);
		const routed = routeHTML(
			new StompURL(destination, this.client.url),
			this.client.url,
			this.client.config,
			false,
			nestedRouteOf(context, this.client.names.client),
		);
		const target = (context as Record<string, any>)[
			this.client.names.client
		] as DocumentClient | undefined;
		if (this.client.sandboxFlags !== null && target)
			target.callIn(context.location.replace, context.location, [routed]);
		else context.location.replace(routed);
	}
	/**
	 * Post to `receiver` with this client's window as the incumbent the
	 * browser names as the event's source: its own native postMessage,
	 * called through a function of its realm. The bundle's free
	 * `postMessage` is the realm the bundle was loaded in, which for a
	 * client another page injected (a frame's initial about:blank, kept for
	 * the document of its src) is that page's: its messages named the
	 * framing page as their source.
	 */
	#postFromHere(receiver: Context, args: unknown[]) {
		return this.client.callIn(
			this.client.nativePostMessage ?? this.client.global.postMessage,
			receiver,
			this.postMessage(<any>args, receiver),
		);
	}
	restrictContext(context: Context): RestrictedContext {
		const proxyModule = this.client.getModule(ProxyModule)!;
		// a child that runs no Stomp yet (an iframe still on its initial
		// about:blank) is still that child, of the frame's origin: never the
		// top, which a walk down the tree would visit again forever
		const restrictChild = (child: Context) =>
			isStomp(child, this.client.names.client)
				? this.newRestricted(child)
				: this.restrictOpaque(child);

		const restrictedLocation = this.restrictObject('Location', {
			replace: {
				value: (url: urlLike) => {
					this.#navigate(context, url, 'replace');
				},
			},
			href: {
				set: (value: urlLike) => {
					this.#navigate(context, value, 'href');
				},
			},
		});

		const res = <any>this.restrictObject(
			'Window',
			{
				// read from the real windows, not through the context's own
				// getters: those answer with its view (its own stand-ins), and a
				// climb by `parent` compares what it reaches with this page's `top`
				top: {
					get: () =>
						this.newRestricted(findTop(context, this.client.names.client)),
				},
				parent: {
					get: () => {
						let parent: Context;
						try {
							parent = (
								(context as Record<string, any>)[
									this.client.names.client
								] as DocumentClient
							).parent;
						} catch (error) {
							return this.newRestricted(<Context>(<unknown>context.parent!));
						}
						// the top of the proxied world is its own parent
						return this.newRestricted(
							isStomp(parent, this.client.names.client) ? parent : context,
						);
					},
				},
				opener: {
					get: () => this.newRestricted(<Context>(<unknown>context.opener!)),
				},
				self: {
					get: () => res,
				},
				frames: {
					get: () => res,
				},
				window: {
					get: () => res,
				},
				blur: {
					value: () => context.blur(),
				},
				focus: {
					value: () => context.focus(),
				},
				close: {
					value: () => context.close(),
				},
				closed: {
					get: () => context.closed,
				},
				length: {
					get: () => context.length,
				},
				location: {
					get: () => restrictedLocation,
					set: (value: urlLike) => {
						this.#navigate(context, value, 'href');
					},
				},
				postMessage: {
					value: proxyModule.wrapFunction(
						this.client.global.postMessage,
						(target, that, args) => {
							catchRequiredArguments(args.length, 1, 'Window', 'postMessage');
							if (!this.targetAllows(args, context)) return;
							return this.#postFromHere(context, args);
						},
					),
				},
			},
			// its frames, by index: cross-origin reads of them are allowed,
			// and each is another window of this world or outside it
			(index) => {
				const child = (
					context as unknown as Record<number, Context | undefined>
				)[index];
				if (!child) return undefined;
				return restrictChild(child);
			},
			// and by name (`parent.sibling`): only a child window the browser
			// names, never another of the window's globals
			(name) => {
				const child = childNamed(context, name);
				return child === undefined ? undefined : restrictChild(child);
			},
		);

		return res;
	}
	/**
	 * The stand-in for a frame showing an opaque (data:) document: restricted
	 * like a frame of another origin, whatever runs in it, and never injected
	 * from this side (see DOMAttributes' opaqueDocument).
	 */
	restrictOpaque(context: Context): RestrictedContext {
		if (!this.restricted.has(context)) {
			const restricted = this.restrictContext(context);
			this.restricted.set(context, restricted);
			this.restrictedContexts.set(restricted, context);
		}
		return this.restricted.get(context)!;
	}
	/**
	 * A window whose next document is of another site (the window
	 * `window.open(url)` returns, a frame's contentWindow read while the
	 * document its src names is on the way): its stand-in from the start.
	 * Every proxied site shares the real origin, so the raw window the page
	 * would hold now is that other site's window once its document arrives.
	 * A window the page already holds is handed back as it is.
	 */
	pending(context: Context, url: unknown): RestrictedContext {
		if (this.held.has(context)) return context;
		let target: URL | undefined;
		try {
			target = new URL(String(url), this.client.url.toString());
		} catch (error) {
			// no URL: the window's own document decides
		}
		if (
			target === undefined ||
			!/^https?:$/.test(target.protocol) ||
			sameOrigin(this.client.url.toString(), target.href)
		)
			return this.newRestricted(context);
		return this.restrictOpaque(context);
	}
	newRestricted(context: Context): RestrictedContext {
		// a cross-origin window (the host application in isolation mode) throws
		// on the `in` check; it is never a Stomp context
		if (!isStomp(context, this.client.names.client))
			// the proxied world ends here (the host, or anything it opened):
			// present ourselves as the top, as this page sees it (a frame of
			// another origin gets its stand-in, as for `top`)
			context = findTop(this.client.global, this.client.names.client);

		if (this.held.has(context)) return context;

		// an opaque origin (a document the page sandboxed without
		// allow-same-origin) is another origin to every other document, and
		// every other document is to it
		let opaque = false;
		try {
			opaque =
				context !== this.client.global &&
				(this.client.sandboxedOpaque ||
					(
						(context as Record<string, any>)[
							this.client.names.client
						] as DocumentClient
					).sandboxedOpaque);
		} catch (error) {
			// a window being torn down
		}

		// the documents' site keys, kept per document: this runs on every read
		// of another window, and decoding both routed URLs for each read
		// (about 20 us) let the ad frames of a crazygames game page, about 200
		// walking the frame tree, keep the renderer's main thread busy for
		// good. An opaque URL (a data: document) has no key: its URLs decide.
		const other = (context as any)[this.client.names.client] as DocumentClient;
		const mine = this.client.siteKey;
		const theirs = other.siteKey;
		if (
			!opaque &&
			(mine !== null && theirs !== null
				? mine === theirs
				: sameOrigin(this.client.url.toString(), other.url.toString()))
		) {
			this.held.add(context);
			return context;
		}

		if (!this.restricted.has(context)) {
			// one stand-in per window for every document of an origin: a frame
			// hands its same-origin parent's windows to its own code as they
			// are, so the stand-ins that parent's getters return must be the
			// ones this page's own reads return, or `t = t.parent` never
			// reaches `top` (rubiconproject's usync in imgur's ad frames)
			const standIns = (
				(context as Record<string, any>)[this.client.names.client] as
					DocumentClient | undefined
			)?.standIns;
			// (never a sandboxed document's: its stand-ins hold its sandbox's
			// limits, which another document of the site does not share)
			const key =
				this.client.sandboxFlags === null
					? siteKeyOf(this.client.url.toString())
					: null;
			let restricted = key === null ? undefined : standIns?.get(key)?.deref();
			if (!restricted) {
				restricted = this.restrictContext(context);
				if (key !== null) standIns?.set(key, new NativeWeakRef(restricted));
			}

			this.restricted.set(context, restricted);
			this.restrictedContexts.set(restricted, context);
		}

		return this.restricted.get(context)!;
	}
	/**
	 * A child window by its name (`frames.kid`, `window['kid']`, a bare
	 * `kid`): the browser answers from the window's named properties, which
	 * no rewrite sees, with the raw window of whatever site the child shows.
	 * Each child tells its parent its name (when it loads and when it names
	 * itself), and the parent puts an accessor of that name on its
	 * Window.prototype, ahead of the named properties object: it reads the
	 * browser's answer and hands it out through `restrictForeign`. A global
	 * of the page by that name stays ahead of it, as natively. (A document's
	 * named iframe, `document.kid`, cannot be covered this way: the document's
	 * named properties come before anything that could be defined.)
	 */
	exposeNames(proxyModule: ProxyModule) {
		const global = this.client.global;
		const exposed = new Set<string>();
		const accessor = (
			name: string,
			get: (that: unknown) => unknown,
			set: (that: unknown, value: unknown) => void,
		): PropertyDescriptor => {
			const getter = proxyModule.wrapFunction(
				function () {},
				(target, that) => get(that),
			);
			const setter = proxyModule.wrapFunction(
				function (_value: unknown) {},
				(target, that, args) => set(that, args[0]),
			);
			proxyModule.functionStrings.set(getter, nativeFunction(`get ${name}`));
			proxyModule.functionStrings.set(setter, nativeFunction(`set ${name}`));
			return {
				configurable: true,
				enumerable: false,
				get: getter,
				set: setter,
			};
		};
		const restrict = (value: unknown, container?: unknown) =>
			this.client.restrictForeign
				? this.client.restrictForeign(value, container)
				: value;
		const windowPrototype = global.Window.prototype;
		const named = Reflect.getPrototypeOf(windowPrototype);
		this.client.exposeChild = (name) => {
			if (exposed.has(name)) return;
			exposed.add(name);
			// never ahead of a member the browser itself puts before the names
			if (
				named &&
				!Reflect.getOwnPropertyDescriptor(windowPrototype, name) &&
				!Reflect.has(Reflect.getPrototypeOf(named) ?? {}, name)
			)
				Reflect.defineProperty(
					windowPrototype,
					name,
					accessor(
						name,
						(that) => restrict(Reflect.get(named, name, that), that),
						// an assignment makes a global of the page, as natively
						(that, value) => {
							Reflect.defineProperty(that as object, name, {
								value,
								writable: true,
								enumerable: true,
								configurable: true,
							});
						},
					),
				);
		};

		// the named properties object itself (Window.prototype's prototype)
		// answers every name: the page reaches it through a stand-in whose
		// reads are restricted the same way
		if (named) {
			const namedStandIn = new Proxy(named, {
				get: (target, key) => restrict(Reflect.get(target, key, target)),
				getOwnPropertyDescriptor: (target, key) => {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
					if (descriptor && 'value' in descriptor)
						descriptor.value = restrict(descriptor.value);
					return descriptor;
				},
			});
			const prototypeOf = <T extends (...args: any[]) => any>(target: T): T =>
				proxyModule.wrapFunction(target, (target, that, args) => {
					const prototype = Reflect.apply(target, that, args);
					return prototype === named ? namedStandIn : prototype;
				});
			global.Object.getPrototypeOf = prototypeOf(global.Object.getPrototypeOf);
			global.Reflect.getPrototypeOf = prototypeOf(
				global.Reflect.getPrototypeOf,
			);
			const protoDescriptor = Reflect.getOwnPropertyDescriptor(
				global.Object.prototype,
				'__proto__',
			);
			if (protoDescriptor?.get)
				Reflect.defineProperty(global.Object.prototype, '__proto__', {
					...protoDescriptor,
					get: prototypeOf(protoDescriptor.get),
				});
		}

		// this window's own name, told to its parent page (a proxied one)
		const nameDescriptor = Reflect.getOwnPropertyDescriptor(global, 'name');
		const tell = () => {
			if (!this.client.nested || !nameDescriptor?.get) return;
			try {
				const name = Reflect.apply(nameDescriptor.get, global, []) as string;
				const parent = (this.client.parent as Record<string, any>)[
					this.client.names.client
				] as DocumentClient | undefined;
				if (name) parent?.exposeChild?.(name);
			} catch (error) {
				// a parent of another real origin
			}
		};
		tell();
		if (this.client.nested && nameDescriptor?.set)
			Reflect.defineProperty(global, 'name', {
				...nameDescriptor,
				set: proxyModule.wrapFunction(
					nameDescriptor.set,
					(target, that, args) => {
						Reflect.apply(target, that, args);
						tell();
					},
				),
			});
	}
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const parentDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global,
			'parent',
		)!;

		Reflect.defineProperty(this.client.global, 'parent', {
			get: proxyModule.wrapFunction(
				parentDescriptor.get!,
				(target, that, args) => {
					const got = Reflect.apply(target, that, args);
					return this.newRestricted(got);
				},
			),
			set: parentDescriptor.set!,
			configurable: true,
			enumerable: true,
		});

		// window.top is unforgeable, so the JS rewriter routes `top` reads here:
		// the proxied world's top is the outermost Stomp context
		// only windows qualify: set2 also routes `obj['top'] = v` through here
		// the client of a window this page reached (its own, a frame's), for
		// a read off it; nothing for anything else
		const windowClient = (container: unknown): DocumentClient | undefined => {
			if (typeof container !== 'object' || container === null) return;
			if (container === this.client.global) return this.client;
			try {
				const client = (container as Record<string, any>)[
					this.client.names.client
				] as DocumentClient | undefined;
				return client?.global === container ? client : undefined;
			} catch (error) {
				// a window of another real origin
			}
		};

		const isWindow = (value: unknown): value is Context => {
			try {
				return (
					typeof value === 'object' &&
					value !== null &&
					(value as { window?: unknown }).window === value
				);
			} catch (error) {
				// cross-origin WindowProxy still exposes .window; anything that
				// throws here isn't a window we can reason about
				return false;
			}
		};

		this.client.resolveTop = (value) => {
			if (!isWindow(value)) return value;
			// a stand-in answers with its own `top` (the top of its world, as
			// this page may see it), never with this page's top
			if (this.restrictedContexts.has(value as Context))
				return Reflect.get(value, 'top');

			try {
				if (value === this.client.top || !(this.client.names.client in value))
					return this.newRestricted(
						findTop(this.client.global, this.client.names.client),
					);
			} catch (error) {
				// cross-origin top
			}

			// another proxied window's top is the top of *its* world, which is
			// this one's for a frame of this page
			return this.newRestricted(findTop(value, this.client.names.client));
		};

		// a window of another proxied origin that a computed read lands on
		// (`frames[i]`, `window[name]`): the browser would hand the page a
		// cross-origin WindowProxy, so the page gets the restricted stand-in
		// (a same-origin one is returned as it is)
		this.client.restrictForeign = (value, container) => {
			if (typeof value !== 'object' || value === null) return value;
			try {
				if (!(this.client.names.client in value)) {
					// a child window that runs nothing yet (an iframe's initial
					// about:blank), read off its window by index or by name: injected
					// first, as reading its contentWindow does. Its own natives (its
					// `parent` getter, MessageEvent's `source` getter) called on a
					// window of this page would answer raw, past every hook here
					const owner = windowClient(container);
					if (
						!owner ||
						(value as { window?: unknown }).window !== value ||
						Reflect.get(value, 'parent') !== container
					)
						return value;
					owner.injectChild?.(value as Context);
					if (!(this.client.names.client in value)) return value;
				} else if ((value as { window?: unknown }).window !== value)
					return value;
			} catch (error) {
				// a real cross-origin window: the `in` check throws
				return value;
			}
			// a frame on its initial about:blank: the document its src names decides
			if (initialBlank(value as Context)) {
				let element: unknown;
				try {
					element = Reflect.get(value, 'frameElement');
				} catch (error) {
					// no element this page can see
				}
				if (element)
					return this.pending(
						value as Context,
						Reflect.get(element as object, 'src'),
					);
			}
			return this.newRestricted(value as Context);
		};

		this.exposeNames(proxyModule);

		const messageData = new WeakMap<MessageEvent, MessageData>();

		// a BroadcastChannel message carries the sender's origin, which is the
		// proxy's for every document of this site: the page's own is the real one
		const eventTarget = Reflect.getOwnPropertyDescriptor(
			this.client.global.Event.prototype,
			'target',
		)!.get!;
		const fromBroadcastChannel = (event: MessageEvent): boolean => {
			try {
				return (
					Reflect.apply(eventTarget, event, []) instanceof
					this.client.global.BroadcastChannel
				);
			} catch (error) {
				return false;
			}
		};

		Reflect.defineProperty(
			this.client.global.MessageEvent.prototype,
			'origin',
			{
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(
					Reflect.getOwnPropertyDescriptor(
						this.client.global.MessageEvent.prototype,
						'origin',
					)!.get!,
					(target, that: MessageEvent, args) => {
						if (messageData.has(that)) {
							return messageData.get(that)!.origin;
						}

						const origin = Reflect.apply(target, that, args);
						if (origin !== '' && fromBroadcastChannel(that))
							return this.client.origin;
						return origin;
					},
				),
			},
		);

		// the sender's window as the page may see it: its own real origin's
		// windows as they are, another proxied origin's restricted (every
		// proxied window shares the proxy origin, so the browser would hand the
		// page the whole window), anything outside the proxied world as the
		// top; ports and workers as they are
		const sourceDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.MessageEvent.prototype,
			'source',
		)!;
		Reflect.defineProperty(
			this.client.global.MessageEvent.prototype,
			'source',
			{
				...sourceDescriptor,
				get: proxyModule.wrapFunction(
					sourceDescriptor.get!,
					(target, that: MessageEvent, args) => {
						const source = Reflect.apply(target, that, args);
						return isWindow(source) ? this.newRestricted(source) : source;
					},
				),
			},
		);

		Reflect.defineProperty(this.client.global.MessageEvent.prototype, 'data', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(
					this.client.global.MessageEvent.prototype,
					'data',
				)!.get!,
				(target, that: MessageEvent, args) => {
					if (messageData.has(that)) {
						return messageData.get(that)!.data;
					}

					return Reflect.apply(target, that, args);
				},
			),
		});

		// the tagger: messages from other Stomp windows arrive in an envelope
		// (see postMessage below) which the data and origin getters unwrap.
		// Registered now and again after every document.open(), which drops
		// window listeners.
		const tagMessages = () => {
			this.client.global.addEventListener('message', (event) => {
				/*console.error(
					this.client.url.url.toString(),
					event.data,
					isMessageData(event.data, this.client.names.globalName)
				);*/
				usePrototype(event, nativeMessageEvent, (event) => {
					if (!isMessageData(event.data, this.client.names.globalName)) return;

					messageData.set(event, event.data);

					/* else {
						console.warn('Unknown message', event.data);
					}*/
				});
			});
		};
		tagMessages();
		addDocumentOpenListener(this.client.global, tagMessages);

		// another context posting to this window calls this native from its
		// own realm (access API `post`), so it is the incumbent the browser
		// reports as the source
		this.client.nativePostMessage = this.client.global.postMessage;
		// `x.postMessage()` on a stand-in this page holds: posted from this
		// realm, since the browser names the realm that calls postMessage as
		// the event's source, and the stand-in may be one another document of
		// this origin made (see newRestricted)
		this.client.postToRestricted = (target, args) => {
			const context = this.restrictedContexts.get(target as Context);
			if (!context) return false;
			catchRequiredArguments(args.length, 1, 'Window', 'postMessage');
			if (this.targetAllows(args, context)) this.#postFromHere(context, args);
			return true;
		};
		this.client.postToWindow = (target, args) => {
			const receiver = (target as Record<string, any>)[
				this.client.names.client
			] as Client;
			if (!this.targetAllows(args as unknown[], target as Context)) return;
			const [data, options] = this.postMessage(
				args as PostMessageArgs,
				target as Context,
			) as PostMessageArgs2;
			// from this window's realm, whatever bundle this client is (callIn)
			return this.client.callIn(receiver.nativePostMessage!, target, [
				data,
				options,
			]);
		};
		this.client.global.postMessage = proxyModule.wrapFunction(
			this.client.global.postMessage,
			(target, that, args) => {
				catchRequiredArguments(args.length, 1, 'Window', 'postMessage');
				return Reflect.apply(
					target,
					this.client.global,
					this.postMessage(<any>args, this.client.global as Context),
				);
			},
		);
		this.client.hookedPostMessage = this.client.global.postMessage;
	}
}
