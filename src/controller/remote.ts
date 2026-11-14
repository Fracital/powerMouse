import type { AdblockOptions, SiteShields } from '../blocker/types';
import { assetName } from '../config';
// Host-side controller for origin isolation. The real StompController runs in
// a hidden controller frame on the proxy origin (dist/controllerFrame.html);
// this class embeds that frame and mirrors the StompController / Frame API
// over postMessage. Proxied content is shown in sandboxed, cross-origin
// frames the host page can neither read nor be read by.
import type { Assets, Config, ConfigCodec } from '../config';
import { validateNames, type HelperNames } from '../helperNames';
import { validateHooks, type HookErrorInfo, type InitHooks } from '../hooks';
import type {
	NavigateInfo,
	RequestInfo,
	RequestRule,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import { BUILD } from '../version';
import { ClientFrames } from './clientFrames';
import { hostReload } from './hostReload';
import { controllerId, forgetControllerIds, keptControllerId } from './id';
import {
	activatedReport,
	clientReport,
	CookieJar,
	cookieJar,
	frameMovedReport,
	frameOfSource,
	hookErrorReport,
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
	STORAGE_BLOCKED,
	TransportDescriptor,
} from './messages';
import { createShields, type Shields } from './shields';

export interface RemoteControllerInit {
	/** origin that serves dist/ and the proxied content, e.g. https://proxy.example.com */
	proxyOrigin: string;
	/** pathname of dist/ on that origin, default `/stomp/` */
	directory?: string;
	/**
	 * the controller's id (see ControllerInit.id): minted here when omitted and
	 * handed to the controller frame, so the host knows the address its frames
	 * load from and can store it per tab
	 */
	id?: string;
	/**
	 * the transport, described: the controller frame instantiates it on the
	 * proxy origin, in its transport worker unless `host: 'page'`
	 */
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
	/** the window membrane, on unless `false` (see StompController) */
	membrane?: boolean;
	/** emulated service workers, on unless `false` (see StompController) */
	serviceWorkers?: boolean;
	/** the rewriter backend, `'js'` by default (see StompController) */
	rewriter?: 'wasm' | 'js';
	/** @internal see StompController */
	serviceWorkerTimeout?: number;
	/** @internal see StompController */
	serviceWorkerEventDelay?: number;
	/** Workers that rewrite scripts for the service worker; `0` starts none (see StompController) */
	rewriteWorkers?: number;
	/** ms the service worker waits on a rewrite worker before rewriting itself (see StompController) */
	rewriteTimeout?: number;
	/** request rules run in the service worker (see StompController) */
	rules?: RequestRule[];
	/** proxy-ception: forward the proxy's own origin, off unless `true` (see StompController) */
	allowSelfProxy?: boolean;
	/** per-site shields the controller starts with (see StompController.shields) */
	shields?: SiteShields[];
	/** called after `controller.shields.set(...)` to persist the change (see StompController) */
	onShieldsChange?: (host: string, state: SiteShields) => void;
	/** the served file names, when the host renamed them (see StompController) */
	assets?: Assets;
	/** the deployment's helper names (see StompController.names) */
	names?: Partial<HelperNames>;
	/** host code for every proxied realm (see StompController.hooks); a `{ url }` must be readable from the proxy origin, where the controller frame fetches it */
	hooks?: InitHooks;
	/** the built-in blocker (see StompController.adblock) */
	adblock?: boolean | AdblockOptions;
	/** a host hook threw in a proxied realm, or a hook URL failed (see StompController) */
	onHookError?: (info: HookErrorInfo) => void;
	/**
	 * The host's own page for a document the proxy failed to produce (see
	 * StompController): a path on the proxy origin, where the worker runs,
	 * so in this mode the page must be served from the proxy host.
	 */
	errorPage?: string;
	/** one report per proxied request, with the RemoteFrame when known (see StompController.onRequest) */
	onRequest?: (info: RemoteRequestEvent) => void;
	/**
	 * a proxied site asks for a permission the proxy origin holds for another
	 * site (see StompController.onPermissionRequest); the frames that should
	 * reach the browser's own prompts need an `allow` attribute in this mode
	 */
	onPermissionRequest?: (
		request: RemotePermissionRequest,
	) => boolean | null | Promise<boolean | null>;
}

/** a site's permission request (see StompController's PermissionRequest) */
export interface RemotePermissionRequest {
	origin: string;
	permission: string;
	frame: RemoteFrame | null;
}

/** a RequestInfo with the frame it belongs to (see StompController's RequestEvent) */
export interface RemoteRequestEvent extends RequestInfo {
	frame: RemoteFrame | null;
}

export const DEFAULT_SANDBOX =
	'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock allow-storage-access-by-user-activation';

/**
 * Events, as on StompController: `navigate`, `open`, `request` alongside the
 * callbacks; `stale` (detail: StaleInfo) when the
 * controller frame's service worker is another build than its controller
 * and could not be replaced in time, `rebind` once the builds agree again.
 */
export class RemoteController extends EventTarget {
	proxyOrigin: string;
	/** the scope on the proxy origin; the controller's address is `config.directory` */
	directory: string;
	/**
	 * the controller's id (ControllerInit.id): the host's own at once, else
	 * the one kept here, on the host's origin, which the controller frame is
	 * given (empty until then, before `wait()` resolves)
	 */
	id: string;
	/** the build this host-side bundle came from (see StompController.build); the controller frame's is `config.build` once it answered */
	readonly build: string = BUILD;
	config?: Config;
	/** the inner controller's `stale` (see StompController); null while the builds agree */
	stale: StaleInfo | null = null;
	frames: RemoteFrame[] = [];
	isReady = false;
	/** the service worker clients the pages reported, by frame, and those nobody spoke for */
	#clients = new ClientFrames<RemoteFrame>(
		() => this.frames,
		async (clients) => {
			await this.#ready;
			return this.#rpc.call('goneClients', clients);
		},
	);
	/** @internal see StompController */
	get clientCounts(): { clients: number; silent: number } {
		return this.#clients.sizes;
	}
	readonly element: HTMLIFrameElement;
	#rpc: RpcHelper<HostBound, FrameBound>;
	#ready: Promise<void>;
	#init: RemoteControllerInit;
	#sandbox: string;
	/** per-site shields, forwarded to the controller frame (see StompController.shields) */
	#shields!: Shields;

	constructor(init: RemoteControllerInit) {
		super();
		validateNames(init.names, Object.getOwnPropertyNames(globalThis));
		validateHooks(init.hooks);
		this.#init = init;
		this.proxyOrigin = new URL(init.proxyOrigin).origin;
		this.directory = init.directory ?? '/stomp/';
		// kept on the host's origin, where no proxied page reads it, and
		// handed to the controller frame as its id: that one never keeps any
		this.id = init.id ? controllerId(init.id) : '';
		const idReady: Promise<void> = this.id
			? Promise.resolve()
			: keptControllerId().then((id) => {
					this.id = id;
				});
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
		// a host page that is cross-origin isolated lets the proxy's frames be
		// (the permission does not reach another origin's frame by itself):
		// the controller's frame reads there that the host is, and tells the
		// service worker
		if (globalThis.crossOriginIsolated === true)
			this.element.allow = `cross-origin-isolated ${this.proxyOrigin}`;
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
				hookError: async (info) => {
					init.onHookError?.(info);
					this.dispatchEvent(
						new CustomEvent('hookerror', { detail: { info } }),
					);
				},
				request: async (info) => {
					// a worker's request is its creator's frame's (info.owner)
					const known = () => this.#clients.frame(info.client, info.owner);
					let frame = known();
					// the document and its head's subresources are reported before the
					// page has said which frame it is in: give that a moment, once
					// for a client that never says (see StompController)
					if (!frame && info.client && !this.#clients.silent(info.client)) {
						const deadline =
							Date.now() +
							(['document', 'iframe', 'frame', 'embed', 'object'].includes(
								info.destination,
							)
								? 3000
								: 1500);
						while (!frame && Date.now() < deadline) {
							await new Promise((resolve) => setTimeout(resolve, 50));
							frame = known();
						}
						if (!frame) this.#clients.silence(info.client);
					}
					if (frame && info.client && info.owner)
						this.#clients.attribute(info.client, frame);
					const event: RemoteRequestEvent = { ...info, frame };
					init.onRequest?.(event);
					this.dispatchEvent(new CustomEvent('request', { detail: event }));
				},
				permission: async (info) => {
					const ask = init.onPermissionRequest;
					if (!ask) return [null, []];
					try {
						const answer = await ask({
							origin: info.origin,
							permission: info.permission,
							frame: this.#clients.frame(info.client),
						});
						return [typeof answer === 'boolean' ? answer : null, []];
					} catch (error) {
						return [null, []];
					}
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

		// a hook that threw in a realm of `frame`'s page
		const reportHookError = (info: HookErrorInfo, frame: RemoteFrame) => {
			init.onHookError?.(info);
			this.dispatchEvent(
				new CustomEvent('hookerror', { detail: { info, frame } }),
			);
		};
		window.addEventListener('message', (event) => {
			if (event.origin !== this.proxyOrigin) return;
			if (event.source === this.element.contentWindow) {
				this.#rpc.receive(event.data);
				return;
			}
			// a report or an open request from one of our proxied frames
			const found = frameOfSource(this.frames, event.source);
			if (!found) return;
			const { frame, nested } = found;
			// a document of the frame got a user activation: the controller
			// frame reads it now
			const activated = activatedReport(event.data);
			if (activated !== null) {
				frame.historyTouched(activated, nested);
				return;
			}
			// a document in a frame of the page says which client it is (its
			// requests are this frame's), when its history moved and that a
			// hook threw in it, nothing else (see StompController)
			const announce = (info: NavigateInfo) => {
				init.onNavigate?.(info, frame);
				this.dispatchEvent(
					new CustomEvent('navigate', { detail: { info, frame } }),
				);
			};
			if (nested) {
				const client = clientReport(event.data);
				const moved = frameMovedReport(event.data);
				const id = client ?? moved?.client;
				if (id) this.#clients.attribute(id, frame);
				// a frame in the page that navigated is a step of the frame's
				// history (a tab's Back steps it first): the buttons follow
				if (moved) frame.historyChanged(announce);
				const thrown = client || moved ? null : hookErrorReport(event.data);
				if (thrown) reportHookError(thrown, frame);
				return;
			}
			const navigate = navigateReport(event.data);
			if (navigate) {
				if (navigate.client) this.#clients.attribute(navigate.client, frame);
				frame.report(navigate);
				// where the frame's history can go is the controller frame's to
				// say (nested frames included), not the page's own navigable
				frame.reported(navigate, announce);
				return;
			}
			const url = openRequest(event.data);
			if (url !== null) {
				init.onOpen?.(url, frame);
				this.dispatchEvent(new CustomEvent('open', { detail: { url, frame } }));
				return;
			}
			// a hook that threw: the page posts to the real top, which is this
			// host page (the controller frame only relays URL fetch failures)
			const hookError = hookErrorReport(event.data);
			if (hookError) reportHookError(hookError, frame);
		});

		(document.body || document.documentElement).append(this.element);

		// how this page was loaded, for the page it shows again (hostReload.ts)
		const reloaded = hostReload();
		this.#ready = Promise.all([reloaded, frameReadyPromise, idReady])
			.then(([mode]) =>
				this.#rpc.call('init', {
					...(mode ? { hostReload: mode } : {}),
					codec: init.codec,
					directory: this.directory,
					id: this.id,
					transport: init.transport,
					openTab: !!init.onOpen,
					...(init.cache === false ? { cache: false } : {}),
					requestLog: !!init.onRequest,
					...(init.onPermissionRequest ? { permissionPrompt: true } : {}),
					...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
					...(init.membrane === false ? { membrane: false } : {}),
					...(init.serviceWorkers === false ? { serviceWorkers: false } : {}),
					...(init.rewriter === 'wasm' ? { rewriter: 'wasm' } : {}),
					...(init.serviceWorkerTimeout !== undefined
						? { serviceWorkerTimeout: init.serviceWorkerTimeout }
						: {}),
					...(init.serviceWorkerEventDelay !== undefined
						? { serviceWorkerEventDelay: init.serviceWorkerEventDelay }
						: {}),
					...(init.rewriteWorkers !== undefined
						? { rewriteWorkers: init.rewriteWorkers }
						: {}),
					...(init.rewriteTimeout !== undefined
						? { rewriteTimeout: init.rewriteTimeout }
						: {}),
					...(init.rules ? { rules: init.rules } : {}),
					...(init.allowSelfProxy ? { allowSelfProxy: true } : {}),
					...(init.assets ? { assets: init.assets } : {}),
					...(init.adblock !== undefined ? { adblock: init.adblock } : {}),
					...(init.names ? { names: init.names } : {}),
					...(init.hooks ? { hooks: init.hooks } : {}),
					...(init.errorPage ? { errorPage: init.errorPage } : {}),
				}),
			)
			.then(
				({ config, stale }) => {
					this.config = config;
					this.stale = stale ?? null;
					this.isReady = true;
				},
				(error: Error) => {
					// the frame's storage is blocked: an error a host can tell apart
					if (error.message.startsWith(`${STORAGE_BLOCKED}: `)) {
						error.name = STORAGE_BLOCKED;
						error.message = error.message.slice(STORAGE_BLOCKED.length + 2);
					}
					throw error;
				},
			);

		// per-site shields: the host-side state the demo reads and writes, each
		// change forwarded to the controller frame (which applies it to the inner
		// StompController, so it reaches the worker and its handshakes)
		this.#shields = createShields((list) => {
			void this.#ready
				.then(() => this.#rpc.call('shields', list))
				.catch(() => {});
		}, init.onShieldsChange);
		if (init.shields?.length) this.#shields.replace(init.shields);

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
	/** @internal see StompController.reportViewport */
	reportViewport(width: number, height: number) {
		if (!(width > 0 && height > 0)) return;
		this.#ready
			.then(() => this.#rpc.call('viewport', [width, height]))
			.catch(() => {});
	}
	/** the real URL a routed one stands for, null for a non-route (see StompController.unroute) */
	async unroute(url: string): Promise<string | null> {
		await this.#ready;
		return this.#rpc.call('unroute', url);
	}
	/** replace the request rules (see StompController.setRules) */
	async setRules(rules: RequestRule[]): Promise<void> {
		await this.#ready;
		await this.#rpc.call('rules', rules);
	}
	/** per-site shields (see StompController.shields) */
	get shields(): Shields {
		return this.#shields;
	}
	/** drop every entry of the service worker's HTTP cache */
	async clearCache(): Promise<void> {
		await this.#ready;
		await this.#rpc.call('clearCache', undefined);
	}
	/** the cookie jar, for the host application only (see StompController.cookies) */
	readonly cookies: CookieJar = cookieJar(async (command) => {
		await this.#ready;
		const result = await this.#rpc.call('cookies', command);
		// as on StompController: the kept ids go with every site's cookies
		if (command.op === 'clear' && command.origin === undefined)
			await forgetControllerIds();
		return result;
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
	async frameActivated(
		element: HTMLIFrameElement,
		token: string,
		nested: boolean,
	) {
		await this.#ready;
		const index = this.#frameIndex(element);
		if (index !== -1)
			await this.#rpc.call('frameActivated', { index, token, nested });
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
	/** last known: whether the frame's history (nested frames included) has an entry before/after the current one; null when unknown */
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
		// in a cross-origin isolated host page the frame may be isolated too
		// (a page whose own headers isolate it is; the service worker serves
		// every other one without the permission): added to what the host
		// allows the frame already
		if (globalThis.crossOriginIsolated === true) {
			const allow = element.getAttribute('allow')?.trim() ?? '';
			if (!/(^|;)\s*cross-origin-isolated(\s|;|$)/.test(allow))
				element.setAttribute(
					'allow',
					`${allow}${allow && !allow.endsWith(';') ? '; ' : allow ? ' ' : ''}cross-origin-isolated ${controller.proxyOrigin}`,
				);
		}
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
		this.controller.reportViewport(
			this.element.clientWidth,
			this.element.clientHeight,
		);
		const routed = await this.controller.route(url);
		// the next document is the host's, not the page's (history intervention)
		await this.controller.frameCommand(this.element, 'typed').catch(() => {});
		this.element.src = routed;
		this.#keepFocusAcrossCommit();
		this.url = url;
		await reported;
	}
	/**
	 * A focused frame still showing a document of the host's origin (its
	 * initial about:blank) loses focus when the proxy origin's document
	 * commits in another process, and the page would read
	 * document.hasFocus() false and miss the keys typed next, where a tab's
	 * page has focus. The commit shows here as the frame's document turning
	 * cross-origin: focus is given back at once, before the page runs. A
	 * frame already on the proxy origin keeps focus by itself (measured)
	 */
	#keepFocusAcrossCommit() {
		const element = this.element;
		if (document.activeElement !== element) return;
		const sameOrigin = () => {
			try {
				return element.contentDocument !== null;
			} catch (error) {
				return false;
			}
		};
		if (!sameOrigin()) return;
		const until = Date.now() + NAVIGATION_WAIT_MS;
		const check = () => {
			if (document.activeElement !== element) return;
			if (sameOrigin()) {
				if (Date.now() < until) setTimeout(check, 4);
				return;
			}
			element.blur();
			element.focus({ preventScroll: true });
		};
		setTimeout(check, 4);
	}
	/** @internal */
	report(info: NavigateInfo) {
		this.url = info.url;
		this.title = info.title;
	}
	/** the last report, with the frame's history state */
	#last: NavigateInfo | null = null;
	/** history state requests, answered in order */
	#history: Promise<void> = Promise.resolve();
	/** the frame's history state from the controller frame */
	#syncHistory(): Promise<void> {
		const run = () =>
			this.controller
				.frameInfo(this.element)
				.then((info) => {
					if (info.canGoBack !== null) this.canGoBack = info.canGoBack;
					if (info.canGoForward !== null) this.canGoForward = info.canGoForward;
				})
				.catch(() => {});
		this.#history = this.#history.then(run, run);
		return this.#history;
	}
	/** @internal a document of the frame got a user activation */
	historyTouched(token: string, nested: boolean) {
		// in line with the history state requests, so it is in before the
		// report of the document the click navigated to
		const run = () =>
			this.controller
				.frameActivated(this.element, token, nested)
				.catch(() => {});
		this.#history = this.#history.then(run, run);
	}
	/**
	 * @internal A report, out with the frame's history state once that is
	 * known: the frame's event, then the controller's (`announce`)
	 */
	async reported(
		info: NavigateInfo,
		announce: (info: NavigateInfo) => void,
	): Promise<void> {
		await this.#syncHistory();
		if (this.canGoBack !== null) info.canGoBack = this.canGoBack;
		if (this.canGoForward !== null) info.canGoForward = this.canGoForward;
		this.canGoBack = info.canGoBack;
		this.canGoForward = info.canGoForward;
		this.#last = info;
		this.dispatchEvent(new CustomEvent('navigate', { detail: info }));
		announce(info);
		// go() and reload() resolve once the report is out, as on Frame
		for (const resolve of this.#awaitingReport) resolve();
		this.#awaitingReport.clear();
	}
	/**
	 * @internal A document in a frame of the page reported: the last report
	 * goes out again when the frame's history state changed
	 */
	async historyChanged(announce: (info: NavigateInfo) => void): Promise<void> {
		await this.#syncHistory();
		const last = this.#last;
		if (
			!last ||
			(this.canGoBack === last.canGoBack &&
				this.canGoForward === last.canGoForward)
		)
			return;
		await this.reported({ ...last }, announce);
	}
	/**
	 * Step the frame's history as a tab's Back and Forward do (see
	 * Frame.back), relayed through the controller frame. Resolves false when
	 * there is no entry in that direction.
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
