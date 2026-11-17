import { parseSrcset, stringifySrcset } from 'srcset';
import {
	restoreCSSValueURLs,
	rewriteCSSValueURLs,
	routeCSS,
} from '../../../cssURLs';
import { handlerMark, keepSource, sourceKey } from '../../../functionSource';
import {
	isXMLDocumentMime,
	modifyHTML,
	modifyRefresh,
	routeHTML,
} from '../../../rewriteHTML';
import {
	parseDataURI,
	proxyBlobURL,
	ROUTE_PROTOCOLS,
	routeBinary,
	routeImageSet,
	routeXHR,
} from '../../../routeURL';
import { routeJS, ScriptType } from '../../../scriptRoutes';
import { parseAcceptCH } from '../../../server/hintNames';
import {
	dataURLBytes,
	INTEGRITY_MARK,
	integrityHoldsSync,
	markIntegrity,
	NO_INTEGRITY,
	REFUSED_FRAGMENT,
} from '../../../sri';
import StompURL from '../../../StompURL';
import {
	LOAD_HEADER,
	OPAQUE_COPY_HEADER,
	SEALER_ROUTE,
} from '../../../transport/messages';
import { dataBody, unresolvable } from '../../../urlShape';
import Module from '../../Module';
import { opaqueCopy, opaqueMarked } from '../../modules/Fetch';
import MixedContentModule from '../../modules/MixedContent';
import ProxyModule, { usePrototype } from '../../modules/Proxy';
import {
	computedURL,
	scopePrefix,
	unrouteCSS,
	unrouteURL,
} from '../../modules/Unroute';
import { LazyMap, LazyWeakMap, LazyWeakSet } from '../../ownCollections';
import { modifyCSS, modifyJS } from '../../rewriter';
import { blobLoads, opaqueCopies } from '../blobLoads';
import DocumentClient, {
	addDocumentOpenListener,
	type StyleElement,
} from '../Client';
import { inertDocumentOf } from '../cloneNode';
import { ELEMENT_STYLE_INTERFACES } from '../cssRules';
import { deferred } from '../deferred';
import { forgetDestination, frameWindow } from '../freshContext';
import { loadFetch, loadSource } from '../loadGrants';
import { responseURLOf } from '../responseDocuments';
import { guardDocument, realSandbox, sandboxTokens } from '../sandbox';
import { sealedURL } from '../sealedCopies';
import { siteWindows } from '../siteWindows';
import { SVG_HREF_INTERFACES } from '../svgReferences';
import DOMHooksModule, {
	appliedAttribute,
	CustomElement,
	nativeElement,
	pendingAttributes,
} from './DOMHooks';
import { hiddenMutation, hookWrite, MARKER } from './MutationObserver';
import NavigationHintModule from './NavigationHint';
import TokenListsModule from './TokenLists';

/**
 * A frame element's container policy as its allow attribute says it, with
 * `allowfullscreen` read as `fullscreen *` where the attribute does not name
 * the feature, as Chrome reads it (empty: neither attribute)
 */
function containerPolicy(element: CustomElement): string {
	// as the page wrote it (the site pool may give the browser another)
	const allow = element.hasAttributeOG('allow')
		? element.getAttributeOG('allow')
		: element.getAttribute('allow');
	if (!element.hasAttribute('allowfullscreen')) return allow ?? '';
	if (allow !== null && /(?:^|;)\s*fullscreen(?:\s|;|$)/i.test(allow))
		return allow;
	return allow ? `${allow}; fullscreen *` : 'fullscreen *';
}

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
/** the name of `element`'s xlink:href, whatever its prefix (x:href), else xlink:href */
const xlinkName = (element: Element): string =>
	(
		Reflect.apply(nativeElement.getAttributeNodeNS, element, [
			XLINK_NAMESPACE,
			'href',
		]) as Attr | null
	)?.name ?? 'xlink:href';

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
	copySheet?: (style: StyleElement, mark: (rule: CSSRule) => void) => void;
	/** @internal copy the routed loads of a sheet whose rules the CSSOM changed, in a document no service worker controls (CSSOM) */
	copyRules?: (sheet: CSSStyleSheet) => void;
	/** @internal copy the routed loads of an element's style that came into a document no service worker controls (DOMContentHooks) */
	copyInline?: (element: Element) => void;
	/** @internal the page's view of a CSSStyleDeclaration: reads unrouted, writes routed (CSSReadback) */
	wrapDeclaration?: (declaration: CSSStyleDeclaration) => CSSStyleDeclaration;
	// captured before the hooks replace them, for serializeStyle
	#nativeStyle: PropertyDescriptor;
	#nativeCssText: PropertyDescriptor;
	// each kind of element that has a declaration has its own getter, which
	// throws "Illegal invocation" on any other kind
	#nativeStyleGetters: (() => CSSStyleDeclaration)[];
	#scratch?: HTMLElement;
	constructor(client: DocumentClient) {
		super(client);
		this.#nativeStyle = Reflect.getOwnPropertyDescriptor(
			client.global.HTMLElement.prototype,
			'style',
		)!;
		this.#nativeStyleGetters = [
			client.global.HTMLElement,
			client.global.SVGElement,
			(client.global as { MathMLElement?: typeof Element }).MathMLElement,
		].flatMap((ctor) => {
			const get = ctor
				? Reflect.getOwnPropertyDescriptor(ctor.prototype, 'style')?.get
				: undefined;
			return get ? [get] : [];
		});
		this.#nativeCssText = Reflect.getOwnPropertyDescriptor(
			client.global.CSSStyleDeclaration.prototype,
			'cssText',
		)!;
	}
	/** an element's own declaration, null for a kind that has none */
	#nativeDeclaration(element: Element): CSSStyleDeclaration | null {
		for (const get of this.#nativeStyleGetters)
			try {
				return Reflect.apply(get, element, []);
			} catch (error) {
				// another kind of element
			}
		return null;
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
		const moduleClient = this.client;
		const realm = moduleClient.global;
		// (the realm's own, as the page may replace it)
		const NativeBlob = realm.Blob;

		// A document no service worker controls (an about:blank frame or popup
		// the page built, a document it opened, or a blob: document: Chrome
		// hands none to the page's worker, and an <object>'s HTML document is
		// a blob: copy, since Chrome sends no object load through a worker)
		// loads its elements from the proxy origin's own server,
		// where a route means nothing. Its loads are fetched through the proxy
		// instead (routedFetch, from the nearest controlled ancestor) and the
		// element gets a blob: URL of the copy, written underneath the hooks:
		// the attribute, the property and the markup read back as the page
		// wrote them, currentSrc as the URL the copy came from.
		// (an about:srcdoc document has its parent's worker, so one under such
		// a document has none either)
		const uncontrolled = () =>
			!moduleClient.controlled &&
			(moduleClient.opened ||
				realm.location.href === 'about:blank' ||
				realm.location.href === 'about:srcdoc' ||
				realm.location.protocol === 'blob:');
		this.uncontrolled = uncontrolled;
		// the proxy origin from the base URL: an about:blank document's own
		// origin reads "null"
		const isRoute = (value: string) => {
			const prefix = scopePrefix(moduleClient);
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
		const createObjectURL = realm.URL.createObjectURL;
		const revokeObjectURL = realm.URL.revokeObjectURL;
		/**
		 * One value's copies: the routed value, what was set, the blobs made.
		 * `kept` are the images that hold a sealed copy's cache entry
		 * (sealedCopies.ts), `sound` whether every one of them loaded, `live`
		 * the copies of another origin's scripts and stylesheets, whose URLs
		 * are revoked as soon as their loads have them (endLive)
		 */
		type Copy = {
			routed: string;
			url?: string;
			made: string[];
			kept?: object[];
			sound?: boolean;
			live?: string[];
			retried?: boolean;
		};
		const createElement = realm.Document.prototype.createElement;
		const isConnected = Reflect.getOwnPropertyDescriptor(
			realm.Node.prototype,
			'isConnected',
		)!.get!;
		/** an image the inject keeps, loading `url` in this document; whether it loaded */
		const keep = (url: string, state: Copy): Promise<boolean> =>
			new Promise((resolve) => {
				try {
					const keeper = Reflect.apply(createElement, realm.document, [
						'img',
					]) as HTMLImageElement;
					for (const type of ['load', 'error'])
						nativeElement.addEventListener.call(
							keeper,
							type,
							() => resolve(type === 'load'),
							{ once: true },
						);
					nativeElement.setAttribute.call(keeper, 'src', url);
					(state.kept ??= []).push(keeper);
				} catch (error) {
					resolve(false);
				}
			});
		/**
		 * The URL of a copy the page may not read (another origin's no-cors
		 * load), which is to be shown as an image: one nothing can fetch,
		 * answered from the memory cache an image the inject keeps holds
		 * (sealedCopies.ts). Bytes that are no image name nothing at all, as
		 * the load fails natively. Without a worker to make it in, the URL is
		 * this realm's: revoked at once when the bytes are no image.
		 */
		const sealed = async (
			body: Blob,
			state: Copy,
			fragments: string[],
		): Promise<string> => {
			let primed = false;
			// the memory cache keeps a blob: URL's fragment in its key: one
			// kept image for each form the value names the copy by
			const dead = await sealedURL(
				body,
				async (url) => {
					primed = (
						await Promise.all(
							(fragments.length ? fragments : ['']).map((fragment) =>
								keep(url + fragment, state),
							),
						)
					).every((loaded) => loaded);
					return true;
				},
				`${new URL(scopePrefix(moduleClient)).origin}${moduleClient.directory}${SEALER_ROUTE}`,
				{
					worker: moduleClient.browserRefuses('worker-src', 'blob:'),
					fetch: moduleClient.browserRefuses('connect-src', 'blob:'),
				},
			);
			if (dead !== null) {
				if (state.sound !== false) state.sound = primed;
				return dead;
			}
			const url = proxyBlobURL(
				Reflect.apply(createObjectURL, realm.URL, [body]) as string,
			);
			if (!(await keep(url, state)))
				Reflect.apply(revokeObjectURL, realm.URL, [url]);
			return url;
		};
		/**
		 * The copies of another origin's scripts and stylesheets a value shows
		 * (`state.live`) are let go as soon as their loads have them: a load
		 * resolves its blob: URL when it starts, so the URL of `placed`, set
		 * on an element in the document, is revoked at once (measured in
		 * plain Chrome 152 and 156 for classic, async, deferred and module
		 * scripts and for stylesheets, forty at a time); the rest (an element
		 * not in the document yet, the imports of a stylesheet) when `owner`
		 * has loaded or failed, or after half a minute.
		 */
		const endLive = (owner: object, state: Copy, placed?: string) => {
			let live = state.live;
			if (!live?.length) return;
			state.live = undefined;
			const revoke = (urls: string[]) => {
				for (const url of urls)
					Reflect.apply(revokeObjectURL, realm.URL, [url]);
			};
			if (
				placed !== undefined &&
				live.includes(placed) &&
				Reflect.apply(isConnected, owner, [])
			) {
				revoke([placed]);
				live = live.filter((url) => url !== placed);
				if (!live.length) return;
			}
			let ended = false;
			const end = () => {
				if (ended) return;
				ended = true;
				revoke(live);
			};
			try {
				for (const type of ['load', 'error'])
					nativeElement.addEventListener.call(owner as Element, type, end, {
						once: true,
					});
			} catch (error) {
				// no element (a constructed sheet): the timer alone
			}
			setTimeout(end, 30_000);
		};
		const copies = new LazyWeakMap<object, Map<string, Copy>>();
		// a route inside a url(): the worker's rewritten CSS writes them whole,
		// then the marker that keeps the page's token
		const routePattern = () => {
			const escaped = scopePrefix(moduleClient).replace(
				/[.*+?^${}()|[\]\\]/g,
				'\\$&',
			);
			return new RegExp(`(url\\(\\s*["']?)(${escaped}[^"'\\s)#]*)`, 'g');
		};
		/**
		 * What the url() that starts at `index` of `text` names, as the
		 * browser's tokenizer reads it: quoted or not, its escapes undone
		 * (CSS Syntax, consume a url token and consume an escaped code point).
		 * Null when it does not end.
		 */
		const cssURLAt = (text: string, index: number): string | null => {
			let at = index + 4;
			while (/\s/.test(text[at] ?? '')) at++;
			const quote = text[at] === '"' || text[at] === "'" ? text[at++] : '';
			let named = '';
			for (; at < text.length; at++) {
				const char = text[at];
				if (quote ? char === quote : char === ')' || /\s/.test(char))
					return named;
				if (char !== '\\') {
					named += char;
					continue;
				}
				const hex = /^[0-9a-f]{1,6}/i.exec(text.slice(at + 1, at + 7))?.[0];
				if (hex) {
					named += String.fromCodePoint(parseInt(hex, 16) || 0xfffd);
					at += hex.length;
					if (/\s/.test(text[at + 1] ?? '')) at++;
				} else if (at + 1 < text.length) named += text[++at];
			}
			return null;
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
			// each route as the load where it first appears, and what follows
			// it in each url() that names it (the marker that keeps the page's
			// token): the copy's URL is named with the same
			const kinds = new Map<string, string>();
			const fragments = new Map<string, Set<string>>();
			for (const match of text.matchAll(routePattern())) {
				const target = match[2];
				if (!kinds.has(target))
					kinds.set(target, cssLoadKind(text, match.index ?? 0, target));
				const named = cssURLAt(text, match.index ?? 0);
				if (!fragments.has(target)) fragments.set(target, new Set());
				if (named?.startsWith(target))
					fragments.get(target)!.add(named.slice(target.length));
			}
			await Promise.allSettled(
				routesIn(text).map(async (target) =>
					copied.set(
						target,
						await copyOf(
							target,
							unrouteURL(moduleClient, target) ?? target,
							state,
							depth,
							kinds.get(target) ?? null,
							[...(fragments.get(target) ?? [])],
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
		const passes = new LazyWeakMap<object, Map<string, number>>();
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
				if (previous) {
					for (const url of previous.made.splice(0))
						if (shown.has(url)) state.made.push(url);
						else {
							blobLoads.delete(url);
							opaqueCopies.delete(url);
							Reflect.apply(revokeObjectURL, realm.URL, [url]);
						}
					// the images that hold the copies still shown stay with them
					if (previous.kept?.length && state.made.length)
						(state.kept ??= []).push(...previous.kept);
					previous.kept = undefined;
				}
				perOwner.set(key, state);
				endLive(owner, state);
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
		const declarationProto = realm.CSSStyleDeclaration.prototype;
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
					.slice(moduleClient.directory.length)
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
			fragments: string[] | null = null,
		): Promise<string> => {
			// an SVG reference's fragment names the element in the copy
			const hash = routed.indexOf('#');
			const fragment = hash === -1 ? '' : routed.slice(hash);
			const response = await loadFetch(
				moduleClient,
				new URL(
					hash === -1 ? routed : routed.slice(0, hash),
					scopePrefix(moduleClient),
				).href,
				// the copy stands for the element's load, never a page's read
				// (a load the worker takes no metadata from is `copy`)
				load ?? 'copy',
				{ credentials: 'include' },
			);
			if (!response.ok && response.status !== 0)
				throw new Error(String(response.status));
			const type = response.headers.get('content-type') ?? '';
			const body = /^\s*text\/css/i.test(type)
				? new NativeBlob([await copyCSS(await response.text(), state, depth)], {
						type,
					})
				: await response.blob();
			// a copy the page may not read is kept out of its reach: an image's
			// URL is sealed, a script's or stylesheet's revoked once its load
			// has it (a video's or sound's must stay: its loads go on)
			const opaque = opaqueCopy(response);
			const kind = load === null ? null : load.split(' ')[0];
			let url: string;
			if (opaque && (kind === 'image' || kind === null))
				url = await sealed(
					body,
					state,
					fragments ?? (fragment ? [fragment] : []),
				);
			else {
				url = proxyBlobURL(
					Reflect.apply(createObjectURL, realm.URL, [body]) as string,
				);
				if (opaque && (kind === 'script' || kind === 'style'))
					(state.live ??= []).push(url);
			}
			state.made.push(url);
			blobLoads.set(url, page);
			if (opaqueMarked(response)) opaqueCopies.add(url);
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
			if (!moduleClient.workerTransport) return null;
			// the bridge of the client the grant is announced through (it may
			// be of another bundle): its beacon is the request the worker sees
			const from = loadSource();
			const sync = (from?.client as DocumentClient | undefined)?.syncBridge;
			if (!from || !sync) return null;
			try {
				const target = new URL(routed, scopePrefix(moduleClient)).href;
				const token = from.announce(target, load ?? 'copy');
				if (token === null) return null;
				const response = sync.fetch(
					target,
					{
						credentials: 'include',
						// a Headers: the bridge passes on no other kind
						headers: new Headers({ [LOAD_HEADER]: token }),
					},
					false,
					5000,
				);
				if (!response.ok) return null;
				const url = proxyBlobURL(
					Reflect.apply(createObjectURL, realm.URL, [
						new NativeBlob([response.rawArrayBuffer], {
							type: response.headers.get('content-type') ?? 'text/javascript',
						}),
					]) as string,
				);
				state.made.push(url);
				blobLoads.set(url, page);
				if (response.headers.get(OPAQUE_COPY_HEADER) === 'opaque')
					(state.live ??= []).push(url);
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
				opaqueCopies.delete(url);
				Reflect.apply(revokeObjectURL, realm.URL, [url]);
			}
			state.kept = undefined;
			state.live = undefined;
		};
		const stopImmediate = realm.Event.prototype.stopImmediatePropagation;
		const nativeQuery = realm.Document.prototype.querySelector;
		/**
		 * A script the page wrote got its copy during the write (syncCopyOf),
		 * in the markup: the element the parser makes from it loads the URL.
		 * A copy the page may not read is revoked once that element is in the
		 * document (its load has the URL by then), looked for after the write
		 * and a few times more (a parser held up by an earlier script).
		 */
		const endWritten = (state: Copy, url: string) => {
			if (!state.live?.includes(url)) return;
			state.live = state.live.filter((live) => live !== url);
			const revoke = () => Reflect.apply(revokeObjectURL, realm.URL, [url]);
			const waits = [0, 50, 250, 1000, 5000, 24_000];
			const look = () => {
				let found: Element | null = null;
				try {
					found = Reflect.apply(nativeQuery, realm.document, [
						`script[src="${url}"],script[href="${url}"]`,
					]) as Element | null;
				} catch (error) {
					// a document that is gone
				}
				const wait = waits.shift();
				if (found || wait === undefined) revoke();
				else setTimeout(look, wait);
			};
			setTimeout(look, 0);
		};
		// async=false scripts run in the order they were added (the browser's
		// list of scripts that execute in order follows when each gets its
		// src): a copy is applied once every earlier one of its document's is
		const scriptAsync = Reflect.getOwnPropertyDescriptor(
			realm.HTMLScriptElement.prototype,
			'async',
		)?.get;
		const inOrder = new LazyWeakMap<
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
		 * A script's or a stylesheet's route with the integrity the page gave
		 * its element: the worker checks the origin's bytes against it, the
		 * element itself keeps none (src/sri.ts)
		 */
		const withIntegrity = (
			element: CustomElement,
			routed: string,
			original?: URL,
		) => {
			// a value the integrity hook has not taken yet is the newest
			const metadata = element.hasAttribute('integrity')
				? element.getAttribute('integrity')
				: element.getAttributeOG('integrity');
			// a data: URL's bytes are here, and checked now: ones that do not
			// match go to the browser as they are, with the page's metadata on
			// the element, and it refuses them itself as natively (its error,
			// its message, a stylesheet with no sheet). Nothing of them runs, so
			// nothing needs rewriting
			if (original?.protocol === 'data:' && metadata) {
				const bytes = dataURLBytes(original.href);
				if (bytes && !integrityHoldsSync(bytes, metadata)) {
					givenIntegrity.add(element);
					element.setAttribute('integrity', metadata);
					element.removeAttributeOG('integrity');
					return original.href;
				}
			}
			return markIntegrity(routed, metadata, moduleClient.directory);
		};
		/**
		 * Elements the browser is given the page's integrity for (a data: URL
		 * that does not match it, a refused stylesheet asked for again): the
		 * integrity hook leaves the attribute on them, and a new load of theirs
		 * takes it back (releaseIntegrity)
		 */
		const givenIntegrity = new LazyWeakSet<Element>();
		/** before a script or a link routes a new load: the integrity it gave the browser goes back to the page's copy */
		const releaseIntegrity = (element: CustomElement) => {
			if (!givenIntegrity.delete(element)) return;
			if (element.hasAttribute('integrity')) {
				element.setAttributeOG('integrity', element.getAttribute('integrity')!);
				element.removeAttribute('integrity');
			}
		};
		// A stylesheet the worker refused by its integrity fails as a network
		// error, which leaves the link an empty sheet; natively it has none,
		// and document.styleSheets does not list it. Its 'error' is held here,
		// before any listener of the page's, and the link asks for its route
		// again (REFUSED_FRAGMENT) with the page's metadata on it: the worker
		// answers with bytes that fail that metadata (none of the origin's),
		// and the browser refuses them itself, with the error and the console
		// message it gives natively.
		{
			const global = realm as typeof globalThis;
			const targetOf = Reflect.getOwnPropertyDescriptor(
				global.Event.prototype,
				'target',
			)!.get!;
			const localNameOf = Reflect.getOwnPropertyDescriptor(
				global.Element.prototype,
				'localName',
			)!.get!;
			const stop = global.Event.prototype.stopImmediatePropagation;
			const read = nativeElement.getAttribute;
			const write = nativeElement.setAttribute;
			const remove = nativeElement.removeAttribute;
			const held = (event: Event) => {
				if (!event.isTrusted) return;
				const target = Reflect.apply(targetOf, event, []) as Element | null;
				let href: string | null;
				try {
					if (Reflect.apply(localNameOf, target, []) !== 'link') return;
					href = Reflect.apply(read, target, ['href']) as string | null;
				} catch (error) {
					// not an element
					return;
				}
				const rel = (
					(Reflect.apply(read, target, ['rel']) as string | null) ?? ''
				)
					.toLowerCase()
					.split(/[\t\n\f\r ]+/);
				// a link given the page's metadata already: the browser's own
				// refusal (a page's own URL may end in the fragment too)
				if (
					!href ||
					givenIntegrity.has(target!) ||
					!rel.includes('stylesheet') ||
					!href.includes(INTEGRITY_MARK) ||
					href.includes(INTEGRITY_MARK + NO_INTEGRITY)
				)
					return;
				const metadata =
					(Reflect.apply(read, target, [`${MARKER}integrity`]) as
						string | null) ??
					(Reflect.apply(read, target, ['integrity']) as string | null);
				if (metadata === null) return;
				Reflect.apply(stop, event, []);
				const again = href.replace(/#.*$/s, '') + REFUSED_FRAGMENT;
				hiddenMutation(() => {
					Reflect.apply(write, target, ['integrity', metadata]);
					Reflect.apply(remove, target, [`${MARKER}integrity`]);
					// the network error gave the link an empty sheet, which a new
					// load that fails does not take away: no href first
					Reflect.apply(remove, target, ['href']);
					Reflect.apply(write, target, ['href', again]);
				});
				appliedAttribute(target!, 'href', again);
				givenIntegrity.add(target!);
			};
			// opening the document (loadHTML) removes the window's listeners
			const listen = () =>
				Reflect.apply(nativeElement.addEventListener, global, [
					'error',
					held,
					true,
				]);
			listen();
			addDocumentOpenListener(global, listen);
		}
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
			retried = false,
		) => {
			const targets = urls ?? [
				{
					routed,
					page: moduleClient.encodingParse(
						element.getAttributeOG(attribute) ?? routed,
						moduleClient.baseURL.toString(),
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
			if (retried) state.retried = true;
			states.set(attribute, state);
			// markup the page writes: the element here is the clone the markup
			// is rewritten on; the parser makes the real one, which gets its copy
			// after the write (writtenLoads). A script is copied at once below.
			if (moduleClient.writing && element.localName !== 'script') {
				states.delete(attribute);
				element.removeAttribute(attribute);
				return;
			}
			// a script the page writes (its src, an SVG script's href): its copy
			// now, or it would never run
			if (
				(attribute === 'src' || element.namespaceURI === SVG_NAMESPACE) &&
				element.localName === 'script' &&
				moduleClient.writing &&
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
					endWritten(state, url);
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
				const ownLive = !!state.live?.includes(value);
				usePrototype(element, CustomElement.prototype, (element) =>
					element.setAttribute(attribute, value),
				);
				endLive(element, state, value);
				release(current);
				// a sealed image whose cache entry went, a stylesheet put back
				// into the document after its URL was revoked: the load fails
				// where the native one would not, and is copied again, once
				if (
					!state.retried &&
					(state.sound === true ||
						(ownLive && loadKind(element, attribute)?.startsWith('style ')))
				)
					nativeElement.addEventListener.call(
						element,
						'error',
						(event) => {
							if (states.get(attribute) !== state) return;
							Reflect.apply(stopImmediate, event, []);
							states.delete(attribute);
							release(state);
							usePrototype(element, CustomElement.prototype, (element) =>
								placeLoad(element, attribute, routed, urls, compose, true),
							);
						},
						{ once: true, capture: true },
					);
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
			const { mime, data } = parseDataURI(dataBody(resource.url));
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
			const inline = moduleClient.inlineDocument(
				data,
				resource.url.href,
				'data:,',
			);
			if (inline) return inline;
			const blob = new NativeBlob(
				[
					modifyHTML(
						data,
						resource,
						moduleClient.config,
						true,
						undefined,
						moduleClient.scriptNonce,
					),
				],
				{ type: 'text/html' },
			);
			return proxyBlobURL(realm.URL.createObjectURL(blob));
		};
		const domHooksModule = moduleClient.getModule(DOMHooksModule)!;
		// whether a document in this frame may run scripts: its own sandbox (as
		// the page wrote it, in the marker) and this document's
		const frameRunsScripts = (element: CustomElement) => {
			const sandbox = element.getAttributeOG('sandbox');
			return (
				moduleClient.allows('allow-scripts') &&
				(sandbox === null || sandboxTokens(sandbox).has('allow-scripts'))
			);
		};

		// inline event handler attributes are scripts too: `onclick="top.x()"`
		// would reach the real top. Every `on*` the platform knows about, from
		// the prototypes that carry them; one hook watches them all
		const handlerNames = new Set<string>();
		const g = realm;
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
		// An interface may carry handlers of its own (an SVG animation's
		// onbegin, onend and onrepeat, a video's picture-in-picture ones, the
		// permission elements'), and a name the hooks did not know ran its
		// attribute as the page wrote it. So the hook watches every `on*`
		// name, and one outside the set above is a handler where an element of
		// that name has its property: asked of a fresh element in the inert
		// document (the hooks run with the element's own prototype set aside),
		// once per element name, so no interface is made in a frame for a name
		// its page never writes. A custom element's own property makes no
		// handler of its attribute.
		const createElementNS = g.Document.prototype.createElementNS;
		const ownHandlers = new LazyMap<string, boolean>();
		const isHandler = (element: Element, name: string): boolean => {
			if (handlerNames.has(name)) return true;
			const namespace = element.namespaceURI;
			const localName = element.localName;
			if (localName.includes('-')) return false;
			const key = `${namespace} ${localName} ${name}`;
			let known = ownHandlers.get(key);
			if (known === undefined) {
				try {
					known =
						name in
						(Reflect.apply(createElementNS, inertDocumentOf(g.document), [
							namespace,
							localName,
						]) as Element);
				} catch (error) {
					// no element of that name: no handler either
					known = false;
				}
				ownHandlers.set(key, known);
			}
			return known;
		};
		class HandlerNames extends Set<string> {
			override has(name: string) {
				return /^on[a-z]+$/.test(name);
			}
		}
		domHooksModule.useAttributes(
			(element, name) => {
				if (!isHandler(element, name)) return;
				element.restoreAttributesOG(name);
				if (element.hasAttribute(name)) {
					const source = element.getAttribute(name)!;
					element.setAttributeOG(name, source);
					// the page's own script-src-attr refuses this inline handler: it
					// compiles nothing (no browser-facing attribute) and the inject
					// reports it (src/csp.ts)
					if (moduleClient.refuseHandler(element, source)) {
						// clear the live handler (the page's own, which the page's
						// setAttribute left on the element) so clicking runs nothing
						element.removeAttribute(name);
						element.removeAttributeOG(name);
						return;
					}
					// the browser compiles the code as a function's body: marked,
					// so the function reads back with the page's code in it
					const key = sourceKey(source);
					keepSource(key, source);
					element.setAttribute(
						name,
						handlerMark(key) +
							modifyJS(
								source,
								moduleClient.baseURL,
								moduleClient.config,
								'generic',
							),
					);
				}
			},
			[['*', new HandlerNames()]],
		);

		// SVG references (sprites, images, filters) by href or legacy
		// xlink:href. SVG node names keep their case, and the fragment stays.
		// The ones that load another file (an <image>, a <use> of an external
		// sprite, an <feImage>) are copied in a document no worker controls,
		// the fragment kept on the copy
		const SVG_LOADS = ['image', 'use', 'feimage'];
		// (each is called with the attribute's own name: an xlink:href by
		// another prefix, x:href, is the same attribute)
		const svgHook = (element: CustomElement, attribute: string) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '' || value.startsWith('#')) return;
			element.setAttributeOG(attribute, value);
			const routed = routeBinary(
				new StompURL(
					moduleClient.encodingParse(value, moduleClient.baseURL.toString()),
					moduleClient.baseURL,
				),
			);
			if (SVG_LOADS.includes(element.localName.toLowerCase()))
				placeLoad(element, attribute, routed);
			else element.setAttribute(attribute, routed);
		};
		for (const attribute of ['href', 'xlink:href'])
			domHooksModule.useAttributes(
				svgHook,
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
		const svgScriptHook = (element: CustomElement, attribute: string) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '') return;
			element.setAttributeOG(attribute, value);
			const routed = routeJS(
				new StompURL(
					moduleClient.encodingParse(value, moduleClient.baseURL.toString()),
					moduleClient.baseURL,
				),
				moduleClient.baseURL,
				moduleClient.config,
				'generic',
			);
			// an HTML script's href loads nothing
			if (element.namespaceURI === SVG_NAMESPACE)
				placeLoad(element, attribute, routed);
			else element.setAttribute(attribute, routed);
		};
		for (const attribute of ['href', 'xlink:href'])
			domHooksModule.useAttributes(svgScriptHook, [
				['script', attribute],
				['SCRIPT', attribute],
			]);

		// the values the animations' hooks routed, by route: what an animated
		// href's animVal reads back
		const animatedValues = new Map<string, string>();
		// an SVG reference's `href` is an SVGAnimatedString: its baseVal and
		// animVal read the attribute the page wrote (the hooked getAttribute),
		// setting baseVal writes through the hooked setAttribute, so it routes
		{
			const proxyModule = moduleClient.getModule(ProxyModule)!;
			const global = realm as unknown as Record<string, any>;
			const owners = new LazyWeakMap<object, Element>();
			for (const name of SVG_HREF_INTERFACES) {
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
			const createSVG = global.Document.prototype.createElementNS;
			const routedBases = new WeakMap<Element, [string, string]>();
			const baseGet =
				animated && Reflect.getOwnPropertyDescriptor(animated, 'baseVal')?.get;
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
								// an animation running on the href: the value it set,
								// as the page wrote it (animatedValues)
								if (property === 'animVal' && baseGet) {
									const live = Reflect.apply(target, that, args) as string;
									if (live !== Reflect.apply(baseGet, that, []))
										return animatedValues.get(live) ?? live;
								}
								// a baseVal set where only an xlink:href is (below)
								const set = routedBases.get(owner);
								if (
									set &&
									baseGet &&
									Reflect.apply(baseGet, that, []) === set[0]
								)
									return set[1];
								return (
									owner.getAttribute(
										owner.hasAttribute('href') ? 'href' : xlinkName(owner),
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
										const value = String(args[0]);
										if (
											!owner.hasAttribute('href') &&
											owner.hasAttribute(xlinkName(owner))
										) {
											// where only an xlink:href is, Chrome sets the
											// property alone: the attribute reads as it was and
											// the element loads the new value, routed as on an
											// element of its kind (made where nothing loads)
											const scratch = Reflect.apply(
												createSVG,
												inertDocumentOf(realm.document),
												['http://www.w3.org/2000/svg', owner.localName],
											) as Element;
											scratch.setAttribute('href', value);
											const routed =
												nativeElement.getAttribute.call(scratch, 'href') ?? '';
											routedBases.set(owner, [routed, value]);
											return Reflect.apply(target, that, [routed]);
										}
										owner.setAttribute('href', value);
									},
								)
							: undefined,
					});
				}
		}

		// browsing context names that would leave the frame: a top-level page
		// navigates itself for these, so does a proxied one. `_blank` and
		// names stay native (popups) until a host opts into onOpen
		// A sandboxed document's are left as written: the real frame's sandbox
		// never allows top navigation, so the browser refuses them as it
		// would natively, and the Sandbox module navigates the proxied top for
		// a link the page's sandbox lets through
		// (a frame under the proxied top is navigated the same way, and the
		// hooks navigate the proxied parent or top it means: DocumentClient
		// targetWindow)
		const selfTargets = ['_top', '_parent', '_unfencedtop'];
		const targetHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (!selfTargets.includes(value.toLowerCase())) return;
			if (moduleClient.sandboxFlags !== null) return;
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
			[realm.HTMLAnchorElement, 'target', ogOrFalse('target')],
			[realm.HTMLAreaElement, 'target', ogOrFalse('target')],
			[realm.HTMLFormElement, 'target', ogOrFalse('target')],
			[realm.HTMLBaseElement, 'target', ogOrFalse('target')],
		]);
		domHooksModule.useAttributes(targetHook('formtarget'), [
			['BUTTON', 'formtarget'],
			['INPUT', 'formtarget'],
			[realm.HTMLButtonElement, 'formTarget', ogOrFalse('formtarget')],
			[realm.HTMLInputElement, 'formTarget', ogOrFalse('formtarget')],
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
						modifyHTML(
							source,
							moduleClient.baseURL,
							moduleClient.config,
							false,
							undefined,
							moduleClient.scriptNonce,
						),
					);
				}
			},
			[
				['IFRAME', 'srcdoc'],
				[
					realm.HTMLIFrameElement,
					'srcdoc',
					(element) => element.getAttributeOG('srcdoc') ?? false,
				],
			],
		);

		const linkHook = (element: CustomElement, attribute: string) => {
			element.restoreAttributesOG(attribute);

			if (
				element.hasAttribute(attribute) &&
				element.getAttribute(attribute) !== ''
			) {
				element.setAttributeOG(attribute, element.getAttribute(attribute)!);
				element.setAttribute(
					attribute,
					moduleClient.linkRoute(
						new StompURL(
							moduleClient.encodingParse(
								element.getAttribute(attribute)!,
								moduleClient.baseURL.toString(),
							),
							moduleClient.baseURL,
						),
					),
				);
			}
		};
		// an SVG link's legacy xlink:href is a link as much as its href: a
		// javascript: URL in it ran as the page wrote it
		domHooksModule.useAttributes(linkHook, [['a', 'xlink:href']]);
		// An SVG animation of a link's href (<set attributeName="href"
		// to="javascript:...">, <animate values="...">) makes its values the
		// link's while it runs: they are routed the way the attribute itself
		// is, the link's as a link (which rewrites a javascript: URL's code),
		// any other reference's as the file it loads. The animation's target is
		// the element its own href names, else its parent; a value written
		// before either is known (the element its href names appears later,
		// and SMIL finds it then) is routed as a file, which is what an image
		// or a use takes (a link that takes it navigates to the file); a
		// javascript: URL as a link's always (no reference runs one
		// unrewritten). The attribute is href by any prefix: the browser
		// looks the prefix up (q:href, with q bound to xlink), and a prefix
		// it finds no namespace for animates nothing, whatever its values.
		// A change of the animation's own href retargets it: routed again.
		const ANIMATED = ['to', 'from', 'by', 'values'];
		const animatedTarget = (element: CustomElement): Element | null => {
			const reference =
				element.getAttribute('href') ??
				element.getAttribute(xlinkName(element));
			if (reference?.startsWith('#'))
				return (
					(element.getRootNode() as Document | ShadowRoot).getElementById?.(
						reference.slice(1),
					) ?? null
				);
			return element.parentElement;
		};
		const animatedHook = (element: CustomElement) => {
			element.restoreAttributesOG(...ANIMATED);
			const name = element.getAttribute('attributeName');
			if (name === null || !/^(?:[^:]+:)?href$/.test(name)) return;
			const target = animatedTarget(element);
			const link = target ? target.localName === 'a' : null;
			const route = (value: string): string => {
				const trimmed = value.trim();
				if (trimmed === '' || trimmed.startsWith('#')) return value;
				try {
					const url = new StompURL(
						moduleClient.encodingParse(
							trimmed,
							moduleClient.baseURL.toString(),
						),
						moduleClient.baseURL,
					);
					// (a link's route rewrites a javascript: URL's code)
					if (link === true || url.url.protocol === 'javascript:')
						return moduleClient.linkRoute(url);
					return routeBinary(url);
				} catch (error) {
					// no URL: the browser makes nothing of it either
					return value;
				}
			};
			for (const attribute of ANIMATED) {
				if (!element.hasAttribute(attribute)) continue;
				const value = element.getAttribute(attribute)!;
				// `values` is a list, split at semicolons before any is a URL
				const routed =
					attribute === 'values'
						? value.split(';').map(route).join(';')
						: route(value);
				if (routed === value) continue;
				if (attribute === 'values') {
					const written = value.split(';');
					routed
						.split(';')
						.forEach((part, i) => animatedValues.set(part, written[i]));
				} else animatedValues.set(routed, value);
				element.setAttributeOG(attribute, value);
				element.setAttribute(attribute, routed);
			}
		};
		domHooksModule.useAttributes(
			animatedHook,
			['set', 'animate'].flatMap((tag) =>
				[...ANIMATED, 'attributeName', 'href', 'xlink:href'].map(
					(attribute): [string, string] => [tag, attribute],
				),
			),
		);

		domHooksModule.useAttributes(
			linkHook,
			[
				['A', 'href'],
				['a', 'href'],
				['AREA', 'href'],
				[
					realm.HTMLAnchorElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('href') ??
									element.getAttribute('href'))!,
								responseURLOf(element) ?? moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
				],
				// an image map's areas are links too
				[
					realm.HTMLAreaElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('href') ??
									element.getAttribute('href'))!,
								responseURLOf(element) ?? moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
				],
			],
			// URL attributes do not mixin with element attributes
		);

		domHooksModule.useAttributes(
			(element, attribute) => {
				// the browser reads a script's integrity when it starts the load,
				// at its insertion: a connected one keeps the load it has
				if (attribute === 'integrity' && element.isConnected) return;
				releaseIntegrity(element);
				element.restoreAttributesOG('src');
				// a held script (holdScript) keeps its page's src through a change
				// of its type or integrity (its route, integrity and all, is made
				// as it connects); a src set or removed again replaces it
				if (moduleClient.scriptsHeld && moduleClient.scriptHeld(element)) {
					if (attribute === 'type' || attribute === 'integrity') return;
					moduleClient.releaseScript(element);
				}

				if (
					element.hasAttribute('src') &&
					element.getAttribute('src') !== '' &&
					shouldRewriteScript(element)
				) {
					element.setAttributeOG('src', element.getAttribute('src')!);
					const url = moduleClient.encodingParse(
						element.getAttribute('src')!,
						moduleClient.baseURL.toString(),
					);
					// the page's own script-src refuses this external script: it
					// does not load, the browser fires 'error', and the inject
					// reports it (src/csp.ts). A script the page inserts through the
					// DOM, not the parser (DOMAttributes runs for inserted elements).
					// One not connected yet that a nonce could still let through is
					// held refused, and judged again as it connects, as Chrome
					// judges it (with the nonce it has then: DOMContentHooks)
					if (
						!element.isConnected &&
						moduleClient.scriptAwaitsNonce(element, url)
					) {
						const src = element.getAttribute('src')!;
						element.removeAttribute('src');
						element.removeAttributeOG('src');
						moduleClient.holdScript(element, url, src);
						return;
					}
					if (moduleClient.refuseExternalScript(element, url, false)) {
						// clear the live src (the page's own, which the browser would
						// otherwise load) so nothing loads; the browser fires 'error'
						element.removeAttribute('src');
						element.removeAttributeOG('src');
						moduleClient.dispatchLoadError(element);
						return;
					}
					// let through by its host or its integrity where the page's
					// policy says so and the browser's copy would not (src/csp.ts)
					moduleClient.giveCodeNonce(element, url, null, false);
					placeLoad(
						element,
						'src',
						withIntegrity(
							element,
							routeJS(
								new StompURL(url, moduleClient.baseURL),
								moduleClient.baseURL,
								moduleClient.config,
								scriptType(element),
							),
							url,
						),
					);
				}
			},
			[
				['SCRIPT', 'src'],
				// the route depends on type=module, which pages may set after src
				['SCRIPT', 'type'],
				// and carries the integrity (src/sri.ts), which may come after src
				['SCRIPT', 'integrity'],
				[realm.HTMLScriptElement, 'integrity', () => false],
				[
					realm.HTMLScriptElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
								moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
				],
			],
		);

		domHooksModule.useAttributes(
			(element) => {
				// the browser checks this one itself (withIntegrity)
				if (givenIntegrity.has(element)) return;
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
				// the page's value: the element itself has none (the browser
				// would check the rewrite against it)
				[
					realm.HTMLLinkElement,
					'integrity',
					(element) => element.getAttributeOG('integrity') ?? false,
				],
				[
					realm.HTMLScriptElement,
					'integrity',
					(element) => element.getAttributeOG('integrity') ?? false,
				],
			],
		);

		domHooksModule.useAttributes(
			(element, attribute) => {
				// a stylesheet's integrity is read when its load starts: a
				// connected link keeps the load it has (as natively)
				if (attribute === 'integrity' && element.isConnected) return;
				releaseIntegrity(element);
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
						moduleClient.encodingParse(
							element.getAttribute('href')!,
							moduleClient.baseURL.toString(),
						),
						moduleClient.baseURL,
					);
					element.setAttributeOG('href', element.getAttribute('href')!);
					const stylesheet =
						rel.has('stylesheet') ||
						((rel.has('preload') || rel.has('prefetch')) && as === 'style');
					if (rel.has('manifest')) element.removeAttribute('href');
					// the page's own style-src refuses this external stylesheet: it
					// does not load, the browser fires 'error', the inject reports it
					else if (
						stylesheet &&
						moduleClient.refuseExternalStyle(
							element,
							moduleClient.encodingParse(
								element.getAttribute('href')!,
								moduleClient.baseURL.toString(),
							),
						)
					) {
						element.removeAttribute('href');
						element.removeAttributeOG('href');
						moduleClient.dispatchLoadError(element);
					} else if (stylesheet)
						placeLoad(
							element,
							'href',
							withIntegrity(
								element,
								routeCSS(resource, moduleClient.baseURL),
								resource.url,
							),
						);
					else if (rel.has('modulepreload'))
						placeLoad(
							element,
							'href',
							withIntegrity(
								element,
								routeJS(
									resource,
									moduleClient.baseURL,
									moduleClient.config,
									'genericModule',
								),
							),
						);
					else if (
						(rel.has('preload') || rel.has('prefetch')) &&
						as === 'script'
					)
						placeLoad(
							element,
							'href',
							withIntegrity(
								element,
								routeJS(
									resource,
									moduleClient.baseURL,
									moduleClient.config,
									'generic',
								),
							),
						);
					else placeLoad(element, 'href', routeBinary(resource));
				}
			},
			[
				['LINK', 'href'],
				['LINK', 'rel'],
				['LINK', 'as'],
				// the route carries the integrity (src/sri.ts), which markup and
				// pages may give after href
				['LINK', 'integrity'],
				[realm.HTMLLinkElement, 'integrity', () => false],
				[realm.HTMLLinkElement, 'as', () => false],
				[
					realm.HTMLLinkElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('href') ??
									element.getAttribute('href'))!,
								responseURLOf(element) ?? moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
				],
				[realm.HTMLLinkElement, 'rel', () => false],
			],
		);

		// todo: mimes...?
		// https://www.w3schools.com/tags/tag_embed.asp

		/**
		 * The origin of the document a frame shows now ('null' for an opaque
		 * one), or undefined when it has no context yet (not connected) or
		 * shows a document of another real origin (the host's)
		 */
		const frameOrigin = (element: Element): string | undefined => {
			const shown = frameWindow(element);
			if (!shown) return undefined;
			try {
				const client = (shown as unknown as Record<string, unknown>)[
					moduleClient.names.client
				] as DocumentClient | undefined;
				if (client?.isDOM) return client.originKey ?? 'null';
				// its initial about:blank, which nothing injected yet: of this
				// document's origin
				if (shown.location.href === 'about:blank')
					return moduleClient.originKey ?? 'null';
			} catch (error) {
				// a document of another real origin
			}
			return undefined;
		};

		const contentWindowOf = Reflect.getOwnPropertyDescriptor(
			realm.HTMLIFrameElement.prototype,
			'contentWindow',
		)!.get!;
		// a slot of the site pool: the browser reads the frame's allow for a
		// document of another origin (../siteEvents.ts slotContainerPolicy), the page its own;
		// before the frame is navigated too, since the browser takes the
		// container policy with the navigation
		// The property reads the page's attribute through a hook made the
		// first time a frame's attribute is changed: until then the native
		// getter reads what the page wrote, and a frame that never has an
		// allow attribute (most) makes no wrappers for it
		let allowRead = false;
		// (made only under a pool)
		const slotAllow: ((element: CustomElement) => void) | null = !this.client
			.sites
			? null
			: (element) => {
					if (element.nodeName !== 'IFRAME') return;
					element.restoreAttributesOG('allow');
					if (!element.hasAttribute('allow')) return;
					const allow = element.getAttribute('allow')!;
					if (!allowRead) {
						allowRead = true;
						domHooksModule.useAttributes(slotAllow!, [
							[
								this.client.global.HTMLIFrameElement,
								'allow',
								(element) => element.getAttributeOG('allow') ?? false,
							],
						]);
					}
					element.setAttributeOG('allow', allow);
					element.setAttribute('allow', deferred('slotContainerPolicy')(allow));
				};
		if (slotAllow)
			domHooksModule.useAttributes(slotAllow, [['IFRAME', 'allow']]);
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('src');

				if (element.hasAttribute('src') && element.getAttribute('src') !== '') {
					element.setAttributeOG('src', element.getAttribute('src')!);
					const resource = new StompURL(
						moduleClient.encodingParse(
							element.getAttribute('src')!,
							moduleClient.baseURL.toString(),
						),
						moduleClient.baseURL,
					);
					// a javascript: URL runs in the frame, which a sandbox without
					// allow-scripts forbids: natively nothing happens, so the frame
					// is not navigated at all
					if (
						resource.url.protocol === 'javascript:' &&
						!frameRunsScripts(element)
					) {
						element.removeAttribute('src');
						return;
					}
					// the page's frame-src (src/csp.ts): a frame its policy
					// refuses is sent where the browser's copy of the policy
					// refuses it, and the browser refuses and reports it as natively
					const refused = moduleClient.loadRefusal(
						'frame-src',
						resource.url,
						true,
					);
					if (refused !== null) {
						moduleClient.opaqueFrames.delete(element);
						element.setAttribute('src', refused);
						return;
					}
					const opaque = opaqueDocument(resource);
					if (opaque) moduleClient.opaqueFrames.add(element);
					else moduleClient.opaqueFrames.delete(element);
					// the frame navigates for this document, under its activation,
					// with its element's allow attribute as its container policy
					// (the worker's client hints and permissions policy for the
					// frame read it; empty when the element has none),
					// `allowfullscreen` being `fullscreen *` where the attribute
					// does not name the feature; and with what judges the frame's
					// later hops and the document it ends in: this document's
					// frame-src, and the frame's real ancestors (src/csp.ts)
					if (!opaque)
						moduleClient
							.getModule(NavigationHintModule)
							?.hint(
								resource.url.href,
								element.nodeName === 'IFRAME'
									? containerPolicy(element)
									: undefined,
								{
									policies: moduleClient.hopPolicies('frame-src') ?? [],
									ancestors: [
										moduleClient.origin,
										...moduleClient.ancestorOrigins(),
									],
									required: moduleClient.requiredCSP(element),
								},
							);
					const routed =
						opaque ??
						routeHTML(
							resource,
							moduleClient.baseURL,
							moduleClient.config,
							false,
							// with the host's page cross-origin isolated, the
							// route says whom the frame's `allow` lets be, and
							// whether the frame is a credentialless one (the
							// attribute itself is kept from the browser, below)
							// (the site pool: and the frame's sandbox, which a frame
							// of another slot cannot read)
							moduleClient.hostIsolated
								? moduleClient.childRouteFor(
										element.hasAttributeOG('allow')
											? element.getAttributeOG('allow')
											: element.getAttribute('allow'),
										resource.url.origin,
										element.hasAttributeOG('credentialless') ||
											element.hasAttribute('credentialless'),
										this.client.sites
											? siteWindows().frameSandbox(this.client, element)
											: null,
									)
								: moduleClient.childRouteFor(
										null,
										null,
										false,
										moduleClient.sites
											? siteWindows().frameSandbox(moduleClient, element)
											: null,
									),
						);
					// a frame that shows a document of another origin than the
					// one it is sent to gets a fresh browsing context first
					// (freshContext.ts): a window the page reached while the
					// frame was of its origin must not show the next one. Its
					// initial about:blank is this document's origin, and fires no
					// navigate event of its own (IFrame)
					forgetDestination(moduleClient, element);
					const shown = frameOrigin(element);
					if (
						shown !== undefined &&
						shown !== (opaque ? 'null' : resource.url.origin) &&
						resource.url.protocol !== 'javascript:' &&
						resource.url.href !== 'about:blank' &&
						moduleClient.freshFrame
					) {
						if (moduleClient.freshFrame(element, routed)) return;
					}
					// the document the frame shows now sees the navigation (its
					// navigate event): this one judged it
					try {
						const shown = (
							Reflect.apply(contentWindowOf, element, []) as Record<
								string,
								unknown
							> | null
						)?.[moduleClient.names.client] as DocumentClient | undefined;
						const hints = shown?.getModule?.(NavigationHintModule);
						if (hints) hints.judged = resource.url.href.replace(/#.*$/s, '');
					} catch (error) {
						// a document of another origin, or none
					}
					slotAllow?.(element);
					element.setAttribute('src', routed);
				}
			},
			[
				['IFRAME', 'src'],
				['FRAME', 'src'],
				// what the route says of the frame (an isolated host only)
				...(moduleClient.hostIsolated
					? ([
							['IFRAME', 'allow'],
							['IFRAME', 'credentialless'],
						] as [string, string][])
					: []),
				[
					realm.HTMLFrameElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
								moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
				],
				[
					realm.HTMLIFrameElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
								moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
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
						// the page's policy as the browser can apply it to the
						// proxy's URLs (src/csp.ts); it applies when the meta is
						// inserted, as natively
						case 'content-security-policy': {
							const content = element.getAttribute('content')!;
							element.setAttributeOG('content', content);
							const policy = moduleClient.metaPolicy(content);
							if (policy === null) element.removeAttribute('content');
							else element.setAttribute('content', policy);
							break;
						}
						// client hints are the worker's to send for the real
						// origins (src/server/clientHints.ts, which reads a
						// page's own metas from its markup): the browser must
						// not apply them to the proxy origin
						case 'accept-ch':
						case 'delegate-ch': {
							const content = element.getAttribute('content')!;
							element.setAttributeOG('content', content);
							element.removeAttribute('content');
							// one the page's script inserts counts for its later
							// requests; a scripted delegate-ch counts for nothing
							// (measured)
							if (
								element.getAttribute('http-equiv')!.toLowerCase() ===
								'accept-ch'
							)
								moduleClient.reportAcceptCH(parseAcceptCH(content) ?? []);
							break;
						}
						case 'refresh':
							element.setAttributeOG(
								'content',
								element.getAttribute('content')!,
							);
							element.setAttribute(
								'content',
								modifyRefresh(
									element.getAttribute('content')!,
									moduleClient.baseURL,
									moduleClient.config,
									moduleClient.nestedRoute,
								),
							);
							break;
					}
			},
			[
				['META', 'content'],
				['META', 'http-equiv'],
				[
					realm.HTMLMetaElement,
					'content',
					// what the page wrote, for a refresh the hook rewrote; any
					// other content (a token, a payload) is not a URL and reads
					// natively
					(element) => element.getAttributeOG('content') ?? false,
				],
				[realm.HTMLMetaElement, 'httpEquiv', () => false],
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
								moduleClient.encodingParse(
									element.getAttribute('src')!,
									moduleClient.baseURL.toString(),
								),
								moduleClient.baseURL,
							),
						),
					);
				}
			},
			[
				['IMG', 'src'],
				['INPUT', 'src'],
				[
					realm.HTMLInputElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
								moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
				],
				[
					realm.HTMLImageElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
								moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
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

					// a candidate that is no URL (`https://[`) stays as written: the
					// browser keeps it in the list and fails it if it picks it
					const pages = parsed.map((src) => {
						try {
							return moduleClient.encodingParse(
								src.url,
								moduleClient.baseURL.toString(),
							);
						} catch (error) {
							return null;
						}
					});
					parsed.forEach((src, index) => {
						const page = pages[index];
						updated.push({
							...src,
							url: page
								? routeImageSet(new StompURL(page, moduleClient.baseURL))
								: src.url,
						});
					});

					placeLoad(
						element,
						'srcset',
						stringifySrcset(updated),
						updated.map((candidate, index) => ({
							routed: candidate.url,
							page: pages[index]?.href ?? parsed[index].url,
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
					realm.HTMLImageElement,
					'srcset',
					(element) =>
						element.hasAttribute('srcset') &&
						element.getAttribute('srcset') !== '' &&
						(element.getAttributeOG('srcset') ??
							element.getAttribute('srcset'))!,
				],
				[
					realm.HTMLSourceElement,
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
								moduleClient.encodingParse(
									element.getAttribute('src')!,
									moduleClient.baseURL.toString(),
								),
								moduleClient.baseURL,
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
					realm.HTMLTrackElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
								moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
				],
				[
					realm.HTMLMediaElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
								moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
				],
				[
					realm.HTMLSourceElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						moduleClient
							.encodingParse(
								(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
								moduleClient.baseURL.toString(),
								element,
							)
							.toString(),
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
						moduleClient.baseURL,
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
					// (the page's style-src-attr refuses a style attribute the page
					// sets as a string: enforced at the setAttribute hook, not here,
					// so a CSSOM write that serialises into the attribute, which the
					// browser does not refuse, is not caught, src/inject/dom/
					// modules/DOMHooks.ts)
					// a style the browser serialised from a CSSOM write (a copy of
					// such an element, inserted) holds routes: the page's is the
					// browser's serialisation of the url()s it wrote
					element.setAttributeOG(
						'style',
						unrouteCSS(moduleClient, element.getAttribute('style')!, true),
					);
					element.setAttribute(
						'style',
						modifyCSS(
							(element.getAttributeOG('style') ??
								element.getAttribute('style'))!,
							moduleClient.baseURL,
							'declarationList',
						),
					);
				}
				copyInlineSoon(element);
			},
			[
				['*', 'style'],
				[realm.HTMLElement, 'style', () => false],
			],
		);

		// CSSStyleDeclaration: element.style.x = ..., setProperty(), cssText
		{
			const styleProto = realm.CSSStyleDeclaration.prototype;
			const proxyModule = moduleClient.getModule(ProxyModule)!;

			// the element each page-facing declaration belongs to
			const owners = new LazyWeakMap<CSSStyleDeclaration, Element>();
			const pending = new LazyWeakSet<Element>();
			copyInlineSoon = (element) => {
				if (!uncontrolled() || pending.has(element)) return;
				pending.add(element);
				queueMicrotask(() => {
					pending.delete(element);
					const declaration = this.#nativeDeclaration(element);
					// no declaration, no style: nothing loads
					if (!declaration) return;
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
			// A CSSOM write makes the browser serialise the declaration into the
			// attribute, so what the page wrote as the attribute (its marker)
			// is no longer what the attribute holds: it goes, and the attribute
			// reads as the browser serialised it, with the page's url()s
			const dropMarker = (element: Element) => {
				// most writes: no marker to drop, known without a prototype swap
				if (
					!pendingAttributes(element) &&
					!nativeElement.hasAttribute.call(element, `${MARKER}style`)
				)
					return;
				usePrototype(element, CustomElement.prototype, (element) => {
					if (element.hasAttributeOG('style'))
						element.removeAttributeOG('style');
				});
			};
			// a rule's declarations (rule.style) belong to its sheet: a write
			// there in a document no service worker controls has the sheet's
			// loads copied
			const parentRule = Reflect.getOwnPropertyDescriptor(
				styleProto,
				'parentRule',
			)!.get!;
			const parentSheet = Reflect.getOwnPropertyDescriptor(
				realm.CSSRule.prototype,
				'parentStyleSheet',
			)!.get!;
			const ruleWritten = (rule: unknown) => {
				try {
					const sheet = rule && Reflect.apply(parentSheet, rule, []);
					if (sheet) this.copyRules?.(sheet as CSSStyleSheet);
				} catch (error) {
					// not a rule
				}
			};
			const afterWrite = (declaration: unknown) => {
				const owner = owners.get(declaration as CSSStyleDeclaration);
				if (!owner) {
					if (!uncontrolled()) return;
					try {
						ruleWritten(Reflect.apply(parentRule, declaration, []));
					} catch (error) {
						// not a declaration block
					}
					return;
				}
				dropMarker(owner);
				copyInlineSoon(owner);
			};
			this.copyInline = (element) => copyInlineSoon(element);

			// One property's value. A URL named any way but a plain lower-case
			// url() token (a string of image-set() or src(), a url( spelled
			// with an escape, in upper case, or left unclosed) takes the
			// parser, which reads the value as a declaration's: the fast regex
			// below finds only a lower-case, closed url(, and the browser loads
			// the rest all the same (background-image:URL(...) and an unclosed
			// url( at the end of a value both fetch).
			const AS_DECLARATION = 'content:';
			const rewriteValue = (value: unknown) => {
				if (typeof value !== 'string') return value;
				if (/url\(|image-set|src\(|\\/i.test(value))
					try {
						const routed = modifyCSS(
							AS_DECLARATION + value,
							moduleClient.baseURL,
							'declarationList',
						);
						if (routed.startsWith(AS_DECLARATION))
							return routed.slice(AS_DECLARATION.length);
					} catch (error) {
						// not a value the parser takes: the url() tokens it has
					}
				// a url( in any case or spelled with an escape
				return /url\(|\\/i.test(value)
					? rewriteCSSValueURLs(value, moduleClient.baseURL)
					: value;
			};

			const rewriteCssText = (value: unknown) => {
				try {
					return modifyCSS(
						String(value),
						moduleClient.baseURL,
						'declarationList',
					);
				} catch (error) {
					return value;
				}
			};

			// Chromium implements the named properties (style.backgroundImage = ...)
			// as per-instance named setters, so the only way to see those writes
			// is to hand the page a Proxy from the `style` getter.
			const declarationProxies = new LazyWeakMap<
				CSSStyleDeclaration,
				CSSStyleDeclaration
			>();
			// a computed style's url() is absolute, natively: the real URL its
			// route stands for
			const computedDeclarations = new LazyWeakSet<CSSStyleDeclaration>();
			const restore = (target: CSSStyleDeclaration, value: string) =>
				computedDeclarations.has(target)
					? restoreCSSValueURLs(value, (routed) =>
							computedURL(moduleClient, routed),
						)
					: restoreCSSValueURLs(value);

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
										? restore(target, result)
										: result;
								};
							if (typeof value === 'function') return value.bind(target);
							return typeof value === 'string' && value.includes('url(')
								? restore(target, value)
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
			// every element interface with an inline style of its own (a
			// MathML element's, too)
			const styleInterfaces = ELEMENT_STYLE_INTERFACES.flatMap((name) => {
				const ctor = (realm as unknown as Record<string, unknown>)[name];
				return typeof ctor === 'function' ? [ctor as typeof HTMLElement] : [];
			});

			for (const ctor of styleInterfaces) {
				const descriptor = Reflect.getOwnPropertyDescriptor(
					ctor.prototype,
					'style',
				);
				if (!descriptor?.get) continue;
				const get = descriptor.get;

				Reflect.defineProperty(ctor.prototype, 'style', {
					...descriptor,
					get: proxyModule.wrapFunction(get, (target, that, args) => {
						const declaration = Reflect.apply(target, that, args);
						if (declaration && typeof declaration === 'object')
							owners.set(declaration, that as Element);
						return wrapDeclaration(declaration);
					}),
					// `el.style = text` is a write of its cssText
					...(descriptor.set
						? {
								set: proxyModule.wrapFunction(
									descriptor.set,
									(target, that, args) => {
										const declaration = Reflect.apply(get, that, []);
										if (!declaration || typeof declaration !== 'object')
											return Reflect.apply(target, that, args);
										owners.set(declaration, that as Element);
										Reflect.apply(target, that, [rewriteCssText(args[0])]);
										afterWrite(declaration);
									},
								),
							}
						: {}),
				});
			}

			// computed styles read back the page's URLs too
			realm.getComputedStyle = proxyModule.wrapFunction(
				realm.getComputedStyle,
				(target, that, args) => {
					const declaration = Reflect.apply(target, that, args);
					if (declaration && typeof declaration === 'object')
						computedDeclarations.add(declaration);
					return wrapDeclaration(declaration);
				},
			);

			// the Typed OM: values stringify with the page's URLs; what the page
			// parses or sets is routed
			const typed = realm as unknown as Record<string, any>;
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
			const mapOwners = new LazyWeakMap<object, Element>();
			for (const ctor of styleInterfaces) {
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
			// a style rule's styleMap: a write there changes the rule
			const mapRules = new LazyWeakMap<object, object>();
			{
				const descriptor = Reflect.getOwnPropertyDescriptor(
					realm.CSSStyleRule.prototype,
					'styleMap',
				);
				if (descriptor?.get)
					Reflect.defineProperty(realm.CSSStyleRule.prototype, 'styleMap', {
						...descriptor,
						get: proxyModule.wrapFunction(
							descriptor.get,
							(target, that, args) => {
								const map = Reflect.apply(target, that, args);
								if (map && typeof map === 'object') mapRules.set(map, that);
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
								if (owner) {
									dropMarker(owner);
									copyInlineSoon(owner);
								} else if (uncontrolled()) ruleWritten(mapRules.get(that));
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
			styleProto.removeProperty = proxyModule.wrapFunction(
				styleProto.removeProperty,
				(target, that, args) => {
					const result = Reflect.apply(target, that, args);
					afterWrite(that);
					return restoreCSSValueURLs(result);
				},
			);

			// newer Chromium moves the named properties (backgroundImage, ...)
			// onto CSSStyleProperties; wrap setters on both prototypes
			const protos = [
				styleProto,
				(
					realm as unknown as {
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
											moduleClient.baseURL,
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
			realm.CSSRule.prototype,
			'cssText',
		)!.get!;
		const nativeRules = {
			sheet: {
				insert: realm.CSSStyleSheet.prototype.insertRule,
				delete: realm.CSSStyleSheet.prototype.deleteRule,
			},
			group: {
				insert: realm.CSSGroupingRule.prototype.insertRule,
				delete: realm.CSSGroupingRule.prototype.deleteRule,
			},
		};
		const textOf = (rule: CSSRule) =>
			Reflect.apply(ruleText, rule, []) as string;
		// a style rule's own declarations, not the page-facing view the
		// readback module (which applies later) hands out: the native
		// methods putCopies calls refuse that view
		const ruleStyle = Reflect.getOwnPropertyDescriptor(
			realm.CSSStyleRule.prototype,
			'style',
		)!.get!;
		const keyframeStyle = Reflect.getOwnPropertyDescriptor(
			realm.CSSKeyframeRule?.prototype ?? {},
			'style',
		)?.get;
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
				container instanceof realm.CSSStyleSheet
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
				// an @keyframes rule's keyframes take the copies as a style rule
				// does (they cannot be put back at a place)
				if ('appendRule' in rule) {
					for (const keyframe of (rule as CSSKeyframesRule).cssRules)
						if (keyframeStyle && routesIn(textOf(keyframe)).length)
							putCopies(
								Reflect.apply(
									keyframeStyle,
									keyframe,
									[],
								) as CSSStyleDeclaration,
								copied,
							);
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
		/** how the CSSOM pass of each <style> marks a rule it need not redo */
		const sheetMarks = new WeakMap<StyleElement, (rule: CSSRule) => void>();
		this.copySheet = (style, mark) => {
			sheetMarks.set(style, mark);
			copyOwned(
				style,
				'sheet',
				() => sheetText(style.sheet),
				(copied) => {
					if (style.sheet) putBack(style.sheet, copied, mark);
				},
			);
		};
		// A sheet whose rules the page changed through the CSSOM in a document
		// no service worker controls (insertRule, addRule, replace,
		// replaceSync, deleteRule, a rule put inside another, a rule's own
		// declarations): the same. A <style>'s sheet is copied as its
		// element's, so the copies go when its text changes; any other (a
		// constructed sheet, a <link>'s, an @import's) holds its own. Once
		// for the writes of a task: a page that builds a sheet rule by rule
		// has it read once.
		const ownerNode = Reflect.getOwnPropertyDescriptor(
			realm.StyleSheet.prototype,
			'ownerNode',
		)!.get!;
		const changedSheets = new LazyWeakSet<CSSStyleSheet>();
		this.copyRules = (sheet) => {
			if (!uncontrolled() || changedSheets.has(sheet)) return;
			changedSheets.add(sheet);
			queueMicrotask(() => {
				changedSheets.delete(sheet);
				let style: StyleElement | null;
				try {
					style = moduleClient.styleElement(
						Reflect.apply(ownerNode, sheet, []),
					);
				} catch (error) {
					return;
				}
				if (style) {
					// the sheet the element has now: one the page kept from before
					// its text changed shows nothing
					if (style.sheet === sheet)
						this.copySheet!(style, sheetMarks.get(style) ?? (() => {}));
					return;
				}
				copyOwned(
					sheet,
					'rules',
					() => sheetText(sheet),
					(copied) => putBack(sheet, copied, () => {}),
				);
			});
		};

		// The elements the parser made from markup the page wrote into a
		// document no service worker controls: each load the rewrite left with
		// only its marker (see placeLoad) gets the page's value back and its
		// hooks run on the element itself, which makes its copy. Underneath the
		// hooks, so the page's observers see nothing. A script is not one: it
		// got its copy during the write, or (the transport in the page) does
		// not run.
		const nativeQueryAll = realm.Document.prototype.querySelectorAll;
		const LOADS = [
			...['src', 'href', 'xlink:href', 'srcset', 'poster', 'data'],
			'imagesrcset',
		];
		const written = LOADS.map((name) => name.replace(':', '\\:'))
			.map((name) => `[s_o\\:${name}]:not([${name}]):not(script)`)
			.join(',');
		// a document a worker controls loads its elements itself, but for an
		// <object>'s data and an <embed>'s src: Chrome sends no such load
		// through a worker, so those are copies in every document (proxiedLoad)
		const OBJECT_LOADS: [string, string][] = [
			['object', 'data'],
			['embed', 'src'],
		];
		const writtenObjects = OBJECT_LOADS.map(
			([tag, name]) => `${tag}[s_o\\:${name}]:not([${name}])`,
		).join(',');
		moduleClient.writtenLoads = (document) => {
			const all = uncontrolled();
			let elements: Element[];
			try {
				elements = [
					...(Reflect.apply(nativeQueryAll, document, [
						all ? written : writtenObjects,
					]) as NodeListOf<Element>),
				];
			} catch (error) {
				return;
			}
			for (const element of elements)
				usePrototype(element, CustomElement.prototype, (element) => {
					const names = all
						? LOADS
						: OBJECT_LOADS.filter(([tag]) => tag === element.localName).map(
								([, name]) => name,
							);
					for (const name of names) {
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
			const routedPrefix = `${moduleClient.directory}html`;

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
			// an action no base resolves submits nothing, natively: kept as
			// written (the page's own value)
			if (
				unresolvable(
					(element.getAttributeOG('action') ?? element.getAttribute('action'))!,
					this.client.baseURL.toString(),
				)
			) {
				element.setAttribute('action', element.getAttributeOG('action')!);
				return;
			}

			/**
			 * Absolute URL
			 */
			let action: string;
			try {
				action = moduleClient
					.encodingParse(
						(element.getAttributeOG('action') ??
							element.getAttribute('action'))!,
						moduleClient.baseURL.toString(),
					)
					.toString();
			} catch (error) {
				// no URL at all (`https://[`): the form keeps it as written and
				// its submission goes nowhere, as natively (the insertion pass
				// calls this outside the attribute hooks' own guard)
				return;
			}

			const methodIndex = validMethods.indexOf(
				element.getAttribute('method')?.toUpperCase() || '',
			);
			const method = validMethods[methodIndex === -1 ? 0 : methodIndex];

			switch (method) {
				case 'GET':
					element.setAttribute(
						'action',
						routeHTML(
							new StompURL(action, moduleClient.baseURL),
							moduleClient.baseURL,
							moduleClient.config,
							true,
							moduleClient.nestedRoute,
						),
					);
					break;
				case 'POST':
					element.setAttribute(
						'action',
						routeHTML(
							new StompURL(action, moduleClient.baseURL),
							moduleClient.baseURL,
							moduleClient.config,
							false,
							moduleClient.nestedRoute,
						),
					);

					break;
			}
		};

		/** the page's absolute URL for a routed URL attribute, or false without one */
		const originalURL = (attribute: string) => (element: CustomElement) =>
			element.hasAttribute(attribute) &&
			element.getAttribute(attribute) !== '' &&
			moduleClient
				.encodingParse(
					(element.getAttributeOG(attribute) ??
						element.getAttribute(attribute))!,
					moduleClient.baseURL.toString(),
					element,
				)
				.toString();

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
							moduleClient.encodingParse(
								element.getAttribute(attribute)!,
								moduleClient.baseURL.toString(),
							),
							moduleClient.baseURL,
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
		const loads = new LazyWeakMap<
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
			// the clone a document's markup is rewritten on (an inert
			// document's, see Client.load and WriteStream): the parser makes the
			// real element from the markup serialized from it, which gets its
			// copy after the write (writtenLoads). A copy settled here would
			// land on the clone, and the real one would load nothing
			if (element.ownerDocument !== realm.document) {
				loads.delete(element);
				element.removeAttribute(attribute);
				return;
			}
			const resource = new StompURL(
				moduleClient.encodingParse(written, moduleClient.baseURL.toString()),
				moduleClient.baseURL,
			);
			const routedOf = () =>
				routeHTML(
					resource,
					moduleClient.baseURL,
					moduleClient.config,
					false,
					moduleClient.childRoute,
				);
			// the page's object-src (src/csp.ts): the browser refuses and
			// reports what it refuses, where the browser's copy of the policy
			// refuses it too (the copy itself is a blob: URL, which the copy
			// allows wherever the page allows any load)
			const refused = moduleClient.loadRefusal(
				'object-src',
				resource.url,
				true,
			);
			if (refused !== null) {
				loads.delete(element);
				element.setAttribute(attribute, refused);
				return;
			}
			let routed = routedOf();
			// a blob: of the page's is copied like a fetched resource: as it is
			// it would show a document of the proxy's origin, unrewritten
			const fromBlob = resource.url.protocol === 'blob:';
			if (!fromBlob && !ROUTE_PROTOCOLS.includes(resource.url.protocol)) {
				// data: and the like: as routeHTML leaves them
				element.setAttribute(attribute, routed);
				return;
			}
			// mixed content (src/mixedContent.ts): the resource is copied here,
			// never reaching the worker as the element's, so the page's URL
			// decides here. A blocked one fails to load, as natively (an object
			// fires error); an upgraded one loads over https
			const mixed = fromBlob
				? undefined
				: moduleClient
						.getModule(MixedContentModule)
						?.verdict(resource.url, attribute === 'data' ? 'object' : 'embed');
			if (mixed?.action === 'upgrade') {
				resource.url = mixed.url;
				routed = routedOf();
			}
			if (mixed?.action === 'block') {
				// told once: the insertion hooks run this again for the same value
				if (loads.get(element)?.written !== resource.url.href) {
					loads.set(element, {
						written: resource.url.href,
						generation: ++generations,
					});
					moduleClient.getModule(MixedContentModule)!.report(mixed.notices);
				}
				// a load that fails as the blocked one does: an object fires
				// error, an embed nothing (a blob: URL of no origin, never minted;
				// a revoked one of this origin would fire an embed's load)
				element.setAttribute(attribute, 'blob:null/mixed-content-blocked');
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
			// the copy goes out as the load it stands for (loadGrants.ts); a
			// blob: is read at once, as the browser resolves it at the load
			(fromBlob
				? moduleClient.nativeFetch(routeXHR(resource))
				: loadFetch(
						moduleClient,
						new URL(routeXHR(resource), scopePrefix(moduleClient)).href,
						// Chrome loads an object's or embed's resource as a nested
						// context: mode navigate, destination its element
						attribute === 'data' ? 'object navigate' : 'embed navigate',
					)
			)
				.then(async (response) => {
					if (!response.ok && response.status !== 0)
						throw new Error(String(response.status));
					const type = response.headers.get('content-type') ?? '';
					const mime = type.split(';')[0].trim().toLowerCase();
					// an XML document (an SVG, a feed) runs its XHTML scripts too:
					// it gets the XML shell, under its own mime
					const blob =
						mime === 'text/html' || mime === 'application/xhtml+xml'
							? new NativeBlob(
									[
										modifyHTML(
											await response.text(),
											resource,
											moduleClient.config,
											true,
											undefined,
											moduleClient.scriptNonce,
										),
									],
									{ type: 'text/html' },
								)
							: isXMLDocumentMime(mime)
								? new NativeBlob(
										[
											deferred('modifyXML')(
												await response.text(),
												resource,
												moduleClient.config,
												mime,
												undefined,
												undefined,
												false,
												undefined,
												undefined,
												undefined,
												true,
											),
										],
										{ type: `${mime};charset=utf-8` },
									)
								: await response.blob();
					if (loads.get(element) !== state) return;
					if (current?.url?.startsWith('blob:'))
						realm.URL.revokeObjectURL(current.url);
					settle(proxyBlobURL(realm.URL.createObjectURL(blob)));
				})
				.catch(() => settle(routed));
		};
		// the property reads the page's URL from the original alone: the real
		// attribute is absent while the proxied copy loads, then a blob: URL
		const writtenURL = (attribute: string) => (element: CustomElement) => {
			const written = element.getAttributeOG(attribute);
			return written !== null && written !== ''
				? moduleClient
						.encodingParse(written, moduleClient.baseURL.toString(), element)
						.toString()
				: false;
		};
		domHooksModule.useAttributes(proxiedLoad('data'), [
			['OBJECT', 'data'],
			[realm.HTMLObjectElement, 'data', writtenURL('data')],
		]);
		domHooksModule.useAttributes(proxiedLoad('src'), [
			['EMBED', 'src'],
			[realm.HTMLEmbedElement, 'src', writtenURL('src')],
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
										moduleClient.encodingParse(
											token,
											moduleClient.baseURL.toString(),
										),
										moduleClient.baseURL,
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
					realm.HTMLAnchorElement,
					'ping',
					(element) => element.getAttributeOG('ping') ?? false,
				],
				[
					realm.HTMLAreaElement,
					'ping',
					(element) => element.getAttributeOG('ping') ?? false,
				],
			],
		);

		// <video poster>
		domHooksModule.useAttributes(routeAttribute('poster', routeBinary, true), [
			['VIDEO', 'poster'],
			[realm.HTMLVideoElement, 'poster', originalURL('poster')],
		]);

		// background on <body> and a table's parts: the legacy presentational
		// image, which Chrome still loads. body.background reflects the
		// attribute as the page wrote it (no URL resolution). One hook of
		// every element's attribute that routes it on those names (a hook per
		// name cost each frame about 1 KB)
		const routeBackground = routeAttribute('background', routeBinary, true);
		domHooksModule.useAttributes(
			(element) => {
				if (
					element.namespaceURI === HTML_NAMESPACE &&
					' body table thead tbody tfoot tr td th '.includes(
						` ${element.localName} `,
					)
				)
					routeBackground(element);
			},
			[
				['*', 'background'],
				[
					this.client.global.HTMLBodyElement,
					'background',
					(element) => element.getAttributeOG('background') ?? false,
				],
			],
		);

		// <button formaction>, <input formaction>: the form's method decides how
		// the query travels, as for <form action>
		domHooksModule.useAttributes(
			routeAttribute('formaction', (resource) =>
				routeHTML(
					resource,
					moduleClient.baseURL,
					moduleClient.config,
					true,
					moduleClient.nestedRoute,
				),
			),
			[
				['BUTTON', 'formaction'],
				['INPUT', 'formaction'],
				[realm.HTMLButtonElement, 'formAction', originalURL('formaction')],
				[realm.HTMLInputElement, 'formAction', originalURL('formaction')],
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
										moduleClient.encodingParse(
											src.url,
											moduleClient.baseURL.toString(),
										),
										moduleClient.baseURL,
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
					realm.HTMLLinkElement,
					'imageSrcset',
					(element) =>
						element.hasAttribute('imagesrcset') &&
						element.getAttribute('imagesrcset') !== '' &&
						(element.getAttributeOG('imagesrcset') ??
							element.getAttribute('imagesrcset'))!,
				],
			],
		);

		// a child frame's csp or credentialless attribute would put its
		// document outside what the service worker can serve or rewrite:
		// dropped, read back as written. Setting the property
		// (`iframe.credentialless = true`, `iframe.csp = policy`) drops it at
		// once too, so it is not dropped later on insertion, behind attributes
		// the page set after it, and the browser never asks the document for
		// the policy (the worker does: the frame's hints say it, and
		// DocumentClient.requiredCSP reads it); `csp` reads back as written
		const iframePrototype = realm.HTMLIFrameElement.prototype;
		for (const [attribute, property, getter] of [
			['csp', 'csp', (element) => element.getAttributeOG('csp') ?? ''],
			['credentialless', 'credentialless', () => false],
		] as [string, string, (element: CustomElement) => string | false][])
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
					...(Reflect.getOwnPropertyDescriptor(iframePrototype, property)?.set
						? [
								[realm.HTMLIFrameElement, property, getter] as [
									typeof HTMLIFrameElement,
									string,
									typeof getter,
								],
							]
						: []),
				],
			);

		// A child frame's sandbox: as the page wrote it, it would make the
		// document an opaque origin (without allow-same-origin), whose
		// navigations the service worker never sees, or keep the inject from
		// running (without allow-scripts). The page's value is kept in the
		// marker and read back as written; the real attribute is the page's
		// flags plus those two, without the top navigation flags (sandbox.ts),
		// so the browser itself keeps enforcing forms, popups, modals,
		// downloads, pointer lock, presentation and orientation lock, for the
		// frame's own frames and its popups too, from the next navigation on.
		// What it no longer enforces the frame's documents emulate from the
		// marker (DocumentClient.sandboxFlags). A frame whose sandbox takes away
		// scripts gets the script policy on the about:blank it shows now, before
		// the page can write into it. Setting the property
		// (`iframe.sandbox = x` writes through its token list, which no
		// attribute hook sees) applies at once too.
		const contentDocument = Reflect.getOwnPropertyDescriptor(
			iframePrototype,
			'contentDocument',
		)!.get!;
		domHooksModule.useAttributes(
			(element) => {
				element.restoreAttributesOG('sandbox');
				const lists = moduleClient.getModule(TokenListsModule);
				if (!element.hasAttribute('sandbox')) {
					lists?.sync(element, null);
					return;
				}
				const value = element.getAttribute('sandbox')!;
				lists?.sync(element, value);
				element.setAttributeOG('sandbox', value);
				element.setAttribute('sandbox', realSandbox(value));
				if (
					sandboxTokens(value).has('allow-scripts') &&
					moduleClient.allows('allow-scripts')
				)
					return;
				try {
					const child = Reflect.apply(
						contentDocument,
						element,
						[],
					) as Document | null;
					if (child && child.URL === 'about:blank') guardDocument(child);
				} catch (error) {
					// nothing shown yet
				}
			},
			[
				['IFRAME', 'sandbox'],
				...(Reflect.getOwnPropertyDescriptor(iframePrototype, 'sandbox')?.set
					? [
							[realm.HTMLIFrameElement, 'sandbox', () => false] as [
								typeof HTMLIFrameElement,
								string,
								() => false,
							],
						]
					: []),
			],
		);

		domHooksModule.useAttributes(this.formHook, [
			['FORM', 'action'],
			['FORM', 'method'],
			[
				realm.HTMLFormElement,
				'action',
				(element) =>
					element.hasAttribute('action') &&
					element.getAttribute('action') !== '' &&
					moduleClient
						.encodingParse(
							(element.getAttributeOG('action') ??
								element.getAttribute('action'))!,
							moduleClient.baseURL.toString(),
							element,
						)
						.toString(),
			],
			[realm.HTMLFormElement, 'method', () => false],
		]);

		// a base's href resolves against the document's URL, not against the
		// base URL (which client.baseURL follows once a base is in place, and
		// is the page's own base while loadHTML rewrites the markup)
		const documentURL = () => moduleClient.url;
		// A report-only base-uri's refusal is the inject's to report (the base
		// applies): once, for the document's first base, a task later as
		// natively, and for the markup's own once it is parsed (the hook ran
		// on its copy, before the page's scripts could listen)
		const reported = new LazyWeakSet<Element>();
		const reportBase = (element: Element, url: URL) => {
			const global = realm;
			const owner = element.ownerDocument;
			const first = owner.querySelector('base[href]');
			if (reported.has(element) || (first !== element && first !== null))
				return;
			reported.add(element);
			const report = () => moduleClient.reportRefusal('base-uri', url);
			if (owner === global.document) {
				Reflect.apply(setTimeout, global, [report, 0]);
				return;
			}
			// (the markup is written after a document.open, which drops the
			// document's listeners)
			let pending = true;
			addDocumentOpenListener(global, () => {
				if (!pending) return;
				pending = false;
				global.document.addEventListener('DOMContentLoaded', report, {
					once: true,
				});
			});
		};
		// the refusal URL each base was given, for the page's href: a hook
		// that runs again (the base inserted) leaves it, as a write would be
		// another check of the base, and another violation
		const refusedBases = new LazyWeakMap<Element, [string, string]>();
		domHooksModule.useAttributes(
			(element) => {
				const refused = refusedBases.get(element);
				if (
					refused &&
					element.getAttribute('href') === refused[1] &&
					element.getAttributeOG('href') === refused[0]
				)
					return;
				element.restoreAttributesOG('href');

				if (
					element.hasAttribute('href') &&
					element.getAttribute('href') !== ''
				) {
					const document = documentURL();
					element.setAttributeOG('href', element.getAttribute('href')!);
					const url = new URL(
						element.getAttribute('href')!,
						document.toString(),
					);
					// the page's base-uri (src/csp.ts): a base it refuses names a
					// refusal URL the browser's copy refuses, and the browser
					// refuses and reports it as natively (the document's URL stays
					// its base URL); a report-only one's refusal is reported
					const refusals = /^https?:$/.test(url.protocol)
						? moduleClient.pageRefusals('base-uri', url)
						: [];
					if (
						/^https?:$/.test(url.protocol) &&
						moduleClient.baseRefused(url, element)
					) {
						const refusal = moduleClient.refusalURL(
							'https',
							url.href,
							url.href.replace(/#.*$/s, ''),
						);
						refusedBases.set(element, [
							element.getAttributeOG('href')!,
							refusal,
						]);
						element.setAttribute('href', refusal);
						return;
					}
					if (refusals.length) reportBase(element, url);
					element.setAttribute(
						'href',
						routeHTML(
							new StompURL(url, document),
							document,
							moduleClient.config,
							false,
							moduleClient.nestedRoute,
						),
					);
				}
			},
			[
				['BASE', 'href'],
				[
					realm.HTMLBaseElement,
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
