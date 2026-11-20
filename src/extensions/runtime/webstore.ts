// The Chrome Web Store's page (docs/extensions.md "The Chrome Web Store"):
// Chrome gives https://chromewebstore.google.com/* chrome.webstorePrivate
// and chrome.management, and chrome.runtime's members a web page has, which
// the store's "Add to Chrome" and "Remove from Chrome" buttons call. They
// are defined here, on the page's own `chrome`, as Chrome's bindings make
// them: in its order, functions of length 0 shown as native, a call checked
// against its schema (a TypeError as Chrome words it), a callback with
// runtime.lastError set during it or a promise. Each call goes to the
// worker (`extapi`, src/server/extensions/webstore.ts), which answers only
// a document whose URL is the store's; this file decides nothing. The
// events come from the extensions' change channel, in Chrome's order.
import { copy, messageOf, NO_RECEIVER } from './context';
import { listen, natives } from './natives';
import { methodLike } from './present';

/** a parameter: its name, its type (an object's properties, or a $ref's name), whether it may be left out */
type Param = [
	name: string,
	type: string,
	optional?: boolean,
	properties?: Record<
		string,
		[type: string, optional: boolean, min?: number, max?: number]
	>,
];

/** a function: its parameters, and whether it answers (a callback or a promise) */
type Spec = [params: Param[], async: boolean];

const ID: Param = ['id', 'string'];
const EXPECTED: Param = ['expected_id', 'string'];

const WEBSTORE: Record<string, Spec> = {
	beginInstallWithManifest3: [
		[
			[
				'details',
				'object',
				false,
				{
					id: ['string', false, 32, 32],
					manifest: ['string', false, 1],
					iconUrl: ['string', true],
					localizedName: ['string', true],
					locale: ['string', true],
					appInstallBubble: ['boolean', true],
					enableLauncher: ['boolean', true],
					authuser: ['string', true],
					esbAllowlist: ['boolean', true],
				},
			],
		],
		true,
	],
	completeInstall: [[EXPECTED], true],
	enableAppLauncher: [[], true],
	getBrowserLogin: [[], true],
	getExtensionStatus: [[ID, ['manifest', 'string', true]], true],
	getFullChromeVersion: [[], true],
	getIsLauncherEnabled: [[], true],
	getMV2DeprecationStatus: [[], true],
	getReferrerChain: [[], true],
	getStoreLogin: [[], true],
	getWebGLStatus: [[], true],
	install: [[EXPECTED], true],
	isInIncognitoMode: [[], true],
	isPendingCustodianApproval: [[ID], true],
	logEnterprisePromoShown: [[], false],
	onEnterprisePromoClick: [[], false],
	setStoreLogin: [[['login', 'string']], true],
	shouldShowEnterprisePromotionBanner: [[], true],
};

const MANAGEMENT: Record<string, Spec> = {
	createAppShortcut: [[ID], true],
	generateAppForLink: [
		[
			['url', 'string'],
			['title', 'string'],
		],
		true,
	],
	get: [[ID], true],
	getAll: [[], true],
	getPermissionWarningsById: [[ID], true],
	launchApp: [[ID], true],
	setEnabled: [[ID, ['enabled', 'boolean']], true],
	setLaunchType: [[ID, ['launchType', 'management.LaunchType']], true],
	uninstall: [
		[
			ID,
			[
				'options',
				'management.UninstallOptions',
				true,
				{ showConfirmDialog: ['boolean', true] },
			],
		],
		true,
	],
};

/** an enum as the bindings make it: SCREAMING_CASE keys, sorted */
const enumOf = (values: string[]) => {
	const made: Record<string, string> = {};
	for (const value of [...values].sort((a, b) =>
		a.toUpperCase() < b.toUpperCase() ? -1 : 1,
	))
		made[value.toUpperCase().replace(/-/g, '_')] = value;
	return made;
};

const WEBSTORE_ENUMS: Record<string, string[]> = {
	ExtensionInstallStatus: [
		'can_request',
		'request_pending',
		'blocked_by_policy',
		'installable',
		'enabled',
		'disabled',
		'terminated',
		'blacklisted',
		'custodian_approval_required',
		'custodian_approval_required_for_installation',
		'force_installed',
		'deprecated_manifest_version',
		'corrupted',
	],
	MV2DeprecationStatus: ['inactive', 'warning', 'soft_disable', 'hard_disable'],
	PromotionType: [
		'CHROME_ENTERPRISE_CORE',
		'CHROME_ENTERPRISE_PREMIUM',
		'PROMOTION_TYPE_UNSPECIFIED',
	],
	Result: [
		'',
		'success',
		'user_gesture_required',
		'unknown_error',
		'feature_disabled',
		'unsupported_extension_type',
		'missing_dependencies',
		'install_error',
		'user_cancelled',
		'invalid_id',
		'blacklisted',
		'blocked_by_policy',
		'install_in_progress',
		'launch_in_progress',
		'manifest_error',
		'icon_error',
		'invalid_icon_url',
		'already_installed',
		'blocked_for_child_account',
	],
	WebGlStatus: ['webgl_allowed', 'webgl_blocked'],
};

const MANAGEMENT_ENUMS: Record<string, string[]> = {
	ExtensionDisabledReason: ['unknown', 'permissions_increase'],
	ExtensionInstallType: ['admin', 'development', 'normal', 'sideload', 'other'],
	ExtensionType: [
		'extension',
		'hosted_app',
		'packaged_app',
		'legacy_packaged_app',
		'theme',
		'login_screen_extension',
	],
	LaunchType: [
		'OPEN_AS_REGULAR_TAB',
		'OPEN_AS_PINNED_TAB',
		'OPEN_AS_WINDOW',
		'OPEN_FULL_SCREEN',
	],
};

const RUNTIME_ENUMS: Record<string, string[]> = {
	ContextType: [
		'TAB',
		'POPUP',
		'BACKGROUND',
		'OFFSCREEN_DOCUMENT',
		'SIDE_PANEL',
		'DEVELOPER_TOOLS',
	],
	OnInstalledReason: [
		'install',
		'update',
		'chrome_update',
		'shared_module_update',
	],
	OnLoadedReason: [
		'install',
		'update',
		'browser_update',
		'enable',
		'startup',
		'reload',
	],
	OnRestartRequiredReason: ['app_update', 'os_update', 'periodic'],
	PlatformArch: [
		'arm',
		'arm64',
		'x86-32',
		'x86-64',
		'mips',
		'mips64',
		'riscv64',
	],
	PlatformNaclArch: ['arm', 'x86-32', 'x86-64', 'mips', 'mips64'],
	PlatformOs: ['mac', 'win', 'android', 'cros', 'linux', 'openbsd'],
	RequestUpdateCheckStatus: ['throttled', 'no_update', 'update_available'],
};

/** a value's type as the bindings name it in an error (GetV8ValueTypeString) */
function typeOf(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number')
		return (value | 0) === value && !Object.is(value, -0)
			? 'integer'
			: 'number';
	if (value instanceof ArrayBuffer) return 'binary';
	return typeof value === 'bigint' || typeof value === 'symbol'
		? 'object'
		: typeof value;
}

/** whether a value may be the parameter (ArgumentSpec::IsCorrectType: its type only) */
const fits = (param: Param, value: unknown) =>
	param[1] === 'boolean'
		? typeof value === 'boolean'
		: param[3]
			? value !== null && typeof value === 'object'
			: typeof value === 'string';

/** the parameters each argument is, as ResolveArguments matches them (an optional one may be left out) */
function resolve(given: unknown[], params: Param[]): unknown[] | null {
	if (!given.length && !params.length) return [];
	if (given.length > params.length) return null;
	const [param] = params;
	if (
		given.length &&
		((param[2] && (given[0] === null || given[0] === undefined)) ||
			fits(param, given[0]))
	) {
		const rest = resolve(given.slice(1), params.slice(1));
		if (rest)
			return [
				given[0] === null || given[0] === undefined ? undefined : given[0],
				...rest,
			];
	}
	if (param[2]) {
		const rest = resolve(given, params.slice(1));
		if (rest) return [undefined, ...rest];
	}
	return null;
}

/** an argument checked against its parameter (ArgumentSpec::ParseArgument), the error's words or null */
function checkArgument(param: Param, value: unknown): string | null {
	const properties = param[3];
	if (value === undefined || !properties) return null;
	const object = value as Record<string, unknown>;
	for (const key in properties) {
		const [type, optional, min, max] = properties[key];
		const item = object[key];
		if (item === undefined || item === null) {
			if (!optional) return `Missing required property '${key}'.`;
			continue;
		}
		const found = typeOf(item);
		if (found !== type)
			return `Error at property '${key}': Invalid type: expected ${type}, found ${found}.`;
		const length = typeof item === 'string' ? item.length : 0;
		if (min !== undefined && length < min)
			return `Error at property '${key}': String must have at least ${min} characters; found ${length}.`;
		if (max !== undefined && length > max)
			return `Error at property '${key}': String must have at most ${max} characters; found ${length}.`;
	}
	return null;
}

const signatureOf = ([params, async]: Spec) =>
	[
		...params.map(
			([name, type, optional]) =>
				`${optional ? 'optional ' : ''}${type} ${name}`,
		),
		...(async ? ['optional function callback'] : []),
	].join(', ');

/** what the worker answered of a call (webstore.ts StoreAnswer) */
type Answer = { value?: unknown; error?: string; result?: unknown };

/** define the store's API on the page's `chrome` */
export function storePage(channel: string, changes: string, token: string) {
	const global = natives.global as Record<string, unknown>;
	const define = (target: object, key: string, value: unknown) =>
		natives.defineProperty(target, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	let chrome = global.chrome as Record<string, unknown> | undefined;
	if (!chrome || typeof chrome !== 'object') {
		chrome = {};
		define(global, 'chrome', chrome);
	}
	const runtime = (
		chrome.runtime && typeof chrome.runtime === 'object' ? chrome.runtime : {}
	) as Record<string, unknown>;

	// runtime.lastError: set while a callback runs (api_last_error.cc)
	let lastError: { message: string } | undefined;
	let checked = false;
	const lastErrorGet = methodLike({ name: 'get lastError', length: 0 }, () => {
		checked = true;
		return lastError;
	});
	const answer = (
		cb: (...values: unknown[]) => unknown,
		error: string | undefined,
		values: unknown[],
	) => {
		if (error !== undefined) {
			lastError = { message: error };
			checked = false;
			natives.defineProperty(runtime, 'lastError', {
				get: lastErrorGet as () => unknown,
				enumerable: true,
				configurable: true,
			});
		}
		try {
			cb(...values);
		} catch (thrown) {
			// (the page's exception, reported as its own)
			natives.setTimeout(() => {
				throw thrown;
			}, 0);
		} finally {
			if (error !== undefined) {
				delete runtime.lastError;
				if (!checked)
					natives.console.error(`Unchecked runtime.lastError: ${error}`);
				lastError = undefined;
			}
		}
	};

	const post = async (area: string, name: string, args: unknown[]) => {
		try {
			const response = await natives.fetch(`${channel}extapi`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: natives.JSON.stringify({
					store: true,
					token,
					area,
					call: name,
					args,
				}),
			});
			return natives.JSON.parse(await response.text()) as Answer;
		} catch (error) {
			return { error: messageOf(error) } as Answer;
		}
	};

	/** the infos the page was given, for the events that name a removed one */
	const infos = new Map<string, unknown>();
	const keep = (value: unknown) => {
		for (const info of Array.isArray(value) ? value : [value])
			if (info && typeof info === 'object' && 'id' in info)
				infos.set(String((info as { id: unknown }).id), info);
	};

	const api = (
		area: string,
		specs: Record<string, Spec>,
		target: Record<string, unknown>,
	) => {
		for (const name in specs) {
			const spec = specs[name];
			const fail = (detail: string) =>
				new natives.TypeError(
					`Error in invocation of ${area}.${name}(${signatureOf(spec)}): ${detail}`,
				);
			define(
				target,
				name,
				methodLike({ name, length: 0 }, (given) => {
					let args = given;
					let cb: ((...values: unknown[]) => unknown) | null = null;
					let resolved: unknown[] | null = null;
					const last = args[args.length - 1];
					if (
						spec[1] &&
						args.length &&
						(typeof last === 'function' || last === null || last === undefined)
					) {
						resolved = resolve(args.slice(0, -1), spec[0]);
						if (resolved && typeof last === 'function')
							cb = last as (...values: unknown[]) => unknown;
					}
					resolved ??= resolve(args, spec[0]);
					if (!resolved) throw fail('No matching signature.');
					for (let index = 0; index < spec[0].length; index++) {
						const error = checkArgument(spec[0][index], resolved[index]);
						if (error)
							throw fail(`Error at parameter '${spec[0][index][0]}': ${error}`);
					}
					args = resolved;
					while (args.length && args[args.length - 1] === undefined)
						args = args.slice(0, -1);
					if (!spec[1]) return undefined;
					const reply = post(area, name, copy(args));
					if (cb) {
						const callback = cb;
						reply.then((got) => {
							if (
								area === 'management' &&
								(name === 'getAll' || name === 'get')
							)
								keep(got.value);
							if (typeof got.error === 'string')
								answer(
									callback,
									got.error,
									'result' in got ? [got.result] : [],
								);
							else
								answer(
									callback,
									undefined,
									got.value === undefined ? [] : [got.value],
								);
						});
						return undefined;
					}
					return new natives.Promise((resolve, reject) => {
						reply.then((got) => {
							if (
								area === 'management' &&
								(name === 'getAll' || name === 'get')
							)
								keep(got.value);
							if (typeof got.error === 'string')
								reject(new natives.Error(got.error));
							else resolve(got.value);
						});
					});
				}),
			);
		}
	};
	const enums = (target: object, list: Record<string, string[]>) => {
		for (const name in list) define(target, name, enumOf(list[name]));
	};

	// the events: one prototype, as the bindings' event objects share theirs
	const listeners = new WeakMap<object, { event: string; list: Function[] }>();
	const eventProto: Record<string, unknown> = {};
	const eventMethod = (
		name: string,
		run: (list: Function[], args: unknown[]) => unknown,
	) =>
		methodLike({ name, length: 0 }, function (this: unknown, args) {
			const own = listeners.get(this as object);
			if (!own) throw new natives.TypeError('Illegal invocation');
			if (
				name !== 'hasListeners' &&
				name !== 'dispatch' &&
				typeof args[0] !== 'function'
			)
				throw new natives.TypeError(
					`Error in invocation of management.${own.event}.${name}(function callback): No matching signature.`,
				);
			return run(own.list, args);
		});
	const events = ['onDisabled', 'onEnabled', 'onUninstalled', 'onInstalled'];
	const made: Record<string, object> = {};
	for (const name of events)
		made[name] = natives.setPrototypeOf({}, eventProto);
	const dispatch = (list: Function[], args: unknown[]) => {
		for (const listener of [...list])
			try {
				listener(...args);
			} catch (thrown) {
				natives.setTimeout(() => {
					throw thrown;
				}, 0);
			}
	};
	const methods: [string, (list: Function[], args: unknown[]) => unknown][] = [
		[
			'addListener',
			(list, [fn]) => {
				if (!list.includes(fn as Function)) list.push(fn as Function);
			},
		],
		[
			'removeListener',
			(list, [fn]) => {
				const at = list.indexOf(fn as Function);
				if (at >= 0) list.splice(at, 1);
			},
		],
		['hasListener', (list, [fn]) => list.includes(fn as Function)],
		['hasListeners', (list) => list.length > 0],
		['dispatch', (list, args) => dispatch(list, args)],
	];
	for (const [name, run] of methods)
		define(eventProto, name, eventMethod(name, run));
	const constructor = methodLike({ name: '', length: 0 }, () => {
		throw new natives.TypeError('Illegal constructor');
	});
	define(eventProto, 'constructor', constructor);
	for (const name of events)
		listeners.set(made[name], { event: name, list: [] });

	const webstorePrivate: Record<string, unknown> = {};
	api('webstorePrivate', WEBSTORE, webstorePrivate);
	enums(webstorePrivate, WEBSTORE_ENUMS);
	const management: Record<string, unknown> = {};
	for (const name of events) define(management, name, made[name]);
	api('management', MANAGEMENT, management);
	enums(management, MANAGEMENT_ENUMS);
	define(chrome, 'webstorePrivate', webstorePrivate);
	define(chrome, 'management', management);

	// chrome.runtime as a web page has it: messages to an extension that
	// lists the page in externally_connectable, which none here does
	if (!chrome.runtime || typeof chrome.runtime !== 'object') {
		define(runtime, 'dynamicId', undefined);
		define(runtime, 'id', undefined);
		const messaging = (
			name: string,
			signature: string,
			run: (args: unknown[]) => unknown,
		) =>
			define(
				runtime,
				name,
				methodLike({ name, length: 0 }, (args) => {
					if (typeof args[0] !== 'string')
						throw new natives.TypeError(
							`Error in invocation of runtime.${name}(${signature}): chrome.runtime.${name}() called from a webpage must specify an Extension ID (string) for its first argument.`,
						);
					return run(args);
				}),
			);
		messaging(
			'connect',
			'optional string extensionId, optional object connectInfo',
			(args) => {
				const info = args[1] as { name?: unknown } | undefined;
				const port: Record<string, unknown> = {
					name: typeof info?.name === 'string' ? info.name : '',
				};
				const disconnected: Function[] = [];
				const portEvent = (list: Function[]) => ({
					addListener: (fn: Function) => list.push(fn),
					removeListener: (fn: Function) => {
						const at = list.indexOf(fn);
						if (at >= 0) list.splice(at, 1);
					},
					hasListener: (fn: Function) => list.includes(fn),
					hasListeners: () => list.length > 0,
				});
				port.onDisconnect = portEvent(disconnected);
				port.onMessage = portEvent([]);
				port.postMessage = () => {
					throw new natives.Error(
						'Attempting to use a disconnected port object',
					);
				};
				port.disconnect = () => {};
				natives.setTimeout(() => {
					for (const fn of [...disconnected])
						answer(fn as (...values: unknown[]) => unknown, NO_RECEIVER, [
							port,
						]);
				}, 0);
				return port;
			},
		);
		messaging(
			'sendMessage',
			'optional string extensionId, any message, optional object options, optional function callback',
			(args) => {
				const cb = args.length > 1 ? args[args.length - 1] : undefined;
				if (typeof cb === 'function') {
					natives.setTimeout(
						() =>
							answer(cb as (...values: unknown[]) => unknown, NO_RECEIVER, []),
						0,
					);
					return undefined;
				}
				return natives.Promise.reject(new natives.Error(NO_RECEIVER));
			},
		);
		enums(runtime, RUNTIME_ENUMS);
		define(chrome, 'runtime', runtime);
	}

	// what changed of the extensions, as Chrome's events tell it
	const fire = (name: string, args: unknown[]) =>
		dispatch(listeners.get(made[name])?.list ?? [], args);
	const infoOf = async (id: string) => {
		const got = await post('management', 'get', [id]);
		if (got.value) keep(got.value);
		return got.value;
	};
	try {
		const bus = new natives.BroadcastChannel(changes);
		listen(bus, 'message', async (event: MessageEvent) => {
			const change = event.data as { type?: string; id?: string };
			const id = typeof change?.id === 'string' ? change.id : '';
			if (!id) return;
			switch (change.type) {
				case 'installed': {
					const info = await infoOf(id);
					if (!info) return;
					if ((info as { enabled?: boolean }).enabled)
						fire('onEnabled', [copy(info)]);
					fire('onInstalled', [copy(info)]);
					return;
				}
				case 'updated': {
					const before = infos.get(id);
					const info = await infoOf(id);
					if (!info) return;
					if (before) fire('onDisabled', [copy(before)]);
					if ((info as { enabled?: boolean }).enabled)
						fire('onEnabled', [copy(info)]);
					fire('onInstalled', [copy(info)]);
					return;
				}
				case 'enabled':
				case 'disabled': {
					const info = await infoOf(id);
					if (info)
						fire(change.type === 'enabled' ? 'onEnabled' : 'onDisabled', [
							copy(info),
						]);
					return;
				}
				case 'removed': {
					const before = infos.get(id) as { enabled?: boolean } | undefined;
					infos.delete(id);
					if (before?.enabled)
						fire('onDisabled', [copy({ ...before, enabled: false })]);
					fire('onUninstalled', [id]);
					return;
				}
			}
		});
	} catch (error) {
		// (no channel: the page hears no change)
	}
}
