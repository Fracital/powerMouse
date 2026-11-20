// The controllers' extensions (docs/extensions.md): `controller.extensions`
// installs and manages them (the worker keeps them, src/server/extensions),
// and the hub that lives with the controller on the proxy origin hosts what
// Chrome keeps in the browser rather than in a page: the extensions'
// backgrounds (hidden proxied frames), the toolbar action's state per tab,
// the tabs themselves, offscreen documents, popups' sizes. The extensions'
// contexts reach the hub on their BroadcastChannel; a RemoteController's
// hub is its controller frame's, asked over the frame's RPC.
import {
	cleanPath,
	displayExtensionURL,
	extensionOfURL,
	extensionURL,
	resolveExtensionURL,
} from '../extensions/origin';
import {
	BACKGROUND_PAGE,
	CONTEXT_NAME_PREFIX,
	ExtensionError,
	serviceWorkerPage,
	type ActionState,
	type ClickResult,
	type ExtensionAction,
	type ExtensionCommand,
	type ExtensionErrorCode,
	type ExtensionInfo,
	type ExtensionNotification,
	type ExtensionOptions,
	type ExtensionPrompt,
	type ExtensionPromptAnswer,
	type ExtensionPromptRequest,
	type ExtensionsChange,
	type ExtensionSource,
	type InstallOptions,
	type PopupHandle,
} from '../extensions/types';
import { EXTENSION_BUS_PREFIX, EXTENSION_CHANGES } from '../transport/messages';

/** a tab as the hub's host knows it */
export interface HubTab {
	id: number;
	url: string;
	title: string;
	active: boolean;
	/** a document is loading in it (the feed saw it commit, not load) */
	status?: 'loading';
}

/** what the hub asks of its controller about tabs */
export interface HubTabs {
	list(): Promise<HubTab[]>;
	/** the tab (and frame: 0 for its top document) a service worker client is in */
	ofClient(client: string): Promise<{ tabId: number; frameId: number } | null>;
	create(url: string, active: boolean): Promise<number | null>;
	navigate(tabId: number, url: string): Promise<void>;
	reload(tabId: number): Promise<void>;
	back(tabId: number): Promise<void>;
	forward(tabId: number): Promise<void>;
	close(tabId: number): Promise<void>;
	activate(tabId: number): Promise<void>;
}

/** a controller's frame as a tab (Frame, RemoteFrame) */
export interface TabFrame {
	element: HTMLIFrameElement;
	url: string | null;
	title: string | null;
	go(url: string): unknown;
	reload(): unknown;
	back(): unknown;
	forward(): unknown;
}

/** what framesAsTabs needs of a controller */
export interface TabFrames<F extends TabFrame> {
	frames(): readonly F[];
	/** a frame was closed (`tabs.remove`): the controller forgets it */
	closed(frame: F): void;
	active(): F | null;
	activate(frame: F): void;
	tabIdOf(frame: F): number;
	/** the frame a service worker client's document is in */
	frameOf(client: string): F | null;
	/** whether the client is the frame's top document */
	isTop(frame: F, client: string): boolean;
	/** a nested document's frame id, as the worker keeps it (its requests' frame ids are the same) */
	frameIdOf?: (client: string) => Promise<unknown>;
	/** a frame's next document keeps the frame id of its last: the worker is told */
	sameFrame?: (next: string, previous: string) => void;
	/** the host's onOpen: a new tab opened from `opener` */
	open?: (url: string, opener: F) => void;
	/** a new tab with no tab to open it from: the host is told (a `tab` change) */
	request?: (url: string) => void;
	/** where the feed's events go (the hub, or the controller frame's over RPC); none: no feed */
	events?: (event: TabEvent) => void;
}

/**
 * What the host's frames did, for the hub's tabs and webNavigation events:
 * Chrome's tab strip and navigation stack, which only the host sees (the
 * tabs it opens, shows and closes, each top document's commit and load)
 */
export type TabEvent =
	| { e: 'created'; tabId: number; url: string; active: boolean }
	| { e: 'activated'; tabId: number }
	| { e: 'removed'; tabId: number }
	| {
			e: 'commit';
			tabId: number;
			url: string;
			title: string;
			client: string;
			transition: string;
	  }
	| { e: 'history'; tabId: number; url: string; fragment: boolean }
	| { e: 'title'; tabId: number; title: string }
	| { e: 'icon'; tabId: number; icon: string }
	| { e: 'complete'; tabId: number };

/** a top document's navigate report, as the feed reads it */
export interface TabReport {
	url: string;
	title: string;
	icon?: string | null;
	client?: string;
}

/** a controller's frames as the hub's tabs: the hub's calls, and the feed of what they did */
export interface FramesAsTabs<F extends TabFrame> extends HubTabs {
	/** the frames, or which one is shown, changed */
	changed(): void;
	/** a frame's top document reported (navigateReport) */
	navigated(frame: F, report: TabReport): void;
	/**
	 * a nested document reported its client from `source`, its frame's
	 * WindowProxy (the same object across the frame's documents): it keeps
	 * the frame id of the last document reported from there
	 */
	sameWindow(source: object, client: string): void;
}

/**
 * An array that calls `changed` (once a task) when it is written to: the
 * controllers' `frames`, which their hosts push to and splice
 */
export function watchedList<T>(list: T[], changed: () => void): T[] {
	let queued = false;
	return new Proxy(list, {
		set(target, key, value, receiver) {
			const done = Reflect.set(target, key, value, receiver);
			if (!queued) {
				queued = true;
				queueMicrotask(() => {
					queued = false;
					changed();
				});
			}
			return done;
		},
		deleteProperty(target, key) {
			const done = Reflect.deleteProperty(target, key);
			changed();
			return done;
		},
	});
}

const sameDocumentURL = (from: string, to: string) =>
	from.split('#')[0] === to.split('#')[0];

/** a controller's frames as the hub's tabs, in both host modes */
export function framesAsTabs<F extends TabFrame>(
	host: TabFrames<F>,
): FramesAsTabs<F> {
	const shown = () =>
		host.frames().filter((frame) => frame.element.isConnected);
	const byId = (id: number) => {
		const frame = shown().find((candidate) => host.tabIdOf(candidate) === id);
		if (!frame) throw new Error(`No tab with id: ${id}.`);
		return frame;
	};
	// (the worker's, kept here once asked; a counter of this hub's without it)
	const frameIds = new Map<string, number>();
	// the client each nested frame's window last reported
	const windows = new WeakMap<object, string>();
	// what the feed last told of each tab
	type Seen = {
		tabId: number;
		client: string | null;
		url: string;
		title: string;
		icon: string | null;
		complete: boolean;
		/** a load came before its document reported (the commit completes at once) */
		loaded: number;
	};
	const seen = new Map<F, Seen>();
	let active: F | null = null;
	const send = (event: TabEvent) => {
		try {
			host.events?.(event);
		} catch (error) {
			// the hub's host is gone
		}
	};
	const loaded = (frame: F) => {
		const state = seen.get(frame);
		if (!state) return;
		if (state.client && !state.complete) {
			state.complete = true;
			send({ e: 'complete', tabId: state.tabId });
		} else if (state.client) state.loaded = Date.now();
	};
	const changed = () => {
		if (!host.events) return;
		const now = shown();
		for (const frame of now)
			if (!seen.has(frame)) {
				const tabId = host.tabIdOf(frame);
				seen.set(frame, {
					tabId,
					client: null,
					url: frame.url ?? '',
					title: frame.title ?? '',
					icon: null,
					complete: false,
					loaded: 0,
				});
				frame.element.addEventListener('load', () => loaded(frame));
				send({
					e: 'created',
					tabId,
					url: frame.url ?? '',
					active: frame === host.active(),
				});
			}
		for (const [frame, state] of seen)
			if (!now.includes(frame)) {
				seen.delete(frame);
				send({ e: 'removed', tabId: state.tabId });
			}
		// a tab the host shows before its frame is in the page: once it is
		const wanted = host.active();
		const shownNow = wanted
			? now.includes(wanted)
				? wanted
				: active
			: (now[0] ?? null);
		if (shownNow !== active) {
			active = shownNow;
			if (shownNow) send({ e: 'activated', tabId: host.tabIdOf(shownNow) });
		}
	};
	return {
		changed,
		sameWindow: (source, client) => {
			const previous = windows.get(source);
			windows.set(source, client);
			if (!previous || previous === client) return;
			const id = frameIds.get(previous);
			if (id !== undefined) frameIds.set(client, id);
			host.sameFrame?.(client, previous);
		},
		navigated: (frame, report) => {
			if (!host.events) return;
			changed();
			const state = seen.get(frame);
			if (!state) return;
			if (report.client && report.client !== state.client) {
				const first = state.client === null;
				const reload = !first && report.url === state.url;
				state.client = report.client;
				state.url = report.url;
				state.title = report.title;
				state.icon = report.icon ?? null;
				state.complete = false;
				send({
					e: 'commit',
					tabId: state.tabId,
					url: report.url,
					title: report.title,
					client: report.client,
					transition: first ? 'typed' : reload ? 'reload' : 'link',
				});
				// its load came first: the frame's element said so before the
				// report (the document says, when the host may read it)
				let done: boolean | null = null;
				try {
					const doc = frame.element.contentDocument;
					if (doc) done = doc.readyState === 'complete';
				} catch (error) {
					// another origin's
				}
				const early = !!state.loaded && Date.now() - state.loaded < 1000;
				state.loaded = 0;
				if (done ?? early) {
					state.complete = true;
					send({ e: 'complete', tabId: state.tabId });
				}
				return;
			}
			if (report.url !== state.url) {
				const fragment = sameDocumentURL(state.url, report.url);
				state.url = report.url;
				send({ e: 'history', tabId: state.tabId, url: report.url, fragment });
			}
			if (report.title !== state.title) {
				state.title = report.title;
				send({ e: 'title', tabId: state.tabId, title: report.title });
			}
			const icon = report.icon ?? null;
			if (icon && icon !== state.icon) {
				state.icon = icon;
				send({ e: 'icon', tabId: state.tabId, icon });
			}
		},
		list: async () => {
			const active = host.active() ?? shown()[0] ?? null;
			return shown().map((frame) => {
				const state = seen.get(frame);
				return {
					id: host.tabIdOf(frame),
					url: frame.url ?? '',
					title: frame.title ?? '',
					active: frame === active,
					...(state && state.client && !state.complete
						? { status: 'loading' as const }
						: {}),
				};
			});
		},
		ofClient: async (client) => {
			const frame = host.frameOf(client);
			if (!frame) return null;
			let frameId = 0;
			if (!host.isTop(frame, client)) {
				let known = frameIds.get(client);
				if (known === undefined) {
					const asked = Number(await host.frameIdOf?.(client).catch(() => -1));
					known = asked > 0 ? asked : frameIds.size + 1;
					frameIds.set(client, known);
					if (frameIds.size > 4096)
						frameIds.delete(frameIds.keys().next().value!);
				}
				frameId = known;
			}
			return { tabId: host.tabIdOf(frame), frameId };
		},
		create: async (url) => {
			const opener = host.active() ?? shown()[0];
			const before = new Set(host.frames());
			if (host.open && opener) host.open(url, opener);
			else if (host.request) host.request(url);
			else return null;
			for (let tries = 0; tries < 40; tries++) {
				const made = host.frames().find((frame) => !before.has(frame));
				if (made) return host.tabIdOf(made);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return null;
		},
		navigate: async (id, url) => {
			await byId(id).go(url);
		},
		reload: async (id) => {
			await byId(id).reload();
		},
		back: async (id) => {
			await byId(id).back();
		},
		forward: async (id) => {
			await byId(id).forward();
		},
		close: async (id) => {
			const frame = byId(id);
			frame.element.remove();
			host.closed(frame);
		},
		activate: async (id) => {
			host.activate(byId(id));
		},
	};
}

/** what the hub needs of its controller */
export interface HubHost {
	/** the controller's address: the extensions' channels are named by it */
	channel(): string;
	/** the service worker's scope */
	scope(): string;
	/** the worker's extension backend (SWbound `extensions`) */
	command(
		command: ExtensionCommand,
		transfer?: Transferable[],
	): Promise<unknown>;
	route(url: string): Promise<string>;
	/** where the backgrounds' and offscreen documents' frames go */
	container(): HTMLElement;
	sandbox: string | null;
	tabs: HubTabs;
	/** tell the host's listeners */
	notify(change: ExtensionsChange): void;
}

const DEFAULT_ACTION = (): Omit<
	ActionState,
	'title' | 'iconUrl' | 'popupUrl'
> & {
	title: string | null;
	icon: string | null;
	popup: string | null;
} => ({
	title: null,
	icon: null,
	popup: null,
	badgeText: '',
	badgeColor: '#5f6368',
	badgeTextColor: null,
	enabled: true,
});

type RawAction = ReturnType<typeof DEFAULT_ACTION>;

interface HubExtension {
	info: ExtensionInfo;
	bus: BroadcastChannel;
	action: RawAction;
	tabAction: Map<number, Partial<RawAction>>;
	background: HTMLIFrameElement | null;
	backgroundReady: Promise<void> | null;
	offscreen: HTMLIFrameElement | null;
	menus: Map<string, Record<string, unknown>>;
	notifications: Map<string, ExtensionNotification>;
	/** popups a host is mounting (mountPopup): the next page of the URL that says hello is one */
	popups: { url: string; tabId: number; at: number }[];
}

/** how long a popup the host mounts has to say hello */
const POPUP_WAIT_MS = 15_000;

/** an error the worker's RPC carried as text (`[ext:<code>] message`) */
/** an ExtensionError as a message that carries its code (extensionErrorOf reads it back) */
export function codedError(error: unknown): unknown {
	return error instanceof ExtensionError
		? new Error(`[ext:${error.code}] ${error.message}`)
		: error;
}

export function extensionErrorOf(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	const coded = /^\[ext:([a-z-]+)\] ([\s\S]*)$/.exec(message);
	return coded
		? new ExtensionError(coded[1] as ExtensionErrorCode, coded[2])
		: error instanceof Error
			? error
			: new Error(message);
}

/**
 * @internal The hub: one per controller that talks to the worker (the
 * StompController, or a RemoteController's controller frame)
 */
export class ExtensionHub {
	#host: HubHost;
	#extensions = new Map<string, HubExtension>();
	#changes: BroadcastChannel | null = null;
	#refreshing: Promise<void> | null = null;
	#started = false;
	/** settles once the hub listed the extensions the first time */
	ready: Promise<void> = Promise.resolve();

	constructor(host: HubHost) {
		this.#host = host;
	}

	/** start listening (the controller is ready, its address known) */
	start() {
		if (this.#started) return this.ready;
		this.#started = true;
		this.#changes = new BroadcastChannel(
			`${EXTENSION_CHANGES}${this.#host.scope()}`,
		);
		this.#changes.onmessage = (event) => {
			const change = event.data as ExtensionsChange;
			this.refresh().then(() => this.#host.notify(change));
		};
		this.ready = this.refresh().then(() =>
			this.#host.notify({ type: 'ready' }),
		);
		return this.ready;
	}

	async command<T>(
		command: ExtensionCommand,
		transfer?: Transferable[],
	): Promise<T> {
		try {
			return (await this.#host.command(command, transfer)) as T;
		} catch (error) {
			throw extensionErrorOf(error);
		}
	}

	/** read the list again: open the buses of new ones, start their backgrounds */
	refresh(): Promise<void> {
		const run = async () => {
			const list = await this.command<ExtensionInfo[]>({ op: 'list' });
			const seen = new Set<string>();
			for (const info of list) {
				seen.add(info.id);
				const known = this.#extensions.get(info.id);
				if (!info.enabled) {
					if (known) this.#drop(known);
					continue;
				}
				if (known) {
					const updated = known.info.updatedAt !== info.updatedAt;
					known.info = info;
					if (updated && known.background) {
						this.#stopBackground(known);
						this.#startBackground(known);
					}
					continue;
				}
				const ext: HubExtension = {
					info,
					bus: new BroadcastChannel(
						`${EXTENSION_BUS_PREFIX}${this.#host.channel()}|${info.id}`,
					),
					action: DEFAULT_ACTION(),
					tabAction: new Map(),
					background: null,
					backgroundReady: null,
					offscreen: null,
					menus: new Map(),
					notifications: new Map(),
					popups: [],
				};
				ext.bus.onmessage = (event) => this.#receive(ext, event.data);
				this.#extensions.set(info.id, ext);
				this.#startBackground(ext);
			}
			for (const [id, ext] of this.#extensions)
				if (!seen.has(id)) this.#drop(ext);
		};
		const next = (this.#refreshing ?? Promise.resolve()).then(run, run);
		this.#refreshing = next.catch(() => {});
		return next;
	}

	#drop(ext: HubExtension) {
		this.#stopBackground(ext);
		ext.offscreen?.remove();
		ext.bus.close();
		this.#extensions.delete(ext.info.id);
	}

	#frame(name: string): HTMLIFrameElement {
		const frame = document.createElement('iframe');
		frame.name = name;
		if (this.#host.sandbox !== null)
			frame.setAttribute('sandbox', this.#host.sandbox);
		frame.setAttribute('aria-hidden', 'true');
		frame.tabIndex = -1;
		frame.style.cssText =
			'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none';
		return frame;
	}

	/** the background's page, in a hidden frame of the hub's document */
	#startBackground(ext: HubExtension) {
		if (ext.info.background === 'none' || ext.background) return;
		const background = ext.info.manifest.background ?? {};
		const path =
			ext.info.background === 'service_worker'
				? serviceWorkerPage(background.service_worker ?? '')
				: background.page
					? cleanPath(background.page)
					: BACKGROUND_PAGE;
		const frame = this.#frame(`${CONTEXT_NAME_PREFIX}background`);
		ext.background = frame;
		ext.backgroundReady = (async () => {
			frame.src = await this.#host.route(extensionURL(ext.info.id, path));
			this.#host.container().append(frame);
			await new Promise<void>((resolve) => {
				frame.addEventListener('load', () => resolve(), { once: true });
				setTimeout(resolve, 10_000);
			});
		})().catch((error) => {
			console.warn(
				`STomp: the background of ${ext.info.name} could not start:`,
				error,
			);
		});
	}

	#stopBackground(ext: HubExtension) {
		ext.background?.remove();
		ext.background = null;
		ext.backgroundReady = null;
	}

	#post(ext: HubExtension, message: Record<string, unknown>) {
		ext.bus.postMessage(message);
	}

	async #receive(ext: HubExtension, message: Record<string, unknown>) {
		if (message?.t === 'dnr-badge') {
			// declarativeNetRequest's action count (setExtensionActionOptions)
			const tabId = Number(message.tabId);
			const raw = { badgeText: String(message.text ?? '') };
			if (tabId < 0) Object.assign(ext.action, raw);
			else ext.tabAction.set(tabId, { ...ext.tabAction.get(tabId), ...raw });
			this.#host.notify({
				type: 'action',
				id: ext.info.id,
				...(tabId < 0 ? {} : { tabId }),
			});
			return;
		}
		if (message?.t === 'bye') {
			this.#subframes.delete(String(message.ctx));
			return;
		}
		if (message?.t !== 'hub') return;
		const reply = (value: unknown, error?: string) =>
			this.#post(ext, {
				t: 'hubr',
				id: message.id,
				to: message.from,
				...(error === undefined ? { value } : { error }),
			});
		try {
			reply(
				await this.#contextCall(
					ext,
					String(message.call),
					(message.args as unknown[]) ?? [],
					String(message.from ?? ''),
				),
			);
		} catch (error) {
			reply(undefined, error instanceof Error ? error.message : String(error));
		}
	}

	/** each tab as the feed told it: Chrome's status, top document and icon of it */
	#tabState = new Map<
		number,
		{ status: 'loading' | 'complete'; documentId: string; icon: string | null }
	>();
	/**
	 * the documents below a tab's top that an extension's content scripts
	 * reached, by the contexts that said hello from them (getAllFrames, their
	 * webNavigation events)
	 */
	#subframes = new Map<
		string,
		{
			tabId: number;
			frameId: number;
			url: string;
			documentId: string;
			ext: string;
		}
	>();

	/** a document's id as webNavigation gives it (32 upper-case hex digits) */
	static documentId(client: string): string {
		const hex = client.replace(/-/g, '').toUpperCase();
		if (/^[0-9A-F]{32}$/.test(hex)) return hex;
		let hash = 0x811c9dc5;
		let out = '';
		for (let round = 0; round < 4; round++) {
			for (let index = 0; index < client.length; index++)
				hash = Math.imul(hash ^ client.charCodeAt(index), 0x01000193) >>> 0;
			hash = Math.imul(hash ^ round, 0x01000193) >>> 0;
			out += hash.toString(16).toUpperCase().padStart(8, '0');
		}
		return out;
	}

	/** tell every extension (with `permission`, when one is needed) a chrome.* event */
	#broadcast(name: string, args: unknown[], permission?: string, url?: string) {
		for (const ext of this.#extensions.values())
			if (!permission || ext.info.permissions.includes(permission))
				this.#post(ext, {
					t: 'event',
					name,
					args,
					...(url === undefined ? {} : { url }),
				});
	}

	#navigation(
		tabId: number,
		frameId: number,
		url: string,
		documentId: string | null,
		more: Record<string, unknown> = {},
	): Record<string, unknown> {
		const top = this.#tabState.get(tabId)?.documentId;
		return {
			...(documentId ? { documentId } : {}),
			documentLifecycle: 'active',
			frameId,
			frameType: frameId === 0 ? 'outermost_frame' : 'sub_frame',
			...(frameId !== 0 && top ? { parentDocumentId: top } : {}),
			parentFrameId: frameId === 0 ? -1 : 0,
			processId: documentId ? tabId : -1,
			tabId,
			timeStamp: performance.timeOrigin + performance.now(),
			url,
			...more,
		};
	}

	/** a webNavigation event of a frame: the extensions that may see it */
	#webNavigation(
		name: string,
		details: Record<string, unknown>,
		only?: HubExtension,
	) {
		const event = `webNavigation.${name}`;
		if (only) {
			if (only.info.permissions.includes('webNavigation'))
				this.#post(only, {
					t: 'event',
					name: event,
					args: [details],
					url: details.url,
				});
		} else
			this.#broadcast(event, [details], 'webNavigation', String(details.url));
	}

	/** tabs.onUpdated: what changed, and the tab after it */
	async #updated(tabId: number, change: Record<string, unknown>) {
		if (!this.#extensions.size) return;
		let tab: Record<string, unknown>;
		try {
			tab = await this.#tab(tabId);
		} catch (error) {
			return;
		}
		this.#broadcast('tabs.onUpdated', [tabId, change, tab]);
	}

	/**
	 * What the host's frames did (framesAsTabs' feed): tabs' and
	 * webNavigation's events, in Chrome's order of them
	 */
	async tabEvent(given: TabEvent) {
		// an extension's page is at chrome-extension:// to the extensions, as in Chrome
		const event = { ...given } as TabEvent & { url?: string; icon?: string };
		if (event.url) event.url = displayExtensionURL(event.url);
		if (event.icon) event.icon = displayExtensionURL(event.icon);
		// one at a time: a tab's events come in the order they happened
		const run = async () => {
			if (event.e === 'removed') {
				this.#tabState.delete(event.tabId);
				for (const [key, frame] of this.#subframes)
					if (frame.tabId === event.tabId) this.#subframes.delete(key);
			}
			const tabId = event.tabId;
			switch (event.e) {
				case 'created': {
					if (!this.#extensions.size) return;
					let tab: Record<string, unknown>;
					try {
						tab = await this.#tab(tabId);
					} catch (error) {
						return;
					}
					this.#broadcast('tabs.onCreated', [
						{
							...tab,
							status: 'loading',
							url: '',
							title: '',
							...(event.url ? { pendingUrl: event.url } : {}),
						},
					]);
					return;
				}
				case 'activated':
					this.#broadcast('tabs.onActivated', [{ tabId, windowId: 1 }]);
					this.#broadcast('tabs.onHighlighted', [
						{ tabIds: [tabId], windowId: 1 },
					]);
					return;
				case 'removed':
					this.#broadcast('tabs.onRemoved', [
						tabId,
						{ isWindowClosing: false, windowId: 1 },
					]);
					return;
				case 'commit': {
					const documentId = ExtensionHub.documentId(event.client);
					this.#webNavigation(
						'onBeforeNavigate',
						this.#navigation(tabId, 0, event.url, null),
					);
					this.#tabState.set(tabId, {
						status: 'loading',
						documentId,
						icon: null,
					});
					for (const [key, frame] of this.#subframes)
						if (frame.tabId === tabId) this.#subframes.delete(key);
					await this.#updated(tabId, { status: 'loading', url: event.url });
					this.#webNavigation(
						'onCommitted',
						this.#navigation(tabId, 0, event.url, documentId, {
							transitionQualifiers: [],
							transitionType: event.transition,
						}),
					);
					if (event.title) await this.#updated(tabId, { title: event.title });
					return;
				}
				case 'complete': {
					const state = this.#tabState.get(tabId);
					if (!state || state.status === 'complete') return;
					state.status = 'complete';
					if (!this.#extensions.size) return;
					const tab = await this.#tab(tabId).catch(() => null);
					const url = String(tab?.url ?? '');
					for (const name of ['onDOMContentLoaded', 'onCompleted'])
						this.#webNavigation(
							name,
							this.#navigation(tabId, 0, url, state.documentId),
						);
					await this.#updated(tabId, { status: 'complete' });
					return;
				}
				case 'history': {
					const state = this.#tabState.get(tabId);
					const status = state?.status;
					if (state) state.status = 'loading';
					await this.#updated(tabId, { status: 'loading', url: event.url });
					this.#webNavigation(
						event.fragment
							? 'onReferenceFragmentUpdated'
							: 'onHistoryStateUpdated',
						this.#navigation(tabId, 0, event.url, state?.documentId ?? null, {
							transitionQualifiers: [],
							transitionType: 'link',
						}),
					);
					if (state) state.status = status ?? 'complete';
					if (status !== 'loading')
						await this.#updated(tabId, { status: 'complete' });
					return;
				}
				case 'title':
					await this.#updated(tabId, { title: event.title });
					return;
				case 'icon': {
					const state = this.#tabState.get(tabId);
					if (state) state.icon = event.icon;
					await this.#updated(tabId, { favIconUrl: event.icon });
					return;
				}
			}
		};
		const next = this.#tabEvents.then(run, run);
		this.#tabEvents = next.catch(() => {});
		return next;
	}
	#tabEvents: Promise<void> = Promise.resolve();

	/** a document below a tab's top said hello: its frame is known, and committed */
	#subframeHello(
		ext: HubExtension,
		from: string,
		place: { tabId: number; frameId: number },
		url: string,
		client: string,
	) {
		const documentId = ExtensionHub.documentId(client || from);
		this.#subframes.set(from, {
			tabId: place.tabId,
			frameId: place.frameId,
			url,
			documentId,
			ext: ext.info.id,
		});
		this.#webNavigation(
			'onBeforeNavigate',
			this.#navigation(place.tabId, place.frameId, url, null),
			ext,
		);
		this.#webNavigation(
			'onCommitted',
			this.#navigation(place.tabId, place.frameId, url, documentId, {
				transitionQualifiers: [],
				transitionType: 'auto_subframe',
			}),
			ext,
		);
	}

	/** webNavigation.getAllFrames: the tab's top, and the documents below it the extensions reached */
	async #frames(tabId: number): Promise<Record<string, unknown>[]> {
		const tab = await this.#tab(tabId);
		const state = this.#tabState.get(tabId);
		const frames: Record<string, unknown>[] = [
			this.#navigation(tabId, 0, String(tab.url), state?.documentId ?? null, {
				errorOccurred: false,
			}),
		];
		const seen = new Set<number>([0]);
		for (const frame of this.#subframes.values())
			if (frame.tabId === tabId && !seen.has(frame.frameId)) {
				seen.add(frame.frameId);
				frames.push(
					this.#navigation(tabId, frame.frameId, frame.url, frame.documentId, {
						errorOccurred: false,
					}),
				);
			}
		for (const frame of frames) delete frame.timeStamp;
		return frames;
	}

	async #tab(id: number): Promise<Record<string, unknown>> {
		const tabs = await this.#host.tabs.list();
		const index = tabs.findIndex((tab) => tab.id === id);
		if (index < 0) throw new Error(`No tab with id: ${id}.`);
		return this.#tabObject(tabs[index], index);
	}

	#tabObject(tab: HubTab, index: number): Record<string, unknown> {
		return {
			id: tab.id,
			index,
			windowId: 1,
			openerTabId: undefined,
			highlighted: tab.active,
			active: tab.active,
			pinned: false,
			audible: false,
			discarded: false,
			autoDiscardable: true,
			mutedInfo: { muted: false },
			// an extension's page is at chrome-extension://, as Chrome lists it
			url: displayExtensionURL(tab.url),
			title: tab.title,
			...(this.#tabState.get(tab.id)?.icon
				? { favIconUrl: displayExtensionURL(this.#tabState.get(tab.id)!.icon!) }
				: {}),
			status: this.#tabState.get(tab.id)?.status ?? tab.status ?? 'complete',
			incognito: false,
			width: innerWidth,
			height: innerHeight,
			groupId: -1,
			selected: tab.active,
		};
	}

	async #tabs(): Promise<Record<string, unknown>[]> {
		return (await this.#host.tabs.list()).map((tab, index) =>
			this.#tabObject(tab, index),
		);
	}

	async #activeTab(): Promise<number | null> {
		const tabs = await this.#host.tabs.list();
		return (tabs.find((tab) => tab.active) ?? tabs[0])?.id ?? null;
	}

	/** what the extension's contexts ask (over the bus) */
	async #contextCall(
		ext: HubExtension,
		call: string,
		args: unknown[],
		from: string,
	): Promise<unknown> {
		const tabs = this.#host.tabs;
		switch (call) {
			case 'hello': {
				const hello = (args[0] ?? {}) as {
					client?: string;
					url?: string;
					top?: boolean;
					name?: string;
					tabId?: number;
				};
				if (hello.name === 'background' || hello.name === 'offscreen')
					return { tabId: -1, frameId: -1, tab: null };
				if (hello.name === 'popup')
					return {
						tabId: hello.tabId ?? -1,
						frameId: -1,
						tab: null,
					};
				// a popup the host mounts (its frame is none of the tabs)
				const now = Date.now();
				ext.popups = ext.popups.filter(
					(popup) => now - popup.at < POPUP_WAIT_MS,
				);
				const popup = ext.popups.findIndex(
					(candidate) => candidate.url === hello.url,
				);
				if (popup >= 0 && hello.name !== 'content') {
					const [{ tabId }] = ext.popups.splice(popup, 1);
					return { tabId, frameId: -1, tab: null, kind: 'popup' };
				}
				// a document reports its client to the controller as it loads: a
				// script at document_start may ask before it did
				let place: { tabId: number; frameId: number } | null = null;
				for (let tries = 0; tries < 40 && !place; tries++) {
					place = hello.client ? await tabs.ofClient(hello.client) : null;
					if (!place) await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (!place) return { tabId: -1, frameId: -1, tab: null };
				let tab: Record<string, unknown> | null = null;
				try {
					tab = await this.#tab(place.tabId);
					if (place.frameId === 0 && hello.url)
						tab.url = displayExtensionURL(hello.url);
				} catch (error) {
					// a tab that just closed
				}
				if (place.frameId > 0 && hello.url)
					this.#subframeHello(
						ext,
						from,
						place,
						displayExtensionURL(hello.url),
						String(hello.client ?? ''),
					);
				return { ...place, tab };
			}
			case 'nav': {
				// a document below a tab's top: its DOMContentLoaded, its load
				const frame = this.#subframes.get(from);
				if (!frame) return undefined;
				this.#webNavigation(
					args[0] === 'load' ? 'onCompleted' : 'onDOMContentLoaded',
					this.#navigation(
						frame.tabId,
						frame.frameId,
						frame.url,
						frame.documentId,
					),
					ext,
				);
				return undefined;
			}
			case 'webNavigation.getAllFrames':
				return this.#frames(Number(args[0])).catch(() => null);
			case 'webNavigation.getFrame': {
				const [tabId, frameId, documentId] = args as [
					number | undefined,
					number | undefined,
					string | undefined,
				];
				const tabIds =
					typeof tabId === 'number'
						? [tabId]
						: (await this.#host.tabs.list()).map((tab) => tab.id);
				for (const id of tabIds) {
					const frames = await this.#frames(id).catch(() => []);
					const found = frames.find((frame) =>
						documentId
							? frame.documentId === documentId
							: frame.frameId === (frameId ?? 0),
					);
					if (found) {
						const details = { ...found };
						for (const key of ['frameId', 'tabId', 'processId'])
							delete details[key];
						return details;
					}
				}
				return null;
			}
			case 'wake':
				if (ext.info.background === 'none') return false;
				this.#startBackground(ext);
				await ext.backgroundReady;
				return true;
			case 'reload':
				this.#stopBackground(ext);
				this.#startBackground(ext);
				return undefined;
			case 'action.set': {
				const [tabId, patch] = args as [number | null, Record<string, unknown>];
				const raw: Partial<RawAction> = {};
				if ('title' in patch) raw.title = patch.title as string;
				if ('iconUrl' in patch) raw.icon = patch.iconUrl as string;
				if ('popup' in patch) raw.popup = patch.popup as string | null;
				for (const key of [
					'badgeText',
					'badgeColor',
					'badgeTextColor',
					'enabled',
				] as const)
					if (key in patch) (raw as Record<string, unknown>)[key] = patch[key];
				if (tabId === null) Object.assign(ext.action, raw);
				else ext.tabAction.set(tabId, { ...ext.tabAction.get(tabId), ...raw });
				this.#host.notify({
					type: 'action',
					id: ext.info.id,
					...(tabId === null ? {} : { tabId }),
				});
				return undefined;
			}
			case 'action.get': {
				const state = this.#rawAction(ext, args[0] as number | null);
				return {
					title: state.title,
					iconUrl: state.icon,
					popup: state.popup,
					badgeText: state.badgeText,
					badgeColor: state.badgeColor,
					badgeTextColor: state.badgeTextColor,
					enabled: state.enabled,
				};
			}
			case 'openPopup': {
				const tabId = await this.#activeTab();
				const state = this.#rawAction(ext, tabId);
				if (!state.popup)
					throw new Error('Could not find an active browser window.');
				this.#host.notify({
					type: 'action',
					id: ext.info.id,
					...(tabId === null ? {} : { tabId }),
					popup: true,
				} as ExtensionsChange);
				return undefined;
			}
			case 'openOptions': {
				if (!ext.info.optionsUrl)
					throw new Error('Could not create an options page.');
				await tabs.create(ext.info.optionsUrl, true);
				return undefined;
			}
			case 'tabs.query': {
				const info = (args[0] ?? {}) as Record<string, unknown>;
				return (await this.#tabs()).filter((tab) => {
					if (info.active !== undefined && tab.active !== info.active)
						return false;
					if (info.url !== undefined) {
						const patterns = Array.isArray(info.url) ? info.url : [info.url];
						if (
							!patterns.some((pattern) =>
								urlMatches(String(pattern), String(tab.url)),
							)
						)
							return false;
					}
					if (info.title !== undefined && tab.title !== info.title)
						return false;
					if (info.index !== undefined && tab.index !== info.index)
						return false;
					return true;
				});
			}
			case 'tabs.get':
				return this.#tab(Number(args[0]));
			case 'tabs.active': {
				const id = await this.#activeTab();
				return id === null ? null : this.#tab(id);
			}
			case 'tabs.ofClient':
				return tabs.ofClient(String(args[0]));
			case 'tabs.create': {
				const props = (args[0] ?? {}) as { url?: string; active?: boolean };
				const id = await tabs.create(
					resolveExtensionURL(String(props.url ?? 'about:blank')),
					props.active !== false,
				);
				if (id === null) throw new Error('Tabs cannot be created here.');
				return this.#tab(id).catch(() => ({ id, url: props.url, windowId: 1 }));
			}
			case 'tabs.update': {
				const [id, props] = args as [
					number,
					{ url?: string; active?: boolean },
				];
				if (typeof props?.url === 'string')
					await tabs.navigate(id, resolveExtensionURL(props.url));
				if (props?.active) await tabs.activate(id);
				return this.#tab(id);
			}
			case 'tabs.remove':
				for (const id of Array.isArray(args[0]) ? args[0] : [args[0]])
					await tabs.close(Number(id));
				return undefined;
			case 'tabs.reload':
				return tabs.reload(Number(args[0]));
			case 'tabs.back':
				return tabs.back(Number(args[0]));
			case 'tabs.forward':
				return tabs.forward(Number(args[0]));
			case 'windows.get':
				return {
					id: 1,
					focused: true,
					top: 0,
					left: 0,
					width: innerWidth,
					height: innerHeight,
					incognito: false,
					type: 'normal',
					state: 'normal',
					alwaysOnTop: false,
					...(args[0] ? { tabs: await this.#tabs() } : {}),
				};
			case 'popup.size':
				this.#host.notify({
					type: 'action',
					id: ext.info.id,
					popupSize: args[0],
				} as ExtensionsChange);
				return undefined;
			case 'popup.close':
				this.#host.notify({
					type: 'action',
					id: ext.info.id,
					popupClosed: true,
				} as ExtensionsChange);
				return undefined;
			case 'offscreen.create': {
				if (ext.offscreen)
					throw new Error('Only a single offscreen document may be created.');
				const frame = this.#frame(`${CONTEXT_NAME_PREFIX}offscreen`);
				ext.offscreen = frame;
				frame.src = await this.#host.route(
					extensionURL(ext.info.id, String(args[0] ?? '')),
				);
				this.#host.container().append(frame);
				await new Promise<void>((resolve) => {
					frame.addEventListener('load', () => resolve(), { once: true });
					setTimeout(resolve, 10_000);
				});
				return undefined;
			}
			case 'offscreen.close':
				if (!ext.offscreen) throw new Error('No current offscreen document.');
				ext.offscreen.remove();
				ext.offscreen = null;
				return undefined;
			case 'offscreen.has':
				return !!ext.offscreen;
			case 'notify': {
				const [id, options, update] = args as [
					string,
					Record<string, unknown>,
					boolean?,
				];
				if (update && !ext.notifications.has(id)) return false;
				const notification = {
					...(update ? ext.notifications.get(id) : {}),
					...options,
					id,
				} as ExtensionNotification;
				if (
					typeof notification.iconUrl === 'string' &&
					!/^(data|blob):/.test(notification.iconUrl)
				)
					notification.iconUrl = await this.#host.route(
						resolveExtensionURL(
							new URL(
								notification.iconUrl,
								`${ext.info.id ? extensionURL(ext.info.id) : ''}`,
							).href,
						),
					);
				ext.notifications.set(id, notification);
				this.#host.notify({
					type: 'notification',
					id: ext.info.id,
					notification,
				});
				return update ? true : id;
			}
			case 'notify.clear': {
				const id = String(args[0]);
				const had = ext.notifications.delete(id);
				if (had)
					this.#host.notify({
						type: 'notification',
						id: ext.info.id,
						notification: { id, cleared: true },
					});
				return had;
			}
			case 'notify.all':
				return Object.fromEntries(
					[...ext.notifications.keys()].map((id) => [id, true]),
				);
			case 'menus.set': {
				const [id, properties] = args as [string, Record<string, unknown>];
				ext.menus.set(id, { ...ext.menus.get(id), ...properties, id });
				this.#host.notify({ type: 'menus', id: ext.info.id });
				return undefined;
			}
			case 'menus.remove':
				if (args[0] === null) ext.menus.clear();
				else ext.menus.delete(String(args[0]));
				this.#host.notify({ type: 'menus', id: ext.info.id });
				return undefined;
			default:
				throw new Error(`${call} is not something the hub answers.`);
		}
	}

	#rawAction(ext: HubExtension, tabId: number | null): RawAction {
		return tabId === null
			? ext.action
			: ({ ...ext.action, ...ext.tabAction.get(tabId) } as RawAction);
	}

	#found(id: string): HubExtension {
		const ext = this.#extensions.get(id);
		if (!ext)
			throw new ExtensionError(
				'not-found',
				`No enabled extension with id ${id} is installed.`,
			);
		return ext;
	}

	/** the action as the host shows it: its manifest's defaults, then what the extension set */
	async actionState(id: string, tabId: number | null): Promise<ActionState> {
		const ext = this.#found(id);
		const raw = this.#rawAction(ext, tabId);
		const manifest = ext.info.manifest;
		const declared =
			manifest.action ?? manifest.browser_action ?? manifest.page_action;
		const popup =
			raw.popup === null ? (declared?.default_popup ?? null) : raw.popup;
		const icon = raw.icon ?? ext.info.iconUrl;
		return {
			title: raw.title ?? declared?.default_title ?? ext.info.name,
			iconUrl:
				icon && !/^(data|blob):/.test(icon)
					? await this.#host.route(icon)
					: icon,
			badgeText: raw.badgeText,
			badgeColor: raw.badgeColor,
			badgeTextColor: raw.badgeTextColor,
			popupUrl: popup ? extensionURL(id, popup.replace(/^\/+/, '')) : null,
			enabled: raw.enabled && (!manifest.page_action || raw.enabled),
		};
	}

	async actions(tabId: number | null): Promise<ExtensionAction[]> {
		await this.ready;
		const rows: ExtensionAction[] = [];
		for (const ext of this.#extensions.values())
			if (ext.info.hasAction)
				rows.push({
					id: ext.info.id,
					name: ext.info.name,
					...(await this.actionState(ext.info.id, tabId)),
				});
		return rows;
	}

	/** a click on the toolbar button: the popup, or action.onClicked in the background */
	async click(id: string, tabId: number | null): Promise<ClickResult> {
		const ext = this.#found(id);
		const state = await this.actionState(id, tabId);
		if (!state.enabled) return 'disabled';
		// the click grants activeTab for the tab, until it navigates
		// (declarativeNetRequest's rules for the tab, as in Chrome)
		if (tabId !== null && ext.info.permissions.includes('activeTab'))
			await this.command({ op: 'grant', id, tabId }).catch(() => {});
		if (state.popupUrl) return 'popup';
		this.#startBackground(ext);
		await ext.backgroundReady;
		const tab =
			tabId === null ? null : await this.#tab(tabId).catch(() => null);
		const event =
			Number(ext.info.manifestVersion) >= 3
				? 'action.onClicked'
				: ext.info.manifest.page_action
					? 'pageAction.onClicked'
					: 'browserAction.onClicked';
		this.#post(ext, { t: 'event', name: event, args: [tab] });
		return 'clicked';
	}

	/** tell the extension's contexts a chrome.* event (notifications, menus) */
	dispatch(id: string, name: string, args: unknown[]) {
		this.#post(this.#found(id), { t: 'event', name, args });
	}

	/** the host mounts the extension's popup for a tab (see hello) */
	/** an extension is enabled (the controller's socket hooks ask the worker's rules then) */
	get any(): boolean {
		return this.#extensions.size > 0;
	}

	/**
	 * A tab's document is this client: the worker gives its requests that
	 * tab (declarativeNetRequest's tabIds, badges and matched rules)
	 */
	place(client: string, tabId: number) {
		const started = this.#started;
		this.ready.then(() => {
			if (started && this.#extensions.size)
				this.command({ op: 'place', client, tabId }).catch(() => {});
		});
	}

	/**
	 * The host sends a tab to `url` (a frame's go): its main frame's request
	 * is that tab's, before any document of it can say so
	 */
	expect(url: string, tabId: number) {
		const started = this.#started;
		this.ready.then(() => {
			if (started && this.#extensions.size)
				this.command({ op: 'expect', url, tabId }).catch(() => {});
		});
	}

	expectPopup(id: string, tabId: number | null, url: string) {
		this.#found(id).popups.push({ url, tabId: tabId ?? -1, at: Date.now() });
	}

	menus(id: string): Record<string, unknown>[] {
		return [...this.#found(id).menus.values()];
	}
}

function urlMatches(pattern: string, url: string): boolean {
	if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file):/.test(url);
	const parts = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)?$/.exec(pattern);
	if (!parts) return false;
	const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
	const scheme = parts[1] === '*' ? 'https?' : escape(parts[1]);
	const host =
		parts[2] === '*'
			? '[^/]*'
			: parts[2].startsWith('*.')
				? `(?:[^/]*\\.)?${escape(parts[2].slice(2))}`
				: escape(parts[2]);
	const path = (parts[3] ?? '/').split('*').map(escape).join('.*');
	return new RegExp(`^${scheme}:\\/\\/${host}(?::\\d+)?${path}$`).test(
		url.split('#')[0],
	);
}

// ---- the public API -------------------------------------------------------

/** what `controller.extensions` needs: the hub (local or over the frame's RPC) and routing */
export interface ExtensionsBackend {
	command<T>(command: ExtensionCommand, transfer?: Transferable[]): Promise<T>;
	actionState(id: string, tabId: number | null): Promise<ActionState>;
	actions(tabId: number | null): Promise<ExtensionAction[]>;
	click(id: string, tabId: number | null): Promise<ClickResult>;
	dispatch(id: string, name: string, args: unknown[]): Promise<void>;
	menus(id: string): Promise<Record<string, unknown>[]>;
	/** the popup of `url` the host mounts next is the extension's popup for the tab */
	expectPopup(id: string, tabId: number | null, url: string): Promise<void>;
	route(url: string): Promise<string>;
	/** the sandbox a popup's frame gets */
	sandbox: string | null;
	/** the tab the host shows now, when it says nothing else */
	activeTab(): number | null;
}

const isFileList = (value: unknown): value is FileList | File[] =>
	(typeof FileList !== 'undefined' && value instanceof FileList) ||
	(Array.isArray(value) && value.every((item) => item instanceof File));

async function bytesOf(value: unknown): Promise<ArrayBuffer> {
	if (value instanceof ArrayBuffer) return value.slice(0);
	if (ArrayBuffer.isView(value))
		return value.buffer.slice(
			value.byteOffset,
			value.byteOffset + value.byteLength,
		) as ArrayBuffer;
	if (value instanceof Blob) return value.arrayBuffer();
	if (typeof value === 'string')
		return new TextEncoder().encode(value).buffer as ArrayBuffer;
	throw new ExtensionError(
		'bad-source',
		'An unpacked file must be text, bytes or a Blob.',
	);
}

/** an install source as the worker's command */
export async function installCommand(
	source: ExtensionSource,
	options: InstallOptions = {},
): Promise<{ command: ExtensionCommand; transfer: Transferable[] }> {
	const common = {
		...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
		...(options.policy ? { policy: true } : {}),
	};
	if (typeof source === 'string') {
		const text = source.trim();
		if (!text)
			throw new ExtensionError(
				'bad-source',
				'An empty string names no extension.',
			);
		return {
			command: { op: 'install', webStore: text, ...common },
			transfer: [],
		};
	}
	if (
		source instanceof ArrayBuffer ||
		ArrayBuffer.isView(source) ||
		source instanceof Blob
	) {
		const bytes = await bytesOf(source);
		const filename =
			options.filename ?? (source instanceof File ? source.name : undefined);
		return {
			command: {
				op: 'install',
				bytes,
				...(filename ? { filename } : {}),
				...common,
			},
			transfer: [bytes],
		};
	}
	const files: Record<string, ArrayBuffer> = {};
	if (isFileList(source)) {
		for (const file of Array.from(source)) {
			const path = (file.webkitRelativePath || file.name).split('/');
			// a folder's files name the folder first
			const name = file.webkitRelativePath
				? path.slice(1).join('/')
				: path.join('/');
			files[name] = await file.arrayBuffer();
		}
	} else if (source && typeof source === 'object') {
		for (const [name, value] of Object.entries(source))
			files[name] = await bytesOf(value);
	} else
		throw new ExtensionError(
			'bad-source',
			"install() takes a .crx or .zip (bytes, Blob or File), a Web Store id or URL, or an unpacked extension's files.",
		);
	return {
		command: {
			op: 'install',
			files,
			...(options.filename ? { filename: options.filename } : {}),
			...common,
		},
		transfer: Object.values(files),
	};
}

const clamp = (value: number, low: number, high: number) =>
	Math.min(high, Math.max(low, Math.round(value)));

/**
 * `controller.extensions`: install, list and manage Chrome extensions, and
 * show their toolbar buttons and popups. Every call is promise-based and
 * rejects with an ExtensionError whose `code` says what went wrong.
 */
export class Extensions {
	#backend: ExtensionsBackend;
	#listeners = new Set<(change: ExtensionsChange) => void>();
	#popups = new Set<PopupController>();
	#prompt: ((prompt: ExtensionPrompt) => boolean | Promise<boolean>) | null =
		null;

	/** @internal */
	constructor(backend: ExtensionsBackend) {
		// every rejection is an ExtensionError with its code, however it came
		// (a RemoteController's over the controller frame's RPC carries only
		// a message)
		const coded =
			<A extends unknown[], T>(call: (...args: A) => Promise<T>) =>
			(...args: A) =>
				call(...args).catch((error: unknown) => {
					throw extensionErrorOf(error);
				});
		this.#backend = {
			...backend,
			command: coded(
				backend.command.bind(backend),
			) as ExtensionsBackend['command'],
			actionState: coded(backend.actionState.bind(backend)),
			actions: coded(backend.actions.bind(backend)),
			click: coded(backend.click.bind(backend)),
			dispatch: coded(backend.dispatch.bind(backend)),
			menus: coded(backend.menus.bind(backend)),
			expectPopup: coded(backend.expectPopup.bind(backend)),
		};
	}

	/** @internal the hub (or the controller frame) told a change */
	changed(change: ExtensionsChange) {
		const extra = change as ExtensionsChange & {
			popupSize?: { width: number; height: number };
			popupClosed?: boolean;
		};
		if (extra.popupSize || extra.popupClosed) {
			for (const popup of this.#popups)
				if (popup.id === change.id) {
					if (extra.popupSize) popup.resized(extra.popupSize);
					if (extra.popupClosed) popup.close();
				}
			return;
		}
		for (const listener of [...this.#listeners])
			try {
				listener(change);
			} catch (error) {
				console.error(error);
			}
	}

	/**
	 * Install an extension, or update it in place when one with its id is
	 * installed: a .crx (2 or 3) or .zip as bytes, a Blob or a File; a
	 * Chrome Web Store id or detail page URL (downloaded through the
	 * transport); or an unpacked extension's files (a path map, or the
	 * FileList of `<input webkitdirectory>`).
	 */
	async install(
		source: ExtensionSource,
		options: InstallOptions = {},
	): Promise<ExtensionInfo> {
		const { command, transfer } = await installCommand(source, options);
		return this.#backend.command<ExtensionInfo>(command, transfer);
	}

	/** every installed extension, oldest first */
	list(): Promise<ExtensionInfo[]> {
		return this.#backend.command<ExtensionInfo[]>({ op: 'list' });
	}

	/** one installed extension, or null */
	get(id: string): Promise<ExtensionInfo | null> {
		return this.#backend.command<ExtensionInfo | null>({ op: 'get', id });
	}

	enable(id: string): Promise<ExtensionInfo> {
		return this.#backend.command<ExtensionInfo>({
			op: 'enable',
			id,
			enabled: true,
		});
	}

	disable(id: string): Promise<ExtensionInfo> {
		return this.#backend.command<ExtensionInfo>({
			op: 'enable',
			id,
			enabled: false,
		});
	}

	/** uninstall: its files, its storage and its state go */
	async remove(id: string): Promise<void> {
		await this.#backend.command({ op: 'remove', id });
	}

	/** download it again from the Chrome Web Store (one installed from there) */
	update(id: string): Promise<ExtensionInfo> {
		return this.#backend.command<ExtensionInfo>({ op: 'update', id });
	}

	/**
	 * Show Chrome's dialog when the Chrome Web Store's page asks to install
	 * an extension ("Add to Chrome") or to remove one ("Remove from
	 * Chrome"): the handler draws it and answers true for its accept
	 * button (Add extension, Remove). The page asked on a click of its own
	 * button, and the worker made the request (the name, the icon, Chrome's
	 * permission warnings) and checked the page is the store's. Without a
	 * handler the store's install and removal end as cancelled. Returns the
	 * unsubscribe.
	 */
	onPrompt(
		handler: (prompt: ExtensionPrompt) => boolean | Promise<boolean>,
	): () => void {
		this.#prompt = handler;
		return () => {
			if (this.#prompt === handler) this.#prompt = null;
		};
	}

	/** @internal the store's page asked (the controller checked the user's click) */
	async prompt(
		request: ExtensionPromptRequest,
		frame: unknown,
	): Promise<ExtensionPromptAnswer> {
		const handler = this.#prompt;
		if (!handler) return 'cancel';
		const { kind, id, name, iconUrl, permissions, url } = request;
		try {
			return (await handler({
				kind,
				id,
				name,
				iconUrl,
				permissions,
				url,
				frame: frame ?? null,
			})) === true
				? 'accept'
				: 'cancel';
		} catch (error) {
			console.error(error);
			return 'cancel';
		}
	}

	/** hear installs, updates, removals, action and menu changes, notifications; returns the unsubscribe */
	onChange(listener: (change: ExtensionsChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** the toolbar button of one extension, for a tab (its defaults without one) */
	action(
		id: string,
		tabId: number | null = this.#backend.activeTab(),
	): Promise<ActionState> {
		return this.#backend.actionState(id, tabId);
	}

	/** every enabled extension's toolbar button, for a tab */
	actions(
		tabId: number | null = this.#backend.activeTab(),
	): Promise<ExtensionAction[]> {
		return this.#backend.actions(tabId);
	}

	/**
	 * What Chrome does on a click of the button: `popup` when the extension
	 * has one (show it with `openPopup` or `mountPopup`), `clicked` once
	 * action.onClicked went to its background, `disabled` when it is off
	 */
	clickAction(
		id: string,
		tabId: number | null = this.#backend.activeTab(),
	): Promise<ClickResult> {
		return this.#backend.click(id, tabId);
	}

	/**
	 * Show the extension's popup in an element of the host's (an iframe it
	 * placed): sized as the popup's document asks, clamped as Chrome clamps
	 * it, closed when the popup calls window.close()
	 */
	async mountPopup(
		id: string,
		element: HTMLIFrameElement,
		tabId: number | null = this.#backend.activeTab(),
	): Promise<PopupHandle> {
		const state = await this.#backend.actionState(id, tabId);
		if (!state.popupUrl)
			throw new ExtensionError(
				'no-popup',
				`The extension ${id} has no popup for this tab.`,
			);
		const popup = new PopupController(id, tabId, element, false, () =>
			this.#popups.delete(popup),
		);
		this.#popups.add(popup);
		element.name = `${CONTEXT_NAME_PREFIX}popup:${tabId ?? -1}`;
		// (the frame's name does not always reach its document: the hub knows it by its URL)
		await this.#backend.expectPopup(id, tabId, state.popupUrl);
		if (this.#backend.sandbox !== null)
			element.setAttribute('sandbox', this.#backend.sandbox);
		element.src = await this.#backend.route(state.popupUrl);
		return popup;
	}

	/**
	 * Click the button and show what it opens: a popup in a new iframe the
	 * runtime places at `at` (an element to anchor under, or a point),
	 * appended to `parent` (default: the document's body). Null when the
	 * click went to the background instead.
	 */
	async openPopup(
		id: string,
		options: {
			tabId?: number | null;
			parent?: HTMLElement;
			at?: HTMLElement | { x: number; y: number };
		} = {},
	): Promise<PopupHandle | null> {
		const tabId =
			options.tabId === undefined ? this.#backend.activeTab() : options.tabId;
		const result = await this.#backend.click(id, tabId);
		if (result !== 'popup') return null;
		const element = document.createElement('iframe');
		element.style.cssText =
			'position:fixed;z-index:2147483647;border:0;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.3);background:#fff;width:25px;height:25px';
		const at = options.at;
		if (at instanceof HTMLElement) {
			const box = at.getBoundingClientRect();
			element.style.left = `${Math.max(0, box.right - 25)}px`;
			element.style.top = `${box.bottom + 4}px`;
		} else if (at) {
			element.style.left = `${at.x}px`;
			element.style.top = `${at.y}px`;
		} else {
			element.style.right = '8px';
			element.style.top = '8px';
		}
		(options.parent ?? document.body).append(element);
		const popup = await this.mountPopup(id, element, tabId);
		(popup as PopupController).owned = true;
		popup.onResize((size) => {
			element.style.width = `${size.width}px`;
			element.style.height = `${size.height}px`;
			if (at instanceof HTMLElement) {
				const box = at.getBoundingClientRect();
				element.style.left = `${Math.max(0, Math.min(innerWidth - size.width, box.right - size.width))}px`;
			}
		});
		return popup;
	}

	/** the extension's options page: navigate a frame to `url` */
	async options(id: string): Promise<ExtensionOptions> {
		const info = await this.get(id);
		if (!info)
			throw new ExtensionError(
				'not-found',
				`No extension with id ${id} is installed.`,
			);
		if (!info.optionsUrl)
			throw new ExtensionError('no-popup', `${info.name} has no options page.`);
		return {
			url: info.optionsUrl,
			displayUrl: displayExtensionURL(info.optionsUrl),
			openInTab:
				!info.manifest.options_ui ||
				info.manifest.options_ui.open_in_tab === true,
		};
	}

	/** an extension URL as an address bar shows it: `chrome-extension://<id>/...` */
	displayUrl(url: string): string {
		return displayExtensionURL(url);
	}

	/** `chrome-extension://<id>/...` as the URL a frame navigates to (`frame.go`); any other URL as it is */
	resolveUrl(url: string): string {
		return resolveExtensionURL(url);
	}

	/** the extension a URL belongs to, or null */
	extensionOf(url: string): string | null {
		return extensionOfURL(url);
	}

	/** an extension's context menu items, as it created them */
	menus(id: string): Promise<Record<string, unknown>[]> {
		return this.#backend.menus(id);
	}

	/** tell the extension its menu item was clicked (contextMenus.onClicked) */
	async clickMenu(
		id: string,
		info: Record<string, unknown>,
		tabId: number | null = this.#backend.activeTab(),
	) {
		await this.#backend.dispatch(id, 'contextMenus.onClicked', [
			info,
			tabId === null ? undefined : { id: tabId },
		]);
	}

	/** tell the extension the user clicked (or closed) one of its notifications */
	async notificationEvent(
		id: string,
		notificationId: string,
		event: 'clicked' | 'closed' | 'buttonClicked',
		buttonIndex?: number,
	) {
		await this.#backend.dispatch(
			id,
			event === 'clicked'
				? 'notifications.onClicked'
				: event === 'closed'
					? 'notifications.onClosed'
					: 'notifications.onButtonClicked',
			event === 'buttonClicked'
				? [notificationId, buttonIndex ?? 0]
				: [notificationId, ...(event === 'closed' ? [true] : [])],
		);
	}
}

class PopupController implements PopupHandle {
	size: { width: number; height: number } | null = null;
	owned = false;
	#resize = new Set<(size: { width: number; height: number }) => void>();
	#close = new Set<() => void>();
	#closed = false;
	constructor(
		readonly id: string,
		readonly tabId: number | null,
		readonly element: HTMLIFrameElement,
		owned: boolean,
		readonly forget: () => void,
	) {
		this.owned = owned;
	}
	resized(size: { width: number; height: number }) {
		if (this.#closed) return;
		this.size = {
			width: clamp(size.width, 25, 800),
			height: clamp(size.height, 25, 600),
		};
		for (const listener of this.#resize) listener(this.size);
	}
	onResize(listener: (size: { width: number; height: number }) => void) {
		this.#resize.add(listener);
		if (this.size) listener(this.size);
	}
	onClose(listener: () => void) {
		this.#close.add(listener);
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.forget();
		this.element.src = 'about:blank';
		if (this.owned) this.element.remove();
		for (const listener of this.#close) listener();
	}
}
