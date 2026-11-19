// The site pool (ControllerInit.sitePool, src/controller/sitePool.ts): every
// proxied site is shown from one of a few origins, the slots, so the browser
// gives a page and a frame of another site in it a process each. The host's
// controller is the hub: for each slot in use it embeds an agent, the
// controller frame on that slot's origin running src/controller/site.ts,
// which runs a StompController there (the origin's service worker, its
// handshakes and revives, its sites' emulated service workers) with no
// frames, no transport and no cookie jar of its own: every port it would
// serve the transport on is served by the hub's, and its worker's jar is
// the hub's origin's (src/server/jarDB.ts).
import type { HostGeometry, SitesConfig } from '../config';
import type {
	PasskeyAnswer,
	PasskeyPrompt,
	PasskeysConfig,
} from '../passkeys/types';
import type {
	IdentityChooserRequest,
	PermissionRequestInfo,
	RequestInfo,
	SiteArrival,
	TransportModule,
	WorkerToController,
} from '../transport/messages';
import { RpcHelper } from '../transport/rpc';
import type { DecorateHandshake } from '../transport/serveTransport';
import type { AdmitSession } from '../transport/webTransportHost';
import { sharedGeometry } from './geometry';
import type { SiteHistoryAnswer, SiteHistoryOp } from './history';
import type { ControllerInit } from './index';
import { SiteSlots } from './sitePool';

/** rpc id between the hub and an agent (one port each) */
export const SITE_RPC = 'stomp-site-agent';
/** agent -> hub, on its window: it is up and waits for its init */
export const SITE_HELLO = '$stomp$siteHello';
/** hub -> agent, on its window, with the agent's rpc port */
export const SITE_INIT = '$stomp$siteInit';
/** the rpc id a decorate port speaks (the transport worker's own) */
export const DECORATE_RPC = 'stomp-transport-worker';

/** what the hub hands an agent to start its controller with */
export interface SiteAgentInit {
	/** the hub's worker's codec key, which every slot's worker takes */
	codecKey: string;
	/** how many rewrite workers the hub runs (ports are made per handshake) */
	pool: number;
	/**
	 * the hub's page is cross-origin isolated: the slot's documents are
	 * served to load there (Config.isolated), which the agent, a frame of
	 * another origin with no isolation delegated to it, cannot read itself
	 */
	isolated: boolean;
	/** the hub's message token (Config.sites) */
	token: string;
	/**
	 * the origin of the page whose frames show the proxied sites (the real
	 * top, which the slot's documents never show as a window of their
	 * world): the hub's own, or the host's when the hub is a controller
	 * frame (RemoteController)
	 */
	top?: string;
	/**
	 * how many windows up from the agent that page is: 1 when the hub is
	 * that page (the agent is its frame), 2 when the hub is a controller
	 * frame in it
	 */
	framesUp?: number;
	/** the pool's slots' origins (Config.sites) */
	origins: string[];
	/** how many slots the pool has (ControllerInitMessage.slots) */
	slots: number;
	/** the controller's options, as the hub's own were given (no functions) */
	controller: Partial<ControllerInit>;
	/**
	 * the hub's passkeys (Config.passkeys): the slot's worker is the
	 * authenticator of the sites it shows, with the credentials in the hub
	 * origin's store (src/server/jarDB.ts), and the hub's host asks the user
	 * (HubBound.passkeyPrompt)
	 */
	passkeys?: PasskeysConfig;
}

/** implemented by the hub, called by an agent */
export type HubBound = {
	/** serve the transport on `port`, asking `decorate` for WebSocket handshake headers */
	serve: [{ port: MessagePort; decorate: MessagePort }];
	/** hand each of the hub's rewrite workers one of these ports, in order */
	rewritePorts: [MessagePort[]];
	/** the slot `site` is shown from (its origin), given one now when it has none */
	siteSlot: [string, string | null];
	/** a navigation leaves for `site`: its slot's origin once that slot's agent is up (it was handed `arrival`), or null */
	crossSite: [{ site: string; arrival: SiteArrival }, string | null];
	/** answer the agent's worker's cookie jar requests on this port (src/transport/jarServer.ts) */
	jar: [MessagePort];
	/** answer the agent's worker's blocker questions on this port (src/server/remoteBlocker.ts) */
	blocker: [MessagePort];
	/** a proxied request completed (the host's request log) */
	request: [RequestInfo];
	/** a site asks for a permission (ControllerInit.onPermissionRequest) */
	permission: [PermissionRequestInfo, boolean | null];
	/** a site's passkey ceremony asks the user (ControllerInit.passkeys), with the port that says the page gave up */
	passkeyPrompt: [
		{ request: PasskeyPrompt; port: MessagePort },
		PasskeyAnswer | null,
	];
	/** whether the focus is in the page of the frame that shows the document `client` (a ceremony's focus check) */
	passkeyFocused: [string, boolean];
	/** a site's FedCM account chooser, which the host's page draws, with the port that closes when the document goes away */
	identityChooser: [
		{ request: IdentityChooserRequest; port: MessagePort },
		number,
	];
	/** replace the transport (the agent's setTransport) */
	setTransport: [TransportModule];
};

/** implemented by an agent, called by the hub */
export type AgentBound = {
	/** the controller is up (its first handshake was answered) */
	ready: [undefined, boolean];
	/** a navigation from another slot's worker is on its way to this origin */
	arrive: [SiteArrival];
	/** the hub's clock: keep the worker running */
	tick: [];
	/** the hub's host changed something every worker is told (FannedMethod) */
	apply: [{ method: FannedMethod; args: unknown }];
	/**
	 * run `run` of the history of the frame at `index` of the hub's page,
	 * a stretch of it shown from this origin (history.ts answerRun); null
	 * when there is no such frame
	 */
	/** a command of the isolated RemoteController for the frame at `index` (frame.ts frameCommand) */
	command: [{ index: number; command: SiteHistoryCommand }, boolean | null];
	/** what the frame at `index` shows, when it is a document of this origin (RemoteController's frameInfo) */
	frameInfo: [number, SiteFrameInfo | null];
	/** a document of the frame at `index` got a user activation (RemoteController's frameActivated) */
	activated: [{ index: number; token: string; nested: boolean }, boolean];
	/** the frame at `index` of the hub's page has focus there (-1: none does) */
	focus: [number];
	/** the host's browser window as its frames' documents see it (HOST_GEOMETRY, ./geometry.ts) */
	geometry: [HostGeometry];
	/** which of these service worker clients the slot's worker does not know (the hub's ClientFrames) */
	goneClients: [string[], string[]];
	history: [
		{ index: number; run: number; op: SiteHistoryOp },
		SiteHistoryAnswer | null,
	];
};

/** what an agent reads of a frame of this origin (messages.ts FrameInfo) */
export interface SiteFrameInfo {
	url: string | null;
	title: string | null;
	canGoBack: boolean | null;
	canGoForward: boolean | null;
}

/**
 * what the hub's host changed for its own worker and every slot's worker
 * must hear too (the rules, the shields, the blocker's lists, a cleared
 * cache, a site's storage to forget), by the worker's method
 */
export type FannedMethod =
	| 'rules'
	| 'shields'
	| 'adblock'
	| 'clearCache'
	| 'forgetStorage'
	| 'forgetDeviceIds'
	| 'viewport';

/** what the isolated RemoteController asks an agent of a frame's history (frame.ts frameCommand) */
export type SiteHistoryCommand =
	'back' | 'forward' | 'reload' | 'typed' | 'canBack' | 'canForward';

/** what a StompController running as an agent is told to do differently (ControllerInit.agent) */
export interface SiteAgentHooks {
	codecKey: string;
	/** how many slots the pool has (SiteAgentInit.slots) */
	slots: number;
	/** the hub's page is cross-origin isolated (SiteAgentInit.isolated) */
	isolated: boolean;
	/** the hub's origin and its message token (Config.sites) */
	sites: SitesConfig;
	/** serves the transport through the hub; `bind` gives it the controller's handshake headers */
	worker: BrokeredTransport;
	/** the hub's rewrite workers */
	pool: BrokeredPool | undefined;
	siteSlot(site: string): Promise<string | null>;
	crossSite(args: {
		site: string;
		arrival: SiteArrival;
	}): Promise<string | null>;
	/** a port that asks the hub's cookie jar, for a handshake */
	jar(): MessagePort;
	/** a port that asks the hub's worker's blocker, for a handshake (a slot's worker builds no engine) */
	blocker: () => MessagePort;
	request(info: RequestInfo): void;
	permission(info: PermissionRequestInfo): Promise<boolean | null>;
	/** HubBound.passkeyFocused */
	passkeyFocused(client: string): Promise<boolean>;
	/** the controller's keep-alive, for the hub's clock */
	keepAlive?: () => void;
	/** the slot's worker took the controller's handshake (its hello): it is STomp's */
	heard?: () => void;
}

/**
 * answer a transport worker's decorate requests on `port` with `decorate`,
 * and its WebTransport admissions with `admit` (the slot's controller asks
 * the blocker as the hub's does for its own pages)
 */
export function answerDecorate(
	port: MessagePort,
	decorate: DecorateHandshake,
	admit: AdmitSession,
) {
	const rpc = new RpcHelper<WorkerToController, Record<never, never>>(
		{
			decorate: async ({ url, headers }) => [
				await decorate(new URL(url), headers),
				[],
			],
			admit: async ({ url, origin }) => [await admit(new URL(url), origin), []],
			tick: async () => {},
			// the hub's controller hears its worker's carrier and notes itself
			carrier: async () => {},
			transportNote: async () => {},
		},
		DECORATE_RPC,
		(data, transfer) => port.postMessage(data, transfer),
	);
	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.start();
}

/** the handshake headers and admissions asked over `port` (answerDecorate's other end) */
export function decorateOver(port: MessagePort): {
	decorate: DecorateHandshake;
	admit: AdmitSession;
} {
	const rpc = new RpcHelper<Record<never, never>, WorkerToController>(
		{},
		DECORATE_RPC,
		(data, transfer) => port.postMessage(data, transfer),
	);
	port.addEventListener('message', (event) => rpc.receive(event.data));
	port.start();
	return {
		decorate: (url, headers) =>
			rpc.call('decorate', { url: url.href, headers }),
		admit: (url, origin) => rpc.call('admit', { url: url.href, origin }),
	};
}

/**
 * An agent's transport: every port its controller would hand its transport
 * worker goes to the hub's, with a second port on which the agent answers
 * for the WebSocket handshake headers
 */
export class BrokeredTransport {
	#hub: RpcHelper<AgentBound, HubBound>;
	#decorate: DecorateHandshake = async (url, headers) => headers;
	#admit: AdmitSession = async () => true;
	constructor(hub: RpcHelper<AgentBound, HubBound>) {
		this.#hub = hub;
	}
	/** the controller's handshake headers hook */
	bind(decorate: DecorateHandshake, admit: AdmitSession) {
		this.#decorate = decorate;
		this.#admit = admit;
	}
	servePort(port: MessagePort) {
		const channel = new MessageChannel();
		answerDecorate(
			channel.port2,
			(url, headers) => this.#decorate(url, headers),
			(url, origin) => this.#admit(url, origin),
		);
		this.#hub
			.call('serve', { port, decorate: channel.port1 }, [port, channel.port1])
			.catch((error) =>
				console.error('Stomp: the hub could not serve a port', error),
			);
	}
	serve(): MessagePort {
		const channel = new MessageChannel();
		this.servePort(channel.port2);
		return channel.port1;
	}
	setTransport(descriptor: TransportModule): Promise<void> {
		return this.#hub.call('setTransport', descriptor);
	}
	terminate() {}
}

/** an agent's rewrite workers: the hub's, a fresh port to each per handshake */
export class BrokeredPool {
	#hub: RpcHelper<AgentBound, HubBound>;
	#size: number;
	constructor(hub: RpcHelper<AgentBound, HubBound>, size: number) {
		this.#hub = hub;
		this.#size = size;
	}
	ports(): MessagePort[] {
		const channels = Array.from({ length: this.#size }, () => {
			return new MessageChannel();
		});
		const theirs = channels.map((channel) => channel.port1);
		this.#hub
			.call('rewritePorts', theirs, theirs)
			.catch((error) =>
				console.error('Stomp: the hub could not pass on rewrite ports', error),
			);
		return channels.map((channel) => channel.port2);
	}
	/** the hub's workers hold the hub's modules */
	adopt() {}
	held(): string[][] {
		return [];
	}
}

/** what the hub needs of the host's controller */
export interface HubHost {
	/** the host's options */
	init: ControllerInit;
	/** the page whose frames show the sites, and how far up from an agent it is (SiteAgentInit.top, framesUp) */
	top: string;
	framesUp: number;
	/** the scope's URL on the host's origin (the agents' directory has its path) */
	directory: URL;
	/** the controller frame's file and the agent script's, as the host serves them */
	frameFile: string;
	scriptFile: string;
	/** the host's codec key, once its worker answered */
	codecKey(): Promise<string>;
	/** the controller's options for an agent, once the host's controller is ready */
	agentOptions(): Promise<Partial<ControllerInit>>;
	/** how many rewrite workers the host runs */
	poolSize(): number;
	serve(port: MessagePort, decorate: MessagePort): void;
	/** answer a slot's worker's cookie jar requests on `port` */
	jar(port: MessagePort): void;
	/** answer a slot's worker's blocker questions on `port`, from the host's worker */
	blocker(port: MessagePort): void;
	rewritePorts(ports: MessagePort[]): void;
	/** a navigation from a slot's worker comes to the host's own worker (its slot is left out) */
	arrive(arrival: SiteArrival): Promise<void>;
	request(info: RequestInfo): void;
	permission(info: PermissionRequestInfo): Promise<boolean | null>;
	/** the host's passkeys, once its controller is ready (Config.passkeys) */
	passkeys(): PasskeysConfig | undefined;
	/** a slot's site's passkey ceremony: the host asks the user */
	passkeyPrompt(
		request: PasskeyPrompt,
		port: MessagePort,
	): Promise<PasskeyAnswer | null>;
	/** HubBound.passkeyFocused */
	passkeyFocused(client: string): Promise<boolean>;
	/** HubBound.identityChooser */
	identityChooser(
		request: IdentityChooserRequest,
		port: MessagePort,
	): Promise<number>;
	setTransport(descriptor: TransportModule): Promise<void>;
}

interface Agent {
	origin: string;
	element: HTMLIFrameElement;
	rpc: RpcHelper<HubBound, AgentBound>;
	/** settles once the agent's controller answered its first handshake */
	ready: Promise<void>;
}

/**
 * how long an agent may take to start (its frame, its worker's install and
 * first handshake) before its slot counts as unreachable; a slot never used
 * takes 1.3 to 1.8 s on a busy machine (docs/site-pool.md)
 */
const AGENT_WAIT_MS = 15000;
/**
 * how long an agent's frame may stay silent once it loaded: a front that
 * answers the slot's port with a page of its own (an error page, a login)
 * loads a document that never says hello. The agent's hello is posted by
 * its script, which the frame's load event waits for, and the two reach
 * this page in that order: this only covers a page that is slow to say it
 */
const HELLO_AFTER_LOAD_MS = 1000;
/**
 * When an agent's frame that has not said hello is navigated again, in ms
 * from when it was made: Chrome sometimes never commits a frame of a slot
 * made within a second or two of the closing of a tab that had one there
 * (its response arrives, its document never starts and the frame never
 * loads), where the same navigation made again about 4 s later commits at
 * once (docs/site-pool.md, "An agent's frame that never commits"). An
 * agent says hello within a few hundred ms otherwise, a second or two on a
 * busy machine, so the gaps grow.
 */
const AGENT_RETRY_MS = [2000, 4000, 7000, 11000];
/**
 * how long a slot's origin may take to answer a request at all before its
 * agent is embedded: a network that drops other ports than the host's (a
 * filter that lets 443 through alone) answers nothing, and a frame says
 * nothing of a load that failed. Every slot is asked when the hub starts,
 * and given four times what the host's own origin took for the same
 * request (a new connection to another port costs a round trip or two
 * more), SLOT_PROBE_MIN_MS at least and SLOT_PROBE_MS at the most.
 */
const SLOT_PROBE_MS = 5000;
/** how long the spare agent (SiteHub.warm) waits for the page to be idle */
const WARM_WAIT_MS = 2000;
/** how long after a slot's agent is up the next spare is looked for */
const WARM_AFTER_MS = 1000;
const SLOT_PROBE_MIN_MS = 1000;
/**
 * how long an agent that started may take to answer the hub (a navigation
 * on its way, a step of a frame's history): one whose document went away
 * (its renderer crashed, the host's page removed or navigated its frame)
 * answers nothing, and its slot is left out from then on. The agent shares
 * a process with its slot's pages, so a page's long task holds it up too.
 */
const AGENT_CALL_MS = 4000;

/**
 * The host's side of the site pool: which slot shows which site, and each
 * slot's agent, made the first time the slot shows a site and kept while the
 * host lives
 */
export class SiteHub {
	#host: HubHost;
	#slots: SiteSlots;
	/** agents by origin */
	#agents = new Map<string, Agent>();
	/** the agents whose `ready` settled well */
	#running = new WeakSet<Agent>();
	/** the slots that did not answer from here: no site is shown from one while this page lives */
	#dead = new Set<string>();
	/** a spare agent is to be started (warm) */
	#warming = false;
	/** what every slot's document puts in a message to another slot's window (Config.sites) */
	#token = crypto.randomUUID();
	/** whether each slot's origin answered a request from here (#answers), asked when the hub starts */
	#probes = new Map<string, Promise<boolean>>();
	/**
	 * The frame of this page that has focus here, by its index in `frames`
	 * (-1: none), as every agent was told. A frame whose next document
	 * commits in another process loses its focus there (the browser keeps
	 * the frame focused and sends it the keys, but the new process never
	 * hears of it, so the document reads `document.hasFocus()` false; a
	 * frame of a page natively has the same fate, a tab's page does not):
	 * a slot's top document takes it back as it starts, before the page
	 * runs, when its agent says the frame is the one with focus
	 * (siteWindows.ts keepTopFocus)
	 */
	#focused = -1;
	#noteFocus = (element: unknown) => {
		let index = -1;
		if (element instanceof HTMLIFrameElement) {
			const win = element.contentWindow;
			for (let i = 0; win && i < window.length; i++)
				if (window[i] === win) {
					index = i;
					break;
				}
		}
		if (index === this.#focused) return;
		this.#focused = index;
		for (const agent of this.#agents.values())
			agent.rpc.call('focus', index).catch(() => {});
	};
	constructor(host: HubHost, origins: string[]) {
		this.#host = host;
		this.#slots = new SiteSlots(origins);
		// every slot is asked at once, in parallel, so a slot that does not
		// answer is known before the first navigation needs it
		const reference = this.#took(location.origin);
		for (const origin of origins)
			this.#probes.set(origin, this.#answers(origin, reference));
		document.addEventListener(
			'focusin',
			(event) => this.#noteFocus(event.composedPath()[0]),
			true,
		);
		document.addEventListener(
			'focusout',
			(event) => this.#noteFocus(event.relatedTarget),
			true,
		);
		this.#noteFocus(document.activeElement);
		window.addEventListener('message', (event) => {
			const agent = this.#agents.get(event.origin);
			if (
				!agent ||
				event.source !== agent.element.contentWindow ||
				typeof event.data !== 'object' ||
				event.data === null ||
				!(SITE_HELLO in event.data)
			)
				return;
			this.#start(agent);
		});
	}
	/** whether `origin` is one of the pool's slots */
	has(origin: string): boolean {
		return this.#slots.origins.includes(origin);
	}
	/** the pool's slots */
	get origins(): string[] {
		return [...this.#slots.origins];
	}
	/**
	 * The slot `site` is shown from (its origin), once that slot's agent's
	 * worker is up, or null when it is shown from this page's origin: its
	 * slot does not answer from here (every slot, for a site without one).
	 * `from` is the slot of the document a navigation comes from (a site
	 * without a slot yet gets another one than that). A site keeps its slot
	 * when it is shown from this page's origin: the slot may answer in the
	 * next page, and its data is there.
	 */
	async originOf(site: string, from?: string): Promise<string | null> {
		let origin: string;
		try {
			origin = await this.#slots.originOf(site, from, this.#dead);
		} catch (error) {
			// no slot answers from here
			return null;
		}
		if (this.#dead.has(origin)) return null;
		const agent = this.#agent(origin);
		// a new site may have taken the spare: the next one is started once
		// this one is up and the page it shows had a moment to load
		const next = () => setTimeout(() => this.warm(), WARM_AFTER_MS);
		agent.ready.then(next, next);
		try {
			await agent.ready;
		} catch (error) {
			return null;
		}
		return this.#live(agent) ? origin : null;
	}
	/**
	 * Once the page is idle, start the agents of the slots a site is likely
	 * to be shown from next, the spares, so its first document does not wait
	 * for its slot's agent and worker to start: the slot the next new site
	 * would get (SiteSlots.next), and before this page showed any site, the
	 * slot that showed one last (SiteSlots.last: the site a visit often
	 * goes back to). Once it showed one, a new spare is started only when
	 * no agent is idle (none of this page's documents was shown from its
	 * slot). Not every slot: an agent is a renderer process and a worker
	 * kept running, which a page that shows one site never uses, so a page
	 * keeps one spare (two before its first site). A spare is never closed:
	 * the hub's frames are counted by index in the page's `frames`, the
	 * agents' too.
	 */
	warm() {
		if (this.#warming) return;
		this.#warming = true;
		const idle =
			globalThis.requestIdleCallback ??
			((callback: () => void) => setTimeout(callback, 50));
		idle(
			async () => {
				const slots = this.#slots;
				const wanted: (string | null)[] = [];
				try {
					if (!slots.origins.some((origin) => slots.usedHere(origin)))
						wanted.push(await slots.next(this.#dead), slots.last(this.#dead));
					else if ([...this.#agents.keys()].every((o) => slots.usedHere(o)))
						wanted.push(await slots.next(this.#dead));
				} finally {
					this.#warming = false;
				}
				for (const origin of wanted)
					if (origin && !this.#agents.has(origin) && !this.#dead.has(origin))
						this.#agent(origin);
			},
			{ timeout: WARM_WAIT_MS },
		);
	}
	/**
	 * A navigation from a document this page's origin shows (its worker's)
	 * leaves for `site`: the origin it goes to once that origin's worker was
	 * handed `arrival`, this page's own when the site's slot is left out
	 */
	cross(site: string, arrival: SiteArrival): Promise<string> {
		return this.#cross(site, arrival, location.origin);
	}
	/** the slot of `site` sent a navigation back here (its agent is gone): it is left out */
	async homed(site: string): Promise<boolean> {
		const origin = await this.#slots.known(site);
		if (!origin || origin === location.origin) return false;
		this.#kill(origin, new Error(`the agent of ${origin} is gone`));
		return true;
	}
	/** no site is shown from the slot `origin` from now on (its worker said its agent is gone) */
	leaveOut(origin: string) {
		if (this.has(origin))
			this.#kill(origin, new Error(`the agent of ${origin} is gone`));
	}
	/** the agent's frame is still in this page (the host's own code may have removed it) */
	#live(agent: Agent): boolean {
		if (agent.element.isConnected) return true;
		this.#kill(agent.origin, new Error(`the agent of ${agent.origin} is gone`));
		return false;
	}
	/** an agent's answer, or a rejection AGENT_CALL_MS on (its slot is then left out) */
	async #ask<M extends keyof AgentBound>(
		agent: Agent,
		method: M,
		args: AgentBound[M][0],
	): Promise<AgentBound[M][1]> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				agent.rpc.call(method, args),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(new Error(`the agent of ${agent.origin} does not answer`)),
						AGENT_CALL_MS,
					);
				}),
			]);
		} catch (error) {
			if (this.#agents.get(agent.origin) === agent)
				this.#kill(agent.origin, error);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	/**
	 * No site is shown from the slot `origin` while this page lives: its
	 * sites are this page's origin's, as without a pool. Its assignments are
	 * kept.
	 */
	#kill(origin: string, error: unknown) {
		if (!this.#dead.has(origin))
			console.warn('Stomp: a slot of the site pool is left out', error);
		this.#dead.add(origin);
		const agent = this.#agents.get(origin);
		if (!agent) return;
		this.#agents.delete(origin);
		agent.rpc.abort(`the slot ${origin} is left out`);
		agent.element.remove();
	}
	/** how long this page's origin takes to answer the probe's request, in ms (SLOT_PROBE_MS when it does not) */
	async #took(origin: string): Promise<number> {
		const started = performance.now();
		return (await this.#fetched(origin, SLOT_PROBE_MS))
			? performance.now() - started
			: SLOT_PROBE_MS;
	}
	/** whether a request for the agent's frame on `origin` was answered within `ms` */
	async #fetched(
		origin: string,
		ms: number | Promise<number>,
	): Promise<boolean> {
		const abort = new AbortController();
		const started = performance.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = Promise.resolve(ms).then(
			(ms) =>
				new Promise<boolean>((resolve) => {
					timer = setTimeout(
						() => resolve(false),
						ms - (performance.now() - started),
					);
				}),
		);
		try {
			return await Promise.race([
				fetch(this.#frameURL(origin), {
					mode: 'no-cors',
					cache: 'no-store',
					credentials: 'omit',
					signal: abort.signal,
				}).then(
					() => true,
					() => false,
				),
				late,
			]);
		} finally {
			clearTimeout(timer);
			abort.abort();
		}
	}
	/** whether the slot's origin answers a request from here in about the time this page's origin does (SLOT_PROBE_MS) */
	#answers(origin: string, reference: Promise<number>): Promise<boolean> {
		return this.#fetched(
			origin,
			reference.then((ms) =>
				Math.min(SLOT_PROBE_MS, Math.max(SLOT_PROBE_MIN_MS, ms * 4)),
			),
		);
	}
	/** the agent's frame on `origin` */
	#frameURL(origin: string): URL {
		const src = new URL(
			`${this.#host.directory.pathname}${this.#host.frameFile}`,
			origin,
		);
		src.searchParams.set('script', this.#host.scriptFile);
		return src;
	}
	/** a command of the isolated RemoteController for the frame at `index` of the host's page, to the agent of `origin` (AgentBound.command) */
	async command(
		origin: string,
		index: number,
		command: SiteHistoryCommand,
	): Promise<boolean | null> {
		const agent = this.#agents.get(origin);
		if (!agent || index < 0) return null;
		try {
			await agent.ready;
			if (!this.#live(agent)) return null;
			return await this.#ask(agent, 'command', { index, command });
		} catch (error) {
			return null;
		}
	}
	/** ask the agent of `origin` about run `run` of the frame at `index` of this page (AgentBound.history) */
	async history(
		origin: string,
		index: number,
		run: number,
		op: SiteHistoryOp,
	): Promise<SiteHistoryAnswer | null> {
		const agent = this.#agents.get(origin);
		if (!agent || index < 0) return null;
		try {
			await agent.ready;
			if (!this.#live(agent)) return null;
			return await this.#ask(agent, 'history', { index, run, op });
		} catch (error) {
			return null;
		}
	}
	/** what every agent was told last of each frame of this page (tell), for an agent started since */
	#told = new Map<Window, SiteHistoryOp>();
	/** tell every agent `op` of the frame at `index` of this page, unanswered (AgentBound.history) */
	tell(index: number, op: SiteHistoryOp) {
		const win = this.#host.framesUp === 2 ? window.parent : window;
		const frame = win[index] as Window | undefined;
		if (frame) this.#told.set(frame, op);
		for (const agent of this.#agents.values()) this.#tell(agent, index, op);
	}
	/** (once the agent is ready: the hub's first call is its `ready`) */
	#tell(agent: Agent, index: number, op: SiteHistoryOp) {
		agent.ready
			.then(() => agent.rpc.call('history', { index, run: 0, op }))
			.catch(() => {});
	}
	/** tell an agent started since what the others were told of the frames' runs */
	#tellAll(agent: Agent) {
		const page = this.#host.framesUp === 2 ? window.parent : window;
		for (const [frame, op] of this.#told) {
			let index = -1;
			for (let i = 0; i < page.length; i++) if (page[i] === frame) index = i;
			if (index === -1) this.#told.delete(frame);
			else this.#tell(agent, index, op);
		}
	}
	/** ask the agent of `origin` what the frame at `index` of the page shows (AgentBound.frameInfo) */
	async frameInfo(
		origin: string,
		index: number,
	): Promise<SiteFrameInfo | null> {
		const agent = this.#agents.get(origin);
		if (!agent || index < 0) return null;
		try {
			await agent.ready;
			return await agent.rpc.call('frameInfo', index);
		} catch (error) {
			return null;
		}
	}
	/** tell the agent of `origin` of a user activation in the frame at `index` (AgentBound.activated) */
	async activated(
		origin: string,
		index: number,
		token: string,
		nested: boolean,
	): Promise<boolean> {
		const agent = this.#agents.get(origin);
		if (!agent || index < 0) return false;
		try {
			await agent.ready;
			return await agent.rpc.call('activated', { index, token, nested });
		} catch (error) {
			return false;
		}
	}
	/**
	 * tell every agent the host's geometry this window keeps (HOST_GEOMETRY);
	 * settles once each running agent heard. One still starting has it on its
	 * port before any document of its slot loads (the hub's first call is its
	 * `ready`), and one that never starts (a dead slot) holds nothing up.
	 */
	async geometry(): Promise<void> {
		const geometry = sharedGeometry(window);
		if (!geometry) return;
		const heard: Promise<unknown>[] = [];
		for (const agent of this.#agents.values()) {
			const call = agent.rpc.call('geometry', geometry).catch(() => {});
			if (this.#running.has(agent)) heard.push(call);
		}
		await Promise.all(heard);
	}
	/** tell every slot's worker what the hub's own was told (FannedMethod); settles once each heard */
	async apply(method: FannedMethod, args: unknown): Promise<void> {
		await Promise.all(
			[...this.#agents.values()].map((agent) =>
				agent.ready
					.then(() => agent.rpc.call('apply', { method, args }))
					.catch(() => {}),
			),
		);
	}
	/** tell the worker of one slot what the hub's own was told (FannedMethod), once it heard */
	async applyTo(origin: string, method: FannedMethod, args: unknown) {
		const agent = this.#agents.get(origin);
		if (!agent) return;
		try {
			await agent.ready;
			await agent.rpc.call('apply', { method, args });
		} catch (error) {
			// the agent is gone: its slot shows nothing now
		}
	}
	/**
	 * which of `clients` no slot's worker knows either: a document shown
	 * from a slot is a client of that slot's worker, which the hub's own
	 * worker never knows of. An agent that cannot answer keeps its clients
	 * (they are asked again later; ClientFrames bounds what it keeps)
	 */
	async goneClients(clients: string[]): Promise<string[]> {
		let gone = clients;
		for (const agent of this.#agents.values()) {
			if (!gone.length) break;
			try {
				await agent.ready;
			} catch (error) {
				continue; // a slot that never started has no documents
			}
			try {
				const left = new Set(await agent.rpc.call('goneClients', gone));
				gone = gone.filter((client) => left.has(client));
			} catch (error) {
				return [];
			}
		}
		return gone;
	}
	/** the hub's clock: every agent keeps its worker running */
	tick() {
		for (const agent of this.#agents.values())
			agent.rpc.call('tick', undefined).catch(() => {});
	}
	#agent(origin: string): Agent {
		const known = this.#agents.get(origin);
		if (known) return known;
		const element = document.createElement('iframe');
		element.setAttribute('aria-hidden', 'true');
		element.tabIndex = -1;
		element.style.display = 'none';
		const src = this.#frameURL(origin);
		element.src = src.href;
		const channel = new MessageChannel();
		const host = this.#host;
		const rpc = new RpcHelper<HubBound, AgentBound>(
			{
				serve: async ({ port, decorate }) => host.serve(port, decorate),
				rewritePorts: async (ports) => host.rewritePorts(ports),
				// a site whose slot is left out is this page's origin's, as
				// without a pool: the slot's worker sends its navigations there
				siteSlot: async (site) => [
					(await this.originOf(site, origin)) ?? location.origin,
					[],
				],
				crossSite: async ({ site, arrival }) => [
					await this.#cross(site, arrival, origin),
					[],
				],
				jar: async (port) => host.jar(port),
				blocker: async (port) => host.blocker(port),
				request: async (info) => host.request(info),
				permission: async (info) => [await host.permission(info), []],
				passkeyPrompt: async ({ request, port }) => [
					await host.passkeyPrompt(request, port),
					[],
				],
				passkeyFocused: async (client) => [
					await host.passkeyFocused(client),
					[],
				],
				identityChooser: async ({ request, port }) => [
					await host.identityChooser(request, port),
					[],
				],
				setTransport: async (descriptor) => host.setTransport(descriptor),
			},
			SITE_RPC,
			(data, transfer) => channel.port1.postMessage(data, transfer),
		);
		channel.port1.addEventListener('message', (event) =>
			rpc.receive(event.data),
		);
		channel.port1.start();
		// (heard once the agent has its port)
		if (this.#focused !== -1) rpc.call('focus', this.#focused).catch(() => {});
		const geometry = sharedGeometry(window);
		if (geometry) rpc.call('geometry', geometry).catch(() => {});
		let started!: () => void;
		const helloed = new Promise<void>((resolve) => (started = resolve));
		let unreachable!: (error: Error) => void;
		const refused = new Promise<never>((_, reject) => (unreachable = reject));
		const agent: Agent & { start?: () => void; port?: MessagePort } = {
			origin,
			element,
			rpc,
			ready: Promise.race([
				helloed.then(async () => {
					if (!(await rpc.call('ready', undefined)))
						throw new Error(`the agent of ${origin} did not start`);
				}),
				refused,
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`the agent of ${origin} did not answer`)),
						AGENT_WAIT_MS,
					),
				),
			]),
		};
		agent.ready.then(
			() => this.#running.add(agent),
			() => {},
		);
		this.#tellAll(agent);
		// the agent's frame said hello (its document runs)
		let greeted = false;
		agent.start = () => {
			greeted = true;
			if (!agent.port) return;
			const port = agent.port;
			agent.port = undefined;
			Promise.all([host.codecKey(), host.agentOptions()]).then(
				([codecKey, controller]) => {
					const passkeys = host.passkeys();
					const init: SiteAgentInit = {
						codecKey,
						pool: host.poolSize(),
						isolated: globalThis.crossOriginIsolated === true,
						token: this.#token,
						top: host.top,
						framesUp: host.framesUp,
						origins: [...this.#slots.origins],
						slots: this.#slots.origins.length,
						controller,
						...(passkeys ? { passkeys } : {}),
					};
					element.contentWindow?.postMessage({ [SITE_INIT]: init }, origin, [
						port,
					]);
					started();
				},
				(error) => console.error('Stomp: no agent could be started', error),
			);
		};
		agent.port = channel.port2;
		element.addEventListener('load', () =>
			setTimeout(
				() => unreachable(new Error(`the slot ${origin} is not an agent`)),
				HELLO_AFTER_LOAD_MS,
			),
		);
		let said = false;
		helloed.then(() => {
			said = true;
			unreachable = () => {};
		});
		// a frame that stays silent is navigated again (AGENT_RETRY_MS)
		for (const ms of AGENT_RETRY_MS)
			setTimeout(() => {
				if (
					!greeted &&
					element.isConnected &&
					this.#agents.get(origin) === agent
				)
					element.src = src.href;
			}, ms);
		// no site is shown from it while this page lives: its sites are this
		// page's origin's, as without a pool
		agent.ready.catch((error) => this.#kill(origin, error));
		this.#agents.set(origin, agent);
		// the frame loads beside the probe (asked when the hub started), and
		// its hello is the answer: a probe that fails first leaves the slot
		// out as before
		document.documentElement.append(element);
		this.#probes.get(origin)!.then((answers) => {
			if (!answers && !said)
				unreachable(new Error(`the slot ${origin} does not answer`));
		});
		return agent;
	}
	/**
	 * A navigation from a document of the slot `from` leaves for `site`: the
	 * origin it goes to once that origin's worker was handed `arrival` (this
	 * page's origin when the site's slot is left out, or `from` itself)
	 */
	async #cross(
		site: string,
		arrival: SiteArrival,
		from: string,
	): Promise<string> {
		const to = await this.originOf(site, from);
		const agent = to === null ? undefined : this.#agents.get(to);
		if (to === from) return to;
		if (agent) {
			try {
				await this.#ask(agent, 'arrive', arrival);
				return agent.origin;
			} catch (error) {
				// its agent went away: this page's origin takes it
			}
		}
		// this page's worker keeps what it knew of a navigation of its own
		if (from !== location.origin)
			await this.#host.arrive(arrival).catch(() => {});
		return location.origin;
	}
	#start(agent: Agent & { start?: () => void }) {
		agent.start?.();
	}
}
