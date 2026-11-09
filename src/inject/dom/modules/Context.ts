import { getDomain } from 'tldts';
import { routeHTML } from '../../../rewriteHTML';
import StompURL, { urlLike } from '../../../StompURL';
import Client from '../../Client';
import Module from '../../Module';
import ProxyModule, {
	applyDescriptors,
	catchRequiredArguments,
	usePrototype,
} from '../../modules/Proxy';
import { nativeFunction } from '../../nativeUtil';
import DocumentClient, { addDocumentOpenListener } from '../Client';

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

/**
 * The key `sameOrigin` compares by: windows whose documents share it hold
 * each other as themselves, so they must also share their stand-ins for
 * every other window (null for an opaque document, which shares nothing).
 */
function originKey(url: string): string | null {
	const parsed = new URL(url);
	if (parsed.origin === 'null') return null;
	return `${removeBlob(parsed.protocol)}//${getDomain(parsed.host) ?? parsed.host}:${parsed.port}`;
}

// taken before the page runs: a page may replace the global
const NativeWeakRef = WeakRef;

/** whether a window runs Stomp (a cross-origin one throws on the check) */
function isStomp(value: unknown, client: string): boolean {
	try {
		return (
			typeof value === 'object' && value !== null && client in (value as object)
		);
	} catch (error) {
		return false;
	}
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
		interfaces: PropertyDescriptorMap,
		// a cross-origin window's child browsing contexts by index
		indexed?: (index: number) => unknown,
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

		const accessError = () =>
			new this.client.global.DOMException(
				`Blocked a frame with "${this.client.url.url.origin}" from accessing a cross-origin frame.`,
				'SecurityError',
			);
		const indexOf = (prop: string | symbol): number | undefined =>
			indexed && typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)
				? Number(prop)
				: undefined;

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
					const index = indexOf(prop);
					if (index !== undefined) {
						const child = indexed!(index);
						if (child !== undefined) return child;
					}
					throw accessError();
				}

				return Reflect.get(target, prop, receiver);
			},
			set: (target, prop, value) => {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);

				if (!descriptor || typeof descriptor.set !== 'function') {
					throw accessError();
				}

				return Reflect.set(target, prop, value);
			},
			defineProperty: () => {
				throw accessError();
			},
			getOwnPropertyDescriptor: (target, prop) => {
				if (!(prop in target)) throw accessError();
				return Reflect.getOwnPropertyDescriptor(target, prop);
			},
			setPrototypeOf: () => {
				throw accessError();
			},
			has: (target, prop) => {
				if (!(prop in target)) {
					const index = indexOf(prop);
					if (index !== undefined && indexed!(index) !== undefined) return true;
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
	postMessage(
		args: PostMessageArgs | PostMessageArgs2,
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
				origin: this.client.url.url.origin,
			},
			{
				targetOrigin: this.client.global.location.origin,
				transfer: message.transfer,
			},
		];
	}
	/**
	 * Whether a message with these arguments reaches `receiver`, judged by
	 * the real origins the way the browser judges real ones (every proxied
	 * window shares the proxy origin, so the browser's own check passes them
	 * all): `*` reaches any, `/` the sender's own origin, anything else must
	 * be the receiver's origin ("null" for an opaque document never matches).
	 * An unparsable target origin is the browser's SyntaxError.
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
		try {
			const client = (receiver as Record<string, any>)[
				this.client.names.client
			] as DocumentClient | undefined;
			if (!client) return true;
			receiverOrigin = client.url.url.origin;
		} catch (error) {
			return true;
		}
		const wanted =
			target === '/'
				? this.client.url.url.origin
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
	restrictContext(context: Context): RestrictedContext {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const restrictedLocation = this.restrictObject({
			replace: {
				value: (url: urlLike) => {
					context.location.replace(
						routeHTML(
							new StompURL(
								new URL(url, this.client.url.toString()),
								this.client.url,
							),
							this.client.url,
							this.client.config,
							false,
							nestedRouteOf(context, this.client.names.client),
						),
					);
				},
			},
			href: {
				set: (value: urlLike) => {
					context.location.replace(
						routeHTML(
							new StompURL(
								new URL(value, this.client.url.toString()),
								this.client.url,
							),
							this.client.url,
							this.client.config,
							false,
							nestedRouteOf(context, this.client.names.client),
						),
					);
				},
			},
		});

		const res = <any>this.restrictObject(
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
						context.location.replace(
							routeHTML(
								new StompURL(
									new URL(value, this.client.url.toString()),
									this.client.url,
								),
								this.client.url,
								this.client.config,
								false,
								nestedRouteOf(context, this.client.names.client),
							),
						);
					},
				},
				postMessage: {
					value: proxyModule.wrapFunction(postMessage, (target, that, args) => {
						catchRequiredArguments(args.length, 1, 'Window', 'postMessage');
						if (!this.targetAllows(args, context)) return;
						return Reflect.apply(target, context, this.postMessage(<any>args));
					}),
				},
			},
			// its frames, by index: cross-origin reads of them are allowed,
			// and each is another window of this world or outside it
			(index) => {
				const child = (
					context as unknown as Record<number, Context | undefined>
				)[index];
				if (!child) return undefined;
				// a child that runs no Stomp yet (an iframe still on its initial
				// about:blank) is still that child, of the frame's origin: never
				// the top, which a walk down the tree would visit again forever
				return isStomp(child, this.client.names.client)
					? this.newRestricted(child)
					: this.restrictOpaque(child);
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
	newRestricted(context: Context): RestrictedContext {
		// a cross-origin window (the host application in isolation mode) throws
		// on the `in` check; it is never a Stomp context
		if (!isStomp(context, this.client.names.client))
			// the proxied world ends here (the host, or anything it opened):
			// present ourselves as the top, as this page sees it (a frame of
			// another origin gets its stand-in, as for `top`)
			context = findTop(this.client.global, this.client.names.client);

		if (this.held.has(context)) return context;

		if (
			sameOrigin(
				this.client.url.toString(),
				(
					(context as any)[this.client.names.client] as DocumentClient
				).url.toString(),
			)
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
			const key = originKey(this.client.url.toString());
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
		this.client.restrictForeign = (value) => {
			if (typeof value !== 'object' || value === null) return value;
			try {
				if (
					!(this.client.names.client in value) ||
					(value as { window?: unknown }).window !== value
				)
					return value;
			} catch (error) {
				// a real cross-origin window: the `in` check throws
				return value;
			}
			return this.newRestricted(value as Context);
		};

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
							return this.client.url.url.origin;
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
			if (this.targetAllows(args, context))
				Reflect.apply(postMessage, context, this.postMessage(<any>args));
			return true;
		};
		this.client.postToWindow = (target, args) => {
			const receiver = (target as Record<string, any>)[
				this.client.names.client
			] as Client;
			if (!this.targetAllows(args as unknown[], target as Context)) return;
			const [data, options] = this.postMessage(
				args as PostMessageArgs,
			) as PostMessageArgs2;
			// the browser checks the target origin against the receiver's real
			// one (the proxy origin, shared by every proxied window); an
			// about:srcdoc caller reads its own as "null", so the receiver's
			// is used, or any
			const receiverOrigin = (receiver as DocumentClient).global.location
				.origin;
			// from this window's realm, whatever bundle this client is (callIn)
			return this.client.callIn(receiver.nativePostMessage!, target, [
				data,
				{
					...options,
					targetOrigin:
						receiverOrigin && receiverOrigin !== 'null' ? receiverOrigin : '*',
				},
			]);
		};
		this.client.global.postMessage = proxyModule.wrapFunction(
			this.client.global.postMessage,
			(target, that, args) => {
				catchRequiredArguments(args.length, 1, 'Window', 'postMessage');
				return Reflect.apply(
					target,
					this.client.global,
					this.postMessage(<any>args),
				);
			},
		);
		this.client.hookedPostMessage = this.client.global.postMessage;
	}
}
