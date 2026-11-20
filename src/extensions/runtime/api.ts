// The chrome object one context sees (docs/extensions.md "API coverage"):
// content scripts get Chrome's content-script subset, extension pages the
// rest by their manifest. What lives in the worker (storage, rules,
// registered scripts, cookies, management) is a call there; what lives with
// the controller (tabs, the action, popups, offscreen documents) a call of
// the hub; messaging is the bus. Ported from STicks (src/api/*).
import { getMessage } from '../manifest';
import { matchesAny } from '../match';
import {
	chromeExtensionURL,
	cleanPath,
	displayExtensionURL,
	extensionOfURL,
	extensionURL,
	resolveExtensionURL,
} from '../origin';
import { ApiError, copy, type Context } from './context';
import { connect, sendMessage } from './messaging';
import { natives } from './natives';

type Fn = (...args: any[]) => unknown;

/** a path of the extension's, given as one or as its URL (getURL's chrome-extension:// one too) */
const ownPath = (given: string) =>
	cleanPath(
		extensionOfURL(given)
			? new URL(resolveExtensionURL(given)).pathname
			: given,
	);

const EXTENSION_ID = /^[a-p]{32}$/;

/** Chrome's defaults of the ChromeSettings an extension may read (privacy.*, proxy.settings) */
const SETTING_DEFAULTS: Record<string, unknown> = {
	'privacy.network.webRTCIPHandlingPolicy': 'default',
	'privacy.websites.doNotTrackEnabled': false,
	'proxy.settings': { mode: 'system' },
};

/** a ChromeSetting's path (`privacy.network.networkPredictionEnabled`), from a call's path */
const SETTING =
	/^(privacy\.[a-zA-Z]+\.[a-zA-Z]+|proxy\.settings)\.(get|set|clear)$/;

/** what a call of a namespace STomp does not implement answers: a list for a list, a setting for a setting */
function stubAnswer(
	path: string,
	args: unknown[],
	settings: Map<string, unknown>,
): unknown {
	const setting = SETTING.exec(path);
	if (setting) {
		const [, name, op] = setting;
		if (op === 'set') {
			settings.set(name, (args[0] as { value?: unknown } | undefined)?.value);
			return undefined;
		}
		if (op === 'clear') {
			settings.delete(name);
			return undefined;
		}
		const own = settings.has(name);
		return {
			value: own
				? settings.get(name)
				: name in SETTING_DEFAULTS
					? SETTING_DEFAULTS[name]
					: true,
			levelOfControl: own
				? 'controlled_by_this_extension'
				: 'controllable_by_this_extension',
		};
	}
	// getFontList, getAll, query and their kind: an empty list, not nothing
	if (/\.(get[A-Z]\w*List|getAll\w*|query|list)$/.test(path)) return [];
	return undefined;
}

/** a namespace that only keeps its events: calls answer what a list or a setting would, events never fire */
function stubNamespace(ctx: Context, name: string): unknown {
	const settings = new Map<string, unknown>();
	const make = (path: string): unknown =>
		new Proxy(function stub() {}, {
			get(_target, key) {
				if (typeof key === 'symbol' || key === 'then') return undefined;
				if (/^on[A-Z]/.test(key)) return ctx.event(`${path}.${key}`).api;
				return make(`${path}.${key}`);
			},
			apply(_target, _that, args) {
				const callback =
					typeof args[args.length - 1] === 'function'
						? (args[args.length - 1] as (value: unknown) => void)
						: null;
				const answer = stubAnswer(
					path,
					callback ? args.slice(0, -1) : args,
					settings,
				);
				if (callback) {
					natives.setTimeout(() => callback(answer), 0);
					return undefined;
				}
				return natives.Promise.resolve(answer);
			},
		});
	return make(name);
}

const platformInfo = () => {
	const agent = natives.userAgent;
	const os = /Windows/.test(agent)
		? 'win'
		: /Mac OS X/.test(agent)
			? 'mac'
			: /CrOS/.test(agent)
				? 'cros'
				: /Android/.test(agent)
					? 'android'
					: 'linux';
	const arch = /arm|aarch64/i.test(agent) ? 'arm64' : 'x86-64';
	return { os, arch, nacl_arch: arch };
};

function messageArgs(args: unknown[]): {
	target: string | null;
	message: unknown;
} {
	if (args.length >= 3)
		return { target: (args[0] as string) ?? null, message: args[1] };
	if (
		args.length === 2 &&
		typeof args[0] === 'string' &&
		EXTENSION_ID.test(args[0])
	)
		return { target: args[0], message: args[1] };
	return { target: null, message: args[0] };
}

export function runtimeApi(ctx: Context) {
	const { ext } = ctx;
	const m = ctx.method.bind(ctx);
	const content = ctx.kind === 'content';
	const api: Record<string, unknown> = {
		id: ext.id,
		// (an extension that asks for no dynamic URL has its id there)
		dynamicId: ext.id,
		getURL: ctx.sync((path: unknown) => chromeExtensionURL(ext.id, path)),
		getManifest: ctx.sync(() => copy(ext.manifest)),
		sendMessage: m((...args: unknown[]) => {
			const { target, message } = messageArgs(args);
			if (target && target !== ext.id)
				throw new ApiError(
					'Messaging another extension is not supported by STomp.',
				);
			return sendMessage(ctx, { kind: 'ext' }, message);
		}),
		connect: (...args: unknown[]) => {
			if (typeof args[0] === 'string') args.shift();
			const info = (args[0] ?? {}) as { name?: string };
			return connect(ctx, { kind: 'ext' }, String(info.name ?? ''));
		},
		onMessage: ctx.event('runtime.onMessage').api,
		onConnect: ctx.event('runtime.onConnect').api,
		OnInstalledReason: {
			INSTALL: 'install',
			UPDATE: 'update',
			CHROME_UPDATE: 'chrome_update',
			SHARED_MODULE_UPDATE: 'shared_module_update',
		},
		ContextType: {
			TAB: 'TAB',
			POPUP: 'POPUP',
			BACKGROUND: 'BACKGROUND',
			OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT',
			SIDE_PANEL: 'SIDE_PANEL',
		},
		PlatformOs: {
			MAC: 'mac',
			WIN: 'win',
			ANDROID: 'android',
			CROS: 'cros',
			LINUX: 'linux',
			OPENBSD: 'openbsd',
			FUCHSIA: 'fuchsia',
		},
		PlatformArch: {
			ARM: 'arm',
			ARM64: 'arm64',
			X86_32: 'x86-32',
			X86_64: 'x86-64',
			MIPS: 'mips',
			MIPS64: 'mips64',
			RISCV64: 'riscv64',
		},
		PlatformNaclArch: {
			ARM: 'arm',
			X86_32: 'x86-32',
			X86_64: 'x86-64',
			MIPS: 'mips',
			MIPS64: 'mips64',
		},
		OnRestartRequiredReason: {
			APP_UPDATE: 'app_update',
			OS_UPDATE: 'os_update',
			PERIODIC: 'periodic',
		},
		RequestUpdateCheckStatus: {
			THROTTLED: 'throttled',
			NO_UPDATE: 'no_update',
			UPDATE_AVAILABLE: 'update_available',
		},
	};
	if (!content) {
		for (const name of [
			'onInstalled',
			'onStartup',
			'onSuspend',
			'onSuspendCanceled',
			'onUpdateAvailable',
			'onRestartRequired',
			'onMessageExternal',
			'onConnectExternal',
			'onUserScriptMessage',
			'onUserScriptConnect',
		])
			api[name] = ctx.event(`runtime.${name}`).api;
		const types: Record<string, string> = {
			background: 'BACKGROUND',
			popup: 'POPUP',
			tab: 'TAB',
			offscreen: 'OFFSCREEN_DOCUMENT',
		};
		Object.assign(api, {
			getPlatformInfo: m(() => platformInfo()),
			getBackgroundPage: m(() => null),
			openOptionsPage: m(() => ctx.hub('openOptions'), { voidResult: true }),
			setUninstallURL: m(() => undefined, { voidResult: true }),
			reload: () => {
				ctx.hub('reload').catch(() => {});
			},
			requestUpdateCheck: m(() => ({ status: 'no_update' })),
			restart: () => {},
			restartAfterDelay: m(() => undefined, { voidResult: true }),
			getContexts: m((filter: { contextTypes?: string[] } = {}) =>
				[{ ...ctx.presence() }, ...[...ctx.peers.values()]]
					.filter((presence) => presence.kind !== 'content')
					.map((presence) => ({
						contextType: types[presence.kind] ?? 'TAB',
						contextId: presence.ctx,
						tabId: presence.tabId,
						windowId: presence.tabId >= 0 ? 1 : -1,
						frameId: presence.frameId,
						documentUrl: displayExtensionURL(presence.url),
						documentOrigin: `chrome-extension://${ext.id}`,
						incognito: false,
					}))
					.filter(
						(info) =>
							!filter.contextTypes ||
							filter.contextTypes.includes(info.contextType),
					),
			),
		});
	}
	natives.defineProperty(api, 'lastError', {
		enumerable: true,
		get: () => {
			ctx.lastErrorChecked = true;
			return ctx.lastError;
		},
	});
	return api;
}

export function storageApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	const QUOTAS: Record<string, Record<string, number>> = {
		local: { QUOTA_BYTES: 10_485_760 },
		sync: {
			QUOTA_BYTES: 102_400,
			QUOTA_BYTES_PER_ITEM: 8192,
			MAX_ITEMS: 512,
			MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
			MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
		},
		session: { QUOTA_BYTES: 10_485_760 },
		managed: {},
	};
	const area = (name: string) => ({
		...QUOTAS[name],
		get: m((keys?: unknown) =>
			ctx.worker('storage', 'get', name, keys ?? null),
		),
		getKeys: m(() => ctx.worker('storage', 'getKeys', name)),
		getBytesInUse: m((keys?: unknown) =>
			ctx.worker('storage', 'getBytesInUse', name, keys ?? null),
		),
		set: m(
			(items: unknown) => ctx.worker('storage', 'set', name, copy(items)),
			{
				voidResult: true,
			},
		),
		remove: m((keys: unknown) => ctx.worker('storage', 'remove', name, keys), {
			voidResult: true,
		}),
		clear: m(() => ctx.worker('storage', 'clear', name), { voidResult: true }),
		setAccessLevel: m(
			(options: unknown) =>
				ctx.worker('storage', 'setAccessLevel', name, options),
			{ voidResult: true },
		),
		onChanged: ctx.event(`storage.${name}.onChanged`).api,
	});
	ctx.on('storage', (message) => {
		const changes = message.changes as Record<string, unknown>;
		const name = String(message.area);
		ctx.event('storage.onChanged').dispatch([copy(changes), name]);
		ctx.event(`storage.${name}.onChanged`).dispatch([copy(changes)]);
	});
	return {
		local: area('local'),
		sync: area('sync'),
		session: area('session'),
		managed: area('managed'),
		onChanged: ctx.event('storage.onChanged').api,
		AccessLevel: {
			TRUSTED_CONTEXTS: 'TRUSTED_CONTEXTS',
			TRUSTED_AND_UNTRUSTED_CONTEXTS: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
		},
	};
}

export function i18nApi(ctx: Context) {
	const { ext } = ctx;
	const special: Record<string, string> = {
		'@@extension_id': ext.id,
		'@@ui_locale': ext.uiLocale,
		'@@bidi_dir': 'ltr',
		'@@bidi_reversed_dir': 'rtl',
		'@@bidi_start_edge': 'left',
		'@@bidi_end_edge': 'right',
	};
	return {
		getMessage: ctx.sync((name: unknown, substitutions: unknown) =>
			getMessage(ext.messages, String(name), substitutions, special),
		),
		getUILanguage: ctx.sync(() => natives.language || 'en-US'),
		getAcceptLanguages: ctx.method(() => [...natives.languages]),
		detectLanguage: ctx.method(() => ({ isReliable: false, languages: [] })),
	};
}

/**
 * What an extension page's window is marked with (entry.ts pageContext):
 * its extension, its kind and its tab, read as getViews walks the frames.
 * A registered symbol is every realm's own, so a page of the extension
 * finds the mark another realm of it left.
 */
export const VIEW_MARK = Symbol.for('extension view');

export interface ViewMark {
	readonly id: string;
	readonly kind: string;
	readonly tabId: number;
}

/**
 * The extension's pages under this window's top (Chrome's views of the
 * extension in its process): its tabs, its popup and, for a background page
 * (MV2), the background, each the page's own window. A service worker's
 * stand-in page and an offscreen document are no view.
 */
export function extensionViews(
	ctx: Context,
	filter: { type?: string; tabId?: number; windowId?: number } = {},
): Window[] {
	const views: Window[] = [];
	const mv3 = Number(ctx.ext.manifest.manifest_version) >= 3;
	const visit = (win: Window, depth: number) => {
		let mark: ViewMark | undefined;
		try {
			mark = (win as unknown as Record<symbol, ViewMark | undefined>)[
				VIEW_MARK
			];
		} catch (error) {
			// another origin's window: only its frames can be reached
		}
		if (mark && mark.id === ctx.ext.id) {
			const kind = mark.kind;
			const type =
				kind === 'popup' ? 'popup' : kind === 'background' ? null : 'tab';
			const wanted =
				kind === 'offscreen' || (kind === 'background' && mv3)
					? false
					: filter.type === undefined
						? true
						: filter.type === type;
			if (
				wanted &&
				(filter.tabId === undefined || filter.tabId === mark.tabId) &&
				(filter.windowId === undefined ||
					filter.windowId === -2 ||
					filter.windowId === 1 ||
					kind === 'background')
			)
				views.push(win);
		}
		if (depth > 32) return;
		let length: number;
		try {
			length = win.length;
		} catch (error) {
			return;
		}
		for (let index = 0; index < length; index++) {
			let child: Window | null;
			try {
				child = (win as unknown as Record<number, Window>)[index];
			} catch (error) {
				continue;
			}
			if (child) visit(child, depth + 1);
		}
	};
	visit((natives.global.top ?? natives.global) as Window, 0);
	return views;
}

export function extensionApi(ctx: Context) {
	const page = ctx.kind !== 'content';
	const background = () =>
		page && Number(ctx.ext.manifest.manifest_version) < 3
			? (extensionViews(ctx).find(
					(view) =>
						(view as unknown as Record<symbol, ViewMark>)[VIEW_MARK]?.kind ===
						'background',
				) ?? null)
			: null;
	const api: Record<string, unknown> = {
		getURL: ctx.sync((path: unknown) => chromeExtensionURL(ctx.ext.id, path)),
		inIncognitoContext: false,
		getBackgroundPage: background,
		getViews: (fetch?: { type?: string; tabId?: number; windowId?: number }) =>
			page ? extensionViews(ctx, fetch ?? {}) : [],
		isAllowedIncognitoAccess: ctx.method(() => false),
		isAllowedFileSchemeAccess: ctx.method(() => false),
		setUpdateUrlData: () => {},
	};
	natives.defineProperty(api, 'lastError', {
		enumerable: true,
		get: () => ctx.lastError,
	});
	return api;
}

// ---- the action, tabs and windows: the hub's --------------------------------

type Details = { tabId?: number | null } | undefined;

const NAMED: Record<string, string> = {
	red: '#ff0000',
	green: '#008000',
	blue: '#0000ff',
	black: '#000000',
	white: '#ffffff',
	transparent: 'rgba(0,0,0,0)',
};

function toCss(color: unknown): string {
	if (Array.isArray(color)) {
		const [r = 0, g = 0, b = 0, a = 255] = color.map(Number);
		return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
	}
	const text = String(color).trim().toLowerCase();
	if (NAMED[text]) return NAMED[text];
	if (
		/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text) ||
		/^rgba?\(/.test(text)
	)
		return text;
	throw new ApiError('The color specification could not be parsed.');
}

function toArray(css: string | null): number[] {
	if (!css) return [0, 0, 0, 0];
	const hex = /^#([0-9a-f]+)$/i.exec(css)?.[1];
	if (hex) {
		const full =
			hex.length <= 4
				? hex
						.split('')
						.map((char) => char + char)
						.join('')
				: hex;
		const value = (at: number) => parseInt(full.slice(at, at + 2), 16);
		return [value(0), value(2), value(4), full.length === 8 ? value(6) : 255];
	}
	const parts =
		/rgba?\(([^)]+)\)/
			.exec(css)?.[1]
			.split(/[,\s/]+/)
			.filter(Boolean)
			.map(Number) ?? [];
	return [
		parts[0] ?? 0,
		parts[1] ?? 0,
		parts[2] ?? 0,
		parts[3] === undefined ? 255 : Math.round(parts[3] * 255),
	];
}

function imageDataUrl(data: {
	width: number;
	height: number;
	data: ArrayLike<number>;
}) {
	const canvas = document.createElement('canvas');
	canvas.width = data.width;
	canvas.height = data.height;
	canvas
		.getContext('2d')
		?.putImageData(
			new ImageData(new Uint8ClampedArray(data.data), data.width, data.height),
			0,
			0,
		);
	return canvas.toDataURL('image/png');
}

/**
 * setIcon's path or imageData, at the toolbar's two sizes (16 and 32
 * pixels): for each, the nearest bigger one given, else the nearest smaller
 */
function pickSizes<T>(value: T | Record<string, T>): Record<string, T> {
	if (!value || typeof value !== 'object' || 'width' in (value as object))
		return { 16: value as T, 32: value as T };
	const entries = Object.entries(value as Record<string, T>).sort(
		(a, b) => Number(a[0]) - Number(b[0]),
	);
	const out: Record<string, T> = {};
	for (const size of [16, 32]) {
		const found = (entries.find(([given]) => Number(given) >= size) ??
			entries[entries.length - 1])?.[1];
		if (found !== undefined) out[size] = found;
	}
	return out;
}

/** declarativeContent's rules as they travel to the hub: SetIcon's imageData as pictures */
function contentRulesOut(rules: unknown): Record<string, unknown>[] {
	const list = (Array.isArray(rules) ? rules : []) as Record<string, unknown>[];
	return list.map((rule) => ({
		...JSON.parse(JSON.stringify({ ...rule, actions: undefined })),
		actions: ((rule?.actions ?? []) as Record<string, unknown>[]).map(
			(action) => {
				const plain = JSON.parse(
					JSON.stringify({ ...action, imageData: undefined }),
				) as Record<string, unknown>;
				if (action?.imageData)
					plain.icons = Object.fromEntries(
						Object.entries(
							pickSizes(
								action.imageData as Record<
									string,
									{ width: number; height: number; data: ArrayLike<number> }
								>,
							),
						).map(([size, data]) => [size, imageDataUrl(data)]),
					);
				return plain;
			},
		),
	}));
}

export function actionApi(ctx: Context, kind: string) {
	const m = ctx.method.bind(ctx);
	const tabOf = (details: Details) =>
		details?.tabId === undefined || details?.tabId === null
			? null
			: details.tabId;
	const set = (details: Details, patch: Record<string, unknown>) =>
		ctx.hub('action.set', tabOf(details), patch);
	const get = async (details: Details, key: string) =>
		((await ctx.hub('action.get', tabOf(details))) as Record<string, unknown>)[
			key
		];
	const tabArg = (value: unknown): Details =>
		typeof value === 'number' ? { tabId: value } : undefined;
	const v = { voidResult: true };
	return {
		setBadgeText: m((details: Details & { text?: string | null }) => {
			const text = String(details?.text ?? '');
			let bytes = 0;
			for (const char of text) {
				const code = char.codePointAt(0)!;
				bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
			}
			if (bytes > 100)
				throw new ApiError(
					`Badge text size is ${bytes} bytes which exceeds the limit of 100 bytes.`,
				);
			return set(details, { badgeText: text });
		}, v),
		getBadgeText: m((details: Details) => get(details, 'badgeText')),
		setBadgeBackgroundColor: m(
			(details: Details & { color: unknown }) =>
				set(details, { badgeColor: toCss(details.color) }),
			v,
		),
		getBadgeBackgroundColor: m(async (details: Details) =>
			toArray((await get(details, 'badgeColor')) as string),
		),
		setBadgeTextColor: m(
			(details: Details & { color: unknown }) =>
				set(details, { badgeTextColor: toCss(details.color) }),
			v,
		),
		getBadgeTextColor: m(async (details: Details) =>
			toArray((await get(details, 'badgeTextColor')) as string),
		),
		setTitle: m(
			(details: Details & { title: string }) =>
				set(details, { title: String(details.title ?? '') }),
			v,
		),
		getTitle: m(
			async (details: Details) => (await get(details, 'title')) ?? ctx.ext.name,
		),
		setIcon: m(
			(
				details: Details & {
					path?: string | Record<string, string>;
					imageData?: unknown;
				},
			) => {
				const icons: Record<string, string> = {};
				if (details.imageData) {
					const sizes = pickSizes(
						details.imageData as Record<
							string,
							{ width: number; height: number; data: ArrayLike<number> }
						>,
					);
					for (const [size, data] of Object.entries(sizes))
						if (data) icons[size] = imageDataUrl(data);
				} else if (details.path) {
					// (getURL's chrome-extension:// URL is the emulated origin's)
					for (const [size, path] of Object.entries(pickSizes(details.path))) {
						const url = path && resolveExtensionURL(path);
						if (url)
							icons[size] = /^(data|blob|https?):/.test(url)
								? url
								: extensionURL(ctx.ext.id, cleanPath(url));
					}
				}
				if (!Object.keys(icons).length)
					throw new ApiError('Either path or imageData must be specified.');
				return set(details, { icons });
			},
			v,
		),
		setPopup: m((details: Details & { popup: string }) => {
			const popup = String(details.popup ?? '')
				.replace(/^chrome-extension:\/\/[a-p]{32}\//, '')
				.replace(/^https:\/\/[a-p]{32}\.invalid\//, '');
			// (an empty one is no popup on the tab, whatever the manifest says)
			return set(details, { popup: popup ? cleanPath(popup) : '' });
		}, v),
		getPopup: m(async (details: Details) => {
			const popup = (await get(details, 'popup')) as string | null;
			return popup ? chromeExtensionURL(ctx.ext.id, popup) : '';
		}),
		enable: m((tabId?: number) => set(tabArg(tabId), { enabled: true }), v),
		disable: m((tabId?: number) => set(tabArg(tabId), { enabled: false }), v),
		isEnabled: m((tabId?: number) => get(tabArg(tabId), 'enabled')),
		show: m((tabId?: number) => set(tabArg(tabId), { enabled: true }), v),
		hide: m((tabId?: number) => set(tabArg(tabId), { enabled: false }), v),
		openPopup: m(
			(options?: { windowId?: number }) => ctx.hub('openPopup', options ?? {}),
			v,
		),
		getUserSettings: m(() => ctx.hub('action.settings')),
		onClicked: ctx.event(`${kind}.onClicked`).api,
		onUserSettingsChanged: ctx.event(`${kind}.onUserSettingsChanged`).api,
	};
}

type Target = {
	tabId: number;
	frameIds?: number[];
	allFrames?: boolean;
	documentIds?: string[];
};

type InjectionResult = {
	frameId: number;
	result?: unknown;
	documentId?: string;
};

/** each context's injections waiting for their documents' answers, by id (one exec-res handler per context) */
const injections = new WeakMap<
	Context,
	Map<string, (m: Record<string, unknown>) => void>
>();

function injectionsOf(ctx: Context) {
	let waiting = injections.get(ctx);
	if (!waiting) {
		const made = new Map<string, (m: Record<string, unknown>) => void>();
		injections.set(ctx, (waiting = made));
		ctx.on('exec-res', (m) => made.get(String(m.id))?.(m));
	}
	return waiting;
}

/** run code (an injection the worker prepared) in a tab's documents of this extension */
async function inject(
	ctx: Context,
	target: Target,
	source: { files?: string[]; code?: string; world?: string },
	css?: { remove?: boolean; key: string },
): Promise<{ frameId: number; result?: unknown; documentId?: string }[]> {
	if (typeof target?.tabId !== 'number')
		throw new ApiError('A target tab is required.');
	const prepared = css
		? null
		: ((await ctx.worker('execute', 'prepare', source)) as {
				route: string;
				key: string;
			});
	const cssText =
		css && !css.remove
			? ((await ctx.worker('css', 'prepare', source)) as string)
			: '';
	const frames = target.frameIds ?? (target.allFrames ? null : [0]);
	// one answer per document: its own context's (a world's context in the
	// same frame runs nothing injected, and waiting for it held every call
	// to the 10 s bound)
	const expected = [...ctx.peers.values()].filter(
		(presence) =>
			presence.kind === 'content' &&
			presence.x === true &&
			presence.tabId === target.tabId &&
			(frames === null || frames.includes(presence.frameId)),
	);
	if (!expected.length)
		throw new ApiError(
			`Cannot access contents of the page. Extension manifest must request permission to access the respective host.`,
		);
	const id = `${ctx.id}.x${Math.random().toString(36).slice(2)}`;
	const waiting = injectionsOf(ctx);
	return new natives.Promise((resolve) => {
		const results: InjectionResult[] = [];
		const left = new Set(expected.map((presence) => presence.ctx));
		const finish = () => {
			natives.clearTimeout(timer);
			waiting.delete(id);
			resolve(results.sort((a, b) => a.frameId - b.frameId));
		};
		waiting.set(id, (m) => {
			if (!left.has(String(m.ctx))) return;
			left.delete(String(m.ctx));
			results.push({
				frameId: Number(m.frameId),
				documentId: String(m.ctx),
				...(m.error === undefined ? { result: m.result } : {}),
			});
			if (!left.size) finish();
		});
		const timer = natives.setTimeout(finish, 10_000);
		ctx.post({
			t: 'exec',
			id,
			from: ctx.id,
			tabId: target.tabId,
			frames,
			...(prepared
				? {
						route: prepared.route,
						key: prepared.key,
						world: source.world ?? 'ISOLATED',
					}
				: {}),
			...(css ? { css: cssText, cssKey: css.key, remove: !!css.remove } : {}),
		});
	});
}

export function tabsApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	const v = { voidResult: true };
	const active = async () => {
		const tab = (await ctx.hub('tabs.active')) as { id: number } | null;
		if (!tab) throw new ApiError('No active tab.');
		return tab.id;
	};
	const resolve = (url: string) =>
		/^[a-z][a-z0-9+.-]*:/i.test(url)
			? url.replace(
					/^chrome-extension:\/\/([a-p]{32})\//,
					'https://$1.invalid/',
				)
			: new URL(url, ctx.url).href;
	const legacy = (
		run: (tabId: number, details: Record<string, unknown>) => unknown,
	) =>
		m(async (a: unknown, b: unknown) => {
			const [tabId, details] =
				typeof a === 'number'
					? [a, (b ?? {}) as Record<string, unknown>]
					: [await active(), (a ?? {}) as Record<string, unknown>];
			return run(tabId, details);
		});
	const targetOf = (
		tabId: number,
		details: Record<string, unknown>,
	): Target => ({
		tabId,
		allFrames: !!details.allFrames,
		...(typeof details.frameId === 'number'
			? { frameIds: [details.frameId] }
			: {}),
	});
	const sourceOf = (details: Record<string, unknown>) =>
		typeof details.code === 'string'
			? { code: details.code }
			: { files: [String(details.file ?? '')] };
	return {
		TAB_ID_NONE: -1,
		TAB_INDEX_NONE: -1,
		MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
		query: m((info: Record<string, unknown> = {}) =>
			ctx.hub('tabs.query', copy(info)),
		),
		get: m((tabId: number) => ctx.hub('tabs.get', tabId)),
		getCurrent: m(() => (ctx.place.tab ? ctx.place.tab : undefined)),
		create: m((props: Record<string, unknown> = {}) =>
			ctx.hub('tabs.create', {
				...copy(props),
				url: resolve(String(props.url ?? 'about:blank')),
			}),
		),
		update: m(async (a: unknown, b: unknown) => {
			const [tabId, props] =
				typeof a === 'number'
					? [a, (b ?? {}) as Record<string, unknown>]
					: [await active(), (a ?? {}) as Record<string, unknown>];
			return ctx.hub('tabs.update', tabId, {
				...copy(props),
				...(typeof props.url === 'string' ? { url: resolve(props.url) } : {}),
			});
		}),
		remove: m((ids: number | number[]) => ctx.hub('tabs.remove', ids), v),
		reload: m(
			async (a?: unknown) =>
				ctx.hub('tabs.reload', typeof a === 'number' ? a : await active()),
			v,
		),
		goBack: m(
			async (a?: unknown) =>
				ctx.hub('tabs.back', typeof a === 'number' ? a : await active()),
			v,
		),
		goForward: m(
			async (a?: unknown) =>
				ctx.hub('tabs.forward', typeof a === 'number' ? a : await active()),
			v,
		),
		sendMessage: m(
			(tabId: number, message: unknown, options: { frameId?: number } = {}) =>
				sendMessage(
					ctx,
					{ kind: 'tab', tabId, frameId: options?.frameId },
					message,
				),
		),
		connect: (tabId: number, info: { name?: string; frameId?: number } = {}) =>
			connect(
				ctx,
				{ kind: 'tab', tabId, frameId: info.frameId },
				String(info.name ?? ''),
			),
		executeScript: legacy(async (tabId, details) =>
			(await inject(ctx, targetOf(tabId, details), sourceOf(details))).map(
				(result) => result.result,
			),
		),
		insertCSS: legacy(async (tabId, details) => {
			await inject(ctx, targetOf(tabId, details), sourceOf(details), {
				key: natives.JSON.stringify(sourceOf(details)),
			});
		}),
		removeCSS: legacy(async (tabId, details) => {
			await inject(ctx, targetOf(tabId, details), sourceOf(details), {
				key: natives.JSON.stringify(sourceOf(details)),
				remove: true,
			});
		}),
		setZoom: m(() => undefined, v),
		getZoom: m(() => 1),
		getZoomSettings: m(() => ({
			mode: 'automatic',
			scope: 'per-origin',
			defaultZoomFactor: 1,
		})),
		detectLanguage: m(() => 'und'),
		captureVisibleTab: m(() => {
			throw new ApiError('captureVisibleTab is not supported by STomp.');
		}),
		discard: m((tabId?: number) =>
			tabId === undefined ? undefined : ctx.hub('tabs.get', tabId),
		),
		duplicate: m(async (tabId: number) => {
			const tab = (await ctx.hub('tabs.get', tabId)) as { url: string };
			return ctx.hub('tabs.create', { url: tab.url });
		}),
		highlight: m(async (info: { tabs: number | number[] }) => {
			const first = Array.isArray(info.tabs) ? info.tabs[0] : info.tabs;
			if (typeof first === 'number')
				await ctx.hub('tabs.update', first, { active: true });
			return ctx.hub('windows.get');
		}),
		move: m((ids: number | number[]) =>
			Array.isArray(ids)
				? natives.Promise.all(ids.map((id) => ctx.hub('tabs.get', id)))
				: ctx.hub('tabs.get', ids),
		),
		...Object.fromEntries(
			[
				'onCreated',
				'onUpdated',
				'onActivated',
				'onRemoved',
				'onReplaced',
				'onMoved',
				'onHighlighted',
				'onAttached',
				'onDetached',
				'onZoomChange',
			].map((name) => [name, ctx.event(`tabs.${name}`).api]),
		),
	};
}

/** webNavigation: the hub's events of the tabs' documents, and the frames it knows of them */
export function webNavigationApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	const names = (list: string[]) =>
		Object.fromEntries(list.map((name) => [name.toUpperCase(), name]));
	return {
		TransitionType: names([
			'link',
			'typed',
			'auto_bookmark',
			'auto_subframe',
			'manual_subframe',
			'generated',
			'start_page',
			'form_submit',
			'reload',
			'keyword',
			'keyword_generated',
		]),
		TransitionQualifier: names([
			'client_redirect',
			'server_redirect',
			'forward_back',
			'from_address_bar',
		]),
		getFrame: m(
			(details: { tabId?: number; frameId?: number; documentId?: string }) =>
				ctx.hub(
					'webNavigation.getFrame',
					details?.tabId,
					details?.frameId,
					details?.documentId,
				),
		),
		getAllFrames: m((details: { tabId: number }) =>
			ctx.hub('webNavigation.getAllFrames', details?.tabId),
		),
		...Object.fromEntries(
			[
				'onBeforeNavigate',
				'onCommitted',
				'onDOMContentLoaded',
				'onCompleted',
				'onErrorOccurred',
				'onCreatedNavigationTarget',
				'onReferenceFragmentUpdated',
				'onTabReplaced',
				'onHistoryStateUpdated',
			].map((name) => [name, ctx.event(`webNavigation.${name}`).api]),
		),
	};
}

export function windowsApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	const current = (info?: { populate?: boolean }) =>
		ctx.hub('windows.get', !!info?.populate);
	return {
		WINDOW_ID_NONE: -1,
		WINDOW_ID_CURRENT: -2,
		get: m((_id: number, info?: { populate?: boolean }) => current(info)),
		getCurrent: m((info?: { populate?: boolean }) => current(info)),
		getLastFocused: m((info?: { populate?: boolean }) => current(info)),
		getAll: m(async (info?: { populate?: boolean }) => [await current(info)]),
		create: m(async (data: { url?: string | string[] } = {}) => {
			for (const url of Array.isArray(data.url)
				? data.url
				: data.url
					? [data.url]
					: [])
				await ctx.hub('tabs.create', { url });
			return current({ populate: true });
		}),
		update: m(() => current()),
		remove: m(() => undefined, { voidResult: true }),
		onCreated: ctx.event('windows.onCreated').api,
		onRemoved: ctx.event('windows.onRemoved').api,
		onFocusChanged: ctx.event('windows.onFocusChanged').api,
		onBoundsChanged: ctx.event('windows.onBoundsChanged').api,
	};
}

export function scriptingApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	const v = { voidResult: true };
	return {
		ExecutionWorld: { ISOLATED: 'ISOLATED', MAIN: 'MAIN' },
		StyleOrigin: { AUTHOR: 'AUTHOR', USER: 'USER' },
		executeScript: m(
			async (injection: {
				target: Target;
				func?: Fn;
				function?: Fn;
				args?: unknown[];
				files?: string[];
				world?: string;
			}) => {
				const fn = injection.func ?? injection.function;
				if (!fn && !injection.files?.length)
					throw new ApiError(
						'Exactly one of func and files must be specified.',
					);
				const source = fn
					? {
							code: `$result((${String(fn)}).apply(this, ${natives.JSON.stringify(injection.args ?? [])}));`,
							world: injection.world,
						}
					: { files: injection.files, world: injection.world };
				return inject(ctx, injection.target, source);
			},
		),
		insertCSS: m(
			async (injection: { target: Target; css?: string; files?: string[] }) => {
				const source =
					typeof injection.css === 'string'
						? { code: injection.css }
						: { files: injection.files ?? [] };
				await inject(ctx, injection.target, source, {
					key: natives.JSON.stringify(source),
				});
			},
			v,
		),
		removeCSS: m(
			async (injection: { target: Target; css?: string; files?: string[] }) => {
				const source =
					typeof injection.css === 'string'
						? { code: injection.css }
						: { files: injection.files ?? [] };
				await inject(ctx, injection.target, source, {
					key: natives.JSON.stringify(source),
					remove: true,
				});
			},
			v,
		),
		registerContentScripts: m(
			(scripts: unknown) =>
				ctx.worker('scripting', 'registerContentScripts', copy(scripts)),
			v,
		),
		getRegisteredContentScripts: m((filter?: unknown) =>
			ctx.worker(
				'scripting',
				'getRegisteredContentScripts',
				copy(filter ?? null),
			),
		),
		unregisterContentScripts: m(
			(filter?: unknown) =>
				ctx.worker(
					'scripting',
					'unregisterContentScripts',
					copy(filter ?? null),
				),
			v,
		),
		updateContentScripts: m(
			(scripts: unknown) =>
				ctx.worker('scripting', 'updateContentScripts', copy(scripts)),
			v,
		),
	};
}

// ---- the rest -------------------------------------------------------------

export function alarmsApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	const alarms = new Map<
		string,
		{
			name: string;
			scheduledTime: number;
			periodInMinutes?: number;
			timer: number;
		}
	>();
	const info = (alarm: {
		name: string;
		scheduledTime: number;
		periodInMinutes?: number;
	}) => ({
		name: alarm.name,
		scheduledTime: alarm.scheduledTime,
		...(alarm.periodInMinutes
			? { periodInMinutes: alarm.periodInMinutes }
			: {}),
	});
	const clear = (name: string) => {
		const alarm = alarms.get(name);
		if (!alarm) return false;
		natives.clearTimeout(alarm.timer);
		alarms.delete(name);
		return true;
	};
	const schedule = (name: string, when: number, periodInMinutes?: number) => {
		clear(name);
		const fire = () => {
			const alarm = alarms.get(name);
			if (!alarm) return;
			ctx.event('alarms.onAlarm').dispatch([info(alarm)]);
			if (alarm.periodInMinutes) {
				alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60_000;
				alarm.timer = natives.setTimeout(
					fire,
					alarm.periodInMinutes * 60_000,
				) as unknown as number;
			} else alarms.delete(name);
		};
		alarms.set(name, {
			name,
			scheduledTime: when,
			periodInMinutes,
			timer: natives.setTimeout(
				fire,
				Math.max(0, when - Date.now()),
			) as unknown as number,
		});
	};
	return {
		create: m(
			(a?: unknown, b?: unknown) => {
				const [name, options] =
					typeof a === 'string'
						? [a, (b ?? {}) as Record<string, number>]
						: ['', (a ?? {}) as Record<string, number>];
				const when =
					options.when ??
					Date.now() +
						(options.delayInMinutes ?? options.periodInMinutes ?? 0) * 60_000;
				schedule(name, when, options.periodInMinutes);
			},
			{ voidResult: true },
		),
		get: m((name = '') => {
			const alarm = alarms.get(String(name));
			return alarm ? info(alarm) : undefined;
		}),
		getAll: m(() => [...alarms.values()].map(info)),
		clear: m((name = '') => clear(String(name))),
		clearAll: m(() => {
			for (const name of [...alarms.keys()]) clear(name);
			return true;
		}),
		onAlarm: ctx.event('alarms.onAlarm').api,
	};
}

const WEB_REQUEST_EVENTS = [
	'onBeforeRequest',
	'onBeforeSendHeaders',
	'onSendHeaders',
	'onHeadersReceived',
	'onAuthRequired',
	'onResponseStarted',
	'onBeforeRedirect',
	'onCompleted',
	'onErrorOccurred',
	'onActionIgnored',
];

/** an enum of Chrome's API schema: its values, keyed in upper snake case */
const enumOf = (...values: string[]) =>
	Object.fromEntries(
		values.map((value) => [
			value.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
			value,
		]),
	);

/** webRequest's enums, as Chrome's schema has them (Privacy Badger and Violentmonkey read them at startup) */
const WEB_REQUEST_ENUMS = {
	OnBeforeRequestOptions: enumOf('blocking', 'requestBody', 'extraHeaders'),
	OnBeforeSendHeadersOptions: enumOf(
		'requestHeaders',
		'blocking',
		'extraHeaders',
	),
	OnSendHeadersOptions: enumOf('requestHeaders', 'extraHeaders'),
	OnHeadersReceivedOptions: enumOf(
		'blocking',
		'responseHeaders',
		'extraHeaders',
	),
	OnAuthRequiredOptions: enumOf(
		'responseHeaders',
		'blocking',
		'asyncBlocking',
		'extraHeaders',
	),
	OnResponseStartedOptions: enumOf('responseHeaders', 'extraHeaders'),
	OnBeforeRedirectOptions: enumOf('responseHeaders', 'extraHeaders'),
	OnCompletedOptions: enumOf('responseHeaders', 'extraHeaders'),
	OnErrorOccurredOptions: enumOf('extraHeaders'),
	IgnoredActionType: enumOf(
		'redirect',
		'request_headers',
		'response_headers',
		'auth_credentials',
	),
};

/** declarativeContent: its rules are kept, and the action stays shown (no page state is judged) */
export function declarativeContentApi(ctx: Context) {
	const rule = (type: string) =>
		function (
			this: Record<string, unknown>,
			options?: Record<string, unknown>,
		) {
			Object.assign(this, options ?? {}, { instanceType: type });
		};
	// the rules live in the hub, which judges them on each page and keeps
	// them (Chrome keeps them across restarts)
	const event = ctx.event('declarativeContent.onPageChanged').api;
	const answer = (cb: unknown, value: unknown) => {
		if (typeof cb === 'function') (cb as (value: unknown) => void)(value);
	};
	const call = (op: string, given: unknown, cb: unknown) => {
		ctx
			.hub('content.rules', op, given)
			.then((value) => answer(cb, value))
			.catch((error: unknown) => ctx.listenerError(error));
	};
	return {
		onPageChanged: {
			...event,
			addRules: (rules: unknown, cb?: unknown) =>
				call('add', contentRulesOut(rules), cb),
			removeRules: (ids?: unknown, cb?: unknown) =>
				typeof ids === 'function'
					? call('remove', null, ids)
					: call('remove', ids ?? null, cb),
			getRules: (ids?: unknown, cb?: unknown) =>
				typeof ids === 'function'
					? call('get', null, ids)
					: call('get', ids ?? null, cb),
		},
		PageStateMatcher: rule('declarativeContent.PageStateMatcher'),
		ShowAction: rule('declarativeContent.ShowAction'),
		ShowPageAction: rule('declarativeContent.ShowPageAction'),
		SetIcon: rule('declarativeContent.SetIcon'),
		RequestContentScript: rule('declarativeContent.RequestContentScript'),
	};
}

/** webRequest: the listeners go to the worker, which asks this context as requests pass */
export function webRequestApi(ctx: Context) {
	let pending = 0;
	const push = () => {
		if (pending) return;
		pending = natives.setTimeout(() => {
			pending = 0;
			const listeners: unknown[] = [];
			for (const name of WEB_REQUEST_EVENTS) {
				const event = ctx.events.get(`webRequest.${name}`);
				for (const listener of event?.listeners ?? []) {
					const [filter, extra] = (listener.options ?? []) as [
						{ urls?: string[]; types?: string[]; tabId?: number } | undefined,
						string[] | undefined,
					];
					listeners.push({
						extensionId: ctx.ext.id,
						event: name,
						urls: filter?.urls ?? [],
						...(filter?.types ? { types: filter.types } : {}),
						...(typeof filter?.tabId === 'number'
							? { tabId: filter.tabId }
							: {}),
						blocking: !!extra?.includes('blocking'),
						extra: extra ?? [],
					});
				}
			}
			ctx
				.worker('webRequest', 'register', listeners)
				.catch((error) =>
					console.warn('STomp: webRequest listeners not registered:', error),
				);
		}, 0) as unknown as number;
	};
	const api: Record<string, unknown> = {
		MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
		...WEB_REQUEST_ENUMS,
		ResourceType: Object.fromEntries(
			[
				'main_frame',
				'sub_frame',
				'stylesheet',
				'script',
				'image',
				'font',
				'object',
				'xmlhttprequest',
				'ping',
				'csp_report',
				'media',
				'websocket',
				'webbundle',
				'webtransport',
				'other',
			].map((type) => [type.toUpperCase(), type]),
		),
		handlerBehaviorChanged: ctx.method(() => undefined, { voidResult: true }),
	};
	for (const name of WEB_REQUEST_EVENTS) {
		const event = ctx.event(`webRequest.${name}`);
		const add = event.api.addListener as Fn;
		const remove = event.api.removeListener as Fn;
		api[name] = {
			...event.api,
			addListener: (fn: unknown, filter?: unknown, extra?: unknown) => {
				if (!filter || !Array.isArray((filter as { urls?: unknown }).urls))
					throw new natives.TypeError(
						`Error in invocation of webRequest.${name}.addListener: filter.urls is required.`,
					);
				add(fn, filter, extra);
				push();
			},
			removeListener: (fn: unknown) => {
				remove(fn);
				push();
			},
		};
	}
	// the worker asks: the listeners this context registered, by tab
	ctx.on('wr', async (message) => {
		if (message.context !== ctx.id) return;
		const details = message.details as Record<string, unknown>;
		const client = String(message.client ?? '');
		if (client) {
			const place = (await ctx
				.hub('tabs.ofClient', client)
				.catch(() => null)) as { tabId: number; frameId: number } | null;
			if (place) {
				details.tabId = place.tabId;
				details.frameId = place.frameId;
			}
		}
		const event = ctx.events.get(`webRequest.${String(message.event)}`);
		const verdicts: Record<string, unknown>[] = [];
		for (const listener of [...(event?.listeners ?? [])]) {
			const [filter] = (listener.options ?? []) as [
				{ tabId?: number; urls?: string[] }?,
			];
			if (typeof filter?.tabId === 'number' && filter.tabId !== details.tabId)
				continue;
			if (!matchesAny(filter?.urls, String(details.url))) continue;
			try {
				const result = listener.fn(copy(details));
				if (result && typeof result === 'object')
					verdicts.push(result as Record<string, unknown>);
			} catch (error) {
				ctx.listenerError(error);
			}
		}
		if (!message.blocking) return;
		const verdict: Record<string, unknown> = {};
		for (const result of verdicts) {
			if (result.cancel) verdict.cancel = true;
			if (typeof result.redirectUrl === 'string' && !verdict.redirectUrl)
				verdict.redirectUrl = result.redirectUrl;
			if (Array.isArray(result.requestHeaders))
				verdict.requestHeaders = copy(result.requestHeaders);
			if (Array.isArray(result.responseHeaders))
				verdict.responseHeaders = copy(result.responseHeaders);
		}
		ctx.post({ t: 'wr-reply', id: message.id, verdict });
	});
	return api;
}

export function declarativeNetRequestApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	const v = { voidResult: true };
	const call = (name: string) => (options?: unknown) =>
		options === undefined
			? ctx.worker('dnr', name)
			: ctx.worker('dnr', name, copy(options));
	return {
		MAX_NUMBER_OF_RULES: 330_000,
		GUARANTEED_MINIMUM_STATIC_RULES: 30_000,
		MAX_NUMBER_OF_DYNAMIC_RULES: 30_000,
		MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
		MAX_NUMBER_OF_SESSION_RULES: 5000,
		MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
		MAX_NUMBER_OF_REGEX_RULES: 1000,
		MAX_NUMBER_OF_STATIC_RULESETS: 100,
		MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
		MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
		GETMATCHEDRULES_QUOTA_INTERVAL: 10,
		DYNAMIC_RULESET_ID: '_dynamic',
		SESSION_RULESET_ID: '_session',
		RuleActionType: {
			BLOCK: 'block',
			REDIRECT: 'redirect',
			ALLOW: 'allow',
			UPGRADE_SCHEME: 'upgradeScheme',
			MODIFY_HEADERS: 'modifyHeaders',
			ALLOW_ALL_REQUESTS: 'allowAllRequests',
		},
		ResourceType: Object.fromEntries(
			[
				'main_frame',
				'sub_frame',
				'stylesheet',
				'script',
				'image',
				'font',
				'object',
				'xmlhttprequest',
				'ping',
				'csp_report',
				'media',
				'websocket',
				'webtransport',
				'webbundle',
				'other',
			].map((type) => [type.toUpperCase(), type]),
		),
		DomainType: { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' },
		HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' },
		RequestMethod: Object.fromEntries(
			[
				'connect',
				'delete',
				'get',
				'head',
				'options',
				'patch',
				'post',
				'put',
				'other',
			].map((method) => [method.toUpperCase(), method]),
		),
		updateDynamicRules: m(call('updateDynamicRules'), v),
		getDynamicRules: m(call('getDynamicRules')),
		updateSessionRules: m(call('updateSessionRules'), v),
		getSessionRules: m(call('getSessionRules')),
		updateEnabledRulesets: m(call('updateEnabledRulesets'), v),
		getEnabledRulesets: m(call('getEnabledRulesets')),
		getAvailableStaticRuleCount: m(call('getAvailableStaticRuleCount')),
		updateStaticRules: m(call('updateStaticRules'), v),
		getDisabledRuleIds: m(call('getDisabledRuleIds')),
		isRegexSupported: m(call('isRegexSupported')),
		getMatchedRules: m(call('getMatchedRules')),
		testMatchOutcome: m(call('testMatchOutcome')),
		setExtensionActionOptions: m(call('setExtensionActionOptions'), v),
		onRuleMatchedDebug: ctx.event('declarativeNetRequest.onRuleMatchedDebug')
			.api,
	};
}

function workerNamespace(
	ctx: Context,
	area: string,
	calls: string[],
	events: string[],
	voids: string[] = [],
) {
	const api: Record<string, unknown> = {};
	for (const name of calls)
		api[name] = ctx.method(
			(...args: unknown[]) => ctx.worker(area, name, ...copy(args)),
			{
				voidResult: voids.includes(name),
			},
		);
	for (const name of events) api[name] = ctx.event(`${area}.${name}`).api;
	return api;
}

export function cookiesApi(ctx: Context) {
	return {
		SameSiteStatus: {
			NO_RESTRICTION: 'no_restriction',
			LAX: 'lax',
			STRICT: 'strict',
			UNSPECIFIED: 'unspecified',
		},
		OnChangedCause: {
			EVICTED: 'evicted',
			EXPIRED: 'expired',
			EXPLICIT: 'explicit',
			EXPIRED_OVERWRITE: 'expired_overwrite',
			OVERWRITE: 'overwrite',
		},
		...workerNamespace(
			ctx,
			'cookies',
			['get', 'getAll', 'set', 'remove', 'getAllCookieStores'],
			['onChanged'],
		),
	};
}

export function permissionsApi(ctx: Context) {
	const api = workerNamespace(
		ctx,
		'permissions',
		['contains', 'getAll', 'request', 'remove'],
		['onAdded', 'onRemoved'],
	);
	return {
		...api,
		addHostAccessRequest: ctx.method(() => undefined, { voidResult: true }),
		removeHostAccessRequest: ctx.method(() => undefined, { voidResult: true }),
	};
}

export function managementApi(ctx: Context) {
	return workerNamespace(
		ctx,
		'management',
		['getSelf', 'get', 'getAll', 'setEnabled', 'uninstallSelf'],
		['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled'],
		['setEnabled', 'uninstallSelf'],
	);
}

export function contextMenusApi(ctx: Context) {
	let next = 1;
	const m = ctx.method.bind(ctx);
	return {
		ACTION_MENU_TOP_LEVEL_LIMIT: 6,
		ContextType: Object.fromEntries(
			[
				'ALL',
				'PAGE',
				'FRAME',
				'SELECTION',
				'LINK',
				'EDITABLE',
				'IMAGE',
				'VIDEO',
				'AUDIO',
				'LAUNCHER',
				'BROWSER_ACTION',
				'PAGE_ACTION',
				'ACTION',
			].map((type) => [type, type.toLowerCase()]),
		),
		create: (
			properties: Record<string, unknown> = {},
			callback?: () => void,
		) => {
			const id = String(properties.id ?? `menu-${next++}`);
			ctx
				.hub('menus.set', id, copy({ ...properties, onclick: undefined, id }))
				.finally(() => {
					if (typeof callback === 'function') callback();
				});
			return id;
		},
		update: m(
			(id: unknown, properties: unknown) =>
				ctx.hub('menus.set', String(id), copy(properties)),
			{
				voidResult: true,
			},
		),
		remove: m((id: unknown) => ctx.hub('menus.remove', String(id)), {
			voidResult: true,
		}),
		removeAll: m(() => ctx.hub('menus.remove', null), { voidResult: true }),
		onClicked: ctx.event('contextMenus.onClicked').api,
	};
}

export function notificationsApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	return {
		TemplateType: {
			BASIC: 'basic',
			IMAGE: 'image',
			LIST: 'list',
			PROGRESS: 'progress',
		},
		PermissionLevel: { GRANTED: 'granted', DENIED: 'denied' },
		create: m((a?: unknown, b?: unknown) => {
			const [id, options] =
				typeof a === 'string'
					? [a || natives.randomUUID(), b ?? {}]
					: [natives.randomUUID(), a ?? {}];
			return ctx.hub('notify', id, copy(options)).then(() => id);
		}),
		update: m((id: string, options: unknown) =>
			ctx.hub('notify', id, copy(options), true),
		),
		clear: m((id: string) => ctx.hub('notify.clear', id)),
		getAll: m(() => ctx.hub('notify.all')),
		getPermissionLevel: m(() => 'granted'),
		onClicked: ctx.event('notifications.onClicked').api,
		onClosed: ctx.event('notifications.onClosed').api,
		onButtonClicked: ctx.event('notifications.onButtonClicked').api,
		onPermissionLevelChanged: ctx.event(
			'notifications.onPermissionLevelChanged',
		).api,
	};
}

export function offscreenApi(ctx: Context) {
	const m = ctx.method.bind(ctx);
	return {
		Reason: Object.fromEntries(
			[
				'TESTING',
				'AUDIO_PLAYBACK',
				'IFRAME_SCRIPTING',
				'DOM_SCRAPING',
				'BLOBS',
				'DOM_PARSER',
				'USER_MEDIA',
				'DISPLAY_MEDIA',
				'WEB_RTC',
				'CLIPBOARD',
				'LOCAL_STORAGE',
				'WORKERS',
				'BATTERY_STATUS',
				'MATCH_MEDIA',
				'GEOLOCATION',
			].map((reason) => [reason, reason]),
		),
		createDocument: m(
			(parameters: { url: string }) =>
				ctx.hub('offscreen.create', ownPath(String(parameters?.url ?? ''))),
			{ voidResult: true },
		),
		closeDocument: m(() => ctx.hub('offscreen.close'), { voidResult: true }),
		hasDocument: m(() => ctx.hub('offscreen.has')),
	};
}

export function commandsApi(ctx: Context) {
	const commands = (ctx.ext.manifest.commands ?? {}) as Record<
		string,
		{ description?: string; suggested_key?: Record<string, string> }
	>;
	return {
		getAll: ctx.method(() =>
			Object.entries(commands).map(([name, command]) => ({
				name,
				description: command.description ?? '',
				shortcut: command.suggested_key?.default ?? '',
			})),
		),
		onCommand: ctx.event('commands.onCommand').api,
	};
}

export function idleApi(ctx: Context) {
	return {
		IdleState: { ACTIVE: 'active', IDLE: 'idle', LOCKED: 'locked' },
		queryState: ctx.method(() => 'active'),
		setDetectionInterval: () => {},
		getAutoLockDelay: ctx.method(() => 0),
		onStateChanged: ctx.event('idle.onStateChanged').api,
	};
}

const NOT_NAMESPACES = new Set([
	'activeTab',
	'background',
	'clipboardRead',
	'clipboardWrite',
	'declarativeNetRequestFeedback',
	'declarativeNetRequestWithHostAccess',
	'geolocation',
	'unlimitedStorage',
	'webRequestBlocking',
	'webRequestAuthProvider',
]);

/** the chrome object of a context */
export function buildChrome(ctx: Context): Record<string, unknown> {
	const manifest = ctx.ext.manifest;
	const chrome: Record<string, unknown> = {
		runtime: runtimeApi(ctx),
		storage: storageApi(ctx),
		i18n: i18nApi(ctx),
		extension: extensionApi(ctx),
		dom: {
			openOrClosedShadowRoot: (element: Element) =>
				(element as Element & { openOrClosedShadowRoot?: ShadowRoot })
					?.shadowRoot ?? null,
		},
	};
	if (ctx.kind === 'content') return chrome;
	const mv3 = Number(manifest.manifest_version) >= 3;
	const granted = new Set(ctx.ext.permissions);
	Object.assign(chrome, {
		tabs: tabsApi(ctx),
		windows: windowsApi(ctx),
		alarms: alarmsApi(ctx),
		permissions: permissionsApi(ctx),
		contextMenus: contextMenusApi(ctx),
		notifications: notificationsApi(ctx),
		commands: commandsApi(ctx),
		idle: idleApi(ctx),
		management: managementApi(ctx),
		webRequest: webRequestApi(ctx),
		cookies: cookiesApi(ctx),
		declarativeNetRequest: declarativeNetRequestApi(ctx),
	});
	if (granted.has('declarativeContent'))
		chrome.declarativeContent = declarativeContentApi(ctx);
	if (granted.has('webNavigation'))
		chrome.webNavigation = webNavigationApi(ctx);
	if (granted.has('userScripts'))
		chrome.userScripts = workerNamespace(
			ctx,
			'userScripts',
			[
				'register',
				'update',
				'unregister',
				'getScripts',
				'configureWorld',
				'getWorldConfigurations',
				'resetWorldConfiguration',
			],
			[],
			[
				'register',
				'update',
				'unregister',
				'configureWorld',
				'resetWorldConfiguration',
			],
		);
	if (granted.has('userScripts'))
		// a user script run once in a tab's frames, in the USER_SCRIPT world
		(chrome.userScripts as Record<string, unknown>).execute = ctx.method(
			async (injection: {
				js?: { code?: string; file?: string }[];
				target: Target;
			}) => {
				const js = injection?.js ?? [];
				if (!js.length)
					throw new ApiError('At least one js source is required.');
				const source = js.every((item) => typeof item.file === 'string')
					? { files: js.map((item) => String(item.file)) }
					: js.every((item) => typeof item.code === 'string')
						? { code: js.map((item) => item.code).join('\n;\n') }
						: null;
				if (!source)
					throw new ApiError(
						'STomp runs a userScripts.execute whose sources are all code or all files.',
					);
				return inject(ctx, injection.target, {
					...source,
					world: 'USER_SCRIPT',
				});
			},
		);
	if (mv3)
		Object.assign(chrome, {
			action: actionApi(ctx, 'action'),
			scripting: scriptingApi(ctx),
			offscreen: offscreenApi(ctx),
		});
	else {
		chrome.browserAction = actionApi(ctx, 'browserAction');
		if (manifest.page_action) chrome.pageAction = actionApi(ctx, 'pageAction');
		if (granted.has('scripting')) chrome.scripting = scriptingApi(ctx);
	}
	if (granted.has('contextMenus')) chrome.menus = chrome.contextMenus;
	for (const permission of granted) {
		const name = permission.split('.')[0];
		if (
			/^[a-z][a-zA-Z]+$/.test(name) &&
			!(name in chrome) &&
			!NOT_NAMESPACES.has(name)
		)
			chrome[name] = stubNamespace(ctx, name);
	}
	return chrome;
}
