import { parseSrcset, stringifySrcset } from 'srcset';
import {
	modifyCSS,
	restoreCSSValueURLs,
	rewriteCSSValueURLs,
	routeCSS,
} from '../../../rewriteCSS';
import { modifyHTML, modifyRefresh, routeHTML } from '../../../rewriteHTML';
import { modifyJS, routeJS, ScriptType } from '../../../rewriteJS';
import {
	parseDataURI,
	proxyBlobURL,
	ROUTE_PROTOCOLS,
	routeBinary,
	routeXHR,
} from '../../../routeURL';
import StompURL from '../../../StompURL';
import { LOAD_HEADER } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule, { usePrototype } from '../../modules/Proxy';
import { scopePrefix, unrouteURL } from '../../modules/Unroute';
import { blobLoads } from '../blobLoads';
import DocumentClient from '../Client';
import DOMHooksModule, { CustomElement, nativeElement } from './DOMHooks';
import { hookWrite } from './MutationObserver';
import NavigationHintModule from './NavigationHint';
import SyncModule from './Sync';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** the JavaScript MIME type essences (HTML "JavaScript MIME type") */
const JS_MIME_TYPES = new Set([
	'application/ecmascript',
	'application/javascript',
	'application/x-ecmascript',
	'application/x-javascript',
	'text/ecmascript',
	'text/javascript',
	'text/javascript1.0',
	'text/javascript1.1',
	'text/javascript1.2',
	'text/javascript1.3',
	'text/javascript1.4',
	'text/javascript1.5',
	'text/jscript',
	'text/livescript',
	'text/x-ecmascript',
	'text/x-javascript',
]);

/**
 * What the browser makes of a script element's type, as Chrome does it: a
 * classic script (no type, a JavaScript MIME type in any case or spacing,
 * or the legacy `language` attribute), a module (`module` in any case, no
 * surrounding whitespace), or something that does not run.
 */
export function scriptKind(element: Element): 'classic' | 'module' | null {
	let type = element.getAttribute('type');
	if (type === null) {
		const language = element.getAttribute('language');
		type = language ? `text/${language}` : '';
	}
	if (type.toLowerCase() === 'module') return 'module';
	type = type.trim().toLowerCase();
	if (type === '') return 'classic';
	return JS_MIME_TYPES.has(type) ? 'classic' : null;
}

export function shouldRewriteScript(element: Element) {
	return scriptKind(element) !== null;
}

export function scriptType(element: Element): ScriptType {
	return scriptKind(element) === 'module' ? 'genericModule' : 'generic';
}

export default class DOMAttributesModule extends Module<DocumentClient> {
	formHook?: (element: CustomElement) => void;
	/** @internal whether this document is one no service worker controls, whose routed loads miss the worker */
	uncontrolled: () => boolean = () => false;
	/** @internal copy a <style>'s routed loads in a document no service worker controls (DOMContentHooks) */
	copySheet?: (style: HTMLStyleElement, mark: (rule: CSSRule) => void) => void;
	/** @internal copy a constructed sheet's routed loads in a document no service worker controls (CSSOM) */
	copyConstructed?: (sheet: CSSStyleSheet) => void;
	/** @internal the page's view of a CSSStyleDeclaration: reads unrouted, writes routed (CSSReadback) */
	wrapDeclaration?: (declaration: CSSStyleDeclaration) => CSSStyleDeclaration;
	// captured before the hooks replace them, for serializeStyle
	#nativeStyle: PropertyDescriptor;
	#nativeCssText: PropertyDescriptor;
	#scratch?: HTMLElement;
	constructor(client: DocumentClient) {
		super(client);
		this.#nativeStyle = Reflect.getOwnPropertyDescriptor(
			client.global.HTMLElement.prototype,
			'style',
		)!;
		this.#nativeCssText = Reflect.getOwnPropertyDescriptor(
			client.global.CSSStyleDeclaration.prototype,
			'cssText',
		)!;
	}
	/** the style attribute the browser writes when `text` is assigned to el.style */
	serializeStyle(text: string): string {
		this.#scratch ??= this.client.global.document.createElement('div');
		Reflect.apply(
			this.#nativeCssText.set!,
			Reflect.apply(this.#nativeStyle.get!, this.#scratch, []),
			[text],
		);
		return nativeElement.getAttribute.call(this.#scratch, 'style') ?? '';
	}
	apply() {
		// before the BlobDocuments module wraps it (it applies after this one)
		const NativeBlob = this.client.global.Blob;

		// A document no service worker controls (an about:blank frame or popup
		// the page built, or a document it opened: Chrome hands neither to the
		// page's worker) loads its elements from the proxy origin's own server,
		// where a route means nothing. Its loads are fetched through the proxy
		// instead (routedFetch, from the nearest controlled ancestor) and the
		// element gets a blob: URL of the copy, written underneath the hooks:
		// the attribute, the property and the markup read back as the page
		// wrote them, currentSrc as the URL the copy came from.
		const uncontrolled = () =>
			!this.client.controlled &&
			(this.client.opened ||
				this.client.global.location.href === 'about:blank');
		this.uncontrolled = uncontrolled;
		// the proxy origin from the base URL: an about:blank document's own
		// origin reads "null"
		const isRoute = (value: string) => {
			const prefix = scopePrefix(this.client);
			try {
				return new URL(value, prefix).href.startsWith(prefix);
			} catch (error) {
				return false;
			}
		};
		// per element and attribute: the routed value the copy is for, and its
		// blob: URL once it is in (a hook that runs again for the same value
		// keeps the copy)
		// taken now: a page that replaces them later sees none of the copies
		const createObjectURL = this.client.global.URL.createObjectURL;
		const revokeObjectURL = this.client.global.URL.revokeObjectURL;
		/** one value's copies: the routed value, what was set, the blobs made */
		type Copy = { routed: string; url?: string; made: string[] };
		const copies = new WeakMap<object, Map<string, Copy>>();
		// a route inside a url(): the worker's rewritten CSS writes them whole,
		// then the marker that keeps the page's token
		const routePattern = () => {
			const escaped = scopePrefix(this.client).replace(
				/[.*+?^${}()|[\]\\]/g,
				'\\$&',
			);
			return new RegExp(`(url\\(\\s*["']?)(${escaped}[^"'\\s)#]*)`, 'g');
		};
		const routesIn = (text: string) => [
			...new Set([...text.matchAll(routePattern())].map((match) => match[2])),
		];
		const withCopies = (text: string, copied: Map<string, string>) =>
			text.replace(
				routePattern(),
				(match, open: string, target: string) =>
					`${open}${copied.get(target) ?? target}`,
			);
		/** the copies the inject made that `text` shows */
		const blobsIn = (text: string) =>
			new Set(
				[...text.matchAll(/blob:[^"'\s)#]+/g)]
					.map((match) => match[0])
					.filter((url) => blobLoads.has(url)),
			);
		/** copies of every route in `text`, by route (a failed one is left out) */
		const copiesOf = async (text: string, state: Copy, depth: number) => {
			const copied = new Map<string, string>();
			// each route as the load where it first appears
			const kinds = new Map<string, string>();
			for (const match of text.matchAll(routePattern()))
				if (!kinds.has(match[2]))
					kinds.set(match[2], cssLoadKind(text, match.index ?? 0, match[2]));
			await Promise.allSettled(
				routesIn(text).map(async (target) =>
					copied.set(
						target,
						await copyOf(
							target,
							unrouteURL(this.client, target) ?? target,
							state,
							depth,
							kinds.get(target) ?? null,
						),
					),
				),
			);
			return copied;
		};
		/**
		 * A copied stylesheet's text with its own loads copied too: every route
		 * in a url() (an @import, a background, a font) becomes the blob: URL
		 * of its copy, the page's token kept after the marker for readbacks. An
		 * import's copy is a stylesheet again, copied the same way, `depth`
		 * levels at most (a cycle ends there). A route whose copy failed stays,
		 * and fails as it would have.
		 */
		const copyCSS = async (
			text: string,
			state: Copy,
			depth: number,
		): Promise<string> =>
			depth <= 0
				? text
				: withCopies(text, await copiesOf(text, state, depth - 1));
		// the latest pass per owner and key: an earlier one that ends later
		// gives way
		const passes = new WeakMap<object, Map<string, number>>();
		let passCount = 0;
		/**
		 * The CSS `owner` shows under `key` (its inline style, a <style>'s
		 * sheet), its routes copied and written back by `write`. The copies it
		 * shows afterwards are its own: an earlier pass's still shown move over
		 * to this one, the rest are released.
		 */
		const copyOwned = (
			owner: object,
			key: string,
			read: () => string,
			write: (copied: Map<string, string>) => void,
		) => {
			if (!uncontrolled()) return;
			if (!copies.has(owner)) copies.set(owner, new Map());
			const perOwner = copies.get(owner)!;
			if (!passes.has(owner)) passes.set(owner, new Map());
			const pass = ++passCount;
			passes.get(owner)!.set(key, pass);
			const state: Copy = { routed: key, made: [] };
			const settle = () => {
				const shown = blobsIn(read());
				const previous = perOwner.get(key);
				if (previous)
					for (const url of previous.made.splice(0))
						if (shown.has(url)) state.made.push(url);
						else {
							blobLoads.delete(url);
							Reflect.apply(revokeObjectURL, this.client.global.URL, [url]);
						}
				perOwner.set(key, state);
			};
			const text = read();
			if (!routesIn(text).length) {
				settle();
				return;
			}
			copiesOf(text, state, 4).then((copied) => {
				if (passes.get(owner)!.get(key) !== pass) {
					release(state);
					return;
				}
				write(copied);
				settle();
			});
		};
		// a declaration block's own methods, before the hooks wrap them
		const declarationProto = this.client.global.CSSStyleDeclaration.prototype;
		const nativeDeclaration = {
			setProperty: declarationProto.setProperty,
			getPropertyValue: declarationProto.getPropertyValue,
			getPropertyPriority: declarationProto.getPropertyPriority,
			item: declarationProto.item,
			length: Reflect.getOwnPropertyDescriptor(declarationProto, 'length')!
				.get!,
		};
		/** every property of `declaration` that names routes, set to their copies */
		const putCopies = (
			declaration: CSSStyleDeclaration,
			copied: Map<string, string>,
		) => {
			const call = (method: Function, args: unknown[]) =>
				Reflect.apply(method, declaration, args);
			const length = call(nativeDeclaration.length, []) as number;
			for (let i = 0; i < length; i++) {
				const name = call(nativeDeclaration.item, [i]) as string;
				const value = call(nativeDeclaration.getPropertyValue, [
					name,
				]) as string;
				if (!routesIn(value).length) continue;
				call(nativeDeclaration.setProperty, [
					name,
					withCopies(value, copied),
					call(nativeDeclaration.getPropertyPriority, [name]),
				]);
			}
		};
		/**
		 * What an element's load is to the browser, `<destination> <mode>` as
		 * its Sec-Fetch-Dest and Sec-Fetch-Mode (LOAD_HEADER): the copy is a
		 * fetch, and goes out as the load it stands for. Null for anything the
		 * worker would not take (a frame, an embed)
		 */
		const loadKind = (element: Element, attribute: string): string | null => {
			const mode = (owner: Element | null) =>
				owner?.hasAttribute('crossorigin') ? 'cors' : 'no-cors';
			const name = element.localName;
			if (element.namespaceURI === SVG_NAMESPACE)
				return name === 'image' || name === 'feImage'
					? 'image no-cors'
					: name === 'script'
						? 'script no-cors'
						: null;
			switch (name) {
				case 'img':
					return `image ${mode(element)}`;
				case 'input':
					return attribute === 'src' ? 'image no-cors' : null;
				case 'source': {
					const parent = element.parentElement;
					if (parent?.localName === 'picture')
						return `image ${mode(parent.querySelector('img'))}`;
					if (parent?.localName === 'video' || parent?.localName === 'audio')
						return `${parent.localName} ${mode(parent)}`;
					return null;
				}
				case 'script':
					return element.getAttribute('type') === 'module'
						? 'script cors'
						: `script ${mode(element)}`;
				case 'link': {
					const rel = (element.getAttribute('rel') ?? '')
						.toLowerCase()
						.split(/\s+/);
					if (rel.includes('stylesheet')) return `style ${mode(element)}`;
					if (rel.includes('modulepreload')) return 'script cors';
					if (rel.includes('preload')) {
						const as = (element.getAttribute('as') ?? '').toLowerCase();
						if (as === 'font') return 'font cors';
						if (
							['image', 'script', 'style', 'audio', 'video', 'track'].includes(
								as,
							)
						)
							return `${as} ${mode(element)}`;
					}
					return null;
				}
				case 'video':
				case 'audio':
					return attribute === 'poster'
						? 'image no-cors'
						: `${name} ${mode(element)}`;
				case 'track':
					return 'track cors';
				default:
					return null;
			}
		};
		/**
		 * What a route inside a stylesheet is to the browser: an @import a
		 * style, a font face's source a font, anything else (a background, a
		 * cursor, a mask) an image
		 */
		const cssLoadKind = (text: string, at: number, target: string): string => {
			try {
				const kind = new URL(target).pathname
					.slice(this.client.directory.length)
					.split('/')[0];
				if (kind === 'css') return 'style no-cors';
			} catch (error) {
				// not a URL: as an image
			}
			const face = text.lastIndexOf('@font-face', at);
			return face !== -1 && text.lastIndexOf('}', at) < face
				? 'font cors'
				: 'image no-cors';
		};
		/** a routed URL's copy, as a blob: URL (the proxy's form) */
		const copyOf = async (
			routed: string,
			page: string,
			state: Copy,
			depth = 4,
			load: string | null = null,
		): Promise<string> => {
			// an SVG reference's fragment names the element in the copy
			const hash = routed.indexOf('#');
			const fragment = hash === -1 ? '' : routed.slice(hash);
			const response = await this.client.routedFetch(
				hash === -1 ? routed : routed.slice(0, hash),
				{
					credentials: 'include',
					...(load ? { headers: { [LOAD_HEADER]: load } } : {}),
				},
			);
			if (!response.ok && response.status !== 0)
				throw new Error(String(response.status));
			const type = response.headers.get('content-type') ?? '';
			const body = /^\s*text\/css/i.test(type)
				? new NativeBlob([await copyCSS(await response.text(), state, depth)], {
						type,
					})
				: await response.blob();
			const url = proxyBlobURL(
				Reflect.apply(createObjectURL, this.client.global.URL, [
					body,
				]) as string,
			);
			state.made.push(url);
			blobLoads.set(url, page);
			return url + fragment;
		};
		/**
		 * A script's copy at once, through the nearest controlled document's
		 * synchronous bridge: a script the page writes runs in place, blocking
		 * the parser as it does natively (its copy cannot wait). Only when the
		 * transport runs in the transport worker, where the bridge completes;
		 * bounded well under the bridge's own limit. Null when it cannot.
		 */
		const syncCopyOf = (
			routed: string,
			page: string,
			state: Copy,
			load: string | null = null,
		): string | null => {
			if (!this.client.workerTransport) return null;
			const controlled =
				this.client.controlledClient() as DocumentClient | null;
			const sync = controlled?.getModule(SyncModule);
			if (!sync) return null;
			try {
				const response = sync.fetch(
					new URL(routed, scopePrefix(this.client)).href,
					{
						credentials: 'include',
						// a Headers: the bridge passes on no other kind
						...(load ? { headers: new Headers({ [LOAD_HEADER]: load }) } : {}),
					},
					false,
					5000,
				);
				if (!response.ok) return null;
				const url = proxyBlobURL(
					Reflect.apply(createObjectURL, this.client.global.URL, [
						new NativeBlob([response.rawArrayBuffer], {
							type: response.headers.get('content-type') ?? 'text/javascript',
						}),
					]) as string,
				);
				state.made.push(url);
				blobLoads.set(url, page);
				return url;
			} catch (error) {
				// a stuck or refused bridge: the copy is made the usual way
				return null;
			}
		};
		/** a value's copies are let go: no element shows them any more */
		const release = (state: Copy | undefined) => {
			if (!state) return;
			for (const url of state.made.splice(0)) {
				blobLoads.delete(url);
				Reflect.apply(revokeObjectURL, this.client.global.URL, [url]);
			}
		};
		// async=false scripts run in the order they were added (the browser's
		// list of scripts that execute in order follows when each gets its
		// src): a copy is applied once every earlier one of its document's is
		const scriptAsync = Reflect.getOwnPropertyDescriptor(
			this.client.global.HTMLScriptElement.prototype,
			'async',
		)?.get;
		const inOrder = new WeakMap<
			object,
			{ value?: string; apply: (value: string) => void }[]
		>();
		const flush = (document: object) => {
			const queue = inOrder.get(document)!;
			while (queue.length && queue[0].value !== undefined) {
				const entry = queue.shift()!;
				entry.apply(entry.value!);
			}
		};
		/**
		 * Set a load attribute to its routed value, or in a document no service
		 * worker controls to a copy of what it names (`urls` maps the value to
		 * the routed URLs it holds, for a srcset; one URL otherwise). The copies
		 * of the value it replaces are released once the new one is set (a
		 * media element plays the old one until then).
		 */
		const placeLoad = (
			element: CustomElement,
			attribute: string,
			routed: string,
			urls: { routed: string; page: string }[] | null = null,
			compose: (copies: string[]) => string = (copies) => copies[0],
		) => {
			const targets = urls ?? [
				{
					routed,
					page: new URL(
						element.getAttributeOG(attribute) ?? routed,
						this.client.url.toString(),
					).href,
				},
			];
			const perAttribute = copies.get(element);
			const current = perAttribute?.get(attribute);
			if (!uncontrolled() || !targets.some(({ routed }) => isRoute(routed))) {
				element.setAttribute(attribute, routed);
				if (current) {
					perAttribute!.delete(attribute);
					release(current);
				}
				return;
			}
			if (current?.routed === routed) {
				if (current.url) element.setAttribute(attribute, current.url);
				else element.removeAttribute(attribute);
				return;
			}
			if (!perAttribute) copies.set(element, new Map());
			const states = copies.get(element)!;
			const state: Copy = { routed, made: [] };
			states.set(attribute, state);
			// markup the page writes: the element here is the clone the markup
			// is rewritten on; the parser makes the real one, which gets its copy
			// after the write (writtenLoads). A script is copied at once below.
			if (this.client.writing && element.localName !== 'script') {
				states.delete(attribute);
				element.removeAttribute(attribute);
				return;
			}
			// a script the page writes (its src, an SVG script's href): its copy
			// now, or it would never run
			if (
				(attribute === 'src' || element.namespaceURI === SVG_NAMESPACE) &&
				element.localName === 'script' &&
				this.client.writing &&
				targets.length === 1
			) {
				const url = syncCopyOf(
					routed,
					targets[0].page,
					state,
					loadKind(element, attribute),
				);
				if (url) {
					state.url = url;
					element.setAttribute(attribute, url);
					release(current);
					return;
				}
			}
			// nothing loads until the copy is in
			element.removeAttribute(attribute);
			const apply = (value: string) => {
				if (states.get(attribute) !== state) {
					// replaced while it was on its way
					release(state);
					return;
				}
				state.url = value;
				usePrototype(element, CustomElement.prototype, (element) =>
					element.setAttribute(attribute, value),
				);
				release(current);
			};
			let settle = apply;
			if (
				attribute === 'src' &&
				element.localName === 'script' &&
				element.namespaceURI === HTML_NAMESPACE &&
				scriptAsync &&
				!Reflect.apply(scriptAsync, element, [])
			) {
				const document = element.ownerDocument;
				if (!inOrder.has(document)) inOrder.set(document, []);
				const entry: { value?: string; apply: (value: string) => void } = {
					apply,
				};
				inOrder.get(document)!.push(entry);
				settle = (value) => {
					entry.value = value;
					flush(document);
				};
			}
			// every copy is waited for: when one fails (the routed value is set,
			// which fails as it would have), the others are released with it
			Promise.allSettled(
				targets.map(({ routed, page }) =>
					isRoute(routed)
						? copyOf(routed, page, state, 4, loadKind(element, attribute))
						: routed,
				),
			).then((results) => {
				if (results.every((result) => result.status === 'fulfilled'))
					settle(
						compose(
							results.map(
								(result) => (result as PromiseFulfilledResult<string>).value,
							),
						),
					);
				else {
					settle(routed);
					release(state);
				}
			});
		};
		// A frame whose src is a data: document gets an opaque origin, which
		// the inject cannot reach: its requests would have nowhere to go and
		// its messages no route to the page. It loads instead from a blob: URL
		// of the shell with the data: URL itself as the document's URL, so it
		// runs injected and same-origin underneath, while every readback treats
		// it as the opaque origin "null" it is: its location is the data: URL,
		// its origin "null", and the page and the frame see each other through
		// the restricted cross-origin stand-ins (contentDocument null), as for
		// any frame of another real origin. Best effort, as every proxied
		// cross-origin frame is in same-origin mode.
		const opaqueDocument = (resource: StompURL): string | null => {
			if (resource.url.protocol !== 'data:') return null;
			const { mime, data } = parseDataURI(
				resource.url.pathname + resource.url.search,
			);
			if (
				!/^\s*(text\/html|application\/xhtml\+xml)\s*$/i.test(
					mime || 'text/plain',
				)
			)
				return null;
			// served by the worker as an inline document (controlled, its
			// subresources reaching the worker); its requests refer as a data:
			// document does, with nothing. Without a worker to register with,
			// the shell is a blob as before (subresources then miss the worker)
			const inline = this.client.inlineDocument(
				data,
				resource.url.href,
				'data:,',
			);
			if (inline) return inline;
			const blob = new NativeBlob(
				[modifyHTML(data, resource, this.client.config, true)],
				{ type: 'text/html' },
			);
			return proxyBlobURL(this.client.global.URL.createObjectURL(blob));
		};
		const domHooksModule = this.client.getModule(DOMHooksModule)!;

		// inline event handler attributes are scripts too: `onclick="top.x()"`
		// would reach the real top. Every `on*` the platform knows about, from
		// the prototypes that carry them; a hook per name, like the URL hooks
		const handlerNames = new Set<string>();
		const g = this.client.global;
		for (const owner of [
			g,
			g.Document.prototype,
			g.HTMLElement.prototype,
			g.SVGElement.prototype,
			g.Element.prototype,
			g.HTMLMediaElement.prototype,
			g.HTMLBodyElement.prototype,
		])
			for (const name of Object.getOwnPropertyNames(owner))
				if (/^on[a-z]+$/.test(name)) handlerNames.add(name);
		for (const name of handlerNames)
			domHooksModule.useAttributes(
				(element) => {
					element.restoreAttributesOG(name);
					if (element.hasAttribute(name)) {
						const source = element.getAttribute(name)!;
						element.setAttributeOG(name, source);
						element.setAttribute(
							name,
							modifyJS(source, this.client.url, this.client.config, 'generic'),
						);
					}
				},
				[['*', name]],
			);

		// SVG references (sprites, images, filters) by href or legacy
		// xlink:href. SVG node names keep their case, and the fragment stays.
		// The ones that load another file (an <image>, a <use> of an external
		// sprite, an <feImage>) are copied in a document no worker controls,
		// the fragment kept on the copy
		const SVG_LOADS = ['image', 'use', 'feimage'];
		const svgHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '' || value.startsWith('#')) return;
			element.setAttributeOG(attribute, value);
			const routed = routeBinary(
				new StompURL(
					new URL(value, this.client.url.toString()),
					this.client.url,
				),
			);
			if (SVG_LOADS.includes(element.localName.toLowerCase()))
				placeLoad(element, attribute, routed);
			else element.setAttribute(attribute, routed);
		};
		for (const attribute of ['href', 'xlink:href'])
			domHooksModule.useAttributes(
				svgHook(attribute),
				// live SVG elements keep their case; the page loader clones them as
				// HTML elements first, whose nodeName is upper case
				[
					'use',
					'image',
					'feImage',
					'mpath',
					'textPath',
					'linearGradient',
					'radialGradient',
					'pattern',
					'filter',
					'animate',
					'animateMotion',
					'animateTransform',
					'set',
					'cursor',
					'tref',
				]
					.flatMap((tag) => [tag, tag.toUpperCase()])
					.map((tag): [string, string] => [tag, attribute]),
			);

		// an SVG script loads its source by href (or xlink:href), like src
		const svgScriptHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '') return;
			element.setAttributeOG(attribute, value);
			const routed = routeJS(
				new StompURL(
					new URL(value, this.client.url.toString()),
					this.client.url,
				),
				this.client.url,
				this.client.config,
				'generic',
			);
			// an HTML script's href loads nothing
			if (element.namespaceURI === SVG_NAMESPACE)
				placeLoad(element, attribute, routed);
			else element.setAttribute(attribute, routed);
		};
		for (const attribute of ['href', 'xlink:href'])
			domHooksModule.useAttributes(svgScriptHook(attribute), [
				['script', attribute],
				['SCRIPT', attribute],
			]);

		// an SVG reference's `href` is an SVGAnimatedString: its baseVal and
		// animVal read the attribute the page wrote (the hooked getAttribute),
		// setting baseVal writes through the hooked setAttribute, so it routes
		{
			const proxyModule = this.client.getModule(ProxyModule)!;
			const global = this.client.global as unknown as Record<string, any>;
			const owners = new WeakMap<object, Element>();
			for (const name of Object.getOwnPropertyNames(global)) {
				if (!/^SVG\w+Element$/.test(name)) continue;
				const prototype = global[name]?.prototype;
				const descriptor =
					prototype && Reflect.getOwnPropertyDescriptor(prototype, 'href');
				if (!descriptor?.get) continue;
				Reflect.defineProperty(prototype, 'href', {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const value = Reflect.apply(target, that, args);
							if (value && typeof value === 'object') owners.set(value, that);
							return value;
						},
					),
				});
			}
			const animated = global.SVGAnimatedString?.prototype;
			if (animated)
				for (const property of ['baseVal', 'animVal']) {
					const descriptor = Reflect.getOwnPropertyDescriptor(
						animated,
						property,
					);
					if (!descriptor?.get) continue;
					Reflect.defineProperty(animated, property, {
						...descriptor,
						get: proxyModule.wrapFunction(
							descriptor.get,
							(target, that, args) => {
								const owner = owners.get(that);
								if (!owner) return Reflect.apply(target, that, args);
								return (
									owner.getAttribute(
										owner.hasAttribute('href') ? 'href' : 'xlink:href',
									) ?? ''
								);
							},
						),
						set: descriptor.set
							? proxyModule.wrapFunction(
									descriptor.set,
									(target, that, args) => {
										const owner = owners.get(that);
										if (!owner) return Reflect.apply(target, that, args);
										owner.setAttribute('href', String(args[0]));
									},
								)
							: undefined,
					});
				}
		}

		// browsing context names that would leave the frame: a top-level page
		// navigates itself for these, so does a proxied one. `_blank` and
		// names stay native (popups) until a host opts into onOpen
		const selfTargets = ['_top', '_parent', '_unfencedtop'];
		const targetHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (!selfTargets.includes(value.toLowerCase())) return;
			element.setAttributeOG(attribute, value);
			element.setAttribute(attribute, '_self');
		};
		const ogOrFalse = (attribute: string) => (element: CustomElement) =>
			element.getAttributeOG(attribute) ?? false;
		domHooksModule.useAttributes(targetHook('target'), [
			['A', 'target'],
			['AREA', 'target'],
			['FORM', 'target'],
			['BASE', 'target'],
			[HTMLAnchorElement, 'target', ogOrFalse('target')],
			[HTMLAreaElement, 'target', ogOrFalse('target')],
			[HTMLFormElement, 'target', ogOrFalse('target')],
			[HTMLBaseElement, 'target', ogOrFalse('target')],
		]);
		domHooksModule.useAttributes(targetHook('formtarget'), [
			['BUTTON', 'formtarget'],
			['INPUT', 'formtarget'],
			[HTMLButtonElement, 'formTarget', ogOrFalse('formtarget')],
			[HTMLInputElement, 'formTarget', ogOrFalse('formtarget')],
		]);

		// <iframe srcdoc>: the inline document gets the same shell a fetched
		// one gets, with this page as its base
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('srcdoc');
				if (element.hasAttribute('srcdoc')) {
					const source = element.getAttribute('srcdoc')!;
					element.setAttributeOG('srcdoc', source);
					element.setAttribute(
						'srcdoc',
						modifyHTML(source, this.client.url, this.client.config),
					);
				}
			},
			[
				['IFRAME', 'srcdoc'],
				[
					this.client.global.HTMLIFrameElement,
					'srcdoc',
					(element) => element.getAttributeOG('srcdoc') ?? false,
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.getAttribute('href') !== ''
				) {
					element.setAttributeOG('href', element.getAttribute('href')!);
					element.setAttribute(
						'href',
						routeHTML(
							new StompURL(
								new URL(
									element.getAttribute('href')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
							this.client.url,
							this.client.config,
							false,
							this.client.nestedRoute,
						),
					);
				}
			},
			[
				['A', 'href'],
				['a', 'href'],
				['AREA', 'href'],
				[
					this.client.global.HTMLAnchorElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							(element.getAttributeOG('href') ?? element.getAttribute('href'))!,
							this.client.url.toString(),
						).toString(),
				],
				// an image map's areas are links too
				[
					this.client.global.HTMLAreaElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							(element.getAttributeOG('href') ?? element.getAttribute('href'))!,
							this.client.url.toString(),
						).toString(),
				],
			],
			// URL attributes do not mixin with element attributes
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (
					element.hasAttribute('src') &&
					element.getAttribute('src') !== '' &&
					shouldRewriteScript(element)
				) {
					element.setAttributeOG('src', element.getAttribute('src')!);
					placeLoad(
						element,
						'src',
						routeJS(
							new StompURL(
								new URL(
									element.getAttribute('src')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
							this.client.url,
							this.client.config,
							scriptType(element),
						),
					);
				}
			},
			[
				['SCRIPT', 'src'],
				// the route depends on type=module, which pages may set after src
				['SCRIPT', 'type'],
				[
					this.client.global.HTMLScriptElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('integrity');

				if (element.hasAttribute('integrity')) {
					element.setAttributeOG(
						'integrity',
						element.getAttribute('integrity')!,
					);
					element.removeAttribute('integrity');
				}
			},
			[
				['LINK', 'integrity'],
				['SCRIPT', 'integrity'],
				[
					this.client.global.HTMLLinkElement,
					'integrity',
					(element) =>
						element.hasAttribute('integrity') &&
						element.getAttribute('integrity') !== '' &&
						(element.getAttributeOG('integrity') ??
							element.getAttribute('integrity'))!,
				],
				[
					this.client.global.HTMLScriptElement,
					'integrity',
					(element) =>
						element.hasAttribute('integrity') &&
						element.getAttribute('integrity') !== '' &&
						(element.getAttributeOG('integrity') ??
							element.getAttribute('integrity'))!,
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.hasAttribute('rel') &&
					element.getAttribute('href') !== ''
				) {
					// rel is a token list; a preload's route follows `as`
					const rel = new Set(
						element.getAttribute('rel')!.trim().toLowerCase().split(/\s+/),
					);
					const as = (element.getAttribute('as') || '').trim().toLowerCase();
					const resource = new StompURL(
						new URL(element.getAttribute('href')!, this.client.url.toString()),
						this.client.url,
					);
					element.setAttributeOG('href', element.getAttribute('href')!);
					if (rel.has('manifest')) element.removeAttribute('href');
					else if (
						rel.has('stylesheet') ||
						((rel.has('preload') || rel.has('prefetch')) && as === 'style')
					)
						placeLoad(element, 'href', routeCSS(resource, this.client.url));
					else if (rel.has('modulepreload'))
						placeLoad(
							element,
							'href',
							routeJS(
								resource,
								this.client.url,
								this.client.config,
								'genericModule',
							),
						);
					else if (
						(rel.has('preload') || rel.has('prefetch')) &&
						as === 'script'
					)
						placeLoad(
							element,
							'href',
							routeJS(resource, this.client.url, this.client.config, 'generic'),
						);
					else placeLoad(element, 'href', routeBinary(resource));
				}
			},
			[
				['LINK', 'href'],
				['LINK', 'rel'],
				['LINK', 'as'],
				[HTMLLinkElement, 'as', () => false],
				[
					this.client.global.HTMLLinkElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							(element.getAttributeOG('href') ?? element.getAttribute('href'))!,
							this.client.url.toString(),
						).toString(),
				],
				[HTMLLinkElement, 'rel', () => false],
			],
		);

		// todo: mimes...?
		// https://www.w3schools.com/tags/tag_embed.asp

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					const resource = new StompURL(
						new URL(element.getAttribute('src')!, this.client.url.toString()),
						this.client.url,
					);
					const opaque = opaqueDocument(resource);
					if (opaque) this.client.opaqueFrames.add(element);
					else this.client.opaqueFrames.delete(element);
					// the frame navigates for this document, under its activation
					if (!opaque)
						this.client
							.getModule(NavigationHintModule)
							?.hint(resource.url.href);
					element.setAttribute(
						'src',
						opaque ??
							routeHTML(
								resource,
								this.client.url,
								this.client.config,
								false,
								this.client.topOrigin,
							),
					);
				}
			},
			[
				['IFRAME', 'src'],
				['FRAME', 'src'],
				[
					this.client.global.HTMLFrameElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.url.toString(),
						).toString(),
				],
				[
					this.client.global.HTMLIFrameElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('content');

				if (
					element.hasAttribute('content') &&
					element.getAttribute('content') !== ''
				)
					switch (element.getAttribute('http-equiv')?.toLowerCase()) {
						case 'content-security-policy':
							element.setAttributeOG(
								'content',
								element.getAttribute('content')!,
							);
							element.removeAttribute('content');
							break;
						case 'refresh':
							element.setAttributeOG(
								'content',
								element.getAttribute('content')!,
							);
							element.setAttribute(
								'content',
								modifyRefresh(
									element.getAttribute('content')!,
									this.client.url,
									this.client.config,
									this.client.nestedRoute,
								),
							);
							break;
					}
			},
			[
				['META', 'content'],
				['META', 'http-equiv'],
				[
					this.client.global.HTMLMetaElement,
					'content',
					// what the page wrote, for a refresh the hook rewrote; any
					// other content (a token, a payload) is not a URL and reads
					// natively
					(element) => element.getAttributeOG('content') ?? false,
				],
				[this.client.global.HTMLMetaElement, 'httpEquiv', () => false],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					placeLoad(
						element,
						'src',
						routeBinary(
							new StompURL(
								new URL(
									element.getAttribute('src')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
						),
					);
				}
			},
			[
				['IMG', 'src'],
				['INPUT', 'src'],
				[
					this.client.global.HTMLInputElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.url.toString(),
						).toString(),
				],
				[
					this.client.global.HTMLImageElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('srcset');

				if (
					element.hasAttribute('srcset') &&
					element.getAttribute('srcset') !== ''
				) {
					element.setAttributeOG('srcset', element.getAttribute('srcset')!);

					const parsed = parseSrcset(element.getAttribute('srcset')!);
					const updated: { url: string; width?: number; density?: number }[] =
						[];

					for (const src of parsed) {
						updated.push({
							...src,
							url: routeBinary(
								new StompURL(
									new URL(src.url, this.client.url.toString()),
									this.client.url,
								),
							),
						});
					}

					placeLoad(
						element,
						'srcset',
						stringifySrcset(updated),
						updated.map((candidate, index) => ({
							routed: candidate.url,
							page: new URL(parsed[index].url, this.client.url.toString()).href,
						})),
						(copied) =>
							stringifySrcset(
								updated.map((candidate, index) => ({
									...candidate,
									url: copied[index],
								})),
							),
					);
				}
			},
			[
				['IMG', 'srcset'],
				['SOURCE', 'srcset'],
				[
					this.client.global.HTMLImageElement,
					'srcset',
					(element) =>
						element.hasAttribute('srcset') &&
						element.getAttribute('srcset') !== '' &&
						(element.getAttributeOG('srcset') ??
							element.getAttribute('srcset'))!,
				],
				[
					this.client.global.HTMLSourceElement,
					'srcset',
					(element) =>
						element.hasAttribute('srcset') &&
						element.getAttribute('srcset') !== '' &&
						(element.getAttributeOG('srcset') ??
							element.getAttribute('srcset'))!,
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					placeLoad(
						element,
						'src',
						routeBinary(
							new StompURL(
								new URL(
									element.getAttribute('src')!,
									this.client.url.toString(),
								),
								this.client.url,
							),
						),
					);
				}
			},
			[
				['AUDIO', 'src'],
				['VIDEO', 'src'],
				['SOURCE', 'src'],
				['TRACK', 'src'],
				[
					this.client.global.HTMLTrackElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.url.toString(),
						).toString(),
				],
				[
					this.client.global.HTMLMediaElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.url.toString(),
						).toString(),
				],
				[
					this.client.global.HTMLSourceElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.url.toString(),
						).toString(),
				],
			],
		);

		// An element's inline style in a document no service worker controls:
		// once a write settles (the attribute, a CSSOM write), its routes are
		// copied and the copies set underneath the hooks, owned by the element.
		// Set up with the declaration hooks below.
		let copyInlineSoon: (element: Element) => void = () => {};

		domHooksModule.useAttributes(
			(element) => {
				// our rewritten text comes back serialized by the browser when the
				// page assigns it to el.style (Polymer does, from
				// attributeChangedCallback for the attribute we just wrote). Taken
				// as a new value it would flip the attribute between the original
				// and the rewritten text forever, which froze YouTube
				const current = element.getAttribute('style');

				if (current !== null && element.hasAttributeOG('style')) {
					const rewritten = modifyCSS(
						(element.getAttributeOG('style') ?? element.getAttribute('style'))!,
						this.client.url,
						'declarationList',
					);

					if (
						current === rewritten ||
						current === this.serializeStyle(rewritten)
					)
						return;
				}

				element.restoreAttributesOG('style');

				if (
					element.hasAttribute('style') &&
					element.getAttribute('style') !== ''
				) {
					element.setAttributeOG('style', element.getAttribute('style')!);
					element.setAttribute(
						'style',
						modifyCSS(
							(element.getAttributeOG('style') ??
								element.getAttribute('style'))!,
							this.client.url,
							'declarationList',
						),
					);
				}
				copyInlineSoon(element);
			},
			[
				['*', 'style'],
				[HTMLElement, 'style', () => false],
			],
		);

		// CSSStyleDeclaration: element.style.x = ..., setProperty(), cssText
		{
			const styleProto = this.client.global.CSSStyleDeclaration.prototype;
			const proxyModule = this.client.getModule(ProxyModule)!;

			// the element each page-facing declaration belongs to
			const owners = new WeakMap<CSSStyleDeclaration, Element>();
			const pending = new WeakSet<Element>();
			copyInlineSoon = (element) => {
				if (!uncontrolled() || pending.has(element)) return;
				pending.add(element);
				queueMicrotask(() => {
					pending.delete(element);
					const declaration = Reflect.apply(
						this.#nativeStyle.get!,
						element,
						[],
					) as CSSStyleDeclaration;
					copyOwned(
						element,
						'style',
						() => nativeElement.getAttribute.call(element, 'style') ?? '',
						(copied) =>
							hookWrite(
								element,
								() => ['style'],
								() => putCopies(declaration, copied),
							),
					);
				});
			};
			const afterWrite = (declaration: unknown) => {
				const owner = owners.get(declaration as CSSStyleDeclaration);
				if (owner) copyInlineSoon(owner);
			};

			const rewriteValue = (value: unknown) =>
				typeof value === 'string' && value.includes('url(')
					? rewriteCSSValueURLs(value, this.client.url)
					: value;

			const rewriteCssText = (value: unknown) => {
				try {
					return modifyCSS(String(value), this.client.url, 'declarationList');
				} catch (error) {
					return value;
				}
			};

			// Chromium implements the named properties (style.backgroundImage = ...)
			// as per-instance named setters, so the only way to see those writes
			// is to hand the page a Proxy from the `style` getter.
			const declarationProxies = new WeakMap<
				CSSStyleDeclaration,
				CSSStyleDeclaration
			>();

			const wrapDeclaration = (declaration: CSSStyleDeclaration) => {
				if (!declaration || typeof declaration !== 'object') return declaration;

				let proxy = declarationProxies.get(declaration);

				if (!proxy) {
					proxy = new Proxy(declaration, {
						get: (target, key) => {
							const value = Reflect.get(target, key);
							// getPropertyValue reads back the page's URL like the named
							// properties do
							if (key === 'getPropertyValue' && typeof value === 'function')
								return (...args: unknown[]) => {
									const result = Reflect.apply(value, target, args);
									return typeof result === 'string' && result.includes('url(')
										? restoreCSSValueURLs(result)
										: result;
								};
							if (typeof value === 'function') return value.bind(target);
							return typeof value === 'string' && value.includes('url(')
								? restoreCSSValueURLs(value)
								: value;
						},
						set: (target, key, value) => {
							if (typeof key === 'string')
								value =
									key === 'cssText'
										? rewriteCssText(value)
										: rewriteValue(value);
							const done = Reflect.set(target, key, value);
							afterWrite(target);
							return done;
						},
					});

					declarationProxies.set(declaration, proxy);
				}

				return proxy;
			};
			this.wrapDeclaration = wrapDeclaration;

			for (const ctor of [
				this.client.global.HTMLElement,
				this.client.global.SVGElement,
			]) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					ctor.prototype,
					'style',
				);
				if (!descriptor?.get) continue;

				Reflect.defineProperty(ctor.prototype, 'style', {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const declaration = Reflect.apply(target, that, args);
							if (declaration && typeof declaration === 'object')
								owners.set(declaration, that as Element);
							return wrapDeclaration(declaration);
						},
					),
				});
			}

			// computed styles read back the page's URLs too
			this.client.global.getComputedStyle = proxyModule.wrapFunction(
				this.client.global.getComputedStyle,
				(target, that, args) =>
					wrapDeclaration(Reflect.apply(target, that, args)),
			);

			// the Typed OM: values stringify with the page's URLs; what the page
			// parses or sets is routed
			const typed = this.client.global as unknown as Record<string, any>;
			if (typeof typed.CSSStyleValue === 'function') {
				for (const name of ['parse', 'parseAll'])
					if (typeof typed.CSSStyleValue[name] === 'function')
						typed.CSSStyleValue[name] = proxyModule.wrapFunction(
							typed.CSSStyleValue[name],
							(target, that, args) => {
								if (args.length > 1) args[1] = rewriteValue(args[1]);
								return Reflect.apply(target, that, args);
							},
						);
				typed.CSSStyleValue.prototype.toString = proxyModule.wrapFunction(
					typed.CSSStyleValue.prototype.toString,
					(target, that, args) => {
						const value = Reflect.apply(target, that, args);
						return typeof value === 'string' && value.includes('url(')
							? restoreCSSValueURLs(value)
							: value;
					},
				);
			}
			// the element each page-facing attributeStyleMap belongs to: a write
			// there changes its inline style, whose loads are copied in a
			// document no worker controls (and released by a delete or clear)
			const mapOwners = new WeakMap<object, Element>();
			for (const ctor of [
				this.client.global.HTMLElement,
				this.client.global.SVGElement,
			]) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					ctor.prototype,
					'attributeStyleMap',
				);
				if (!descriptor?.get) continue;
				Reflect.defineProperty(ctor.prototype, 'attributeStyleMap', {
					...descriptor,
					get: proxyModule.wrapFunction(
						descriptor.get,
						(target, that, args) => {
							const map = Reflect.apply(target, that, args);
							if (map && typeof map === 'object')
								mapOwners.set(map, that as Element);
							return map;
						},
					),
				});
			}
			if (typeof typed.StylePropertyMap === 'function')
				for (const name of ['set', 'append', 'delete', 'clear'])
					if (typeof typed.StylePropertyMap.prototype[name] === 'function')
						typed.StylePropertyMap.prototype[name] = proxyModule.wrapFunction(
							typed.StylePropertyMap.prototype[name],
							(target, that, args) => {
								if (name === 'set' || name === 'append')
									for (let i = 1; i < args.length; i++)
										args[i] = rewriteValue(args[i]);
								const result = Reflect.apply(target, that, args);
								const owner = mapOwners.get(that);
								if (owner) copyInlineSoon(owner);
								return result;
							},
						);

			styleProto.setProperty = proxyModule.wrapFunction(
				styleProto.setProperty,
				(target, that, args) => {
					if (args.length > 1) args[1] = rewriteValue(args[1]);
					const result = Reflect.apply(target, that, args);
					afterWrite(that);
					return result;
				},
			);

			// newer Chromium moves the named properties (backgroundImage, ...)
			// onto CSSStyleProperties; wrap setters on both prototypes
			const protos = [
				styleProto,
				(
					this.client.global as unknown as {
						CSSStyleProperties?: typeof CSSStyleDeclaration;
					}
				).CSSStyleProperties?.prototype,
			].filter((proto): proto is CSSStyleDeclaration => !!proto);

			for (const proto of protos)
				for (const name of Object.getOwnPropertyNames(proto)) {
					const descriptor = Reflect.getOwnPropertyDescriptor(proto, name)!;
					if (!descriptor.set || !descriptor.configurable) continue;

					const rewrite =
						name === 'cssText'
							? (value: unknown) => {
									try {
										return modifyCSS(
											String(value),
											this.client.url,
											'declarationList',
										);
									} catch (error) {
										return value;
									}
								}
							: rewriteValue;

					Reflect.defineProperty(proto, name, {
						...descriptor,
						set: proxyModule.wrapFunction(
							descriptor.set,
							(target, that, args) => {
								const result = Reflect.apply(target, that, [rewrite(args[0])]);
								afterWrite(that);
								return result;
							},
						),
					});
				}
		}

		// A <style>'s sheet in a document no service worker controls: once its
		// rules are routed (DOMContentHooks), a rule that names routes is put
		// back with their copies (through the CSSOM: its text, and the page's
		// observers, see nothing), `mark` telling the CSSOM pass it is done.
		// The copies are the element's.
		// the rules' own text and methods, before the readback and CSSOM
		// modules (which apply later) wrap them
		const ruleText = Reflect.getOwnPropertyDescriptor(
			this.client.global.CSSRule.prototype,
			'cssText',
		)!.get!;
		const nativeRules = {
			sheet: {
				insert: this.client.global.CSSStyleSheet.prototype.insertRule,
				delete: this.client.global.CSSStyleSheet.prototype.deleteRule,
			},
			group: {
				insert: this.client.global.CSSGroupingRule.prototype.insertRule,
				delete: this.client.global.CSSGroupingRule.prototype.deleteRule,
			},
		};
		const textOf = (rule: CSSRule) =>
			Reflect.apply(ruleText, rule, []) as string;
		// a style rule's own declarations, not the page-facing view the
		// readback module (which applies later) hands out: the native
		// methods putCopies calls refuse that view
		const ruleStyle = Reflect.getOwnPropertyDescriptor(
			this.client.global.CSSStyleRule.prototype,
			'style',
		)!.get!;
		const sheetText = (sheet: CSSStyleSheet | null | undefined) => {
			try {
				return [...(sheet?.cssRules ?? [])].map(textOf).join('\n');
			} catch (error) {
				return '';
			}
		};
		/** every rule of `container` that names routes, given their copies */
		const putBack = (
			container: CSSStyleSheet | CSSGroupingRule,
			copied: Map<string, string>,
			mark: (rule: CSSRule) => void,
		) => {
			const methods =
				container instanceof this.client.global.CSSStyleSheet
					? nativeRules.sheet
					: nativeRules.group;
			const rules = container.cssRules;
			for (let i = 0; i < rules.length; i++) {
				const rule = rules[i];
				if (!routesIn(textOf(rule)).length) continue;
				// a style rule keeps its identity: its own declarations take the
				// copies (as an inline style does), its nested rules are entered
				if ('selectorText' in rule) {
					putCopies(
						Reflect.apply(ruleStyle, rule, []) as CSSStyleDeclaration,
						copied,
					);
					if ('cssRules' in rule)
						putBack(rule as unknown as CSSGroupingRule, copied, mark);
					continue;
				}
				// a grouping rule (@media, @supports, @layer) is entered
				if ('cssRules' in rule && !('styleSheet' in rule)) {
					putBack(rule as CSSGroupingRule, copied, mark);
					continue;
				}
				// @import and @font-face have no declarations to edit: put back
				// whole
				const text = withCopies(textOf(rule), copied);
				try {
					Reflect.apply(methods.delete, container, [i]);
					Reflect.apply(methods.insert, container, [text, i]);
					mark(container.cssRules[i]);
				} catch (error) {
					// a rule the browser will not take back: it keeps its route
				}
			}
		};
		this.copySheet = (style, mark) =>
			copyOwned(
				style,
				'sheet',
				() => sheetText(style.sheet),
				(copied) => {
					if (style.sheet) putBack(style.sheet, copied, mark);
				},
			);
		// A constructed sheet a document no service worker controls made
		// (replace, replaceSync, insertRule, deleteRule): the same, the copies
		// the sheet's own. A sheet a <link> or <style> owns, or an @import's,
		// has its loads copied with its owner.
		const ownerNode = Reflect.getOwnPropertyDescriptor(
			this.client.global.StyleSheet.prototype,
			'ownerNode',
		)!.get!;
		const ownerRule = Reflect.getOwnPropertyDescriptor(
			this.client.global.CSSStyleSheet.prototype,
			'ownerRule',
		)!.get!;
		this.copyConstructed = (sheet) => {
			try {
				if (
					Reflect.apply(ownerNode, sheet, []) !== null ||
					Reflect.apply(ownerRule, sheet, []) !== null
				)
					return;
			} catch (error) {
				return;
			}
			copyOwned(
				sheet,
				'rules',
				() => sheetText(sheet),
				(copied) => putBack(sheet, copied, () => {}),
			);
		};

		// The elements the parser made from markup the page wrote into a
		// document no service worker controls: each load the rewrite left with
		// only its marker (see placeLoad) gets the page's value back and its
		// hooks run on the element itself, which makes its copy. Underneath the
		// hooks, so the page's observers see nothing. A script is not one: it
		// got its copy during the write, or (the transport in the page) does
		// not run.
		const nativeQueryAll =
			this.client.global.Document.prototype.querySelectorAll;
		const LOADS = [
			...['src', 'href', 'xlink:href', 'srcset', 'poster', 'data'],
			'imagesrcset',
		];
		const written = LOADS.map((name) => name.replace(':', '\\:'))
			.map((name) => `[s_o\\:${name}]:not([${name}]):not(script)`)
			.join(',');
		this.client.writtenLoads = (document) => {
			if (!uncontrolled()) return;
			let elements: Element[];
			try {
				elements = [
					...(Reflect.apply(nativeQueryAll, document, [
						written,
					]) as NodeListOf<Element>),
				];
			} catch (error) {
				return;
			}
			for (const element of elements)
				usePrototype(element, CustomElement.prototype, (element) => {
					for (const name of LOADS) {
						const page = element.getAttributeOG(name);
						if (page === null || element.hasAttribute(name)) continue;
						element.setAttribute(name, page);
						domHooksModule.updateAttributeHooks(element, name);
					}
				});
		};

		const validMethods = ['GET', 'POST'];

		this.formHook = (element) => {
			element.restoreAttributesOG('action');

			// this hook always sets a routed 'action', so on later runs (e.g. the
			// method changing) the attribute may hold our own value rather than
			// the page's; only record it as the original when it isn't ours
			const current = element.getAttribute('action');
			const routedPrefix = `${this.client.directory}html`;

			if (
				element.hasAttribute('action') &&
				current !== '' &&
				!current!.startsWith(routedPrefix)
			) {
				element.setAttributeOG('action', current!);
			}

			// a form without an action (or an empty one) submits to the document's
			// own address, which is already a route; the page reads it back
			// without an action, as it wrote it (a routed one would hand the page
			// the proxy's address, which it might route again)
			if (!element.hasAttributeOG('action')) return;

			/**
			 * Absolute URL
			 */
			const action = new URL(
				(element.getAttributeOG('action') ?? element.getAttribute('action'))!,
				this.client.url.toString(),
			).toString();

			const methodIndex = validMethods.indexOf(
				element.getAttribute('method')?.toUpperCase() || '',
			);
			const method = validMethods[methodIndex === -1 ? 0 : methodIndex];

			switch (method) {
				case 'GET':
					element.setAttribute(
						'action',
						routeHTML(
							new StompURL(action, this.client.url),
							this.client.url,
							this.client.config,
							true,
							this.client.nestedRoute,
						),
					);
					break;
				case 'POST':
					element.setAttribute(
						'action',
						routeHTML(
							new StompURL(action, this.client.url),
							this.client.url,
							this.client.config,
							false,
							this.client.nestedRoute,
						),
					);

					break;
			}
		};

		/** the page's absolute URL for a routed URL attribute, or false without one */
		const originalURL = (attribute: string) => (element: CustomElement) =>
			element.hasAttribute(attribute) &&
			element.getAttribute(attribute) !== '' &&
			new URL(
				(element.getAttributeOG(attribute) ?? element.getAttribute(attribute))!,
				this.client.url.toString(),
			).toString();

		/** route one URL attribute, keeping the page's value as the original */
		const routeAttribute =
			(
				attribute: string,
				route: (resource: StompURL) => string,
				// a load (an image, media): copied in a document no worker controls
				load = false,
			) =>
			(element: CustomElement) => {
				element.restoreAttributesOG(attribute);
				if (
					element.hasAttribute(attribute) &&
					element.getAttribute(attribute) !== ''
				) {
					element.setAttributeOG(attribute, element.getAttribute(attribute)!);
					const value = route(
						new StompURL(
							new URL(
								element.getAttribute(attribute)!,
								this.client.url.toString(),
							),
							this.client.url,
						),
					);
					if (load) placeLoad(element, attribute, value);
					else element.setAttribute(attribute, value);
				}
			};

		// <object data> and <embed src>: Chrome never routes their loads through
		// a service worker, so a routed URL would reach the proxy origin's own
		// server. The inject fetches the resource through the proxy instead and
		// hands the element a blob: URL of it: HTML wrapped in the shell (as a
		// blob document, its real URL as base), anything else as it came. The
		// element loads nothing until then; a later value wins over a load
		// still in flight, and a failed fetch falls back to the routed URL.
		// The attribute and the property read back as the page wrote them.
		// per element: the URL the page wrote, the load for it, and the blob:
		// URL once it is in. A hook that runs again for the same value (the
		// insertion hooks re-run every attribute hook) keeps the load and its
		// blob instead of starting over, which would reset a document the
		// element is already showing
		const loads = new WeakMap<
			Element,
			{ written: string; generation: number; url?: string }
		>();
		let generations = 0;
		const proxiedLoad = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (
				!element.hasAttribute(attribute) ||
				element.getAttribute(attribute) === ''
			)
				return;
			const written = element.getAttribute(attribute)!;
			element.setAttributeOG(attribute, written);
			const resource = new StompURL(
				new URL(written, this.client.url.toString()),
				this.client.url,
			);
			const routed = routeHTML(
				resource,
				this.client.url,
				this.client.config,
				false,
				this.client.topOrigin,
			);
			if (!ROUTE_PROTOCOLS.includes(resource.url.protocol)) {
				// data:, blob: and the like: as routeHTML leaves them
				element.setAttribute(attribute, routed);
				return;
			}
			const current = loads.get(element);
			if (current?.written === resource.url.href) {
				if (current.url) element.setAttribute(attribute, current.url);
				else element.removeAttribute(attribute);
				return;
			}
			const generation = ++generations;
			const state: { written: string; generation: number; url?: string } = {
				written: resource.url.href,
				generation,
			};
			loads.set(element, state);
			// no URL at all until the proxied copy is in (an empty one makes an
			// object show its fallback and not load again)
			element.removeAttribute(attribute);
			const settle = (value: string) => {
				if (loads.get(element) !== state) return;
				state.url = value;
				usePrototype(element, CustomElement.prototype, (element) =>
					element.setAttribute(attribute, value),
				);
			};
			this.client
				.routedFetch(routeXHR(resource))
				.then(async (response) => {
					if (!response.ok && response.status !== 0)
						throw new Error(String(response.status));
					const type = response.headers.get('content-type') ?? '';
					const blob = /^\s*(text\/html|application\/xhtml\+xml)/i.test(type)
						? new NativeBlob(
								[
									modifyHTML(
										await response.text(),
										resource,
										this.client.config,
										true,
									),
								],
								{ type: 'text/html' },
							)
						: await response.blob();
					if (loads.get(element) !== state) return;
					if (current?.url?.startsWith('blob:'))
						this.client.global.URL.revokeObjectURL(current.url);
					settle(proxyBlobURL(this.client.global.URL.createObjectURL(blob)));
				})
				.catch(() => settle(routed));
		};
		// the property reads the page's URL from the original alone: the real
		// attribute is absent while the proxied copy loads, then a blob: URL
		const writtenURL = (attribute: string) => (element: CustomElement) => {
			const written = element.getAttributeOG(attribute);
			return written !== null && written !== ''
				? new URL(written, this.client.url.toString()).toString()
				: false;
		};
		domHooksModule.useAttributes(proxiedLoad('data'), [
			['OBJECT', 'data'],
			[this.client.global.HTMLObjectElement, 'data', writtenURL('data')],
		]);
		domHooksModule.useAttributes(proxiedLoad('src'), [
			['EMBED', 'src'],
			[this.client.global.HTMLEmbedElement, 'src', writtenURL('src')],
		]);

		// <a ping>, <area ping>: a list of URLs the browser posts to when the
		// link is followed. Each is routed, or the ping would reach the site
		// past the proxy (and name the proxy's URLs in Ping-From / Ping-To);
		// one that does not parse is dropped, as the browser drops it
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('ping');
				if (
					element.hasAttribute('ping') &&
					element.getAttribute('ping')!.trim() !== ''
				) {
					const written = element.getAttribute('ping')!;
					element.setAttributeOG('ping', written);
					const routed: string[] = [];
					for (const token of written.split(/[\t\n\f\r ]+/)) {
						if (!token) continue;
						try {
							routed.push(
								routeXHR(
									new StompURL(
										new URL(token, this.client.url.toString()),
										this.client.url,
									),
								),
							);
						} catch (error) {
							// not a URL
						}
					}
					element.setAttribute('ping', routed.join(' '));
				}
			},
			[
				['A', 'ping'],
				['AREA', 'ping'],
				[
					this.client.global.HTMLAnchorElement,
					'ping',
					(element) => element.getAttributeOG('ping') ?? false,
				],
				[
					this.client.global.HTMLAreaElement,
					'ping',
					(element) => element.getAttributeOG('ping') ?? false,
				],
			],
		);

		// <video poster>
		domHooksModule.useAttributes(routeAttribute('poster', routeBinary, true), [
			['VIDEO', 'poster'],
			[HTMLVideoElement, 'poster', originalURL('poster')],
		]);

		// <button formaction>, <input formaction>: the form's method decides how
		// the query travels, as for <form action>
		domHooksModule.useAttributes(
			routeAttribute('formaction', (resource) =>
				routeHTML(
					resource,
					this.client.url,
					this.client.config,
					true,
					this.client.nestedRoute,
				),
			),
			[
				['BUTTON', 'formaction'],
				['INPUT', 'formaction'],
				[HTMLButtonElement, 'formAction', originalURL('formaction')],
				[HTMLInputElement, 'formAction', originalURL('formaction')],
			],
		);

		// <link imagesrcset>: a preload's candidates, like <img srcset>
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('imagesrcset');
				if (
					element.hasAttribute('imagesrcset') &&
					element.getAttribute('imagesrcset') !== ''
				) {
					element.setAttributeOG(
						'imagesrcset',
						element.getAttribute('imagesrcset')!,
					);
					element.setAttribute(
						'imagesrcset',
						stringifySrcset(
							parseSrcset(element.getAttribute('imagesrcset')!).map((src) => ({
								...src,
								url: routeBinary(
									new StompURL(
										new URL(src.url, this.client.url.toString()),
										this.client.url,
									),
								),
							})),
						),
					);
				}
			},
			[
				['LINK', 'imagesrcset'],
				[
					this.client.global.HTMLLinkElement,
					'imageSrcset',
					(element) =>
						element.hasAttribute('imagesrcset') &&
						element.getAttribute('imagesrcset') !== '' &&
						(element.getAttributeOG('imagesrcset') ??
							element.getAttribute('imagesrcset'))!,
				],
			],
		);

		// a child frame's sandbox (an opaque origin), csp or credentialless
		// attribute would put its document outside what the service worker can
		// serve or rewrite: dropped, read back as written. Setting the
		// property (`iframe.sandbox = x` writes through its token list, which
		// no attribute hook sees) drops it at once too, so it is not dropped
		// later on insertion, behind attributes the page set after it. Not
		// `csp`: the property hook applies a string property's value again,
		// which would bring the attribute back
		const iframePrototype = this.client.global.HTMLIFrameElement.prototype;
		for (const [attribute, property] of [
			['sandbox', 'sandbox'],
			['csp', ''],
			['credentialless', 'credentialless'],
		])
			domHooksModule.useAttributes(
				(element) => {
					element.restoreAttributesOG(attribute);
					if (element.hasAttribute(attribute)) {
						element.setAttributeOG(attribute, element.getAttribute(attribute)!);
						element.removeAttribute(attribute);
					}
				},
				[
					['IFRAME', attribute],
					...(property &&
					Reflect.getOwnPropertyDescriptor(iframePrototype, property)?.set
						? [
								[
									this.client.global.HTMLIFrameElement,
									property,
									() => false,
								] as [typeof HTMLIFrameElement, string, () => false],
							]
						: []),
				],
			);

		domHooksModule.useAttributes(this.formHook, [
			['FORM', 'action'],
			['FORM', 'method'],
			[
				this.client.global.HTMLFormElement,
				'action',
				(element) =>
					element.hasAttribute('action') &&
					element.getAttribute('action') !== '' &&
					new URL(
						(element.getAttributeOG('action') ??
							element.getAttribute('action'))!,
						this.client.url.toString(),
					).toString(),
			],
			[HTMLFormElement, 'method', () => false],
		]);

		// a base's href resolves against the document's URL, not against the
		// base URL (which client.url follows once a base is in place, and is
		// the page's own base while loadHTML rewrites the markup)
		const documentURL = () => {
			const location = this.client.location;
			return ROUTE_PROTOCOLS.includes(location.url.protocol)
				? location
				: this.client.url;
		};
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.getAttribute('href') !== ''
				) {
					const document = documentURL();
					element.setAttributeOG('href', element.getAttribute('href')!);
					element.setAttribute(
						'href',
						routeHTML(
							new StompURL(
								new URL(element.getAttribute('href')!, document.toString()),
								document,
							),
							document,
							this.client.config,
							false,
							this.client.nestedRoute,
						),
					);
				}
			},
			[
				['BASE', 'href'],
				[
					this.client.global.HTMLBaseElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							(element.getAttributeOG('href') ?? element.getAttribute('href'))!,
							documentURL().toString(),
						).toString(),
				],
			],
		);
	}
}
