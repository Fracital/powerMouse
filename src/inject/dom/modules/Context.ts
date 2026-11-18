import type { SitesConfig } from '../../../config';
import { urlLike } from '../../../StompURL';
import Client from '../../Client';
import Module from '../../Module';
import ProxyModule, {
	applyDescriptors,
	catchRequiredArguments,
	usePrototype,
} from '../../modules/Proxy';
import { routedPrefix } from '../../modules/Unroute';
import { failsToParse, withStack } from '../../nativeErrors';
import { nativeFunction } from '../../nativeUtil';
import {
	LazySet,
	LazyWeakMap,
	OwnWeakMap,
	OwnWeakSet,
} from '../../ownCollections';
import DocumentClient, {
	addDocumentOpenListener,
	type AcrossNavigation,
} from '../Client';
import { deferred } from '../deferred';
import { frameDestination, frameOfHeld, heldBefore } from '../freshContext';
import type { OtherCause, OtherNavigation } from '../navigateOther';
import { foreignWindow, nativeOrigin, siteWindows } from '../siteWindows';

function removeBlob(protocol: string): string {
	return protocol.startsWith('blob:') ? protocol.slice(5) : protocol;
}

/**
 * Whether two URLs are of one origin: scheme, host and port (a blob: URL
 * by the origin it names). Not one site: a name under a site is another
 * origin to it, as to Chrome
 */
export function sameOrigin(first: string, second: string): boolean {
	const firstURL = new URL(first);
	const secondURL = new URL(second);
	return (
		removeBlob(firstURL.protocol) === removeBlob(secondURL.protocol) &&
		firstURL.port === secondURL.port &&
		firstURL.hostname === secondURL.hostname
	);
}

/**
 * Whether two documents reach each other's windows, as Chrome decides it:
 * same origin-domain. Two documents neither of which set document.domain
 * are by their origins (scheme, host and port; a site is not enough: a name
 * under a site is another origin to it); two that both set it, to the same
 * value and of one scheme, are, whatever their hosts and ports; one that set
 * it and one that did not are not, even of one origin. document.domain is
 * set only in an agent cluster keyed by site (Origin-Agent-Cluster: ?0;
 * DOMHooks), so it never joins two sites. Each document's origin is its own
 * URL's (DocumentClient.url), never its base URL's; an opaque one (a
 * sandbox without allow-same-origin, a data: document) reaches nothing.
 * A document its Document-Isolation-Policy isolates reaches only the
 * documents of its origin that theirs isolates (measured in Chrome 157,
 * the document-isolation suite).
 */
export function reachableClients(
	first: DocumentClient,
	second: DocumentClient,
): boolean {
	if (first === second) return true;
	// one isolated by its Document-Isolation-Policy and one not are in two
	// agent clusters, whatever their origins
	if ((first.scriptFacts.dip === true) !== (second.scriptFacts.dip === true))
		return false;
	const mine = first.originKey;
	const theirs = second.originKey;
	if (mine === null || theirs === null) return false;
	const myDomain = first.documentDomain;
	const theirDomain = second.documentDomain;
	if (myDomain !== null || theirDomain !== null)
		return (
			myDomain !== null &&
			myDomain === theirDomain &&
			mine.slice(0, mine.indexOf(':')) === theirs.slice(0, theirs.indexOf(':'))
		);
	return mine === theirs;
}

// taken before the page runs: a page may replace the global
const NativeWeakRef = WeakRef;
// a window's opener as the browser has it: a window's own accessor answers
// for any window
export const nativeOpener = Reflect.getOwnPropertyDescriptor(
	globalThis,
	'opener',
)?.get;
// Chrome's console message for a navigation it refuses is the browser's own:
// printed with the console's native method, which no page hook sees
export const nativeConsoleError = console.error;

/** whether a frame's window is still on the initial about:blank its creation gave it */
export function initialBlank(context: typeof globalThis): boolean {
	try {
		return context.location.href === 'about:blank';
	} catch (error) {
		return false;
	}
}

/**
 * whether a window runs STomp (one of another origin is asked nothing: it
 * would throw on the check, and an exception is most of what a read of
 * another slot's window cost)
 */
export function isStomp(value: unknown, client: string): boolean {
	try {
		return (
			typeof value === 'object' &&
			value !== null &&
			!foreignWindow(value) &&
			client in (value as object)
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
		// a window of another real origin (the site pool: another slot's)
		// has no prototype to read: the browser hands out its named children
		// itself, and throws for any other name
		const value = named
			? Reflect.getOwnPropertyDescriptor(named, name)?.value
			: Reflect.get(context, name);
		if (typeof value !== 'object' || value === null) return undefined;
		for (let index = 0; index < context.length; index++)
			if ((context as unknown as Record<number, unknown>)[index] === value)
				return value as Context;
	} catch (error) {
		// a window of another real origin
	}
	return undefined;
}

function findTop(
	global: typeof globalThis,
	client: string,
	sites?: SitesConfig | null,
	from: typeof globalThis = global,
): Context {
	if (sites) return siteWindows().siteTop(global, sites.hub, from);
	let parent: Context;
	try {
		parent = ((global as Record<string, any>)[client] as DocumentClient).parent;
	} catch (error) {
		return global;
	}
	// A window's way up changes only with its parent: a frame above it that
	// navigates or leaves its document takes this window's browsing context
	// with it, whose parent is then null. So the top found last time stands
	// while the parent is the one it was found from (every read of `top`
	// walked up, a frame six deep climbed six windows each time)
	const kept = tops.get(global);
	if (kept !== undefined && kept.parent === parent) return kept.top;
	const first = parent;
	let context: Context = global;
	// walk up while the parent is still a STomp context; the controller page
	// (or anything cross-origin) ends the proxied world
	try {
		while (parent !== context && client in parent) {
			context = parent;
			parent = ((context as Record<string, any>)[client] as DocumentClient)
				.parent;
		}
	} catch (error) {
		// a window of another origin, or one with no STomp in it
	}
	tops.set(global, { parent: first, top: context });
	return context;
}
/** the top `findTop` found for a window, and the parent it found it from */
const tops = new OwnWeakMap<object, { parent: Context; top: Context }>();

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

/** a message between STomp contexts: the envelope key is the deployment's globalName helper */
interface MessageData {
	data: any;
	origin: string;
	/** encoded frames: `message` carries some, `error` is a messageerror (Context.postMessage) */
	frames?: 'message' | 'error';
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

/** whether `value` is a window, of any origin, as `client`'s realm reads it */
export function isWindow(
	client: DocumentClient,
	value: unknown,
): value is Context {
	try {
		// (by the browser's own `window` getter, which answers for a
		// window of any origin: a Proxy of the page's is asked nothing
		// and passes for none)
		if (client.isWindowObject) return client.isWindowObject(value);
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
	/** the document the holds were made in, and its origin */
	#heldIn: { document: Document; key: string | null } | null = null;
	constructor(client: DocumentClient) {
		super(client);
		// (asked through natives the page cannot replace: what they answer
		// decides which window the page is handed)
		this.restricted = new OwnWeakMap();
		this.restrictedContexts = new OwnWeakMap();
		this.held = new OwnWeakSet();
	}
	/**
	 * The holds, which are a document's: the browser keeps a window for the
	 * document that follows its initial about:blank, and this module with
	 * it. A popup's about:blank is its opener's document and holds the
	 * opener as itself; the site the popup was opened to is another origin's
	 * document in a window that natively is a new one, holding nothing (it
	 * read its opener's globals, document and location through the hold)
	 */
	#holds(): WeakSet<Context> {
		const document = this.client.global.document;
		if (this.#heldIn?.document !== document) {
			const key = this.client.originKey;
			if (this.#heldIn && this.#heldIn.key !== key) this.held = new WeakSet();
			this.#heldIn = { document, key };
		}
		return this.held;
	}
	/** a window this realm now holds as itself (see `held`) */
	hold(context: Context) {
		this.#holds().add(context);
	}
	/**
	 * What every stand-in answers `true` under, whichever document's module
	 * made it: a frame is handed its same-origin parent's stand-ins as they
	 * are (the parent's `opener`, read by the frame), and one this module
	 * did not make is a stand-in all the same, never a window outside the
	 * proxied world (which reads as this page's own top). A registered
	 * symbol, so every realm's bundle finds it, named by the client's name;
	 * answered by the stand-in's read alone, so it is no property of it.
	 */
	#brand(): symbol {
		// (made once: a registry lookup of a new string on every read of
		// another window was the largest part of one)
		return (this.#brandSymbol ??= Symbol.for(
			`${this.client.names.client}$standIn`,
		));
	}
	#brandSymbol?: symbol;
	/**
	 * Windows of another real origin, which refused the brand's read: no
	 * stand-in is one, and a window keeps its identity. Kept so that a read
	 * of such a window's `top` (every one with the site pool, from a frame of
	 * another slot) throws once, not on every read (an exception costs some
	 * 3 us; frame-walk's 5000 reads took 64 to 72 ms, 2 natively). Made at
	 * the first refusal: most documents never meet one.
	 */
	#notStandIns?: WeakSet<object>;
	/** whether `value` is a stand-in, this module's or another document's */
	#standIn(value: unknown): boolean {
		if (typeof value !== 'object' || value === null) return false;
		if (this.restrictedContexts.has(value as Context)) return true;
		if (this.#notStandIns?.has(value)) return false;
		try {
			return (value as Record<symbol, unknown>)[this.#brand()] === true;
		} catch (error) {
			// a window of another real origin
			(this.#notStandIns ??= new OwnWeakSet()).add(value);
			return false;
		}
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

		const brand = this.#brand();
		const proxy = new Proxy(restricted, {
			get: (target, prop, receiver) => {
				if (prop === brand) return true;
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

		// encoded frames (the WebRTC library's, once this document has
		// some): to a receiver of another origin a messageerror, as their
		// agent cluster is the sender's (Chrome 157)
		let { data, transfer } = message;
		let frames: MessageData['frames'];
		const carried = this.client.encodedFrames?.window(
			data,
			transfer,
			this.#sameOrigin(receiver),
		);
		if (carried === 'error') {
			data = null;
			frames = 'error';
		} else if (carried) {
			data = carried.data;
			transfer = carried.transfer as Transferable[];
			frames = 'message';
		}
		return <PostMessageArgs2>[
			<MessageData>{
				[this.client.names.globalName]: 'stompMessage',
				data,
				origin: this.client.origin,
				frames,
			},
			{
				targetOrigin: this.deliveryOrigin(receiver),
				transfer,
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
		const moduleClient = this.client;
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
				moduleClient.names.client
			] as DocumentClient | undefined;
			if (!client) return true;
			receiverClient = client;
			receiverOrigin = client.origin;
		} catch (error) {
			return true;
		}
		if (target === '/' && moduleClient.origin === 'null')
			return receiverClient === moduleClient;
		const wanted =
			target === '/'
				? moduleClient.origin
				: (() => {
						try {
							return new URL(target).origin;
						} catch (error) {
							throw withStack(
								new moduleClient.global.DOMException(
									"Failed to execute 'postMessage' on 'Window': Invalid target origin '" +
										target +
										"' in a call to 'postMessage'.",
									'SyntaxError',
								),
							);
						}
					})();
		return wanted !== 'null' && wanted === receiverOrigin;
	}
	/** the client of a window of the proxied world, if it is one */
	#clientOf(context: unknown): DocumentClient | undefined {
		try {
			const client = (context as Record<string, any>)[
				this.client.names.client
			] as DocumentClient | undefined;
			return client?.global === context ? client : undefined;
		} catch (error) {
			// a window of another real origin
			return undefined;
		}
	}
	/** whether `context`'s document is of this one's origin (an agent cluster, as Chrome keys it) */
	#sameOrigin(context: unknown): boolean {
		const other = this.#clientOf(context);
		if (!other) return false;
		const own = this.client.origin;
		return other === this.client || (own !== 'null' && other.origin === own);
	}
	/** whether this document reaches `context`'s (same origin-domain, neither opaque) */
	#reaches(context: unknown): boolean {
		const client = this.client;
		const other = this.#clientOf(context);
		if (!other) return false;
		if (other === client) return true;
		try {
			return (
				!client.sandboxedOpaque &&
				!other.sandboxedOpaque &&
				reachableClients(client, other)
			);
		} catch (error) {
			return false;
		}
	}
	/**
	 * Navigate `target`, another window of the proxied world, to `value` as
	 * this document's navigation (../navigateOther.ts, a deferred part made
	 * here, before anything of the browser's is called: without it the
	 * navigation throws and nothing navigates)
	 */
	#navigateOther(
		target: Context,
		value: urlLike,
		member: 'href' | 'assign' | 'replace',
		cause: OtherCause | null = null,
	) {
		deferred('navigateOther')(this.#navigation, target, value, member, cause);
	}
	/** what the navigation part reads of this module */
	#navigation: OtherNavigation = {
		client: this.client,
		clientOf: (context) => this.#clientOf(context),
		reaches: (context) => this.#reaches(context),
		voucher: () => this.#voucher(),
	};
	/**
	 * The routed document that speaks for this one to the service worker:
	 * this one, or for a document the page made (about:srcdoc, a written
	 * about:blank) the nearest routed one of its origin above it
	 */
	#voucher(): DocumentClient | null {
		const client = this.client;
		const routed = client.routedClient() as DocumentClient | null;
		if (!routed) return null;
		try {
			return routed === client ||
				routed.url.url.origin === client.url.url.origin
				? routed
				: null;
		} catch (error) {
			return null;
		}
	}
	/**
	 * Navigate `context` (a window behind a restricted stand-in) to the
	 * page's `value`: as #navigateOther
	 */
	#navigate(context: Context, value: urlLike, member: 'replace' | 'href') {
		this.#navigateOther(context, value, member);
	}
	/**
	 * A message that holds or transfers a tainted ImageBitmap is not sent
	 * (CanvasTaint): the browser serializes it before it delivers anything
	 */
	#cloneCheck(args: unknown[]) {
		const option = args[1];
		this.client.cloneCheck?.(
			'Window',
			'postMessage',
			args[0],
			option !== null && typeof option === 'object'
				? Reflect.get(option, 'transfer')
				: args[2],
		);
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
		const client = this.client;
		// the site pool: a window of another site's origin
		if (
			client.sites &&
			siteWindows().postAcross(client, receiver, args, (args) =>
				this.#cloneCheck(args),
			)
		)
			return undefined;
		return client.callIn(
			client.nativePostMessage ?? client.global.postMessage,
			receiver,
			this.postMessage(<any>args, receiver),
		);
	}
	restrictContext(context: Context): RestrictedContext {
		const moduleClient = this.client;
		const global = moduleClient.global;
		const proxyModule = moduleClient.getModule(ProxyModule)!;
		// a child that runs no STomp yet (an iframe still on its initial
		// about:blank) is still that child, of the frame's origin: never the
		// top, which a walk down the tree would visit again forever
		const restrictChild = (child: Context) =>
			isStomp(child, moduleClient.names.client)
				? this.newRestricted(child)
				: this.restrictOpaque(child);

		const restrictedLocation = this.restrictObject('Location', {
			replace: {
				// (the browser's own count check first)
				value: proxyModule.wrapFunction(
					global.location.replace,
					(target, that, args) => {
						catchRequiredArguments(
							args.length,
							1,
							'Location',
							'replace',
							global,
						);
						this.#navigate(context, String(args[0]), 'replace');
					},
				),
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
						this.newRestricted(
							findTop(
								context,
								moduleClient.names.client,
								moduleClient.sites,
								global,
							),
						),
				},
				parent: {
					get: () => {
						let parent: Context | undefined;
						// (a window of another origin is asked nothing: it has no
						// client of this realm's to ask, and the read would throw)
						if (!foreignWindow(context))
							try {
								parent = (
									(context as Record<string, any>)[
										moduleClient.names.client
									] as DocumentClient
								).parent;
							} catch (error) {
								// no STomp in it
							}
						if (parent === undefined)
							return this.newRestricted(<Context>(<unknown>context.parent!));
						// a window whose frame was removed has none
						if (parent === null) return null;
						if (isStomp(parent, moduleClient.names.client))
							return this.newRestricted(parent);
						// the site pool: a parent of another slot is another site's
						// window, and gets its stand-in (never the window itself:
						// its own parent may be of this document's slot, which the
						// browser would hand over whole); the stand-in again would
						// leave a climb to `top` by `parent` (ad and consent scripts
						// look for a frame up the tree that way) spinning for good
						const sites = moduleClient.sites;
						if (sites && !siteWindows().isHub(global, parent, sites.hub))
							return this.newRestricted(parent);
						// the top of the proxied world is its own parent
						return this.newRestricted(context);
					},
				},
				// the window that opened it, when a proxied page did; a window
				// nobody opened has none. It was this document's own top (the
				// stand-in for "outside the proxied world"), so a climb through
				// `opener.top` to the first window never ended
				opener: {
					get: () => {
						let opener: Context | null = null;
						try {
							opener = nativeOpener
								? (Reflect.apply(nativeOpener, context, []) as Context | null)
								: null;
						} catch (error) {
							// a window being torn down
						}
						return opener && isStomp(opener, moduleClient.names.client)
							? this.newRestricted(opener)
							: null;
					},
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
						global.postMessage,
						(target, that, args) => {
							catchRequiredArguments(
								args.length,
								1,
								'Window',
								'postMessage',
								global,
							);
							// the browser serializes the message before it looks at the
							// target origin
							this.#cloneCheck(args);
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
		// (the site pool: a window of another slot gets the stand-in every
		// document of this origin shares)
		if (
			!this.restricted.has(context) &&
			this.client.sites &&
			!isStomp(context, this.client.names.client) &&
			!siteWindows().isHub(this.client.global, context, this.client.sites.hub)
		)
			return siteWindows().restrictAcross(this.client, this, context);
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
		const restricted = this.#pending(context, url);
		return restricted === context
			? restricted
			: (this.#handle(context) ?? restricted);
	}
	/**
	 * The window `context` (a frame's) showed before the fresh browsing
	 * context it was given, when this realm held that one: the frame's
	 * window to this realm still, as natively (freshContext.ts)
	 */
	#handle(context: Context): Context | null {
		for (const old of heldBefore(this.client, context))
			if (old !== context && this.#holds().has(old as Context))
				return old as Context;
		return null;
	}
	#pending(context: Context, url: unknown): RestrictedContext {
		if (this.#holds().has(context)) return context;
		let target: URL | undefined;
		try {
			target = this.client.encodingParse(String(url), this.client.baseHref);
		} catch (error) {
			// no URL: the window's own document decides
		}
		if (
			target === undefined ||
			!/^https?:$/.test(target.protocol) ||
			sameOrigin(this.client.url.toString(), target.href)
		)
			return this.newRestricted(context);
		// (the site pool too: the other site may share this document's slot,
		// a pool of one slot or more sites than slots, and then the browser
		// never restricts the window)
		return this.restrictOpaque(context);
	}
	newRestricted(context: Context): RestrictedContext {
		// no window: the `parent` and `top` of a window whose frame was taken
		// out, an `opener` of none. The browser answers null, and so does the
		// page's: it read as the proxied top (the edge of the proxied world)
		// or as the window itself, and with the site pool it threw (a
		// stand-in kept for null)
		if (context === null || context === undefined) return context;
		const restricted = this.#restrict(context);
		return restricted === context
			? restricted
			: (this.#handle(context) ?? restricted);
	}
	#restrict(context: Context): RestrictedContext {
		const moduleClient = this.client;
		const global = moduleClient.global;
		// another document's stand-in (a same-origin parent's getter handed
		// it over): restricted already
		if (!this.restrictedContexts.has(context) && this.#standIn(context))
			return context;
		// a cross-origin window (the host application in isolation mode) throws
		// on the `in` check; it is never a STomp context
		if (!isStomp(context, moduleClient.names.client)) {
			// the site pool: a window of another slot's origin, another site's.
			// Its stand-in, as without a pool, never the window itself: the
			// browser restricts that only while it shows a document of
			// another slot, and the frame may go next to a site this
			// document's slot shows (more sites than slots), when the window
			// the page held would be that site's, raw. Only the hub's page is
			// hidden, as the top. (A window this realm already holds as
			// itself, a popup it opened on about:blank, it gets back as it is:
			// the page has it, and identity holds, as without a pool.)
			if (
				moduleClient.sites &&
				!siteWindows().isHub(global, context, moduleClient.sites.hub)
			)
				return this.held.has(context) ? context : this.restrictOpaque(context);
			// the proxied world ends here (the host, or anything it opened):
			// present ourselves as the top, as this page sees it (a frame of
			// another origin gets its stand-in, as for `top`)
			context = findTop(global, moduleClient.names.client, moduleClient.sites);
			if (!isStomp(context, moduleClient.names.client))
				// (the site pool: a proxied top of another slot, the stand-in
				// every other path to it answers, so `t = t.parent` meets `top`)
				return moduleClient.sites &&
					!siteWindows().isHub(global, context, moduleClient.sites.hub)
					? siteWindows().restrictAcross(this.client, this, context)
					: context;
		}

		if (this.#holds().has(context)) return context;

		const other = (context as any)[moduleClient.names.client] as DocumentClient;
		// a window this realm holds a stand-in of: its own again once the two
		// documents reach each other (both set document.domain); a stand-in
		// the page kept from before stays one
		if (this.restricted.has(context)) {
			let reach = false;
			try {
				reach =
					context !== global &&
					!moduleClient.sandboxedOpaque &&
					!other.sandboxedOpaque &&
					reachableClients(moduleClient, other);
			} catch (error) {
				// a window being torn down
			}
			if (!reach) return this.restricted.get(context)!;
			this.#holds().add(context);
			return context;
		}

		// an opaque origin (a document the page sandboxed without
		// allow-same-origin) is another origin to every other document, and
		// every other document is to it
		let opaque = false;
		try {
			opaque =
				context !== global &&
				(moduleClient.sandboxedOpaque ||
					(
						(context as Record<string, any>)[
							moduleClient.names.client
						] as DocumentClient
					).sandboxedOpaque);
		} catch (error) {
			// a window being torn down
		}

		// the documents' origins, kept per document: this runs on every read
		// of another window, and decoding both routed URLs for each read
		// (about 20 us) let the ad frames of a crazygames game page, about 200
		// walking the frame tree, keep the renderer's main thread busy for
		// good. An opaque URL (a data: document) has none, and reaches nothing.
		if (!opaque && reachableClients(moduleClient, other)) {
			this.#holds().add(context);
			return context;
		}

		if (!this.restricted.has(context)) {
			// one stand-in per window for every document of an origin: a frame
			// hands its same-origin parent's windows to its own code as they
			// are, so the stand-ins that parent's getters return must be the
			// ones this page's own reads return, or `t = t.parent` never
			// reaches `top` (rubiconproject's usync in imgur's ad frames)
			const standIns = (
				(context as Record<string, any>)[moduleClient.names.client] as
					DocumentClient | undefined
			)?.standIns;
			// (never a sandboxed document's: its stand-ins hold its sandbox's
			// limits, which another document of the site does not share)
			// (by what this document reaches others as: its origin, or the
			// domain it set)
			const domain = moduleClient.documentDomain;
			const key =
				moduleClient.sandboxFlags === null
					? domain !== null
						? `${moduleClient.url.url.protocol}domain:${domain}`
						: moduleClient.originKey
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
		const moduleClient = this.client;
		const global = moduleClient.global;
		const exposed = new LazySet<string>();
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
			moduleClient.restrictForeign
				? moduleClient.restrictForeign(value, container)
				: value;
		const windowPrototype = global.Window.prototype;
		const named = Reflect.getPrototypeOf(windowPrototype);
		moduleClient.exposeChild = (name) => {
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
			if (!moduleClient.nested || !nameDescriptor?.get) return;
			try {
				const name = Reflect.apply(nameDescriptor.get, global, []) as string;
				const parent = (moduleClient.parent as Record<string, any>)[
					moduleClient.names.client
				] as DocumentClient | undefined;
				if (name) parent?.exposeChild?.(name);
			} catch (error) {
				// a parent of another real origin
			}
		};
		tell();
		if (moduleClient.nested && nameDescriptor?.set)
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
		const moduleClient = this.client;
		const realm = moduleClient.global;
		const proxyModule = moduleClient.getModule(ProxyModule)!;

		const parentDescriptor = Reflect.getOwnPropertyDescriptor(realm, 'parent')!;

		Reflect.defineProperty(realm, 'parent', {
			get: proxyModule.wrapFunction(
				parentDescriptor.get!,
				(target, that, args) => {
					const got = Reflect.apply(target, that, args);
					// a removed frame's window has no parent (null), as natively
					if (got === null) return null;
					return this.newRestricted(got);
				},
			),
			set: parentDescriptor.set!,
			configurable: true,
			enumerable: true,
		});

		// window.top is unforgeable, so the JS rewriter routes `top` reads here:
		// the proxied world's top is the outermost STomp context
		// only windows qualify: set2 also routes `obj['top'] = v` through here
		// the client of a window this page reached (its own, a frame's), for
		// a read off it; nothing for anything else
		const windowClient = (container: unknown): DocumentClient | undefined => {
			if (typeof container !== 'object' || container === null) return;
			if (container === realm) return moduleClient;
			try {
				const client = (container as Record<string, any>)[
					moduleClient.names.client
				] as DocumentClient | undefined;
				return client?.global === container ? client : undefined;
			} catch (error) {
				// a window of another real origin
			}
		};

		// a window this realm held, whose frame got a fresh context since: what
		// is done to it through the access API (a message, a location set, a
		// read or write of another origin's window) is done to the frame's
		// window now, as this realm has it (freshContext.ts)
		moduleClient.liveWindow = (target) => {
			if (!this.#holds().has(target as Context)) return undefined;
			const frame = frameOfHeld(moduleClient, target);
			if (!frame?.now || (frame.now as unknown) === target) return undefined;
			return this.#restrict(frame.now as unknown as Context);
		};

		// another proxied window's location, set or called by this document
		// (Sandbox's gated Location, the access API's `w.location = url`)
		// (false for a URL that does not parse: the location's own setter or
		// method throws the browser's error for it)
		// (and a window of this real origin that runs nothing of ours yet:
		// a popup whose next document committed before its bundle ran. Its
		// own Location navigated raw would take it to the site itself,
		// outside the proxy, with the proxy's address for its Referer)
		moduleClient.unclaimedWindow = (target) => {
			try {
				return (
					isWindow(moduleClient, target) &&
					target !== realm &&
					!foreignWindow(target) &&
					!(moduleClient.names.client in target) &&
					(target as Context).document !== null
				);
			} catch (error) {
				// a window of another real origin
				return false;
			}
		};
		moduleClient.navigateWindow = (target, value, member, cause) => {
			if (
				!isWindow(moduleClient, target) ||
				(!this.#clientOf(target) && !moduleClient.unclaimedWindow!(target))
			)
				return false;
			const url = String(value);
			if (failsToParse(moduleClient, url)) return false;
			this.#navigateOther(target, url, member, cause);
			return true;
		};

		moduleClient.resolveTop = (value, container) => {
			// (this window and the browser's top are windows without asking:
			// the browser's top is the hub's page with the site pool, of
			// another origin, and asking a window of another origin costs an
			// exception)
			const top = moduleClient.top;
			if (value !== realm && value !== top && !isWindow(moduleClient, value))
				return value;
			// a stand-in answers with its own `top` (the top of its world, as
			// this page may see it), never with this page's top
			if (this.#standIn(value)) return Reflect.get(value, 'top');

			try {
				if (
					value === top ||
					(!foreignWindow(value as object) &&
						!(moduleClient.names.client in value))
				) {
					// the top of the world the window it was read off is in: this
					// page's own, unless that window is in another tab (a popup
					// reads `opener.top`, which was the popup itself)
					const from =
						container !== undefined &&
						container !== realm &&
						isWindow(moduleClient, container) &&
						moduleClient.names.client in container
							? container
							: realm;
					return this.newRestricted(
						findTop(from, moduleClient.names.client, moduleClient.sites, realm),
					);
				}
			} catch (error) {
				// cross-origin top
			}

			// another proxied window's top is the top of *its* world, which is
			// this one's for a frame of this page
			return this.newRestricted(
				findTop(
					value as Context,
					moduleClient.names.client,
					moduleClient.sites,
					realm,
				),
			);
		};

		// a window of another proxied origin that a computed read lands on
		// (`frames[i]`, `window[name]`): the browser would hand the page a
		// cross-origin WindowProxy, so the page gets the restricted stand-in
		// (a same-origin one is returned as it is)
		moduleClient.restrictForeign = (value, container) => {
			if (typeof value !== 'object' || value === null) return value;
			try {
				// Only a window is asked for the client. Every computed read
				// that lands on an object comes here, and a Proxy of the
				// page's asked `client in value` would learn the client's
				// name, which no page is told and every page of a controller
				// shares
				if (!isWindow(moduleClient, value)) return value;
				// (a window of another origin is asked nothing more: it would
				// throw, and an exception costs more than the rest of the read)
				if (foreignWindow(value))
					return moduleClient.sites
						? this.newRestricted(value as Context)
						: value;
				if (!(moduleClient.names.client in value)) {
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
					if (!(moduleClient.names.client in value)) return value;
				} else if ((value as { window?: unknown }).window !== value)
					return value;
			} catch (error) {
				// a real cross-origin window: the `in` check throws. With the
				// site pool it is another slot's (or the hub's page): restricted
				// as without a pool, since the frame may next show a site of
				// this document's slot (ContextModule #restrict)
				return this.client.sites && isWindow(this.client, value)
					? this.newRestricted(value as Context)
					: value;
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
						frameDestination(moduleClient, element as object),
					);
			}
			return this.newRestricted(value as Context);
		};

		this.exposeNames(proxyModule);

		const messageData = new LazyWeakMap<MessageEvent, MessageData>();

		// a BroadcastChannel message carries the sender's origin, which is the
		// proxy's for every document of this site: the page's own is the real one
		const eventTarget = Reflect.getOwnPropertyDescriptor(
			realm.Event.prototype,
			'target',
		)!.get!;
		const fromBroadcastChannel = (event: MessageEvent): boolean => {
			try {
				return (
					Reflect.apply(eventTarget, event, []) instanceof
					realm.BroadcastChannel
				);
			} catch (error) {
				return false;
			}
		};

		Reflect.defineProperty(realm.MessageEvent.prototype, 'origin', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(
					realm.MessageEvent.prototype,
					'origin',
				)!.get!,
				(target, that: MessageEvent, args) => {
					if (messageData.has(that)) {
						return messageData.get(that)!.origin;
					}

					const origin = Reflect.apply(target, that, args);
					if (origin !== '' && fromBroadcastChannel(that))
						return moduleClient.origin;
					return origin;
				},
			),
		});

		// the sender's window as the page may see it: its own real origin's
		// windows as they are, another proxied origin's restricted (every
		// proxied window shares the proxy origin, so the browser would hand the
		// page the whole window), anything outside the proxied world as the
		// top; ports and workers as they are
		const sourceDescriptor = Reflect.getOwnPropertyDescriptor(
			realm.MessageEvent.prototype,
			'source',
		)!;
		Reflect.defineProperty(realm.MessageEvent.prototype, 'source', {
			...sourceDescriptor,
			get: proxyModule.wrapFunction(
				sourceDescriptor.get!,
				(target, that: MessageEvent, args) => {
					const source = Reflect.apply(target, that, args);
					return isWindow(moduleClient, source)
						? this.newRestricted(source)
						: source;
				},
			),
		});

		Reflect.defineProperty(realm.MessageEvent.prototype, 'data', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				Reflect.getOwnPropertyDescriptor(realm.MessageEvent.prototype, 'data')!
					.get!,
				(target, that: MessageEvent, args) => {
					if (messageData.has(that)) {
						return messageData.get(that)!.data;
					}

					return Reflect.apply(target, that, args);
				},
			),
		});

		// the tagger: messages from other STomp windows arrive in an envelope
		// (see postMessage below) which the data and origin getters unwrap.
		// Registered now and again after every document.open(), which drops
		// window listeners.
		// the realm's own, taken before the page ran: the event below has the
		// native MessageEvent members alone while its data is read
		const stopImmediate =
			this.client.global.Event.prototype.stopImmediatePropagation;
		const dispatch = realm.EventTarget.prototype.dispatchEvent;
		const NativeMessageEvent = realm.MessageEvent;
		const tagMessages = () => {
			realm.addEventListener('message', (event) => {
				/*console.error(
					this.client.url.url.toString(),
					event.data,
					isMessageData(event.data, this.client.names.globalName)
				);*/
				usePrototype(event, nativeMessageEvent, (event) => {
					let data: unknown;
					try {
						data = event.data;
					} catch (error) {
						// an event the page made that is no MessageEvent
						// (`dispatchEvent(new Event('message'))`): it carries no data
						return;
					}
					const sites = moduleClient.sites;
					// the site pool: a frame under this window, of another slot,
					// asks it to navigate (DocumentClient navigateAcross); never
					// the page's message
					if (
						typeof data === 'object' &&
						data !== null &&
						(data as Record<string, unknown>)[moduleClient.names.globalName] ===
							'stompNavigate'
					) {
						Reflect.apply(stopImmediate, event, []);
						const request = data as Record<string, unknown>;
						if (sites && request.token === sites.token)
							deferred('receiveAcross')(
								moduleClient,
								event.source,
								request.request as AcrossNavigation,
							);
						return;
					}
					const across =
						!!sites &&
						// (an opaque sender, a sandboxed frame of this slot, is
						// judged as without a pool)
						event.origin !== 'null' &&
						event.origin !== Reflect.apply(nativeOrigin!, realm, []);
					if (!isMessageData(data, moduleClient.names.globalName)) {
						// the site pool: a window of another slot posted it past its
						// inject (the browser's own postMessage of a window of
						// another origin, taken where no hook stands: `post =
						// w.postMessage; post.call(w, m)`). Nothing says which site
						// sent it, and its origin is a slot's, which no page may
						// see: it never arrives. (The hub's page is the host's, as
						// without a pool.)
						if (across && event.origin !== sites!.hub)
							Reflect.apply(stopImmediate, event, []);
						return;
					}
					if (across) {
						// another slot's origin: only a STomp document of this hub
						// says where a message is from, and one for another origin
						// than this page's never arrives, as natively
						const { token, to } = data as MessageData;
						if (
							token !== sites.token ||
							(to !== '*' && to !== moduleClient.origin)
						) {
							Reflect.apply(stopImmediate, event, []);
							return;
						}
					}

					// encoded frames: a receiver of another origin than the
					// sender's has a messageerror (data null) instead, and one
					// of its origin turns them back with its own frames
					const { frames } = data as MessageData;
					if (frames === 'error') {
						Reflect.apply(stopImmediate, event, []);
						Reflect.apply(dispatch, realm, [
							new NativeMessageEvent('messageerror', {
								data: null,
								origin: (data as MessageData).origin,
								source: event.source,
							}),
						]);
						return;
					}
					if (frames === 'message' && !moduleClient.encodedFrames)
						try {
							moduleClient.loadEncodedFrames?.();
						} catch (error) {
							// (the frames arrive as the browser clones the inject's)
						}
					messageData.set(event, data);

					/* else {
						console.warn('Unknown message', event.data);
					}*/
				});
			});
		};
		tagMessages();
		addDocumentOpenListener(realm, tagMessages);

		// another context posting to this window calls this native from its
		// own realm (access API `post`), so it is the incumbent the browser
		// reports as the source
		moduleClient.nativePostMessage = realm.postMessage;
		// `x.postMessage()` on a stand-in this page holds: posted from this
		// realm, since the browser names the realm that calls postMessage as
		// the event's source, and the stand-in may be one another document of
		// this origin made (see newRestricted)
		moduleClient.postToRestricted = (target, args) => {
			const context = this.restrictedContexts.get(target as Context);
			// (the site pool: or a window of another slot's origin)
			if (!context)
				return (
					!!moduleClient.sites &&
					siteWindows().postAcross(moduleClient, target, args, (args) =>
						this.#cloneCheck(args),
					)
				);
			catchRequiredArguments(args.length, 1, 'Window', 'postMessage', realm);
			this.#cloneCheck(args);
			if (this.targetAllows(args, context)) this.#postFromHere(context, args);
			return true;
		};
		moduleClient.postToWindow = (target, args) => {
			const receiver = (target as Record<string, any>)[
				moduleClient.names.client
			] as Client;
			this.#cloneCheck(args as unknown[]);
			if (!this.targetAllows(args as unknown[], target as Context)) return;
			const [data, options] = this.postMessage(
				args as PostMessageArgs,
				target as Context,
			) as PostMessageArgs2;
			// from this window's realm, whatever bundle this client is (callIn)
			return moduleClient.callIn(receiver.nativePostMessage!, target, [
				data,
				options,
			]);
		};
		// The window's postMessage acts on its receiver, as the browser's
		// does: the window it was read from when it is called with none (a
		// detached call), any other window it is called on
		// (`postMessage.call(parent, m)`, a timer of another window calling
		// it), and anything that is no window is the browser's Illegal
		// invocation. It posted to its own window whatever it was called on.
		// The message goes from this realm, which the browser names as the
		// source.
		const nativePost = realm.postMessage;
		// (the scope a `with` over another window reads the name through
		// stands for that window: see postScope)
		const scopes = new LazyWeakMap<object, object>();
		const poster = (home: Context) =>
			proxyModule.wrapFunction(nativePost, (target, that, args) => {
				const receiver: unknown =
					that === undefined || that === null || that === scopes.get(home)
						? home
						: that;
				if (receiver === realm) {
					catchRequiredArguments(
						args.length,
						1,
						'Window',
						'postMessage',
						realm,
					);
					this.#cloneCheck(args);
					return Reflect.apply(
						target,
						realm,
						this.postMessage(<any>args, realm as Context),
					);
				}
				let stomp: Client | undefined;
				let window = false;
				try {
					window =
						typeof receiver === 'object' &&
						(this.restrictedContexts.has(receiver as Context) ||
							(receiver as Context).window === receiver);
					if (window)
						stomp = (receiver as Record<string, any>)[
							moduleClient.names.client
						];
				} catch (error) {
					// a window of another origin: the browser's own call
				}
				if (!window) throw new realm.TypeError('Illegal invocation');
				catchRequiredArguments(args.length, 1, 'Window', 'postMessage', realm);
				if (stomp?.nativePostMessage)
					return moduleClient.postToWindow!(receiver as object, args);
				if (moduleClient.postToRestricted!(receiver, args)) return undefined;
				return Reflect.apply(target, receiver, args);
			});
		realm.postMessage = poster(realm as Context);
		moduleClient.hookedPostMessage = realm.postMessage;
		const posters = new LazyWeakMap<object, unknown>();
		moduleClient.postMessageOf = (target) => {
			if (target === realm) return undefined;
			try {
				if (
					typeof target !== 'object' ||
					target === null ||
					(target as Context).window !== target
				)
					return undefined;
				const receiver = (target as Record<string, any>)[
					moduleClient.names.client
				] as Client | undefined;
				if (
					!receiver?.nativePostMessage ||
					(target as Context).postMessage !== receiver.hookedPostMessage
				)
					return undefined;
			} catch (error) {
				// a window of another origin
				return undefined;
			}
			let made = posters.get(target);
			if (!made) {
				made = poster(target as Context);
				posters.set(target, made);
			}
			return made;
		};
		// `with (parent) { postMessage(m) }`: the name is found on the window
		// with no member read to route. The rewriter puts this scope inside
		// the head's. It has the one name, for as long as the window's
		// postMessage is the hook, and a write or a delete of the name is the
		// window's. (The helpers the body's code calls are reached by no name
		// a scope answers: src/helperNames.ts accessExpression.)
		moduleClient.postScope = (target) => {
			if (!moduleClient.postMessageOf!(target)) return undefined;
			let scope = scopes.get(target as object);
			if (!scope) {
				scope = new Proxy(Object.create(null) as object, {
					has: (_, key) =>
						key === 'postMessage' && !!moduleClient.postMessageOf!(target),
					get: (_, key) =>
						key === 'postMessage'
							? moduleClient.postMessageOf!(target)
							: undefined,
					set: (_, key, value) => Reflect.set(target as object, key, value),
					deleteProperty: (_, key) =>
						Reflect.deleteProperty(target as object, key),
				});
				scopes.set(target as object, scope);
			}
			return scope;
		};
	}
}
