import { getDomain } from 'tldts';
import { routeHTML } from '../../../rewriteHTML';
import { CLIENT_KEY, GLOBAL_NAME } from '../../../rewriteJS';
import StompURL, { urlLike } from '../../../StompURL';
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
	restrictObject(interfaces: PropertyDescriptorMap) {
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
			new DOMException(
				`Blocked a frame with "${this.client.url.url.origin}" from accessing a cross-origin frame.`,
			);

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
				)
					throw accessError();

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
				if (!(prop in target)) throw accessError();
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
						),
					);
				},
			},
		});

		const res = <any>this.restrictObject({
			0: {
				value: this.client.global,
			},
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
				get: () => context.closed,
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
		});

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

			return this.newRestricted(value);
		};

		const messageData = new WeakMap<MessageEvent, MessageData>();

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

						return Reflect.apply(target, that, args);
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
	}
}
