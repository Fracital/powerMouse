import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { Config, ConfigCodec } from '../config';
import { isUrlLike, urlLike } from '../StompURL';
import {
	CONTROLLER_INIT,
	CONTROLLER_RPC,
	Controllerbound,
	ControllerInitMessage,
	NAVIGATE,
	NavigateInfo,
	OPEN_TAB,
	postToPort,
	SW_REVIVE,
	SWbound,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import serveTransport from '../transport/serveTransport';
import { BUILD } from '../version';
import { canTraverse, traverse } from './history';
import { DEFAULT_SANDBOX } from './remote';

export { default as SearchBuilder } from '../bootstrapper/SearchBuilder';
export type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
export type { Config, ConfigCodec } from '../config';

export { RemoteController, RemoteFrame, DEFAULT_SANDBOX } from './remote';
export type { RemoteControllerInit } from './remote';
export type { TransportDescriptor, FrameInfo } from './messages';
export type { NavigateInfo } from '../transport/messages';

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
	 * HTTP cache in the service worker, off by default: GET/HEAD responses
	 * with explicit freshness (max-age, Expires) are kept in a Cache API
	 * store and revalidated when stale; `clearCache()` drops it.
	 */
	cache?: boolean;
	/**
	 * sandbox flags for proxied frames, default `DEFAULT_SANDBOX`. Same-origin
	 * frames are not a security boundary, but without a sandbox the browser
	 * lets `<a target="_top">`, `<form target="_parent">` and
	 * `window.open(url, '_top')` navigate the host page. `null` disables it.
	 */
	sandbox?: string | null;
}

/** a navigate report posted by a proxied page, else null */
export function navigateReport(data: unknown): NavigateInfo | null {
	if (typeof data !== 'object' || data === null) return null;
	const info = (data as Record<string, unknown>)[NAVIGATE];
	if (typeof info !== 'object' || info === null) return null;
	const { url, title, canGoBack, canGoForward } = info as NavigateInfo;
	if (typeof url !== 'string' || typeof title !== 'string') return null;
	return {
		url,
		title,
		canGoBack: typeof canGoBack === 'boolean' ? canGoBack : null,
		canGoForward: typeof canGoForward === 'boolean' ? canGoForward : null,
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
export class StompController {
	config: Config;
	directory: URL;
	serviceworker: ServiceWorker;
	transport: ProxyTransport;
	frames: Frame[] = [];
	isReady = false;
	private sandbox: string | null;
	private port?: MessagePort;
	private rpc?: RpcHelper<Controllerbound, SWbound>;
	private stopServing?: () => void;
	private ready: Promise<void>;
	private readyResolve!: () => void;
	private readyReject!: (error: Error) => void;
	private lastHandshake = 0;
	constructor(init: ControllerInit) {
		if (!('serviceWorker' in navigator))
			throw new Error('Your browser does not support service workers.');

		this.serviceworker = init.serviceworker;
		this.transport = init.transport;
		this.sandbox = init.sandbox === undefined ? DEFAULT_SANDBOX : init.sandbox;
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
			...(init.cache ? { cache: true } : {}),
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
				frame.report(navigate);
				init.onNavigate?.(navigate, frame);
				return;
			}
			const url = openRequest(event.data);
			if (url !== null && init.onOpen) init.onOpen(url, frame);
		});

		this.ready = new Promise((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		// an unhandled rejection is noise when the host only reads isReady
		this.ready.catch(() => {});

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
					if (build !== undefined && build !== BUILD) {
						const error = new Error(
							`Stomp version mismatch: the controller is build ${BUILD}, the service worker is build ${build}; hard-reload the page or clear the old service worker`,
						);
						console.error(error.message);
						this.readyReject(error);
						return;
					}
					// the id both sides agreed on, visible to the host
					if (build !== undefined) this.config = { ...this.config, build };
					this.isReady = true;
					this.readyResolve();
				},
				initRemoteTransport: async (port) => {
					serveTransport(port, () => this.transport);
				},
			},
			CONTROLLER_RPC,
			(data, transfer) => postToPort(port, data, transfer),
		);

		port.addEventListener('message', (event) => this.rpc!.receive(event.data));
		port.start();

		// the service worker's own transport shares this port with the rpc above
		this.stopServing = serveTransport(port, () => this.transport);

		const message: ControllerInitMessage = {
			directory: this.config.directory,
			config: this.config,
			build: BUILD,
		};

		this.serviceworker.postMessage({ [CONTROLLER_INIT]: message }, [
			channel.port2,
		]);
	}
	/** resolves once the service worker has created a server for this controller */
	async wait(): Promise<void> {
		await this.ready;
	}
	/** hot-swap the transport; in-flight requests finish on the old one */
	setTransport(transport: ProxyTransport) {
		this.transport = transport;
	}
	/** drop every entry of the service worker's HTTP cache */
	async clearCache(): Promise<void> {
		await this.ready;
		await this.rpc!.call('clearCache', undefined);
	}
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
