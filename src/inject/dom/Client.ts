import { decode, escapeText } from 'entities';
import { ParsedConfig } from '../../config';
import { modifyJS } from '../../rewriteJS';
import { parseRoutedURL, ROUTE_PROTOCOLS } from '../../routeURL';
import StompURL from '../../StompURL';
import { OPEN_TAB } from '../../transport/messages';
import Client from '../Client';
import cloneRawNode, { parseHTML } from './cloneNode';
import { shouldRewriteScript } from './modules/DOMAttributes';

type OpenCallback = () => void;

const onDocumentOpen = new WeakMap<typeof globalThis, OpenCallback[]>();

export function addDocumentOpenListener(
	global: typeof globalThis,
	callback: OpenCallback,
) {
	if (!onDocumentOpen.has(global)) onDocumentOpen.set(global, []);

	return onDocumentOpen.get(global)!.push(callback);
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
		if (!this.config.openTab || !this.topPostMessage) return false;
		try {
			Reflect.apply(this.topPostMessage, this.top, [{ [OPEN_TAB]: url }, '*']);
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
			if (!script.text || !shouldRewriteScript(script)) continue;
			const source = script.text;
			const isModule = script.type === 'module';
			const rewritten = modifyJS(
				source,
				this.url,
				this.config,
				isModule ? 'genericModule' : 'generic',
			);
			script.text = (
				isModule
					? rewritten
					: `document.currentScript.textContent = ${escapeText(
							JSON.stringify(source),
						)};${rewritten}`
			).replace(/<\/script/gi, '<\\/script');
		}

		const newDocument =
			(parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : '') +
			this.innerHTML(node);

		// jump out of the DOM "write stream" so we can start loading our own HTML
		setTimeout(() => {
			this.global.document.open();
			if (onDocumentOpen.has(this.global))
				for (const callback of onDocumentOpen.get(this.global)!) callback();
			this.write.call(this.global.document, newDocument);
			this.global.document.close();
		});
	}
}
