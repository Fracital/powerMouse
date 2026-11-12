import type { AdblockPage } from '../../blocker/types';
import { ParsedConfig } from '../../config';
import {
	BLOB_COPIES,
	browserPolicy,
	browserRefuses,
	governing,
	hashMatches,
	hostsApply,
	inlineAllowed,
	integrityMatches,
	markedPolicy,
	parsePolicies,
	policyMark,
	sourcesMatch,
	type Policy,
	type PolicyText,
} from '../../csp';
import { rewriteCSSValueURLs } from '../../cssURLs';
import type { HookContext, HookErrorInfo, HookPhase } from '../../hooks';
import { allowDelegates } from '../../isolation';
import {
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
	modifyHTML,
	nestedMarkOf,
	provideShellFacts,
	routeHTML,
} from '../../rewriteHTML';
import type { RewriterLib } from '../../rewriterLib';
import {
	injectWorkerJS,
	parseRoutedURL,
	proxyBlobURL,
	rewriterLibJS,
	ROUTE_PROTOCOLS,
	unwrapRoute,
} from '../../routeURL';
import { rewriteImportMap } from '../../scriptRoutes';
import StompURL from '../../StompURL';
import { HOOK_ERROR, OPEN_TAB, WORKER_BASE } from '../../transport/messages';
import { queryOf } from '../../urlShape';
import { BUILD } from '../../version';
import { contextText, linkRoute, opaqueContext } from '../../visited';
import { ownCodec, shareCodec, type CodecBackend } from '../../wasm/codec';
import Client from '../Client';
import {
	getPublicSuffix,
	givenLibrary,
	libraryText,
	lightText,
	loadRewriterLibrary,
	modifyCSS,
	modifyJS,
	shareRewriter,
} from '../rewriter';
import { learnSites, siteAnswers } from '../sites';
import cloneRawNode, {
	inertDocumentOf,
	nativeAttributes,
	parseHTML,
	releaseMarkup,
	startedScripts,
} from './cloneNode';
import { initLoads, loadSource, type LoadSource } from './loadGrants';
import DOMAttributesModule, {
	scriptKind,
	shouldRewriteScript,
} from './modules/DOMAttributes';
import { MARKER } from './modules/MutationObserver';
import SyncModule from './modules/Sync';
import { createRewriterRealm, libraryFactoryFromScript } from './rewriterRealm';
import {
	documentNonce,
	guardDocument,
	pageSandbox,
	runningNonce,
	sandboxTokens,
	serializeScripted,
	stripScripts,
	textifyNoscript,
	unwrapNoscript,
} from './sandbox';
import { siteKeyOf } from './site';

type OpenCallback = () => void;

// taken when the bundle loads, before any hook
const nativeSetAttribute = Element.prototype.setAttribute;
const nativeQuerySelectorAll = Element.prototype.querySelectorAll;
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

export default class DocumentClient extends Client {
	private write: typeof document.write;
	// native document.open: the hooked one runs the open listeners, which
	// loadHTML does itself
	private open: typeof document.open;
	// native innerHTML, taken before the hooks: the page-facing getter folds
	// the markers back, which is the opposite of what the written page needs
	private innerHTML: (element: Element) => string;
	// native script text setter: the hooked one rewrites what it is given, and
	// markup the client rewrites itself must not go through it twice
	private scriptText: (script: HTMLScriptElement, text: string) => void;
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
		token: string;
	} | null = null;
	/** the window's native frameElement getter (the Framing module hooks it) */
	#frameElementGet: (() => Element | null) | undefined;
	/** the flags a popup inherited from its opener when it was created */
	#inheritedFlags: Set<string> | null = null;
	/** the nonce the shell script that made this client carried, in its document (guardScripts) */
	#shellNonce: { document: Document; nonce: string } | null = null;
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
		// the bundle's own realm's client: its load channel opens now
		if (global === globalThis) initLoads(this);
		this.#setTimeout = this.global.setTimeout;
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
		this.scriptText = (script, text) => Reflect.apply(textSet, script, [text]);
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
		// policy: this document's, which they inherit (src/csp.ts)
		provideShellFacts(() => this.scriptFacts);
		this.isDOM = true;
		// read while the shell's own script makes this client, never later: a
		// script running then could be the page's
		const shellNonce = runningNonce(this.global.document);
		if (shellNonce !== null)
			this.#shellNonce = { document: this.global.document, nonce: shellNonce };
		this.guardScripts();
		// The rewriter library this bundle's rewrites use (rewriter.ts). The
		// bundle's first client is its realm's document; a top makes the realm
		// it shares now, before any of our hooks or of the page's code exists
		if (
			shareRewriter(() => this.#rewriterLibrary(), {
				load: (library) => this.#topClient().loadSharedRewriter(library),
				text: () => {
					const top = this.#topClient();
					return top === this ? null : top.rewriterLibraryText(BUILD);
				},
				lightText: () => {
					const top = this.#topClient();
					return top === this ? null : top.rewriterLightText(BUILD);
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
			}) &&
			!this.sandboxedOpaque &&
			this.#topClient() === this
		)
			// with `rewriter: 'js'` the realm holds the rewriter library
			// itself, made from the file this top's shell loaded; with
			// `'wasm'` the light library, which is handed that file's text
			// when a call needs it
			// (in a document whose policy refuses code made from a string the
			// realm is made by a script with the document's nonce, and holds
			// the rewriter library itself whatever the option: the light one
			// would make it from its text)
			this.#rewriter = createRewriterRealm(
				this.global.document,
				this.wasmRewriter && this.scriptFacts.evaluates
					? undefined
					: (givenLibrary() ?? undefined),
				this.scriptFacts.evaluates ? null : this.scriptNonce,
			);
		// with `rewriter: 'wasm'` the library a top shares rewrites in the
		// module the controller compiled, once it has arrived: the realm
		// only instantiates it, and until then (and whenever the module
		// declines a script) its JavaScript rewriter answers. One instance
		// per top; a frame under it holds none
		const library = this.#rewriter;
		if (library && this.wasmRewriter)
			this.requestModules((name, module) => {
				try {
					library.adopt(name, module);
				} catch (error) {
					// the library is gone with its document
				}
			});
	}
	/**
	 * The rewriter library a top shares with the frames under it, in a realm
	 * no page code runs in (rewriterRealm.ts); null when this document is no
	 * top or could not make one. @internal
	 */
	get sharedRewriter(): RewriterLib | null {
		return this.#rewriter ?? null;
	}
	/**
	 * The rewriter library (the asset the bundles do not carry) loaded into
	 * the library this top shares, by this top's realm, which holds the
	 * file's text (its shell loaded it); where it does not, its request for
	 * it is this document's, not a frame's, whose own answer to the `allow`
	 * attribute the page gave it (`sync-xhr 'none'`, as on ad frames).
	 * False when `library` is not this top's. @internal
	 */
	loadSharedRewriter(library: RewriterLib): boolean {
		if (!this.#rewriter || library !== this.#rewriter) return false;
		loadRewriterLibrary(library);
		return true;
	}
	/**
	 * The rewriter library's text as this top's shell loaded it, for a
	 * document under it that keeps a library of its own (one sandboxed
	 * without allow-same-origin): a string, and nothing of this realm's
	 * with it. Null without the text, or for a bundle of another `build`.
	 * @internal
	 */
	rewriterLibraryText(build: string): string | null {
		return build === BUILD ? libraryText() : null;
	}
	/**
	 * The light library's statement (src/inject/rewriter.ts lightFactory)
	 * as this top holds it, for a document under it that makes a copy of its
	 * own; null without it, or for a bundle of another `build`. @internal
	 */
	rewriterLightText(build: string): string | null {
		return build === BUILD ? lightText() : null;
	}
	/** a top's library (null: it could not make one), undefined for a frame under a top */
	#rewriter: RewriterLib | null | undefined;
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
		if (this.#rewriter !== undefined) return this.#rewriter;
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
			const flags = this.#flagsOf(opener);
			if (!flags || flags.has('allow-popups-to-escape-sandbox')) return null;
			return flags;
		} catch (error) {
			// an opener of another origin (the host in isolation mode)
			return null;
		}
	}
	#sandbox(): Set<string> | null {
		let flags: Set<string> | null = this.#inheritedFlags;
		const narrow = (other: Set<string> | null) => {
			if (!other) return;
			flags = flags
				? new Set([...flags].filter((token) => other.has(token)))
				: new Set(other);
		};
		try {
			const frame =
				this.#frameElementGet &&
				(Reflect.apply(
					this.#frameElementGet,
					this.global,
					[],
				) as Element | null);
			if (frame) {
				const sandbox = pageSandbox(frame, MARKER);
				if (sandbox !== null) narrow(sandboxTokens(sandbox));
			}
			const parent = this.parent;
			if (parent !== this.global) narrow(this.#flagsOf(parent));
		} catch (error) {
			// a cross-origin parent (the host in isolation mode)
		}
		return flags;
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
		frames: WeakMap<Element, { windows: object[]; destination: string | null }>;
		elements: WeakMap<object, Element>;
	};
	/**
	 * The policies the browser applies to this document for the page's own
	 * (src/csp.ts): its headers' (the shell's) and its metas', each browser
	 * policy's text with the page's text it stands for
	 */
	policyTexts: PolicyText[] = [];
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
		// (its script and style directives name the document's nonce, and the
		// inject's files a worker imports, as the headers' do: src/csp.ts)
		const nonce = this.scriptFacts.nonce;
		const code = nonce
			? {
					nonce,
					assets: [
						injectWorkerJS(this.url, this.config),
						rewriterLibJS(this.url, this.config),
					].map((asset) => asset.split('?')[0]),
				}
			: undefined;
		for (const policy of parsePolicies(content, 'enforce', 'meta')) {
			const text = browserPolicy(policy, code);
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
	readonly #metaPolicies = new Map<
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
	readonly #appliedMetas = new Map<string, PolicyText[]>();
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
						`${MARKER}content`,
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
		if (!/^(https?|data|blob):$/.test(url.protocol)) return null;
		const refusing = this.pageRefusals(directive, url).some(
			({ policy }) => policy.disposition === 'enforce',
		);
		if (!refusing) {
			// (a data: or blob: URL's scheme is the browser's to report; a
			// frame's refusal is reported twice, measured)
			this.reportRefusal(directive, url, navigation, navigation ? 2 : 1);
			return null;
		}
		if (url.protocol === 'data:') return url.href;
		if (url.protocol === 'blob:' && !BLOB_COPIES.includes(directive))
			return proxyBlobURL(url.href);
		const blocked =
			url.protocol === 'blob:'
				? 'blob'
				: navigation && url.origin !== this.url.url.origin
					? url.origin
					: url.href.replace(/#.*$/s, '');
		return this.refusalURL('https', url.href, blocked);
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
	 * Report a load of `url` for `directive` that a report-only policy of
	 * the page's refuses and that went out (no enforced one refuses it): an
	 * event for each such policy, as the browser fires it, named as Chrome
	 * names the load (a navigation of another origin by its origin). The
	 * browser cannot be made to report it itself without refusing the load,
	 * so the event is the inject's: the same fields, but not trusted.
	 */
	reportRefusal(
		directive: string,
		url: URL,
		navigation = false,
		/** how many events the browser fires for one (a fetch is judged twice, measured) */
		times = 1,
	) {
		if (!/^(https?|wss?):$/.test(url.protocol)) return;
		const refusals = this.pageRefusals(directive, url);
		// an enforced refusal is the browser's to report, every policy's
		if (refusals.some(({ policy }) => policy.disposition === 'enforce')) return;
		const reporting = refusals.filter(
			({ policy }) => policy.disposition === 'report',
		);
		if (!reporting.length) return;
		const global = this.global as typeof globalThis;
		const Event = global.SecurityPolicyViolationEvent;
		if (typeof Event !== 'function') return;
		const blocked =
			navigation && url.origin !== this.url.url.origin
				? url.origin
				: url.href.replace(/#.*$/s, '');
		const document = global.document;
		for (const { policy } of reporting)
			for (let time = 0; time < times; time++)
				Reflect.apply(global.EventTarget.prototype.dispatchEvent, document, [
					new Event('securitypolicyviolation', {
						bubbles: true,
						composed: true,
						blockedURI: blocked,
						documentURI: this.url.url.href.replace(/#.*$/s, ''),
						referrer: this.referrerOf(document) ?? '',
						violatedDirective: directive,
						effectiveDirective: directive,
						originalPolicy: policy.text,
						disposition: 'report',
						sourceFile: '',
						statusCode: 200,
						lineNumber: 0,
						columnNumber: 0,
						sample: '',
					}),
				]);
	}
	/**
	 * The nonce a script or style element of the page's (`directive`
	 * script-src-elem or style-src-elem) gets to be let through by the
	 * browser where every enforced policy of the page's allows it natively
	 * but the browser's copy of one would not (src/csp.ts codeSources): an
	 * inline one by the hash of its text (`text`, the page's, which the
	 * rewrite changed), an external one (`url`, the real URL) by its host
	 * where the policy also takes nonces, or by its integrity. Null where
	 * the browser decides as natively. `parser`: the element is the parser's
	 * (the page's markup, a document.write), which 'strict-dynamic' does
	 * not let through.
	 */
	codeNonce(
		element: Element,
		directive: 'script-src-elem' | 'style-src-elem',
		url: URL | null,
		text: string | null,
		parser: boolean,
	): string | null {
		const nonce = this.scriptNonce;
		if (nonce === null) return null;
		const enforced = this.pagePolicies().filter(
			({ policy }) => policy.disposition === 'enforce',
		);
		if (!enforced.length) return null;
		let own: string | null = null;
		try {
			own = (element as HTMLElement).nonce || element.getAttribute('nonce');
		} catch (error) {
			// an element of another kind
		}
		// (the page's integrity, which the browser never gets: the rewritten
		// body is not the one it names)
		const integrity =
			url &&
			((
				element as Element & {
					getAttributeOG?: (name: string) => string | null;
				}
			).getAttributeOG?.('integrity') ??
				element.getAttribute('integrity'));
		let needed = false;
		for (const { policy, self } of enforced) {
			const governed = governing(policy, directive);
			if (!governed) continue;
			const { sources } = governed;
			const lower = sources.map((source) => source.toLowerCase());
			const dynamic =
				directive === 'script-src-elem' && lower.includes("'strict-dynamic'");
			if (own && sources.includes(`'nonce-${own}'`)) continue;
			if (dynamic && !parser) continue;
			if (url === null) {
				if (inlineAllowed(sources, directive)) continue;
				if (text !== null && hashMatches(sources, text)) {
					needed = true;
					continue;
				}
				return null;
			}
			if (integrity && integrityMatches(sources, integrity)) {
				needed = true;
				continue;
			}
			if (!dynamic && sourcesMatch(sources, url, self)) {
				// the browser lets it through by 'self', and the worker applies the hosts
				if (!hostsApply(sources)) needed = true;
				continue;
			}
			return null;
		}
		return needed ? nonce : null;
	}
	/** give `element` the nonce codeNonce says it needs (a script's or a style's) */
	giveCodeNonce(
		element: Element,
		url: URL | null,
		text: string | null,
		parser: boolean,
	) {
		const directive =
			(element.localName || '').toLowerCase() === 'script'
				? 'script-src-elem'
				: 'style-src-elem';
		const nonce = this.codeNonce(element, directive, url, text, parser);
		if (nonce !== null)
			Reflect.apply(nativeSetAttribute, element, ['nonce', nonce]);
	}
	/** the URLs refusalURL made, by their host: the URL each stands for, and what a report names it by */
	readonly refusals = new Map<string, { url: string; blocked: string }>();
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
		try {
			return this.#policyCreator()?.refusedURI(value) ?? null;
		} catch (error) {
			return null;
		}
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
		if (this.scriptFacts.evaluates) return null;
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
		return this.parentDescriptor.get!.call(this.global);
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
			return parent !== this.global && this.names.client in parent;
		} catch (error) {
			return false;
		}
	}
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
	#partition?: { document: Document; partition: string };
	/**
	 * This document's storage partition: its top-level document's site when
	 * that is another site than its own, or when a frame between them is of
	 * another site (src/partition.ts). Decided once per document, from the
	 * chain of proxied parents: a site framed by another keeps to stores of
	 * its own from its first script on.
	 */
	override get partition(): string {
		const document = this.global.document;
		const kept = this.#partition;
		if (kept && kept.document === document) return kept.partition;
		let partition = '';
		try {
			if (this.proxiedTop !== this.global)
				partition = partitionOf(
					this.url.url.origin,
					this.topOrigin,
					getPublicSuffix,
					this.#crossAncestor(),
				);
		} catch (error) {
			// an origin without a site (opaque): it has no storage to key
		}
		this.#partition = { document, partition };
		return partition;
	}
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
			return !!parent && parent.partition !== '';
		} catch (error) {
			return false;
		}
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
	): string {
		return nestedMark(
			this.topOrigin,
			this.partition !== '',
			this.#embedder(allow, src, credentialless),
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
	 * a frame is of another origin and gets a window of its own). Called
	 * when the client is applied and when a shell says what its document is.
	 */
	override hideSharedArrayBuffer() {
		if (!this.hostIsolated) return;
		try {
			if (
				Reflect.get(this.global, 'crossOriginIsolated') === false &&
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
		return (
			(this.proxiedTop as Record<string, any>)[
				this.names.client
			] as DocumentClient
		).url.url.origin;
	}
	/** the windows this document opened (a sandboxed document may navigate them) */
	readonly openedWindows = new WeakSet<object>();
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
	 */
	mayNavigate(target: unknown): boolean {
		if (this.sandboxFlags === null || target === this.global) return true;
		if (typeof target !== 'object' || target === null) return true;
		if (this.openedWindows.has(target)) return true;
		// a descendant: its chain of parents reaches this window
		let context = target as typeof globalThis;
		for (let depth = 0; depth < 64; depth++) {
			let parent: typeof globalThis;
			try {
				parent = Reflect.apply(this.parentDescriptor.get!, context, []);
			} catch (error) {
				break;
			}
			if (parent === this.global) return true;
			if (parent === context) break;
			context = parent;
		}
		if (target !== this.proxiedTop) return false;
		if (this.allows('allow-top-navigation')) return true;
		return (
			this.allows('allow-top-navigation-by-user-activation') &&
			this.global.navigator.userActivation?.isActive === true
		);
	}
	/**
	 * The SecurityError a sandboxed document gets for navigating a window it
	 * may not (`member` of Location, set or called), naming the URL as the
	 * page wrote it
	 */
	navigationRefused(
		member: string,
		call: boolean,
		url: URL | string,
	): DOMException {
		return new this.global.DOMException(
			`${call ? `Failed to execute '${member}' on` : `Failed to set a named property '${member}' on`} 'Location': The current window does not have permission to navigate the target frame to '${String(url)}'.`,
			'SecurityError',
		);
	}
	/** what a navigation from this context routes as: the top origin when nested, else a top-level document */
	get nestedRoute(): string | false {
		return this.nested
			? nestedMark(this.topOrigin, this.#crossAncestor(), this.#ownEmbedder())
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
	linkRoute(resource: StompURL, base: StompURL = this.url): string {
		const context = this.visitedContext;
		const plain = () =>
			routeHTML(resource, base, this.config, false, this.nestedRoute);
		if (context === null || !ROUTE_PROTOCOLS.includes(resource.url.protocol))
			return plain();
		// a URL that is a route already is the real URL it stands for
		const target = unwrapRoute(resource.url, resource.codec) ?? resource.url;
		if (!this.followsOwnLinks) {
			const own = this.location.url;
			if (
				target.origin === own.origin &&
				target.pathname === own.pathname &&
				queryOf(target) === queryOf(own)
			)
				return plain();
		}
		return linkRoute(this.scope, this.codec, context, target);
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
		return this.topDescriptor.get!.call(this.global);
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
	readonly standIns = new Map<string, WeakRef<typeof globalThis>>();
	/** @internal frame elements showing an opaque (data:) document: never injected from this page (DOMAttributes, IFrame) */
	readonly opaqueFrames = new WeakSet<Element>();
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
		if (!route)
			return modifyHTML(
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
	/** @internal give the loads the parser made from markup the page wrote their copies (DOMAttributes; DOMHooks' write calls it) */
	writtenLoads?: (document: Document) => void;
	/**
	 * @internal this client's synchronous bridge, for a client of another
	 * bundle: a blob: document runs a bundle of its own, whose module classes
	 * are not this one's, so it cannot look this client's module up itself
	 */
	get syncBridge(): SyncModule | undefined {
		return this.getModule(SyncModule);
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
		const named = (this.global as Record<string, unknown>)[WORKER_BASE];
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
		// about:blank, about:srcdoc: of the document that made it
		if (own.protocol === 'about:') {
			const creator = this.#creatorClient();
			if (creator) return creator.url;
		}
		// anything else (a blob: copy no shell named, an <object>'s SVG): its
		// own address, the proxy's, which is no page's origin
		return new StompURL(location, this.codec, prefix);
	}
	/** the client of the document an about:blank or about:srcdoc document is of: its parent's, else its opener's */
	#creatorClient(): DocumentClient | null {
		for (const read of [
			() => this.global.parent,
			() => (this.global as unknown as { opener: unknown }).opener,
		])
			try {
				const window = read() as Record<string, unknown> | null;
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
	 * What a URL this document's page writes resolves against: its base URL
	 * (its <base href> when it has one, else its own URL), as the browser
	 * resolves an attribute, a fetch, a script's import. It is the page's
	 * own base while its markup is rewritten (loadHTML). Never a document's
	 * identity: that is `url`.
	 */
	get baseURL(): StompURL {
		if (this.#parseBase) return this.#parseBase;
		// Nearly every hook asks, and decoding the route each time was a
		// tenth of the hooks' time on a Google keystroke: the answer is a
		// function of the base URL and the shell's name for the page, so it
		// is made again only when either changed (a new copy each time, as a
		// caller may change what it is given)
		const named = (this.global as Record<string, unknown>)[WORKER_BASE];
		const base = this.baseURIDescriptor.get!.call(
			this.global.document,
		) as string;
		const memo = this.#urlMemo;
		if (memo && memo.base === base && memo.named === named)
			return new StompURL(memo.href, this.codec, memo.directory);
		const url = this.#readURL(named);
		this.#urlMemo = {
			base,
			named,
			href: url.url.href,
			directory: url.directory,
		};
		return url;
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
			const base = (this.global as Record<string, unknown>)[WORKER_BASE];
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
		return new URL(this.baseURIDescriptor.get!.call(this.global.document));
	}
	/**
	 * Rewrite every inline script under `root` the way the parser will run it
	 * (a classic script gets the currentScript preamble, a module none, an
	 * import map its routed targets): the written page (loadHTML) and
	 * document.write markup go through here before the browser parses them.
	 */
	rewriteInlineScripts(root: ParentNode, parsed = false) {
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
				write(rewriteImportMap(read(), this.baseURL, this.config));
				continue;
			}
			if (!shouldRewriteScript(script)) continue;
			const source = read();
			// the client's own (a style's stand-in, DOMContentHooks)
			if (isHTMLScript && this.rewrittenScripts.get(script) === source)
				continue;
			// let through by the hash of its text where the page's policy says
			// so: the rewrite is not that text (src/csp.ts)
			if (!script.hasAttribute('src'))
				this.giveCodeNonce(script, null, source, true);
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
			write(named.replace(/<\/script/gi, '<\\/script'));
		}
	}
	/**
	 * Load an XML document (a standalone SVG, an XHTML page) served through
	 * the XML shell: parsed with its own mime, its scripts rewritten, its tree
	 * re-created through the hooks in this document (namespaces kept) under
	 * the shell's root, since an XML document has no document.write.
	 * Scripts run as the tree lands, like a parser's would.
	 */
	loadXML(markup: string, mime: string) {
		const parsed = parseHTML(
			markup,
			this.global.document,
			mime as DOMParserSupportedType,
		);
		const root = parsed.documentElement;
		const live = this.global.document.documentElement;
		if (!root || !live) return;
		this.refreshSandbox();
		if (!this.allows('allow-scripts')) stripScripts(root);
		setGlobalParsingState(this.global, 'parsingBeforeWrite');
		this.rewriteInlineScripts(root, true);
		// The shell's root is the document's own start tag, so it stays (a
		// root put in its place would not carry the title: Chrome's
		// document.title only follows an SVG <title> that is inserted under
		// the connected root). Its attributes are set again, through the
		// hooks, and the shell's scripts give way to the page's children.
		for (const attribute of Array.from(
			Reflect.apply(nativeAttributes, live, []) as NamedNodeMap,
		))
			if (attribute.namespaceURI)
				live.setAttributeNS(
					attribute.namespaceURI,
					attribute.name,
					attribute.value,
				);
			else live.setAttribute(attribute.name, attribute.value);
		while (live.firstChild) live.removeChild(live.firstChild);
		const clone = cloneRawNode(root, this.global.document, true);
		setGlobalParsingState(this.global);
		live.append(clone);
		runDocumentOpenListeners(this.global);
	}
	/** @internal the rewritten text each script element carries (DOMContentHooks, DOMHooks) */
	readonly rewrittenScripts = new WeakMap<HTMLScriptElement, string>();
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
		if (!this.isConnected(script) || !shouldRewriteScript(script)) return text;
		if (!script.hasAttribute('src'))
			this.giveCodeNonce(script, null, text, false);
		const module = scriptKind(script) === 'module';
		const rewritten =
			this.prewrittenScript(module, text, true) ??
			modifyJS(
				text,
				this.baseURL,
				this.config,
				module ? 'genericModule' : 'generic',
			);
		this.rewrittenScripts.set(script, rewritten);
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
			if (text.length >= STYLE_MEMO_MIN) this.#rememberStyle(text, prewritten);
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
	readonly #styleOutputs = new Set<string>();
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
		if (table.url === this.baseURL.toString()) return table;
		return null;
	}
	/** the inline scripts and styles of the document loadHTML wrote, rewritten by the worker */
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
	readonly #styleMemo = new Map<string, string>();
	#styleMemoChars = 0;
	#rememberStyle(text: string, output: string) {
		if (output.length > STYLE_MEMO_CHARS / 4) return;
		if (!this.#styleOutputs.has(output)) {
			this.#styleOutputs.add(output);
			this.#styleOutputChars += output.length;
			for (const kept of this.#styleOutputs) {
				if (this.#styleOutputChars <= STYLE_MEMO_CHARS) break;
				this.#styleOutputs.delete(kept);
				this.#styleOutputChars -= kept.length;
			}
		}
		if (this.#styleMemo.has(text)) return;
		this.#styleMemo.set(text, output);
		this.#styleMemoChars += text.length + output.length;
		for (const [key, value] of this.#styleMemo) {
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
			return namespace === 'http://www.w3.org/1999/xhtml'
				? 'html'
				: namespace === 'http://www.w3.org/2000/svg'
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
		const markup = unescapeText(script);
		// the document's inline scripts and styles as the worker rewrote them,
		// named by where their texts stand in the markup
		if (prewritten !== undefined)
			try {
				this.#prewritten = new PrewrittenTable(
					JSON.parse(unescapeText(prewritten)) as Prewritten,
					markup,
					this.names.access,
				);
			} catch (error) {
				// not a table: everything is rewritten here
			}
		// the document is new: its sandbox is decided now, and a document
		// without allow-scripts is guarded before any of its markup is touched
		this.refreshSandbox();
		setGlobalParsingState(this.global, 'parsingBeforeWrite');

		const parsed = parseHTML(markup, this.global.document);
		if (parsed.documentElement) {
			if (this.allows('allow-scripts'))
				textifyNoscript(parsed.documentElement, this.innerHTML);
			else unwrapNoscript(parsed.documentElement);
		}

		// the first <base href> is the base URL of everything in the page; its
		// own href resolves against the document's URL, and one that does not
		// parse or names no web URL leaves the document's URL in place
		const baseHref = parsed.querySelector('base[href]')?.getAttribute('href');
		if (baseHref !== null && baseHref !== undefined)
			try {
				const base = new URL(baseHref, this.url.toString());
				if (ROUTE_PROTOCOLS.includes(base.protocol))
					this.#parseBase = new StompURL(base, this.url);
			} catch (error) {
				// not a URL: the document's own stands
			}

		// the copy is made in an inert document (see inertDocumentOf), as a
		// write's is: made in this one, every image, video and audio in it
		// loaded a second time (each <video> of a page was downloaded twice),
		// an autoplaying one could play, detached, and an image that listens
		// to the viewport kept the whole copy alive
		const inert = inertDocumentOf(this.global.document);
		const node = inert.createElement('div');
		// a document no worker controls (an <object>'s HTML document is a
		// blob: copy) gets its loads as copies, and its own markup is written
		// as markup the page writes is (WriteStream): a script copied at once,
		// or it would never run, the rest after the write (writtenLoads)
		const uncontrolled =
			!!this.getModule(DOMAttributesModule)?.uncontrolled?.();
		const writing = this.writing;
		if (uncontrolled) this.writing = true;
		try {
			// workaround:
			// we cannot append any descendants of parsed into any element (whether it is attached or detached) because it will pre-fetch the images in parsed
			// pass the entirety of parsed into cloneRawNode
			node.append(cloneRawNode([parsed.documentElement], inert));

			setGlobalParsingState(this.global);

			// inline scripts are rewritten here, once. A classic script gets a
			// preamble that restores the source the page wrote for
			// `document.currentScript.textContent`; a module has no currentScript.
			// Nothing may produce `</script` in the markup.
			this.rewriteInlineScripts(node, true);
		} finally {
			this.#parseBase = null;
			this.writing = writing;
		}

		const newDocument =
			(parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : '') +
			serializeScripted(node, this.innerHTML);
		// the copy was made to be serialized (see releaseMarkup)
		releaseMarkup(node);

		// jump out of the DOM "write stream" so we can start loading our own HTML
		const load = () => {
			this.shellPending = false;
			Reflect.apply(this.open, this.global.document, []);
			runDocumentOpenListeners(this.global);
			// the host's post hook, on the document the page's markup lands in
			// (the shell asked apply() to leave it to us), before the first
			// script of the page
			this.runHook('post');
			this.write.call(this.global.document, newDocument);
			{
				// what the write parsed now; what comes after a script it waits
				// for, once the parser is through (a copy is not made twice):
				// every load in a document no worker controls, an object's and
				// an embed's in any (DOMAttributes writtenLoads)
				const document = this.global.document;
				this.writtenLoads?.(document);
				document.addEventListener(
					'DOMContentLoaded',
					() => this.writtenLoads?.(document),
					{ once: true },
				);
			}
			this.global.document.close();
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
		this.shellPending = true;
		Reflect.apply(this.#setTimeout, this.global, [this.ownCallback(load)]);
	}
}
