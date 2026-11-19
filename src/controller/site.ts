// The site pool's agent (src/controller/sites.ts): runs inside
// dist/controllerFrame.html (`?script=siteFrame.js`) on one slot's origin,
// embedded by the host's page, the hub. It registers that origin's service
// worker and runs a StompController there, whose transport, rewrite workers
// and cookie jar are the hub's.
import { SITE_FOCUS } from '../config';
import { helperNames } from '../helperNames';
import { RpcHelper } from '../transport/rpc';
import { shareGeometry } from './geometry';
import {
	answerRun,
	bindHistory,
	canTraverse,
	clientView,
	noteActivation,
	noteBrowserNavigation,
	traverse,
} from './history';
import { StompController } from './index';
import {
	BrokeredPool,
	BrokeredTransport,
	SITE_HELLO,
	SITE_INIT,
	SITE_RPC,
	type AgentBound,
	type HubBound,
	type SiteAgentHooks,
	type SiteAgentInit,
} from './sites';
import { shareSlotLibrary } from './slotLibrary';

/** the origins allowed to drive this frame: the page's meta tag, else the one that embedded it */
function allowedOrigins(): string[] {
	const meta = document.querySelector<HTMLMetaElement>(
		'meta[name="stomp-allowed-origins"]',
	);
	const listed = (meta?.content || '').split(/\s+/).filter(Boolean);
	if (listed.length) return listed;
	try {
		return [new URL(document.referrer).origin];
	} catch (error) {
		return [];
	}
}

let hostOrigin: string | null = null;
try {
	const embedder = new URL(document.referrer).origin;
	if (allowedOrigins().includes(embedder)) hostOrigin = embedder;
} catch (error) {
	// no referrer: nobody may drive this frame
}

if (window === window.parent || !hostOrigin) {
	document.body.textContent =
		'This page is a STomp site agent; it only works embedded by a host application.';
} else {
	const host = hostOrigin;
	let started = false;
	window.addEventListener('message', (event) => {
		if (
			started ||
			event.source !== window.parent ||
			event.origin !== host ||
			typeof event.data !== 'object' ||
			event.data === null ||
			!(SITE_INIT in event.data) ||
			!event.ports[0]
		)
			return;
		started = true;
		start(event.data[SITE_INIT] as SiteAgentInit, event.ports[0], host);
	});
	window.parent.postMessage({ [SITE_HELLO]: true }, host);
}

/**
 * how long the slot's worker may take to take the controller's first
 * handshake (it says hello before it builds anything) once it is
 * registered: a worker of the slot's origin that is not STomp's (a front
 * that serves another application's) never does, and the hub shows the
 * slot's sites from its own origin. A worker installed by this agent is
 * running and answers at once; one registered before may have to start.
 */
const WORKER_HELLO_MS = 3000;
const FRESH_WORKER_HELLO_MS = 1000;

function start(init: SiteAgentInit, port: MessagePort, host: string) {
	let controller: StompController | undefined;
	// the page whose frames show the sites: the hub's (this frame's parent),
	// or, when the hub is a controller frame, the host page above it
	const framesUp = init.framesUp === 2 ? 2 : 1;
	const top = typeof init.top === 'string' && init.top !== '' ? init.top : host;
	let failed = false;
	let settle!: (started: Promise<void>) => void;
	// the hub's frame with focus (AgentBound.focus), for this slot's documents
	Reflect.defineProperty(window, SITE_FOCUS, {
		value: null,
		configurable: true,
	});
	const ready = new Promise<void>((resolve) => (settle = resolve));
	// a start that failed is the hub's to hear (its `ready`), which may ask
	// only after the browser looked for a handler: never an error of the page's
	ready.catch(() => {});
	const hub = new RpcHelper<AgentBound, HubBound>(
		{
			ready: async () => {
				try {
					await ready;
					return [true, []];
				} catch (error) {
					return [false, []];
				}
			},
			arrive: async (arrival) => {
				await ready;
				await controller!.siteArrive(arrival);
			},
			tick: async () => {
				if (!failed) controller?.siteTick();
			},
			apply: async ({ method, args }) => {
				await ready;
				await controller!.siteApply(method, args);
			},
			frameInfo: async (index) => {
				const win = proxiedWindow(index, controller, framesUp);
				if (!win) return [null, []];
				const client = (
					win as unknown as Record<string, { url?: { toString(): string } }>
				)[helperNames(controller?.config).client];
				return [
					{
						url: client?.url ? client.url.toString() : null,
						title: win.document?.title ?? null,
						canGoBack: canTraverse(win, 'back'),
						canGoForward: canTraverse(win, 'forward'),
					},
					[],
				];
			},
			activated: async ({ index, token, nested }) => {
				const win = proxiedWindow(index, controller, framesUp);
				if (!win) return [false, []];
				noteActivation(win, String(token), nested === true);
				return [true, []];
			},
			focus: async (index) => {
				let focused: Window | null = null;
				try {
					focused = (index >= 0 && window.parent[index]) || null;
				} catch (error) {
					// a frame that went away
				}
				Reflect.defineProperty(window, SITE_FOCUS, {
					value: focused,
					configurable: true,
				});
			},
			geometry: async (geometry) => {
				shareGeometry(window, geometry);
			},
			goneClients: async (clients) => {
				await ready;
				return [await controller!.goneClients(clients), []];
			},
			// the isolated RemoteController's commands for a frame of the host's
			// page this origin shows (frame.ts frameCommand)
			command: async ({ index, command }) => {
				const win = proxiedWindow(index, controller, framesUp);
				if (!win) return [null, []];
				switch (command) {
					case 'canBack':
						return [canTraverse(win, 'back'), []];
					case 'canForward':
						return [canTraverse(win, 'forward'), []];
					case 'typed':
						noteBrowserNavigation(win);
						return [true, []];
					case 'reload':
						noteBrowserNavigation(win);
						win.location.reload();
						return [true, []];
					default:
						return [await traverse(win, command), []];
				}
			},
			history: async ({ index, run, op }) => {
				const win = frameWindow(index, framesUp);
				if (!win) return [null, []];
				const name = helperNames(controller?.config).client;
				return [await answerRun(win, run, op, name), []];
			},
		},
		SITE_RPC,
		(data, transfer) => port.postMessage(data, transfer),
	);
	port.addEventListener('message', (event) => hub.receive(event.data));
	port.start();
	const started = (async () => {
		const directory = new URL('./', location.href);
		// a slot that is not a secure context has no service worker
		if (!navigator.serviceWorker)
			throw new Error(`${location.origin} is not a secure context`);
		const known = await navigator.serviceWorker
			.getRegistration(directory.href)
			.catch(() => undefined);
		const helloMs = known?.active ? WORKER_HELLO_MS : FRESH_WORKER_HELLO_MS;
		const registration = await StompController.register(directory, {
			assets: init.controller.assets,
		});
		const agent: SiteAgentHooks = {
			codecKey: init.codecKey,
			slots: Number(init.slots) || 1,
			isolated: init.isolated === true,
			sites: {
				hub: top,
				token: String(init.token),
				home: host,
				origins: Array.isArray(init.origins) ? init.origins.map(String) : [],
			},
			worker: new BrokeredTransport(hub),
			pool: init.pool > 0 ? new BrokeredPool(hub, init.pool) : undefined,
			siteSlot: (site) => hub.call('siteSlot', site),
			crossSite: (args) => hub.call('crossSite', args),
			jar: () => {
				const channel = new MessageChannel();
				hub
					.call('jar', channel.port1, [channel.port1])
					.catch((error) =>
						console.error('Stomp: the hub could not serve the jar', error),
					);
				return channel.port2;
			},
			blocker: () => {
				const channel = new MessageChannel();
				hub
					.call('blocker', channel.port1, [channel.port1])
					.catch((error) =>
						console.error('Stomp: the hub could not serve the blocker', error),
					);
				return channel.port2;
			},
			request: (info) => {
				hub.call('request', info).catch(() => {});
			},
			permission: (info) => hub.call('permission', info),
			passkeyFocused: (client) => hub.call('passkeyFocused', client),
			heard: () => heard(),
		};
		let heard!: () => void;
		const helloed = new Promise<void>((resolve) => (heard = resolve));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const silent = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error('the slot worker is not STomp')),
				helloMs,
			);
		});
		controller = new StompController({
			...init.controller,
			directory: directory.pathname,
			serviceworker: registration,
			// unused: the agent's transport is the hub's
			transport: { module: 'about:blank' },
			agent,
			// the hub's host asks the user about a ceremony of a site this
			// slot shows; the slot's worker makes and signs (docs/passkeys.md)
			...(init.passkeys
				? {
						passkeyRelay: {
							config: {
								uv: init.passkeys.uv === true,
								testing: init.passkeys.testing === true,
							},
							prompt: (request, port) =>
								hub.call('passkeyPrompt', { request, port }, [port]),
						},
					}
				: {}),
		});
		try {
			await Promise.race([helloed, silent]);
		} finally {
			clearTimeout(timer);
		}
		await controller.wait();
		// before the hub hears the slot is ready, so before any document of
		// it exists: the library its frames of another slot's page share
		shareSlotLibrary(controller.libraryText, controller.config);
	})();
	started.catch((error) => {
		failed = true;
		console.error('Stomp: the site agent could not start', error);
	});
	settle(started);
}

/**
 * The hub page's frame at `index` (the hub counts its own `frames`), whatever
 * origin its document is now (answerRun reads it only when it is this one's)
 */
function frameWindow(index: number, framesUp = 1): Window | null {
	if (!Number.isInteger(index) || index < 0) return null;
	const page = framesUp === 2 ? window.parent.parent : window.parent;
	const win = page[index] as Window | undefined;
	return win && win !== window ? win : null;
}

/**
 * The page's frame at `index`, `framesUp` windows up, when it shows a
 * document of this origin that is a proxied one (it has the client), its
 * history told how to read its documents (history.ts)
 */
function proxiedWindow(
	index: number,
	controller: StompController | undefined,
	framesUp = 1,
): Window | null {
	if (!Number.isInteger(index) || index < 0) return null;
	const name = helperNames(controller?.config).client;
	try {
		const page = framesUp === 2 ? window.parent.parent : window.parent;
		const win = page[index] as Window | undefined;
		if (!win || win === window || !(name in win)) return null;
		bindHistory(win, (target) => clientView(target, name));
		return win;
	} catch (error) {
		// a document of another origin
		return null;
	}
}
