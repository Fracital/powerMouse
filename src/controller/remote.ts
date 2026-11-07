import { assetName } from '../config';
// Host-side controller for origin isolation. The real StompController runs in
// a hidden controller frame on the proxy origin (dist/controllerFrame.html);
// this class embeds that frame and mirrors the StompController / Frame API
// over postMessage. Proxied content is shown in sandboxed, cross-origin
// frames the host page can neither read nor be read by.
import type { Assets, Config, ConfigCodec } from '../config';
import type {
	NavigateInfo,
	RequestInfo,
	RequestRule,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import {
	cookieJar,
	CookieJar,
	navigateReport,
	NAVIGATION_WAIT_MS,
	openRequest,
	REPORT_GRACE_MS,
} from './index';
import {
	FrameBound,
	FrameCommand,
	FrameInfo,
	HostBound,
	REMOTE_RPC,
	StaleInfo,
	TransportDescriptor,
} from './messages';

export interface RemoteControllerInit {
	/** origin that serves dist/ and the proxied content, e.g. https://proxy.example.com */
	proxyOrigin: string;
	/** pathname of dist/ on that origin, default `/stomp/` */
	directory?: string;
	transport: TransportDescriptor;
	codec?: ConfigCodec;
	/**
	 * sandbox flags for proxied frames. The default keeps scripts, forms,
	 * popups, modals and downloads and deliberately omits top navigation so a
	 * page can never navigate the host.
	 */
	sandbox?: string;
	/** how often (ms) to refresh url/title of frames; 0 disables */
	pollInterval?: number;
	/**
	 * Called when a proxied page wants a new tab (`window.open`, a link with
	 * `target="_blank"` or a name, a modifier click). The page's `window.open`
	 * then returns null, like a popup blocker. Without it, popups open
	 * natively as bare proxied tabs.
	 */
	onOpen?: (url: string, frame: RemoteFrame) => void;
	/**
	 * Called whenever a proxied page reports where it is (load, pushState,
	 * hashchange, title change); the same information arrives as a
	 * `navigate` CustomEvent on the RemoteFrame (`event.detail`). The poll
	 * (`pollInterval`) stays as a fallback and can be disabled with 0.
	 */
	onNavigate?: (info: NavigateInfo, frame: RemoteFrame) => void;
	/** HTTP cache in the service worker, on by default; `false` turns it off (see StompController) */
	cache?: boolean;
	/** a script the rewriter cannot parse fails instead of running raw when `false` (see StompController) */
	allowInvalidJs?: boolean;
	/** request rules run in the service worker (see StompController) */
	rules?: RequestRule[];
	/** the served file names, when the host renamed them (see StompController) */
	assets?: Assets;
	/**
	 * The host's own page for a document the proxy failed to produce (see
	 * StompController): a path on the proxy origin, where the worker runs,
	 * so in this mode the page must be served from the proxy host.
	 */
	errorPage?: string;
	/** one report per proxied request, with the RemoteFrame when known (see StompController.onRequest) */
	onRequest?: (info: RemoteRequestEvent) => void;
}

/** a RequestInfo with the frame it belongs to, when the page reported its client id */
export interface RemoteRequestEvent extends RequestInfo {
	frame: RemoteFrame | null;
}

export const DEFAULT_SANDBOX =
	'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';

/**
 * Events, as on StompController: `navigate`, `open`, `request` alongside the
 * callbacks; `stale` (detail: StaleInfo) when the
 * controller frame's service worker is another build than its controller
 * and could not be replaced in time, `rebind` once the builds agree again.
 */
export class RemoteController extends EventTarget {
	proxyOrigin: string;
	directory: string;
	config?: Config;
	/** the inner controller's `stale` (see StompController); null while the builds agree */
	stale: StaleInfo | null = null;
	frames: RemoteFrame[] = [];
	isReady = false;
	/** service worker client ids the pages reported, by frame */
	#clientFrames = new Map<string, RemoteFrame>();
	readonly element: HTMLIFrameElement;
	#rpc: RpcHelper<HostBound, FrameBound>;
	#ready: Promise<void>;
	#init: RemoteControllerInit;
	#sandbox: string;

	constructor(init: RemoteControllerInit) {
		super();
		this.#init = init;
		this.proxyOrigin = new URL(init.proxyOrigin).origin;
		this.directory = init.directory ?? '/stomp/';
		this.#sandbox = init.sandbox ?? DEFAULT_SANDBOX;

		if (this.proxyOrigin === location.origin)
			throw new Error(
				'RemoteController needs a proxy origin different from the host origin; use StompController for same-origin setups',
			);

		this.element = document.createElement('iframe');
		// the frame learns its own script's name from the query (sanitised there)
		const script = init.assets?.controllerFrameScript;
		this.element.src = `${this.proxyOrigin}${this.directory}${assetName(
			init.assets,
			'controllerFrame',
		)}${script ? `?script=${encodeURIComponent(script)}` : ''}`;
		this.element.style.display = 'none';
		this.element.setAttribute('aria-hidden', 'true');
		this.element.title = 'Stomp controller';

		let frameReady!: () => void;
		const frameReadyPromise = new Promise<void>(
			(resolve) => (frameReady = resolve),
		);

		this.#rpc = new RpcHelper<HostBound, FrameBound>(
			{
				ready: async () => {
					frameReady();
				},
				request: async (info) => {
					let frame =
						(info.client && this.#clientFrames.get(info.client)) || null;
					// the document and its head's subresources are reported before the
					// page has said which frame it is in: give that a moment
					if (!frame && info.client) {
						const deadline =
							Date.now() +
							(['document', 'iframe', 'frame', 'embed', 'object'].includes(
								info.destination,
							)
								? 3000
								: 1500);
						while (!frame && Date.now() < deadline) {
							await new Promise((resolve) => setTimeout(resolve, 50));
							frame = this.#clientFrames.get(info.client) || null;
						}
					}
					const event: RemoteRequestEvent = { ...info, frame };
					init.onRequest?.(event);
					this.dispatchEvent(new CustomEvent('request', { detail: event }));
				},
				stale: async (info) => {
					const was = this.stale;
					this.stale = info;
					if (info) {
						if (this.config)
							this.config = { ...this.config, build: info.worker };
						this.dispatchEvent(new CustomEvent('stale', { detail: info }));
					} else if (was) {
						if (this.config)
							this.config = { ...this.config, build: was.controller };
						this.dispatchEvent(
							new CustomEvent('rebind', {
								detail: { build: was.controller },
							}),
						);
					}
				},
			},
			REMOTE_RPC,
			(data) => this.element.contentWindow?.postMessage(data, this.proxyOrigin),
		);

		window.addEventListener('message', (event) => {
			if (event.origin !== this.proxyOrigin) return;
			if (event.source === this.element.contentWindow) {
				this.#rpc.receive(event.data);
				return;
			}
			// a report or an open request from one of our proxied frames
			const frame = this.frames.find(
				(frame) => frame.element.contentWindow === event.source,
			);
			if (!frame) return;
			const navigate = navigateReport(event.data);
			if (navigate) {
				if (navigate.client) this.#clientFrames.set(navigate.client, frame);
				frame.report(navigate);
				init.onNavigate?.(navigate, frame);
				this.dispatchEvent(
					new CustomEvent('navigate', { detail: { info: navigate, frame } }),
				);
				return;
			}
			const url = openRequest(event.data);
			if (url !== null) {
				init.onOpen?.(url, frame);
				this.dispatchEvent(new CustomEvent('open', { detail: { url, frame } }));
			}
		});

		(document.body || document.documentElement).append(this.element);

		this.#ready = frameReadyPromise
			.then(() =>
				this.#rpc.call('init', {
					codec: init.codec,
					directory: this.directory,
					transport: init.transport,
					openTab: !!init.onOpen,
					...(init.cache === false ? { cache: false } : {}),
					requestLog: !!init.onRequest,
					...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
					...(init.rules ? { rules: init.rules } : {}),
					...(init.assets ? { assets: init.assets } : {}),
					...(init.errorPage ? { errorPage: init.errorPage } : {}),
				}),
			)
			.then(({ config, stale }) => {
				this.config = config;
				this.stale = stale ?? null;
				this.isReady = true;
			});

		const every = init.pollInterval ?? 500;
		if (every > 0)
			setInterval(() => {
				for (const frame of this.frames) frame.refresh();
			}, every);
	}
	async wait(): Promise<void> {
		await this.#ready;
	}
	async route(url: string): Promise<string> {
		await this.#ready;
		return this.#rpc.call('route', url);
	}
	/** replace the request rules (see StompController.setRules) */
	async setRules(rules: RequestRule[]): Promise<void> {
		await this.#ready;
		await this.#rpc.call('rules', rules);
	}
	/** drop every entry of the service worker's HTTP cache */
	async clearCache(): Promise<void> {
		await this.#ready;
		await this.#rpc.call('clearCache', undefined);
	}
	/** the cookie jar, for the host application only (see StompController.cookies) */
	readonly cookies: CookieJar = cookieJar(async (command) => {
		await this.#ready;
		return this.#rpc.call('cookies', command);
	});
	async setTransport(transport: TransportDescriptor): Promise<void> {
		await this.#ready;
		await this.#rpc.call('setTransport', transport);
	}
	createFrame(element: HTMLIFrameElement = document.createElement('iframe')) {
		const frame = new RemoteFrame(this, element, this.#sandbox);
		this.frames.push(frame);
		return frame;
	}
	/**
	 * index of a frame in this window's `frames` list. That list is in frame
	 * creation order, not document order, so compare window proxies (identity
	 * comparison works across origins).
	 */
	#frameIndex(element: HTMLIFrameElement): number {
		const target = element.contentWindow;
		if (!target) return -1;
		for (let i = 0; i < window.length; i++) if (window[i] === target) return i;
		return -1;
	}
	/** @internal */
	async frameInfo(element: HTMLIFrameElement): Promise<FrameInfo> {
		await this.#ready;
		const index = this.#frameIndex(element);
		if (index === -1)
			return { url: null, title: null, canGoBack: null, canGoForward: null };
		return this.#rpc.call('frameInfo', index);
	}
	/** @internal */
	async frameCommand(
		element: HTMLIFrameElement,
		command: FrameCommand,
	): Promise<boolean> {
		await this.#ready;
		const index = this.#frameIndex(element);
		if (index === -1) return false;
		return this.#rpc.call('frameCommand', { index, command });
	}
}

/**
 * A proxied frame on the proxy origin. Dispatches `navigate` (CustomEvent,
 * `detail` is a NavigateInfo) whenever the page reports a new URL, title or
 * history state; the fields below follow the reports and the poll.
 */
export class RemoteFrame extends EventTarget {
	/** last known real URL of the page, from the page's reports and the poll */
	url: string | null = null;
	/** last known document title */
	title: string | null = null;
	/** last known: whether the frame's own history has an entry before/after the current one; null when unknown */
	canGoBack: boolean | null = null;
	canGoForward: boolean | null = null;
	#refreshing: Promise<void> | null = null;
	constructor(
		public controller: RemoteController,
		public element: HTMLIFrameElement,
		sandbox: string,
	) {
		super();
		element.setAttribute('sandbox', sandbox);
		element.setAttribute('referrerpolicy', 'no-referrer');
	}
	/** hosts waiting for the next report (go, reload) */
	#awaitingReport = new Set<() => void>();
	/** resolves on the next report, REPORT_GRACE_MS after the frame's load event without one, or after NAVIGATION_WAIT_MS */
	#nextReport(): Promise<void> {
		return new Promise((resolve) => {
			let grace: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				clearTimeout(timer);
				clearTimeout(grace);
				this.#awaitingReport.delete(done);
				this.element.removeEventListener('load', onLoad);
				resolve();
			};
			// the report crosses message ports and usually lands a few
			// milliseconds after the frame's load event; a document that never
			// reports (an image, a download, a blocked response) resolves
			// REPORT_GRACE_MS after that event
			const onLoad = () => {
				if (grace === undefined) grace = setTimeout(done, REPORT_GRACE_MS);
			};
			const timer = setTimeout(done, NAVIGATION_WAIT_MS);
			this.element.addEventListener('load', onLoad);
			this.#awaitingReport.add(done);
		});
	}
	/** navigate the frame; resolves when the new document first reports (see Frame.go) */
	async go(url: string): Promise<void> {
		const reported = this.#nextReport();
		this.element.src = await this.controller.route(url);
		this.url = url;
		await reported;
	}
	/** @internal */
	report(info: NavigateInfo) {
		this.url = info.url;
		this.title = info.title;
		this.canGoBack = info.canGoBack;
		this.canGoForward = info.canGoForward;
		for (const resolve of this.#awaitingReport) resolve();
		this.#awaitingReport.clear();
		this.dispatchEvent(new CustomEvent('navigate', { detail: info }));
	}
	/**
	 * Step the frame's own history, relayed through the controller frame.
	 * Resolves false when there is no entry in that direction (the frame's
	 * history is never allowed to walk the host page).
	 */
	back(): Promise<boolean> {
		return this.controller.frameCommand(this.element, 'back');
	}
	forward(): Promise<boolean> {
		return this.controller.frameCommand(this.element, 'forward');
	}
	/** reload the frame; resolves when the reloaded document first reports (false when there was nothing to reload) */
	async reload(): Promise<boolean> {
		const reported = this.#nextReport();
		const done = await this.controller.frameCommand(this.element, 'reload');
		if (done) await reported;
		return done;
	}
	/** fetch the current url/title from the controller frame */
	refresh(): Promise<void> {
		if (!this.#refreshing)
			this.#refreshing = this.controller
				.frameInfo(this.element)
				.then((info) => {
					if (info.url) this.url = info.url;
					if (info.title !== null) this.title = info.title;
					this.canGoBack = info.canGoBack;
					this.canGoForward = info.canGoForward;
				})
				.catch(() => {})
				.finally(() => (this.#refreshing = null));
		return this.#refreshing;
	}
}
