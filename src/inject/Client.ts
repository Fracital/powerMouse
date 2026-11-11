import { BareCompatibleClient } from '@mercuryworkshop/proxy-transports';
import GenericCodec from '../Codecs';
import {
	Assets,
	codecType,
	Config,
	parseConfig,
	ParsedConfig,
} from '../config';
import { HelperNames, helperNames } from '../helperNames';
import type {
	HookContext,
	HookErrorInfo,
	HookPhase,
	ResolvedHooks,
} from '../hooks';
import { addRouteScope, parseRoutedURL, ROUTE_PROTOCOLS } from '../routeURL';
import StompURL from '../StompURL';
import {
	ABORT_REQUEST,
	INIT_PAGE_MODULES,
	INIT_REMOTE_TRANSPORT,
	INLINE_DOCUMENT,
	PAGE_MODULES,
	SRCDOC_CLAIM,
	SRCDOC_VOUCH,
	TRANSPORT_INIT,
	WORKER_BASE,
} from '../transport/messages';
import RemoteTransport from '../transport/RemoteTransport';
import { BUILD } from '../version';
import Module from './Module';

export interface ModuleCtor {
	new (client: any): Module<any>;
}

type PostMessage = (
	this: unknown,
	message: unknown,
	transfer: Transferable[],
) => void;

type CallIn = (method: Function, that: unknown, args: unknown[]) => unknown;

/** the largest markup an inline document takes (the worker refuses more) */
const INLINE_DOCUMENT_MAX = 4 * 1024 * 1024;

/**
 * `MessageEvent.prototype.data` as the browser made it, taken when the
 * bundle runs, before any script of the page: what a message that carries
 * a wasm module is read with (requestModules)
 */
const messageData = Reflect.getOwnPropertyDescriptor(
	MessageEvent.prototype,
	'data',
)?.get;

export default class Client {
	modules: Map<ModuleCtor, Module<any>>;
	global: typeof globalThis;
	codec: GenericCodec;
	/** this controller's address, what every route of this context starts with (config.directory) */
	directory: string;
	/** the scope the bundles are served from (config.scope) */
	scope: string;
	/** the host handles window.open / target=_blank (config.openTab) */
	openTab: boolean;
	/** a synchronous request completes: the transport runs in the transport worker (config.workerTransport) */
	workerTransport: boolean;
	/** set while the markup the page writes is rewritten (WriteStream) */
	writing = false;
	/** the service worker's build id, from the shell */
	build?: string;
	/** unparseable scripts fail instead of running raw when false (config.allowInvalidJs) */
	allowInvalidJs: boolean;
	/** the window membrane is on (config.membrane, on unless false) */
	membrane: boolean;
	/** pages get emulated service workers (config.serviceWorkers, on unless false) */
	serviceWorkers: boolean;
	/** the wasm rewriters answer where this realm holds them (config.rewriter) */
	wasmRewriter: boolean;
	/** the host's served file names (config.assets) */
	assets?: Assets;
	/** the built-in blocker is on (config.adblock): a document's inject applies the cosmetic rules it is handed */
	blocking: boolean;
	applied: boolean;
	/** @internal called after a response reached this context (fetch, XHR): caches that depend on the jar drop */
	readonly responseListeners = new Set<() => void>();
	/**
	 * @internal Globals of this realm that a module holds behind an accessor
	 * until the page first reads them (CanvasTaint's WebGL interfaces): each
	 * name's function makes it the plain data property it natively is. The
	 * Reflection module calls it before any reflective question about the
	 * name on the window, so a page never sees the accessor.
	 */
	readonly lazyGlobals = new Map<string, () => void>();
	/**
	 * @internal Globals a module deleted and defined again (lazyGlobals), by
	 * the key they came after: the Reflection module lists the window's keys
	 * with each back in its native place
	 */
	readonly globalKeyAfter = new Map<string, PropertyKey>();
	/** @internal how often document.cookie went to the jar (cookie-cache suite) */
	cookieReads = 0;
	isDOM: boolean;
	isWorker: boolean;
	/** the document's policy upgrades insecure requests (its shell says so; src/mixedContent.ts) */
	upgradeInsecureRequests = false;
	#bare?: BareCompatibleClient;
	/** set by the Context module: maps the real `top` to the proxied world's top */
	resolveTop?: (value: unknown) => unknown;
	/** set by the Context module: a window of another proxied origin, read through the access API (`frames[i]`, `window[name]`), becomes its restricted stand-in */
	restrictForeign?: (value: unknown, container?: unknown) => unknown;
	/** set by the Reflection module: `key` is a helper name, which the page never finds on `target` */
	hidesName?: (target: unknown, key: unknown) => boolean;
	/**
	 * @internal set by the Sandbox module: what a read of another window's
	 * location (`real`, its stand-in `standIn`) gives a sandboxed document,
	 * which may not navigate every window
	 */
	gateLocation?: (real: unknown, standIn: unknown) => unknown;
	/** @internal set by the Sandbox module: throws when a sandboxed document may not navigate `target` to `value` */
	gateNavigation?: (target: unknown, value: unknown) => void;
	/** @internal this context's native window.postMessage, taken before the Context module wraps it: another context posting here calls it from its own realm */
	nativePostMessage?: PostMessage;
	/** @internal the Context module's wrapper over window.postMessage: a page that replaced it is called as written */
	hookedPostMessage?: unknown;
	/** @internal set by the Context module: post `args` to a STomp window from this realm, so this context is the incumbent (source and origin are its own) */
	postToWindow?: (target: object, args: unknown[]) => unknown;
	readonly #callIn: CallIn;
	readonly #ownCallback: (callback: () => void) => () => void;
	/**
	 * Call `method` as this client's window would: through a function of that
	 * window's own realm, so the browser takes the window for the incumbent
	 * (a message's source, a navigation's initiator). This client's code may
	 * be another realm's: a parent's bundle injects an iframe's initial
	 * about:blank, and the client stays on the window when the frame
	 * navigates to a document of the same origin (the browser keeps the
	 * Window). Plain `Reflect.apply` for a window without a Function
	 * constructor of its own
	 */
	callIn(method: Function, that: unknown, args: unknown[]): unknown {
		return this.#callIn(method, that, args);
	}
	/**
	 * `callback` behind a function of this client's window's realm, for a
	 * timer: the browser runs a timer's callback in the realm that made it
	 */
	ownCallback(callback: () => void): () => void {
		return this.#ownCallback(callback);
	}
	/**
	 * Whether this context's requests go from an opaque origin (a document
	 * the page sandboxed without allow-same-origin): the request modules tell
	 * the worker (OPAQUE_HEADER), which then judges them as the browser
	 * judges an opaque origin's
	 */
	get opaqueRequests(): boolean {
		return false;
	}
	/** @internal set by the Context module: post `args` to the window behind a restricted stand-in this context holds, from this realm; false when `target` is not one */
	postToRestricted?: (target: unknown, args: unknown[]) => boolean;
	// pristine copies taken before modules hook them: the Navigator module
	// removes navigator.serviceWorker from proxied pages
	#serviceWorkerContainer?: ServiceWorkerContainer;
	#portPostMessage?: PostMessage;
	#serviceWorkerPostMessage?: PostMessage;
	#workerPostMessage?: PostMessage;
	/**
	 * The location of the context (or page)
	 * Will always return a URL that can be used to resolve urls
	 */
	get url(): StompURL {
		return this.location;
	}
	/**
	 * The location of the context
	 * May not match the context URL
	 */
	get location(): StompURL {
		// a document the page made, or an inline document the worker served:
		// its shell named the URL it shows (with the live fragment)
		const named = (this.global as Record<string, unknown>)[WORKER_BASE];
		if (typeof named === 'string' && this.isDOM) {
			const url = new URL(named);
			const hash = this.global.location.hash;
			if (hash) url.hash = hash;
			return new StompURL(
				url,
				this.codec,
				`${this.global.location.origin}${this.directory}`,
			);
		}
		// this client's own window, not the bundle's: a popup or frame the
		// opener injected (about:blank) runs the opener's bundle
		const location = this.global.location;
		if (ROUTE_PROTOCOLS.includes(location.protocol)) {
			return parseRoutedURL(
				location.toString(),
				this.codec,
				`${location.origin}${this.directory}`,
			).url;
		} else {
			// a worker started from a blob: URL belongs to the page that made it
			const base = (this.global as Record<string, unknown>)[WORKER_BASE];
			return new StompURL(
				typeof base === 'string' ? base : location.toString(),
				this.codec,
				`${location.origin}${this.directory}`,
			);
		}
	}
	/** the helper names this deployment uses (src/helperNames.ts) */
	readonly names: HelperNames;
	/** the host set its own helper names: pass them on to every shell this client writes */
	readonly #customNames: boolean;
	/** the host's hooks, as text (config.hooks) */
	readonly hooks?: ResolvedHooks;
	/** the realm's Function before the Function module wraps it: a hook is host code, not rewritten */
	readonly #nativeFunction: FunctionConstructor;
	constructor(init: ParsedConfig, global: typeof globalThis) {
		this.names = helperNames(init);
		this.#customNames = !!(init as { names?: unknown }).names;
		this.hooks = init.hooks;
		this.#nativeFunction = global.Function;
		// built now, before any page script runs, from the window's own
		// Function, over the bundle's snapshot of Reflect.apply: a page that
		// later replaces Reflect.apply or Function never sees the method, the
		// target or the arguments (the native postMessage, a route)
		// Their code has no URL of its own, and their frames are under the
		// page's (the timer that writes the page's markup runs every script
		// in it): named under the proxy's scope, the stack cleaner drops them
		// as it drops the bundle's (Unroute)
		const realmOrigin = global.location?.origin;
		const sourceURL =
			realmOrigin && realmOrigin !== 'null'
				? `\n//# sourceURL=${realmOrigin}${init.scope || init.directory}`
				: '';
		try {
			this.#callIn = new this.#nativeFunction(
				'apply',
				`return function (method, that, args) { return apply(method, that, args); };${sourceURL}`,
			)(Reflect.apply) as CallIn;
			this.#ownCallback = new this.#nativeFunction(
				`return function (callback) { return function () { callback(); }; };${sourceURL}`,
			)() as (callback: () => void) => () => void;
		} catch (error) {
			this.#callIn = (method, that, args) => Reflect.apply(method, that, args);
			this.#ownCallback = (callback) => () => callback();
		}
		this.global = global;
		this.applied = false;
		this.modules = new Map();
		this.codec = init.codec;
		this.directory = init.directory;
		this.scope = init.scope || init.directory;
		// the realm's own origin is the proxy's (native at this point): a URL
		// under its scope is already a route (routeURL unwraps it)
		const origin = global.location?.origin;
		if (origin && origin !== 'null') addRouteScope(origin, this.scope);
		this.openTab = !!init.openTab;
		this.workerTransport = !!init.workerTransport;
		this.build = init.build;
		this.allowInvalidJs = init.allowInvalidJs !== false;
		this.membrane = init.membrane !== false;
		this.serviceWorkers = init.serviceWorkers !== false;
		this.wasmRewriter = init.rewriter === 'wasm';
		this.assets = init.assets;
		this.blocking = !!init.adblock;
		// a stale cached bundle next to a new service worker: say so once,
		// the page still gets its best effort
		if (init.build && init.build !== BUILD)
			console.error(
				`Stomp: this inject bundle is build ${BUILD} but the service worker is build ${init.build}; hard-reload the page`,
			);
		this.isDOM = false;
		this.isWorker = false;
		this.#serviceWorkerContainer = (
			global.navigator as Navigator & {
				serviceWorker?: ServiceWorkerContainer;
			}
		)?.serviceWorker;
		this.#serviceWorkerPostMessage = (
			global.ServiceWorker as typeof ServiceWorker | undefined
		)?.prototype.postMessage as PostMessage | undefined;
		this.#portPostMessage = (
			global.MessagePort as typeof MessagePort | undefined
		)?.prototype.postMessage as PostMessage | undefined;
		this.#workerPostMessage = (global.Worker as typeof Worker | undefined)
			?.prototype.postMessage as PostMessage | undefined;
	}
	get config(): Config {
		return {
			directory: this.directory,
			scope: this.scope,
			codec: codecType(this.codec),
			...(this.openTab ? { openTab: true } : {}),
			...(this.workerTransport ? { workerTransport: true } : {}),
			...(this.build ? { build: this.build } : {}),
			...(this.allowInvalidJs ? {} : { allowInvalidJs: false }),
			...(this.membrane ? {} : { membrane: false }),
			...(this.serviceWorkers ? {} : { serviceWorkers: false }),
			...(this.wasmRewriter ? { rewriter: 'wasm' } : {}),
			...(this.assets ? { assets: this.assets } : {}),
			...(this.blocking ? { adblock: true } : {}),
			...(this.#customNames ? { names: this.names } : {}),
			...(this.hooks ? { hooks: this.hooks } : {}),
		};
	}
	/**
	 * Bare-compatible client for this context, backed by the controller's
	 * transport. Created on first use so contexts that never open a WebSocket
	 * don't hold a port.
	 */
	get bare(): BareCompatibleClient {
		if (!this.#bare)
			this.#bare = new BareCompatibleClient(
				new RemoteTransport(this.ownTransportPort()),
			);

		return this.#bare;
	}
	/**
	 * The port this context's own transport talks over.
	 * Documents ask the service worker; workers are handed one by their creator.
	 */
	protected ownTransportPort(): MessagePort | Promise<MessagePort> {
		return this.requestTransportPort();
	}
	/** whether a service worker controls this realm (its routed requests reach the worker) */
	get controlled(): boolean {
		try {
			return !!this.#serviceWorkerContainer?.controller;
		} catch (error) {
			return false;
		}
	}
	/** @internal this bundle's native fetch, which runs in this client's realm */
	nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		return fetch(input, init);
	}
	/**
	 * The nearest client whose document a service worker controls: this one,
	 * or an ancestor up the chain of each client's native parent (the
	 * page-facing getter hands a frame of another origin, or an opaque one,
	 * the restricted stand-in). Null when there is none.
	 */
	controlledClient(): Client | null {
		if (this.controlled) return this;
		if (!this.isDOM) return null;
		const parentOf = (client: Client) =>
			(client as unknown as { parent?: typeof globalThis }).parent;
		let below: typeof globalThis = this.global;
		let parent = parentOf(this);
		for (let depth = 0; depth < 16; depth++) {
			try {
				if (!parent || parent === below) break;
				const next = (parent as unknown as Record<string, Client | undefined>)[
					this.names.client
				];
				if (!next) break;
				if (next.controlled) return next;
				below = next.global;
				parent = parentOf(next);
			} catch (error) {
				// a cross-origin ancestor ends the walk
				break;
			}
		}
		return null;
	}
	/** the nearest client whose document is a routed page of its controller: this one or an ancestor */
	routedClient(): Client | null {
		const routed = (client: Client) => {
			try {
				const { origin, href } = client.global.location;
				return (
					client.controlled && href.startsWith(`${origin}${client.directory}`)
				);
			} catch (error) {
				return false;
			}
		};
		if (routed(this)) return this;
		if (!this.isDOM) return null;
		const parentOf = (client: Client) =>
			(client as unknown as { parent?: typeof globalThis }).parent;
		let below: typeof globalThis = this.global;
		let parent = parentOf(this);
		for (let depth = 0; depth < 16; depth++) {
			try {
				if (!parent || parent === below) break;
				const next = (parent as unknown as Record<string, Client | undefined>)[
					this.names.client
				];
				if (!next) break;
				if (routed(next)) return next;
				below = next.global;
				parent = parentOf(next);
			} catch (error) {
				break;
			}
		}
		return null;
	}
	/**
	 * The fetch a routed request goes through: this realm's own when a service
	 * worker controls it, else the nearest controlled ancestor's. An object's
	 * or embed's document is not controlled (Chrome never hands their loads
	 * to a service worker), so its routed requests would miss the worker and
	 * reach the proxy origin's server.
	 */
	routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const client = this.controlledClient();
		if (!client || client === this) return fetch(input, init);
		// through the ancestor's realm the request's client is the ancestor,
		// whose URL would be the referrer. An about:blank document's URL strips
		// to no referrer (a request that names one keeps it, under the policy
		// about:blank inherited, which is the ancestor's)
		let blank = false;
		try {
			blank = /^about:blank([?#]|$)/.test(this.global.location.href);
		} catch (error) {
			// a window being torn down: as the ancestor
		}
		const named =
			init?.referrer !== undefined && init.referrer !== 'about:client';
		// a Request's members are getters a spread would not copy (it may be
		// this document's realm's, which the bundle's Request is not)
		if (blank && !named)
			init =
				init instanceof Request || init instanceof this.global.Request
					? new Request(init as Request, { referrer: '' })
					: { ...init, referrer: '' };
		return client.nativeFetch(input, init);
	}
	/**
	 * post to the service worker that controls this document; whether it
	 * went. With `throws`, a message that cannot be cloned throws (the page's
	 * own postMessage to an emulated service worker)
	 */
	postToWorker(
		message: object,
		transfer: Transferable[] = [],
		throws = false,
	): boolean {
		const controller = this.#serviceWorkerContainer?.controller;
		if (!controller || !this.#serviceWorkerPostMessage) return false;
		try {
			this.#serviceWorkerPostMessage.call(controller, message, transfer);
			return true;
		} catch (error) {
			if (throws) throw error;
			return false;
		}
	}
	/**
	 * The routed URL of an inline document (src/server/inline.ts) for markup
	 * the page made itself: registered with the worker under a fresh token by
	 * the nearest controlled document, and served once, rewritten by the
	 * worker, at `<address>inline:<token>/<referrer URL>`. A frame navigated
	 * there is controlled, so its subresources reach the worker. `url` is the
	 * document's URL as its readbacks show it; `referrer` is what the worker
	 * takes as its URL for the Referer of its requests (about:blank or data:
	 * send none). Null when no controlled document can register it, or the
	 * markup is too large.
	 */
	inlineDocument(markup: string, url: string, referrer: string): string | null {
		if (markup.length > INLINE_DOCUMENT_MAX) return null;
		// registered by a routed document of this controller (the worker takes
		// registrations from those only: an about:blank or srcdoc document's
		// URL says nothing about which controller it belongs to)
		const client = this.routedClient();
		if (!client) return null;
		const token = this.#token();
		if (
			!client.postToWorker({
				[INLINE_DOCUMENT]: {
					directory: client.directory,
					token,
					markup,
					url,
				},
			})
		)
			return null;
		const origin = client.global.location.origin;
		const encoded = new StompURL(
			referrer,
			client.codec,
			`${origin}${client.directory}`,
		).encode();
		return `${origin}${client.directory}inline:${token}/${encoded}`;
	}

	/** 16 random bytes in base64url, for the worker's single-use tokens */
	#token(): string {
		const bytes = new Uint8Array(16);
		this.global.crypto.getRandomValues(bytes);
		let token = '';
		for (const byte of bytes) token += String.fromCharCode(byte);
		return btoa(token)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	}

	/**
	 * An about:srcdoc document tells the worker whose it is, before any of
	 * the page's script runs. Its URL names no origin, and under a
	 * no-referrer policy its requests carry no Referer either, so the worker
	 * would judge them as an opaque origin's. The nearest routed ancestor,
	 * whose route names its real origin and partition, vouches for a token
	 * this document makes, and this document's own client claims it
	 * (SRCDOC_VOUCH, SRCDOC_CLAIM): each load binds itself, so a frame that
	 * loads again is bound again. A document with no such ancestor, or an
	 * opaque one (sandboxed without allow-same-origin), claims nothing, which
	 * tells the worker not to wait for it.
	 */
	#bindSrcdoc() {
		if (!this.isDOM) return;
		try {
			if (this.global.location.href !== 'about:srcdoc') return;
		} catch (error) {
			return;
		}
		let token = '';
		try {
			const client = this.opaqueRequests ? null : this.routedClient();
			if (client && client !== this) {
				const minted = this.#token();
				if (
					client.postToWorker({
						[SRCDOC_VOUCH]: { directory: client.directory, token: minted },
					})
				)
					token = minted;
			}
		} catch (error) {
			// an ancestor that cannot vouch: claims nothing
		}
		this.postToWorker({
			[SRCDOC_CLAIM]: { directory: this.directory, token },
		});
	}

	/**
	 * Tell the service worker the page aborted the request it sent with this
	 * id (the browser does not relay a fetch's abort to the worker): the
	 * worker stops waiting for the origin and reports the request as aborted.
	 */
	abortRequest(id: string) {
		const controller = this.#serviceWorkerContainer?.controller;
		if (!controller || !this.#serviceWorkerPostMessage) return;
		try {
			this.#serviceWorkerPostMessage.call(
				controller,
				{ [ABORT_REQUEST]: id },
				[],
			);
		} catch (error) {
			// the worker is gone: nothing to tell
		}
	}
	/**
	 * Ask the controller (through the service worker) to serve a transport on
	 * a fresh port and return our end of it.
	 */
	requestTransportPort(): MessagePort {
		const controller = this.#serviceWorkerContainer?.controller;

		if (!controller || !this.#serviceWorkerPostMessage)
			throw new Error(
				'Stomp: no service worker controller available to obtain a transport',
			);

		const channel = new MessageChannel();

		this.#serviceWorkerPostMessage.call(
			controller,
			{ [INIT_REMOTE_TRANSPORT]: { directory: this.directory } },
			[channel.port2],
		);

		return channel.port1;
	}
	/**
	 * Ask the controller (through the service worker) for the wasm modules
	 * it compiled (`rewriter: 'wasm'`), each handed to `adopt` when the
	 * answer arrives. A compiled module is posted only within an agent
	 * cluster: a document outside the controller's (a tab opened with
	 * noopener) hears a messageerror instead and keeps the JavaScript
	 * rewriter, as every document does until the answer is in.
	 */
	requestModules(adopt: (name: string, module: WebAssembly.Module) => void) {
		const controller = this.#serviceWorkerContainer?.controller;
		if (!controller || !this.#serviceWorkerPostMessage) return;
		const channel = new MessageChannel();
		const port = channel.port1;
		port.addEventListener('message', (event) => {
			// read with nothing the page can have replaced by now
			// (`MessageEvent.prototype.data`, `Object.keys`, an array's
			// iterator): a module of the page's own choosing would be the
			// rewriter of everything this top and its frames evaluate
			const own = (from: unknown, key: string): unknown =>
				typeof from === 'object' && from !== null
					? Reflect.getOwnPropertyDescriptor(from, key)?.value
					: undefined;
			const modules = own(
				messageData ? Reflect.apply(messageData, event, []) : undefined,
				PAGE_MODULES,
			);
			if (typeof modules === 'object' && modules !== null) {
				const names = Reflect.ownKeys(modules);
				for (let i = 0; i < names.length; i++) {
					const name = names[i];
					if (typeof name === 'string')
						adopt(name, own(modules, name) as WebAssembly.Module);
				}
			}
			port.close();
		});
		port.addEventListener('messageerror', () => port.close());
		port.start();
		try {
			this.#serviceWorkerPostMessage.call(
				controller,
				{ [INIT_PAGE_MODULES]: { directory: this.directory } },
				[channel.port2],
			);
		} catch (error) {
			port.close();
		}
	}
	/**
	 * Messages the service worker posts to this document (storage changes),
	 * on the container kept from before the page lost `navigator.serviceWorker`.
	 */
	/** whether this context is a child of a proxied document (a document client decides) */
	get nested(): boolean {
		return false;
	}
	/** the nested route marker for a navigation from this context (a document client decides) */
	get nestedRoute(): string | false {
		return false;
	}
	/**
	 * This context's storage partition (src/partition.ts): '' for a
	 * first-party context, `^<top-level site>` for one under a top-level
	 * document of another site. A document decides it, a worker takes its
	 * creator's.
	 */
	get partition(): string {
		return '';
	}
	/**
	 * What this context's stores are keyed by: its origin, and its
	 * partition after it (the name suffixes of the Partition, IndexedDB and
	 * Storage modules, the shared workers' names)
	 */
	get storageKey(): string {
		return `${this.url.url.origin}${this.partition}`;
	}
	/** @internal a response reached this context */
	notifyResponse() {
		for (const listener of this.responseListeners) listener();
	}
	/** the same, with the whole event (its ports): the emulated service workers' messages */
	onServiceWorkerEvent(listener: (event: MessageEvent) => void) {
		const container = this.#serviceWorkerContainer;
		if (!container) return;
		container.addEventListener('message', (event) =>
			listener(event as MessageEvent),
		);
		container.startMessages?.();
	}
	onServiceWorkerMessage(listener: (data: unknown) => void) {
		const container = this.#serviceWorkerContainer;
		if (!container) return;
		container.addEventListener('message', (event) =>
			listener((event as MessageEvent).data),
		);
		container.startMessages?.();
	}
	/**
	 * Hand a freshly constructed dedicated worker its own transport port.
	 * The worker's inject bundle resolves it from the TRANSPORT_INIT message.
	 */
	/** the same, for a SharedWorker's port (the worker hears it on connect) */
	provisionPortTransport(port: MessagePort) {
		try {
			const transport = this.requestTransportPort();
			this.#portPostMessage!.call(port, { [TRANSPORT_INIT]: true }, [
				transport,
			]);
		} catch (error) {
			console.warn(
				'Stomp: could not provision a transport for a shared worker',
				error,
			);
		}
	}
	provisionWorkerTransport(worker: Worker) {
		try {
			const port = this.requestTransportPort();
			this.#workerPostMessage!.call(worker, { [TRANSPORT_INIT]: true }, [port]);
		} catch (error) {
			console.warn(
				'Stomp: could not provision a transport for a worker',
				error,
			);
		}
	}
	/*
	 called once all modules are created
	 apis can be called, functions can be hooked
	*/
	/**
	 * @param deferPost the HTML shell's loadHTML follows and runs the post
	 * hook itself, after its document.open (which drops every listener a
	 * hook registered before it)
	 */
	apply(deferPost = false) {
		this.#bindSrcdoc();
		this.runHook('pre');
		for (const module of this.modules.values()) {
			if (module.apply) {
				module.apply();
			}
		}

		this.applied = true;
		if (!deferPost) this.runHook('post');
	}
	/**
	 * Run the host's code for `phase` in this realm (src/hooks.ts): raw, with
	 * the realm's real globals, one argument. A throw never reaches the shell:
	 * it is logged here and reported to the host (`hookerror`); a promise it
	 * returns is not awaited, its rejection is reported the same way.
	 */
	/** whether the host's hooks run here (a document whose scripts are off runs none) */
	protected runsHooks(): boolean {
		return true;
	}
	runHook(phase: HookPhase) {
		const source = this.hooks?.[phase];
		if (!source) return;
		if (this.isWorker && !this.hooks?.workers) return;
		if (!this.runsHooks()) return;
		const context = this.hookContext(phase);
		const report = (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			console.error(
				`Stomp: the host's ${phase} hook threw in ${context.url}: ${message}`,
			);
			this.reportHookError({
				phase,
				kind: context.kind,
				url: context.url,
				message,
				...(stack ? { stack } : {}),
			});
		};
		try {
			const result: unknown = Reflect.apply(
				new this.#nativeFunction('stomp', source),
				this.global,
				[context],
			);
			if (
				typeof result === 'object' &&
				result !== null &&
				typeof (result as Promise<unknown>).then === 'function'
			)
				(result as Promise<unknown>).then(undefined, report);
		} catch (error) {
			report(error);
		}
	}
	/** what a hook is handed; documents add what they know (DocumentClient) */
	protected hookContext(phase: HookPhase): HookContext {
		const global = this.global as unknown as Record<string, unknown>;
		const id = this.directory.startsWith(this.scope)
			? this.directory.slice(this.scope.length).replace(/\/$/, '')
			: '';
		return {
			url: this.url.toString(),
			origin: this.url.url.origin,
			isTop: false,
			nested: false,
			kind:
				typeof global.SharedWorkerGlobalScope === 'function'
					? 'sharedWorker'
					: 'worker',
			phase,
			names: this.names,
			...(id ? { frameId: id } : {}),
			window: this.global,
		};
	}
	/** a document posts the report to the host; a worker has nobody to tell */
	protected reportHookError(_info: HookErrorInfo): void {}
	addModule(Module: ModuleCtor) {
		this.modules.set(Module, new Module(this));
	}
	getModule<T extends ModuleCtor>(Module: T): InstanceType<T> | undefined {
		if (!this.modules.has(Module)) {
			return undefined;
		}
		return <InstanceType<T>>this.modules.get(Module);
	}
}

export function createClientFactory<T>(
	Client: {
		new (init: ParsedConfig, global: typeof globalThis): T;
	},
	initClient: (client: T) => void,
) {
	return function (config: Config, codecKey: string) {
		delete globalThis.createClient;

		const client = new Client(parseConfig(config, codecKey), globalThis);

		initClient(client);

		Reflect.defineProperty(globalThis, helperNames(config).client, {
			value: client,
			configurable: false,
			enumerable: false,
		});
	};
}
