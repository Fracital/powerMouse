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
import { packExtension } from '../extensions/pack';
import {
	BACKGROUND_PAGE,
	CONTEXT_NAME_PREFIX,
	ExtensionError,
	serviceWorkerPage,
	type ActionState,
	type ClickResult,
	type CommandResult,
	type ExtensionAction,
	type ExtensionCommand,
	type ExtensionErrorCode,
	type ExtensionErrorEntry,
	type ExtensionInfo,
	type ExtensionMenuEntry,
	type ExtensionNotification,
	type ExtensionOptions,
	type ExtensionPrompt,
	type ExtensionPromptAnswer,
	type ExtensionPromptRequest,
	type ExtensionsChange,
	type ExtensionShortcut,
	type ExtensionSource,
	type ExtensionView,
	type InstallOptions,
	type PackResult,
	type PopupHandle,
	type SiteInteraction,
	type ThemeImageFile,
	type ThemeInfo,
	type ThemePayload,
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

/**
 * What the extension set of its action, for every tab or for one (null:
 * not set, the manifest's or Chrome's default). Its colors are as it gave
 * them (transparent is Chrome's default)
 */
interface RawAction {
	title: string | null;
	/** its icon by size (setIcon) */
	icons: Record<string, string> | null;
	popup: string | null;
	badgeText: string;
	badgeColor: string | null;
	badgeTextColor: string | null;
	/** shown (enable/show), hidden (disable/hide), or the default */
	enabled: boolean | null;
}

const DEFAULT_ACTION = (): RawAction => ({
	title: null,
	icons: null,
	popup: null,
	badgeText: '',
	badgeColor: null,
	badgeTextColor: null,
	enabled: null,
});

/** a declarativeContent rule's conditions and actions, as the extension added them */
interface ContentRule {
	id: string;
	priority?: number;
	conditions?: Record<string, unknown>[];
	actions?: Record<string, unknown>[];
}

/** Chrome's own strings of the extensions' menus (generated_resources.grd, en-US) */
const MENU_TEXT = {
	options: 'Options',
	remove: (browser: string) => `Remove from ${browser}`,
	policy: 'Installed by your administrator',
	pin: 'Pin',
	unpin: 'Unpin',
	manage: 'Manage extension',
	permissions: 'View web permissions',
	inspect: 'Inspect popup',
	cantAccess: "Can't read or change site's data",
	access: 'This can read and change site data',
	onClick: 'When you click the extension',
	onSite: (site: string) => `On ${site}`,
	onAll: 'On all sites',
	learnMore: 'Learn more about site access',
	wantsAccess: 'Wants access to this site',
	hasAccess: 'Has access to this site',
};
/** where "Learn more about site access" leads */
const SITE_ACCESS_HELP =
	'https://support.google.com/chrome?p=enable_extensions';
/** an action menu shows this many of the extension's own items at its top level (ACTION_MENU_TOP_LEVEL_LIMIT) */
const ACTION_MENU_LIMIT = 6;
/** a menu item's title is cut to this many characters (kMaxExtensionItemTitleLength) */
const MENU_TITLE_MAX = 75;
/** how long action.openPopup() waits for its popup (browserAction's 10 s) */
const OPEN_POPUP_WAIT_MS = 10_000;
/** the Chrome Web Store's host: no extension may read or change it */
const STORE_SITE = 'chromewebstore.google.com';

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
	/** its pages open now, by context, as they announced themselves (views()) */
	pages: Map<string, { kind: string; url: string }>;
	/** the contexts of its popups that are open now */
	openPopups: Set<string>;
	/** action.openPopup() calls waiting for their popup to say hello */
	popupWaiters: Set<() => void>;
	/** the tabs a click (or a command) granted it, until they navigate */
	grantedTabs: Set<number>;
	/** the tabs where scripts of its wait for a click (site access withheld) */
	blockedTabs: Set<number>;
	/** its declarativeContent rules (null until the worker gave them) */
	contentRules: ContentRule[] | null;
	/** what the rules show and set on each tab, by its URL as they last judged it */
	contentState: Map<
		number,
		{ show: boolean; icons: Record<string, string> | null }
	>;
}

/** the commands after which the hub reads the list again: what is installed or on changed */
const LISTED_AFTER = new Set<string>([
	'install',
	'enable',
	'remove',
	'update',
	'reload',
]);

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
	/**
	 * settles once the hub listed the extensions the first time (start):
	 * until then it knows none, whatever the worker has installed
	 */
	ready: Promise<void>;
	#settleReady!: { resolve: () => void; reject: (error: unknown) => void };

	constructor(host: HubHost) {
		this.#host = host;
		this.ready = new Promise<void>((resolve, reject) => {
			this.#settleReady = { resolve, reject };
		});
		this.ready.catch(() => {});
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
		this.refresh().then(
			() => {
				this.#settleReady.resolve();
				this.#host.notify({ type: 'ready' });
			},
			(error) => this.#settleReady.reject(error),
		);
		return this.ready;
	}

	/** the controller could not start: what waits for the first list fails with it */
	fail(error: unknown) {
		if (!this.#started) this.#settleReady.reject(error);
	}

	/**
	 * The extensions as the worker lists them now: the hub's first list and
	 * any read again in flight (a change another context made, which the
	 * worker told every hub of) are in before an id is looked up, so a
	 * button or a row the host drew from the worker's list is one the hub
	 * knows
	 */
	async #listed(): Promise<void> {
		await this.ready;
		await this.#refreshing;
	}

	async command<T>(
		command: ExtensionCommand,
		transfer?: Transferable[],
	): Promise<T> {
		let result: T;
		try {
			result = (await this.#host.command(command, transfer)) as T;
		} catch (error) {
			throw extensionErrorOf(error);
		}
		// a change of what is installed or on: the hub reads the list before
		// its caller hears of it, so the caller's next call finds it (the
		// worker's message to the hubs may come after the answer)
		if (LISTED_AFTER.has(command.op)) await this.refresh().catch(() => {});
		return result;
	}

	/** read the list again: open the buses of new ones, start their backgrounds */
	refresh(): Promise<void> {
		const run = async () => {
			const list = await this.command<ExtensionInfo[]>({ op: 'list' });
			const seen = new Set<string>();
			for (const info of list) {
				// (a theme has nothing the hub runs: themes.ts)
				if (info.type === 'theme') continue;
				seen.add(info.id);
				const known = this.#extensions.get(info.id);
				if (!info.enabled) {
					if (known) this.#drop(known);
					continue;
				}
				if (known) {
					const updated = known.info.updatedAt !== info.updatedAt;
					const pinned = known.info.pinned !== info.pinned;
					known.info = info;
					// (Chrome tells the extension, no user gesture with it)
					if (pinned && Number(info.manifestVersion) >= 3)
						this.#post(known, {
							t: 'event',
							name: 'action.onUserSettingsChanged',
							args: [{ isOnToolbar: info.pinned }],
						});
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
					pages: new Map(),
					openPopups: new Set(),
					popupWaiters: new Set(),
					grantedTabs: new Set(),
					blockedTabs: new Set(),
					contentRules: null,
					contentState: new Map(),
				};
				ext.bus.onmessage = (event) => this.#receive(ext, event.data);
				this.#extensions.set(info.id, ext);
				// (pages open from before, a controller's reload: they say who they are again)
				this.#post(ext, { t: 'roll' });
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
			ext.pages.delete(String(message.ctx));
			if (ext.openPopups.delete(String(message.ctx)))
				this.#host.notify({ type: 'action', id: ext.info.id });
			return;
		}
		if (message?.t === 'presence') {
			const presence = message.p as { ctx: string; kind: string; url: string };
			if (presence?.kind !== 'content')
				ext.pages.set(String(presence.ctx), {
					kind: String(presence.kind),
					url: String(presence.url),
				});
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
				this.#forgetTab(event.tabId);
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
					// a new document: what the extensions set for the tab goes
					// (ExtensionAction::ClearAllValuesForTab), its grants too
					this.#forgetTab(tabId);
					this.#judgeContent(tabId, event.url);
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
					this.#judgeContent(tabId, event.url);
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
				if (hello.name === 'popup') {
					this.#popupOpened(ext, from);
					return {
						tabId: hello.tabId ?? -1,
						frameId: -1,
						tab: null,
					};
				}
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
					this.#popupOpened(ext, from);
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
				if ('icons' in patch)
					raw.icons = patch.icons as Record<string, string> | null;
				else if ('iconUrl' in patch)
					raw.icons = { 16: String(patch.iconUrl), 32: String(patch.iconUrl) };
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
				const declared = this.#declared(ext);
				return {
					title: state.title ?? declared?.default_title ?? ext.info.name,
					popup:
						state.popup ??
						(declared?.default_popup
							? cleanPath(declared.default_popup)
							: null),
					badgeText: state.badgeText,
					badgeColor: state.badgeColor,
					badgeTextColor: state.badgeTextColor,
					enabled: this.#visible(ext, args[0] as number | null),
				};
			}
			case 'openPopup': {
				// Chrome's checks, in its order and words (ActionOpenPopupFunction)
				if (!ext.info.hasAction)
					throw new Error('This extension has no action specified.');
				const options = (args[0] ?? {}) as { windowId?: number };
				if (
					options.windowId !== undefined &&
					options.windowId !== null &&
					options.windowId !== 1 &&
					options.windowId !== -2
				)
					throw new Error(`No window with id: ${options.windowId}.`);
				const tabId = await this.#activeTab();
				if (tabId === null)
					throw new Error('Could not find an active browser window.');
				// (declarativeContent's visibility does not count here)
				if (!(await this.actionState(ext.info.id, tabId)).popupUrl)
					throw new Error('Extension does not have a popup on the active tab.');
				for (const other of this.#extensions.values())
					if (other.openPopups.size) throw new Error('Failed to open popup.');
				const shown = new Promise<boolean>((resolve) => {
					const done = () => {
						ext.popupWaiters.delete(done);
						clearTimeout(timer);
						resolve(true);
					};
					const timer = setTimeout(() => {
						ext.popupWaiters.delete(done);
						resolve(false);
					}, OPEN_POPUP_WAIT_MS);
					ext.popupWaiters.add(done);
				});
				this.#host.notify({
					type: 'popup',
					id: ext.info.id,
					tabId,
					popup: true,
				});
				if (!(await shown)) throw new Error('Failed to open popup.');
				return undefined;
			}
			case 'action.settings':
				return { isOnToolbar: ext.info.pinned };
			case 'action.blocked': {
				// a document's scripts wait for a click on the button
				const tabId = Number(args[0]);
				if (tabId >= 0 && !ext.blockedTabs.has(tabId)) {
					ext.blockedTabs.add(tabId);
					this.#host.notify({ type: 'action', id: ext.info.id, tabId });
				}
				return undefined;
			}
			case 'content.rules': {
				// declarativeContent.onPageChanged's addRules, removeRules, getRules
				const [op, given] = args as [string, unknown];
				const rules = await this.#contentRules(ext);
				if (op === 'get') {
					const ids = Array.isArray(given) ? given.map(String) : null;
					return ids ? rules.filter((rule) => ids.includes(rule.id)) : rules;
				}
				let next: ContentRule[];
				let answer: unknown;
				if (op === 'add') {
					const added = (Array.isArray(given) ? given : []).map(
						(rule: ContentRule, index) => ({
							...rule,
							id: String(rule?.id ?? `_${Date.now().toString(36)}${index}_`),
							priority: Number(rule?.priority ?? 100),
						}),
					);
					const ids = new Set(added.map((rule) => rule.id));
					next = [...rules.filter((rule) => !ids.has(rule.id)), ...added];
					answer = added;
				} else {
					const ids = Array.isArray(given) ? given.map(String) : null;
					next = ids ? rules.filter((rule) => !ids.includes(rule.id)) : [];
				}
				ext.contentRules = next;
				await this.command({
					op: 'contentRules',
					id: ext.info.id,
					rules: next as unknown as Record<string, unknown>[],
				});
				for (const tab of await this.#host.tabs.list())
					this.#judgeContent(tab.id, tab.url, ext);
				return answer;
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

	#declared(ext: HubExtension) {
		const manifest = ext.info.manifest;
		return manifest.action ?? manifest.browser_action ?? manifest.page_action;
	}

	#popupOpened(ext: HubExtension, from: string) {
		ext.openPopups.add(from);
		for (const done of [...ext.popupWaiters]) done();
	}

	/** a tab's new document (or its close): what the extensions set for it, and their grants, go */
	#forgetTab(tabId: number) {
		for (const ext of this.#extensions.values()) {
			const had = [
				ext.tabAction.delete(tabId),
				ext.grantedTabs.delete(tabId),
				ext.blockedTabs.delete(tabId),
			].some(Boolean);
			if (had) this.#host.notify({ type: 'action', id: ext.info.id, tabId });
		}
	}

	async #contentRules(ext: HubExtension): Promise<ContentRule[]> {
		if (!ext.contentRules)
			ext.contentRules = await this.command<ContentRule[]>({
				op: 'contentRules',
				id: ext.info.id,
			}).catch(() => []);
		return ext.contentRules;
	}

	/**
	 * declarativeContent: whether a rule's conditions hold for the tab's
	 * page, judged by its URL (PageStateMatcher's pageUrl; its css and
	 * isBookmarked conditions are not judged, and do not hold), and what
	 * its actions show and set there
	 */
	#judgeContent(tabId: number, url: string, only?: HubExtension) {
		for (const ext of only ? [only] : this.#extensions.values()) {
			if (!ext.info.permissions.includes('declarativeContent')) continue;
			const judge = async () => {
				const rules = await this.#contentRules(ext);
				let show = false;
				let icons: Record<string, string> | null = null;
				const shown = displayExtensionURL(url);
				for (const rule of [...rules].sort(
					(a, b) => Number(a.priority ?? 100) - Number(b.priority ?? 100),
				)) {
					const holds = (rule.conditions ?? []).some(
						(condition) =>
							!condition.css &&
							!condition.isBookmarked &&
							pageUrlMatches(
								(condition.pageUrl ?? {}) as Record<string, unknown>,
								shown,
							),
					);
					if (!holds) continue;
					for (const action of rule.actions ?? []) {
						const type = String(action.instanceType ?? '');
						if (/Show(Page)?Action$/.test(type)) show = true;
						else if (/SetIcon$/.test(type) && action.icons)
							icons = action.icons as Record<string, string>;
					}
				}
				const before = ext.contentState.get(tabId);
				if (show || icons) ext.contentState.set(tabId, { show, icons });
				else ext.contentState.delete(tabId);
				if (
					!!before?.show !== show ||
					JSON.stringify(before?.icons ?? null) !== JSON.stringify(icons)
				)
					this.#host.notify({ type: 'action', id: ext.info.id, tabId });
			};
			judge().catch(() => {});
		}
	}

	/** visible on the tab (GetIsVisible): its tab value, then declarativeContent's, then its default */
	#visible(ext: HubExtension, tabId: number | null): boolean {
		const own = tabId === null ? undefined : ext.tabAction.get(tabId)?.enabled;
		if (typeof own === 'boolean') return own;
		if (tabId !== null && ext.contentState.get(tabId)?.show) return true;
		if (typeof ext.action.enabled === 'boolean') return ext.action.enabled;
		// a page action starts hidden, a browser action (and MV3's) shown
		return !ext.info.manifest.page_action || !!ext.info.manifest.action;
	}

	/** whether the extension asks for the site of `url` (its requested hosts) */
	#wants(ext: HubExtension, url: string): boolean {
		return ext.info.requestedHosts.some((pattern) => urlMatches(pattern, url));
	}

	/** how the extension stands with the tab's site (SitePermissionsHelper::GetSiteInteraction) */
	async #siteInteraction(
		ext: HubExtension,
		tabId: number | null,
	): Promise<{ interaction: SiteInteraction; url: string | null }> {
		const url =
			tabId === null
				? null
				: String((await this.#tab(tabId).catch(() => null))?.url ?? '');
		if (tabId === null || !url || restrictedURL(url))
			return { interaction: 'none', url };
		if (ext.grantedTabs.has(tabId)) return { interaction: 'granted', url };
		if (this.#wants(ext, url)) {
			const access = ext.info.siteAccess;
			const granted = !access.withheld || siteListed(access.sites, url);
			return { interaction: granted ? 'granted' : 'withheld', url };
		}
		if (ext.blockedTabs.has(tabId)) return { interaction: 'withheld', url };
		if (ext.info.permissions.includes('activeTab'))
			return { interaction: 'activeTab', url };
		return { interaction: 'none', url };
	}

	/** the action as the host shows it: its manifest's defaults, then what the extension set */
	async actionState(id: string, tabId: number | null): Promise<ActionState> {
		await this.#listed();
		const ext = this.#found(id);
		if (
			ext.contentRules === null &&
			tabId !== null &&
			ext.info.permissions.includes('declarativeContent')
		) {
			await this.#contentRules(ext);
			const tab = await this.#tab(tabId).catch(() => null);
			if (tab) this.#judgeContent(tabId, String(tab.url), ext);
		}
		const raw = this.#rawAction(ext, tabId);
		const declared = this.#declared(ext);
		const popup =
			raw.popup === null ? (declared?.default_popup ?? null) : raw.popup;
		// the icon: the tab's setIcon, declarativeContent's SetIcon, the
		// extension's setIcon, its manifest's; at 16 pixels, 32 on a 2x screen
		const tabIcons =
			tabId === null ? undefined : ext.tabAction.get(tabId)?.icons;
		const icons =
			tabIcons ??
			(tabId === null ? null : ext.contentState.get(tabId)?.icons) ??
			ext.action.icons ??
			ext.info.actionIcons;
		const size =
			typeof devicePixelRatio === 'number' && devicePixelRatio > 1 ? 32 : 16;
		const icon = icons ? pickIconSize(icons, size) : null;
		const { interaction } = await this.#siteInteraction(ext, tabId);
		const visible = this.#visible(ext, tabId);
		const title = raw.title || declared?.default_title || ext.info.name;
		const badge = badgeColors(raw.badgeColor, raw.badgeTextColor);
		return {
			title,
			// (a picture only: the host page cannot load an extension's file,
			// which answers its own contexts alone, through any route)
			iconUrl: icon && /^(data|blob):/.test(icon) ? icon : null,
			badgeText: raw.badgeText,
			badgeColor: badge.background,
			badgeTextColor: badge.text,
			popupUrl: popup ? extensionURL(id, cleanPath(popup)) : null,
			enabled:
				visible || interaction === 'withheld' || interaction === 'activeTab',
			visible,
			siteInteraction: interaction,
			wantsToRun: tabId !== null && ext.blockedTabs.has(tabId),
			tooltip:
				interaction === 'granted'
					? `${title}\n${MENU_TEXT.hasAccess}`
					: interaction === 'none'
						? title
						: `${title}\n${MENU_TEXT.wantsAccess}`,
		};
	}

	/** every button: the pinned in their order, then the others by name (the extensions menu's order) */
	async actions(tabId: number | null): Promise<ExtensionAction[]> {
		await this.#listed();
		const rows: ExtensionAction[] = [];
		for (const ext of this.#extensions.values())
			if (ext.info.hasAction)
				rows.push({
					id: ext.info.id,
					name: ext.info.name,
					pinned: ext.info.pinned,
					...(await this.actionState(ext.info.id, tabId)),
				});
		const order = (row: ExtensionAction) =>
			this.#extensions.get(row.id)?.info.pinOrder ?? Infinity;
		return rows.sort(
			(a, b) =>
				order(a) - order(b) ||
				a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
		);
	}

	/** grant the extension the tab (activeTab, its withheld sites): its waiting scripts run */
	async #grant(ext: HubExtension, tabId: number) {
		const { interaction } = await this.#siteInteraction(ext, tabId);
		if (
			!ext.info.permissions.includes('activeTab') &&
			interaction !== 'withheld'
		)
			return;
		await this.command({ op: 'grant', id: ext.info.id, tabId }).catch(() => {});
		ext.grantedTabs.add(tabId);
		ext.blockedTabs.delete(tabId);
		this.#post(ext, { t: 'unblock', tabId });
		this.#host.notify({ type: 'action', id: ext.info.id, tabId });
	}

	/**
	 * A click on the toolbar button, as Chrome runs it
	 * (ExtensionActionViewModel::ExecuteUserAction, RunAction): a disabled
	 * one opens its menu; scripts waiting on the tab only run; else the
	 * click grants activeTab, then shows the popup or tells action.onClicked
	 */
	async click(id: string, tabId: number | null): Promise<ClickResult> {
		await this.#listed();
		const ext = this.#found(id);
		const state = await this.actionState(id, tabId);
		if (!state.enabled) return 'disabled';
		if (tabId !== null && state.wantsToRun) {
			await this.#grant(ext, tabId);
			return 'granted';
		}
		if (tabId !== null) await this.#grant(ext, tabId);
		if (!state.visible) return 'granted';
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

	/**
	 * Its pages to inspect, as the extensions page lists them: the
	 * background (a service worker inactive while it is not running), its
	 * offscreen document and its pages open in tabs
	 */
	views(id: string): ExtensionView[] {
		const ext = this.#extensions.get(id);
		const info = ext?.info;
		if (!ext || !info || info.background === 'none') return [];
		const view = (kind: ExtensionView['kind'], url: string, active = true) => ({
			kind,
			url,
			displayUrl: displayExtensionURL(url),
			active,
		});
		const rows: ExtensionView[] = [];
		const background = info.manifest.background ?? {};
		if (info.background === 'service_worker')
			rows.push(
				view(
					'service_worker',
					extensionURL(id, cleanPath(background.service_worker ?? '')),
					!!ext.background,
				),
			);
		else
			rows.push(
				view(
					'background',
					extensionURL(
						id,
						background.page
							? cleanPath(background.page)
							: '_generated_background_page.html',
					),
				),
			);
		for (const page of ext.pages.values())
			if (page.kind === 'offscreen' || page.kind === 'tab')
				rows.push(view(page.kind, page.url));
		return rows;
	}

	/** pin the button to the toolbar (after the pinned ones), or unpin it */
	async pin(id: string, pinned: boolean): Promise<ExtensionInfo> {
		await this.#listed();
		this.#found(id);
		const info = await this.command<ExtensionInfo>({ op: 'pin', id, pinned });
		await this.refresh();
		return info;
	}

	/**
	 * Its site access, as its menu's "This can read and change site data"
	 * sets it: on a click, on the tab's site, on all sites. Granting the
	 * tab's site runs the scripts that waited there
	 */
	async setSiteAccess(
		id: string,
		access: 'click' | 'site' | 'all',
		tabId: number | null,
	): Promise<ExtensionInfo> {
		await this.#listed();
		const ext = this.#found(id);
		const url =
			tabId === null
				? ''
				: String((await this.#tab(tabId).catch(() => null))?.url ?? '');
		const info = await this.command<ExtensionInfo>({
			op: 'siteAccess',
			id,
			access,
			...(url ? { url } : {}),
		});
		await this.refresh();
		if (tabId !== null && access !== 'click' && ext.blockedTabs.delete(tabId))
			this.#post(ext, { t: 'unblock', tabId });
		this.#host.notify({
			type: 'action',
			id,
			...(tabId === null ? {} : { tabId }),
		});
		return info;
	}

	/**
	 * The menu of an extension's button (or of its row in the extensions
	 * menu, `source` `menu`), as Chrome's ExtensionContextMenuModel::InitMenu
	 * makes it in 157: its name, its own items, its site access, Options,
	 * Remove, Pin, Manage extension, View web permissions, Inspect popup
	 */
	async contextMenu(
		id: string,
		options: MenuOptions,
	): Promise<ExtensionMenuEntry[]> {
		await this.#listed();
		const ext = this.#found(id);
		const info = ext.info;
		const tabId = options.tabId ?? null;
		const entries: ExtensionMenuEntry[] = [
			{
				type: 'item',
				command: 'home',
				label: info.name,
				enabled: !!info.homepageUrl,
				...(info.homepageUrl ? { url: info.homepageUrl } : {}),
			},
		];
		const items = this.#actionItems(ext);
		if (items.length) entries.push({ type: 'separator' }, ...items);
		entries.push({ type: 'separator' });
		const { url } = await this.#siteInteraction(ext, tabId);
		const restricted = !url || restrictedURL(url);
		const activeTab = info.permissions.includes('activeTab') && !restricted;
		const canAffect = info.requestedHosts.length > 0 && !info.policy;
		if (url && (canAffect || activeTab)) {
			const wants = !restricted && this.#wants(ext, url);
			const allLike = info.requestedHosts.some(allSitesPattern);
			if (restricted || (!activeTab && !wants))
				entries.push({
					type: 'item',
					command: 'cantAccess',
					label: MENU_TEXT.cantAccess,
					enabled: false,
				});
			else {
				const site = new URL(url);
				const access = info.siteAccess;
				const checked =
					wants && !access.withheld && allLike
						? 'all'
						: wants && (!access.withheld || siteListed(access.sites, url))
							? 'site'
							: 'click';
				entries.push({
					type: 'submenu',
					command: 'siteAccess',
					label: MENU_TEXT.access,
					children: [
						{
							type: 'radio',
							command: 'site:click',
							label: MENU_TEXT.onClick,
							enabled: wants || activeTab,
							checked: checked === 'click',
						},
						{
							type: 'radio',
							command: 'site:site',
							label: MENU_TEXT.onSite(site.hostname.replace(/^www\./, '')),
							enabled: wants,
							checked: checked === 'site',
						},
						{
							type: 'radio',
							command: 'site:all',
							label: MENU_TEXT.onAll,
							enabled: allLike,
							checked: checked === 'all',
						},
						{ type: 'separator' },
						{
							type: 'item',
							command: 'learnMore',
							label: MENU_TEXT.learnMore,
							url: SITE_ACCESS_HELP,
						},
					],
				});
			}
			entries.push({ type: 'separator' });
		}
		if (info.optionsUrl)
			entries.push({
				type: 'item',
				command: 'options',
				label: MENU_TEXT.options,
			});
		entries.push(
			info.policy
				? {
						type: 'item',
						command: 'policy',
						label: MENU_TEXT.policy,
						enabled: false,
					}
				: {
						type: 'item',
						command: 'uninstall',
						label: MENU_TEXT.remove(options.browserName ?? 'Chrome'),
					},
		);
		if ((options.source ?? 'toolbar') === 'toolbar' && info.hasAction)
			entries.push(
				info.pinned
					? { type: 'item', command: 'unpin', label: MENU_TEXT.unpin }
					: { type: 'item', command: 'pin', label: MENU_TEXT.pin },
			);
		entries.push(
			{ type: 'separator' },
			{ type: 'item', command: 'manage', label: MENU_TEXT.manage },
			{ type: 'item', command: 'permissions', label: MENU_TEXT.permissions },
		);
		if (options.developerMode && info.hasAction) {
			const state = await this.actionState(id, tabId);
			entries.push(
				{ type: 'separator' },
				{
					type: 'item',
					command: 'inspect',
					label: MENU_TEXT.inspect,
					enabled: !!state.popupUrl,
				},
			);
		}
		return tidyMenu(entries);
	}

	/** the extension's own items an action menu shows (ContextMenuMatcher, its action filter) */
	#actionItems(ext: HubExtension): ExtensionMenuEntry[] {
		const manifest = ext.info.manifest;
		const context =
			Number(ext.info.manifestVersion) >= 3
				? 'action'
				: manifest.page_action
					? 'page_action'
					: 'browser_action';
		const all = [...ext.menus.values()];
		const relevant = (parent: unknown) =>
			all.filter((item) => {
				if ((item.parentId ?? null) !== (parent ?? null)) return false;
				const contexts = Array.isArray(item.contexts)
					? (item.contexts as string[])
					: ['page'];
				return contexts.includes('all') || contexts.includes(context);
			});
		const build = (
			items: Record<string, unknown>[],
			top: boolean,
		): ExtensionMenuEntry[] => {
			const out: ExtensionMenuEntry[] = [];
			let last = 'normal';
			let shown = 0;
			for (const [index, item] of items.entries()) {
				const type = String(item.type ?? 'normal');
				// a run of radios has a separator before and after it
				if (last === 'radio' && type !== 'radio') {
					out.push({ type: 'separator' });
					last = 'separator';
				}
				if (top && shown >= ACTION_MENU_LIMIT) break;
				const visible = item.visible !== false;
				if (visible) shown++;
				const label = menuTitle(String(item.title ?? ''));
				const enabled = item.enabled !== false;
				const menuItemId = String(item.id);
				if (type === 'separator') out.push({ type: 'separator' });
				else if (type === 'checkbox' || type === 'radio') {
					if (type === 'radio' && index > 0 && last !== 'radio')
						out.push({ type: 'separator' });
					if (visible)
						out.push({
							type,
							command: 'item',
							label,
							enabled,
							checked: item.checked === true,
							menuItemId,
						});
				} else if (visible) {
					const children = build(relevant(item.id), false);
					out.push(
						children.length
							? {
									type: 'submenu',
									command: 'item',
									label,
									enabled,
									menuItemId,
									children,
								}
							: { type: 'item', command: 'item', label, enabled, menuItemId },
					);
				}
				last = type;
			}
			return out;
		};
		return build(relevant(null), true);
	}

	/**
	 * Run an entry of `contextMenu()` that the hub carries out: `pin`,
	 * `unpin`, `site:click`, `site:site`, `site:all`, and `item` (the
	 * extension's own: contextMenus.onClicked, with Chrome's info for an
	 * action menu, the tab, and activeTab granted)
	 */
	async runMenuCommand(
		id: string,
		command: string,
		options: { tabId: number | null; menuItemId?: string },
	): Promise<void> {
		await this.#listed();
		const ext = this.#found(id);
		const tabId = options.tabId ?? null;
		switch (command) {
			case 'pin':
			case 'unpin':
				await this.pin(id, command === 'pin');
				return;
			case 'site:click':
			case 'site:site':
			case 'site:all':
				await this.setSiteAccess(
					id,
					command.slice(5) as 'click' | 'site' | 'all',
					tabId,
				);
				return;
			case 'item': {
				const item = ext.menus.get(String(options.menuItemId));
				if (!item)
					throw new ExtensionError(
						'not-found',
						`No menu item ${options.menuItemId}.`,
					);
				const info: Record<string, unknown> = {
					menuItemId: item.id,
					...(item.parentId !== undefined && item.parentId !== null
						? { parentMenuItemId: item.parentId }
						: {}),
					editable: false,
				};
				const type = String(item.type ?? 'normal');
				if (type === 'checkbox' || type === 'radio') {
					const was = item.checked === true;
					info.wasChecked = was;
					info.checked = type === 'radio' ? true : !was;
					this.#check(ext, item, info.checked as boolean);
				}
				if (tabId !== null) await this.#grant(ext, tabId);
				this.#startBackground(ext);
				await ext.backgroundReady;
				const tab =
					tabId === null
						? undefined
						: await this.#tab(tabId).catch(() => undefined);
				this.#post(ext, {
					t: 'event',
					name: 'contextMenus.onClicked',
					args: [info, tab],
				});
				return;
			}
			default:
				throw new ExtensionError(
					'unsupported',
					`${command} is a command the host carries out.`,
				);
		}
	}

	/** a checkbox's or radio's new state (a radio unchecks the others of its run) */
	#check(ext: HubExtension, item: Record<string, unknown>, checked: boolean) {
		item.checked = checked;
		if (item.type === 'radio' && checked) {
			const siblings = [...ext.menus.values()].filter(
				(other) => (other.parentId ?? null) === (item.parentId ?? null),
			);
			const at = siblings.indexOf(item);
			for (const step of [-1, 1])
				for (
					let index = at + step;
					siblings[index]?.type === 'radio';
					index += step
				)
					siblings[index].checked = false;
		}
		this.#host.notify({ type: 'menus', id: ext.info.id });
	}

	/**
	 * The enabled extensions' keyboard shortcuts as the Keyboard shortcuts
	 * page lists them: each command (`_execute_action` first, for one with
	 * a button) with the shortcut it runs on now (the worker keeps them)
	 */
	async commands(): Promise<ExtensionShortcut[]> {
		await this.#listed();
		return this.command<ExtensionShortcut[]>({ op: 'commands' });
	}

	/**
	 * Run an extension's command, as its shortcut does: `_execute_action`
	 * (`_execute_browser_action`, `_execute_page_action`) clicks its button,
	 * any other tells commands.onCommand, with activeTab granted
	 */
	async runCommand(
		id: string,
		name: string,
		tabId: number | null,
	): Promise<CommandResult> {
		await this.#listed();
		const ext = this.#found(id);
		if (/^_execute_(page_|browser_)?action$/.test(name)) {
			if (!ext.info.hasAction) return 'disabled';
			if (name === '_execute_page_action' && !this.#visible(ext, tabId))
				return 'disabled';
			return this.click(id, tabId);
		}
		if (tabId !== null) await this.#grant(ext, tabId);
		this.#startBackground(ext);
		await ext.backgroundReady;
		const tab =
			tabId === null
				? undefined
				: await this.#tab(tabId).catch(() => undefined);
		this.#post(ext, {
			t: 'event',
			name: 'commands.onCommand',
			args: [name, tab],
		});
		return 'command';
	}

	/** the public API's toolbar calls, one door for both controllers (a RemoteController's over its RPC) */
	toolbarCall(call: ToolbarCall, args: unknown[]): Promise<unknown> {
		const [id, a, b] = args as [string, unknown, unknown];
		switch (call) {
			case 'pin':
				return this.pin(id, a === true);
			case 'setSiteAccess':
				return this.setSiteAccess(
					id,
					a as 'click' | 'site' | 'all',
					(b as number | null) ?? null,
				);
			case 'contextMenu':
				return this.contextMenu(id, (a ?? {}) as MenuOptions);
			case 'runMenuCommand':
				return this.runMenuCommand(
					id,
					String(a),
					(b ?? { tabId: null }) as {
						tabId: number | null;
						menuItemId?: string;
					},
				);
			case 'commands':
				return this.commands();
			case 'runCommand':
				return this.runCommand(id, String(a), (b as number | null) ?? null);
			case 'popupOpen':
				return Promise.resolve(this.popupOpen);
			case 'views':
				return this.#listed().then(() => this.views(id));
			default:
				return Promise.reject(new Error(`${call} is not a toolbar call`));
		}
	}

	/** whether a popup of any extension's is open (Chrome shows one at a time) */
	get popupOpen(): boolean {
		for (const ext of this.#extensions.values())
			if (ext.openPopups.size) return true;
		return false;
	}

	/** tell the extension's contexts a chrome.* event (notifications, menus) */
	async dispatch(id: string, name: string, args: unknown[]) {
		await this.#listed();
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

	async expectPopup(id: string, tabId: number | null, url: string) {
		await this.#listed();
		this.#found(id).popups.push({ url, tabId: tabId ?? -1, at: Date.now() });
	}

	async menus(id: string): Promise<Record<string, unknown>[]> {
		await this.#listed();
		return [...this.#found(id).menus.values()];
	}
}

/** a site access list grants `url`: an origin of it, or a match pattern (setSiteHosts') that matches it */
function siteListed(sites: string[], url: string): boolean {
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch (error) {
		return false;
	}
	return sites.some((site) =>
		/^[^:]+:\/\/[^/]*\//.test(site) ? urlMatches(site, url) : site === origin,
	);
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

/** what `ExtensionsBackend.toolbar` carries */
export type ToolbarCall =
	| 'pin'
	| 'setSiteAccess'
	| 'contextMenu'
	| 'runMenuCommand'
	| 'commands'
	| 'runCommand'
	| 'popupOpen'
	| 'views';

/** a host page's `contextMenu()` options */
export interface MenuOptions {
	/** the tab the menu is about (the active one) */
	tabId?: number | null;
	/** `toolbar`: the button's menu (with Pin / Unpin); `menu`: its row's in the extensions menu */
	source?: 'toolbar' | 'menu';
	/** developer mode is on: "Inspect popup" is in it */
	developerMode?: boolean;
	/** the browser in "Remove from Chrome" */
	browserName?: string;
}

/** a URL no extension may read or change (PermissionsData::IsRestrictedUrl): not a web page, or the Web Store's */
function restrictedURL(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			!/^(https?|file|ftp):$/.test(parsed.protocol) ||
			parsed.hostname === STORE_SITE
		);
	} catch (error) {
		return true;
	}
}

/** a pattern that asks for every site: <all_urls>, or any host of http, https or both */
function allSitesPattern(pattern: string): boolean {
	return pattern === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(pattern);
}

/** the icon of `icons` for `size`: the nearest bigger, else the nearest smaller */
function pickIconSize(
	icons: Record<string, string>,
	size: number,
): string | null {
	const sizes = Object.keys(icons)
		.map(Number)
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const best = sizes.find((candidate) => candidate >= size) ?? sizes.at(-1);
	return best === undefined ? null : icons[String(best)];
}

/** a CSS color's [r, g, b, a] (a 0-255), as the runtime wrote it (#hex or rgba()) */
function rgbaOf(css: string | null): [number, number, number, number] | null {
	if (!css) return null;
	const hex = /^#([0-9a-f]{3,8})$/i.exec(css.trim())?.[1];
	if (hex) {
		const full =
			hex.length <= 4 ? [...hex].map((char) => char + char).join('') : hex;
		const at = (index: number) => parseInt(full.slice(index, index + 2), 16);
		return [at(0), at(2), at(4), full.length === 8 ? at(6) : 255];
	}
	const parts = /rgba?\(([^)]+)\)/i
		.exec(css)?.[1]
		.split(/[,\s/]+/)
		.filter(Boolean)
		.map(Number);
	if (!parts || parts.length < 3) return null;
	return [
		parts[0],
		parts[1],
		parts[2],
		parts[3] === undefined ? 255 : Math.round(parts[3] * 255),
	];
}

/** white or #202124, whichever stands out more on `rgb` (color_utils::GetColorWithMaxContrast) */
function maxContrast([r, g, b]: number[]): string {
	const linear = (value: number) => {
		const c = value / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const luminance = (red: number, green: number, blue: number) =>
		0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
	const own = luminance(r, g, b);
	const dark = luminance(0x20, 0x21, 0x24);
	return 1.05 / (own + 0.05) >= (own + 0.05) / (dark + 0.05)
		? '#ffffff'
		: '#202124';
}

/**
 * The badge's colors as Chrome draws them (IconWithBadgeImageSource): a
 * transparent background is the default (null), any other is made
 * opaque; the text's own color, else the one that stands out more
 */
function badgeColors(
	background: string | null,
	text: string | null,
): { background: string | null; text: string | null } {
	const bg = rgbaOf(background);
	const solid = bg && bg[3] > 0 ? bg : null;
	const fg = rgbaOf(text);
	return {
		background: solid ? `rgb(${solid[0]}, ${solid[1]}, ${solid[2]})` : null,
		text:
			fg && fg[3] > 0
				? `rgba(${fg[0]}, ${fg[1]}, ${fg[2]}, ${fg[3] / 255})`
				: solid
					? maxContrast(solid)
					: null,
	};
}

/** a menu item's title as Chrome shows it: `%s` empty, cut at a word to 75 characters, `&&` as `&` */
function menuTitle(title: string): string {
	let text = title.replace(/%s/g, '');
	if (text.length > MENU_TITLE_MAX) {
		const cut = text.slice(0, MENU_TITLE_MAX - 1);
		const space = cut.lastIndexOf(' ');
		text = `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
	}
	// a lone & marks the mnemonic (not drawn), && is one &
	return text.replace(/&(&?)/g, (_, double: string) => double);
}

/** no separator first, last or after another (a views menu drops them) */
function tidyMenu(entries: ExtensionMenuEntry[]): ExtensionMenuEntry[] {
	const out: ExtensionMenuEntry[] = [];
	for (const entry of entries) {
		if (
			entry.type === 'separator' &&
			(!out.length || out.at(-1)!.type === 'separator')
		)
			continue;
		out.push(
			entry.type === 'separator'
				? entry
				: {
						enabled: true,
						...entry,
						...(entry.children ? { children: tidyMenu(entry.children) } : {}),
					},
		);
	}
	while (out.at(-1)?.type === 'separator') out.pop();
	return out;
}

/** declarativeContent's PageStateMatcher pageUrl (UrlFilter) against a page's URL */
function pageUrlMatches(
	filter: Record<string, unknown>,
	href: string,
): boolean {
	let url: URL;
	try {
		url = new URL(href);
	} catch (error) {
		return false;
	}
	const host = url.hostname;
	const path = url.pathname;
	const query = url.search.replace(/^\?/, '');
	const noRef = href.split('#')[0];
	const text = (key: string) =>
		typeof filter[key] === 'string' ? String(filter[key]) : null;
	const checks: [string, (value: string) => boolean][] = [
		['hostContains', (value) => `.${host}`.includes(value)],
		['hostEquals', (value) => host === value.toLowerCase()],
		['hostPrefix', (value) => host.startsWith(value.toLowerCase())],
		['hostSuffix', (value) => `.${host}`.endsWith(value.toLowerCase())],
		['pathContains', (value) => path.includes(value)],
		['pathEquals', (value) => path === value],
		['pathPrefix', (value) => path.startsWith(value)],
		['pathSuffix', (value) => path.endsWith(value)],
		['queryContains', (value) => query.includes(value)],
		['queryEquals', (value) => query === value],
		['queryPrefix', (value) => query.startsWith(value)],
		['querySuffix', (value) => query.endsWith(value)],
		['urlContains', (value) => noRef.includes(value)],
		['urlEquals', (value) => noRef === value],
		['urlPrefix', (value) => noRef.startsWith(value)],
		['urlSuffix', (value) => noRef.endsWith(value)],
		['urlMatches', (value) => new RegExp(value).test(noRef)],
		[
			'originAndPathMatches',
			(value) => new RegExp(value).test(url.origin + path),
		],
	];
	for (const [key, check] of checks) {
		const value = text(key);
		if (value !== null && !check(value)) return false;
	}
	if (
		Array.isArray(filter.schemes) &&
		!filter.schemes.includes(url.protocol.slice(0, -1))
	)
		return false;
	if (Array.isArray(filter.ports)) {
		const port = Number(
			url.port ||
				(url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0),
		);
		if (
			!filter.ports.some((entry) =>
				Array.isArray(entry)
					? port >= Number(entry[0]) && port <= Number(entry[1])
					: port === Number(entry),
			)
		)
			return false;
	}
	return true;
}

// ---- the public API -------------------------------------------------------

/** what `controller.extensions` needs: the hub (local or over the frame's RPC) and routing */
export interface ExtensionsBackend {
	command<T>(command: ExtensionCommand, transfer?: Transferable[]): Promise<T>;
	actionState(id: string, tabId: number | null): Promise<ActionState>;
	actions(tabId: number | null): Promise<ExtensionAction[]>;
	click(id: string, tabId: number | null): Promise<ClickResult>;
	/** the toolbar's other calls (ExtensionHub.toolbarCall) */
	toolbar(call: ToolbarCall, args: unknown[]): Promise<unknown>;
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
	let folder: string | undefined;
	if (isFileList(source)) {
		for (const file of Array.from(source)) {
			const path = (file.webkitRelativePath || file.name).split('/');
			// a folder's files name the folder first (Chrome's Source row shows it)
			if (file.webkitRelativePath && path.length > 1) folder ??= path[0];
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
			...(folder ? { path: folder } : {}),
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
	#themeListeners = new Set<(theme: ThemeInfo | null) => void>();
	/** each installed theme's images as this page's blob: URLs, by its id and update */
	#themeURLs = new Map<string, { key: number; urls: string[] }>();
	/** the last theme told to onTheme's listeners (its id and update), so a change that is none tells nothing */
	#toldTheme: string | undefined;

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
			toolbar: coded(backend.toolbar.bind(backend)),
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
		if (change.type === 'theme') void this.#tellTheme();
		// a disabled or removed extension's popup closes (Chrome closes it with its renderer)
		if ((change.type === 'disabled' || change.type === 'removed') && change.id)
			for (const popup of [...this.#popups])
				if (popup.id === change.id) popup.close();
		if (change.type === 'removed' && change.id)
			this.#keepThemeURLs(
				[...this.#themeURLs.keys()].filter((id) => id !== change.id),
			);
		for (const listener of [...this.#listeners])
			try {
				listener(change);
			} catch (error) {
				console.error(error);
			}
	}

	/** a theme from the worker, its images as blob: URLs of this page (kept while it is installed) */
	#themeInfo(payload: ThemePayload): ThemeInfo {
		const kept = this.#themeURLs.get(payload.extensionId);
		const reuse = kept?.key === payload.updatedAt ? [...kept.urls] : null;
		if (kept && !reuse) for (const url of kept.urls) URL.revokeObjectURL(url);
		const urls: string[] = [];
		const url = (file: ThemeImageFile) => {
			const made =
				reuse?.shift() ??
				URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
			urls.push(made);
			return made;
		};
		const images: ThemeInfo['theme']['images'] = {};
		for (const [key, value] of Object.entries(payload.theme.images))
			images[key] =
				'bytes' in value
					? url(value as ThemeImageFile)
					: Object.fromEntries(
							Object.entries(value as Record<string, ThemeImageFile>).map(
								([scale, file]) => [scale, url(file)],
							),
						);
		this.#themeURLs.set(payload.extensionId, { key: payload.updatedAt, urls });
		return {
			id: payload.id,
			extensionId: payload.extensionId,
			name: payload.name,
			description: payload.description,
			version: payload.version,
			source: payload.source,
			enabled: payload.enabled,
			theme: { ...payload.theme, images },
		};
	}

	/** forget the blob: URLs of themes no longer installed */
	#keepThemeURLs(installed: Iterable<string>) {
		const keep = new Set(installed);
		for (const [id, kept] of this.#themeURLs)
			if (!keep.has(id)) {
				for (const url of kept.urls) URL.revokeObjectURL(url);
				this.#themeURLs.delete(id);
			}
	}

	#themeKey(theme: ThemeInfo | null): string {
		return theme
			? `${theme.extensionId}|${this.#themeURLs.get(theme.extensionId)?.key}`
			: '';
	}

	/** tell onTheme's listeners the theme shown now, when it changed */
	async #tellTheme() {
		if (!this.#themeListeners.size) return;
		let theme: ThemeInfo | null;
		try {
			theme = await this.theme();
		} catch (error) {
			return;
		}
		const told = this.#themeKey(theme);
		if (told === this.#toldTheme) return;
		this.#toldTheme = told;
		for (const listener of [...this.#themeListeners])
			try {
				listener(theme);
			} catch (error) {
				console.error(error);
			}
	}

	/**
	 * The theme shown now, or null for the default: a Chrome theme the
	 * Chrome Web Store's page installed ("Add to Chrome" on a theme's
	 * listing) or `install()` did. Its `theme` is manifest.theme's colors,
	 * tints, properties and images under Chrome's own key names, each image
	 * a blob: URL of this page (valid while the theme is installed).
	 */
	async theme(): Promise<ThemeInfo | null> {
		const payload = await this.#backend.command<ThemePayload | null>({
			op: 'theme',
		});
		return payload ? this.#themeInfo(payload) : null;
	}

	/** every installed theme, the one shown first (a theme a new one replaced stays, off, for a while, as in Chrome) */
	async themes(): Promise<ThemeInfo[]> {
		const list = await this.#backend.command<ThemePayload[]>({
			op: 'themes',
		});
		this.#keepThemeURLs(list.map((payload) => payload.extensionId));
		return list.map((payload) => this.#themeInfo(payload));
	}

	/** Chrome's Reset to default: uninstall every theme (the store's pages hear management.onUninstalled) */
	async resetTheme(): Promise<void> {
		await this.#backend.command({ op: 'resetTheme' });
	}

	/**
	 * Hear the theme shown change: an install from the store's page or
	 * `install()`, a theme turned on, its removal, resetTheme(). The
	 * listener is called once soon with the theme shown now (after a
	 * reload, the installed one), then with each change; null is the
	 * default theme. Returns the unsubscribe.
	 */
	onTheme(listener: (theme: ThemeInfo | null) => void): () => void {
		this.#themeListeners.add(listener);
		this.theme().then(
			(theme) => {
				if (!this.#themeListeners.has(listener)) return;
				this.#toldTheme = this.#themeKey(theme);
				listener(theme);
			},
			() => {},
		);
		return () => this.#themeListeners.delete(listener);
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
		const { kind, id, name, iconUrl, permissions, url } = request;
		if (kind === 'theme') return 'accept';
		if (!handler) return 'cancel';
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

	// ---- the extensions page's controls ---------------------------------------

	/**
	 * Reload it, as the extensions page's reload does: its background starts
	 * again and hears runtime.onInstalled with reason `update`, its content
	 * scripts already in pages lose their extension; its errors stay
	 */
	reload(id: string): Promise<ExtensionInfo> {
		return this.#backend.command<ExtensionInfo>({ op: 'reload', id });
	}

	/** Chrome's developer mode: errors are collected only while it is on, and all go as it goes off. The host sets it at boot and on each toggle. */
	async setDeveloperMode(on: boolean): Promise<void> {
		await this.#backend.command({ op: 'developerMode', on: !!on });
	}

	/** its errors as the extensions page's Errors view lists them, oldest first */
	errors(id: string): Promise<ExtensionErrorEntry[]> {
		return this.#backend.command<ExtensionErrorEntry[]>({ op: 'errors', id });
	}

	/** clear its errors, or those of the ids given */
	async clearErrors(id: string, ids?: number[]): Promise<void> {
		await this.#backend.command({
			op: 'clearErrors',
			id,
			...(ids ? { ids: [...ids] } : {}),
		});
	}

	/** Collect errors on or off (off for a packed extension, on for an unpacked one until set) */
	setCollectErrors(id: string, on: boolean): Promise<ExtensionInfo> {
		return this.#backend.command<ExtensionInfo>({
			op: 'collectErrors',
			id,
			on: !!on,
		});
	}

	/**
	 * Site access on exactly these sites, as the extensions page's list of
	 * sites sets it: each a match pattern (`https://example.com/*`,
	 * `*://*.example.com/*`; anything else is refused, "Invalid host.", as
	 * Chrome refuses it); none is "On click". `setSiteAccess(id, 'all')`
	 * gives it every site it asks for again.
	 */
	setSiteHosts(id: string, hosts: string[]): Promise<ExtensionInfo> {
		return this.#backend.command<ExtensionInfo>({
			op: 'siteHosts',
			id,
			hosts: [...hosts].map(String),
		});
	}

	/**
	 * Set a command's shortcut (`Ctrl+Shift+Y`; '' clears it). A shortcut
	 * Chrome would refuse clears the command's, as the extensions API does;
	 * another command that held it loses it. Answers the commands as they
	 * are now.
	 */
	async setShortcut(
		id: string,
		name: string,
		shortcut: string,
	): Promise<ExtensionShortcut[]> {
		const rows = await this.#backend.command<ExtensionShortcut[]>({
			op: 'setShortcut',
			id,
			name,
			shortcut: String(shortcut ?? ''),
		});
		return rows;
	}

	/** In Chrome or Global: Chrome keeps it, and a key reaches STomp only from its own pages either way */
	async setCommandScope(
		id: string,
		name: string,
		scope: 'chrome' | 'global',
	): Promise<ExtensionShortcut[]> {
		const rows = await this.#backend.command<ExtensionShortcut[]>({
			op: 'setCommandScope',
			id,
			name,
			scope,
		});
		return rows;
	}

	/** its pages to inspect: its background or service worker, its offscreen document, its pages open in tabs */
	views(id: string): Promise<ExtensionView[]> {
		return this.#backend.toolbar('views', [id]) as Promise<ExtensionView[]>;
	}

	/**
	 * Chrome's Pack extension: an unpacked extension (its files, as
	 * install() takes them, or an installed extension's id) as a CRX3
	 * signed with the PKCS#8 PEM key given, or a new RSA-2048 key, which
	 * comes back to keep (the id stays with it)
	 */
	async pack(
		source: ExtensionSource,
		options: { key?: string } = {},
	): Promise<PackResult> {
		let files: Record<string, ArrayBuffer>;
		if (typeof source === 'string') {
			const id = source.trim();
			files = await this.#backend.command<Record<string, ArrayBuffer>>({
				op: 'files',
				id,
			});
		} else {
			const { command } = await installCommand(source);
			if (command.op !== 'install' || !command.files)
				throw new ExtensionError(
					'bad-source',
					"pack() takes an unpacked extension's files or an installed extension's id.",
				);
			files = command.files;
		}
		let packed: Awaited<ReturnType<typeof packExtension>>;
		try {
			packed = await packExtension(
				Object.fromEntries(
					Object.entries(files).map(([name, bytes]) => [
						name,
						new Uint8Array(bytes),
					]),
				),
				options.key,
			);
		} catch (error) {
			throw new ExtensionError(
				'bad-source',
				error instanceof Error ? error.message : String(error),
			);
		}
		return {
			crx: new Blob([packed.crx as Uint8Array<ArrayBuffer>], {
				type: 'application/x-chrome-extension',
			}),
			key: packed.key,
			id: packed.id,
		};
	}

	/**
	 * Pin the extension's button to the toolbar, or unpin it (Chrome keeps
	 * the order: a pinned one goes after the others). Chrome 157 pins an
	 * extension with a button when it is installed. The extension hears
	 * action.onUserSettingsChanged
	 */
	pin(id: string, pinned = true): Promise<ExtensionInfo> {
		return this.#backend.toolbar('pin', [id, pinned]) as Promise<ExtensionInfo>;
	}

	/**
	 * The extension's site access, as its menu's "This can read and change
	 * site data" sets it for the tab's site: `click` (When you click the
	 * extension), `site` (On <site>), `all` (On all sites). A withheld site
	 * holds its content scripts and requests until a click on its button
	 */
	setSiteAccess(
		id: string,
		access: 'click' | 'site' | 'all',
		tabId: number | null = this.#backend.activeTab(),
	): Promise<ExtensionInfo> {
		return this.#backend.toolbar('setSiteAccess', [
			id,
			access,
			tabId,
		]) as Promise<ExtensionInfo>;
	}

	/**
	 * The menu of the extension's button (right click, or its row's More
	 * button in the extensions menu with `source: 'menu'`), entry by entry
	 * as Chrome 157 makes it. Draw it, and on a choice do `home`,
	 * `options`, `uninstall`, `manage`, `permissions`, `learnMore` and
	 * `inspect` yourself; pass the rest to `runMenuCommand`
	 */
	contextMenu(
		id: string,
		options: MenuOptions = {},
	): Promise<ExtensionMenuEntry[]> {
		return this.#backend.toolbar('contextMenu', [
			id,
			{
				...options,
				tabId:
					options.tabId === undefined
						? this.#backend.activeTab()
						: options.tabId,
			},
		]) as Promise<ExtensionMenuEntry[]>;
	}

	/** carry out an entry of `contextMenu()`: pin, unpin, site:click, site:site, site:all, item */
	async runMenuCommand(
		id: string,
		entry: ExtensionMenuEntry | string,
		tabId: number | null = this.#backend.activeTab(),
	): Promise<void> {
		const command = typeof entry === 'string' ? entry : String(entry.command);
		await this.#backend.toolbar('runMenuCommand', [
			id,
			command,
			{
				tabId,
				...(typeof entry === 'object' && entry.menuItemId !== undefined
					? { menuItemId: entry.menuItemId }
					: {}),
			},
		]);
	}

	/** every enabled extension's keyboard shortcuts (manifest `commands`) */
	commands(): Promise<ExtensionShortcut[]> {
		return this.#backend.toolbar('commands', []) as Promise<
			ExtensionShortcut[]
		>;
	}

	/**
	 * Run a command, as its shortcut does: `_execute_action` acts as a click
	 * of the button (`popup`: show it with `mountPopup`; a host closes an
	 * open popup of the extension's instead, as Chrome does), any other
	 * tells commands.onCommand (`command`)
	 */
	runCommand(
		id: string,
		name: string,
		tabId: number | null = this.#backend.activeTab(),
	): Promise<CommandResult> {
		return this.#backend.toolbar('runCommand', [
			id,
			name,
			tabId,
		]) as Promise<CommandResult>;
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
		// Chrome's bubble: square, a 1 px border and two shadows, its content's
		// right edge 1 px inside the button's and its top 1 px below it
		element.style.cssText =
			'position:fixed;z-index:2147483647;box-sizing:content-box;border:1px solid rgba(0,0,0,.2);border-radius:0;box-shadow:0 2px 8px rgba(0,0,0,.2),0 2px 12px rgba(0,0,0,.1);background:#fff;width:25px;height:25px';
		const at = options.at;
		const place = (width: number) => {
			if (!(at instanceof HTMLElement)) return;
			const box = at.getBoundingClientRect();
			element.style.left = `${Math.max(0, Math.min(innerWidth - width - 2, box.right - width - 2))}px`;
			element.style.top = `${box.bottom}px`;
		};
		if (at instanceof HTMLElement) place(25);
		else if (at) {
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
			place(size.width);
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
