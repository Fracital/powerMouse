import { BareCompatibleClient } from '@mercuryworkshop/proxy-transports';
import GenericCodec from '../Codecs';
import { codecType, Config, parseConfig, ParsedConfig } from '../config';
import { CLIENT_KEY } from '../rewriteJS';
import { parseRoutedURL, ROUTE_PROTOCOLS } from '../routeURL';
import StompURL from '../StompURL';
import {
	INIT_REMOTE_TRANSPORT,
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

export default class Client {
	modules: Map<ModuleCtor, Module<any>>;
	global: typeof globalThis;
	codec: GenericCodec;
	directory: string;
	/** the host handles window.open / target=_blank (config.openTab) */
	openTab: boolean;
	/** the service worker's build id, from the shell */
	build?: string;
	applied: boolean;
	isDOM: boolean;
	isWorker: boolean;
	#bare?: BareCompatibleClient;
	/** set by the Context module: maps the real `top` to the proxied world's top */
	resolveTop?: (value: unknown) => unknown;
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
	constructor(init: ParsedConfig, global: typeof globalThis) {
		this.global = global;
		this.applied = false;
		this.modules = new Map();
		this.codec = init.codec;
		this.directory = init.directory;
		this.openTab = !!init.openTab;
		this.build = init.build;
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
			codec: codecType(this.codec),
			...(this.openTab ? { openTab: true } : {}),
			...(this.build ? { build: this.build } : {}),
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
	 * Messages the service worker posts to this document (storage changes),
	 * on the container kept from before the page lost `navigator.serviceWorker`.
	 */
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
	apply() {
		for (const module of this.modules.values()) {
			if (module.apply) {
				module.apply();
			}
		}

		this.applied = true;
	}
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

		Reflect.defineProperty(globalThis, CLIENT_KEY, {
			value: client,
			configurable: false,
			enumerable: false,
		});
	};
}
