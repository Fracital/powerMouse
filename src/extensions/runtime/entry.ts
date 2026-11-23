// The extensions' runtime (dist/extensionsRuntime.js, docs/extensions.md):
// the shell of a document an extension reaches loads it before the inject
// bundle, hands it the payload the worker wrote (`prepare`), and loads the
// content scripts' routes, each of which only defines a function
// (`define`). It starts as the page's document opens, which the inject does
// right before it writes the page's markup, and runs document_start once
// the first write made the page's root element: the inject writes the
// markup in pieces that each end before a `</script`, so no script of the
// page has run there (Chrome's DidCreateDocumentElement point). An
// ISOLATED script runs in its extension's isolated world (./world/), a
// realm of its own made here; a USER_SCRIPT one as a function of its world's
// `chrome`, a MAIN one as the page's code; an extension page gets `chrome`
// on its window.
import {
	cleanPath,
	displayExtensionURL,
	extensionURL,
	resolveExtensionURL,
} from '../origin';
import {
	CONTENT_SCRIPT_ROUTE,
	CONTEXT_NAME_PREFIX,
	IMPORTED_META,
	RUNTIME_GLOBAL,
	type RuntimePayload,
	type ShippedEntry,
	type ShippedExtension,
} from '../types';
import { buildChrome, VIEW_MARK, type ViewMark } from './api';
import { Context, copy, messageOf } from './context';
import { errorConsole } from './errors';
import { receiveMessages } from './messaging';
import {
	call,
	masking,
	natives,
	scriptNatives,
	useNatives,
	webNatives,
} from './natives';
import { methodLike, presentExtensionPage } from './present';
import { workerContainer, workerGlobal } from './serviceWorker';
import { storePage } from './webstore';
import type { World } from './world/index';
import type { PageSide } from './world/page';
import { makeWorld, pageSide } from './worlds';

/** a route's function, or an isolated world's source and the URL it is code at */
type Defined = ((...args: unknown[]) => unknown) | WorldSource;
type WorldSource = { source: string; url: string };

let payload: RuntimePayload | null = null;
let nonce = '';
/**
 * The nonce of the script policy the inject gives a document its sandbox
 * lets run no script (src/inject/dom/sandbox.ts guardDocument): what an
 * injection's script carries there, as Chrome runs an extension's scripts
 * in such a frame too. Read from the policy's meta as the page's document
 * opens (the meta goes with the shell's markup, the policy stays).
 */
let guardNonce = '';
const GUARD_POLICY = /^script-src 'nonce-([\w+/=-]+)' 'wasm-unsafe-eval'$/;
function readGuardNonce(): string {
	const metas = call<NodeListOf<Element>>(
		natives.querySelectorAll,
		natives.document,
		'meta[http-equiv="Content-Security-Policy" i]',
	);
	for (let index = 0; index < metas.length; index++) {
		const content = call<string | null>(
			natives.getAttribute,
			metas[index],
			'content',
		);
		const found = GUARD_POLICY.exec(content ?? '');
		if (found) return found[1];
	}
	return '';
}
let started = false;

type Global = typeof globalThis & Record<string, unknown>;
const global = globalThis as Global;
const web = webNatives(global);
useNatives({ ...web, ...scriptNatives(global) });
/** what an isolated world is handed of the page's, taken before the inject runs */
const page = pageSide(global, web, () => payload?.access ?? '');
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
	 * a route's function (an isolated world's: its source, and the URL it is
	 * code at): taken only from the route's own script element, so nothing
	 * the page runs can stand in for an extension's code
	 */
	define(id: string, key: string, given: unknown, url?: unknown) {
		defineIn(mainDoc, id, key, given, url);
	},
	/**
	 * The inject's hiddenMutation (src/inject/dom/modules/MutationObserver.ts),
	 * handed over as the inject's client is made: a world's frame made after
	 * the page's scripts ran is one no observer of the page's hears of
	 */
	hidden(given: unknown) {
		if (typeof given === 'function' && !hiddenRun)
			hiddenRun = given as unknown as typeof hiddenRun;
	},
	/**
	 * What the inject's client of a local document this one made (an
	 * about:blank, about:srcdoc, blob: or data: frame's) calls, once the
	 * inject runs there: the content scripts that match it run in it
	 * (localDocument). The inject takes it as its client is made
	 * (src/inject/dom/modules/IFrame.ts)
	 */
	localDocument(child: unknown, url: unknown, hidden: unknown) {
		try {
			localDocument(child, url, hidden);
		} catch (error) {
			console.error('STomp: the extensions could not run in a frame:', error);
		}
	},
};
let hiddenRun: (<T>(run: () => T) => T) | null = null;

/**
 * A document the runtime runs content scripts in: its own, or the
 * document of a local frame it made (localDocument), which has no runtime
 * of its own: its contexts are this realm's, and its scripts load and run
 * in its own realm
 */
interface Doc {
	global: Global;
	document: Document;
	/** the routes' functions, by `<id>|<key>`, and the loads waiting for them */
	defined: Map<string, Defined>;
	waiting: Map<string, (fn: Defined) => void>;
	/** the route loads under way, and whether they put the global there (the document's own entries may have it already) */
	loading: number;
	ownGlobal: boolean;
	/** what its route scripts' `self.<RUNTIME_GLOBAL>` is while they load */
	runtime: object;
	/** the nonce its scripts carry */
	nonce(): string;
	/** what its isolated worlds are handed of its page */
	page: PageSide;
	hidden(): (<T>(run: () => T) => T) | null;
	/** its document_start point: once its root is there */
	rooted(run: () => void): void;
	/** its own stylesheets' constructor (a constructed sheet is its document's only) */
	CSSStyleSheet: typeof CSSStyleSheet;
	/** its URL, as its contexts' errors name it */
	href(): string;
	/** its realm's own indirect eval: an injected file's completion value is its result */
	evaluate(code: string): unknown;
	/** a local frame's: the script element of the route being run there now */
	inline?: HTMLScriptElement | null;
}

/** the browser's eval of `global`: the inject leaves the global's own, and answers the page's reads with its hook */
const evalOf = (target: Global) =>
	natives.getOwnPropertyDescriptor(target, 'eval')?.value as
		((code: string) => unknown) | undefined;
const textSet = natives.getOwnPropertyDescriptor(
	global.Node.prototype,
	'textContent',
)?.set;

/**
 * An injected file's code, run as global code of the document's realm,
 * and its completion value (Chrome's result of a file). Where the
 * document's policy refuses eval (a sandboxed frame's guard), the code runs
 * as a script element with the policy's nonce, and has no result
 */
function evaluator(doc: Doc, own: ((code: string) => unknown) | undefined) {
	return (code: string): unknown => {
		try {
			if (own) return natives.Reflect.apply(own, doc.global, [code]);
		} catch (error) {
			if ((error as Error | null)?.name !== 'EvalError') throw error;
		}
		runInline(doc, code);
		return undefined;
	};
}

/** run `code` as a script element of the document's (its nonce's) */
function runInline(doc: Doc, code: string, before?: () => void) {
	const script = call<HTMLScriptElement>(
		natives.createElement,
		doc.document,
		'script',
	);
	const scriptNonce = doc.nonce();
	if (scriptNonce) call(natives.setAttribute, script, 'nonce', scriptNonce);
	if (textSet) call(textSet, script, code);
	const parent = natives.documentElement(doc.document) ?? doc.document;
	before?.();
	doc.inline = script;
	try {
		call(natives.appendChild, parent, script);
	} finally {
		doc.inline = null;
		try {
			call(natives.removeChild, parent, script);
		} catch (error) {
			// the page took it out already
		}
	}
}

const mainDoc: Doc = {
	global,
	document: natives.document,
	defined: new Map(),
	waiting: new Map(),
	loading: 0,
	ownGlobal: false,
	runtime,
	nonce: () => guardNonce || nonce,
	page,
	hidden: () => hiddenRun,
	rooted: (run) => whenRooted(run),
	CSSStyleSheet: natives.CSSStyleSheet,
	href: () => natives.location.href,
	evaluate: (code) => mainEval(code),
};
const mainEval = evaluator(mainDoc, evalOf(global));

/**
 * A route's function, taken only from the route's own script element in
 * the document, so nothing the page runs can stand in for an extension's
 * code
 */
function defineIn(
	doc: Doc,
	id: string,
	key: string,
	given: unknown,
	url?: unknown,
) {
	const script = natives.currentScript(doc.document);
	const src = script ? natives.scriptSrc(script) : '';
	// (a local frame's route runs as the text the runtime fetched: loadRoute)
	const own = !!script && script === doc.inline;
	if (
		(typeof given !== 'function' && typeof given !== 'string') ||
		(!own &&
			(!src.includes(`/${CONTENT_SCRIPT_ROUTE}/${id}/`) ||
				!src.split('?')[0].endsWith(`/${key}.js`)))
	)
		return;
	const fn: Defined =
		typeof given === 'string'
			? { source: given, url: String(url ?? '') }
			: (given as Defined);
	const name = `${id}|${key}`;
	const waiter = doc.waiting.get(name);
	if (waiter) {
		doc.waiting.delete(name);
		waiter(fn);
	} else doc.defined.set(name, fn);
}

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
		if (!started && this === natives.document && payload)
			guardNonce = readGuardNonce();
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
function addSheet(doc: Doc, css: string): CSSStyleSheet | null {
	if (!css || !natives.adoptedStyleSheets?.get) return null;
	const sheet = new doc.CSSStyleSheet();
	try {
		sheet.replaceSync(css);
	} catch (error) {
		return null;
	}
	const list = call<CSSStyleSheet[]>(
		natives.adoptedStyleSheets.get,
		doc.document,
	);
	call(natives.adoptedStyleSheets.set!, doc.document, [...list, sheet]);
	return sheet;
}

function removeSheet(doc: Doc, sheet: CSSStyleSheet) {
	if (!natives.adoptedStyleSheets?.get) return;
	const list = call<CSSStyleSheet[]>(
		natives.adoptedStyleSheets.get,
		doc.document,
	);
	call(
		natives.adoptedStyleSheets.set!,
		doc.document,
		list.filter((other) => other !== sheet),
	);
}

/** the function a route defines in the document, once its script has run */
function definedFn(doc: Doc, id: string, key: string): Promise<Defined> {
	const name = `${id}|${key}`;
	const found = doc.defined.get(name);
	if (found) return natives.Promise.resolve(found);
	return new natives.Promise((resolve) => doc.waiting.set(name, resolve));
}

/** load a route's script in the document now (an injection): its function, when it ran */
function loadRoute(
	doc: Doc,
	id: string,
	key: string,
	route: string,
): Promise<Defined> {
	const loaded = definedFn(doc, id, key);
	const target = doc.global;
	// a local frame's realm loads nothing of the worker's itself (an
	// about:blank one's requests do not reach it): its creator fetches the
	// route, and it runs as the frame's script
	if (doc !== mainDoc) {
		const failed = () =>
			doc.waiting.get(`${id}|${key}`)?.(() => {
				throw new natives.Error(`Could not load the script ${route}`);
			});
		natives
			.fetch(route)
			.then((response) =>
				response.ok ? response.text() : natives.Promise.reject(),
			)
			.then((text) => {
				const had = natives.getOwnPropertyDescriptor(target, RUNTIME_GLOBAL);
				try {
					runInline(doc, text, () =>
						natives.defineProperty(target, RUNTIME_GLOBAL, {
							value: doc.runtime,
							configurable: true,
							writable: true,
							enumerable: false,
						}),
					);
				} finally {
					if (had) natives.defineProperty(target, RUNTIME_GLOBAL, had);
					else delete target[RUNTIME_GLOBAL];
				}
				if (doc.waiting.has(`${id}|${key}`)) failed();
			})
			.catch(failed);
		return loaded;
	}
	// (the global is there while any load is under way: two injections at
	// once share it, and the last to finish takes it away)
	if (doc.loading++ === 0 && !(RUNTIME_GLOBAL in target)) {
		natives.defineProperty(target, RUNTIME_GLOBAL, {
			value: doc.runtime,
			configurable: true,
			writable: true,
			enumerable: false,
		});
		doc.ownGlobal = true;
	}
	const script = call<HTMLScriptElement>(
		natives.createElement,
		doc.document,
		'script',
	);
	const scriptNonce = doc.nonce();
	if (scriptNonce) call(natives.setAttribute, script, 'nonce', scriptNonce);
	call(natives.setAttribute, script, 'src', route);
	const parent = natives.documentElement(doc.document) ?? doc.document;
	let finished = false;
	const done = () => {
		if (finished) return;
		finished = true;
		try {
			call(natives.removeChild, parent, script);
		} catch (error) {
			// the page took it out already
		}
		if (--doc.loading === 0 && doc.ownGlobal) {
			delete target[RUNTIME_GLOBAL];
			doc.ownGlobal = false;
		}
	};
	loaded.then(done, done);
	call(natives.addEventListener, script, 'error', () => {
		done();
		doc.waiting.get(`${id}|${key}`)?.(() => {
			throw new natives.Error(`Could not load the script ${route}`);
		});
	});
	call(natives.appendChild, parent, script);
	return loaded;
}

/**
 * Run a USER_SCRIPT world's code with the window's `chrome` its world's:
 * what the script reads of `window.chrome`, `self.chrome` or
 * `globalThis.chrome` as it runs (the worker rewrote the plain forms of
 * those to its `chrome` already, for what reads them later)
 */
function inWorld<T>(doc: Doc, chrome: unknown, run: () => T): T {
	const target = doc.global;
	const had = natives.getOwnPropertyDescriptor(target, 'chrome');
	let swapped = false;
	try {
		natives.defineProperty(target, 'chrome', {
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
			if (had) natives.defineProperty(target, 'chrome', had);
			else delete target.chrome;
	}
}

/**
 * What a USER_SCRIPT world's `chrome.runtime` has where configureWorld
 * gave it messaging (Chrome 157): its id, its messaging both ways (it hears
 * tabs.sendMessage and tabs.connect on its own onMessage and onConnect) and
 * the runtime's enums
 */
const USER_SCRIPT_RUNTIME = [
	'ContextType',
	'OnInstalledReason',
	'OnRestartRequiredReason',
	'PlatformArch',
	'PlatformNaclArch',
	'PlatformOs',
	'RequestUpdateCheckStatus',
	'connect',
	'dynamicId',
	'id',
	'onConnect',
	'onMessage',
	'sendMessage',
];

/** a USER_SCRIPT world's `chrome`: the page's own members and messaging, where configureWorld allowed it */
function userScriptChrome(
	doc: Doc,
	ctx: Context,
	given: RuntimePayload,
): unknown {
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
		// (what it listens to is told with the tab it is in)
		world.announce();
	});
	receiveMessages(world);
	const runtime = buildChrome(world).runtime as Record<string, unknown>;
	const own: Record<string, unknown> = {};
	for (const name of USER_SCRIPT_RUNTIME) own[name] = runtime[name];
	// (the world's chrome has the page's csi and loadTimes, as every world's)
	const page = doc.global.chrome as Record<string, unknown> | undefined;
	const chrome: Record<string, unknown> = {};
	for (const name of ['csi', 'loadTimes'])
		if (page && typeof page[name] === 'function') chrome[name] = page[name];
	chrome.runtime = own;
	return chrome;
}

/** what a document's isolated scripts run in: the extension's world, or the page's realm where none can be made */
interface Isolated {
	world(): World | null;
	/** the `chrome` of an ISOLATED script that runs in the page's realm */
	chrome(): unknown;
}

/**
 * An entry's function in the document: the one its shell's route defined,
 * or, in a local frame, the creator's (an isolated world's source is no
 * realm's) or the route loaded there (a MAIN or USER_SCRIPT one is code of
 * the frame's realm)
 */
function entryFn(
	doc: Doc,
	id: string,
	entry: ShippedEntry,
	route: string,
): Promise<Defined> {
	if (doc === mainDoc) return definedFn(doc, id, entry.key);
	if (entry.world === 'MAIN' || entry.world === 'USER_SCRIPT')
		return loadRoute(doc, id, entry.key, route);
	return definedFn(mainDoc, id, entry.key);
}

function runEntry(
	doc: Doc,
	ctx: Context,
	entry: ShippedEntry,
	route: string,
	userChrome: () => unknown,
	isolated: Isolated,
) {
	if (!entry.js) return;
	const target = doc.global;
	entryFn(doc, ctx.ext.id, entry, route).then(async (fn) => {
		try {
			if (typeof fn !== 'function') {
				const world = isolated.world();
				if (world) return world.run(fn.source, fn.url);
				const shared = await sharedFn(doc, ctx.ext.id, entry.key, route);
				const own = isolated.chrome();
				inWorld(doc, own, () =>
					natives.Reflect.apply(shared, target, [own, undefined]),
				);
			} else if (entry.world === 'MAIN') natives.Reflect.apply(fn, target, []);
			else {
				// its window's chrome is its world's too (`const { chrome } = window`)
				const own = userChrome();
				inWorld(doc, own, () =>
					natives.Reflect.apply(fn, target, [own, undefined]),
				);
			}
		} catch (error) {
			console.error(error);
		}
	});
}

/**
 * An ISOLATED script's route as a function of `chrome` the page's realm
 * runs (src/server/extensions/contentScripts.ts SHARED), as every ISOLATED
 * script ran before isolated worlds: for a document whose policy lets no
 * world be made
 */
function sharedFn(
	doc: Doc,
	id: string,
	key: string,
	route: string,
): Promise<(...args: unknown[]) => unknown> {
	doc.defined.delete(`${id}|${key}`);
	return loadRoute(doc, id, key, `${route}?shared`) as Promise<
		(...args: unknown[]) => unknown
	>;
}

/**
 * When each run_at point comes: document_start once the root is written,
 * document_end after the document's DOMContentLoaded listeners (on the
 * window, where the event ends), document_idle a task after that or at the
 * window's load, whichever is first
 */
function schedule(doc: Doc, runAt: string, run: () => void) {
	if (runAt === 'document_start') return doc.rooted(run);
	const target = doc.global;
	const idle = () => {
		let ran = false;
		const once = () => {
			if (ran) return;
			ran = true;
			run();
		};
		natives.setTimeout(once, 0);
		call(natives.addEventListener, target, 'load', once, { once: true });
	};
	const later = runAt === 'document_end' ? run : idle;
	if (natives.readyState(doc.document) !== 'loading') return later();
	call(natives.addEventListener, target, 'DOMContentLoaded', later, {
		once: true,
	});
}

/** a frame's DOMContentLoaded and load, told to the hub (webNavigation) */
function subframeLifecycle(doc: Doc, ctx: Context) {
	const tell = (state: string) => () => {
		ctx.hub('nav', state).catch(() => {});
	};
	const state = natives.readyState(doc.document);
	if (state === 'loading')
		call(
			natives.addEventListener,
			doc.document,
			'DOMContentLoaded',
			tell('dom'),
			{
				once: true,
			},
		);
	else tell('dom')();
	if (state === 'complete') tell('load')();
	else
		call(natives.addEventListener, doc.global, 'load', tell('load'), {
			once: true,
		});
}

/**
 * An extension's content context in the document. A local frame's
 * (`local`) is placed by its creator's context: in its tab, below its
 * frame, with the frame id the hub keeps for the frame's key
 */
function contentContext(
	doc: Doc,
	given: RuntimePayload,
	ext: ShippedExtension,
	local?: { creator: Context; key: string },
) {
	const ctx = new Context(
		ext,
		'content',
		given.channel,
		given.url,
		given.tokens[ext.id],
	);
	ctx.injects = true;
	receiveMessages(ctx);
	// (its listeners' errors; its scripts' own are reported where they run:
	// an isolated world's, runEntry's)
	ctx.errors = errorConsole(ctx, {
		win: null,
		console: null,
		contextUrl: () => doc.href(),
	});
	const hello = local
		? local.creator.placed.then(() =>
				ctx.hub('hello', {
					client: '',
					url: given.url,
					top: false,
					name: '',
					local: {
						key: local.key,
						tabId: local.creator.place.tabId,
						parentFrameId: local.creator.place.frameId,
					},
				}),
			)
		: ctx.hub('hello', {
				client: given.client,
				url: given.url,
				top: given.top,
				name: '',
			});
	ctx.placed = hello
		.then((place) => {
			if (place) ctx.place = place as Context['place'];
			ctx.announce();
			// a document below its tab's top: its webNavigation events past the
			// commit are the hub's to tell from here (the host sees only tops)
			if (ctx.place.frameId > 0 && ext.permissions.includes('webNavigation'))
				subframeLifecycle(doc, ctx);
		})
		.catch(() => {
			ctx.announce();
		});
	const routeOf = (key: string) =>
		`${given.channel}${CONTENT_SCRIPT_ROUTE}/${ext.id}/${ext.generation ?? 0}/${key}.js`;
	// the CSS goes in first, before any of the page's markup (a site its
	// site access withholds: once a click on its button runs them)
	const start = (now: boolean) => {
		for (const entry of ext.entries ?? []) addSheet(doc, entry.css);
		for (const entry of ext.entries ?? []) {
			const run = () =>
				runEntry(doc, ctx, entry, routeOf(entry.key), userWorld, isolated);
			if (now) run();
			else schedule(doc, entry.runAt, run);
		}
	};
	let userChrome: { value: unknown } | null = null;
	const userWorld = () =>
		(userChrome ??= { value: userScriptChrome(doc, ctx, given) }).value;
	// the extension's isolated world, made where its first script runs
	let world: World | null | undefined;
	let shared: unknown = null;
	const isolated: Isolated = {
		world: () => world ?? makeIsolated(),
		chrome: () => (shared ??= buildChrome(ctx)),
	};
	const makeIsolated = () => {
		if (world !== undefined) return world;
		world = makeWorld(
			doc.page,
			{
				ext: natives.JSON.stringify(ext),
				channel: given.channel,
				url: given.url,
				token: given.tokens[ext.id],
			},
			doc.hidden(),
			doc.document,
		);
		const made = world;
		if (made)
			ctx.placed.then(() => made.placed(natives.JSON.stringify(ctx.place)));
		return made;
	};
	if (!ext.blocked) start(false);
	else {
		let unblocked = false;
		ctx.on('unblock', (message) => {
			if (unblocked || message.tabId !== ctx.place.tabId) return;
			unblocked = true;
			ctx.placed.then(() => schedule(doc, 'document_end', () => start(true)));
		});
		// the button shows that scripts wait here (Chrome's ring around its icon)
		ctx.placed.then(() => {
			if (!unblocked && ctx.place.tabId >= 0)
				ctx.hub('action.blocked', ctx.place.tabId).catch(() => {});
		});
	}
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
				if (sheet) removeSheet(doc, sheet);
				sheets.delete(key);
			} else {
				const sheet = addSheet(doc, String(message.css ?? ''));
				if (sheet) sheets.set(key, sheet);
			}
			return reply({});
		}
		const target = doc.global;
		try {
			const fn = await loadRoute(
				doc,
				ctx.ext.id,
				String(message.key),
				String(message.route),
			);
			let result: unknown;
			const take = (value: unknown) => {
				result = value;
			};
			// an isolated world's is its code; a MAIN world's function takes
			// only the result's callback; a USER_SCRIPT world's chrome is its
			// own (userScripts.execute)
			if (typeof fn !== 'function') {
				const world = isolated.world();
				if (world) result = world.exec(fn.source, fn.url);
				else {
					const shared = await sharedFn(
						doc,
						ctx.ext.id,
						String(message.key),
						String(message.route),
					);
					const own = isolated.chrome();
					inWorld(doc, own, () =>
						natives.Reflect.apply(shared, target, [own, undefined, take]),
					);
				}
			} else if (fn.length < 3)
				natives.Reflect.apply(fn, target, [take, doc.evaluate]);
			else {
				const own = userWorld();
				inWorld(doc, own, () =>
					natives.Reflect.apply(fn, target, [
						own,
						undefined,
						take,
						doc.evaluate,
					]),
				);
			}
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

// ---- local frames -----------------------------------------------------------

/** this document's content contexts, by extension: the creators of its local frames' */
const creators = new Map<string, Context>();
/** a key per local frame's window, which its next local documents keep (its frame id) */
const localKeys = new WeakMap<object, string>();
/** the local documents the runtime runs in already */
const localRuns = new WeakSet<object>();
const ownGet = (name: string) =>
	natives.getOwnPropertyDescriptor(global, name)?.get;
const parentGet = ownGet('parent');
const documentGet = ownGet('document');

/**
 * A local document of a frame of this document's (about:blank,
 * about:srcdoc, blob:, data:), as the inject's client there tells it. Its
 * URL is none a pattern matches, so Chrome matches the creator's URL for
 * an entry with match_about_blank (about: only) and its origin for one
 * with match_origin_as_fallback (blob: and data: too), and only where the
 * entry is all_frames: such an entry matched this document already
 * (ShippedEntry `local`). Each extension this document has a context of
 * gets one there too (executeScript reaches the frame, and webNavigation
 * sees it), and its entries run in the frame's realm
 */
function localDocument(child: unknown, url: unknown, hidden: unknown) {
	if (!creators.size || !payload?.content || typeof url !== 'string') return;
	const about = /^about:(blank|srcdoc)$/.test(url);
	if (!about && !/^(blob|data):/.test(url)) return;
	if (!parentGet || !documentGet) return;
	const win = child as Global;
	let document: Document;
	try {
		// a frame of this document only: no other window is its to speak for
		if (natives.Reflect.apply(parentGet, win, []) !== global) return;
		document = natives.Reflect.apply(documentGet, win, []) as Document;
	} catch (error) {
		// a window of another real origin
		return;
	}
	if (!document || localRuns.has(document)) return;
	localRuns.add(document);
	let key = localKeys.get(win);
	if (!key) {
		key = natives.randomUUID();
		localKeys.set(win, key);
	}
	const childWeb = webNatives(win);
	const childPage = pageSide(
		win,
		{
			...web,
			global: win,
			document,
			location: childWeb.location,
		},
		() => payload?.access ?? '',
	);
	const childHidden =
		typeof hidden === 'function'
			? (hidden as <T>(run: () => T) => T)
			: hiddenRun;
	const doc: Doc = {
		global: win,
		document,
		defined: new Map(),
		waiting: new Map(),
		loading: 0,
		ownGlobal: false,
		runtime: {},
		nonce: () => '',
		page: childPage,
		hidden: () => childHidden,
		rooted: (run) => {
			if (natives.documentElement(document)) run();
			else
				call(natives.addEventListener, document, 'DOMContentLoaded', run, {
					once: true,
				});
		},
		CSSStyleSheet: childWeb.CSSStyleSheet,
		href: () => url,
		evaluate: (code) => childEval(code),
	};
	const childEval = evaluator(doc, evalOf(win));
	doc.runtime = {
		define(id: string, key: string, given: unknown, at?: unknown) {
			defineIn(doc, id, key, given, at);
		},
	};
	const given: RuntimePayload = {
		...payload,
		url,
		client: '',
		top: false,
	};
	let snapshot = false;
	for (const ext of payload.content) {
		const creator = creators.get(ext.id);
		if (!creator) continue;
		const entries = (ext.entries ?? []).filter(
			(entry) => entry.local === 'origin' || (entry.local === 'about' && about),
		);
		// (one that may not inject and runs nothing there has no context there)
		if (!entries.length && !injects(ext)) continue;
		const own = { ...ext, entries };
		if (!snapshot && isolates(own)) {
			snapshot = true;
			childPage.snapshot();
		}
		contentContext(doc, given, own, { creator, key });
	}
}

/** whether an extension may inject into a document (scripting, tabs, activeTab) or sees its frames (webNavigation) */
const injects = (ext: ShippedExtension) =>
	ext.permissions.some(
		(name) =>
			name === 'scripting' ||
			name === 'tabs' ||
			name === 'activeTab' ||
			name === 'webNavigation',
	);

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

/** IDS_WEB_FONT_FAMILY of Chrome's platform (Linux puts its UI font first) */
function extensionFont(): string {
	const agent =
		(natives.global as unknown as Window).navigator?.userAgent ?? '';
	if (/Windows/.test(agent)) return "'Segoe UI', Tahoma, sans-serif";
	if (/CrOS/.test(agent)) return 'Roboto, sans-serif';
	if (/Mac OS X/.test(agent)) return 'system-ui, sans-serif';
	return 'system-ui, Arial, sans-serif';
}

function pageContext(given: RuntimePayload) {
	const ext = given.page!;
	const { kind, tabId } = pageKind(given);
	// its origin as Chrome's, chrome-extension://, over the inject's hooks
	presentExtensionPage(given.serviceWorker?.url);
	const ctx = new Context(ext, kind, given.channel, given.url, undefined);
	// the extension's other pages find this one as a view (getViews)
	const mark: ViewMark = {
		id: ext.id,
		get kind() {
			return ctx.kind;
		},
		get tabId() {
			return ctx.place.tabId;
		},
	};
	natives.defineProperty(global, VIEW_MARK, {
		value: mark,
		configurable: true,
	});
	// the stylesheet Chrome gives every extension page (extension_fonts.css):
	// the platform's web UI font at 75%, which the page's own rules override
	// (a layer under them, as Chrome's injected sheet comes before them)
	addSheet(
		mainDoc,
		`@layer{body{font-family:${extensionFont()};font-size:75%}}`,
	);
	const chrome = buildChrome(ctx);
	receiveMessages(ctx);
	// its errors for the extensions page (an emulated service worker's are
	// the worker script's, as Chrome's)
	const workerScript = given.serviceWorker?.url;
	ctx.errors = errorConsole(ctx, {
		win: global as unknown as Window & typeof globalThis,
		console: (global as unknown as { console: Console }).console,
		contextUrl: () => workerScript ?? natives.location.href,
		serviceWorker: !!workerScript,
		hidden: () => ctx.kind === 'background' || ctx.kind === 'offscreen',
	});
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
	else if (ext.manifest.background?.service_worker)
		workerContainer(
			ctx,
			extensionURL(ext.id, cleanPath(ext.manifest.background.service_worker)),
			given.top,
		);
	return ctx;
}

/**
 * a popup tells the hub its size, and closes through it. Chrome sizes a
 * popup to its content on every layout (FrameViewAutoSizeInfo): the root's
 * min-content width and the root box's scroll height at that width, plus a
 * scrollbar across a dimension the 800x600 bound cuts. Any change can move
 * that size (a script setting the body's width once the popup knows its
 * tab, text a framework renders late, a font), so the popup measures again
 * after each one.
 */
function popupPage(ctx: Context) {
	if (popupWatched) return;
	popupWatched = true;
	const doc = natives.document;
	let last = '';
	let queued = false;
	let mutations: MutationObserver | null = null;
	// the root at its min-content width, by a sheet of the runtime's: no
	// attribute of the page's changes (a page that watches its root's
	// style sees nothing, and answers nothing)
	let sheet: CSSStyleSheet | null = null;
	const narrow = (on: boolean) => {
		if (!natives.adoptedStyleSheets?.get) return false;
		const list = call<CSSStyleSheet[]>(natives.adoptedStyleSheets.get, doc);
		if (!sheet) {
			sheet = new natives.CSSStyleSheet();
			sheet.replaceSync(':root { width: min-content !important }');
		}
		sheet.disabled = !on;
		if (!list.includes(sheet))
			call(natives.adoptedStyleSheets.set!, doc, [...list, sheet]);
		return true;
	};
	const measure = () => {
		queued = false;
		const root = natives.documentElement(doc) as HTMLElement | null;
		const body = doc.body;
		if (!root || !body || !narrow(true)) return;
		const box = root.getBoundingClientRect();
		const computed = getComputedStyle(root);
		const margins = (first: string, second: string) =>
			(parseFloat(computed.getPropertyValue(first)) || 0) +
			(parseFloat(computed.getPropertyValue(second)) || 0);
		let width = Math.ceil(box.width + margins('margin-left', 'margin-right'));
		// the box's scroll height: its own height, or what overflows the view
		const scrolled = natives.scrollHeight(root);
		let height = Math.ceil(
			scrolled > root.clientHeight
				? scrolled
				: box.height + margins('margin-top', 'margin-bottom'),
		);
		// a scrollbar across what the bound cuts: as wide as the one the
		// frame shows now (the root's client box is the view's, less it)
		const scrollbar = Math.max(0, innerWidth - root.clientWidth);
		narrow(false);
		const overflowY = getComputedStyle(body).overflowY;
		if (
			height > 600 &&
			computed.overflowY !== 'hidden' &&
			overflowY !== 'hidden'
		)
			width += scrollbar;
		else if (width > 800 && computed.overflowX !== 'hidden')
			height += Math.max(0, innerHeight - root.clientHeight);
		mutations?.takeRecords();
		const size = `${width}x${height}`;
		if (size === last) return;
		last = size;
		ctx.hub('popup.size', { width, height }).catch(() => {});
	};
	const queue = () => {
		if (queued) return;
		queued = true;
		natives.setTimeout(measure, 0);
	};
	let resizes: ResizeObserver | null = null;
	try {
		resizes = new ResizeObserver(queue);
	} catch (error) {
		// no observer: the mutations' sizes stand
	}
	let observedRoot: Element | null = null;
	let observedBody: Element | null = null;
	const observe = () => {
		const root = natives.documentElement(doc);
		if (root && resizes && root !== observedRoot) {
			resizes.observe(root);
			observedRoot = root;
		}
		const body = doc.body;
		if (body && resizes && body !== observedBody) {
			resizes.observe(body);
			observedBody = body;
		}
	};
	const settled = () => {
		observe();
		queue();
	};
	try {
		mutations = new MutationObserver(settled);
		mutations.observe(doc, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
	} catch (error) {
		// no observer: the load's size and the resizes stand
	}
	call(natives.addEventListener, doc, 'DOMContentLoaded', settled);
	call(natives.addEventListener, global, 'load', settled);
	try {
		call(natives.addEventListener, doc.fonts, 'loadingdone', settled);
	} catch (error) {
		// no font set
	}
	settled();
	natives.defineProperty(global, 'close', {
		value: function close() {
			ctx.hub('popup.close').catch(() => {});
		},
		writable: true,
		configurable: true,
	});
	// Escape the page left unhandled closes the popup (Chrome's bubble takes
	// the key the popup's contents did not: ExtensionViewViews'
	// HandleKeyboardEvent); the host's own Escape does not reach a frame
	call(natives.addEventListener, global, 'keydown', (event: KeyboardEvent) => {
		if (event.key !== 'Escape' || event.repeat) return;
		natives.setTimeout(() => {
			if (!event.defaultPrevented) ctx.hub('popup.close').catch(() => {});
		}, 0);
	});
}
let popupWatched = false;

/** a background: runtime.onInstalled once its scripts ran; an emulated service worker's global and events too (serviceWorker.ts) */
function backgroundPage(ctx: Context, given: RuntimePayload) {
	if (given.serviceWorker) {
		serviceWorkerShims(ctx);
		workerGlobal(ctx, given.serviceWorker.url);
	}
	call(natives.addEventListener, global, 'load', async () => {
		try {
			const ran = (await ctx.worker('runtime', 'ranVersion')) as {
				previous: string | null;
				now: string;
				started?: 'reloaded' | 'enabled';
			};
			// (turned on again: Chrome tells it nothing; Reload is an update to
			// the same version)
			if (ran.started === 'enabled') return;
			if (ran.started === 'reloaded')
				ctx
					.event('runtime.onInstalled')
					.dispatch([
						{ reason: 'update', previousVersion: ran.previous ?? ran.now },
					]);
			else if (ran.previous === null)
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

/** an MV3 service worker's importScripts, in the page that emulates it */
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
	// (shown as the native: present.ts methodLike)
	define(
		'importScripts',
		methodLike({ name: 'importScripts', length: 0 }, (urls) => {
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
				// (getURL's chrome-extension:// URL is the emulated origin's)
				const url = new URL(resolveExtensionURL(String(given)), ctx.url);
				const path = url.pathname.replace(/^\/+/, '');
				if (url.origin === ctx.ext.origin && imported.includes(path)) continue;
				const request = new XMLHttpRequest();
				request.open('GET', url.href, false);
				request.send();
				if (request.status !== 200)
					throw new DOMException(
						`Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '${displayExtensionURL(url.href)}' failed to load.`,
						'NetworkError',
					);
				imported.push(path);
				// (an indirect eval: the global scope's, through the page's hooks)
				const evaluate = global.eval as (code: string) => unknown;
				evaluate(request.responseText);
			}
		}),
	);
}

function start(given: RuntimePayload) {
	// what the inject handed over as it loaded (natives.ts masking)
	const native = (runtime as { native?: unknown }).native;
	if (typeof native === 'function')
		masking.native = native as typeof masking.native;
	delete global[RUNTIME_GLOBAL];
	if (given.contentType) textDocumentType(given.contentType);
	if (given.page) pageContext(given);
	// what an isolated world reads of the page's members is what they are
	// now, before the page's scripts and its MAIN world's run
	if (given.content?.some(isolates)) page.snapshot();
	for (const ext of given.content ?? [])
		creators.set(ext.id, contentContext(mainDoc, given, ext));
	if (given.store)
		storePage(given.channel, given.store.changes, given.store.token);
}

/** whether an extension may run code in an isolated world of the document (its entries', or an injection's) */
const isolates = (ext: ShippedExtension) =>
	(ext.entries ?? []).some(
		(entry) =>
			entry.js && entry.world !== 'MAIN' && entry.world !== 'USER_SCRIPT',
	) ||
	ext.permissions.some(
		(name) => name === 'scripting' || name === 'tabs' || name === 'activeTab',
	);

/**
 * a text document the worker served as Chrome's HTML of it reads the type
 * it came as (application/json, text/plain), as Chrome's text document
 * does. Set once the inject has taken the native getter, which it asks
 * for whether a node is in an HTML document
 */
function textDocumentType(type: string) {
	const prototype = global.Document.prototype;
	const native = natives.getOwnPropertyDescriptor(prototype, 'contentType');
	if (!native?.get) return;
	const get = native.get;
	// (a getter named as the native's, get contentType)
	const shaped = natives.getOwnPropertyDescriptor(
		{
			get contentType() {
				return this === natives.document
					? type
					: (natives.Reflect.apply(get, this, []) as string);
			},
		},
		'contentType',
	)!.get;
	natives.defineProperty(prototype, 'contentType', { ...native, get: shaped });
}
