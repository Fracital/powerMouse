import { decode } from 'entities';
import { ParsedConfig } from '../../config';
import { modifyJS, rewriteImportMap } from '../../rewriteJS';
import { parseRoutedURL, ROUTE_PROTOCOLS } from '../../routeURL';
import StompURL from '../../StompURL';
import { OPEN_TAB } from '../../transport/messages';
import Client from '../Client';
import cloneRawNode, { parseHTML } from './cloneNode';
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
	private baseURIDescriptor: PropertyDescriptor;
	private parentDescriptor: PropertyDescriptor;
	private topDescriptor: PropertyDescriptor;
	// the real top's postMessage, taken before any page code ran: open
	// requests must not go through anything the page can replace
	private topPostMessage: typeof postMessage | null;
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
		this.write = this.global.document.write;
		this.open = this.global.document.open;
		const innerHTMLGet = Reflect.getOwnPropertyDescriptor(
			this.global.Element.prototype,
			'innerHTML',
		)!.get!;
		this.innerHTML = (element) => Reflect.apply(innerHTMLGet, element, []);
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
	get top(): typeof globalThis {
		return this.topDescriptor.get!.call(this.global);
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
			return new StompURL(
				this.baseURI.href,
				this.codec,
				`${this.baseURI.origin}${this.directory}`,
			);
		}
	}
	get baseURI(): URL {
		return new URL(this.baseURIDescriptor.get!.call(this.global.document));
	}
	loadHTML(script: string) {
		setGlobalParsingState(this.global, 'parsingBeforeWrite');

		const parsed = parseHTML(decode(script));

		// workaround:
		// we cannot append any descendants of parsed into any element (whether it is attached or detached) because it will pre-fetch the images in parsed
		// pass the entirety of parsed into cloneRawNode

		const node = this.global.document.createElement('div');
		node.append(cloneRawNode([parsed.documentElement]));

		setGlobalParsingState(this.global);

		// inline scripts are rewritten here, once. A classic script gets a
		// preamble that restores the source the page wrote for
		// `document.currentScript.textContent`; a module has no currentScript.
		// Nothing may produce `</script` in the markup.
		for (const script of node.querySelectorAll('script')) {
			if (!script.text) continue;
			if (
				(script.getAttribute('type') || '').trim().toLowerCase() === 'importmap'
			) {
				script.text = rewriteImportMap(script.text, this.url, this.config);
				continue;
			}
			if (!shouldRewriteScript(script)) continue;
			const source = script.text;
			const isModule = scriptKind(script) === 'module';
			const rewritten = modifyJS(
				source,
				this.url,
				this.config,
				isModule ? 'genericModule' : 'generic',
			);
			script.text = (
				isModule
					? rewritten
					: `document.currentScript.textContent = ${JSON.stringify(source)};${rewritten}`
			).replace(/<\/script/gi, '<\\/script');
		}

		const newDocument =
			(parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : '') +
			this.innerHTML(node);

		// jump out of the DOM "write stream" so we can start loading our own HTML
		setTimeout(() => {
			Reflect.apply(this.open, this.global.document, []);
			runDocumentOpenListeners(this.global);
			this.write.call(this.global.document, newDocument);
			this.global.document.close();
		});
	}
}
