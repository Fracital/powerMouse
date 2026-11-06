// Host-side controller for origin isolation. The real StompController runs in
// a hidden controller frame on the proxy origin (dist/controllerFrame.html);
// this class embeds that frame and mirrors the StompController / Frame API
// over postMessage. Proxied content is shown in sandboxed, cross-origin
// frames the host page can neither read nor be read by.
import type { Config, ConfigCodec } from '../config';
import { RpcHelper } from '../transport/rpc';
import {
	FrameBound,
	FrameCommand,
	FrameInfo,
	HostBound,
	REMOTE_RPC,
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
}

export const DEFAULT_SANDBOX =
	'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';

export class RemoteController {
	proxyOrigin: string;
	directory: string;
	config?: Config;
	frames: RemoteFrame[] = [];
	isReady = false;
	readonly element: HTMLIFrameElement;
	private rpc: RpcHelper<HostBound, FrameBound>;
	private ready: Promise<void>;
	private init: RemoteControllerInit;
	private sandbox: string;

	constructor(init: RemoteControllerInit) {
		this.init = init;
		this.proxyOrigin = new URL(init.proxyOrigin).origin;
		this.directory = init.directory ?? '/stomp/';
		this.sandbox = init.sandbox ?? DEFAULT_SANDBOX;

		if (this.proxyOrigin === location.origin)
			throw new Error(
				'RemoteController needs a proxy origin different from the host origin; use StompController for same-origin setups',
			);

		this.element = document.createElement('iframe');
		this.element.src = `${this.proxyOrigin}${this.directory}controllerFrame.html`;
		this.element.style.display = 'none';
		this.element.setAttribute('aria-hidden', 'true');
		this.element.title = 'Stomp controller';

		let frameReady!: () => void;
		const frameReadyPromise = new Promise<void>(
			(resolve) => (frameReady = resolve),
		);

		this.rpc = new RpcHelper<HostBound, FrameBound>(
			{
				ready: async () => {
					frameReady();
				},
			},
			REMOTE_RPC,
			(data) => this.element.contentWindow?.postMessage(data, this.proxyOrigin),
		);

		window.addEventListener('message', (event) => {
			if (
				event.origin !== this.proxyOrigin ||
				event.source !== this.element.contentWindow
			)
				return;
			this.rpc.receive(event.data);
		});

		(document.body || document.documentElement).append(this.element);

		this.ready = frameReadyPromise
			.then(() =>
				this.rpc.call('init', {
					codec: init.codec,
					directory: this.directory,
					transport: init.transport,
				}),
			)
			.then(({ config }) => {
				this.config = config;
				this.isReady = true;
			});

		const every = init.pollInterval ?? 500;
		if (every > 0)
			setInterval(() => {
				for (const frame of this.frames) frame.refresh();
			}, every);
	}
	async wait(): Promise<void> {
		await this.ready;
	}
	async route(url: string): Promise<string> {
		await this.ready;
		return this.rpc.call('route', url);
	}
	async setTransport(transport: TransportDescriptor): Promise<void> {
		await this.ready;
		await this.rpc.call('setTransport', transport);
	}
	createFrame(element: HTMLIFrameElement = document.createElement('iframe')) {
		const frame = new RemoteFrame(this, element, this.sandbox);
		this.frames.push(frame);
		return frame;
	}
	/**
	 * index of a frame in this window's `frames` list. That list is in frame
	 * creation order, not document order, so compare window proxies (identity
	 * comparison works across origins).
	 */
	private frameIndex(element: HTMLIFrameElement): number {
		const target = element.contentWindow;
		if (!target) return -1;
		for (let i = 0; i < window.length; i++) if (window[i] === target) return i;
		return -1;
	}
	/** @internal */
	async frameInfo(element: HTMLIFrameElement): Promise<FrameInfo> {
		await this.ready;
		const index = this.frameIndex(element);
		if (index === -1)
			return { url: null, title: null, canGoBack: null, canGoForward: null };
		return this.rpc.call('frameInfo', index);
	}
	/** @internal */
	async frameCommand(
		element: HTMLIFrameElement,
		command: FrameCommand,
	): Promise<boolean> {
		await this.ready;
		const index = this.frameIndex(element);
		if (index === -1) return false;
		return this.rpc.call('frameCommand', { index, command });
	}
}

export class RemoteFrame {
	/** last known real URL of the page, refreshed by the controller's poll */
	url: string | null = null;
	/** last known document title */
	title: string | null = null;
	/** last known: whether the frame's own history has an entry before/after the current one; null when unknown */
	canGoBack: boolean | null = null;
	canGoForward: boolean | null = null;
	private refreshing: Promise<void> | null = null;
	constructor(
		public controller: RemoteController,
		public element: HTMLIFrameElement,
		sandbox: string,
	) {
		element.setAttribute('sandbox', sandbox);
		element.setAttribute('referrerpolicy', 'no-referrer');
	}
	async go(url: string) {
		this.element.src = await this.controller.route(url);
		this.url = url;
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
	reload(): Promise<boolean> {
		return this.controller.frameCommand(this.element, 'reload');
	}
	/** fetch the current url/title from the controller frame */
	refresh(): Promise<void> {
		if (!this.refreshing)
			this.refreshing = this.controller
				.frameInfo(this.element)
				.then((info) => {
					if (info.url) this.url = info.url;
					if (info.title !== null) this.title = info.title;
					this.canGoBack = info.canGoBack;
					this.canGoForward = info.canGoForward;
				})
				.catch(() => {})
				.finally(() => (this.refreshing = null));
		return this.refreshing;
	}
}
