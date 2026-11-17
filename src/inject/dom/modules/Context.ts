import { siteOf } from '../../../partition';
import { routeHTML } from '../../../rewriteHTML';
import StompURL, { urlLike } from '../../../StompURL';
import { INITIATOR_ROUTE } from '../../../transport/messages';
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
import { OwnWeakMap, OwnWeakSet } from '../../ownCollections';
import { getPublicSuffix } from '../../rewriter';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { frameDestination, frameOfHeld, heldBefore } from '../freshContext';

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
 */
export function reachableClients(
	first: DocumentClient,
	second: DocumentClient,
): boolean {
	if (first === second) return true;
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
const nativeOpener = Reflect.getOwnPropertyDescriptor(
	globalThis,
	'opener',
)?.get;
// Chrome's console message for a navigation it refuses is the browser's own:
// printed with the console's native method, which no page hook sees
const nativeConsoleError = console.error;

/** how long a navigation of another window waits for the worker to hear of its initiator */
const INITIATOR_WAIT_MS = 1000;

/** Chrome's reason for refusing a frame's navigation of its top (its framebusting intervention) */
const FRAMEBUSTING =
	'The frame attempting navigation is targeting its top-level window, but is neither same-origin with its target nor has it received a user gesture. See https://www.chromestatus.com/feature/5851021045661696.';

/**
 * A host's registrable domain as Chrome's framebusting check asks for it
 * (GetDomainAndRegistry): '' for an IP address and for a host that is a
 * public suffix itself (localhost)
 */
function registrableDomainOf(host: string): string {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return '';
	const suffix = getPublicSuffix(host);
	if (!suffix || host === suffix || !host.endsWith(`.${suffix}`)) return '';
	const rest = host.slice(0, -suffix.length - 1);
	return `${rest.slice(rest.lastIndexOf('.') + 1)}.${suffix}`;
}

/** whether a frame's window is still on the initial about:blank its creation gave it */
export function initialBlank(context: typeof globalThis): boolean {
	try {
		return context.location.href === 'about:blank';
	} catch (error) {
		return false;
	}
}

/** whether a window runs STomp (a cross-origin one throws on the check) */
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

	// walk up while the parent is still a STomp context; the controller page
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

type RestrictedContext = typeof globalThis;

const nativeMessageEvent: MessageEvent = Object.create({});

applyDescriptors(nativeMessageEvent, MessageEvent.prototype);

/** a message between STomp contexts: the envelope key is the deployment's globalName helper */
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
		return Symbol.for(`${this.client.names.client}$standIn`);
	}
	/** whether `value` is a stand-in, this module's or another document's */
	#standIn(value: unknown): boolean {
		if (typeof value !== 'object' || value === null) return false;
		if (this.restrictedContexts.has(value as Context)) return true;
		try {
			return (value as Record<symbol, unknown>)[this.#brand()] === true;
		} catch (error) {
			// a window of another real origin
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
							throw withStack(
								new this.client.global.DOMException(
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
	/** whether this document reaches `context`'s (same origin-domain, neither opaque) */
	#reaches(context: unknown): boolean {
		const other = this.#clientOf(context);
		if (!other) return false;
		if (other === this.client) return true;
		try {
			return (
				!this.client.sandboxedOpaque &&
				!other.sandboxedOpaque &&
				reachableClients(this.client, other)
			);
		} catch (error) {
			return false;
		}
	}
	/** whether this document reaches `context` or one of its proxied ancestors */
	#reachesAncestor(context: unknown): boolean {
		let current = this.#clientOf(context);
		for (let depth = 0; current && depth < 64; depth++) {
			if (this.#reaches(current.global)) return true;
			let parent: Context;
			try {
				parent = current.parent;
			} catch (error) {
				return false;
			}
			if (parent === current.global) return false;
			current = this.#clientOf(parent);
		}
		return false;
	}
	/**
	 * Why Chrome refuses this document's navigation of `target` to
	 * `destination` (the reason its console message gives), or null when it
	 * allows it: LocalFrame::CanNavigate, measured in Chrome 152, 156 and 157
	 * alike (top-navigation suite). The real frames cannot decide it: inside
	 * the host's frame the proxied top is no browser top, and every proxied
	 * window is of one real origin. A sandboxed document navigates what
	 * DocumentClient.mayNavigate allows. Any other navigates a window of
	 * its origin or under one (its descendants, a frame whose parent is its
	 * origin's), its opener, the top level its opener's ancestors reach,
	 * and its proxied top when it has had a user's activation (sticky: a
	 * click long ago counts) or the destination is of the top's origin (or
	 * registrable domain, of its scheme); Chrome's framebusting
	 * intervention refuses the rest. A javascript: URL goes only to a
	 * window this document reaches.
	 */
	#refusal(target: Context, destination: URL): string | null {
		const client = this.client;
		if (target === client.global) return null;
		if (destination.protocol === 'javascript:' && !this.#reaches(target))
			return 'The frame attempting navigation must be same-origin with the target if navigating to a javascript: url';
		const top = client.proxiedTop;
		if (client.sandboxFlags !== null) {
			if (client.mayNavigate(target)) return null;
			if (target !== top)
				return 'The frame attempting navigation is sandboxed, and is therefore disallowed from navigating its ancestors.';
			if (
				!client.allows('allow-top-navigation') &&
				!client.allows('allow-top-navigation-by-user-activation')
			)
				return "The frame attempting navigation of the top-level window is sandboxed, but the flag of 'allow-top-navigation' or 'allow-top-navigation-by-user-activation' is not set.";
			if (!client.allows('allow-top-navigation'))
				return "The frame attempting navigation of the top-level window is sandboxed with the 'allow-top-navigation-by-user-activation' flag, but has no user activation (aka gesture). See https://www.chromestatus.com/feature/5629582019395584.";
			return FRAMEBUSTING;
		}
		if (this.#reachesAncestor(target)) return null;
		const targetClient = this.#clientOf(target);
		// a top level of the proxied world: this document's opener, or one
		// whose opener this document reaches
		if (targetClient && targetClient.proxiedTop === target) {
			try {
				// (openers as the browser has them: a window's own `opener`
				// answers one of another origin as a stand-in)
				const openerOf = (window: Context): unknown =>
					nativeOpener
						? Reflect.apply(nativeOpener, window, [])
						: window.opener;
				if (openerOf(client.global) === target) return null;
				const theirs = openerOf(target);
				if (theirs && this.#reachesAncestor(theirs)) return null;
			} catch (error) {
				// an opener of another real origin
			}
		}
		if (target === top) {
			let active = false;
			try {
				active = client.global.navigator.userActivation?.hasBeenActive === true;
			} catch (error) {
				// no user activation API
			}
			if (active) return null;
			const topURL = targetClient?.url.url;
			if (topURL && !targetClient!.sandboxedOpaque) {
				if (topURL.origin === destination.origin) return null;
				const domain = registrableDomainOf(topURL.hostname);
				if (
					domain !== '' &&
					domain === registrableDomainOf(destination.hostname) &&
					topURL.protocol === destination.protocol
				)
					return null;
			}
			return FRAMEBUSTING;
		}
		return "The frame attempting navigation is neither same-origin with the target, nor is it the target's parent or opener.";
	}
	/**
	 * Chrome's refusal of a navigation: its console message (printed by the
	 * browser, so no page hook sees it) and the SecurityError of the
	 * Location member, naming the URL as resolved
	 */
	#refuse(
		target: Context,
		reason: string,
		member: 'href' | 'assign' | 'replace',
		destination: URL,
	): DOMException {
		const client = this.client;
		let from: string;
		try {
			from = client.global.location.href;
			if (/^https?:$/.test(new URL(from).protocol))
				from = client.location.toString();
		} catch (error) {
			from = '';
		}
		const origin = this.#clientOf(target)?.origin ?? 'null';
		try {
			Reflect.apply(nativeConsoleError, client.global.console, [
				`Unsafe attempt to initiate navigation for frame with origin '${origin}' from frame with URL '${from}'. ${reason}\n`,
			]);
		} catch (error) {
			// no console
		}
		return client.navigationRefused(member, member !== 'href', destination);
	}
	/**
	 * Navigate `target`, another window of the proxied world, to
	 * `destination` as this document's navigation: refused as Chrome
	 * refuses it (#refusal), else made from that window's own realm through
	 * its Location (the browser lets a window navigate itself, and its
	 * Location keeps the route, the history entry and the fresh browsing
	 * context of a frame that changes origin), once this document has told
	 * the service worker it started it (INITIATOR_ROUTE): its Referer by its
	 * referrer policy, Sec-Fetch-Site from its origin, and Sec-Fetch-User
	 * only when it had activation and is of the target document's site
	 * (measured: a click in a frame of another site sends none). The
	 * navigation starts a moment later, as natively (a navigation is never
	 * synchronous).
	 */
	#navigateOther(
		target: Context,
		value: urlLike,
		member: 'href' | 'assign' | 'replace',
	) {
		const client = this.client;
		const destination = new URL(value, client.baseURL.toString());
		const targetClient = this.#clientOf(target);
		// a window that runs nothing yet (a popup or frame still on its
		// initial about:blank): only a sandbox decides, and the browser lets
		// this document navigate it
		if (!targetClient) {
			if (!client.mayNavigate(target))
				throw client.navigationRefused(member, member !== 'href', destination);
			target.location.replace(
				routeHTML(
					new StompURL(destination, client.url),
					client.url,
					client.config,
					false,
					false,
				),
			);
			return;
		}
		const reason = this.#refusal(target, destination);
		if (reason !== null)
			throw this.#refuse(target, reason, member, destination);
		const replace = member === 'replace';
		const go = () => {
			try {
				const standIn = (target.location as Record<string, any>)[
					client.names.globalProxy
				] as Location;
				const descriptor = Reflect.getOwnPropertyDescriptor(
					standIn,
					replace ? 'replace' : 'href',
				);
				const method = replace ? descriptor?.value : descriptor?.set;
				if (typeof method === 'function')
					targetClient.callIn(method, standIn, [destination.href]);
			} catch (error) {
				// the window went away
			}
		};
		if (!/^https?:$/.test(destination.protocol)) return go();
		let active = false;
		try {
			active = client.global.navigator.userActivation?.isActive === true;
		} catch (error) {
			// no user activation API
		}
		let sameSite = false;
		try {
			sameSite =
				!client.sandboxedOpaque &&
				!targetClient.sandboxedOpaque &&
				siteOf(client.url.url, getPublicSuffix) ===
					siteOf(targetClient.url.url, getPublicSuffix);
		} catch (error) {
			// no URL to compare
		}
		const routed = this.#voucher();
		let started = false;
		const start = () => {
			if (started) return;
			started = true;
			// (in the target's realm: this document may be gone by then)
			targetClient.global.setTimeout(targetClient.ownCallback(go), 0);
		};
		if (!routed) return start();
		// bounded: a worker that does not answer delays nothing for long
		targetClient.global.setTimeout(
			targetClient.ownCallback(start),
			INITIATOR_WAIT_MS,
		);
		routed
			.nativeFetch(
				`${routed.global.location.origin}${routed.directory}${INITIATOR_ROUTE}`,
				{
					method: 'POST',
					body: JSON.stringify({
						url: destination.href,
						activated: active && sameSite,
						opaque: client.sandboxedOpaque,
					}),
					cache: 'no-store',
				},
			)
			.then(start, start);
	}
	/**
	 * The routed document that speaks for this one to the service worker:
	 * this one, or for a document the page made (about:srcdoc, a written
	 * about:blank) the nearest routed one of its origin above it
	 */
	#voucher(): DocumentClient | null {
		const routed = this.client.routedClient() as DocumentClient | null;
		if (!routed) return null;
		try {
			return routed === this.client ||
				routed.url.url.origin === this.client.url.url.origin
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
		return this.client.callIn(
			this.client.nativePostMessage ?? this.client.global.postMessage,
			receiver,
			this.postMessage(<any>args, receiver),
		);
	}
	restrictContext(context: Context): RestrictedContext {
		const proxyModule = this.client.getModule(ProxyModule)!;
		// a child that runs no STomp yet (an iframe still on its initial
		// about:blank) is still that child, of the frame's origin: never the
		// top, which a walk down the tree would visit again forever
		const restrictChild = (child: Context) =>
			isStomp(child, this.client.names.client)
				? this.newRestricted(child)
				: this.restrictOpaque(child);

		const restrictedLocation = this.restrictObject('Location', {
			replace: {
				// (the browser's own count check first)
				value: proxyModule.wrapFunction(
					this.client.global.location.replace,
					(target, that, args) => {
						catchRequiredArguments(
							args.length,
							1,
							'Location',
							'replace',
							this.client.global,
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
						return opener && isStomp(opener, this.client.names.client)
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
						this.client.global.postMessage,
						(target, that, args) => {
							catchRequiredArguments(
								args.length,
								1,
								'Window',
								'postMessage',
								this.client.global,
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
			target = new URL(String(url), this.client.baseURL.toString());
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
		const restricted = this.#restrict(context);
		return restricted === context
			? restricted
			: (this.#handle(context) ?? restricted);
	}
	#restrict(context: Context): RestrictedContext {
		// another document's stand-in (a same-origin parent's getter handed
		// it over): restricted already
		if (!this.restrictedContexts.has(context) && this.#standIn(context))
			return context;
		// a cross-origin window (the host application in isolation mode) throws
		// on the `in` check; it is never a STomp context
		if (!isStomp(context, this.client.names.client))
			// the proxied world ends here (the host, or anything it opened):
			// present ourselves as the top, as this page sees it (a frame of
			// another origin gets its stand-in, as for `top`)
			context = findTop(this.client.global, this.client.names.client);

		if (this.#holds().has(context)) return context;

		const other = (context as any)[this.client.names.client] as DocumentClient;
		// a window this realm holds a stand-in of: its own again once the two
		// documents reach each other (both set document.domain); a stand-in
		// the page kept from before stays one
		if (this.restricted.has(context)) {
			let reach = false;
			try {
				reach =
					context !== this.client.global &&
					!this.client.sandboxedOpaque &&
					!other.sandboxedOpaque &&
					reachableClients(this.client, other);
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

		// the documents' origins, kept per document: this runs on every read
		// of another window, and decoding both routed URLs for each read
		// (about 20 us) let the ad frames of a crazygames game page, about 200
		// walking the frame tree, keep the renderer's main thread busy for
		// good. An opaque URL (a data: document) has none, and reaches nothing.
		if (!opaque && reachableClients(this.client, other)) {
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
				(context as Record<string, any>)[this.client.names.client] as
					DocumentClient | undefined
			)?.standIns;
			// (never a sandboxed document's: its stand-ins hold its sandbox's
			// limits, which another document of the site does not share)
			// (by what this document reaches others as: its origin, or the
			// domain it set)
			const domain = this.client.documentDomain;
			const key =
				this.client.sandboxFlags === null
					? domain !== null
						? `${this.client.url.url.protocol}domain:${domain}`
						: this.client.originKey
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
				// (by the browser's own `window` getter, which answers for a
				// window of any origin: a Proxy of the page's is asked nothing
				// and passes for none)
				if (this.client.isWindowObject)
					return this.client.isWindowObject(value);
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

		// a window this realm held, whose frame got a fresh context since: what
		// is done to it through the access API (a message, a location set, a
		// read or write of another origin's window) is done to the frame's
		// window now, as this realm has it (freshContext.ts)
		this.client.liveWindow = (target) => {
			if (!this.#holds().has(target as Context)) return undefined;
			const frame = frameOfHeld(this.client, target);
			if (!frame?.now || (frame.now as unknown) === target) return undefined;
			return this.#restrict(frame.now as unknown as Context);
		};

		// another proxied window's location, set or called by this document
		// (Sandbox's gated Location, the access API's `w.location = url`)
		// (false for a URL that does not parse: the location's own setter or
		// method throws the browser's error for it)
		this.client.navigateWindow = (target, value, member) => {
			if (!isWindow(target) || !this.#clientOf(target)) return false;
			const url = String(value);
			if (failsToParse(this.client, url)) return false;
			this.#navigateOther(target, url, member);
			return true;
		};

		this.client.resolveTop = (value, container) => {
			if (!isWindow(value)) return value;
			// a stand-in answers with its own `top` (the top of its world, as
			// this page may see it), never with this page's top
			if (this.#standIn(value)) return Reflect.get(value, 'top');

			try {
				if (value === this.client.top || !(this.client.names.client in value)) {
					// the top of the world the window it was read off is in: this
					// page's own, unless that window is in another tab (a popup
					// reads `opener.top`, which was the popup itself)
					const from =
						container !== undefined &&
						container !== this.client.global &&
						isWindow(container) &&
						this.client.names.client in container
							? container
							: this.client.global;
					return this.newRestricted(findTop(from, this.client.names.client));
				}
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
				// Only a window is asked for the client. Every computed read
				// that lands on an object comes here, and a Proxy of the
				// page's asked `client in value` would learn the client's
				// name, which no page is told and every page of a controller
				// shares
				if (!isWindow(value)) return value;
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
						frameDestination(this.client, element as object),
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

		// the tagger: messages from other STomp windows arrive in an envelope
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
					let data: unknown;
					try {
						data = event.data;
					} catch (error) {
						// an event the page made that is no MessageEvent
						// (`dispatchEvent(new Event('message'))`): it carries no data
						return;
					}
					if (!isMessageData(data, this.client.names.globalName)) return;

					messageData.set(event, data);

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
			catchRequiredArguments(
				args.length,
				1,
				'Window',
				'postMessage',
				this.client.global,
			);
			this.#cloneCheck(args);
			if (this.targetAllows(args, context)) this.#postFromHere(context, args);
			return true;
		};
		this.client.postToWindow = (target, args) => {
			const receiver = (target as Record<string, any>)[
				this.client.names.client
			] as Client;
			this.#cloneCheck(args as unknown[]);
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
		// The window's postMessage acts on its receiver, as the browser's
		// does: the window it was read from when it is called with none (a
		// detached call), any other window it is called on
		// (`postMessage.call(parent, m)`, a timer of another window calling
		// it), and anything that is no window is the browser's Illegal
		// invocation. It posted to its own window whatever it was called on.
		// The message goes from this realm, which the browser names as the
		// source.
		const nativePost = this.client.global.postMessage;
		// (the scope a `with` over another window reads the name through
		// stands for that window: see postScope)
		const scopes = new WeakMap<object, object>();
		const poster = (home: Context) =>
			proxyModule.wrapFunction(nativePost, (target, that, args) => {
				const receiver: unknown =
					that === undefined || that === null || that === scopes.get(home)
						? home
						: that;
				if (receiver === this.client.global) {
					catchRequiredArguments(
						args.length,
						1,
						'Window',
						'postMessage',
						this.client.global,
					);
					this.#cloneCheck(args);
					return Reflect.apply(
						target,
						this.client.global,
						this.postMessage(<any>args, this.client.global as Context),
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
						stomp = (receiver as Record<string, any>)[this.client.names.client];
				} catch (error) {
					// a window of another origin: the browser's own call
				}
				if (!window)
					throw new this.client.global.TypeError('Illegal invocation');
				catchRequiredArguments(
					args.length,
					1,
					'Window',
					'postMessage',
					this.client.global,
				);
				if (stomp?.nativePostMessage)
					return this.client.postToWindow!(receiver as object, args);
				if (this.client.postToRestricted!(receiver, args)) return undefined;
				return Reflect.apply(target, receiver, args);
			});
		this.client.global.postMessage = poster(this.client.global as Context);
		this.client.hookedPostMessage = this.client.global.postMessage;
		const posters = new WeakMap<object, unknown>();
		this.client.postMessageOf = (target) => {
			if (target === this.client.global) return undefined;
			try {
				if (
					typeof target !== 'object' ||
					target === null ||
					(target as Context).window !== target
				)
					return undefined;
				const receiver = (target as Record<string, any>)[
					this.client.names.client
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
		this.client.postScope = (target) => {
			if (!this.client.postMessageOf!(target)) return undefined;
			let scope = scopes.get(target as object);
			if (!scope) {
				scope = new Proxy(Object.create(null) as object, {
					has: (_, key) =>
						key === 'postMessage' && !!this.client.postMessageOf!(target),
					get: (_, key) =>
						key === 'postMessage'
							? this.client.postMessageOf!(target)
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
