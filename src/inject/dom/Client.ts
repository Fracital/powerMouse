import { decode } from 'entities';
import { ParsedConfig } from '../../config';
import type { HookContext, HookErrorInfo, HookPhase } from '../../hooks';
import { refererFor, type ReferrerInfo } from '../../referrerPolicy';
import { modifyHTML } from '../../rewriteHTML';
import { modifyJS, rewriteImportMap } from '../../rewriteJS';
import { parseRoutedURL, ROUTE_PROTOCOLS } from '../../routeURL';
import StompURL from '../../StompURL';
import { HOOK_ERROR, OPEN_TAB, WORKER_BASE } from '../../transport/messages';
import Client from '../Client';
import cloneRawNode, { nativeAttributes, parseHTML } from './cloneNode';
import { scriptKind, shouldRewriteScript } from './modules/DOMAttributes';

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
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
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
		this.isDOM = true;
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
	/** the origin of the outermost proxied document above this one (its own when it is the top) */
	get topOrigin(): string {
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
		return (
			(context as Record<string, any>)[this.names.client] as DocumentClient
		).url.url.origin;
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
	 * The document a javascript: URL's string value becomes, in the shell
	 * with this page as its URL (as a blob document gets it), so its scripts
	 * run injected; routeHTML's javascript: wrapper calls this.
	 */
	javascriptDocument(markup: string): string {
		return modifyHTML(markup, this.url, this.config, true);
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
	get url(): StompURL {
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
	rewriteInlineScripts(root: ParentNode) {
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
			write(rewritten.replace(/<\/script/gi, '<\\/script'));
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
		setGlobalParsingState(this.global, 'parsingBeforeWrite');
		this.rewriteInlineScripts(root);
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
		if (
			!this.isConnected(script) ||
			!shouldRewriteScript(script) ||
			script === this.global.document.currentScript
		)
			return text;
		const rewritten = modifyJS(
			text,
			this.url,
			this.config,
			scriptKind(script) === 'module' ? 'genericModule' : 'generic',
		);
		this.rewrittenScripts.set(script, rewritten);
		return rewritten;
	}
	/** @internal the native serialisation of an element (markers kept), for markup the browser will parse */
	innerHTMLOf(element: Element): string {
		return this.innerHTML(element);
	}
	loadHTML(script: string) {
		setGlobalParsingState(this.global, 'parsingBeforeWrite');

		const parsed = parseHTML(decode(script), this.global.document);

		// workaround:
		// we cannot append any descendants of parsed into any element (whether it is attached or detached) because it will pre-fetch the images in parsed
		// pass the entirety of parsed into cloneRawNode

		const node = this.global.document.createElement('div');
		node.append(cloneRawNode([parsed.documentElement], this.global.document));

		setGlobalParsingState(this.global);

		// inline scripts are rewritten here, once. A classic script gets a
		// preamble that restores the source the page wrote for
		// `document.currentScript.textContent`; a module has no currentScript.
		// Nothing may produce `</script` in the markup.
		this.rewriteInlineScripts(node);

		const newDocument =
			(parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : '') +
			this.innerHTML(node);

		// jump out of the DOM "write stream" so we can start loading our own HTML
		setTimeout(() => {
			Reflect.apply(this.open, this.global.document, []);
			runDocumentOpenListeners(this.global);
			// the host's post hook, on the document the page's markup lands in
			// (the shell asked apply() to leave it to us), before the first
			// script of the page
			this.runHook('post');
			this.write.call(this.global.document, newDocument);
			this.global.document.close();
		});
	}
}
