import type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
import { Config, ConfigCodec } from '../config';
import { isUrlLike, urlLike } from '../StompURL';
import {
	CONTROLLER_INIT,
	CONTROLLER_RPC,
	Controllerbound,
	ControllerInitMessage,
	postToPort,
	SW_REVIVE,
	SWbound,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import serveTransport from '../transport/serveTransport';

export { default as SearchBuilder } from '../bootstrapper/SearchBuilder';
export type { ProxyTransport } from '@mercuryworkshop/proxy-transports';
export type { Config, ConfigCodec } from '../config';

export { RemoteController, RemoteFrame, DEFAULT_SANDBOX } from './remote';
export type { RemoteControllerInit } from './remote';
export type { TransportDescriptor, FrameInfo } from './messages';

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
	private port?: MessagePort;
	private rpc?: RpcHelper<Controllerbound, SWbound>;
	private stopServing?: () => void;
	private ready: Promise<void>;
	private readyResolve!: () => void;
	private lastHandshake = 0;
	constructor(init: ControllerInit) {
		if (!('serviceWorker' in navigator))
			throw new Error('Your browser does not support service workers.');

		this.serviceworker = init.serviceworker;
		this.transport = init.transport;
		this.directory = isUrlLike(init.directory)
			? new URL(init.directory, location.href)
			: defaultDirectory();

		if (this.directory.origin !== location.origin)
			throw new Error('Stomp directory must be same-origin');

		this.config = {
			codec: init.codec ?? 'xor',
			directory: this.directory.pathname,
			...(init.frameAncestors ? { frameAncestors: init.frameAncestors } : {}),
		};

		this.ready = new Promise((resolve) => (this.readyResolve = resolve));

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
				ready: async () => {
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
	/** the proxied URL a frame should navigate to in order to load `url` */
	async route(url: string): Promise<string> {
		await this.ready;
		return new URL(await this.rpc!.call('route', url), this.directory).href;
	}
	createFrame(element: HTMLIFrameElement = document.createElement('iframe')) {
		const frame = new Frame(this, element);
		this.frames.push(frame);
		return frame;
	}
}

export class Frame {
	constructor(
		public controller: StompController,
		public element: HTMLIFrameElement,
	) {}
	async go(url: string) {
		this.element.src = await this.controller.route(url);
	}
	/** proxied pages are same-origin, so the frame's history is reachable */
	back() {
		this.element.contentWindow?.history.back();
	}
	forward() {
		this.element.contentWindow?.history.forward();
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
