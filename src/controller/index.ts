import type {
	ProxyTransport,
	RawHeaders,
} from '@mercuryworkshop/proxy-transports';
import { Config, ConfigCodec } from '../config';
import { isUrlLike, urlLike } from '../StompURL';
import type { RequestRule } from '../transport/messages';
import {
	CONTROLLER_INIT,
	CONTROLLER_RPC,
	Controllerbound,
	ControllerInitMessage,
	CookieCommand,
	CookieRecord,
	CookieResult,
	NAVIGATE,
	NavigateInfo,
	OPEN_TAB,
	postToPort,
	RequestInfo,
	SW_REVIVE,
	SWbound,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import serveTransport from '../transport/serveTransport';
import { BUILD } from '../version';
import { canTraverse, traverse } from './history';
import type { StaleInfo } from './messages';
import { DEFAULT_SANDBOX } from './remote';

export { default as SearchBuilder } from '../bootstrapper/SearchBuilder';
export type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
export type { Config, ConfigCodec } from '../config';

export { RemoteController, RemoteFrame, DEFAULT_SANDBOX } from './remote';
export type { RemoteControllerInit } from './remote';
export type { TransportDescriptor, FrameInfo } from './messages';
export type {
	NavigateInfo,
	CookieRecord,
	RequestInfo,
} from '../transport/messages';

export interface ControllerInit {
	/** the registered (and ideally active) Stomp service worker */
	serviceworker: ServiceWorker;
	/** transport that proxied traffic goes through, e.g. an EpoxyTransport */
	transport: ProxyTransport;
	codec?: ConfigCodec;
	/**
	 * URL of the directory `serviceworker` is scoped to and `dist/` is served
	 * from. Defaults to the directory of the current script, or of the page
	 * when loaded as a module.
	 */
	directory?: urlLike;
	/** origins allowed to frame proxied documents (CSP frame-ancestors) */
	frameAncestors?: string[];
	/**
	 * Called when a proxied page wants a new tab (`window.open`, a link with
	 * `target="_blank"` or a name, a modifier click). The page's `window.open`
	 * then returns null, like a popup blocker. Without it, popups open
	 * natively as bare proxied tabs.
	 */
	onOpen?: (url: string, frame: Frame) => void;
	/**
	 * Called whenever a proxied page reports where it is (load, pushState,
	 * hashchange, title change); the same information arrives as a
	 * `navigate` CustomEvent on the Frame (`event.detail`).
	 */
	onNavigate?: (info: NavigateInfo, frame: Frame) => void;
	/** @internal pages may post open requests; set by the controller frame */
	openTab?: boolean;
	/**
	 * Called once per proxied request with what the service worker saw: real
	 * URL, method, destination, status, time, whether the cache answered, the
	 * size, an error, and the Frame it belongs to when known. Nothing is
	 * built or sent when unset.
	 */
	onRequest?: (info: RequestEvent) => void;
	/** @internal the service worker sends request reports; set by the controller frame */
	requestLog?: boolean;
	/**
	 * HTTP cache in the service worker, on by default: GET/HEAD responses
	 * with explicit freshness (max-age, Expires) are kept in a Cache API
	 * store and revalidated when stale; `clearCache()` drops it. `false`
	 * turns it off.
	 */
	cache?: boolean;
	/**
	 * A script the rewriter cannot parse runs as it was (default, like a
	 * browser that does not know the syntax either). `false` makes it fail
	 * with a SyntaxError naming the rewriter error instead, so a broken
	 * rewrite is loud while developing.
	 */
	allowInvalidJs?: boolean;
	/** @internal ms before the service worker answers a routed request with 504 (tests) */
	fetchTimeout?: number;
	/**
	 * Request rules, run in the service worker on the real URL: block, answer
	 * with a status, redirect, or edit request and response headers; the
	 * first matching rule wins. `setRules()` replaces them later.
	 */
	rules?: RequestRule[];
	/**
	 * sandbox flags for proxied frames, default `DEFAULT_SANDBOX`. Same-origin
	 * frames are not a security boundary, but without a sandbox the browser
	 * lets `<a target="_top">`, `<form target="_parent">` and
	 * `window.open(url, '_top')` navigate the host page. `null` disables it.
	 */
	sandbox?: string | null;
}

/** a RequestInfo with the frame it belongs to, when the page reported its client id */
export interface RequestEvent extends RequestInfo {
	frame: Frame | null;
}

/** the host's view of the cookie jar (see StompController.cookies) */
export interface CookieJar {
	/** the Cookie header value the proxy would send to `url` */
	get(url: string): Promise<string>;
	/** apply Set-Cookie header values as if `url` had sent them */
	set(url: string, setCookie: string | string[]): Promise<void>;
	/** every stored cookie, or those a page of `origin` could receive */
	list(origin?: string): Promise<CookieRecord[]>;
	/** forget every cookie, or those of `origin` */
	clear(origin?: string): Promise<void>;
}

/** @internal a CookieJar over a command function */
export function cookieJar(
	run: (command: CookieCommand) => Promise<CookieResult>,
): CookieJar {
	return {
		get: async (url) => String((await run({ op: 'get', url })) ?? ''),
		set: async (url, setCookie) => {
			await run({ op: 'set', url, setCookie });
		},
		list: async (origin) =>
			((await run({ op: 'list', origin })) as CookieRecord[] | undefined) ?? [],
		clear: async (origin) => {
			await run({ op: 'clear', origin });
		},
	};
}

/** a navigate report posted by a proxied page, else null */
export function navigateReport(data: unknown): NavigateInfo | null {
	if (typeof data !== 'object' || data === null) return null;
	const info = (data as Record<string, unknown>)[NAVIGATE];
	if (typeof info !== 'object' || info === null) return null;
	const { url, title, canGoBack, canGoForward, client } = info as NavigateInfo;
	if (typeof url !== 'string' || typeof title !== 'string') return null;
	return {
		url,
		title,
		canGoBack: typeof canGoBack === 'boolean' ? canGoBack : null,
		canGoForward: typeof canGoForward === 'boolean' ? canGoForward : null,
		...(typeof client === 'string' ? { client } : {}),
	};
}

/** the URL of an open request posted by a proxied page, else null */
export function openRequest(data: unknown): string | null {
	if (typeof data !== 'object' || data === null) return null;
	const url = (data as Record<string, unknown>)[OPEN_TAB];
	return typeof url === 'string' ? url : null;
}

/** ignore the service worker's "revive" broadcast this soon after we registered */
const REVIVE_GUARD_MS = 2000;
/**
 * how long a service worker of another build gets to update and activate
 * before wait() resolves on the one we have (the new one is adopted when it
 * activates)
 */
const UPDATE_GRACE_MS = 5000;
/** how long after registration.update() to wait for `updatefound` before concluding nothing changed */
const UPDATE_FOUND_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** how long a document's request report waits for its page to say which frame it is in */
const ATTRIBUTION_WAIT_MS = 3000;
const DOCUMENT_DESTINATIONS = new Set([
	'document',
	'iframe',
	'frame',
	'embed',
	'object',
]);

/** resolves once the worker is activated; rejects when it becomes redundant */
export function activated(worker: ServiceWorker): Promise<ServiceWorker> {
	if (worker.state === 'activated') return Promise.resolve(worker);
	return new Promise((resolve, reject) => {
		worker.addEventListener('statechange', () => {
			if (worker.state === 'activated') resolve(worker);
			else if (worker.state === 'redundant')
				reject(new Error('Service worker became redundant'));
		});
	});
}

export type { StaleInfo };
export type {
	RequestRule,
	RequestRuleAction,
	RequestRuleMatch,
} from '../transport/messages';

function defaultDirectory(): URL {
	const script =
		typeof document !== 'undefined' &&
		(document.currentScript as HTMLScriptElement | null);
	return new URL('.', script && script.src ? script.src : location.href);
}

/**
 * Owns the transport and registers itself with the service worker.
 * Proxied content lives in frames created by `createFrame()`.
 */
/**
 * Events: `stale` (detail: StaleInfo) when the handshake met a service worker
 * of another build that could not be replaced in time, and `rebind` (detail:
 * `{ build }`) when a later handshake agrees again.
 */
export class StompController extends EventTarget {
	config: Config;
	/**
	 * set while the service worker serving this controller is another build
	 * than the controller (a deploy the browser has not finished installing);
	 * null once the builds agree
	 */
	stale: StaleInfo | null = null;
	directory: URL;
	serviceworker: ServiceWorker;
	transport: ProxyTransport;
	frames: Frame[] = [];
	isReady = false;
	/** service worker client ids the pages reported, by frame */
	private clientFrames = new Map<string, Frame>();
	private onRequest?: (info: RequestEvent) => void;
	private sandbox: string | null;
	private port?: MessagePort;
	private rpc?: RpcHelper<Controllerbound, SWbound>;
	private stopServing?: () => void;
	private ready: Promise<void>;
	private readyResolve!: () => void;
	private lastHandshake = 0;
	/** a build mismatch is being healed: the next ready answer must agree */
	private healing = false;
	private rules: RequestRule[];
	constructor(init: ControllerInit) {
		super();
		if (!('serviceWorker' in navigator))
			throw new Error('Your browser does not support service workers.');

		this.serviceworker = init.serviceworker;
		this.transport = init.transport;
		this.sandbox = init.sandbox === undefined ? DEFAULT_SANDBOX : init.sandbox;
		this.onRequest = init.onRequest;
		this.rules = init.rules ?? [];
		this.directory = isUrlLike(init.directory)
			? new URL(init.directory, location.href)
			: defaultDirectory();

		if (this.directory.origin !== location.origin)
			throw new Error('Stomp directory must be same-origin');

		this.config = {
			codec: init.codec ?? 'xor',
			directory: this.directory.pathname,
			...(init.frameAncestors ? { frameAncestors: init.frameAncestors } : {}),
			...(init.onOpen || init.openTab ? { openTab: true } : {}),
			...(init.cache === false ? { cache: false } : {}),
			...(init.onRequest || init.requestLog ? { requestLog: true } : {}),
			...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
			...(init.fetchTimeout ? { fetchTimeout: init.fetchTimeout } : {}),
		};

		window.addEventListener('message', (event) => {
			// only our own frames, same origin as this page in this mode
			if (event.origin !== location.origin) return;
			const frame = this.frames.find(
				(frame) => frame.element.contentWindow === event.source,
			);
			if (!frame) return;
			const navigate = navigateReport(event.data);
			if (navigate) {
				if (navigate.client) this.clientFrames.set(navigate.client, frame);
				frame.report(navigate);
				init.onNavigate?.(navigate, frame);
				return;
			}
			const url = openRequest(event.data);
			if (url !== null && init.onOpen) init.onOpen(url, frame);
		});

		this.ready = new Promise((resolve) => {
			this.readyResolve = resolve;
		});

		navigator.serviceWorker.addEventListener('message', (event) => {
			if (
				typeof event.data === 'object' &&
				event.data !== null &&
				SW_REVIVE in event.data &&
				Date.now() - this.lastHandshake > REVIVE_GUARD_MS
			) {
				const active = navigator.serviceWorker.controller;
				if (active) this.serviceworker = active;
				this.handshake();
			}
		});

		this.handshake();
		// a worker that activates after this handshake (a deploy the browser
		// installs while the page is open) is adopted without a reload
		this.watchRegistration();
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			const controller = navigator.serviceWorker.controller;
			if (
				controller &&
				controller !== this.serviceworker &&
				controller.scriptURL.startsWith(this.directory.href)
			)
				this.rebind(controller).catch(() => {});
		});
	}
	private async watchRegistration() {
		try {
			const registration = await navigator.serviceWorker.getRegistration(
				this.directory.href,
			);
			if (!registration) return;
			const adopt = (worker: ServiceWorker | null) => {
				if (!worker) return;
				activated(worker).then(
					() => {
						// heal() rebinds on its own once its worker is activated
						if (worker !== this.serviceworker && !this.healing)
							this.rebind(worker).catch(() => {});
					},
					() => {},
				);
			};
			registration.addEventListener('updatefound', () =>
				adopt(registration.installing),
			);
			adopt(registration.installing || registration.waiting);
		} catch (error) {
			// no registration to watch
		}
	}
	/**
	 * The service worker answered the handshake with another build: the page
	 * loaded a newer bundle than the worker still active (a deploy the browser
	 * has not finished installing), or the other way round. Update the
	 * registration and, when the new worker activates within the grace
	 * period, bind to it and shake hands again. Otherwise the user is not kept
	 * waiting: `wait()` resolves on the worker we have, `stale` records both
	 * builds (a `stale` event for the host's notice) and the new worker is
	 * adopted when it does activate (the old one may be pinned by a request
	 * that never settles).
	 */
	private async heal(build: string) {
		const settle = () => {
			this.healing = false;
			if (!this.stale)
				console.warn(
					`Stomp: the controller is build ${BUILD}, the service worker is build ${build}; the new worker has not activated yet, continuing with the old one and switching when it does`,
				);
			this.stale = { controller: BUILD, worker: build };
			this.config = { ...this.config, build };
			this.isReady = true;
			this.readyResolve();
			this.dispatchEvent(new CustomEvent('stale', { detail: this.stale }));
		};
		// the second mismatch in a row: the update did not help
		if (this.healing) return settle();
		this.healing = true;
		console.warn(
			`Stomp: the controller is build ${BUILD}, the service worker is build ${build}; updating the service worker`,
		);
		try {
			const worker = await Promise.race([
				this.updatedWorker(),
				sleep(UPDATE_GRACE_MS).then(() => null),
			]);
			if (!worker) return settle();
			await this.rebind(worker);
		} catch (error) {
			settle();
		}
	}
	/**
	 * The registration's newer worker, activated: one the browser already
	 * found, or one an update finds now. Null when there is nothing newer
	 * than the worker this controller talks to.
	 */
	private async updatedWorker(): Promise<ServiceWorker | null> {
		const registration = await navigator.serviceWorker.getRegistration(
			this.directory.href,
		);
		if (!registration) return null;
		// the registration's active worker is not the one we were handed (the
		// host picked while a newer one was installing): that one, now
		const active = registration.active;
		if (active && active !== this.serviceworker) return active;
		let worker: ServiceWorker | null =
			registration.installing || registration.waiting;
		if (!worker) {
			const found = new Promise<ServiceWorker | null>((resolve) =>
				registration.addEventListener(
					'updatefound',
					() => resolve(registration.installing),
					{ once: true },
				),
			);
			await registration.update().catch(() => {});
			worker = await Promise.race([
				found,
				sleep(UPDATE_FOUND_MS).then(
					() => registration.installing || registration.waiting,
				),
			]);
		}
		if (worker) return activated(worker);
		return null;
	}
	/**
	 * Talk to another service worker from now on (default: the registration's
	 * active worker) and shake hands again; the next ready answer settles
	 * `wait()` as usual. Hosts that update the worker themselves call this
	 * instead of reaching into the controller.
	 */
	async rebind(worker?: ServiceWorker): Promise<void> {
		if (!worker) {
			const registration = await navigator.serviceWorker.getRegistration(
				this.directory.href,
			);
			worker = registration?.active ?? undefined;
			if (!worker)
				throw new Error(`No active service worker for ${this.directory.href}`);
		}
		this.serviceworker = worker;
		this.handshake();
	}
	/** (re)register with the service worker over a fresh MessageChannel */
	private handshake() {
		if (this.port) {
			this.rpc?.abort('Service worker replaced');
			this.stopServing?.();
			this.port.close();
		}

		this.isReady = false;
		this.lastHandshake = Date.now();

		const channel = new MessageChannel();
		const port = channel.port1;
		this.port = port;

		this.rpc = new RpcHelper<Controllerbound, SWbound>(
			{
				ready: async (info) => {
					const build = info?.build;
					// the worker we already settled on as stale answers again
					// (it restarted): nothing new to heal
					if (
						build !== undefined &&
						build !== BUILD &&
						this.stale?.worker !== build
					) {
						this.heal(build);
						return;
					}
					this.healing = false;
					// the id both sides agreed on, visible to the host
					if (build !== undefined) this.config = { ...this.config, build };
					// the rules travel with every handshake (a new worker starts empty)
					if (this.rules.length) await this.rpc!.call('rules', this.rules);
					if (this.stale && build === BUILD) {
						this.stale = null;
						this.dispatchEvent(
							new CustomEvent('rebind', { detail: { build } }),
						);
					}
					this.isReady = true;
					this.readyResolve();
				},
				initRemoteTransport: async (port) => {
					serveTransport(port, () => this.transport, this.handshakeHeaders);
				},
				request: async (info) => {
					if (!this.onRequest) return;
					let frame =
						(info.client && this.clientFrames.get(info.client)) || null;
					// a document's own request is reported before its page has told
					// us which frame it is in: give that report a moment to arrive
					if (
						!frame &&
						info.client &&
						DOCUMENT_DESTINATIONS.has(info.destination)
					) {
						const deadline = Date.now() + ATTRIBUTION_WAIT_MS;
						while (!frame && Date.now() < deadline) {
							await sleep(50);
							frame = this.clientFrames.get(info.client) || null;
						}
					}
					this.onRequest({ ...info, frame });
				},
			},
			CONTROLLER_RPC,
			(data, transfer) => postToPort(port, data, transfer),
		);

		port.addEventListener('message', (event) => this.rpc!.receive(event.data));
		port.start();

		// the service worker's own transport shares this port with the rpc above
		this.stopServing = serveTransport(
			port,
			() => this.transport,
			this.handshakeHeaders,
		);

		const message: ControllerInitMessage = {
			directory: this.config.directory,
			config: this.config,
			build: BUILD,
		};

		this.serviceworker.postMessage({ [CONTROLLER_INIT]: message }, [
			channel.port2,
		]);
	}
	/**
	 * A page's WebSocket handshake carries the jar's Cookie header for the
	 * socket's URL, HttpOnly cookies included, under the SameSite rules for
	 * the page's origin (its Origin header). The header is added here, in
	 * the controller's realm, so the page never holds it; without a worker
	 * to ask (not ready, an error) the handshake goes out without one.
	 */
	private handshakeHeaders = async (
		url: URL,
		headers: RawHeaders,
	): Promise<RawHeaders> => {
		if (!this.isReady || !this.rpc) return headers;
		const origin = headers.find(([name]) => name.toLowerCase() === 'origin');
		try {
			const cookie = await this.rpc.call('cookies', {
				op: 'get',
				url: url.href,
				...(origin ? { initiator: origin[1] } : {}),
			});
			if (typeof cookie === 'string' && cookie)
				return [...headers, ['Cookie', cookie]];
		} catch (error) {
			// no jar answer: a handshake without cookies
		}
		return headers;
	};
	/** resolves once the service worker has created a server for this controller */
	async wait(): Promise<void> {
		await this.ready;
	}
	/** hot-swap the transport; in-flight requests finish on the old one */
	setTransport(transport: ProxyTransport) {
		this.transport = transport;
	}
	/** replace the request rules the service worker applies (see ControllerInit.rules) */
	async setRules(rules: RequestRule[]): Promise<void> {
		this.rules = rules;
		await this.ready;
		await this.rpc!.call('rules', rules);
	}
	/** drop every entry of the service worker's HTTP cache */
	async clearCache(): Promise<void> {
		await this.ready;
		await this.rpc!.call('clearCache', undefined);
	}
	/** @internal */
	async cookieCommand(command: CookieCommand): Promise<CookieResult> {
		await this.ready;
		return this.rpc!.call('cookies', command);
	}
	/**
	 * The cookie jar, for the host application only (pages never reach this
	 * port): read what the proxy would send, import Set-Cookie headers,
	 * export records, or wipe an origin.
	 */
	readonly cookies: CookieJar = cookieJar((command) =>
		this.cookieCommand(command),
	);
	/** the proxied URL a frame should navigate to in order to load `url` */
	async route(url: string): Promise<string> {
		await this.ready;
		return new URL(await this.rpc!.call('route', url), this.directory).href;
	}
	createFrame(element: HTMLIFrameElement = document.createElement('iframe')) {
		const frame = new Frame(this, element, this.sandbox);
		this.frames.push(frame);
		return frame;
	}
}

/**
 * A proxied frame. Dispatches `navigate` (CustomEvent, `detail` is a
 * NavigateInfo) whenever the page reports a new URL, title or history state.
 */
export class Frame extends EventTarget {
	/** the last report from the page, if any */
	lastNavigate: NavigateInfo | null = null;
	constructor(
		public controller: StompController,
		public element: HTMLIFrameElement,
		sandbox: string | null = DEFAULT_SANDBOX,
	) {
		super();
		if (sandbox !== null) element.setAttribute('sandbox', sandbox);
	}
	/** @internal */
	report(info: NavigateInfo) {
		this.lastNavigate = info;
		this.dispatchEvent(new CustomEvent('navigate', { detail: info }));
	}
	/** the last title the page reported, else the document's */
	get title(): string | null {
		if (this.lastNavigate) return this.lastNavigate.title;
		try {
			return this.element.contentDocument?.title ?? null;
		} catch {
			return null;
		}
	}
	async go(url: string) {
		this.element.src = await this.controller.route(url);
	}
	/**
	 * Step the frame's own history (proxied pages are same-origin, so it is
	 * reachable). Resolves false when there is no entry in that direction, so
	 * a host can show its own "nothing to go back to" state instead of
	 * letting history.back() walk the page that embeds the frame.
	 */
	async back(): Promise<boolean> {
		const win = this.element.contentWindow;
		return win ? traverse(win, 'back') : false;
	}
	async forward(): Promise<boolean> {
		const win = this.element.contentWindow;
		return win ? traverse(win, 'forward') : false;
	}
	/** whether the frame's own history has an entry before/after the current one; null when the browser cannot tell */
	get canGoBack(): boolean | null {
		return canTraverse(this.element.contentWindow, 'back');
	}
	get canGoForward(): boolean | null {
		return canTraverse(this.element.contentWindow, 'forward');
	}
	reload() {
		this.element.contentWindow?.location.reload();
	}
	/** the URL the frame is currently showing, if it is a proxied page */
	get url(): string | null {
		// proxied pages are same-origin; their inject client exposes the real location
		try {
			const win = this.element.contentWindow as
				(Window & { $P$s?: { url: { toString(): string } } }) | null;
			return win?.$P$s?.url.toString() ?? null;
		} catch {
			return null;
		}
	}
}

export default StompController;
