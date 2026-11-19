import {
	resolveAdblockOptions,
	withAdblockLists,
	type AdblockApplied,
	type AdblockInit,
	type AdblockList,
	type AdblockOptions,
	type SiteShields,
} from '../blocker/types';
import { assetFile } from '../config';
// Host-side controller for origin isolation. The real StompController runs in
// a hidden controller frame on the proxy origin (dist/controllerFrame.html);
// this class embeds that frame and mirrors the StompController / Frame API
// over postMessage. Proxied content is shown in sandboxed, cross-origin
// frames the host page can neither read nor be read by.
import type { Assets, Config, ConfigCodec, HostGeometry } from '../config';
import { validateNames, type HelperNames } from '../helperNames';
import { validateHooks, type HookErrorInfo, type InitHooks } from '../hooks';
import { askHost } from '../passkeys/host';
import type {
	PasskeyManager,
	PasskeyRequest,
	PasskeysInit,
} from '../passkeys/types';
import type {
	NavigateInfo,
	RequestInfo,
	RequestRule,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import type { CarrierInfo } from '../transport/wispWebTransport';
import { BUILD, CONTROLLER_FRAME_SCRIPT } from '../version';
import { drawAccountChooser } from './accountChooser';
import { ClientFrames } from './clientFrames';
import { GeometryWatch } from './geometry';
import {
	framePath,
	type ReportedEntry,
	type SiteHistoryAnswer,
	type SiteHistoryOp,
} from './history';
import { hostReload } from './hostReload';
import { controllerId, forgetControllerIds, keptControllerId } from './id';
import {
	activatedReport,
	clientReport,
	CookieJar,
	cookieJar,
	frameMovedReport,
	frameOfSource,
	historyRunReport,
	hookErrorReport,
	navigateReport,
	NAVIGATION_WAIT_MS,
	navigationTypeReport,
	openRequest,
	passkeyManager,
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
import type { SitePoolInit } from './sitePool';
import { SiteRuns } from './siteRuns';
import { debugTransportStored, printNote } from './transportConsole';

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
	/** filter lists to start the blocker with in place of the defaults (see StompController.adblockLists) */
	adblockLists?: (string | AdblockList)[];
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
	 * the transport's verbose log on this page's console (see
	 * StompController.debugTransport); without it, this origin's
	 * `localStorage['stomp:debug-transport'] = '1'` turns it on
	 */
	debugTransport?: boolean;
	/**
	 * a proxied site asks for a permission the proxy origin holds for another
	 * site (see StompController.onPermissionRequest); the frames that should
	 * reach the browser's own prompts need an `allow` attribute in this mode
	 */
	onPermissionRequest?: (
		request: RemotePermissionRequest,
	) => boolean | null | Promise<boolean | null>;
	/**
	 * The site pool (see StompController's sitePool): origins that serve the
	 * proxy as `proxyOrigin` does, other ports of its host, from which the
	 * controller frame shows each site, so the browser gives a page and a
	 * frame of another site in it a process each. Their documents are this
	 * page's frames as the proxy origin's are; a slot that does not answer
	 * leaves its sites on `proxyOrigin`.
	 */
	sitePool?: SitePoolInit | false;
	/**
	 * Passkeys for proxied sites (docs/passkeys.md), off unless given: STomp
	 * is the passkey provider (see StompController's ControllerInit.passkeys).
	 * The service worker holds the keys; `onRequest`, in this page, asks the
	 * user about every passkey made and every sign-in.
	 */
	passkeys?: RemotePasskeysInit;
	/** @internal For tests (see StompController's fedcmTesting) */
	fedcmTesting?: boolean;
}

/** a proxied site's passkey ceremony the host is asked about (RemoteControllerInit.passkeys) */
export interface RemotePasskeyRequest extends PasskeyRequest {
	/** the frame the request came from, when its page reported its client id */
	frame: RemoteFrame | null;
}
/** the passkeys option (see RemoteControllerInit.passkeys) */
export type RemotePasskeysInit = PasskeysInit<RemotePasskeyRequest>;

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

/** how long the host has to start the navigation a page's open request asked for (RemoteController.openerSlot) */
const OPENED_TTL_MS = 10000;

export const DEFAULT_SANDBOX =
	'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock allow-storage-access-by-user-activation';

/**
 * Events, as on StompController: `navigate`, `open`, `request` alongside the
 * callbacks; `carrier` (detail: CarrierInfo) as on StompController; `stale` (detail: StaleInfo) when the
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
	/** the inner controller's `carrier` (see StompController), with its `carrier` event */
	carrier: CarrierInfo | null = null;
	frames: RemoteFrame[] = [];
	/**
	 * The host's browser window as its frames' documents see it
	 * (./geometry.ts), kept by the controller frame (and its slots' agents)
	 */
	#geometry = new GeometryWatch(
		() => this.frames.map((frame) => frame.element),
		(geometry: HostGeometry) =>
			this.#ready.then(() => this.#rpc.call('geometry', geometry)),
	);
	isReady = false;
	/** the site pool's slots the controller frame shows sites from (none without one) */
	#slots: string[] = [];
	/** the site pool: the slot of the page that asked for each URL to be opened (OPEN_TAB), by the URL, for OPENED_TTL_MS */
	#opened = new Map<string, { origin: string; at: number }>();
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
	/** the blocker's default lists (adblockDefaults()), null when it is off */
	#adblockBase: AdblockInit | null = null;
	/** the lists in force (getAdblockLists()); what setAdblockLists last sent, or the defaults */
	#adblock: AdblockInit | null = null;

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
		// the frame learns its own script's name from the query (sanitised
		// there); both are asked for by the hash of their bytes
		// (`controllerFrame.html?<hash>&script=controllerFrame.js%3F<hash>`),
		// so a host may answer them `immutable`
		const frame = assetFile(init.assets, 'controllerFrame');
		const script =
			init.assets?.controllerFrameScript || CONTROLLER_FRAME_SCRIPT
				? assetFile(init.assets, 'controllerFrameScript')
				: '';
		this.element.src = `${this.proxyOrigin}${this.directory}${frame}${
			script
				? `${frame.includes('?') ? '&' : '?'}script=${encodeURIComponent(script)}`
				: ''
		}`;
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
				passkeyPrompt: async ({ request, port }) => {
					const passkeys = init.passkeys;
					// nobody here to ask: the request ends as one the user declined
					if (!passkeys) {
						port.close();
						return [null, []];
					}
					return [
						await askHost(passkeys, request, port, {
							frame: this.#clients.frame(request.client),
						}),
						[],
					];
				},
				// a site's FedCM account chooser, drawn here over its frame
				identityChooser: async ({ request, port }) => [
					await drawAccountChooser(
						this.#clients.frame(request.client)?.element ?? null,
						request,
						port,
					),
					[],
				],
				passkeyFocused: async (client) => {
					const frame = this.#clients.frame(client);
					return [
						!!frame &&
							document.hasFocus() &&
							document.activeElement === frame.element,
						[],
					];
				},
				carrier: async (info) => {
					this.carrier = info;
					this.dispatchEvent(new CustomEvent('carrier', { detail: info }));
				},
				// the transport's notes are this page's console's
				transportNote: async (note) => printNote(note),
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
			if (
				event.origin !== this.proxyOrigin &&
				!this.#slots.includes(event.origin)
			)
				return;
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
				if (moved)
					frame.historyChanged(announce, event.source as Window, moved.entry);
				const thrown = client || moved ? null : hookErrorReport(event.data);
				if (thrown) reportHookError(thrown, frame);
				return;
			}
			const navigate = navigateReport(event.data);
			if (navigate) {
				if (navigate.client) this.#clients.attribute(navigate.client, frame);
				// where the frame's history can go is the controller frame's to
				// say (nested frames included), not the page's own navigable;
				// the site pool: once the agent of the document's slot took it
				if (this.#slots.length)
					frame.siteReport(
						event.origin,
						navigate,
						navigationTypeReport(event.data),
						() => {
							frame.report(navigate);
							frame.reported(navigate, announce);
						},
						historyRunReport(event.data),
					);
				else {
					frame.report(navigate);
					frame.reported(navigate, announce);
				}
				return;
			}
			const url = openRequest(event.data);
			if (url !== null) {
				if (this.#slots.includes(event.origin)) {
					const now = Date.now();
					for (const [key, opened] of this.#opened)
						if (now - opened.at > OPENED_TTL_MS) this.#opened.delete(key);
					this.#opened.set(url, { origin: event.origin, at: now });
				}
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
					...((init.debugTransport ?? debugTransportStored())
						? { debugTransport: true }
						: {}),
					...(init.onPermissionRequest ? { permissionPrompt: true } : {}),
					...(init.fedcmTesting ? { fedcmTesting: true } : {}),
					...(init.passkeys
						? {
								passkeys: {
									uv: init.passkeys.userVerification === true,
									testing: init.passkeys.testing === true,
								},
							}
						: {}),
					...(init.allowInvalidJs === false ? { allowInvalidJs: false } : {}),
					...(init.membrane === false ? { membrane: false } : {}),
					...(init.serviceWorkers === false ? { serviceWorkers: false } : {}),
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
					...(init.assets ? { assets: init.assets } : {}),
					...(init.adblock !== undefined ? { adblock: init.adblock } : {}),
					...(init.adblockLists ? { adblockLists: init.adblockLists } : {}),
					...(init.names ? { names: init.names } : {}),
					...(init.hooks ? { hooks: init.hooks } : {}),
					...(init.errorPage ? { errorPage: init.errorPage } : {}),
					...(init.sitePool ? { sitePool: init.sitePool } : {}),
				}),
			)
			.then(
				({ config, stale, carrier, sites }) => {
					this.#slots = Array.isArray(sites) ? sites : [];
					this.config = config;
					this.stale = stale ?? null;
					if (carrier && !this.carrier) this.carrier = carrier;
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

		// the blocker's lists, mirrored host-side so adblockDefaults() and
		// getAdblockLists() read without a round trip to the frame; the inner
		// controller is the one that actually rebuilds the engine
		this.#adblockBase =
			init.adblock === false ? null : resolveAdblockOptions(init.adblock);
		this.#adblock =
			this.#adblockBase && init.adblockLists
				? withAdblockLists(this.#adblockBase, init.adblockLists)
				: this.#adblockBase;

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
	/** @internal the site pool's slots */
	get siteOrigins(): string[] {
		return [...this.#slots];
	}
	/** whether the controller frame shows the sites from a pool of origins (see StompController.siteMode) */
	get siteMode(): boolean {
		return this.#slots.length > 0;
	}
	/** @internal the site pool: the slot `url`'s site is shown from, once it is up; null for the proxy origin */
	async siteOrigin(url: string): Promise<string | null> {
		await this.#ready;
		if (!this.#slots.length) return null;
		return this.#rpc.call('siteOrigin', url);
	}
	/**
	 * @internal the site pool: the slot of the page that just asked the host
	 * to open `url` (`onOpen`), taken once; null for any other navigation
	 */
	openerSlot(url: string): string | null {
		const opened = this.#opened.get(url);
		if (!opened) return null;
		this.#opened.delete(url);
		return Date.now() - opened.at > OPENED_TTL_MS ? null : opened.origin;
	}
	/** @internal see StompController.reportViewport */
	reportViewport(width: number, height: number) {
		if (!(width > 0 && height > 0)) return;
		this.#ready
			.then(() => this.#rpc.call('viewport', [width, height]))
			.catch(() => {});
	}
	/** @internal the site pool: see StompController.siteViewport */
	async siteViewport(origin: string, width: number, height: number) {
		if (!(width > 0 && height > 0)) return;
		await this.#ready;
		await this.#rpc.call('viewport', [width, height, origin]);
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
	/** the blocker's default filter lists (see StompController.adblockDefaults) */
	adblockDefaults(): AdblockList[] {
		return this.#adblockBase
			? this.#adblockBase.lists.map((l) => ({ ...l }))
			: [];
	}
	/** the filter lists the blocker is serving now (see StompController.getAdblockLists) */
	getAdblockLists(): AdblockList[] {
		return this.#adblock ? this.#adblock.lists.map((l) => ({ ...l })) : [];
	}
	/** replace the blocker's filter lists at runtime (see StompController.setAdblockLists) */
	async setAdblockLists(
		lists: (string | AdblockList)[],
	): Promise<AdblockApplied> {
		if (!this.#adblock) return { applied: 'off' };
		this.#adblock = withAdblockLists(this.#adblock, lists);
		await this.#ready;
		return this.#rpc.call('adblock', { lists });
	}
	/** re-fetch and recompile the blocker's current lists (see StompController.refreshAdblockLists) */
	async refreshAdblockLists(): Promise<AdblockApplied> {
		if (!this.#adblock) return { applied: 'off' };
		await this.#ready;
		return this.#rpc.call('adblockRefresh', undefined);
	}
	/** drop every entry of the service worker's HTTP cache */
	async clearCache(): Promise<void> {
		await this.#ready;
		await this.#rpc.call('clearCache', undefined);
	}
	/** the passkeys the service worker holds for proxied sites (see StompController.passkeys) */
	readonly passkeys: PasskeyManager = passkeyManager(async (command) => {
		await this.#ready;
		return this.#rpc.call('passkeys', command);
	});
	/** the cookie jar, for the host application only (see StompController.cookies) */
	readonly cookies: CookieJar = cookieJar(async (command) => {
		await this.#ready;
		const result = await this.#rpc.call('cookies', command);
		// as on StompController: the kept ids go with every site's cookies
		if (command.op === 'clear' && command.origin === undefined)
			await forgetControllerIds();
		return result;
	});
	/** clear a site's virtualized storage (see StompController.forgetStorage) */
	async forgetStorage(origin: string): Promise<void> {
		await this.#ready;
		await this.#rpc.call('forgetStorage', origin);
	}
	async setTransport(transport: TransportDescriptor): Promise<void> {
		await this.#ready;
		await this.#rpc.call('setTransport', transport);
	}
	createFrame(element: HTMLIFrameElement = document.createElement('iframe')) {
		const frame = new RemoteFrame(this, element, this.#sandbox);
		this.frames.push(frame);
		this.#geometry.observe(element);
		return frame;
	}
	/** @internal measure the frames' geometry now (a frame about to navigate); settles once the controller frame kept it */
	measureGeometry(): Promise<void> {
		return this.#geometry.update();
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
		const origin = this.#slotOf(element);
		return this.#rpc.call('frameInfo', origin ? { index, origin } : index);
	}
	/** @internal */
	async frameActivated(
		element: HTMLIFrameElement,
		token: string,
		nested: boolean,
	) {
		await this.#ready;
		const index = this.#frameIndex(element);
		const origin = this.#slotOf(element);
		if (index !== -1)
			await this.#rpc.call('frameActivated', {
				index,
				token,
				nested,
				...(origin ? { origin } : {}),
			});
	}
	/** @internal */
	async frameCommand(
		element: HTMLIFrameElement,
		command: FrameCommand,
		routed?: string,
	): Promise<boolean> {
		await this.#ready;
		const index = this.#frameIndex(element);
		if (index === -1) return false;
		const origin = this.#slotOf(element);
		return this.#rpc.call('frameCommand', {
			index,
			command,
			...(origin ? { origin } : {}),
			...(routed ? { routed } : {}),
		});
	}
	/** @internal the site pool: an op on run `run` of `element`'s frame's history, for the agent of `origin` (FrameBound.frameHistory) */
	async frameHistory(
		element: HTMLIFrameElement,
		origin: string,
		run: number,
		op: SiteHistoryOp,
	): Promise<SiteHistoryAnswer | null> {
		await this.#ready;
		const index = this.#frameIndex(element);
		if (index === -1) return null;
		return this.#rpc.call('frameHistory', { index, origin, run, op });
	}
	/** the site pool: the slot the document of `element`'s frame last reported from, when it is one */
	#slotOf(element: HTMLIFrameElement): string | undefined {
		const origin = this.frames.find(
			(frame) => frame.element === element,
		)?.siteOrigin;
		return origin && this.#slots.includes(origin) ? origin : undefined;
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
	/**
	 * The site pool: the frame's history as runs, each a stretch of it shown
	 * from one slot, as Frame keeps it (src/controller/siteRuns.ts)
	 */
	#runs: SiteRuns;
	/** the controller's announcement of the last report (the buttons changed with no report) */
	#announce: ((info: NavigateInfo) => void) | null = null;
	/** @internal the site pool: the origin the frame's document last reported from */
	get siteOrigin(): string | undefined {
		return this.#runs.origin;
	}
	/**
	 * @internal the site pool: a top document of the frame reported, from
	 * `origin`, navigated to as `type` says (NAVIGATION_TYPE), where its
	 * slot's stretch of the history has it (`entries`, HISTORY_RUN);
	 * `deliver` reports it once the agent of that origin took it
	 */
	siteReport(
		origin: string,
		info: NavigateInfo,
		type: string | null,
		deliver: () => void,
		entries: [number, number] | null = null,
	) {
		this.#runs.report(origin, info, type, deliver, entries);
	}
	constructor(
		public controller: RemoteController,
		public element: HTMLIFrameElement,
		sandbox: string,
	) {
		super();
		this.#runs = new SiteRuns({
			ask: (origin, run, op) =>
				controller.frameHistory(element, origin, run, op),
			home: controller.proxyOrigin,
			others: () =>
				controller.frames
					.filter((frame) => frame !== this)
					.map((frame) => frame.#runs),
			changed: () => this.#siteChanged(),
			window: () => element.contentWindow,
			address: async (url, origin) => {
				const routed = new URL(await controller.route(url));
				const to = (await controller.siteOrigin(url)) ?? origin;
				return `${to}${routed.pathname}${routed.search}${routed.hash}`;
			},
			nextReport: () => this.#nextReport(),
		});
		element.setAttribute('sandbox', sandbox);
		element.setAttribute('referrerpolicy', 'no-referrer');
		// in a cross-origin isolated host page the frame may be isolated too
		// (a page whose own headers isolate it is; the service worker serves
		// every other one without the permission): added to what the host
		// allows the frame already
		if (globalThis.crossOriginIsolated === true) {
			const allow = element.getAttribute('allow')?.trim() ?? '';
			if (!/(^|;)\s*cross-origin-isolated(\s|;|$)/.test(allow)) {
				this.#allowBase = allow;
				this.#allowIsolation([controller.proxyOrigin]);
			}
		}
	}
	/** what the host's `allow` was before the isolation permission was added to it, null when none was added */
	#allowBase: string | null = null;
	/** the cross-origin isolation permission for the frame's documents of `origins` */
	#allowIsolation(origins: string[]) {
		const allow = this.#allowBase;
		if (allow === null) return;
		this.element.setAttribute(
			'allow',
			`${allow}${allow && !allow.endsWith(';') ? '; ' : allow ? ' ' : ''}cross-origin-isolated ${origins.join(' ')}`,
		);
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
		let routed = await this.controller.route(url);
		// the site pool: the route on the origin of the URL's site, whose
		// worker is up by now (and the isolation permission for every slot)
		const origin = await this.controller.siteOrigin(url).catch(() => null);
		if (this.controller.siteMode)
			this.#allowIsolation([
				this.controller.proxyOrigin,
				...this.controller.siteOrigins,
			]);
		if (origin) {
			// a page's link or window.open the host opens here leaves from the
			// page's own slot, whose worker heard from the page who started it
			// (NAVIGATION_HINT) and hands that on to the slot of the URL's
			// site, as for a link of the page's; from the URL's slot it would
			// pass for the user's own (Sec-Fetch-Site none)
			const from = this.controller.openerSlot(url) ?? origin;
			const path = new URL(routed);
			routed = `${from}${path.pathname}${path.search}${path.hash}`;
			// the slot's worker makes the navigation (and a Critical-CH
			// retry of it): its viewport hints name this frame's size
			await this.controller
				.siteViewport(
					origin,
					this.element.clientWidth,
					this.element.clientHeight,
				)
				.catch(() => {});
		}
		// the next document is the host's, not the page's (history intervention),
		// and the worker waits for no document's word of who started it
		if (this.controller.siteMode)
			await this.#runs.typed(origin ?? this.controller.proxyOrigin);
		else
			await this.controller
				.frameCommand(this.element, 'typed', routed)
				.catch(() => {});
		// where the frame is, for its first document's first script
		await this.controller.measureGeometry();
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
		if (this.controller.siteMode) {
			this.#runs.activated(token, nested);
			return;
		}
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
		settles = true,
	): Promise<void> {
		if (this.controller.siteMode) {
			this.#announce = announce;
			info.canGoBack = this.#runs.can('back');
			info.canGoForward = this.#runs.can('forward');
		} else {
			await this.#syncHistory();
			if (this.canGoBack !== null) info.canGoBack = this.canGoBack;
			if (this.canGoForward !== null) info.canGoForward = this.canGoForward;
		}
		this.canGoBack = info.canGoBack;
		this.canGoForward = info.canGoForward;
		this.#last = info;
		this.dispatchEvent(new CustomEvent('navigate', { detail: info }));
		announce(info);
		// go() and reload() resolve once the report is out, as on Frame (a
		// report out again for the buttons is the same document's)
		if (!settles) return;
		for (const resolve of this.#awaitingReport) resolve();
		this.#awaitingReport.clear();
	}
	/**
	 * @internal A document in a frame of the page reported: the last report
	 * goes out again when the frame's history state changed
	 */
	async historyChanged(
		announce: (info: NavigateInfo) => void,
		source?: Window,
		entry?: ReportedEntry | null,
	): Promise<void> {
		if (this.controller.siteMode) {
			// the site pool: the agent of the frame's slot hears of it
			const top = this.element.contentWindow;
			const path = top && source && framePath(top, source);
			if (path) this.#runs.nested(path, entry ?? null);
			return;
		}
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
		if (this.controller.siteMode) return this.#runs.step('back');
		return this.controller.frameCommand(this.element, 'back');
	}
	forward(): Promise<boolean> {
		if (this.controller.siteMode) return this.#runs.step('forward');
		return this.controller.frameCommand(this.element, 'forward');
	}
	/** the site pool: the buttons may have changed with no report: the last report goes out again when they did */
	#siteChanged() {
		const last = this.#last;
		const announce = this.#announce;
		if (
			!last ||
			!announce ||
			(this.#runs.can('back') === last.canGoBack &&
				this.#runs.can('forward') === last.canGoForward)
		)
			return;
		void this.reported({ ...last }, announce, false);
	}
	/** reload the frame; resolves when the reloaded document first reports (false when there was nothing to reload) */
	async reload(): Promise<boolean> {
		const reported = this.#nextReport();
		const done =
			(this.controller.siteMode ? await this.#runs.reload() : null) ??
			(await this.controller.frameCommand(this.element, 'reload'));
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
					if (this.controller.siteMode) {
						info.canGoBack = this.#runs.can('back');
						info.canGoForward = this.#runs.can('forward');
					}
					this.canGoBack = info.canGoBack;
					this.canGoForward = info.canGoForward;
				})
				.catch(() => {})
				.finally(() => (this.#refreshing = null));
		return this.#refreshing;
	}
}
