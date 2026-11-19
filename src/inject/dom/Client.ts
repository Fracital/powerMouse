import type { AdblockPage } from '../../blocker/types';
import { ParsedConfig } from '../../config';
import {
	browserPolicy,
	browserRefuses,
	enforcesCode,
	governing,
	markedPolicy,
	parsePolicies,
	policyMark,
	policySandbox,
	refusalNamed,
	sourcesMatch,
	trustedTypesRequired,
	type HopPolicy,
	type Policy,
	type PolicyText,
	type WorkerPolicies,
} from '../../csp';
import { rewriteCSSValueURLs } from '../../cssURLs';
import type { HookContext, HookErrorInfo, HookPhase } from '../../hooks';
import { allowDelegates } from '../../isolation';
import {
	CACHE_MARK_SHAPE,
	MARK_DIRECTIVES,
	OPAQUE_MARK,
	setCacheMarkSource,
} from '../../memoryMark';
import {
	credentiallessPartition,
	nestedMark,
	parseNestedMark,
	partitionOf,
	siteOf,
	type NestedEmbedder,
} from '../../partition';
import {
	PrewrittenTable,
	scriptPreamble,
	type Prewritten,
} from '../../prewrite';
import { refererFor, type ReferrerInfo } from '../../referrerPolicy';
import {
	nestedMarkOf,
	provideShellFacts,
	provideShellSyncXHR,
	routeHTML,
} from '../../rewriteHTML';
import type { RewriterLib } from '../../rewriterLight';
import { parseRoutedURL, ROUTE_PROTOCOLS, unwrapRoute } from '../../routeURL';
import {
	isSpeculationRules,
	markedSpeculationRules,
	NO_SPECULATION,
	rewriteImportMap,
} from '../../scriptRoutes';
import { IMPORT_MAP_ROUTE } from '../../sri';
import StompURL from '../../StompURL';
import { HOOK_ERROR, OPEN_TAB, SHELL_END } from '../../transport/messages';
import { queryOf } from '../../urlShape';
import { BUILD, coreModuleKey } from '../../version';
import { contextText, linkRoute, opaqueContext } from '../../visited';
import { ownCodec, shareCodec, type CodecBackend } from '../../wasm/codec';
import Client from '../Client';
import { LazyMap, LazySet, LazyWeakMap, LazyWeakSet } from '../ownCollections';
import {
	controllerModule,
	deferredText,
	getPublicSuffix,
	lightFactory,
	lightText,
	modifyCSS,
	modifyJS,
	shareRewriter,
} from '../rewriter';
import { learnSites, siteAnswers } from '../sites';
import { trustedHTML, trustedScript } from '../trusted';
import type { ActivationNote, markActivation } from './activation';
import type { ActivationPart } from './activationPart';
import cloneRawNode, {
	inertDocumentOf,
	parsedBases,
	parseHTML,
	releaseMarkup,
	startedScripts,
} from './cloneNode';
import { activationPart, deferred } from './deferred';
import type { LegacyEncoder } from './legacyEncoding';
import { initLoads, loadSource, type LoadSource } from './loadGrants';
import DOMAttributesModule, {
	scriptKind,
	shouldRewriteScript,
} from './modules/DOMAttributes';
import {
	hiddenMutation,
	markerPrefix,
	useMarker,
} from './modules/MutationObserver';
import SyncModule from './modules/Sync';
import { HTML_NAMESPACE, SVG_NAMESPACE } from './namespaces';
import PageStream, {
	empty,
	FIRST_PASS_MS,
	now,
	PASS_MS,
	readMarkup,
	rootOf,
	WRITE_CHARS,
	WRITE_MAX,
	WRITE_MS,
} from './pageStream';
import type { PolicyChecks } from './policyChecks';
import { Pool, type PoolState } from './pool';
import { createRewriterRealm, libraryFactoryFromScript } from './rewriterRealm';
import {
	documentNonce,
	guardDocument,
	pageSandbox,
	runningNonce,
	sandboxTokens,
	serializeScripted,
	textifyNoscript,
	unwrapNoscript,
} from './sandbox';
import { siteKeyOf } from './site';
import { siteWindows } from './siteWindows';

type OpenCallback = () => void;

// taken when the bundle loads, before any hook
const nativeSetAttribute = Element.prototype.setAttribute;
export const nativeSetTimeout = setTimeout;
const nativeFragmentQuery = DocumentFragment.prototype.querySelectorAll;
const nativeOwnerDocument = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'ownerDocument',
)!.get!;
// The `nonce` getters (the HTMLOrSVGElement mixin's): a hook at work swaps
// an element's prototype for one that is an Element's only (DOMHooks
// CustomElement), where `element.nonce` reads undefined, and a nonce the
// page gave by the property sets no attribute
const nativeNonceGetters = [HTMLElement, SVGElement].flatMap((owner) => {
	const get = Reflect.getOwnPropertyDescriptor(owner.prototype, 'nonce')?.get;
	return get ? [get] : [];
});
/** a script or style element's nonce, by the property or the attribute (whichever the page set), even mid-hook; '' for none */
export function nonceOf(element: Element): string {
	for (const get of nativeNonceGetters)
		try {
			return String(Reflect.apply(get, element, []));
		} catch (error) {
			// an element of the other kind
		}
	return '';
}
const nativeQuerySelectorAll = Element.prototype.querySelectorAll;
const nativeDocumentQuerySelector = Document.prototype.querySelector;
const nativeObserve = MutationObserver.prototype.observe;
const nativeDisconnect = MutationObserver.prototype.disconnect;
const nativeGetAttribute = Element.prototype.getAttribute;
const nativeParent = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'parentNode',
)!.get!;

/** the name a function compile() makes is assigned to while its script runs */
const COMPILED = '$stomp$compiled';

const onDocumentOpen = new WeakMap<typeof globalThis, OpenCallback[]>();

/**
 * Run `callback` after every `document.open()` on `global`: the one loadHTML
 * does to write the real page, and any the page does later. Opening a
 * document removes every listener on the window, so a module that listens
 * on the window registers through this (and once at install).
 */
export function addDocumentOpenListener(
	global: typeof globalThis,
	callback: OpenCallback,
) {
	if (!onDocumentOpen.has(global)) onDocumentOpen.set(global, []);

	return onDocumentOpen.get(global)!.push(callback);
}

/** @internal the document on `global` was just opened */
export function runDocumentOpenListeners(global: typeof globalThis) {
	if (onDocumentOpen.has(global))
		for (const callback of onDocumentOpen.get(global)!) callback();
}

/** style texts shorter than this are routed every time: a lookup costs as much */
const STYLE_MEMO_MIN = 1024;
/** characters of style text (in and out) a document keeps routed */
const STYLE_MEMO_CHARS = 16 * 1024 * 1024;

type ParsingState = 'parsingBeforeWrite' | void;

/** a <style> whose text is CSS: an HTML one or an SVG one */
export type StyleElement = HTMLStyleElement | SVGStyleElement;

/**
 * The site pool: who started a navigation across slots, as the worker of
 * the frame that did would record it (INITIATOR_ROUTE): its routed URL ('' for
 * an opaque origin) and the referrer policy of its request
 */
export interface AcrossInitiator {
	referrer: string;
	policy: string;
}

/**
 * The site pool: a navigation a frame asks a window of another slot to
 * make of itself (DocumentClient navigateAcross): a link's or
 * window.open's URL, a form's submission (its attributes, its action
 * and the entry list the frame's browser built), or a script's location
 * set or replace of an ancestor (Context module) with its initiator
 */
export type AcrossNavigation =
	| { kind: 'link'; url: string }
	| {
			kind: 'location';
			url: string;
			replace: boolean;
			initiator?: AcrossInitiator;
	  }
	| {
			kind: 'form';
			action: string;
			attributes: [string, string][];
			entries: [string, string | File][];
	  };

const globalParsingState = new WeakMap<typeof globalThis, ParsingState>();

export function getGlobalParsingState(global: typeof globalThis) {
	return globalParsingState.get(global)!;
}

export function setGlobalParsingState(
	global: typeof globalThis,
	value: ParsingState,
) {
	globalParsingState.set(global, value);
}

// taken when the bundle loads, before any hook or page code runs
const nodeTypeGet = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'nodeType',
)!.get!;
const parentNodeGet = Reflect.getOwnPropertyDescriptor(
	Node.prototype,
	'parentNode',
)!.get!;
const localNameGet = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'localName',
)!.get!;
const namespaceGet = Reflect.getOwnPropertyDescriptor(
	Element.prototype,
	'namespaceURI',
)!.get!;
const documentURLGetter = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'URL',
)?.get;
const documentViewGetter = Reflect.getOwnPropertyDescriptor(
	Document.prototype,
	'defaultView',
)?.get;

/**
 * The page's markup (and the worker's prewritten table) from the shell's
 * copy (modifyHTML): the shell escapes them with entities' escapeText, which writes `&`, `<`, `>` and U+00A0 as
 * `&amp;`, `&lt;`, `&gt;` and `&nbsp;` and nothing else, so every `&` in the
 * copy starts one of those four. A full HTML entity decoder gave the same
 * text, with the decode tables of every named entity in each frame.
 */
const ESCAPED = /&(amp|lt|gt|nbsp);/g;
const UNESCAPED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	nbsp: '\u00a0',
};
function unescapeText(text: string): string {
	return text.replace(ESCAPED, (_, name: string) => UNESCAPED[name]!);
}

/**
 * The client of the proxied top `start` is under (`start` when it is one):
 * up through parents that are STomp documents of the same real origin. The
 * host page, or a parent of another real origin (the host in isolation
 * mode), ends it.
 */
function topClientOf(start: DocumentClient, name: string): DocumentClient {
	let client = start;
	for (let depth = 0; depth < 64; depth++) {
		let next: unknown;
		try {
			const parent = client.parent;
			if (parent === client.global) break;
			next = (parent as unknown as Record<string, unknown>)[name];
		} catch (error) {
			break;
		}
		if (typeof next !== 'object' || next === null) break;
		client = next as DocumentClient;
	}
	return client;
}

// runtime document !== document in 0.001 ms!?!?!?

/** what holds another origin's data (canvasTaints) */
export interface CanvasTaints {
	canvases: WeakSet<object>;
	contexts: WeakSet<object>;
	/** ImageBitmaps and CanvasPatterns made from a cross-origin source */
	sources: WeakSet<object>;
	/** the ImageBitmaps of those, and how many were ever made */
	bitmaps: WeakSet<object>;
	bitmapCount: number;
	/**
	 * the tracks that carry what a canvas or media element shows (its
	 * captured streams' and their clones), by that source, and each one's
	 * source
	 */
	sourceTracks: WeakMap<object, Set<object>>;
	trackSources: WeakMap<object, object>;
	/** ends a track (a realm's native `stop`), once anything was captured */
	stopTrack?: (track: object) => void;
	/**
	 * what the inject does when an element fires an event, by element and
	 * type: run before a page's stopImmediatePropagation can keep it out
	 */
	watched: WeakMap<object, Map<string, (() => void)[]>>;
	/** the gain node between a media element's source node and what the page connected it to */
	gates: WeakMap<object, object>;
}

const newCanvasTaints = (): CanvasTaints => ({
	canvases: new WeakSet(),
	contexts: new WeakSet(),
	sources: new WeakSet(),
	bitmaps: new WeakSet(),
	bitmapCount: 0,
	sourceTracks: new WeakMap(),
	trackSources: new WeakMap(),
	watched: new WeakMap(),
	gates: new WeakMap(),
});
// a window's parent and opener as the browser has them, taken when the
// bundle runs: a window's own accessors answer for any window
const nativeParentGet = Reflect.getOwnPropertyDescriptor(
	window,
	'parent',
)!.get!;
const nativeOpenerGet = Reflect.getOwnPropertyDescriptor(
	window,
	'opener',
)!.get!;

/** whether `text` holds a byte ISO-2022-JP cannot encode as itself (SO, SI, ESC) */
const hasISO2022Escape = (text: string) =>
	text.includes('\u000e') || text.includes('\u000f') || text.includes('\u001b');

export default class DocumentClient extends Client {
	private write: typeof document.write;
	// native document.open: the hooked one runs the open listeners, which
	// loadHTML does itself
	private open: typeof document.open;
	// native innerHTML, taken before the hooks: the page-facing getter folds
	// the markers back, which is the opposite of what the written page needs
	private innerHTML: (element: Element) => string;
	/**
	 * @internal native script text setter: the hooked one rewrites what it is
	 * given, and markup the client rewrites itself (and a script's source put
	 * back, Readback) must not go through it twice
	 */
	scriptText: (script: HTMLScriptElement, text: string) => void;
	/**
	 * @internal the inline scripts of the page's markup, rewritten, to the
	 * source the page wrote, while the parser has not run them all (loadHTML,
	 * Readback)
	 */
	pendingScripts: Map<string, string> | null = null;
	/**
	 * @internal while loadHTML writes the page's markup in pieces: `between`
	 * outside the writes of the pieces, where no script of the parser runs
	 * but one the written markup holds (the document's write, open() and
	 * close() hooks act as on the network's parser there, DOMHooks), `stopped`
	 * once the page opened the document
	 */
	pieces: { between: boolean; stopped: boolean } | null = null;
	private isConnected: (node: Node) => boolean;
	private baseURIDescriptor: PropertyDescriptor;
	private parentDescriptor: PropertyDescriptor;
	private topDescriptor: PropertyDescriptor;
	// the real top's postMessage, taken before any page code ran: open
	// requests must not go through anything the page can replace
	private topPostMessage: typeof postMessage | null;
	// each document's referrer as the service worker decided it for the real
	// origins (the browser's own is judged in proxy URL space)
	#referrers = new WeakMap<Document, string>();
	// the page's <base href> while loadHTML rewrites its markup: the base
	// element is not in the document yet, but every URL in the page resolves
	// against it, as the browser will once the markup is written
	#parseBase: StompURL | null = null;
	/** the window's setTimeout, before page code can replace it (loadHTML) */
	readonly #setTimeout: typeof setTimeout;
	/** the window's queueMicrotask, before page code can replace it (loadHTML) */
	readonly #queueMicrotask: typeof queueMicrotask;
	/** the window's MutationObserver, before page code can replace it (loadHTML) */
	readonly #MutationObserver: typeof MutationObserver;
	/** the window's native `origin` getter (Readback hooks the property) */
	readonly #originGet: (() => string) | undefined;
	/**
	 * The page's sandbox of this document, as the allow-* flags it grants
	 * (lowercase), or null when it is not sandboxed: its frame's sandbox
	 * (the page's value, kept in the frame's marker: the real attribute holds
	 * what the browser can enforce while the worker still serves the frame,
	 * see sandbox.ts), narrowed by its parent's (a sandboxed document's frames
	 * inherit its flags) and by its opener's when it is a popup of a document
	 * without allow-popups-to-escape-sandbox. Decided when the document
	 * starts (again in loadHTML, for a window whose about:blank was injected
	 * before its document arrived), as the browser decides it when it
	 * creates the document: a sandbox the page changes later applies from the
	 * next navigation on.
	 */
	sandboxFlags: Set<string> | null = null;
	/**
	 * The document's user activation, for the host's history (the Navigate
	 * module): whether the browser had given it one when it started (carried
	 * over from the document that navigated to it) and whether it has one of
	 * its own
	 */
	historyActivation: {
		start: boolean;
		activated: () => boolean;
		/** a transient activation from this document's own input */
		transient: () => boolean;
		token: string;
		/** the native UserActivation getters (isActive, hasBeenActive) and the navigator's object */
		natives?: [() => boolean, () => boolean, object];
	} | null = null;
	/**
	 * @internal the activations that reached this document, once one did
	 * that the browser gave it only through the proxy (./activation.ts)
	 */
	activation: ActivationNote | null = null;
	/**
	 * @internal when a tab the host opened for a document of this tab last
	 * consumed its activation (the proxied top's client keeps it,
	 * ./activation.ts mayOpenPopup)
	 */
	popupConsumed?: number;
	/** @internal ./activation.ts markActivation, of this document's realm */
	markActivation: typeof markActivation | null = null;
	/** @internal the Permissions module's gate hooks: `done` lists the navigator members a page was handed */
	permissionHooks: { done?: string[] } | null = null;
	/** @internal the site pool's state of this document (Pool) */
	readonly pool: PoolState = [
		0,
		undefined,
		null,
		null,
		null,
		null,
		0,
		null,
		null,
	];
	/** the window's native frameElement getter (the Framing module hooks it) */
	#frameElementGet: (() => Element | null) | undefined;
	/** whether this window's opener was an opaque origin when it was created */
	#openerOpaque = false;
	/** the flags a popup inherited from its opener when it was created */
	#inheritedFlags: Set<string> | null = null;
	/** the nonce the shell script that made this client carried, in its document (guardScripts) */
	#shellNonce: { document: Document; nonce: string } | null = null;
	/** the native characterSet, createElement, a link's href and a node's ownerDocument (legacyEncoder) */
	readonly #encodingNatives: [
		() => string,
		(name: string) => Element,
		(value: string) => void,
		() => string,
		() => Document | null,
	];
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
		// (before any hook: its markers are its own, MutationObserver.ts useMarker)
		useMarker(this.names.access);
		const documentProto = this.global.Document.prototype;
		const href = Reflect.getOwnPropertyDescriptor(
			this.global.HTMLAnchorElement.prototype,
			'href',
		)!;
		this.#encodingNatives = [
			Reflect.getOwnPropertyDescriptor(documentProto, 'characterSet')!.get!,
			documentProto.createElement,
			href.set!,
			href.get!,
			Reflect.getOwnPropertyDescriptor(
				this.global.Node.prototype,
				'ownerDocument',
			)!.get!,
		];
		// the bundle's own realm's client: its load channel opens now, and
		// the routes the bundle makes carry its site's cache mark
		if (global === globalThis) {
			initLoads(this);
			setCacheMarkSource(() => this.cacheMark);
		}
		this.#setTimeout = this.global.setTimeout;
		this.#queueMicrotask = this.global.queueMicrotask;
		this.#MutationObserver = this.global.MutationObserver;
		this.write = this.global.document.write;
		this.open = this.global.document.open;
		const innerHTMLGet = Reflect.getOwnPropertyDescriptor(
			this.global.Element.prototype,
			'innerHTML',
		)!.get!;
		this.innerHTML = (element) => Reflect.apply(innerHTMLGet, element, []);
		const textSet = Reflect.getOwnPropertyDescriptor(
			this.global.HTMLScriptElement.prototype,
			'text',
		)!.set!;
		this.scriptText = (script, text) =>
			Reflect.apply(textSet, script, [trustedScript(text)]);
		const isConnectedGet = Reflect.getOwnPropertyDescriptor(
			this.global.Node.prototype,
			'isConnected',
		)!.get!;
		this.isConnected = (node) => Reflect.apply(isConnectedGet, node, []);
		this.baseURIDescriptor = Reflect.getOwnPropertyDescriptor(
			this.global.Node.prototype,
			'baseURI',
		)!;
		this.parentDescriptor = Reflect.getOwnPropertyDescriptor(
			this.global,
			'parent',
		)!;
		this.topDescriptor = Reflect.getOwnPropertyDescriptor(this.global, 'top')!;
		// A frame seals and opens its URLs in its top's codec instance, as it
		// rewrites in its top's library: one module and one memory for a
		// page however many frames it has (src/wasm/codec.ts). Taken by the
		// bundle's first client, before it reads its own address.
		shareCodec(() => this.#topCodec());
		try {
			this.topPostMessage = this.top.postMessage;
		} catch (error) {
			this.topPostMessage = null;
		}
		this.#originGet = Reflect.getOwnPropertyDescriptor(this.global, 'origin')
			?.get as (() => string) | undefined;
		this.#frameElementGet = Reflect.getOwnPropertyDescriptor(
			this.global,
			'frameElement',
		)?.get as (() => Element | null) | undefined;
		this.#inheritedFlags = this.#openerFlags();
		this.sandboxFlags = this.#sandbox();
		// what the shells this realm builds say of their documents' script
		// policy and their `sync-xhr` state: this document's, which they
		// inherit (src/csp.ts, src/server/clientHints.ts)
		provideShellFacts(() => this.scriptFacts);
		provideShellSyncXHR(() => this.syncXHRBlocked);
		this.isDOM = true;
		// read while the shell's own script makes this client, never later: a
		// script running then could be the page's
		const shellNonce = runningNonce(this.global.document);
		if (shellNonce !== null)
			this.#shellNonce = { document: this.global.document, nonce: shellNonce };
		this.guardScripts();
		// The rewriter library this bundle's rewrites use (rewriter.ts). The
		// bundle's first client is its realm's document; a top makes the realm
		// it shares the first time a rewrite needs it (#topLibrary)
		if (
			shareRewriter(() => this.#rewriterLibrary(), {
				lightText: () => {
					const top = this.#topClient();
					return top === this
						? ((this.sites ? siteWindows().slotShared(this) : null)?.light ??
								null)
						: top.rewriterLightText(BUILD);
				},
				deferredText: (name) => {
					const top = this.#topClient();
					// (the slot's agent's, by name: src/slotShare.ts)
					return top === this
						? ((this.sites ? siteWindows().slotShared(this) : null)?.deferred?.[
								name
							] ?? null)
						: top.deferredPartsText(BUILD, name);
				},
				factory: (text, name) => {
					// only where the document refuses eval: a document without
					// allow-scripts (its guard's nonce), or one whose policy refuses
					// code made from a string (its own nonce, src/csp.ts)
					const nonce = this.scriptFacts.evaluates
						? documentNonce(this.global.document)
						: this.scriptNonce;
					return nonce === null
						? null
						: libraryFactoryFromScript(this.global.document, text, nonce, name);
				},
				evaluates: () => this.scriptFacts.evaluates,
				module: () => this.#controllerModule(),
			}) &&
			!this.sandboxedOpaque &&
			this.#topClient() === this
		) {
			// the library a top shares rewrites in the wasm module the
			// controller compiled: the realm only instantiates it. One
			// instance per top; a frame under it holds none, and the agent's
			// library is given the module once, by the first frame that has
			// it. A module that arrives before the top made its library waits
			// for it
			this.#rewriter = null;
			this.#rewriterModules = [];
			// the controller left it on its window, which this top reaches
			// now (rewriter.ts controllerModule): its library and the workers
			// it starts have it from the first task on. The message's round
			// trip through the service worker took a median 280 to 440 ms
			// from the navigation's start on real sites, and about half the
			// tops rewrote before it came, compiling the bytes from a
			// synchronous request (10 to 12 ms)
			const reached = controllerModule();
			if (reached) {
				this.#rewriterModules.push(['core', reached]);
				this.holdModules({ core: reached });
			} else
				this.requestModules((name, module) => {
					const library = this.#rewriter;
					if (!library) {
						this.#rewriterModules?.push([name, module]);
						return;
					}
					this.#adoptModule(library, name, module);
				});
		}
	}
	/**
	 * The top's library, made the first time a rewrite of this document or
	 * of a frame under it needs one: most revisits of a page rewrite nothing
	 * in the document (the worker wrote its scripts), and the realm (a
	 * browsing context made and removed) was a fifth of the shell's script.
	 * The light library is made in a realm no page code runs in, from the
	 * file its shell loaded (a document whose policy refuses code made from
	 * a string makes it with a script carrying the document's nonce
	 * instead), with the browser's own methods taken when the bundle loaded,
	 * in a frame no page code reaches (rewriterRealm.ts `hidden`), whose
	 * element no observer of the page's hears of. A frame of
	 * another slot than its page's, which has no top in reach, takes the one
	 * its slot's agent made for every such frame of the slot (siteWindows
	 * slotShared). Null when one cannot be had.
	 */
	#topLibrary(): RewriterLib | null {
		if (this.#rewriter || !this.#rewriterModules) return this.#rewriter ?? null;
		const modules = this.#rewriterModules;
		this.#rewriterModules = null;
		const agent =
			(this.sites ? siteWindows().slotShared(this) : null)?.rewriter ?? null;
		const library =
			agent ??
			hiddenMutation(() =>
				createRewriterRealm(
					this.global.document,
					lightFactory,
					this.scriptFacts.evaluates ? null : this.scriptNonce,
					true,
				),
			);
		this.#rewriter = library;
		this.#rewriterAgent = !!agent;
		if (library)
			for (const [name, module] of modules)
				this.#adoptModule(library, name, module);
		return library;
	}
	#adoptModule(library: RewriterLib, name: string, module: WebAssembly.Module) {
		try {
			if (!this.#rewriterAgent || !library.holds(name))
				library.adopt(name, module);
		} catch (error) {
			// the library is gone with its document
		}
	}
	/**
	 * The rewriter library a top shares with the frames under it, in a realm
	 * no page code runs in (rewriterRealm.ts); null when this document is no
	 * top or could not make one. @internal
	 */
	get sharedRewriter(): RewriterLib | null {
		return this.#topLibrary();
	}
	/**
	 * The light library's statement (src/inject/rewriter.ts lightFactory)
	 * as this top holds it, for a document under it that makes a copy of its
	 * own; null without it, or for a bundle of another `build`. @internal
	 */
	rewriterLightText(build: string): string | null {
		return build === BUILD ? lightText() : null;
	}
	/**
	 * The activation gates' statement (./activationPart.ts) this document
	 * uses: its top's, which the top evaluates once for every document under
	 * it, or its own where it has no top of this build to reach. Throws when
	 * it cannot be had. @internal
	 */
	activationGatesPart(): ActivationPart {
		const top = this.#topClient();
		return (top !== this && top.activationPartOf(BUILD)) || activationPart();
	}
	/** this bundle's activation gates, for a document under this top of `build` @internal */
	activationPartOf(build: string): ActivationPart | null {
		return build === BUILD ? activationPart() : null;
	}
	/**
	 * One of the bundle's deferred statements (src/inject/dom/deferred.ts),
	 * by its name, as this top holds it, for a document under it that evaluates them; null
	 * without it, or for a bundle of another `build`. @internal
	 */
	deferredPartsText(build: string, name?: string): string | null {
		return build === BUILD ? deferredText(name) : null;
	}
	/** a top's library (null: not made yet, or it could not make one), undefined for a frame under a top */
	#rewriter: RewriterLib | null | undefined;
	/** the modules that arrived for a top's library before it was made; null once it was (#topLibrary) */
	#rewriterModules: [name: string, module: WebAssembly.Module][] | null = null;
	/** whether the top's library is its slot's agent's, which holds the modules the first frame gave it */
	#rewriterAgent = false;
	/** the library of this document's top, once looked up (null: none to share) */
	#topRewriter: RewriterLib | null | undefined;
	/**
	 * The library for this document's next rewrite, or null for its realm's
	 * own copy: its top's, unless it is sandboxed without allow-same-origin
	 * (an opaque origin keeps everything to itself) or its top has none or
	 * is of another build.
	 */
	#rewriterLibrary(): RewriterLib | null {
		if (this.sandboxedOpaque) return null;
		if (this.#rewriter !== undefined) return this.#topLibrary();
		if (this.#topRewriter === undefined) {
			this.#topRewriter = null;
			const top = this.#topClient();
			if (top !== this)
				try {
					const lib = top.sharedRewriter;
					if (typeof lib === 'object' && lib !== null && lib.build === BUILD)
						this.#topRewriter = lib;
				} catch (error) {
					// a top of another kind
				}
		}
		return this.#topRewriter;
	}
	/**
	 * This bundle's codec instance, for the frames under this document
	 * when it is their top (null: it has none, they make their own).
	 * @internal
	 */
	get sharedCodec(): CodecBackend | null {
		return ownCodec();
	}
	/** the codec instance of this document's top, once looked up (null: none to share) */
	#topCodecKnown: CodecBackend | null | undefined;
	#topCodec(): CodecBackend | null {
		if (this.#topCodecKnown === undefined) {
			this.#topCodecKnown = null;
			const top = this.#topClient();
			if (top !== this)
				try {
					const codec = top.sharedCodec;
					if (
						typeof codec === 'object' &&
						codec !== null &&
						codec.build === BUILD
					)
						this.#topCodecKnown = codec;
				} catch (error) {
					// a top of another kind
				}
		}
		return this.#topCodecKnown;
	}
	/** where this document's URLs are sealed: its top's instance, its own, or JavaScript (tests) */
	get codecRuns(): 'top' | 'own' | 'js' {
		return this.#topCodec() ? 'top' : ownCodec() ? 'own' : 'js';
	}
	#canvasTaints?: CanvasTaints;
	#heldTaints?: CanvasTaints;
	/**
	 * What the canvases, contexts, bitmaps and patterns of every proxied
	 * document that can reach this one hold of another origin (CanvasTaint).
	 * One set for them all, whichever bundle runs each: a page draws and
	 * reads a canvas of a frame or of a window it opened, with either
	 * realm's methods. It is kept by the outermost window of the proxy's
	 * real origin this one reaches, up its parents and through its opener
	 * (the controller's frame, the host in same-origin mode, a window the
	 * page opened that has no opener to go through).
	 */
	get canvasTaints(): CanvasTaints {
		return (this.#canvasTaints ??= this.#sharedTaints());
	}
	/** this window's own set, when it is the one that keeps it (canvasTaints) */
	heldCanvasTaints(): CanvasTaints {
		return (this.#heldTaints ??= newCanvasTaints());
	}
	#sharedTaints(): CanvasTaints {
		const name = this.names.client;
		let holder: object = this.global;
		const seen = new Set<object>();
		for (let hops = 0; hops < 64 && !seen.has(holder); hops++) {
			seen.add(holder);
			let next: unknown;
			try {
				const parent: unknown = Reflect.apply(nativeParentGet, holder, []);
				next =
					parent && parent !== holder
						? parent
						: Reflect.apply(nativeOpenerGet, holder, []);
				// a window of another real origin refuses the read
				if (next) Reflect.getOwnPropertyDescriptor(next as object, name);
			} catch (error) {
				break;
			}
			if (next === null || typeof next !== 'object') break;
			holder = next;
		}
		if (holder === this.global) return this.heldCanvasTaints();
		try {
			// a proxied window keeps it on its client, which no page can name
			const client = (holder as Record<string, unknown>)[name] as
				DocumentClient | undefined;
			if (client && typeof client.heldCanvasTaints === 'function')
				return client.heldCanvasTaints();
			// the controller's frame or the host: under a name of the client's
			const key = `${name}$taints`;
			const kept = Reflect.getOwnPropertyDescriptor(holder, key)?.value as
				CanvasTaints | undefined;
			if (kept) return kept;
			const made = newCanvasTaints();
			if (
				Reflect.defineProperty(holder, key, {
					value: made,
					enumerable: false,
					configurable: true,
					writable: false,
				})
			)
				return made;
		} catch (error) {
			// a window that keeps nothing: this document's own
		}
		return this.heldCanvasTaints();
	}
	/**
	 * The core module the controller left on its window (StompController
	 * publishCore), which a top takes when its client is made and a rewrite
	 * whose library holds none takes when it needs it (rewriter.ts
	 * controllerModule): on the window of the proxy's real origin this one
	 * reaches up its parents and through its opener (the host in same-origin
	 * mode), or on one of the frames of the first window above them of
	 * another origin (the controller's frame, beside the top in the host's
	 * page). Read as a data property, with the browser's own accessors and
	 * no collection a page could have changed; undefined where none is
	 * reached (a window opened with noopener).
	 */
	#controllerModule(): unknown {
		const key = coreModuleKey(this.names.client);
		const own = (window: object): unknown =>
			Reflect.getOwnPropertyDescriptor(window, key)?.value;
		let holder: object = this.global;
		// a top's parent is itself, and an opener is fixed when its window
		// is made: the walk ends, and the bound is for a chain of popups
		for (let hops = 0; hops < 64; hops++) {
			const found = own(holder);
			if (found) return found;
			const parent: unknown = Reflect.apply(nativeParentGet, holder, []);
			const next =
				parent && parent !== holder
					? parent
					: Reflect.apply(nativeOpenerGet, holder, []);
			if (next === null || typeof next !== 'object' || next === holder)
				return undefined;
			try {
				// a window of another real origin refuses the read
				own(next);
			} catch (error) {
				if (next !== parent) return undefined;
				const frames = next as Window;
				for (let index = 0; index < 64; index++)
					try {
						const frame = frames[index] as object | undefined;
						if (!frame) break;
						if (frame !== holder) {
							const found = own(frame);
							if (found) return found;
						}
					} catch (error) {
						// a frame of another origin
					}
				return undefined;
			}
			holder = next;
		}
		return undefined;
	}
	/**
	 * Throws the browser's DataCloneError when a message holds or transfers
	 * a tainted ImageBitmap (set by CanvasTaint): `iface` and `method` name
	 * the call, as the browser's message does
	 */
	cloneCheck?: (
		iface: string,
		method: string,
		data: unknown,
		transfer?: unknown,
	) => void;
	/** the client of the proxied top this document is under (topClientOf) */
	#topClient(): DocumentClient {
		return topClientOf(this, this.names.client);
	}
	/**
	 * A frame's workers are handed the modules its top asked for (a frame
	 * asks for none: it rewrites in its top's library). A document with no
	 * top to reach (sandboxed to an opaque origin) is its own, and holds
	 * none.
	 */
	protected override makeBare(port: MessagePort | Promise<MessagePort>) {
		return deferred('bareClient')(port);
	}
	protected override moduleHolder(): Client | null {
		return this.#topClient();
	}
	/** the page's flags of the document in `context`, or null */
	#flagsOf(context: unknown): Set<string> | null {
		const client = (context as Record<string, unknown>)[this.names.client] as
			DocumentClient | undefined;
		return client?.sandboxFlags ?? null;
	}
	/** a popup's flags from its opener, when the opener's sandbox carries over */
	#openerFlags(): Set<string> | null {
		try {
			const openerGet = Reflect.getOwnPropertyDescriptor(
				this.global,
				'opener',
			)?.get;
			const opener = openerGet && Reflect.apply(openerGet, this.global, []);
			if (!opener || opener === this.global) return null;
			const client = (opener as Record<string, unknown>)[this.names.client] as
				DocumentClient | undefined;
			this.#openerOpaque = client?.sandboxedOpaque === true;
			const flags = this.#flagsOf(opener);
			if (!flags || flags.has('allow-popups-to-escape-sandbox')) return null;
			return flags;
		} catch (error) {
			// an opener of another origin (the host in isolation mode)
			return null;
		}
	}
	#sandbox(): Set<string> | null {
		const narrowed = (
			flags: Set<string> | null,
			other: Set<string> | null,
		): Set<string> | null =>
			!other
				? flags
				: flags
					? new Set([...flags].filter((token) => other.has(token)))
					: new Set(other);
		// what its frame gives it: its frame element's sandbox and its
		// parent's flags, or (the site pool, a parent of another slot) what
		// its route says the parent gave it
		let frameFlags: Set<string> | null = null;
		try {
			const frame =
				this.#frameElementGet &&
				(Reflect.apply(
					this.#frameElementGet,
					this.global,
					[],
				) as Element | null);
			this.#frameTopNavigation = false;
			if (frame) {
				const sandbox = pageSandbox(frame, markerPrefix());
				if (sandbox !== null) {
					const tokens = sandboxTokens(sandbox);
					frameFlags = narrowed(frameFlags, tokens);
					this.#frameTopNavigation = tokens.has('allow-top-navigation');
				}
			} else {
				const marked = this.slotMark?.sandbox;
				if (marked) {
					frameFlags = new Set(marked);
					this.#frameTopNavigation = frameFlags.has('allow-top-navigation');
				}
			}
			const parent = this.parent;
			if (parent !== this.global)
				frameFlags = narrowed(frameFlags, this.#flagsOf(parent));
		} catch (error) {
			// a cross-origin parent (the host in isolation mode)
		}
		this.pool[Pool.FrameFlags] = frameFlags;
		// its own policies' sandbox (a header's: the browser gets only what it
		// can enforce of it, src/csp.ts)
		return narrowed(
			narrowed(this.#inheritedFlags, this.#policyFlags),
			frameFlags,
		);
	}
	/** the element of the frame this window is in, as the browser has it (null for none) */
	nativeFrameElement(): Element | null {
		if (!this.#frameElementGet) return null;
		try {
			return Reflect.apply(this.#frameElementGet, this.global, []);
		} catch (error) {
			return null;
		}
	}
	/**
	 * The policy a frame element's csp attribute requires of its documents
	 * (CSP Embedded Enforcement), as the page wrote it (the browser never
	 * has the attribute, DOMAttributes), else undefined. Chrome ignores a
	 * value that is no single policy, or one that reports.
	 */
	requiredCSP(element: Element | null): string | undefined {
		if (!element || element.nodeName !== 'IFRAME') return undefined;
		const value =
			Reflect.apply(nativeGetAttribute, element, [`${markerPrefix()}csp`]) ??
			Reflect.apply(nativeGetAttribute, element, ['csp']);
		if (
			typeof value !== 'string' ||
			value.trim() === '' ||
			value.length > 4096 ||
			value.includes(',') ||
			/(?:^|;)\s*report-(?:uri|to)\b/i.test(value)
		)
			return undefined;
		return value;
	}
	/** whether this document's frame's sandbox attribute grants allow-top-navigation */
	#frameTopNavigation = false;
	/** decide this document's sandbox again: a new document of this window starts */
	refreshSandbox() {
		this.sandboxFlags = this.#sandbox();
		this.guardScripts();
	}
	/** whether this document's sandbox grants `flag` (an unsandboxed one grants all) */
	allows(flag: string): boolean {
		return this.sandboxFlags === null || this.sandboxFlags.has(flag);
	}
	/**
	 * Whether this document is an opaque origin natively: sandboxed without
	 * allow-same-origin
	 */
	get sandboxedOpaque(): boolean {
		return !this.allows('allow-same-origin');
	}
	/**
	 * Called by the shell before the page runs: what the service worker's
	 * list says of a host's site, this document's own or its top's
	 * (src/inject/sites.ts). The questions this document asks about itself
	 * are answered from it, and the list in the rewriter library is asked
	 * only about a host no shell named.
	 */
	learnSites(facts: unknown): void {
		learnSites(facts);
	}
	/** @internal the site questions this bundle answered from its shells, and the ones it asked the list (site-facts suite) */
	get siteAnswers(): { known: number; asked: number } {
		return { known: siteAnswers.known, asked: siteAnswers.asked };
	}
	#siteKey?: { document: Document; opaque: boolean; key: string | null };
	/**
	 * The site this document belongs to (siteKeyOf), which the window
	 * membrane compares a caller's with a window's by on every use: null for
	 * an opaque origin (a sandbox without allow-same-origin), which is another
	 * site to every document. Computed once per document: a window keeps its
	 * client across a document of its own origin (an about:blank its next
	 * document reuses), and a site never changes within one document.
	 */
	get siteKey(): string | null {
		const document = this.global.document;
		const opaque = this.sandboxedOpaque;
		const kept = this.#siteKey;
		if (kept && kept.document === document && kept.opaque === opaque)
			return kept.key;
		const origin = this.originKey;
		const key = origin === null ? null : siteKeyOf(origin);
		this.#siteKey = { document, opaque, key };
		return key;
	}
	#originKey?: { document: Document; opaque: boolean; key: string | null };
	/**
	 * This document's origin (scheme, host and port) as the window membrane
	 * compares documents by (Context reachableClients): its own URL's
	 * (`url`), never its base URL's; null for an opaque origin (a sandbox
	 * without allow-same-origin, a data: document). Kept per document.
	 */
	get originKey(): string | null {
		const document = this.global.document;
		const opaque = this.sandboxedOpaque;
		const kept = this.#originKey;
		if (kept && kept.document === document && kept.opaque === opaque)
			return kept.key;
		let key: string | null = null;
		if (!opaque)
			try {
				const { origin } = this.url.url;
				key = origin === 'null' ? null : origin;
			} catch (error) {
				// no URL
			}
		this.#originKey = { document, opaque, key };
		return key;
	}
	/** the domain this document set with document.domain, where that took effect (DOMHooks) */
	#documentDomain: { document: Document; value: string } | null = null;
	/**
	 * The domain this document set with document.domain, or null when it set
	 * none or the write had no effect (an agent cluster keyed by origin, the
	 * default): what the window membrane compares it by then
	 */
	get documentDomain(): string | null {
		const kept = this.#documentDomain;
		return kept && kept.document === this.global.document ? kept.value : null;
	}
	/** @internal document.domain took effect (DOMHooks) */
	setDocumentDomain(value: string) {
		this.#documentDomain = { document: this.global.document, value };
	}
	/**
	 * What this document's response asked for in Origin-Agent-Cluster: 'site'
	 * for ?0, 'origin' for ?1, null for neither (its shell says so before the
	 * page runs)
	 */
	agentCluster: 'site' | 'origin' | null = null;
	/** the mark its shell gave, and the document it was given for */
	#cacheMark: { document: Document; mark: string } | null = null;
	/**
	 * The cache mark of this document's site (src/memoryMark.ts), which the
	 * routes it makes of what the renderer's memory cache keeps carry: its
	 * shell's (the service worker's, or its builder's), an about:blank or
	 * about:srcdoc document's maker's, the opaque one for an opaque origin (it
	 * shares nothing with its site's documents natively: a sandboxed frame is
	 * isolated in a renderer of its own), none for a document no shell named
	 * one for. None either while a policy of the document's governs what
	 * the mark goes on (MARK_DIRECTIVES): natively the renderer judges a
	 * load by the policy before its memory cache answers it, and here the
	 * worker judges it by the real URL, which a load the renderer answers
	 * never reaches.
	 */
	get cacheMark(): string {
		if (this.sandboxedOpaque) return OPAQUE_MARK;
		if (
			this.pagePolicies().some(({ policy }) =>
				MARK_DIRECTIVES.some(
					(directive) => governing(policy, directive) !== null,
				),
			)
		)
			return '';
		const document = this.global.document;
		const own = this.#cacheMark;
		if (own && own.document === document) return own.mark;
		let protocol: string;
		try {
			protocol = this.global.location.protocol;
		} catch (error) {
			return '';
		}
		if (protocol !== 'about:') return '';
		const creator = this.#creatorClient();
		if (!creator || creator.originKey !== this.originKey) return '';
		// (kept for the document: its maker's site is its own for good)
		const mark = creator.cacheMark;
		this.#cacheMark = { document, mark };
		return mark;
	}
	/** @internal its shell names it, before the page runs */
	set cacheMark(mark: unknown) {
		this.#cacheMark =
			typeof mark === 'string' && (mark === '' || CACHE_MARK_SHAPE.test(mark))
				? { document: this.global.document, mark }
				: null;
	}
	/**
	 * @internal the agent cluster keying of each origin in this browsing
	 * context group, kept by its top (true: keyed by site): an origin's first
	 * document there decides it for every later one, as in Chrome
	 */
	agentClusters?: Map<string, boolean>;
	#siteKeyed?: { document: Document; keyed: boolean };
	/**
	 * Whether this document's agent cluster is keyed by site, where
	 * document.domain takes effect and window.originAgentCluster is false:
	 * only when the first document of its origin in the tab asked for it
	 * with Origin-Agent-Cluster: ?0 (Chrome keys by origin by default, and
	 * always for a cross-origin isolated document). Decided when the
	 * document is made (apply), before its page runs.
	 */
	get siteKeyed(): boolean {
		const document = this.global.document;
		const kept = this.#siteKeyed;
		if (kept && kept.document === document) return kept.keyed;
		let keyed = false;
		const origin = this.originKey;
		let isolated = false;
		try {
			isolated = Reflect.get(this.global, 'crossOriginIsolated') === true;
		} catch (error) {
			// not readable: not isolated
		}
		if (origin !== null && !isolated) {
			const group = this.#agentGroup();
			const known = group.get(origin);
			keyed = known ?? this.agentCluster === 'site';
			if (known === undefined) group.set(origin, keyed);
		}
		this.#siteKeyed = { document, keyed };
		return keyed;
	}
	/** the keying map of this document's browsing context group: its top's, or its opener's top's */
	#agentGroup(): Map<string, boolean> {
		return (this.groupClient.agentClusters ??= new Map());
	}
	/**
	 * @internal the client that keeps what this document's browsing context
	 * group shares: its top's, or its opener's top's
	 */
	get groupClient(): DocumentClient {
		const document = this.global.document;
		const kept = this.#group;
		if (kept && kept.document === document) return kept.client;
		const client = this.#findGroup();
		this.#group = { document, client };
		return client;
	}
	/** the group's client, kept per document (every stand-in handed out asks, IFrame) */
	#group?: { document: Document; client: DocumentClient };
	#findGroup(): DocumentClient {
		const topOf = (client: DocumentClient): DocumentClient => {
			try {
				const top = (client.proxiedTop as Record<string, unknown>)[
					this.names.client
				] as DocumentClient | undefined;
				if (top?.isDOM) return top;
			} catch (error) {
				// a top of another real origin
			}
			return client;
		};
		let group = topOf(this);
		for (let depth = 0; depth < 8; depth++) {
			let opener: DocumentClient | undefined;
			try {
				const window = Reflect.get(group.global, 'opener') as Record<
					string,
					unknown
				> | null;
				opener =
					window && window !== (group.global as unknown)
						? (window[this.names.client] as DocumentClient | undefined)
						: undefined;
			} catch (error) {
				// an opener of another real origin
			}
			if (!opener?.isDOM || opener === group) break;
			group = topOf(opener);
		}
		return group;
	}
	/**
	 * @internal the windows each frame element showed before the fresh
	 * browsing contexts it was given (freshContext.ts), kept by the group's
	 * client, and the element each such window was the frame of
	 */
	freshRegistry?: {
		frames: WeakMap<
			Element,
			{ windows: WeakRef<object>[]; destination: string | null }
		>;
		elements: WeakMap<object, Element>;
		/** the WeakRef of the realm that made the registry, which makes `windows`' */
		weakRef: typeof WeakRef;
		/** how many windows were recorded (none: nothing to look up) */
		held?: number;
	};
	/**
	 * The policies the browser applies to this document for the page's own
	 * (src/csp.ts): its headers' (the shell's) and its metas', each browser
	 * policy's text with the page's text it stands for
	 */
	get policyTexts(): PolicyText[] {
		return this.#policyTexts;
	}
	/**
	 * Set by the shell before the page runs, with its headers' policies:
	 * their `sandbox` directives sandbox the document (sandboxFlags), which
	 * is decided again now
	 */
	set policyTexts(texts: PolicyText[]) {
		this.#policyTexts = texts;
		this.#policyFlags = policySandbox(
			texts.flatMap(([, page, disposition]) =>
				parsePolicies(page, disposition, 'header'),
			),
		);
		this.refreshSandbox();
	}
	#policyTexts: PolicyText[] = [];
	/** the flags of the `sandbox` directives of this document's header policies, or null */
	#policyFlags: Set<string> | null = null;
	/** the mark this document's meta policies share (markedPolicy) */
	#policyMark: string | null = null;
	/**
	 * The content the browser gets for a page's `<meta
	 * http-equiv="Content-Security-Policy">` whose content is `content`, or
	 * null when it holds nothing the browser can apply (src/csp.ts)
	 */
	metaPolicy(content: string): string | null {
		const known = this.#metaPolicies.get(content);
		if (known !== undefined) return known.value;
		this.#policyMark ??= policyMark();
		const texts: PolicyText[] = [];
		for (const policy of parsePolicies(content, 'enforce', 'meta')) {
			// (with the name of the inject's own Trusted Types policy: trusted.ts)
			// the browser enforces no Trusted Types policy of the page's
			// (src/csp.ts), so a meta that sets one does not turn STomp's own
			// Trusted Types on
			const text = browserPolicy(policy, this.url.url, this.sites?.origins);
			texts.push([
				text === null
					? ''
					: markedPolicy(
							text,
							`${this.#policyMark}${this.#metaPolicies.size}-${texts.length}`,
						),
				policy.text,
				'enforce',
			]);
		}
		const value =
			texts
				.map(([browser]) => browser)
				.filter(Boolean)
				.join(', ') || null;
		this.#metaPolicies.set(content, { value, texts });
		return value;
	}
	/** what metaPolicy made of each content: the browser's, and each policy's texts */
	readonly #metaPolicies = new LazyMap<
		string,
		{ value: string | null; texts: PolicyText[] }
	>();
	/**
	 * The policies of the metas the browser applied in this document: a
	 * meta of the head's when it is seen there (a meta counts once it was
	 * inserted, natively, even when it is removed later; one outside the head
	 * counts for nothing), by the content the page wrote. Each is looked for
	 * whenever the policies are read.
	 */
	readonly #appliedMetas = new LazyMap<string, PolicyText[]>();
	#metaTexts(): PolicyText[] {
		try {
			const head = this.global.document.head;
			if (head)
				for (const meta of Reflect.apply(nativeQuerySelectorAll, head, [
					'meta[http-equiv]',
				]) as Iterable<Element>) {
					if (
						Reflect.apply(nativeParent, meta, []) !== head ||
						(
							Reflect.apply(nativeGetAttribute, meta, ['http-equiv']) ?? ''
						).toLowerCase() !== 'content-security-policy'
					)
						continue;
					const content = Reflect.apply(nativeGetAttribute, meta, [
						`${markerPrefix()}content`,
					]) as string | null;
					if (content === null || this.#appliedMetas.has(content)) continue;
					const made = this.#metaPolicies.get(content);
					if (made) this.#appliedMetas.set(content, made.texts);
				}
		} catch (error) {
			// a document being torn down
		}
		return [...this.#appliedMetas.values()].flat();
	}
	/**
	 * The page's text of the policy the browser reports as `text` (a
	 * violation's originalPolicy), or null for none of the page's: this
	 * document's own, or one it inherited from the document that made it
	 * (an about:blank, srcdoc, blob: or data: document has its creator's
	 * policies)
	 */
	pagePolicyText(text: string): string | null {
		if (text) {
			for (const [browser, page] of this.policyTexts)
				if (browser === text) return page;
			for (const { texts } of this.#metaPolicies.values())
				for (const [browser, page] of texts) if (browser === text) return page;
		}
		return this.#policyCreator()?.pagePolicyText(text) ?? null;
	}
	/** the browser policies of this document, its own and those it inherited */
	browserPolicies(): string[] {
		return [
			...[...this.policyTexts, ...this.#metaTexts()]
				.map(([browser]) => browser)
				.filter(Boolean),
			...(this.#policyCreator()?.browserPolicies() ?? []),
		];
	}
	/**
	 * The page's policies of this document, its own and those it inherited,
	 * each with the browser policy it stands for and what 'self' means in it
	 * (the real URL of the document whose policy it is)
	 */
	pagePolicies(): { policy: Policy; browser: string; self: URL }[] {
		const texts = [...this.policyTexts, ...this.#metaTexts()];
		if (this.#parsedPolicies?.count !== texts.length) {
			const own: { policy: Policy; browser: string; self: URL }[] = [];
			for (const [browser, page, disposition] of texts)
				for (const policy of parsePolicies(page, disposition, 'header'))
					own.push({ policy, browser, self: this.url.url });
			this.#parsedPolicies = { count: texts.length, own };
		}
		return [
			...this.#parsedPolicies.own,
			...(this.#policyCreator()?.pagePolicies() ?? []),
		];
	}
	#parsedPolicies: {
		count: number;
		own: { policy: Policy; browser: string; self: URL }[];
	} | null = null;
	/** the page's policies of this document that natively refuse (or report) `url` for `directive` */
	pageRefusals(
		directive: string,
		url: URL,
		redirected = false,
	): { policy: Policy; browser: string; self: URL }[] {
		return this.pagePolicies().filter(({ policy, self }) => {
			const governed = governing(policy, directive);
			return (
				governed !== null &&
				!sourcesMatch(governed.sources, url, self, redirected)
			);
		});
	}
	/**
	 * Where a load of this document that no worker sees (a frame, an
	 * object's copy) goes instead of `url` when the page's enforced policy
	 * refuses it for `directive`, or null when it may load: a data: or
	 * blob: URL as it is where the browser's copy of the policy refuses
	 * that scheme as the page's does (it names them as natively), any other
	 * a refusal URL that reads as Chrome names the load (a navigation of
	 * another origin by its origin)
	 */
	loadRefusal(directive: string, url: URL, navigation = false): string | null {
		// (made only where a policy refuses or reports the load; the part
		// cannot be had: refused, at a URL the browser refuses or cannot load)
		if (
			!/^(https?|data|blob):$/.test(url.protocol) ||
			!this.pageRefusals(directive, url).length
		)
			return null;
		const checks = this.#checks();
		return checks
			? checks.loadRefusal(this, directive, url, navigation)
			: this.refusalURL('https', url.href, url.href);
	}
	/**
	 * Whether the page's enforced connect-src refuses a request for `url`
	 * that no worker sees as the page's (a synchronous XMLHttpRequest, which
	 * the bridge carries): the browser is made to refuse and report it, by a
	 * request to a refusal URL that reads as `url`
	 */
	connectRefusal(url: URL): boolean {
		if (!/^(https?|data|blob|filesystem|mediastream):$/.test(url.protocol))
			return false;
		const refusing = this.pageRefusals('connect-src', url).some(
			({ policy }) => policy.disposition === 'enforce',
		);
		if (!refusing) return false;
		// make the browser fire its own connect-src refusal (a synchronous
		// request the sync bridge would route to the proxy origin otherwise,
		// which 'self' allows): an http(s) URL through a refusal URL (its
		// route is the proxy's), a local scheme (data:, blob:) fetched as
		// written, which the browser refuses by its scheme as natively
		this.nativeFetch(
			/^https?:$/.test(url.protocol)
				? this.refusalURL('https', url.href, url.href.replace(/#.*$/s, ''))
				: url.href,
		).catch(() => {});
		return true;
	}
	/**
	 * What a blob: worker this document makes inherits of its policies, for
	 * its own connections (src/csp.ts WorkerPolicies), or null for none that
	 * governs them. Throws where the part cannot be had (the worker is not
	 * made)
	 */
	connectInheritance(): WorkerPolicies | null {
		return this.pagePolicies().length
			? deferred('policyChecks').connectInheritance(this)
			: null;
	}
	/** where a WebSocket to `url` goes instead when the page's enforced connect-src refuses it, or null */
	socketRefusal(url: URL): string | null {
		const refusing = this.pageRefusals('connect-src', url).some(
			({ policy }) => policy.disposition === 'enforce',
		);
		if (refusing)
			return this.refusalURL('wss', url.href, url.href.replace(/#.*$/s, ''));
		this.reportRefusal('connect-src', url);
		return null;
	}
	/**
	 * The page policy's checks (./policyChecks.ts), a deferred part made the
	 * first time a document with a policy of the page's needs one; null where
	 * it cannot be had, where each check refuses and a report is lost
	 */
	#checks(): PolicyChecks | null {
		try {
			return deferred('policyChecks');
		} catch (error) {
			return null;
		}
	}
	/**
	 * Report a load of `url` for `directive` that a report-only policy of
	 * the page's refuses and that went out (no enforced one refuses it): an
	 * event for each such policy, as the browser fires it, named as Chrome
	 * names the load (a navigation of another origin by its origin). The
	 * browser cannot be made to report it itself without refusing the load,
	 * so the event is the inject's: the same fields, read as trusted.
	 */
	reportRefusal(
		directive: string,
		url: URL,
		navigation = false,
		/** how many events the browser fires for one (a fetch is judged twice, measured) */
		times = 1,
		/** a navigation's later hop: what the report names (Chrome's choice, the worker's to make) */
		hop?: string,
	) {
		// (made only where a report-only policy may refuse it; the part
		// cannot be had: the load went out all the same, unreported)
		if (
			!/^(https?|wss?):$/.test(url.protocol) ||
			!this.pagePolicies().some(({ policy }) => policy.disposition === 'report')
		)
			return;
		this.#checks()?.reportRefusal(this, directive, url, navigation, times, hop);
	}
	override trustedTypesRequired(): 'enforce' | 'report' | null {
		return trustedTypesRequired(
			this.pagePolicies().map(({ policy }) => policy),
		);
	}
	/**
	 * Synthesised Trusted Types violations the browser cannot fire (it gets no
	 * `require-trusted-types-for`/`trusted-types`, src/csp.ts): the inject
	 * judges the page's value and reports its refusal itself. Each reads
	 * back trusted, as the browser's does, and so does every other violation
	 * the inject fires (./violations.ts): the view of it every listener is
	 * handed, by the event (../violationDispatch.ts).
	 */
	readonly violationViews = new LazyWeakMap<object, object>();
	/** a sink's refusal only report-only policies make: the inject's event (the browser judges its own value) */
	override reportTrustedTypes(sink: string, value: string) {
		this.#checks()?.reportTrustedTypes(this, sink, value);
	}
	/** a sink's refusal an enforced require-trusted-types-for makes: a trusted violation, as the browser's */
	reportTrustedSink(sink: string, value: string) {
		this.#checks()?.reportTrustedSink(this, sink, value);
	}
	/** a createPolicy the page's `trusted-types` directive refuses (`policy` is the one that refuses it) */
	reportTrustedPolicy(policy: Policy, name: string) {
		this.#checks()?.reportTrustedPolicy(this, policy, name);
	}
	/**
	 * How the page's `trusted-types` directive refuses a `createPolicy` of
	 * `name` (`made`: the names already created): a refusal for each policy
	 * that refuses it (its disposition decides whether it throws, and whether
	 * its violation is trusted), with Chrome's message, or an empty list where
	 * every policy allows it. No `trusted-types` directive lets any name and
	 * any duplicate through (src/csp.ts: the browser gets neither directive).
	 */
	refusedTrustedPolicy(
		name: string,
		made: ReadonlySet<string>,
	): { policy: Policy; message: string }[] {
		const policies = this.pagePolicies()
			.map(({ policy }) => policy)
			.filter((policy) => policy.directives.has('trusted-types'));
		// no trusted-types directive: the part is not made (most pages that
		// create a policy have none)
		return policies.length
			? deferred('refusedTrustedPolicy')(policies, name, made)
			: [];
	}
	/** the exact error Chrome throws at a refused Trusted Types `sink` (src/inject/modules/TrustedTypes.ts) */
	trustedTypeError(
		sink: string,
		type: string,
		tail: string,
		attribute: boolean,
	): Error {
		try {
			return deferred('trustedTypeError')(
				this.global as typeof globalThis,
				sink,
				type,
				tail,
				attribute,
			);
		} catch (error) {
			// the part cannot be had: the sink still refuses, with its error
			return error as Error;
		}
	}
	/**
	 * What a synthesised code violation's `target` reads as (the element the
	 * browser names, which may be gone or never connected by the time the
	 * event fires): the event is dispatched on the document, which always
	 * reaches the page's listener, and ContentSecurity reads this back
	 * (src/inject/dom/modules/ContentSecurity.ts).
	 */
	readonly codeViolationTarget = new LazyWeakMap<object, Node>();
	/**
	 * Hooks the getter that reads them back, the first time one is recorded
	 * (ContentSecurity sets it; gone once it ran)
	 */
	namesViolationTargets?: () => void;
	/**
	 * Bases about to connect (the inserted node, or those in it): where the
	 * page's code inserted one a violation may name (./violations.ts
	 * noteBaseSite sets it, at the first base the page's policy refuses)
	 */
	notesBases?: (bases: Element[]) => void;
	/** whether any policy of this document governs scripts or styles (the inject enforces them against the page's code) */
	get codeEnforced(): boolean {
		return this.scriptFacts.code === true || enforcesCode(this.#ownPolicies());
	}
	#ownPolicies(): Policy[] {
		return this.pagePolicies().map(({ policy }) => policy);
	}
	/**
	 * How the page's own script-src refuses code made from a string, as Chrome
	 * does (measured): fires the violation(s) and returns the error to throw
	 * (an EvalError, or a CompileError for WebAssembly; null for a string
	 * timer, which runs nothing and throws nothing), or null where it runs.
	 * Refused, with the error that says so, where the part cannot be had.
	 */
	override codeEval(
		kind: 'eval' | 'Function' | 'timer' | 'wasm-compile' | 'wasm-module',
		sample: string,
	): { error: Error | null } | null {
		if (!this.codeEnforced) return null;
		try {
			return deferred('policyChecks').codeEval(this, kind, sample);
		} catch (error) {
			return { error: error as Error };
		}
	}
	/** each element a code violation was already reported for, and its verdict (so a second pass neither re-fires nor changes it) */
	readonly #codeVerdict = new LazyWeakMap<object, boolean>();
	/**
	 * Whether the page's own policy refuses `element`'s code at `directive`
	 * (./policyChecks.ts codeRefused), firing the violation(s) the browser
	 * would: true where an enforced policy refuses it, so the caller must not
	 * run, load or apply it, and where the part cannot be had
	 */
	#refuseOnce(
		element: Element,
		directive: string,
		code: string | URL,
		parser?: boolean,
	): boolean {
		if (!this.codeEnforced) return false;
		const cached = this.#codeVerdict.get(element);
		if (cached !== undefined) return cached;
		const refused =
			this.#checks()?.codeRefused(this, element, directive, code, parser) ??
			true;
		this.#codeVerdict.set(element, refused);
		return refused;
	}
	/** whether the page's script-src refuses this inline script (its own `text`); fires the violation and the caller blanks it */
	refuseInlineScript(element: Element, text: string, parser: boolean): boolean {
		// Chrome prepares no script without a src whose text is empty (it is
		// judged once it has text): a held script (holdScript), or markup that
		// carries one, has no src
		if (text === '') return false;
		return this.#refuseOnce(element, 'script-src-elem', text, parser);
	}
	/** whether the page's script-src refuses this external script (`url`); fires the violation and the caller neutralises it */
	refuseExternalScript(element: Element, url: URL, parser: boolean): boolean {
		return this.#refuseOnce(element, 'script-src-elem', url, parser);
	}
	/**
	 * The page's external scripts its script-src refused when their src was
	 * set, before they connected, where a nonce could still let them through:
	 * Chrome judges a script as it prepares it, when it connects, with the
	 * nonce it has then (a page may give the nonce after the src). Such a
	 * script is held refused, its src the page's (`src`) and its real URL
	 * (`url`), and judged again by the insertion that connects it
	 * (DOMContentHooks). One that reaches a document any other way stays
	 * refused, as it was judged.
	 */
	readonly #heldScripts = new LazyWeakMap<Element, { url: URL; src: string }>();
	#heldCount = 0;
	/**
	 * Whether a script by `url` the page gives a src to before it connects is
	 * refused for now only by enforced policies that take nonces, so the nonce
	 * it has when it connects decides (holdScript); nothing is fired. A script
	 * of another document (the inject's own copies of markup) never waits
	 */
	scriptAwaitsNonce(element: Element, url: URL): boolean {
		if (!this.codeEnforced) return false;
		if (
			Reflect.apply(nativeOwnerDocument, element, []) !== this.global.document
		)
			return false;
		// (the part cannot be had: not held, and refused as it is judged,
		// refuseExternalScript)
		return this.#checks()?.awaitsNonce(this, element, url) ?? false;
	}
	/** hold `element` (scriptAwaitsNonce) until it connects */
	holdScript(element: Element, url: URL, src: string) {
		if (!this.#heldScripts.has(element)) this.#heldCount++;
		this.#heldScripts.set(element, { url, src });
	}
	/** whether any script is held (holdScript) */
	get scriptsHeld(): boolean {
		return this.#heldCount > 0;
	}
	/** whether `element` is held (holdScript) */
	scriptHeld(element: Element): boolean {
		return this.#heldScripts.has(element);
	}
	/** a held script's src and URL, which it no longer is (it connects, or the page set its src again) */
	releaseScript(element: Element): { url: URL; src: string } | null {
		const held = this.#heldScripts.get(element);
		if (!held) return null;
		this.#heldScripts.delete(element);
		this.#heldCount--;
		return held;
	}
	/** whether the page's script-src-attr refuses this inline handler (`value`); fires the violation */
	refuseHandler(element: Element, value: string): boolean {
		return this.#refuseOnce(element, 'script-src-attr', value);
	}
	/** whether the page's style-src refuses this inline style (its own `text`); fires the violation (targets the document, as Chrome does for styles) and the caller blanks it */
	refuseInlineStyle(element: Element, text: string, parser: boolean): boolean {
		return this.#refuseOnce(element, 'style-src-elem', text, parser);
	}
	/** the 'error' event the browser fires on a script or stylesheet its policy refused (deferred, once it is connected) */
	dispatchLoadError(element: Element) {
		const global = this.global as typeof globalThis;
		nativeSetTimeout(() => {
			try {
				Reflect.apply(global.EventTarget.prototype.dispatchEvent, element, [
					new global.Event('error'),
				]);
			} catch (error) {
				// the element was removed
			}
		});
	}
	/** whether the page's style-src-attr refuses this style attribute (`value`); fires the violation (targets the document, as Chrome does for styles) */
	refuseStyleAttribute(element: Element, value: string): boolean {
		return this.#refuseOnce(element, 'style-src-attr', value);
	}
	/** whether the page's style-src refuses this external stylesheet (`url`); fires the violation and the caller neutralises it */
	refuseExternalStyle(element: Element, url: URL): boolean {
		return this.#refuseOnce(element, 'style-src-elem', url);
	}
	/**
	 * Give a script or style element of the page's the document's nonce
	 * where the browser's copy of the page's policy would refuse what the
	 * page's own allows (./policyChecks.ts codeNonce): `url` its real URL,
	 * or null with `text` the page's own text of an inline one; `parser`:
	 * the element is the parser's. Throws where the part cannot be had (the
	 * element was judged before, and refused then: #refuseOnce)
	 */
	giveCodeNonce(
		element: Element,
		url: URL | null,
		text: string | null,
		parser: boolean,
	) {
		const nonce = this.scriptNonce;
		if (nonce === null || !this.codeEnforced) return;
		const given = deferred('policyChecks').codeNonce(
			this,
			element,
			url,
			text,
			parser,
			nonce,
		);
		if (given !== null)
			Reflect.apply(nativeSetAttribute, element, ['nonce', given]);
	}
	/** the URLs refusalURL made, by their host: the URL each stands for, and what a report names it by */
	readonly refusals = new LazyMap<string, { url: string; blocked: string }>();
	/**
	 * A URL the browser's copy of every page policy refuses (src/csp.ts),
	 * for a load of the page's that its own policy refuses where no worker
	 * sees it (a frame, a WebSocket): the browser refuses and reports it,
	 * and the violation reads `blocked` (what Chrome names the load by) as
	 * its blockedURI. Its host is its own, for a report that names only an
	 * origin (a frame's).
	 */
	refusalURL(scheme: 'https' | 'wss', url: string, blocked: string): string {
		const host = `r${this.refusals.size}${Math.random().toString(36).slice(2, 8)}.refused.invalid`;
		this.refusals.set(host, { url, blocked });
		return `${scheme}://${host}/`;
	}
	/** what a blockedURI the browser reports for a URL of refusalURL's stands for, or null for another */
	refusedURI(value: string): { url: string; blocked: string } | null {
		const host = /^[a-z]+:\/\/([^/:]+\.refused\.invalid)(?:[:/]|$)/.exec(
			value,
		)?.[1];
		if (!host) return null;
		const known = this.refusals.get(host);
		if (known !== undefined) return known;
		// one the worker sent a frame's refused redirect to (namedRefusal),
		// named as Chrome names a refused navigation
		const named = refusalNamed(host);
		if (named !== null) {
			const url = new URL(named);
			return {
				url: named,
				blocked:
					url.origin === this.url.url.origin
						? named.replace(/#.*$/s, '')
						: url.origin,
			};
		}
		try {
			return this.#policyCreator()?.refusedURI(value) ?? null;
		} catch (error) {
			return null;
		}
	}
	/**
	 * The page's policies of this document that judge the later hops of a
	 * navigation it starts or lets a frame of its make (`directive`:
	 * form-action, frame-src), as the worker is told them (src/csp.ts
	 * HopPolicy), or null for none
	 */
	hopPolicies(directive: string): HopPolicy[] | null {
		const policies: HopPolicy[] = [];
		for (const { policy, self } of this.pagePolicies()) {
			const governed = governing(policy, directive);
			if (governed)
				policies.push([
					directive,
					governed.sources,
					policy.disposition,
					self.href,
				]);
		}
		return policies.length ? policies : null;
	}
	/**
	 * Whether the page's enforced base-uri refuses `url` for a <base>
	 * (`base`): its headers' and its metas', those before it in its
	 * document too (markup the hooks rewrite before its metas apply;
	 * src/csp.ts). Its hook names a refusal URL in its place, and the
	 * document's URL stays the base URL.
	 */
	baseRefused(url: URL, base: Element): boolean {
		if (
			this.pageRefusals('base-uri', url).some(
				({ policy }) => policy.disposition === 'enforce',
			)
		)
			return true;
		// (a copy of the markup's base is judged before it is in its tree:
		// by the metas before the parsed one it was made from)
		const placed = parsedBases.get(base) ?? base;
		for (const meta of placed.ownerDocument.querySelectorAll(
			'head meta[http-equiv]',
		)) {
			if (
				!(meta.compareDocumentPosition(placed) & 4) ||
				meta.getAttribute('http-equiv')!.toLowerCase() !==
					'content-security-policy'
			)
				continue;
			for (const policy of parsePolicies(
				meta.getAttribute('content'),
				'enforce',
				'meta',
			)) {
				const sources = policy.directives.get('base-uri');
				if (sources && !sourcesMatch(sources, url, this.url.url)) return true;
			}
		}
		return false;
	}
	/** the client of the proxied document this one is a frame of, or null at the proxied top */
	parentClient(): DocumentClient | null {
		try {
			const parent = this.parent as unknown as Record<string, unknown>;
			if (parent === (this.global as unknown)) return null;
			const client = parent[this.names.client] as DocumentClient | undefined;
			return client && client !== this && client.isDOM ? client : null;
		} catch (error) {
			return null;
		}
	}
	/**
	 * The real origins of this document's ancestors up to the proxied top,
	 * nearest first ("null" for an opaque one): what a framed document's
	 * frame-ancestors judges (the host's page is none of the page's)
	 */
	ancestorOrigins(): string[] {
		const origins: string[] = [];
		let last: DocumentClient | null = null;
		for (
			let client = this.parentClient();
			client && origins.length < 64;
			client = client.parentClient()
		) {
			origins.push(client.origin);
			last = client;
		}
		// the site pool: past a parent of another slot's origin, the ancestors
		// the worker was told of when it served the frame of this world that
		// is under it (ScriptFacts.framed), else what the route's marker says
		// (none past a proxied top: the hub's page is above it)
		const outer = last ?? this;
		const sites = this.sites;
		if (sites && outer.nested)
			origins.push(
				...(siteWindows().framedOf(outer)?.ancestors ??
					siteWindows().ancestorsPast(this, sites, outer, origins.length)),
			);
		return origins.slice(0, 64);
	}
	/**
	 * Whether the browser refuses (or reports) a URL of `scheme` for
	 * `directive` in this document: a policy of the page's says so
	 * (src/csp.ts), and a request of the proxy's own of that kind would show
	 * the page a violation it never made
	 */
	browserRefuses(directive: string, scheme: string): boolean {
		return browserRefuses(this.browserPolicies(), directive, scheme);
	}
	/**
	 * The client of the document this one inherited its policies from (its
	 * creator's, for a document the browser made of its creator's:
	 * about:blank, srcdoc, blob:, data:), or null for one it loaded (a
	 * routed URL's, which has its own)
	 */
	#policyCreator(): DocumentClient | null {
		try {
			if (/^https?:$/.test(this.global.location.protocol)) return null;
		} catch (error) {
			return null;
		}
		return this.#creatorClient();
	}
	/**
	 * The nonce the inject's own scripts carry: the document's (its shell's,
	 * which the browser's copy of the page's script policy names, src/csp.ts),
	 * or the policy's of a document without allow-scripts; null for none
	 */
	get scriptNonce(): string | null {
		return this.allows('allow-scripts')
			? (this.scriptFacts.nonce ?? null)
			: documentNonce(this.global.document);
	}
	/** a function of this realm made by a script with the document's nonce, where its policy refuses code made from a string */
	override compile(parameters: string[], source: string): Function | null {
		if (this.scriptFacts.evaluates) return super.compile(parameters, source);
		const nonce = this.scriptNonce;
		const made =
			nonce === null
				? null
				: libraryFactoryFromScript(
						this.global.document,
						`${COMPILED}=function(${parameters.join(',')}){${source}\n};`,
						nonce,
						COMPILED,
					);
		if (typeof made !== 'function') return super.compile(parameters, source);
		return made as Function;
	}
	/**
	 * A document without allow-scripts runs no script of the page: the real
	 * frame has to allow scripts (the inject rewrites the document), so the
	 * document gets a Content-Security-Policy that lets only scripts carrying
	 * the inject's nonce run (sandbox.ts). It is in place before any of the
	 * page's markup reaches the document, and every document this one makes
	 * of its own (about:blank, srcdoc, blob:, data:) inherits it. A document
	 * that inherited one already (its shell's scripts carry that policy's
	 * nonce) gets a policy with the same nonce.
	 */
	guardScripts() {
		if (this.allows('allow-scripts')) return;
		const document = this.global.document;
		guardDocument(
			document,
			this.#shellNonce?.document === document ? this.#shellNonce.nonce : null,
		);
	}
	/** this document's requests go from an opaque origin (the request modules mark them) */
	override get opaqueRequests(): boolean {
		return this.sandboxedOpaque;
	}
	/**
	 * This document's origin as the page sees it: its real site's, or "null"
	 * for an opaque one (a data: document, a frame sandboxed without
	 * allow-same-origin)
	 */
	get origin(): string {
		return this.sandboxedOpaque ? 'null' : this.url.url.origin;
	}
	/**
	 * The window's origin as the browser has it: the proxy origin (an
	 * about:srcdoc or about:blank document's inherited one, which its
	 * location reads as "null"), or "null" for a document the browser made
	 * opaque
	 */
	realOrigin(): string {
		if (!this.#originGet) return this.baseURI.origin;
		return Reflect.apply(this.#originGet, this.global, []);
	}
	get parent(): typeof globalThis {
		return Reflect.apply(this.parentDescriptor.get!, this.global, []);
	}
	/** @internal what this client's bundle fetches its copies through (loadGrants.ts) */
	loadSource(): LoadSource | null {
		return loadSource();
	}
	/**
	 * A child frame of a proxied page: its navigations are routed as nested
	 * documents, which the service worker never treats as top-level. A
	 * cross-origin parent (the host in isolation mode) means not nested.
	 */
	get nested(): boolean {
		try {
			const parent = this.parent;
			if (parent !== this.global && this.names.client in parent) return true;
		} catch (error) {
			// a parent of another origin: the host's, or another slot's
		}
		return this.slotMark !== null;
	}
	/**
	 * The site pool: what this document's route says of the frames above it,
	 * when its parent is a document of another slot (another origin, out of
	 * this one's reach). The parent's inject named its top origin, and
	 * whether it is in a partition, in the route it gave the frame
	 * (nestedMark), and a navigation of the frame's own keeps it. Null with a
	 * parent in reach, for a top-level document (its parent is the hub's
	 * page) and without a pool.
	 */
	get slotMark(): ReturnType<typeof parseNestedMark> {
		// (apart: a document compiles what it runs, and most run without a pool)
		const sites = this.sites;
		return sites ? siteWindows().slotMarkOf(this, sites) : null;
	}
	/**
	 * What `URL` and `documentURI` read as for `document`, whose native
	 * reading is `native`: this window's document is the page's; another
	 * proxied window's (a frame's contentDocument, read through this
	 * realm's getter) is that window's page's, by its own client; a
	 * document without a window is `about:blank` where the browser says so
	 * (one made with createHTMLDocument) and else the URL of the document
	 * that parsed it. It was this page's URL whatever the document.
	 */
	documentURL(document: object, native: string, answer: () => string): string {
		if (document === this.global.document) return answer();
		try {
			const view =
				documentViewGetter &&
				(Reflect.apply(documentViewGetter, document, []) as object | null);
			const other =
				view &&
				(Reflect.getOwnPropertyDescriptor(view, this.names.client)?.value as
					DocumentClient | undefined);
			if (other && other !== this)
				return other.documentURL(document, native, () => other.locationHref);
			if (!view && native === 'about:blank') return native;
		} catch (error) {
			// not a document this realm may read: the page's answer
		}
		return answer();
	}
	/**
	 * performance.memory per site (the Memory module), kept by the proxied
	 * top's client for every realm under it
	 */
	siteMemory?: Map<string, unknown>;
	/** the outermost proxied window above this one (its own when it is the top) */
	get proxiedTop(): typeof globalThis {
		let context: typeof globalThis = this.global;
		for (;;) {
			try {
				const parent = (context as Record<string, any>)[this.names.client]
					.parent as typeof globalThis;
				if (parent === context || !(this.names.client in parent)) break;
				context = parent;
			} catch (error) {
				break;
			}
		}
		return context;
	}
	#partition?: { document: Document; partition: string; nonce: string | null };
	/**
	 * This document's storage partition: its top-level document's site when
	 * that is another site than its own, or when a frame between them is of
	 * another site (src/partition.ts), and a nonce of its top-level
	 * document's in a credentialless frame (credentiallessPartition).
	 * Decided once per document, from its route and the chain of proxied
	 * parents: a site framed by another keeps to stores of its own from its
	 * first script on.
	 */
	/**
	 * @internal while a Storage Access handle makes a channel or a shared
	 * worker: the first-party partition's (./storageAccess.ts)
	 */
	firstParty = false;
	override get partition(): string {
		return this.firstParty ? '' : this.#partitionFacts().partition;
	}
	/**
	 * The nonce of this document's credentialless partition, null for a
	 * document that is not in a credentialless frame: a routed document's
	 * route names it, one no response made (about:blank, srcdoc, blob:) is
	 * its parent's
	 */
	get credentiallessNonce(): string | null {
		return this.#partitionFacts().nonce;
	}
	#partitionFacts() {
		const document = this.global.document;
		const kept = this.#partition;
		if (kept && kept.document === document) return kept;
		let partition = '';
		let nonce: string | null = null;
		try {
			const { pathname } = new URL(this.#documentURL());
			nonce = pathname.startsWith(this.directory)
				? (parseNestedMark(
						nestedMarkOf(pathname, this.directory, this.codec) ?? '',
					)?.nonce ?? null)
				: this.nested
					? (
							(this.parent as Record<string, any>)[
								this.names.client
							] as DocumentClient
						).credentiallessNonce
					: null;
		} catch (error) {
			// a parent of another origin: none in reach
		}
		try {
			if (nonce !== null)
				partition = credentiallessPartition(
					this.topOrigin,
					nonce,
					getPublicSuffix,
				);
			else if (this.proxiedTop !== this.global || this.slotMark)
				partition = partitionOf(
					this.url.url.origin,
					this.topOrigin,
					getPublicSuffix,
					this.#crossAncestor(),
				);
		} catch (error) {
			// an origin without a site (opaque): it has no storage to key
		}
		return (this.#partition = { document, partition, nonce });
	}
	/** the nonce of the credentialless frames under this top-level document, made when the first is */
	ownNonce?: string;
	/**
	 * Whether this document's document.cookie reads "" and its writes do
	 * nothing, as Chrome has it for a document whose URL is not http(s): a
	 * blob: document and a `javascript:` URL's (whose URL is about:blank),
	 * which the worker serves at an `inline:` route, and an about:blank or
	 * srcdoc document such a document makes (measured in Chrome 152; a plain
	 * about:blank frame of an http page reads its parent's cookies). Their
	 * requests carry cookies as any other's. A data: document is an opaque
	 * origin, and stays as it is.
	 */
	get cookieAverse(): boolean {
		try {
			const location = this.global.location;
			if (location.protocol === 'about:') {
				if (!this.nested) return false;
				const parent = (this.parent as Record<string, any>)[
					this.names.client
				] as DocumentClient | undefined;
				return !!parent && parent.cookieAverse;
			}
			return (
				location.pathname.startsWith(`${this.directory}inline:`) &&
				this.url.url.protocol !== 'data:'
			);
		} catch (error) {
			return false;
		}
	}
	/**
	 * Whether a proxied frame between this document and its top is of another
	 * site than the top: its parent is in a partition (src/partition.ts)
	 */
	#crossAncestor(): boolean {
		if (!this.nested) return false;
		try {
			const parent = (this.parent as Record<string, any>)[this.names.client] as
				DocumentClient | undefined;
			if (parent) return parent.partition !== '';
		} catch (error) {
			// a parent of another origin
		}
		// the site pool: a parent of another slot (out of reach) said so in
		// this frame's route
		return this.slotMark?.crossAncestor ?? false;
	}
	/**
	 * The nested route marker of a frame this document makes (an iframe's
	 * src): its top origin, flagged when this document is in a partition, so
	 * the frame's document is keyed apart from its top's even when it is of
	 * the top's site (src/partition.ts nestedMark)
	 */
	get childRoute(): string {
		return this.childRouteFor(null, null, false);
	}
	/**
	 * childRoute for a frame element: with the host's page cross-origin
	 * isolated the marker also says what this document is and whom the
	 * frame's `allow` lets have the permission (src/isolation.ts), so the
	 * service worker can decide whether the frame's document loads here and
	 * whether it is isolated. `src`: the origin the frame is navigated to.
	 */
	childRouteFor(
		allow: string | null,
		src: string | null,
		credentialless: boolean,
		sandbox: Set<string> | null = null,
	): string {
		let nonce = this.credentiallessNonce;
		if (nonce === null && credentialless) {
			const top = (this.proxiedTop as Record<string, any>)[
				this.names.client
			] as DocumentClient;
			nonce = top.ownNonce ??= Math.random().toString(36).slice(2, 12);
		}
		return nestedMark(
			this.topOrigin,
			this.partition !== '',
			this.#embedder(allow, src, credentialless),
			sandbox,
			this.sites !== null && siteWindows().topOpenerSameOrigin(this),
			nonce,
		);
	}
	/**
	 * What this document is by its headers when the host's page is
	 * cross-origin isolated: its shell's word, or its parent's for a document
	 * no response made (about:blank, about:srcdoc, a blob: document), which
	 * inherits it
	 */
	get isolationFacts(): string {
		if (this.isolation !== null) return this.isolation;
		if (this.nested)
			try {
				return (
					(this.parent as Record<string, any>)[
						this.names.client
					] as DocumentClient
				).isolationFacts;
			} catch (error) {
				// the parent went away
			}
		return '';
	}
	/**
	 * In a host page that is cross-origin isolated, a document that is not:
	 * it has no SharedArrayBuffer global. Chrome keeps the window of a
	 * frame's initial about:blank for a first navigation within one origin
	 * (every proxied document is of the proxy's), and with it the globals
	 * that document had under an isolated embedder (measured: natively such
	 * a frame is of another origin and gets a window of its own). WebKit
	 * isolates every frame of an isolated page: there a document the shell
	 * says is not isolated (`n`) loses it too, and its `crossOriginIsolated`
	 * reads false (DOMHooks). Called when the client is applied and when a
	 * shell says what its document is.
	 */
	override hideSharedArrayBuffer() {
		if (!this.hostIsolated) return;
		try {
			if (
				(Reflect.get(this.global, 'crossOriginIsolated') === false ||
					this.isolationFacts.includes('n')) &&
				Reflect.has(this.global, 'SharedArrayBuffer')
			)
				Reflect.deleteProperty(this.global, 'SharedArrayBuffer');
		} catch (error) {
			// a window that is going away
		}
	}
	/** this document as the embedder of a frame (null when the host's page is not isolated) */
	#embedder(
		allow: string | null,
		src: string | null,
		credentialless: boolean,
	): NestedEmbedder | null {
		if (!this.hostIsolated) return null;
		const facts = this.isolationFacts;
		return {
			origin: this.url.url.origin,
			coep: facts.includes('c'),
			group: facts.includes('g'),
			// only a document that has the permission can pass it on
			...(facts.includes('p')
				? allowDelegates(allow, src)
				: { delegates: 'none' as const }),
			credentialless,
		};
	}
	/**
	 * The embedder a navigation of this frame's own keeps: the one its
	 * route names, or its parent as it is for a document without a route
	 */
	#ownEmbedder(): NestedEmbedder | null {
		if (!this.hostIsolated) return null;
		const mark = nestedMarkOf(
			this.baseURI.pathname,
			this.directory,
			this.codec,
		);
		const parsed = mark === null ? null : parseNestedMark(mark);
		if (parsed) return { ...parsed.embedder, later: true };
		try {
			const embedder = (
				(this.parent as Record<string, any>)[
					this.names.client
				] as DocumentClient
			).#embedder(null, null, false);
			return embedder && { ...embedder, later: true };
		} catch (error) {
			return null;
		}
	}
	/** the origin of the outermost proxied document above this one (its own when it is the top) */
	get topOrigin(): string {
		const top = (this.proxiedTop as Record<string, any>)[
			this.names.client
		] as DocumentClient;
		// (the site pool: the outermost document in reach may be a frame of a
		// document of another slot, whose route names the top)
		return top.slotMark?.top ?? top.url.url.origin;
	}
	/** the windows this document opened (a sandboxed document may navigate them) */
	readonly openedWindows = new LazyWeakSet<object>();
	/** tell the worker an Accept-CH meta named these hints (the ClientHints module sets it) */
	reportAcceptCH: (hints: string[]) => void = () => {};
	/**
	 * Whether this document may navigate `target`, as the browser
	 * decides it for a sandboxed document: itself, its descendants, the
	 * windows it opened, and the proxied top under allow-top-navigation (with
	 * user activation under allow-top-navigation-by-user-activation). Its
	 * parent and every other window are out of reach; a script's top
	 * navigation to a custom scheme (mailto:) is refused under
	 * allow-top-navigation-to-custom-protocols as well, as Chrome 152 refuses
	 * it (sandbox-restrictions suite, measured). An unsandboxed
	 * document may navigate any. The real frame cannot say no here: the
	 * proxied top is not the browser's top, and a navigation the target
	 * window's own inject makes is the target's, which the browser allows.
	 * A sandboxed document's decision is a deferred part (./navigateOther.ts
	 * mayNavigate): without it the call throws.
	 */
	mayNavigate(target: unknown): boolean {
		return (
			this.sandboxFlags === null ||
			target === this.global ||
			deferred('mayNavigate')(this, target, this.#frameTopNavigation)
		);
	}
	/** what a navigation from this context routes as: the top origin when nested, else a top-level document */
	get nestedRoute(): string | false {
		return this.nested
			? nestedMark(
					this.topOrigin,
					this.#crossAncestor(),
					this.#ownEmbedder(),
					this.sites ? this.pool[Pool.FrameFlags] : null,
					this.sites !== null && siteWindows().topOpenerSameOrigin(this),
					this.credentiallessNonce,
				)
			: false;
	}
	#visited?: { document: Document; context: string | null };
	/**
	 * What the browser keys this document's links' visited state by, as the
	 * link route spells it (src/visited.ts): the document's origin, and its
	 * top-level document's site when that is another. A document of an
	 * opaque origin, whose links Chrome never shows visited, has a context
	 * of its own.
	 */
	get visitedContext(): string | null {
		const document = this.global.document;
		const kept = this.#visited;
		if (kept && kept.document === document) return kept.context;
		let context: string | null = null;
		try {
			context =
				this.origin === 'null'
					? opaqueContext(Math.random().toString(36).slice(2, 12))
					: contextText(
							{
								frame: this.url.url.origin,
								top: siteOf(this.topOrigin, getPublicSuffix),
							},
							getPublicSuffix,
						);
		} catch (error) {
			// no origin to key by: its links are routed as before
		}
		this.#visited = { document, context };
		return context;
	}
	/**
	 * Whether this document can follow a link route to its own URL without
	 * loading again (the Visited module does it from the navigate event): a
	 * document without that event keeps its own URLs at its address
	 */
	followsOwnLinks = false;
	/**
	 * What a link of this document to `resource` is routed as: the link
	 * route (src/visited.ts), which the browser shows visited exactly when
	 * its history has it under this document's own partition.
	 */
	linkRoute(resource: StompURL, base?: StompURL): string {
		const context = this.visitedContext;
		const plain = () =>
			routeHTML(
				resource,
				base ?? this.url,
				this.config,
				false,
				this.nestedRoute,
			);
		if (context === null || !ROUTE_PROTOCOLS.includes(resource.url.protocol))
			return plain();
		// a URL that is a route already is the real URL it stands for
		const target =
			unwrapRoute(resource.url, resource.codec, resource.directory) ??
			resource.url;
		if (!this.followsOwnLinks) {
			// (parsed once per address: only read here)
			const href = this.locationHref;
			if (this.#ownLocation?.href !== href)
				this.#ownLocation = { href, url: new URL(href) };
			const own = this.#ownLocation.url;
			if (
				target.origin === own.origin &&
				target.pathname === own.pathname &&
				queryOf(target) === queryOf(own)
			)
				return plain();
		}
		// the same link again (a list rendered once more) is the same route:
		// sealing it was most of a link's write
		const key = `${context} ${target.href}`;
		let route = this.#linkRoutes.get(key);
		if (route === undefined) {
			if (this.#linkRoutes.size >= 1024) this.#linkRoutes.clear();
			route = linkRoute(this.scope, this.codec, context, target);
			this.#linkRoutes.set(key, route);
		}
		return route;
	}
	#ownLocation?: { href: string; url: URL };
	#linkRoutes = new LazyMap<string, string>();
	/**
	 * `url`, just resolved against the base URL and held by nothing else, as
	 * a StompURL of the base's routes (`new StompURL(url, baseURL)` without
	 * the two copies: the hooks route every URL a page writes this way)
	 */
	atBase(url: URL): StompURL {
		const parsing = this.#parseBase;
		const made = StompURL.of(
			url,
			this.codec,
			parsing ? parsing.directory : this.#readBase().directory,
		);
		// (a cache mark goes with the base, as the constructor takes it on)
		if (parsing && parsing.mark !== undefined) made.mark = parsing.mark;
		return made;
	}
	/**
	 * The proxied window `_parent`, `_top` or `_unfencedtop` names from a
	 * frame under the proxied top, with its client; null for any other
	 * keyword, for the proxied top (its own parent and top) and for a
	 * sandboxed document (the Sandbox module decides what it may navigate).
	 * The browser's own keywords cannot be used: the host frames the proxied
	 * top sandboxed, and a sandboxed frame navigates no ancestor (and its top
	 * is the host). The hooks navigate the window from its own realm instead
	 * (window.open here, a link's click and a javascript: form in the Sandbox
	 * module), with the URL routed as a document of that window.
	 */
	targetWindow(
		keyword: string | null | undefined,
	): { window: typeof globalThis; client: DocumentClient } | null {
		const name = (keyword ?? '').toLowerCase();
		if (name !== '_parent' && name !== '_top' && name !== '_unfencedtop')
			return null;
		if (this.sandboxFlags !== null || !this.nested) return null;
		try {
			const window = name === '_parent' ? this.parent : this.proxiedTop;
			// (the site pool: the proxied top is out of reach, of another
			// slot, when the outermost window in reach is this one;
			// targetAcross)
			if (window === this.global) return null;
			const client = (window as Record<string, any>)[this.names.client] as
				DocumentClient | undefined;
			return client ? { window, client } : null;
		} catch (error) {
			return null;
		}
	}
	/**
	 * Called by the shell the service worker served with `document`, before
	 * the page runs. When the worker saw only the proxy origin (the policy
	 * stripped the routed URL the browser had), a nested document's
	 * initiator is taken to be its parent, the one proxied page it can see.
	 */
	setReferrer(document: Document, info: ReferrerInfo) {
		// a document an opaque origin made (a sandboxed document's frame or
		// popup) has none: an opaque origin sends no referrer, natively
		if (this.#openerOpaque || this.#creatorClient()?.sandboxedOpaque) {
			this.#referrers.set(document, '');
			return;
		}
		if ('referrer' in info) {
			this.#referrers.set(document, info.referrer);
			return;
		}
		let referrer = '';
		if (this.nested)
			try {
				const parent = (this.parent as Record<string, any>)[
					this.names.client
				] as DocumentClient;
				referrer = refererFor(parent.url.url, this.url.url, info.policy) ?? '';
			} catch (error) {
				// the parent went away: no referrer, as for an unknown initiator
			}
		this.#referrers.set(document, referrer);
	}
	/** the referrer the service worker decided for `document`, if it served it */
	referrerOf(document: Document): string | undefined {
		return this.#referrers.get(document);
	}
	get top(): typeof globalThis {
		return Reflect.apply(this.topDescriptor.get!, this.global, []);
	}
	/**
	 * Whether a `target` names a browsing context this page already has (an
	 * iframe or frame with that name, as the page wrote it): the browser
	 * navigates that frame, so it is not a new tab for the host to open.
	 * Browsing context names are case-sensitive; the `_` keywords are not
	 * names.
	 */
	hasFrameNamed(name: string): boolean {
		return this.frameNamed(name) !== null;
	}
	/**
	 * @internal set by the Sandbox module: the window a link, a form or
	 * window.open() of this document aims at by `name` that the browser
	 * would not navigate for it, the host framing the proxied top
	 * sandboxed: a window of this tab's proxied frames other than this one
	 * and its own. With `popups`, also a popup the tab opened (tabPopups),
	 * which the browser navigates itself, but which no frame of this
	 * document names, so it is no new tab for the host. Null for a keyword,
	 * for this window and its own frames (the browser finds those) and for
	 * a name nothing in reach has
	 */
	namedWindow?: (
		name: string | null | undefined,
		popups?: boolean,
	) => typeof globalThis | null;
	/**
	 * the windows this tab's documents opened (window.open), kept on the
	 * proxied top's client for namedWindow, which reads their names when
	 * it is asked
	 */
	tabPopups?: WeakRef<typeof globalThis>[];
	/**
	 * @internal set by the History module: another document's link or form
	 * (`source`, null when that document is of another origin) navigates
	 * this window to `url` from its realm (navigateOther), by the user's
	 * click or submission when `user`: this window's navigate event for it
	 * shows them, as natively, where it would show a navigation of its own
	 */
	navigatedBy?: (url: string, user: boolean, source: Element | null) => void;
	/**
	 * @internal set by navigateOther while another document of this realm
	 * navigates this window to `url` in the call (a window still on its
	 * initial about:blank): whether that document had transient activation
	 * then, which the browser takes for the navigation's Sec-Fetch-User and
	 * the hint this window's location hooks send carries (NavigationHint)
	 */
	initiatorActivation?: { url: string; active: boolean };
	/** the frame element of this document named `name` (`target`, window.open), if any */
	frameNamed(name: string): Element | null {
		if (!name || name.startsWith('_')) return null;
		for (const frame of this.global.document.querySelectorAll(
			'iframe[name], frame[name]',
		))
			if (frame.getAttribute('name') === name) return frame;
		return null;
	}
	/**
	 * Ask the host application to open `url` in a new tab. Only when the host
	 * opted in (`config.openTab`); returns whether it was sent.
	 */
	openInHost(url: string): boolean {
		if (!this.config.openTab) return false;
		// the host takes requests from its frames' own windows (the proxied
		// tops) only: a nested frame's goes through its top's client, whose
		// realm then posts it, so the browser names the top as the source
		const top = this.proxiedTop;
		if (top !== this.global) {
			const client = (top as Record<string, any>)[this.names.client] as
				DocumentClient | undefined;
			if (client) return client.openInHost(url);
		}
		return this.postToHost({ [OPEN_TAB]: url });
	}
	/**
	 * Post to the host application through the real top's postMessage taken
	 * before any page code ran; returns whether it was sent.
	 */
	/**
	 * A document sandboxed without allow-scripts runs no page script, and
	 * the policy that holds its scripts back (guardScripts) refuses the
	 * hook's evaluation too: it runs no hook rather than report a refusal
	 */
	protected override runsHooks(): boolean {
		return this.allows('allow-scripts');
	}
	protected override hookContext(phase: HookPhase): HookContext {
		const nested = this.nested;
		return {
			...super.hookContext(phase),
			isTop: !nested,
			nested,
			kind: 'document',
		};
	}
	protected override reportHookError(info: HookErrorInfo): void {
		this.postToHost({ [HOOK_ERROR]: info });
	}
	/**
	 * @internal the stand-in every document of an origin (`originKey` in the
	 * Context module) gets for this window when it is of another origin
	 */
	readonly standIns = new LazyMap<string, WeakRef<typeof globalThis>>();
	/** @internal frame elements showing an opaque (data:) document: never injected from this page (DOMAttributes, IFrame) */
	readonly opaqueFrames = new LazyWeakSet<Element>();
	/**
	 * The document a javascript: URL's string value becomes, in the shell
	 * with this page as its URL (as a blob document gets it), so its scripts
	 * run injected; routeHTML's javascript: wrapper calls this.
	 */
	javascriptDocument(markup: string, documentURL?: string): string {
		// served by the worker as an inline document, so it is controlled and
		// its subresources reach the worker; the javascript: document itself is
		// a raw bootstrap that replaces itself with it. The replaced document
		// was an iframe's initial about:blank, whose URL strips to no referrer,
		// or another (an srcdoc), whose requests refer like the page
		const url = this.url.toString();
		const route = this.inlineDocument(
			markup,
			url,
			documentURL === 'about:blank' ? 'about:blank' : url,
		);
		// (the shell is a deferred part: without it the URL throws, and its
		// frame keeps the document it had)
		if (!route)
			return deferred('modifyHTML')(
				markup,
				this.url,
				this.config,
				true,
				undefined,
				this.scriptNonce,
			);
		// (with the nonce of the policy the document inherits from this one)
		const nonce = this.scriptNonce;
		return `<!doctype html><script${nonce ? ` nonce="${nonce.replace(/[^\w+/=-]/g, '')}"` : ''}>location.replace(${JSON.stringify(route).replace(/</g, '\\u003c')})</script>`;
	}

	postToHost(message: object): boolean {
		if (!this.topPostMessage) return false;
		// a window that is its own top (a popup) has no host above it: the
		// message would reach the page's own listeners, which never hear one
		// natively
		if ((this.top as unknown) === this.global) return false;
		try {
			Reflect.apply(this.topPostMessage, this.top, [message, '*']);
			return true;
		} catch (error) {
			return false;
		}
	}
	/** the document was opened (document.open(), or a write once it had loaded): its URL is its opener's, its loads may still have no worker */
	opened = false;
	/**
	 * @internal this document, a frame still on its initial about:blank, is
	 * to show `destination` (a POST's body: `formData`): a fresh context for
	 * it when that is of another origin, navigated there, or `empty` for the
	 * browser to navigate by the frame's name; whether it was given (IFrame)
	 */
	freshTo?: (
		destination: URL,
		formData?: FormData | null,
		empty?: boolean,
	) => boolean;
	/**
	 * @internal give a frame of this document a fresh browsing context
	 * navigated to `routed` (a POST's body: `formData`), before a document
	 * of another origin than the one it shows loads in it (IFrame,
	 * freshContext.ts); a method, so a frame running another bundle asks
	 */
	freshFrame?: (
		element: Element,
		routed: string | null,
		formData?: FormData | null,
		page?: string,
	) => boolean;
	/** @internal give the loads the parser made from markup the page wrote their copies, under a document, an element or a shadow root (DOMAttributes; DOMHooks' write calls it) */
	writtenLoads?: (root: Node) => void;
	/** @internal an object whose copy is on its way: its context's URL put back to the about:blank it stands for (DOMAttributes; IFrame's contentWindow calls it) */
	heldBlank?: (element: Element, context?: typeof globalThis | null) => void;
	/**
	 * @internal this client's synchronous bridge, for a client of another
	 * bundle: a blob: document runs a bundle of its own, whose module classes
	 * are not this one's, so it cannot look this client's module up itself
	 */
	get syncBridge(): SyncModule | undefined {
		return this.getModule(SyncModule);
	}
	/**
	 * An import map's `integrity` (its JSON `text`, as the page wrote it) goes
	 * to the worker before the browser has the map, so before any module it
	 * names is asked for: the worker checks a module script whose element
	 * named no integrity of its own against it (server/integrityLoads.ts).
	 * The keys are URLs, resolved against the document's base as the browser
	 * resolves them; the routed modules never match them in the browser.
	 */
	noteImportMap(text: string) {
		let integrity: unknown;
		try {
			integrity = (JSON.parse(text) as { integrity?: unknown })?.integrity;
		} catch (error) {
			return;
		}
		if (typeof integrity !== 'object' || integrity === null) return;
		const entries: [string, string][] = [];
		for (const [key, value] of Object.entries(integrity)) {
			if (typeof value !== 'string') continue;
			try {
				entries.push([
					new URL(key, this.baseHref).href.replace(/#.*$/s, ''),
					value,
				]);
			} catch (error) {
				// not a URL: the browser ignores the entry
			}
		}
		if (!entries.length) return;
		try {
			this.syncBridge?.jsonAPI(`${this.directory}${IMPORT_MAP_ROUTE}`, entries);
		} catch (error) {
			// a document with no bridge: the modules go unchecked
		}
	}
	/**
	 * @internal inject this page's bundle into a child frame's window nothing
	 * injected yet, as reading its contentWindow does (IFrame sets it):
	 * routeHTML's javascript: wrapper calls it from the frame, whose rewritten
	 * code needs the access helper before it runs
	 */
	injectChild?: (context: typeof globalThis) => void;
	/** @internal a child window has this name (Context module): reads of it by name are restricted like `frames[i]` */
	exposeChild?: (name: string) => void;
	/**
	 * @internal inject every child frame still on its initial about:blank
	 * (IFrame sets it): called wherever a frame may have just connected
	 */
	sweepFrames?: () => void;
	/** the document's base URL and what `baseURL` made of it, last time */
	#urlMemo: {
		base: string;
		named: unknown;
		href: string;
		directory: string;
	} | null = null;
	/** the document's own URL and what `url` made of it, last time */
	#documentMemo: {
		document: Document;
		location: string;
		named: unknown;
		href: string;
		directory: string;
	} | null = null;
	/**
	 * The page URL of this document itself: what its origin, its site, its
	 * storage, its cookies, its partition and the window membrane are of.
	 * Never its base URL: a page names any URL it likes in a <base href>,
	 * and a document whose identity followed it was another site's to every
	 * store and window (a page of one site that named another's page as its
	 * base read that site's localStorage and cookies, and reached its frames'
	 * realms). A routed document's is its route's page URL; a document the
	 * page made (blob:, data:, an inline one, an <object>'s) is what its
	 * shell named; an about:blank or about:srcdoc document is of the
	 * document that made it, its parent's or its opener's. What a URL the
	 * page writes resolves against is `baseURL`.
	 */
	get url(): StompURL {
		const named = this.namedBase;
		let location: string;
		try {
			location = this.#locationHref(this.global.location);
		} catch (error) {
			return this.baseURL;
		}
		const document = this.global.document;
		const memo = this.#documentMemo;
		if (
			memo &&
			memo.document === document &&
			memo.location === location &&
			memo.named === named
		)
			return new StompURL(memo.href, this.codec, memo.directory);
		const url = this.#readDocumentURL(named, location);
		this.#documentMemo = {
			document,
			location,
			named,
			href: url.url.href,
			directory: url.directory,
		};
		return url;
	}
	#readDocumentURL(named: unknown, location: string): StompURL {
		const own = this.global.location;
		const prefix = `${own.origin}${this.directory}`;
		if (typeof named === 'string')
			return new StompURL(named, this.codec, prefix);
		if (ROUTE_PROTOCOLS.includes(own.protocol))
			return parseRoutedURL(location, this.codec, prefix).url;
		// about:blank, about:srcdoc: of the document that made it. A window
		// whose document was of one origin never becomes another's this way:
		// an opener that has gone to another site since is not the maker of
		// the about:blank its popup loads next
		if (own.protocol === 'about:') {
			const creator = this.#creatorClient();
			const was = this.#originKey?.key ?? null;
			if (creator && (was === null || was === creator.originKey))
				return creator.url;
		}
		// anything else (a blob: copy no shell named, an <object>'s SVG): its
		// own address, the proxy's, which is no page's origin
		return new StompURL(location, this.codec, prefix);
	}
	/**
	 * The client of the window that opened this document's top, the last
	 * window up its parents that is a document of ours (an about:blank
	 * popup, or a frame of one); null for a frame under the host or another
	 * origin's window, and for a window nothing opened
	 */
	protected override openerClient(): DocumentClient | null {
		const name = this.names.client;
		const clientOf = (window: unknown) =>
			(window as Record<string, DocumentClient | undefined>)[name];
		try {
			let top: unknown = this.global;
			for (let depth = 0; depth < 16; depth++) {
				const parent: unknown = Reflect.apply(nativeParentGet, top, []);
				if (parent === top) break;
				if (!clientOf(parent)?.isDOM) return null;
				top = parent;
			}
			const opener: unknown = Reflect.apply(nativeOpenerGet, top, []);
			if (!opener || opener === top) return null;
			const client = clientOf(opener);
			return client?.isDOM && client !== clientOf(top) ? client : null;
		} catch (error) {
			// a window of another real origin
			return null;
		}
	}
	/**
	 * The client of the document an about:blank or about:srcdoc document is
	 * of: its parent's, else its opener's. Read with the browser's own
	 * accessors: the page-facing `parent` hands out a stand-in for a window
	 * of another origin, which asks for this document's origin, which is
	 * what is being worked out here (a frame whose about:blank was loaded a
	 * second time, by its `src`, came out as an opaque origin's: its parent
	 * could not reach it, and it read no cookie)
	 */
	#creatorClient(): DocumentClient | null {
		for (const get of [nativeParentGet, nativeOpenerGet])
			try {
				const window = Reflect.apply(get, this.global, []) as Record<
					string,
					unknown
				> | null;
				if (!window || window === (this.global as unknown)) continue;
				const client = window[this.names.client] as DocumentClient | undefined;
				if (client && client !== this && client.isDOM) return client;
			} catch (error) {
				// a window of another real origin
			}
		return null;
	}
	/**
	 * location.href as the browser has it: a Location's members are its own
	 * unforgeable properties, which the page cannot replace (its own reads
	 * go through the Location module's stand-in)
	 */
	#locationHref(location: Location): string {
		return location.href;
	}
	/**
	 * The document's encoding when it is a legacy one, which the browser
	 * encodes a URL's query and a form's submission with (the HTML
	 * standard's output encoding: UTF-8 for UTF-16 and replacement), or
	 * null for UTF-8. The worker serves each document in its own encoding
	 * (src/server/charset.ts encodeShell), so the browser's answer is the
	 * page's.
	 */
	#legacyEncoding(document: Document = this.global.document): string | null {
		const encoding = Reflect.apply(
			this.#encodingNatives[0],
			document,
			[],
		) as string;
		return /^(utf-8|utf-16(le|be)|replacement)$/i.test(encoding)
			? null
			: encoding;
	}
	/**
	 * The document's legacy encoding with the browser's encoder for it, a
	 * link of the document, which encodes its query in the document's
	 * encoding (src/inject/dom/legacyEncoding.ts); null for UTF-8
	 */
	legacyEncoder(document = this.global.document): LegacyEncoder | null {
		const encoding = this.#legacyEncoding(document);
		if (encoding === null) return null;
		const [, createElement, hrefSet, hrefGet] = this.#encodingNatives;
		return {
			encoding,
			encode: (text, fragment) => {
				const link = Reflect.apply(createElement, document, ['a']);
				Reflect.apply(hrefSet, link, [
					`http://h/?${text}${fragment ? '#' : ''}`,
				]);
				const href = Reflect.apply(hrefGet, link, []) as string;
				return href.slice(
					href.indexOf('?') + 1,
					fragment ? href.lastIndexOf('#') : href.length,
				);
			},
		};
	}
	/**
	 * `owner`: the element whose URL it is, when the URL is read back (as
	 * the browser reads it, in its node document's encoding: an inert
	 * document's is UTF-8); a URL routed is in the document's
	 */
	override encodingParse(value: string, base?: string, owner?: Node): URL {
		// the page's value made a string once, as new URL makes it (a
		// TrustedScriptURL, an object with a toString of its own)
		const input = `${value}`;
		const url = new URL(input, base);
		if (
			!(/[^\0-\x7f]/.test(input) || hasISO2022Escape(input)) ||
			(url.protocol !== 'http:' && url.protocol !== 'https:')
		)
			return url;
		const encoder = this.legacyEncoder(
			(owner &&
				(Reflect.apply(
					this.#encodingNatives[4],
					owner,
					[],
				) as Document | null)) ||
				this.global.document,
		);
		if (encoder === null) return url;
		const query = deferred('legacyQuery')(input, encoder);
		return query === null ? url : new URL(query, base);
	}
	/** which encoding a form's submission is in (src/inject/dom/legacyEncoding.ts formEncoding) */
	formEncoding(acceptCharset: string | null): 'utf-8' | 'document' | 'other' {
		const encoder = this.legacyEncoder();
		if (acceptCharset === null) return encoder ? 'document' : 'utf-8';
		return deferred('formEncoding')(acceptCharset, encoder);
	}
	/**
	 * What a URL this document's page writes resolves against: its base URL
	 * (its <base href> when it has one, else its own URL), as the browser
	 * resolves an attribute, a fetch, a script's import. It is the page's
	 * own base while its markup is rewritten (loadHTML). Never a document's
	 * identity: that is `url`.
	 */
	get baseURL(): StompURL {
		if (this.#parseBase) return this.#parseBase;
		const memo = this.#readBase();
		return new StompURL(memo.href, this.codec, memo.directory);
	}
	/**
	 * `baseURL.toString()` without a copy: nearly every hook resolves the
	 * page's URLs against it, and a copy made only to be printed was a URL
	 * parse on every attribute a hook routed
	 */
	override get baseHref(): string {
		if (this.#parseBase) return this.#parseBase.toString();
		return this.#readBase().href;
	}
	#readBase(): { href: string; directory: string } {
		// Nearly every hook asks, and decoding the route each time was a
		// tenth of the hooks' time on a Google keystroke: the answer is a
		// function of the base URL and the shell's name for the page, so it
		// is made again only when either changed (a new copy each time, as a
		// caller may change what it is given)
		const named = this.namedBase;
		const base = Reflect.apply(
			this.baseURIDescriptor.get!,
			this.global.document,
			[],
		) as string;
		const memo = this.#urlMemo;
		if (memo && memo.base === base && memo.named === named) return memo;
		const url = this.#readURL(named);
		this.#urlMemo = {
			base,
			named,
			href: url.url.href,
			directory: url.directory,
		};
		return this.#urlMemo;
	}
	#readURL(named: unknown): StompURL {
		// a document the page made (a blob, a data: frame, an inline document
		// the worker served, an <object>'s document): its shell named the URL
		// it shows, which is what its URLs resolve against, unless its own
		// <base href> names another. That base is a routed URL in the real
		// document (its hook writes it so), and the browser's base URL is it,
		// as a routed document's is; without one the base is the document's
		// own URL
		if (typeof named === 'string') {
			const base = this.baseURI;
			const prefix = `${base.origin}${this.directory}`;
			if (
				ROUTE_PROTOCOLS.includes(base.protocol) &&
				base.href.startsWith(prefix) &&
				base.href !== this.#documentURL()
			)
				try {
					return parseRoutedURL(base.href, this.codec, prefix).url;
				} catch (error) {
					// not one of this controller's routes: the named URL stands
				}
			return new StompURL(named, this.codec, prefix);
		}
		if (ROUTE_PROTOCOLS.includes(this.baseURI.protocol)) {
			return parseRoutedURL(
				this.baseURI.href,
				this.codec,
				`${this.baseURI.origin}${this.directory}`,
			).url;
		} else {
			// a blob: document the page built: its shell named the page URL
			const base = this.namedBase;
			return new StompURL(
				typeof base === 'string' ? base : this.baseURI.href,
				this.codec,
				`${this.baseURI.origin}${this.directory}`,
			);
		}
	}
	/** the document's own URL as the browser has it (Document.prototype.URL) */
	#documentURL(): string {
		try {
			return Reflect.apply(
				documentURLGetter!,
				this.global.document,
				[],
			) as string;
		} catch (error) {
			return '';
		}
	}
	get baseURI(): URL {
		return new URL(
			Reflect.apply(this.baseURIDescriptor.get!, this.global.document, []),
		);
	}
	/**
	 * An inline script's rewrite with `preamble` in front, as the client
	 * makes it, with nothing the page could have replaced asked on the way
	 * there (no table: markupMembers.ts, whose markup's scripts run)
	 */
	markupScript(source: string, isModule: boolean, preamble: string): string {
		return modifyJS(
			source,
			this.baseURL,
			this.config,
			isModule ? 'genericModule' : 'generic',
			preamble,
		);
	}
	/**
	 * Rewrite every inline script under `root` the way the parser will run it
	 * (a classic script gets the currentScript preamble, a module none, an
	 * import map its routed targets): the written page (loadHTML) and
	 * document.write markup go through here before the browser parses them.
	 */
	rewriteInlineScripts(
		root: ParentNode,
		parsed = false,
		/** each rewritten classic script's text, to the source the page wrote */
		sources?: Map<string, string>,
	) {
		// The page's markup (`parsed`) reaches the browser through
		// document.write, and a script that runs inside a write has no URL:
		// its stack frames and errors read `<anonymous>`, where the network's
		// parser names the document. Each is named for the document (the
		// route, which reads back as the page's URL), unless it names itself.
		// Markup the page writes is left as natively: unnamed.
		const sourceURL = parsed
			? `\n//# sourceURL=${this.global.location.href}`
			: '';
		for (const script of root.querySelectorAll('script')) {
			// an SVG script element has no `text`: its textContent is the source
			const element: Element = script;
			const isHTMLScript = script instanceof this.global.HTMLScriptElement;
			const read = () =>
				(isHTMLScript ? script.text : element.textContent) || '';
			const write = (text: string) => {
				if (isHTMLScript) this.scriptText(script, text);
				else element.textContent = text;
			};
			if (!read()) continue;
			if (
				(script.getAttribute('type') || '').trim().toLowerCase() === 'importmap'
			) {
				this.noteImportMap(read());
				write(rewriteImportMap(read(), this.baseURL, this.config));
				continue;
			}
			// (scriptRoutes.ts NO_SPECULATION), with the text marked for the page
			// to read back
			if (isSpeculationRules(script.getAttribute('type'))) {
				this.speculationMarked = true;
				write(markedSpeculationRules(read()));
				continue;
			}
			if (!shouldRewriteScript(script)) continue;
			const source = read();
			// the client's own (a style's stand-in, DOMContentHooks)
			if (isHTMLScript && this.rewrittenScripts.get(script) === source)
				continue;
			// the page's own script-src refuses this inline script of the
			// markup: it keeps no text, so it runs nothing (src/csp.ts)
			if (!script.hasAttribute('src')) {
				if (this.refuseInlineScript(script, source, true)) {
					write('');
					continue;
				}
				// let through by the hash of its text where the page's policy says
				// so: the rewrite is not that text (src/csp.ts)
				this.giveCodeNonce(script, null, source, true);
			}
			const isModule = scriptKind(script) === 'module';
			// the restore runs after the script's directive prologue, so a strict
			// script stays strict
			// what the worker made of it already (prewrite.ts), else made here
			const rewritten =
				this.#table()?.script(isModule, source) ??
				modifyJS(
					source,
					this.baseURL,
					this.config,
					isModule ? 'genericModule' : 'generic',
					isModule ? '' : scriptPreamble(source),
				);
			const named = /^\/\/[#@]\s*sourceURL=/m.test(rewritten)
				? rewritten
				: rewritten + sourceURL;
			const text = named.replace(/<\/script/gi, '<\\/script');
			write(text);
			sources?.set(text, source);
		}
	}
	/**
	 * Load an XML document (a standalone SVG, an XHTML page, any other XML
	 * document) served through the XML shell: parsed with its own mime, its
	 * scripts rewritten, its tree re-created through the hooks in this
	 * document (namespaces kept) under the shell's root, since an XML
	 * document has no document.write. Scripts run as the tree lands, like a
	 * parser's would. The prolog's processing instructions and comments land
	 * around the root as natively (an xml-stylesheet one loads its sheet,
	 * routed by ./stylesheetPIs.ts); an XSLT one transforms
	 * the document instead, as the browser's parser does at its end.
	 */
	loadXML(markup: string, mime: string) {
		// (a deferred part, ./instructions.ts: without it the document does
		// not load)
		deferred('loadXML')(this, markup, mime);
	}
	/** @internal the rewritten text each script element carries (DOMContentHooks, DOMHooks) */
	readonly rewrittenScripts = new WeakMap<HTMLScriptElement, string>();
	/** @internal whether the page's markup had speculation rules, which hold its text marked (Readback) */
	speculationMarked = false;
	/**
	 * @internal set by the Readback module: `script` holds `rewritten` for the
	 * text `written` the page gave it, which is what the page reads back; in
	 * `pieces`, the text nodes that held it and what each was given
	 */
	scriptSource?: (
		script: Element,
		written: string,
		rewritten: string,
		pieces: [CharacterData, string][],
	) => void;
	/**
	 * @internal The text a script should get when the page sets it (`text`,
	 * `textContent`). A connected script runs the moment its text lands,
	 * before any hook, so the text is rewritten here and recorded so the
	 * insertion hook does not rewrite it a second time. A detached script is
	 * rewritten when it is inserted (where the readback module records what
	 * the page wrote), and the running script setting its own text (the
	 * preamble restoring the source the page wrote) is already started: both
	 * keep what they are given.
	 */
	/**
	 * The text of each script the page set through a Trusted Types sink
	 * (scriptValue): natively the script's own, which runs as it is, where
	 * text that reached it any other way (a Text node it was given, a clone)
	 * is judged as it runs (scriptPrepared)
	 */
	readonly #scriptSlots = new LazyWeakMap<Element, string>();
	/**
	 * What a script's text sink named `sink` takes of the page's `value`,
	 * under the page's Trusted Types (Client.trustedValue), or null where it
	 * is refused. The running script setting its own text is the inject's
	 * preamble (prepareScriptText).
	 */
	scriptValue(
		script: Element,
		value: unknown,
		sink: string,
		refuse: () => unknown,
		convert: (value: unknown) => string = String,
	): string | null {
		if (
			!this.trustedTypesRequired() ||
			script === this.global.document.currentScript
		)
			return convert(value);
		const text = this.trustedValue(
			value,
			'TrustedScript',
			sink,
			refuse,
			convert,
		);
		if (text !== null) this.#scriptSlots.set(script, text);
		return text;
	}
	/** the scripts of a fragment the parser made of the page's markup, whose text is the parser's (scriptValue) */
	parsedScripts(root: DocumentFragment) {
		if (this.trustedTypesRequired())
			for (const script of Reflect.apply(nativeFragmentQuery, root, [
				'script',
			]) as Iterable<Element>)
				this.#scriptSlots.set(script, script.textContent ?? '');
	}
	/**
	 * Under Trusted Types, set a script's text (the page's, which passed
	 * scriptValue) as a trusted value, rewritten where it runs now: text
	 * that lands as a Text node is judged again as the script runs. False
	 * where nothing requires it.
	 */
	trustedScriptText(script: HTMLScriptElement, text: string): boolean {
		if (!this.trustedTypesRequired()) return false;
		this.scriptText(script, this.prepareScriptText(script, text));
		return true;
	}
	/**
	 * The text a script that is about to run runs (the page's, or what its
	 * default policy made of it), or null where the page's Trusted Types
	 * refuse it: text that did not reach it through a sink (scriptValue),
	 * judged as Chrome judges it as the script runs. Refused, the script
	 * keeps the page's text, which the browser refuses and reports itself.
	 */
	scriptPrepared(
		script: Element,
		text: string,
		sink = 'HTMLScriptElement text',
	): string | null {
		// (a script's own text is empty until a sink sets it)
		if (
			!this.trustedTypesRequired() ||
			(this.#scriptSlots.get(script) ?? '') === text
		)
			return text;
		// a script of markup the parser is making (the document's own, which
		// loadHTML copies, or a write's): its text is the parser's, which
		// runs as it is. Judged as a sink's, every inline script of a page
		// whose Trusted Types are enforced (Google's sign-in page) was
		// reported to the page as a trusted-types-sink violation of its own
		if (getGlobalParsingState(this.global) === 'parsingBeforeWrite') {
			this.#scriptSlots.set(script, text);
			return text;
		}
		// text that reached the script any other way (a Text node, a clone) is
		// judged as the script runs: refused, the script runs nothing and the
		// inject reports it, with no throw (the browser would not throw either)
		try {
			const passed = this.trustedValue(text, 'TrustedScript', sink, () => {});
			if (passed !== null) this.#scriptSlots.set(script, passed);
			return passed;
		} catch (error) {
			return null;
		}
	}
	prepareScriptText(script: HTMLScriptElement, text: string): string {
		// the running script setting its own text is the preamble of a
		// parser-inserted inline script: a frame the parser made before it
		// is injected now, since the parser runs it inside the write that
		// made the frame, before any observer hears of the frame
		if (script === this.global.document.currentScript) {
			startedScripts.add(script);
			this.sweepFrames?.();
			return text;
		}
		if (!this.isConnected(script)) return text;
		// (scriptRoutes.ts NO_SPECULATION)
		if (text && isSpeculationRules(script.getAttribute('type'))) {
			this.rewrittenScripts.set(script, NO_SPECULATION);
			return NO_SPECULATION;
		}
		if (!shouldRewriteScript(script)) return text;
		const passed = this.scriptPrepared(script, text);
		// refused by the page's Trusted Types as the script runs: it runs nothing
		// (the inject reported it in scriptPrepared), where the browser's own
		// Trusted Types would have stopped it
		if (passed === null) return '';
		if (!script.hasAttribute('src')) {
			// the page's own script-src refuses this inline script: it runs
			// nothing (empty text) and the inject reports it (src/csp.ts)
			if (this.refuseInlineScript(script, passed, false)) return '';
			this.giveCodeNonce(script, null, passed, false);
		}
		const module = scriptKind(script) === 'module';
		// no text runs nothing: nothing to rewrite (DOMContentHooks)
		const rewritten =
			passed === ''
				? ''
				: (this.prewrittenScript(module, passed, true) ??
					modifyJS(
						passed,
						this.baseURL,
						this.config,
						module ? 'genericModule' : 'generic',
					));
		this.rewrittenScripts.set(script, rewritten);
		// (what runs is the inject's, which the page's default policy is not
		// asked of again where it lands as a Text node: TrustedTypes.ts)
		this.trustedApprove?.(rewritten);
		return rewritten;
	}
	/**
	 * @internal CSS text as the browser should parse it in a <style>: every
	 * url() and @import routed. Text is routed before it lands, since the
	 * browser fetches an @import as it parses and paints a url() at the next
	 * style recalc. Routing is idempotent, and the page reads the text back
	 * as it wrote it (CSSReadback).
	 */
	prepareStyleText(text: string): string {
		const prewritten = this.#table()?.style(text);
		if (prewritten !== undefined) {
			// its output is known for what it is when it comes back; the text
			// itself is not memoized, the table answers it while it is kept
			// (CNN's 3.1M-character style was kept once more that way)
			if (text.length >= STYLE_MEMO_MIN)
				this.#rememberStyle(text, prewritten, false);
			return prewritten;
		}
		// what this routed already, coming back (a style's stand-in writes the
		// routed style in its place): routing it again is wasted, and not
		// always a no-op (a data: URL's escapes)
		if (this.#styleOutputs.has(text)) return text;
		// the same text again (a style rewritten as it is inserted and again
		// as its text node lands, the same sheet in another style): the
		// routing of a text depends on nothing else, so the answer is known
		const large = text.length >= STYLE_MEMO_MIN;
		if (large) {
			const known = this.#styleMemo.get(text);
			if (known !== undefined) return known;
		}
		let output: string;
		try {
			output = modifyCSS(text, this.baseURL);
		} catch (error) {
			// unparsable: route what the regex can find
			output = rewriteCSSValueURLs(text, this.baseURL);
		}
		if (large) this.#rememberStyle(text, output);
		return output;
	}
	/** large routed style texts this client made, the oldest out first */
	readonly #styleOutputs = new LazySet<string>();
	#styleOutputChars = 0;
	/** @internal the worker's rewrite of an inline script of this document's markup (PrewrittenTable.script) */
	prewrittenScript(
		module: boolean,
		source: string,
		bare = false,
	): string | undefined {
		return this.#table()?.script(module, source, bare);
	}
	/** the worker's table, while this client's URL is the one it was made for (a <base> the page adds changes it) */
	#table(): PrewrittenTable | null {
		const table = this.#prewritten;
		if (!table) return null;
		if (table.url === this.baseHref) return table;
		return null;
	}
	/**
	 * the inline scripts and styles of the document loadHTML wrote, rewritten
	 * by the worker, until its markup is parsed (DOMContentLoaded): what
	 * asks it later is a copy the page makes of one, rewritten here as any
	 * script or style the page inserts (CNN's table was 14 MB)
	 */
	#prewritten: PrewrittenTable | null = null;
	/**
	 * loadHTML was called and has not written the page yet: this document
	 * is still the shell. It writes from a timer, and when Chrome runs the
	 * shell's load task before it, the frame element fires `load` for the
	 * shell and again for the page, where natively it fires once (the
	 * embedder's IFrame module keeps the first from its page)
	 */
	shellPending = false;
	/** large style texts and their routed text, the oldest out first */
	readonly #styleMemo = new LazyMap<string, string>();
	#styleMemoChars = 0;
	#rememberStyle(text: string, output: string, memo = true) {
		if (output.length > STYLE_MEMO_CHARS / 4) return;
		if (!this.#styleOutputs.has(output)) {
			this.#styleOutputs.add(output);
			this.#styleOutputChars += output.length;
			for (const kept of this.#styleOutputs.values()) {
				if (this.#styleOutputChars <= STYLE_MEMO_CHARS) break;
				this.#styleOutputs.delete(kept);
				this.#styleOutputChars -= kept.length;
			}
		}
		if (!memo || this.#styleMemo.has(text)) return;
		this.#styleMemo.set(text, output);
		this.#styleMemoChars += text.length + output.length;
		for (const [key, value] of this.#styleMemo.entries()) {
			if (this.#styleMemoChars <= STYLE_MEMO_CHARS) break;
			this.#styleMemo.delete(key);
			this.#styleMemoChars -= key.length + value.length;
		}
	}
	/**
	 * @internal `node` if it is a <style> element whose text is CSS the
	 * document applies, else null: an HTML one, or an SVG one (inline SVG in
	 * an HTML page applies its CSS to the whole page, like an HTML style).
	 * The kinds share no native accessor (`sheet` is each kind's own and
	 * throws "Illegal invocation" on the other), see `styleKind`.
	 */
	styleElement(node: unknown): StyleElement | null {
		return this.styleKind(node) ? (node as StyleElement) : null;
	}
	/** @internal which kind of <style> `node` is (see styleElement), else null */
	styleKind(node: unknown): 'html' | 'svg' | null {
		// no node at all (a detached root's parent): answered without the
		// native getter's TypeError, which every insertion paid for twice
		if (typeof node !== 'object' || node === null) return null;
		try {
			if (
				Reflect.apply(nodeTypeGet, node, []) !== 1 ||
				Reflect.apply(localNameGet, node, []) !== 'style'
			)
				return null;
			const namespace = Reflect.apply(namespaceGet, node, []);
			return namespace === HTML_NAMESPACE
				? 'html'
				: namespace === SVG_NAMESPACE
					? 'svg'
					: null;
		} catch (error) {
			// not a node
			return null;
		}
	}
	/**
	 * @internal The <style> (see styleElement) whose text a Text node is part
	 * of (its parent), else null: comments and elements in a style are not
	 * its text
	 */
	styleOfText(node: unknown): StyleElement | null {
		try {
			if (Reflect.apply(nodeTypeGet, node, []) !== 3) return null;
			return this.styleElement(Reflect.apply(parentNodeGet, node, []));
		} catch (error) {
			return null;
		}
	}
	/** @internal the native serialisation of an element (markers kept), for markup the browser will parse */
	innerHTMLOf(element: Element): string {
		return this.innerHTML(element);
	}
	/**
	 * The shell hands over the blocker's cosmetic rules and scriptlets for
	 * this document (docs/adblock.md); the Adblock module takes them when the
	 * blocker is on
	 */
	adblock: (page: AdblockPage) => void = () => {};
	loadHTML(script: string, prewritten?: string) {
		// the shell escaped the markup with escapeText (modifyHTML), which
		// writes a no-break space as &nbsp;: an XML-level decode leaves that
		// as text, and every U+00A0 in a script, a style or a JSON payload
		// read "&nbsp;" (BBC's __NEXT_DATA__, so React's hydration failed)
		this.#startPage()(
			unescapeText(script),
			prewritten === undefined ? undefined : unescapeText(prewritten),
			true,
		);
	}
	/**
	 * Write the page as its markup comes: the worker served the shell once
	 * the head was in, and hands the rest to `url` (its MARKUP_ROUTE) as the
	 * origin sends it, each piece with its prewritten table
	 */
	loadHTMLStream(url: string) {
		const feed = this.#startPage();
		void readMarkup(url, (markup, table, sizes, end) => {
			// the sizes the body had, for the document's navigation timing
			// (ResourceTiming): the shell's are the browser's count
			if (sizes) this.documentSizes = sizes;
			feed(markup, (table ?? undefined) as Prewritten | undefined, end);
		});
	}
	/**
	 * Begin writing the page (../pageStream.ts): its markup is handed to the
	 * returned function in pieces, in order, each with the worker's table of
	 * its inline scripts and styles (its texts named by where they stand in
	 * that piece), the last with `end`. The shell's document is opened for
	 * the page at the shell's end, and what of the markup is parsed is
	 * written from there, a task at a time, so the page paints and loads as
	 * its markup comes.
	 */
	#startPage(): (
		markup: string,
		prewritten: string | Prewritten | undefined,
		end: boolean,
	) => void {
		// the document is new: its sandbox is decided now, and a document
		// without allow-scripts is guarded before any of its markup is touched
		this.refreshSandbox();
		const scripts = this.allows('allow-scripts');
		const shell = this.global.document;
		// the copy is made in an inert document (see inertDocumentOf), as a
		// write's is: made in this one, every image, video and audio in it
		// loaded a second time (each <video> of a page was downloaded twice),
		// an autoplaying one could play, detached, and an image that listens
		// to the viewport kept the whole copy alive
		const inert = inertDocumentOf(shell);
		// a document no worker controls (an <object>'s HTML document is a
		// blob: copy) gets its loads as copies, and its own markup is written
		// as markup the page writes is (WriteStream): a script copied at once,
		// or it would never run, the rest after the write (writtenLoads)
		const uncontrolled =
			!!this.getModule(DOMAttributesModule)?.uncontrolled?.();
		// what the write needs, each let go when the page is written: an Error
		// a page script makes while a piece is written keeps the functions of
		// its stack unformatted, these closures among them, so nothing large
		// is a variable they close over (see loadHTML's write before: CNN kept
		// 52 MB through a Svelte module's Error)
		const job: {
			// the parse
			stream: PageStream | null;
			// the markup so far, which a refused base's violation names its place in
			received: string;
			// what is copied and not yet written
			copied: string;
			// each rewritten classic script's text, to the source the page
			// wrote (the client's pendingScripts holds it once the page is
			// written, emptied at DOMContentLoaded)
			sources: Map<string, string> | null;
		} = { stream: null, received: '', copied: '', sources: new Map() };
		// the page's first <base href>: the base URL of everything in the page
		let base: StompURL | null = null;
		// what each copy is made in, to be serialized
		const node = inert.createElement('div');
		const copy = (from: Element, shallow: boolean) => {
			if (!shallow) {
				if (scripts) textifyNoscript(from, this.innerHTML);
				else unwrapNoscript(from);
			}
			const writing = this.writing;
			if (uncontrolled) this.writing = true;
			this.#parseBase = base;
			setGlobalParsingState(this.global, 'parsingBeforeWrite');
			try {
				// workaround: no descendant of the parse may go into any element
				// (attached or not), which would fetch its images; the copy is
				// made of its nodes (in the parse's own tree, where a base's
				// hook finds the policies before it)
				node.append(
					cloneRawNode(
						shallow ? [from] : [...from.childNodes],
						inert,
						false,
						shallow,
					),
				);
				setGlobalParsingState(this.global);
				// inline scripts are rewritten here, once. A classic script gets a
				// preamble that restores the source the page wrote for
				// `document.currentScript.textContent`; a module has no currentScript.
				// Nothing may produce `</script` in the markup.
				this.rewriteInlineScripts(node, true, job.sources ?? undefined);
			} finally {
				setGlobalParsingState(this.global);
				this.#parseBase = null;
				this.writing = writing;
			}
			const markup = serializeScripted(node, this.innerHTML);
			// the copy was made to be serialized (see releaseMarkup)
			releaseMarkup(node);
			empty(node);
			return markup;
		};
		// the first <base href> is the base URL of everything in the page
		// after it; its own href resolves against the document's URL, and
		// one that does not parse or names no web URL leaves the document's
		// URL in place
		const watch = (node: Element) => {
			const found = scripts ? 'base[href]:not(noscript base)' : 'base[href]';
			const element = node.matches(found) ? node : node.querySelector(found);
			if (!element) return false;
			const href = element.getAttribute('href');
			if (href !== null)
				try {
					const url = new URL(href, this.url.toString());
					if (ROUTE_PROTOCOLS.includes(url.protocol)) {
						const refused = this.baseRefused(url, element);
						if (!refused) base = new StompURL(url, this.url);
						// where in the markup its violation names (a deferred part,
						// ./violations.ts), for a base the page's policy refuses
						if (refused || this.pageRefusals('base-uri', url).length)
							deferred('markupBaseSite')(this, job.received, element);
					}
				} catch (error) {
					// not a URL: the document's own stands
				}
			return true;
		};
		// the parse (made with the first piece: all of the markup at once is
		// parsed whole, as it always was)
		let written = false;
		// a pass is due (a task the timer runs, or the open's own)
		let due = false;
		const state: NonNullable<typeof this.pieces> = {
			between: false,
			stopped: false,
		};
		// the root the page's markup made, gone when the page opened the
		// document again
		let root: Element | null = null;
		// when the page was last written
		let lastWrite = 0;
		// how much is written so far
		let total = 0;
		// a copy threw: the page is what was copied before it
		let failed = false;
		const finish = (document: Document) => {
			if (this.pieces !== state) return;
			this.pieces = null;
			job.stream = null;
			job.received = '';
			job.copied = '';
			job.sources = null;
			// what the write parsed now; what comes after a script it waits
			// for, once the parser is through (a copy is not made twice):
			// every load in a document no worker controls, an object's and
			// an embed's in any (DOMAttributes writtenLoads)
			this.writtenLoads?.(document);
			document.addEventListener(
				'DOMContentLoaded',
				() => {
					this.pendingScripts = null;
					// what asks the worker's table after the parse is a copy the
					// page makes, rewritten here as any it inserts
					this.#prewritten = null;
					this.writtenLoads?.(document);
				},
				{ once: true },
			);
			document.close();
		};
		// one pass: what the parse has done, written. The markup is written
		// in pieces that end before each `</script`: a parser fed by the
		// network performs a microtask checkpoint before it runs a script it
		// inserted (the "text" insertion mode), so a MutationObserver sees
		// the script, and may change it, before it runs, and a script's
		// promise reactions run before the next script. Nothing does between
		// the scripts of one write, so each piece after the first is written
		// from a microtask queued after those of the piece before. The next
		// pass is a task of its own, after which the page may paint.
		const pass = () => {
			due = false;
			const document = this.global.document;
			const page = job.stream;
			if (
				!page ||
				failed ||
				state.stopped ||
				(root !== null && rootOf(document) !== root)
			)
				return;
			let markup = '';
			// a copy that throws (a data: document cannot load the rewriter
			// library) ends the page where it is, and the document is closed
			// as natively, else it and every document above it never loaded
			let thrown: { error: unknown } | null = null;
			try {
				markup = page.take(now() + (root === null ? FIRST_PASS_MS : PASS_MS));
			} catch (error) {
				failed = true;
				thrown = { error };
			}
			job.copied += markup;
			const ended = failed || page.done;
			// written now: the first of the page, its end, what the parse had
			// once it has nothing more (the rest is on its way), or what was
			// copied once it is enough (WRITE_CHARS, more as the page grows);
			// else the next pass copies more first
			const time = now();
			if (
				root !== null &&
				markup &&
				!ended &&
				job.copied.length <
					Math.min(WRITE_MAX, Math.max(WRITE_CHARS, total / 4)) &&
				time - lastWrite < WRITE_MS
			) {
				schedule();
				return;
			}
			lastWrite = time;
			const batch = job.copied;
			total += batch.length;
			job.copied = '';
			// (what the next piece's write reads is no variable of this pass:
			// a piece is a slice of the batch, which keeps all of it while any
			// piece is kept, so each goes once written)
			const pieces = batch.split(/(?=<\/script)/i);
			const loads = uncontrolled || /<(?:object|embed)\b/i.test(batch);
			const more = markup !== '';
			const next = (index: number) => {
				if (state.stopped) {
					pieces.length = 0;
					return;
				}
				state.between = false;
				const piece = pieces[index]!;
				pieces[index] = '';
				this.write.call(document, trustedHTML(piece));
				state.between = true;
				root ??= rootOf(document);
				if (index + 1 < pieces.length) {
					Reflect.apply(this.#queueMicrotask, this.global, [
						this.ownCallback(() => next(index + 1)),
					]);
					return;
				}
				if (ended) {
					finish(document);
					return;
				}
				// an object's or an embed's load is not the worker's
				// (writtenLoads); the rest of the page waits for its markup
				if (loads) this.writtenLoads?.(document);
				if (more) schedule();
			};
			if (pieces[0]) next(0);
			else if (ended) finish(document);
			// reported as it was before the page was written as it is parsed
			if (thrown) throw thrown.error;
		};
		const schedule = () => {
			if (due || !written) return;
			due = true;
			Reflect.apply(this.#setTimeout, this.global, [this.ownCallback(pass)]);
		};

		// jump out of the DOM "write stream" so we can start loading our own HTML
		const load = () => {
			this.shellPending = false;
			Reflect.apply(this.open, this.global.document, []);
			runDocumentOpenListeners(this.global);
			// the host's post hook, on the document the page's markup lands in
			// (the shell asked apply() to leave it to us), before the first
			// script of the page
			this.runHook('post');
			// a script the parser has not run yet reads back as the page wrote
			// it (Readback), until the page's markup is parsed
			this.pendingScripts = job.sources;
			this.pieces = state;
			written = true;
			pass();
		};
		// The browser runs a timer's callback in the realm that made it, and
		// document.open() gives the document the URL of that realm's document.
		// This client may be another realm's: one the parent injected into an
		// iframe's initial about:blank stays on the window when the frame
		// navigates to its src (the browser keeps the Window for a document of
		// the same origin), and a callback of the parent's realm would give the
		// page the parent's URL (reCAPTCHA's anchor took its page for its
		// parent and never answered it). So the callback is this window's own,
		// through a wrapper and a setTimeout taken before any page script ran.
		//
		// The timer alone left a race: on a loaded machine the shell's parse
		// could end before it ran, and the shell's load event then marked the
		// frame complete, so the parent's load fired while the frame still
		// held the empty shell (a page's onload found nothing in its frame).
		// The shell ends with an empty script element of a type no script runs
		// as (SHELL_END, after the script that calls this), and a parser fed
		// by the network performs a microtask checkpoint at its end tag, with
		// no script running, where document.open() is allowed: an observer
		// that sees that element writes the page there, before the shell's
		// parse can end, so the frame keeps loading until the page has
		// loaded, as natively. The timer stays for a shell no such parser
		// reads; whichever comes first writes.
		this.shellPending = true;
		let observer: MutationObserver | null = null;
		let started = false;
		const start = () => {
			if (started) return;
			started = true;
			if (observer) Reflect.apply(nativeDisconnect, observer, []);
			load();
		};
		try {
			// (the page is written from a microtask the callback queues, in
			// the same checkpoint: the browser runs a microtask's callback in
			// its own realm, this window's, where the observer's callback may be
			// another realm's. A STomp the page runs in wraps the window's
			// observer in its own bundle's function, which may be the parent's,
			// and document.open() then gave the page the parent's URL)
			observer = new this.#MutationObserver(() => {
				if (
					!started &&
					Reflect.apply(nativeDocumentQuerySelector, shell, [
						`script[type="${SHELL_END}"]`,
					])
				)
					Reflect.apply(this.#queueMicrotask, this.global, [
						this.ownCallback(start),
					]);
			});
			Reflect.apply(nativeObserve, observer, [
				shell,
				{ childList: true, subtree: true },
			]);
		} catch (error) {
			// no observer: the timer writes the page
			observer = null;
		}
		Reflect.apply(this.#setTimeout, this.global, [this.ownCallback(start)]);

		return (markup, prewritten, end) => {
			// the document's inline scripts and styles as the worker rewrote
			// them, named by where their texts stand in this piece
			if (prewritten !== undefined)
				try {
					const table =
						typeof prewritten === 'string'
							? (JSON.parse(prewritten) as Prewritten)
							: prewritten;
					if (this.#prewritten) this.#prewritten.add(table, markup);
					else
						this.#prewritten = new PrewrittenTable(
							table,
							markup,
							this.names.access,
						);
				} catch (error) {
					// not a table: everything is rewritten here
				}
			job.received += markup;
			const stream = job.stream;
			if (stream) stream.add(markup, end);
			else if (end) {
				job.stream = new PageStream(
					parseHTML(markup, shell),
					copy,
					watch,
					true,
				);
				// a small page, all there before the document is opened for
				// it, is copied now, in the shell's script (PageStream
				// takeWhole), and written at the open
				if (!written)
					try {
						const whole = job.stream.takeWhole();
						if (whole !== null) job.copied = whole;
					} catch (error) {
						// as before: a copy that throws (a data: document cannot load
						// the rewriter library) leaves the shell, complete, and the
						// document is never opened for the page
						started = true;
						if (observer) Reflect.apply(nativeDisconnect, observer, []);
						this.shellPending = false;
						throw error;
					}
			} else {
				job.stream = new PageStream(parseHTML('', shell), copy, watch);
				job.stream.add(markup, false);
			}
			schedule();
		};
	}
}
