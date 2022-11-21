import StompURL from '../../StompURL';
import { ParsedConfig } from '../../config';
import { modifyJS } from '../../rewriteJS';
import { parseRoutedURL, ROUTE_PROTOCOLS } from '../../routeURL';
import Client from '../Client';
import cloneRawNode, { parseHTML } from './cloneNode';
import { shouldRewriteScript } from './modules/DOMAttributes';
import { decode, escapeText } from 'entities';

type OpenCallback = () => void;

const onDocumentOpen = new WeakMap<typeof globalThis, OpenCallback[]>();

export function addDocumentOpenListener(
	global: typeof globalThis,
	callback: OpenCallback
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
	value: ParsingState
) {
	globalParsingState.set(global, value);
}

// runtime document !== document in 0.001 ms!?!?!?

export default class DocumentClient extends Client {
	private write: typeof document.write;
	private baseURIDescriptor: PropertyDescriptor;
	private parentDescriptor: PropertyDescriptor;
	private topDescriptor: PropertyDescriptor;
	constructor(init: ParsedConfig, global: typeof globalThis) {
		super(init, global);
		this.write = this.global.document.write;
		this.baseURIDescriptor = Reflect.getOwnPropertyDescriptor(
			this.global.Node.prototype,
			'baseURI'
		)!;
		this.parentDescriptor = Reflect.getOwnPropertyDescriptor(
			this.global,
			'parent'
		)!;
		this.topDescriptor = Reflect.getOwnPropertyDescriptor(this.global, 'top')!;
		this.isDOM = true;
	}
	get parent(): typeof globalThis {
		return this.parentDescriptor.get!.call(this.global);
	}
	get top(): typeof globalThis {
		return this.topDescriptor.get!.call(this.global);
	}
	get url(): StompURL {
		if (ROUTE_PROTOCOLS.includes(this.baseURI.protocol)) {
			return parseRoutedURL(
				this.baseURI.href,
				this.codec,
				`${this.baseURI.origin}${this.directory}`
			).url;
		} else {
			return new StompURL(
				this.baseURI.href,
				this.codec,
				`${this.baseURI.origin}${this.directory}`
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

		for (const script of node.querySelectorAll('script')) {
			if (script.text && shouldRewriteScript(script)) {
				script.text = `document.currentScript.textContent = ${escapeText(
					JSON.stringify(script.textContent)
				)};${modifyJS(script.text, this.url, this.config, 'generic')}`;
			}
		}

		const newDocument =
			(parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : '') +
			node.innerHTML;

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
