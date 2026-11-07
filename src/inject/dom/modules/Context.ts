import { getDomain } from 'tldts';
import { routeHTML } from '../../../rewriteHTML';
import { CLIENT_KEY, GLOBAL_NAME } from '../../../rewriteJS';
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

function findTop(global: typeof globalThis): Context {
	let context: Context = global;

	// walk up while the parent is still a Stomp context; the controller page
	// (or anything cross-origin) ends the proxied world
	while (true) {
		try {
			const parent = (context[CLIENT_KEY] as DocumentClient).parent;
			if (parent === context || !(CLIENT_KEY in parent)) return context;
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
function nestedRouteOf(context: Context): string | false {
	try {
		return (
			(
				(context as Record<string, any>)[CLIENT_KEY] as
					DocumentClient | undefined
			)?.nestedRoute ?? false
		);
	} catch (error) {
		return false;
	}
}
type RestrictedContext = typeof globalThis;

const nativeMessageEvent: MessageEvent = Object.create({});

applyDescriptors(nativeMessageEvent, MessageEvent.prototype);

interface MessageData {
	[GLOBAL_NAME]: 'stompMessage';
	data: any;
	origin: string;
}

function isMessageData(data: any): data is MessageData {
	return (
		typeof data === 'object' &&
		data !== null &&
		data[GLOBAL_NAME] === 'stompMessage'
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
	constructor(client: DocumentClient) {
		super(client);
		this.restricted = new WeakMap();
		this.restrictedContexts = new WeakMap();
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
				window[CLIENT_KEY].url.url.toOrigin() === origin,
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
				[GLOBAL_NAME]: 'stompMessage',
				data: message.data,
				origin: this.client.url.url.origin,
			},
			{
				targetOrigin: this.client.global.location.origin,
				transfer: message.transfer,
			},
		];
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
							nestedRouteOf(context),
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
							nestedRouteOf(context),
						),
					);
				},
			},
		});

		const res = <any>this.restrictObject(
			{
				top: {
					get: () => this.newRestricted(<Context>(<unknown>context.top!)),
				},
				parent: {
					get: () => this.newRestricted(<Context>(<unknown>context.parent!)),
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
								nestedRouteOf(context),
							),
						);
					},
				},
				postMessage: {
					value: proxyModule.wrapFunction(postMessage, (target, that, args) => {
						catchRequiredArguments(args.length, 1, 'Window', 'postMessage');
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
				return child ? this.newRestricted(child) : undefined;
			},
		);

		return res;
	}
	newRestricted(context: Context): RestrictedContext {
		// a cross-origin window (the host application in isolation mode) throws
		// on the `in` check; it is never a Stomp context
		let isStomp: boolean;
		try {
			isStomp = CLIENT_KEY in context;
		} catch {
			isStomp = false;
		}

		if (!isStomp) {
			// the proxied world ends here (the host, or anything it opened):
			// present ourselves as the top
			return findTop(this.client.global);
		}

		if (
			sameOrigin(
				this.client.url.toString(),
				((context as any)[CLIENT_KEY] as DocumentClient).url.toString(),
			)
		)
			return context;

		if (!this.restricted.has(context)) {
			const restricted = this.restrictContext(context);

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
				if (value === this.client.top || !(CLIENT_KEY in value))
					return this.newRestricted(findTop(this.client.global));
			} catch (error) {
				// cross-origin top
			}

			// another proxied window's top is the top of *its* world, which is
			// this one's for a frame of this page
			return this.newRestricted(findTop(value));
		};

		// a window of another proxied origin that a computed read lands on
		// (`frames[i]`, `window[name]`): the browser would hand the page a
		// cross-origin WindowProxy, so the page gets the restricted stand-in
		// (a same-origin one is returned as it is)
		this.client.restrictForeign = (value) => {
			if (typeof value !== 'object' || value === null) return value;
			try {
				if (
					!(CLIENT_KEY in value) ||
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
					isMessageData(event.data)
				);*/
				usePrototype(event, nativeMessageEvent, (event) => {
					if (!isMessageData(event.data)) return;

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
		this.client.postToWindow = (target, args) => {
			const receiver = (target as Record<string, any>)[CLIENT_KEY] as Client;
			const [data, options] = this.postMessage(
				args as PostMessageArgs,
			) as PostMessageArgs2;
			// the browser checks the target origin against the receiver's real
			// one (the proxy origin, shared by every proxied window); an
			// about:srcdoc caller reads its own as "null", so the receiver's
			// is used, or any
			const receiverOrigin = (receiver as DocumentClient).global.location
				.origin;
			return Reflect.apply(receiver.nativePostMessage!, target, [
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
