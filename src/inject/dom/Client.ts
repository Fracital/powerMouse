import { decodeHTML } from 'entities';
import { ParsedConfig } from '../../config';
import type { HookContext, HookErrorInfo, HookPhase } from '../../hooks';
import { refererFor, type ReferrerInfo } from '../../referrerPolicy';
import { modifyCSS, rewriteCSSValueURLs } from '../../rewriteCSS';
import { modifyHTML } from '../../rewriteHTML';
import { modifyJS, rewriteImportMap } from '../../rewriteJS';
import { parseRoutedURL, ROUTE_PROTOCOLS } from '../../routeURL';
import StompURL from '../../StompURL';
import { HOOK_ERROR, OPEN_TAB, WORKER_BASE } from '../../transport/messages';
import Client from '../Client';
import cloneRawNode, { nativeAttributes, parseHTML } from './cloneNode';
import DOMAttributesModule, {
	scriptKind,
	shouldRewriteScript,
} from './modules/DOMAttributes';
import { MARKER } from './modules/MutationObserver';
import SyncModule from './modules/Sync';
import {
	documentNonce,
	guardDocument,
	pageSandbox,
	sandboxTokens,
	stripScripts,
	textifyNoscript,
	unwrapNoscript,
} from './sandbox';
import { siteKeyOf } from './site';

type OpenCallback = () => void;

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

// runtime document !== document in 0.001 ms!?!?!?

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
	/** the window's native frameElement getter (the Framing module hooks it) */
	#frameElementGet: (() => Element | null) | undefined;
	/** the flags a popup inherited from its opener when it was created */
	#inheritedFlags: Set<string> | null = null;
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
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
		this.isDOM = true;
		this.guardScripts();
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
		const key = opaque ? null : siteKeyOf(this.url.toString());
		this.#siteKey = { document, opaque, key };
		return key;
	}
	/** the nonce the inject's own scripts carry in a document without allow-scripts, else null */
	get scriptNonce(): string | null {
		return this.allows('allow-scripts')
			? null
			: documentNonce(this.global.document);
	}
	/**
	 * A document without allow-scripts runs no script of the page: the real
	 * frame has to allow scripts (the inject rewrites the document), so the
	 * document gets a Content-Security-Policy that lets only scripts carrying
	 * the inject's nonce run (sandbox.ts). It is in place before any of the
	 * page's markup reaches the document, and every document this one makes
	 * of its own (about:blank, srcdoc, blob:, data:) inherits it.
	 */
	guardScripts() {
		if (!this.allows('allow-scripts')) guardDocument(this.global.document);
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
		return this.nested ? this.topOrigin : false;
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
		if (!name || name.startsWith('_')) return false;
		for (const frame of this.global.document.querySelectorAll(
			'iframe[name], frame[name]',
		))
			if (frame.getAttribute('name') === name) return true;
		return false;
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
		return `<!doctype html><script>location.replace(${JSON.stringify(route).replace(/</g, '\\u003c')})</script>`;
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
	get url(): StompURL {
		if (this.#parseBase) return this.#parseBase;
		// a document the page made (a blob, a data: frame, an inline document
		// the worker served): its shell named the URL it shows
		const named = (this.global as Record<string, unknown>)[WORKER_BASE];
		if (typeof named === 'string')
			return new StompURL(
				named,
				this.codec,
				`${this.baseURI.origin}${this.directory}`,
			);
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
				write(rewriteImportMap(read(), this.url, this.config));
				continue;
			}
			if (!shouldRewriteScript(script)) continue;
			const source = read();
			const isModule = scriptKind(script) === 'module';
			// the restore runs after the script's directive prologue, so a strict
			// script stays strict
			const rewritten = modifyJS(
				source,
				this.url,
				this.config,
				isModule ? 'genericModule' : 'generic',
				isModule
					? ''
					: `document.currentScript.textContent = ${JSON.stringify(source)};`,
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
			this.sweepFrames?.();
			return text;
		}
		if (!this.isConnected(script) || !shouldRewriteScript(script)) return text;
		const rewritten = modifyJS(
			text,
			this.url,
			this.config,
			scriptKind(script) === 'module' ? 'genericModule' : 'generic',
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
		try {
			return modifyCSS(text, this.url);
		} catch (error) {
			// unparsable: route what the regex can find
			return rewriteCSSValueURLs(text, this.url);
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
	loadHTML(script: string) {
		// the document is new: its sandbox is decided now, and a document
		// without allow-scripts is guarded before any of its markup is touched
		this.refreshSandbox();
		setGlobalParsingState(this.global, 'parsingBeforeWrite');

		// the shell escaped the markup with escapeText (modifyHTML), which
		// writes a no-break space as &nbsp;: an XML-level decode leaves that
		// as text, and every U+00A0 in a script, a style or a JSON payload
		// read "&nbsp;" (BBC's __NEXT_DATA__, so React's hydration failed)
		const parsed = parseHTML(decodeHTML(script), this.global.document);
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

		const node = this.global.document.createElement('div');
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
			node.append(cloneRawNode([parsed.documentElement], this.global.document));

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
			this.innerHTML(node);

		// jump out of the DOM "write stream" so we can start loading our own HTML
		const load = () => {
			Reflect.apply(this.open, this.global.document, []);
			runDocumentOpenListeners(this.global);
			// the host's post hook, on the document the page's markup lands in
			// (the shell asked apply() to leave it to us), before the first
			// script of the page
			this.runHook('post');
			this.write.call(this.global.document, newDocument);
			if (uncontrolled) {
				// what the write parsed now; what comes after a script it waits
				// for, once the parser is through (a copy is not made twice)
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
		Reflect.apply(this.#setTimeout, this.global, [this.ownCallback(load)]);
	}
}
