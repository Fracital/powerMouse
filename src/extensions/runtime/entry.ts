// The extensions' runtime (dist/extensionsRuntime.js, docs/extensions.md):
// the shell of a document an extension reaches loads it before the inject
// bundle, hands it the payload the worker wrote (`prepare`), and loads the
// content scripts' routes, each of which only defines a function
// (`define`). It starts as the page's document opens, which the inject does
// right before it writes the page's markup, and runs document_start once
// the first write made the page's root element: the inject writes the
// markup in pieces that each end before a `</script`, so no script of the
// page has run there (Chrome's DidCreateDocumentElement point). A content
// script runs as a function of its world's `chrome`; an extension page gets
// `chrome` on its window.
import {
	CONTENT_SCRIPT_ROUTE,
	CONTEXT_NAME_PREFIX,
	IMPORTED_META,
	RUNTIME_GLOBAL,
	type RuntimePayload,
	type ShippedEntry,
	type ShippedExtension,
} from '../types';
import { buildChrome } from './api';
import { Context, copy, messageOf } from './context';
import { receiveMessages } from './messaging';
import { call, natives } from './natives';

type Defined = (...args: unknown[]) => unknown;

let payload: RuntimePayload | null = null;
let nonce = '';
let started = false;
const defined = new Map<string, Defined>();
const waiting = new Map<string, (fn: Defined) => void>();

const global = globalThis as typeof globalThis & Record<string, unknown>;
/** the frame's name as the hub gave it, read before the inject runs (it shadows the name for the page) */
const frameName = natives.windowName(global) ?? '';

const runtime = {
	/** the shell's payload (once) */
	prepare(given: RuntimePayload) {
		if (payload) return;
		payload = given;
		const script = natives.currentScript(natives.document);
		nonce = script?.nonce ?? '';
	},
	/**
	 * a route's function: taken only from the route's own script element, so
	 * nothing the page runs can stand in for an extension's code
	 */
	define(id: string, key: string, fn: Defined) {
		const script = natives.currentScript(natives.document);
		const src = script ? natives.scriptSrc(script) : '';
		if (
			typeof fn !== 'function' ||
			!src.includes(`/${CONTENT_SCRIPT_ROUTE}/${id}/`) ||
			!src.split('?')[0].endsWith(`/${key}.js`)
		)
			return;
		const name = `${id}|${key}`;
		const waiter = waiting.get(name);
		if (waiter) {
			waiting.delete(name);
			waiter(fn);
		} else defined.set(name, fn);
	},
};

natives.defineProperty(global, RUNTIME_GLOBAL, {
	value: runtime,
	configurable: true,
	writable: true,
	enumerable: false,
});

// the inject opens the page's document right before it writes the page's
// markup: the runtime starts there. A wrapper named and shaped as the
// native, which the inject hooks over in turn (the page sees the inject's
// hook, which reads as native)
const nativeOpen = natives.documentOpen;
const wrapped = {
	open(this: Document, ...args: unknown[]) {
		const result = natives.Reflect.apply(nativeOpen, this, args);
		if (!started && this === natives.document && payload) {
			started = true;
			// (a page with no markup at all gets its document_start runs at
			// DOMContentLoaded, as it never gets a root)
			if (!natives.documentElement(this)) {
				rootWaiting = [];
				call(
					natives.addEventListener,
					natives.document,
					'DOMContentLoaded',
					rooted,
					{ once: true },
				);
			}
			try {
				start(payload);
			} catch (error) {
				console.error('STomp: the extensions could not start:', error);
			}
		}
		return result;
	},
}.open;
natives.defineProperty(global.Document.prototype, 'open', {
	value: wrapped,
	writable: true,
	configurable: true,
	enumerable: true,
});

/** document_start's runs, until a write made the page's root element */
let rootWaiting: (() => void)[] | null = null;
function whenRooted(run: () => void) {
	if (rootWaiting) rootWaiting.push(run);
	else run();
}
function rooted() {
	const runs = rootWaiting ?? [];
	rootWaiting = null;
	for (const run of runs) run();
}
const nativeWrite = natives.documentWrite;
const wrappedWrite = {
	write(this: Document, ...args: unknown[]) {
		const result = natives.Reflect.apply(nativeWrite, this, args);
		if (
			rootWaiting &&
			this === natives.document &&
			natives.documentElement(this)
		)
			rooted();
		return result;
	},
}.write;
natives.defineProperty(global.Document.prototype, 'write', {
	value: wrappedWrite,
	writable: true,
	configurable: true,
	enumerable: true,
});

/** a stylesheet of an extension's, on the document as Chrome's injected sheets are: no element of the page's */
function addSheet(css: string): CSSStyleSheet | null {
	if (!css || !natives.adoptedStyleSheets?.get) return null;
	const sheet = new natives.CSSStyleSheet();
	try {
		sheet.replaceSync(css);
	} catch (error) {
		return null;
	}
	const list = call<CSSStyleSheet[]>(
		natives.adoptedStyleSheets.get,
		natives.document,
	);
	call(natives.adoptedStyleSheets.set!, natives.document, [...list, sheet]);
	return sheet;
}

function removeSheet(sheet: CSSStyleSheet) {
	if (!natives.adoptedStyleSheets?.get) return;
	const list = call<CSSStyleSheet[]>(
		natives.adoptedStyleSheets.get,
		natives.document,
	);
	call(
		natives.adoptedStyleSheets.set!,
		natives.document,
		list.filter((other) => other !== sheet),
	);
}

/** the function a route defines, once its script has run */
function definedFn(id: string, key: string): Promise<Defined> {
	const name = `${id}|${key}`;
	const found = defined.get(name);
	if (found) return natives.Promise.resolve(found);
	return new natives.Promise((resolve) => waiting.set(name, resolve));
}

/** the route loads under way, and whether they put the global there (the document's own entries may have it already) */
let loading = 0;
let ownGlobal = false;

/** load a route's script now (an injection): its function, when it ran */
function loadRoute(id: string, key: string, route: string): Promise<Defined> {
	const loaded = definedFn(id, key);
	// (the global is there while any load is under way: two injections at
	// once share it, and the last to finish takes it away)
	if (loading++ === 0 && !(RUNTIME_GLOBAL in global)) {
		natives.defineProperty(global, RUNTIME_GLOBAL, {
			value: runtime,
			configurable: true,
			writable: true,
			enumerable: false,
		});
		ownGlobal = true;
	}
	const script = call<HTMLScriptElement>(
		natives.createElement,
		natives.document,
		'script',
	);
	if (nonce) call(natives.setAttribute, script, 'nonce', nonce);
	call(natives.setAttribute, script, 'src', route);
	const parent = natives.documentElement(natives.document) ?? natives.document;
	let finished = false;
	const done = () => {
		if (finished) return;
		finished = true;
		try {
			call(natives.removeChild, parent, script);
		} catch (error) {
			// the page took it out already
		}
		if (--loading === 0 && ownGlobal) {
			delete global[RUNTIME_GLOBAL];
			ownGlobal = false;
		}
	};
	loaded.then(done, done);
	call(natives.addEventListener, script, 'error', () => {
		done();
		waiting.get(`${id}|${key}`)?.(() => {
			throw new natives.Error(`Could not load the script ${route}`);
		});
	});
	call(natives.appendChild, parent, script);
	return loaded;
}

/**
 * Run an isolated world's code with the window's `chrome` the extension's:
 * what the script reads of `window.chrome`, `self.chrome` or
 * `globalThis.chrome` as it runs (the worker rewrote the plain forms of
 * those to its `chrome` already, for what reads them later)
 */
function inWorld<T>(chrome: unknown, run: () => T): T {
	const had = natives.getOwnPropertyDescriptor(global, 'chrome');
	let swapped = false;
	try {
		natives.defineProperty(global, 'chrome', {
			value: chrome,
			writable: true,
			configurable: true,
			enumerable: had?.enumerable ?? true,
		});
		swapped = true;
	} catch (error) {
		// the page made its own unconfigurable: the rewritten forms stand
	}
	try {
		return run();
	} finally {
		if (swapped)
			if (had) natives.defineProperty(global, 'chrome', had);
			else delete global.chrome;
	}
}

/** a USER_SCRIPT world's `chrome`: messaging alone, where configureWorld allowed it */
function userScriptChrome(ctx: Context, given: RuntimePayload): unknown {
	if (!ctx.ext.userScriptMessaging) return undefined;
	const world = new Context(
		ctx.ext,
		'content',
		given.channel,
		given.url,
		ctx.token,
	);
	world.userScript = true;
	world.placed = ctx.placed.then(() => {
		world.place = ctx.place;
	});
	receiveMessages(world);
	const runtime = buildChrome(world).runtime as Record<string, unknown>;
	return {
		runtime: {
			id: runtime.id,
			sendMessage: runtime.sendMessage,
			connect: runtime.connect,
		},
	};
}

function runEntry(
	ctx: Context,
	chrome: unknown,
	entry: ShippedEntry,
	userChrome: () => unknown,
) {
	if (!entry.js) return;
	definedFn(ctx.ext.id, entry.key).then((fn) => {
		try {
			if (entry.world === 'MAIN') natives.Reflect.apply(fn, global, []);
			else if (entry.world === 'USER_SCRIPT') {
				// its window's chrome is its world's too (`const { chrome } = window`)
				const own = userChrome();
				inWorld(own, () => natives.Reflect.apply(fn, global, [own, undefined]));
			} else
				inWorld(chrome, () =>
					natives.Reflect.apply(fn, global, [chrome, undefined]),
				);
		} catch (error) {
			console.error(error);
		}
	});
}

/**
 * When each run_at point comes: document_start once the root is written,
 * document_end after the document's DOMContentLoaded listeners (on the
 * window, where the event ends), document_idle a task after that or at the
 * window's load, whichever is first
 */
function schedule(runAt: string, run: () => void) {
	if (runAt === 'document_start') return whenRooted(run);
	const idle = () => {
		let ran = false;
		const once = () => {
			if (ran) return;
			ran = true;
			run();
		};
		natives.setTimeout(once, 0);
		call(natives.addEventListener, global, 'load', once, { once: true });
	};
	const later = runAt === 'document_end' ? run : idle;
	if (natives.readyState(natives.document) !== 'loading') return later();
	call(natives.addEventListener, global, 'DOMContentLoaded', later, {
		once: true,
	});
}

function contentContext(given: RuntimePayload, ext: ShippedExtension) {
	const ctx = new Context(
		ext,
		'content',
		given.channel,
		given.url,
		given.tokens[ext.id],
	);
	const chrome = buildChrome(ctx);
	receiveMessages(ctx);
	ctx.placed = ctx
		.hub('hello', {
			client: given.client,
			url: given.url,
			top: given.top,
			name: '',
		})
		.then((place) => {
			if (place) ctx.place = place as Context['place'];
			ctx.announce();
		})
		.catch(() => {
			ctx.announce();
		});
	// the CSS goes in first, before any of the page's markup
	for (const entry of ext.entries ?? []) addSheet(entry.css);
	let userChrome: { value: unknown } | null = null;
	const userWorld = () =>
		(userChrome ??= { value: userScriptChrome(ctx, given) }).value;
	for (const entry of ext.entries ?? [])
		schedule(entry.runAt, () => runEntry(ctx, chrome, entry, userWorld));
	// what the extension's other contexts inject (scripting, tabs)
	const sheets = new Map<string, CSSStyleSheet>();
	ctx.on('exec', async (message) => {
		if (message.tabId !== ctx.place.tabId) return;
		const frames = message.frames as number[] | null;
		if (frames && !frames.includes(ctx.place.frameId)) return;
		const reply = (more: Record<string, unknown>) =>
			ctx.post({
				t: 'exec-res',
				id: message.id,
				to: message.from,
				ctx: ctx.id,
				frameId: ctx.place.frameId,
				...more,
			});
		if (typeof message.cssKey === 'string') {
			const key = message.cssKey;
			if (message.remove) {
				const sheet = sheets.get(key);
				if (sheet) removeSheet(sheet);
				sheets.delete(key);
			} else {
				const sheet = addSheet(String(message.css ?? ''));
				if (sheet) sheets.set(key, sheet);
			}
			return reply({});
		}
		try {
			const fn = await loadRoute(
				ctx.ext.id,
				String(message.key),
				String(message.route),
			);
			let result: unknown;
			const take = (value: unknown) => {
				result = value;
			};
			// a MAIN world's function takes only the result's callback; a
			// USER_SCRIPT world's chrome is its own (userScripts.execute)
			const own = message.world === 'USER_SCRIPT' ? userWorld() : chrome;
			if (fn.length < 3) natives.Reflect.apply(fn, global, [take]);
			else
				inWorld(own, () =>
					natives.Reflect.apply(fn, global, [own, undefined, take]),
				);
			if (result && typeof (result as Promise<unknown>).then === 'function')
				result = await result;
			reply({ result: copy(result) });
		} catch (error) {
			console.error(error);
			reply({ error: messageOf(error) });
		}
	});
	return ctx;
}

/** the kind the hub gave the page's frame (its real name), else the worker's */
function pageKind(given: RuntimePayload): {
	kind: Context['kind'];
	tabId: number;
} {
	const name = frameName;
	if (name.startsWith(CONTEXT_NAME_PREFIX)) {
		const [kind, tab] = name.slice(CONTEXT_NAME_PREFIX.length).split(':');
		if (kind === 'popup' || kind === 'offscreen' || kind === 'background')
			return { kind, tabId: tab ? Number(tab) : -1 };
	}
	return { kind: given.page!.kind, tabId: -1 };
}

function pageContext(given: RuntimePayload) {
	const ext = given.page!;
	const { kind, tabId } = pageKind(given);
	const ctx = new Context(ext, kind, given.channel, given.url, undefined);
	const chrome = buildChrome(ctx);
	receiveMessages(ctx);
	// the page's own `chrome` (the browser's, with its app and csi) gains the
	// extension's namespaces
	const existing = global.chrome;
	const target =
		existing && typeof existing === 'object'
			? (existing as Record<string, unknown>)
			: {};
	for (const [name, value] of Object.entries(chrome))
		natives.defineProperty(target, name, {
			value,
			writable: true,
			configurable: true,
			enumerable: true,
		});
	if (target !== existing)
		natives.defineProperty(global, 'chrome', {
			value: target,
			writable: true,
			configurable: true,
			enumerable: true,
		});
	ctx.placed = ctx
		.hub('hello', {
			client: given.client,
			url: given.url,
			top: given.top,
			name: kind,
			tabId,
		})
		.then((place) => {
			const told = place as (Context['place'] & { kind?: string }) | null;
			if (told) ctx.place = told;
			// a popup the host mounted, which the frame's name did not say
			if (told?.kind === 'popup' && ctx.kind !== 'popup') {
				ctx.kind = 'popup';
				popupPage(ctx);
			}
			ctx.announce();
		})
		.catch(() => ctx.announce());
	if (kind === 'popup') popupPage(ctx);
	if (kind === 'background') backgroundPage(ctx, given);
	return ctx;
}

/** a popup tells the hub its size, and closes through it */
function popupPage(ctx: Context) {
	const report = () => {
		const root = natives.documentElement(natives.document);
		if (!root) return;
		// the width it would take with room to spare (Chrome lays a popup out
		// unconstrained and shrinks it to its content), not the frame's: a
		// popup of fluid width is still 25 px wide before its first size
		let width = natives.scrollWidth(root);
		const style = (root as HTMLElement).style;
		if (style) {
			const was = style.getPropertyValue('width');
			const priority = style.getPropertyPriority('width');
			style.setProperty('width', 'max-content', 'important');
			width = Math.ceil(root.getBoundingClientRect().width) || width;
			if (was) style.setProperty('width', was, priority);
			else style.removeProperty('width');
		}
		ctx
			.hub('popup.size', {
				width,
				height: natives.scrollHeight(root),
			})
			.catch(() => {});
	};
	const watch = () => {
		report();
		try {
			new ResizeObserver(report).observe(
				natives.documentElement(natives.document)!,
			);
		} catch (error) {
			// no observer: the load's size stands
		}
	};
	if (natives.readyState(natives.document) === 'complete') watch();
	else call(natives.addEventListener, global, 'load', watch, { once: true });
	natives.defineProperty(global, 'close', {
		value: function close() {
			ctx.hub('popup.close').catch(() => {});
		},
		writable: true,
		configurable: true,
	});
}

/** a background: runtime.onInstalled once its scripts ran; an emulated service worker's events too */
function backgroundPage(ctx: Context, given: RuntimePayload) {
	if (given.serviceWorker) serviceWorkerShims(ctx);
	call(natives.addEventListener, global, 'load', async () => {
		if (given.serviceWorker) {
			const install = new Event('install');
			(install as Event & { waitUntil?: () => void }).waitUntil = () => {};
			global.dispatchEvent(install);
			const activate = new Event('activate');
			(activate as Event & { waitUntil?: () => void }).waitUntil = () => {};
			global.dispatchEvent(activate);
		}
		try {
			const ran = (await ctx.worker('runtime', 'ranVersion')) as {
				previous: string | null;
				now: string;
			};
			if (ran.previous === null)
				ctx.event('runtime.onInstalled').dispatch([{ reason: 'install' }]);
			else if (ran.previous !== ran.now)
				ctx
					.event('runtime.onInstalled')
					.dispatch([{ reason: 'update', previousVersion: ran.previous }]);
			else ctx.event('runtime.onStartup').dispatch([]);
		} catch (error) {
			console.warn('STomp: runtime.onInstalled could not be told:', error);
		}
	});
}

/** what an MV3 service worker's script expects of its global, in the page that emulates it */
function serviceWorkerShims(ctx: Context) {
	const define = (name: string, value: unknown) =>
		natives.defineProperty(global, name, {
			value,
			writable: true,
			configurable: true,
		});
	// the page loaded every literal import ahead of the script
	// (src/server/extensions/serve.ts staticImports); any other is read
	// now, synchronously as in a worker, and run as the page's code
	let imported: string[] | null = null;
	define('importScripts', (...urls: unknown[]) => {
		if (!imported) {
			const meta = call<Element | null>(
				natives.querySelector,
				natives.document,
				`meta[name="${IMPORTED_META}"]`,
			);
			try {
				imported = natives.JSON.parse(
					(meta &&
						call<string | null>(natives.getAttribute, meta, 'content')) ||
						'[]',
				) as string[];
			} catch (error) {
				imported = [];
			}
		}
		for (const given of urls) {
			const url = new URL(String(given), ctx.url);
			const path = url.pathname.replace(/^\/+/, '');
			if (url.origin === ctx.ext.origin && imported.includes(path)) continue;
			const request = new XMLHttpRequest();
			request.open('GET', url.href, false);
			request.send();
			if (request.status !== 200)
				throw new DOMException(
					`Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '${url.href}' failed to load.`,
					'NetworkError',
				);
			imported.push(path);
			// (an indirect eval: the global scope's, through the page's hooks)
			const evaluate = global.eval as (code: string) => unknown;
			evaluate(request.responseText);
		}
	});
	define('skipWaiting', () => natives.Promise.resolve());
	define('registration', {
		scope: `${ctx.ext.origin}/`,
		active: { state: 'activated', scriptURL: ctx.url },
		showNotification: (title: string, options: unknown) =>
			ctx.hub('notify', natives.randomUUID(), {
				title,
				...(options as object),
			}),
		getNotifications: () => natives.Promise.resolve([]),
		unregister: () => natives.Promise.resolve(false),
		update: () => natives.Promise.resolve(),
	});
	define('clients', {
		claim: () => natives.Promise.resolve(),
		matchAll: () => natives.Promise.resolve([]),
		get: () => natives.Promise.resolve(undefined),
		openWindow: (url: string) => ctx.hub('tabs.create', { url }),
	});
}

function start(given: RuntimePayload) {
	delete global[RUNTIME_GLOBAL];
	if (given.page) pageContext(given);
	for (const ext of given.content ?? []) contentContext(given, ext);
}
