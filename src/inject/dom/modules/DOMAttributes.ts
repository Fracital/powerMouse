import { parseSrcset, stringifySrcset } from 'srcset';
import {
	restoreCSSValueURLs,
	rewriteCSSValueURLs,
	routeCSS,
} from '../../../cssURLs';
import { handlerMark, keepSource, sourceKey } from '../../../functionSource';
import { modifyHTML, modifyRefresh, routeHTML } from '../../../rewriteHTML';
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
import StompURL from '../../../StompURL';
import {
	LOAD_HEADER,
	OPAQUE_COPY_HEADER,
	SEALER_ROUTE,
} from '../../../transport/messages';
import { dataBody } from '../../../urlShape';
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
import { modifyCSS, modifyJS } from '../../rewriter';
import { blobLoads, opaqueCopies } from '../blobLoads';
import DocumentClient, { type StyleElement } from '../Client';
import { inertDocumentOf } from '../cloneNode';
import { loadFetch, loadSource } from '../loadGrants';
import { responseURLOf } from '../responseDocuments';
import { guardDocument, realSandbox, sandboxTokens } from '../sandbox';
import { sealedURL } from '../sealedCopies';
import { SVG_HREF_INTERFACES } from '../svgReferences';
import DOMHooksModule, {
	CustomElement,
	nativeElement,
	pendingAttributes,
} from './DOMHooks';
import { hookWrite, MARKER } from './MutationObserver';
import NavigationHintModule from './NavigationHint';
import TokenListsModule from './TokenLists';

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
		// before the BlobDocuments module wraps it (it applies after this one)
		const NativeBlob = this.client.global.Blob;

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
			!this.client.controlled &&
			(this.client.opened ||
				this.client.global.location.href === 'about:blank' ||
				this.client.global.location.href === 'about:srcdoc' ||
				this.client.global.location.protocol === 'blob:');
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
		const createElement = this.client.global.Document.prototype.createElement;
		const isConnected = Reflect.getOwnPropertyDescriptor(
			this.client.global.Node.prototype,
			'isConnected',
		)!.get!;
		/** an image the inject keeps, loading `url` in this document; whether it loaded */
		const keep = (url: string, state: Copy): Promise<boolean> =>
			new Promise((resolve) => {
				try {
					const keeper = Reflect.apply(
						createElement,
						this.client.global.document,
						['img'],
					) as HTMLImageElement;
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
				`${new URL(scopePrefix(this.client)).origin}${this.client.directory}${SEALER_ROUTE}`,
			);
			if (dead !== null) {
				if (state.sound !== false) state.sound = primed;
				return dead;
			}
			const url = proxyBlobURL(
				Reflect.apply(createObjectURL, this.client.global.URL, [
					body,
				]) as string,
			);
			if (!(await keep(url, state)))
				Reflect.apply(revokeObjectURL, this.client.global.URL, [url]);
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
					Reflect.apply(revokeObjectURL, this.client.global.URL, [url]);
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
							unrouteURL(this.client, target) ?? target,
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
				if (previous) {
					for (const url of previous.made.splice(0))
						if (shown.has(url)) state.made.push(url);
						else {
							blobLoads.delete(url);
							opaqueCopies.delete(url);
							Reflect.apply(revokeObjectURL, this.client.global.URL, [url]);
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
			fragments: string[] | null = null,
		): Promise<string> => {
			// an SVG reference's fragment names the element in the copy
			const hash = routed.indexOf('#');
			const fragment = hash === -1 ? '' : routed.slice(hash);
			const response = await loadFetch(
				this.client,
				new URL(
					hash === -1 ? routed : routed.slice(0, hash),
					scopePrefix(this.client),
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
					Reflect.apply(createObjectURL, this.client.global.URL, [
						body,
					]) as string,
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
			if (!this.client.workerTransport) return null;
			// the bridge of the client the grant is announced through (it may
			// be of another bundle): its beacon is the request the worker sees
			const from = loadSource();
			const sync = (from?.client as DocumentClient | undefined)?.syncBridge;
			if (!from || !sync) return null;
			try {
				const target = new URL(routed, scopePrefix(this.client)).href;
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
					Reflect.apply(createObjectURL, this.client.global.URL, [
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
				Reflect.apply(revokeObjectURL, this.client.global.URL, [url]);
			}
			state.kept = undefined;
			state.live = undefined;
		};
		const stopImmediate =
			this.client.global.Event.prototype.stopImmediatePropagation;
		const nativeQuery = this.client.global.Document.prototype.querySelector;
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
			const revoke = () =>
				Reflect.apply(revokeObjectURL, this.client.global.URL, [url]);
			const waits = [0, 50, 250, 1000, 5000, 24_000];
			const look = () => {
				let found: Element | null = null;
				try {
					found = Reflect.apply(nativeQuery, this.client.global.document, [
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
			retried = false,
		) => {
			const targets = urls ?? [
				{
					routed,
					page: new URL(
						element.getAttributeOG(attribute) ?? routed,
						this.client.baseURL.toString(),
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
			const inline = this.client.inlineDocument(
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
						this.client.config,
						true,
						undefined,
						this.client.scriptNonce,
					),
				],
				{ type: 'text/html' },
			);
			return proxyBlobURL(this.client.global.URL.createObjectURL(blob));
		};
		const domHooksModule = this.client.getModule(DOMHooksModule)!;
		// whether a document in this frame may run scripts: its own sandbox (as
		// the page wrote it, in the marker) and this document's
		const frameRunsScripts = (element: CustomElement) => {
			const sandbox = element.getAttributeOG('sandbox');
			return (
				this.client.allows('allow-scripts') &&
				(sandbox === null || sandboxTokens(sandbox).has('allow-scripts'))
			);
		};

		// inline event handler attributes are scripts too: `onclick="top.x()"`
		// would reach the real top. Every `on*` the platform knows about, from
		// the prototypes that carry them; one hook watches them all
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
		const ownHandlers = new Map<string, boolean>();
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
					// the browser compiles the code as a function's body: marked,
					// so the function reads back with the page's code in it
					const key = sourceKey(source);
					keepSource(key, source);
					element.setAttribute(
						name,
						handlerMark(key) +
							modifyJS(
								source,
								this.client.baseURL,
								this.client.config,
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
		const svgHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);
			if (!element.hasAttribute(attribute)) return;
			const value = element.getAttribute(attribute)!;
			if (value === '' || value.startsWith('#')) return;
			element.setAttributeOG(attribute, value);
			const routed = routeBinary(
				new StompURL(
					new URL(value, this.client.baseURL.toString()),
					this.client.baseURL,
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
					new URL(value, this.client.baseURL.toString()),
					this.client.baseURL,
				),
				this.client.baseURL,
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
			if (this.client.sandboxFlags !== null) return;
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
			[this.client.global.HTMLAnchorElement, 'target', ogOrFalse('target')],
			[this.client.global.HTMLAreaElement, 'target', ogOrFalse('target')],
			[this.client.global.HTMLFormElement, 'target', ogOrFalse('target')],
			[this.client.global.HTMLBaseElement, 'target', ogOrFalse('target')],
		]);
		domHooksModule.useAttributes(targetHook('formtarget'), [
			['BUTTON', 'formtarget'],
			['INPUT', 'formtarget'],
			[
				this.client.global.HTMLButtonElement,
				'formTarget',
				ogOrFalse('formtarget'),
			],
			[
				this.client.global.HTMLInputElement,
				'formTarget',
				ogOrFalse('formtarget'),
			],
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
							this.client.baseURL,
							this.client.config,
							false,
							undefined,
							this.client.scriptNonce,
						),
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

		const linkHook = (attribute: string) => (element: CustomElement) => {
			element.restoreAttributesOG(attribute);

			if (
				element.hasAttribute(attribute) &&
				element.getAttribute(attribute) !== ''
			) {
				element.setAttributeOG(attribute, element.getAttribute(attribute)!);
				element.setAttribute(
					attribute,
					this.client.linkRoute(
						new StompURL(
							new URL(
								element.getAttribute(attribute)!,
								this.client.baseURL.toString(),
							),
							this.client.baseURL,
						),
					),
				);
			}
		};
		// an SVG link's legacy xlink:href is a link as much as its href: a
		// javascript: URL in it ran as the page wrote it
		domHooksModule.useAttributes(linkHook('xlink:href'), [['a', 'xlink:href']]);
		// An SVG animation of a link's href (<set attributeName="href"
		// to="javascript:...">, <animate values="...">) makes its values the
		// link's while it runs: they are routed the way the attribute itself
		// is, the link's as a link (which rewrites a javascript: URL's code),
		// any other reference's as the file it loads. The animation's target is
		// the element its own href names, else its parent; a value written
		// before either is known is routed when it is a javascript: URL (no
		// reference runs one unrewritten).
		const ANIMATED = ['to', 'from', 'by', 'values'];
		const animatedTarget = (element: CustomElement): Element | null => {
			const reference =
				element.getAttribute('href') ?? element.getAttribute('xlink:href');
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
			if (name !== 'href' && name !== 'xlink:href') return;
			const target = animatedTarget(element);
			const link = target ? target.localName === 'a' : null;
			const route = (value: string): string => {
				const trimmed = value.trim();
				if (trimmed === '' || trimmed.startsWith('#')) return value;
				try {
					const url = new StompURL(
						new URL(trimmed, this.client.baseURL.toString()),
						this.client.baseURL,
					);
					// (a link's route rewrites a javascript: URL's code)
					if (link === true || url.url.protocol === 'javascript:')
						return this.client.linkRoute(url);
					return link === false ? routeBinary(url) : value;
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
				element.setAttributeOG(attribute, value);
				element.setAttribute(attribute, routed);
			}
		};
		domHooksModule.useAttributes(
			animatedHook,
			['set', 'animate'].flatMap((tag) =>
				[...ANIMATED, 'attributeName'].map((attribute): [string, string] => [
					tag,
					attribute,
				]),
			),
		);

		domHooksModule.useAttributes(
			linkHook('href'),
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
							responseURLOf(element) ?? this.client.baseURL.toString(),
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
							responseURLOf(element) ?? this.client.baseURL.toString(),
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
									this.client.baseURL.toString(),
								),
								this.client.baseURL,
							),
							this.client.baseURL,
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
							this.client.baseURL.toString(),
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
						new URL(
							element.getAttribute('href')!,
							this.client.baseURL.toString(),
						),
						this.client.baseURL,
					);
					element.setAttributeOG('href', element.getAttribute('href')!);
					if (rel.has('manifest')) element.removeAttribute('href');
					else if (
						rel.has('stylesheet') ||
						((rel.has('preload') || rel.has('prefetch')) && as === 'style')
					)
						placeLoad(element, 'href', routeCSS(resource, this.client.baseURL));
					else if (rel.has('modulepreload'))
						placeLoad(
							element,
							'href',
							routeJS(
								resource,
								this.client.baseURL,
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
							routeJS(
								resource,
								this.client.baseURL,
								this.client.config,
								'generic',
							),
						);
					else placeLoad(element, 'href', routeBinary(resource));
				}
			},
			[
				['LINK', 'href'],
				['LINK', 'rel'],
				['LINK', 'as'],
				[this.client.global.HTMLLinkElement, 'as', () => false],
				[
					this.client.global.HTMLLinkElement,
					'href',
					(element) =>
						element.hasAttribute('href') &&
						element.getAttribute('href') !== '' &&
						new URL(
							(element.getAttributeOG('href') ?? element.getAttribute('href'))!,
							responseURLOf(element) ?? this.client.baseURL.toString(),
						).toString(),
				],
				[this.client.global.HTMLLinkElement, 'rel', () => false],
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
						new URL(
							element.getAttribute('src')!,
							this.client.baseURL.toString(),
						),
						this.client.baseURL,
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
					const opaque = opaqueDocument(resource);
					if (opaque) this.client.opaqueFrames.add(element);
					else this.client.opaqueFrames.delete(element);
					// the frame navigates for this document, under its activation,
					// with its element's allow attribute as its container policy
					// (the worker's client hints for the frame read it)
					if (!opaque)
						this.client
							.getModule(NavigationHintModule)
							?.hint(
								resource.url.href,
								element.nodeName === 'IFRAME'
									? (element.getAttribute('allow') ?? undefined)
									: undefined,
							);
					element.setAttribute(
						'src',
						opaque ??
							routeHTML(
								resource,
								this.client.baseURL,
								this.client.config,
								false,
								// with the host's page cross-origin isolated, the
								// route says whom the frame's `allow` lets be, and
								// whether the frame is a credentialless one (the
								// attribute itself is kept from the browser, below)
								this.client.hostIsolated
									? this.client.childRouteFor(
											element.getAttribute('allow'),
											resource.url.origin,
											element.hasAttributeOG('credentialless') ||
												element.hasAttribute('credentialless'),
										)
									: this.client.childRoute,
							),
					);
				}
			},
			[
				['IFRAME', 'src'],
				['FRAME', 'src'],
				// what the route says of the frame (an isolated host only)
				...(this.client.hostIsolated
					? ([
							['IFRAME', 'allow'],
							['IFRAME', 'credentialless'],
						] as [string, string][])
					: []),
				[
					this.client.global.HTMLFrameElement,
					'src',
					(element) =>
						element.hasAttribute('src') &&
						element.getAttribute('src') !== '' &&
						new URL(
							(element.getAttributeOG('src') ?? element.getAttribute('src'))!,
							this.client.baseURL.toString(),
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
							this.client.baseURL.toString(),
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
								this.client.reportAcceptCH(parseAcceptCH(content) ?? []);
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
									this.client.baseURL,
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
									this.client.baseURL.toString(),
								),
								this.client.baseURL,
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
							this.client.baseURL.toString(),
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
							this.client.baseURL.toString(),
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
							url: routeImageSet(
								new StompURL(
									new URL(src.url, this.client.baseURL.toString()),
									this.client.baseURL,
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
							page: new URL(parsed[index].url, this.client.baseURL.toString())
								.href,
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
									this.client.baseURL.toString(),
								),
								this.client.baseURL,
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
							this.client.baseURL.toString(),
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
							this.client.baseURL.toString(),
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
							this.client.baseURL.toString(),
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
						this.client.baseURL,
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
					// a style the browser serialised from a CSSOM write (a copy of
					// such an element, inserted) holds routes: the page's is the
					// browser's serialisation of the url()s it wrote
					element.setAttributeOG(
						'style',
						unrouteCSS(this.client, element.getAttribute('style')!, true),
					);
					element.setAttribute(
						'style',
						modifyCSS(
							(element.getAttributeOG('style') ??
								element.getAttribute('style'))!,
							this.client.baseURL,
							'declarationList',
						),
					);
				}
				copyInlineSoon(element);
			},
			[
				['*', 'style'],
				[this.client.global.HTMLElement, 'style', () => false],
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
				this.client.global.CSSRule.prototype,
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

			// One property's value. A url() token is found as it stands; a URL
			// named any other way (a string of image-set() or src(), a url(
			// spelled with an escape) takes the parser, which reads the value
			// as a declaration's
			const AS_DECLARATION = 'content:';
			const rewriteValue = (value: unknown) => {
				if (typeof value !== 'string') return value;
				if (/image-set|src\(|\\/i.test(value))
					try {
						const routed = modifyCSS(
							AS_DECLARATION + value,
							this.client.baseURL,
							'declarationList',
						);
						if (routed.startsWith(AS_DECLARATION))
							return routed.slice(AS_DECLARATION.length);
					} catch (error) {
						// not a value the parser takes: the url() tokens it has
					}
				return value.includes('url(')
					? rewriteCSSValueURLs(value, this.client.baseURL)
					: value;
			};

			const rewriteCssText = (value: unknown) => {
				try {
					return modifyCSS(
						String(value),
						this.client.baseURL,
						'declarationList',
					);
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
			// a computed style's url() is absolute, natively: the real URL its
			// route stands for
			const computedDeclarations = new WeakSet<CSSStyleDeclaration>();
			const restore = (target: CSSStyleDeclaration, value: string) =>
				computedDeclarations.has(target)
					? restoreCSSValueURLs(value, (routed) =>
							computedURL(this.client, routed),
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

			for (const ctor of [
				this.client.global.HTMLElement,
				this.client.global.SVGElement,
			]) {
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
			this.client.global.getComputedStyle = proxyModule.wrapFunction(
				this.client.global.getComputedStyle,
				(target, that, args) => {
					const declaration = Reflect.apply(target, that, args);
					if (declaration && typeof declaration === 'object')
						computedDeclarations.add(declaration);
					return wrapDeclaration(declaration);
				},
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
			// a style rule's styleMap: a write there changes the rule
			const mapRules = new WeakMap<object, object>();
			{
				const descriptor = Reflect.getOwnPropertyDescriptor(
					this.client.global.CSSStyleRule.prototype,
					'styleMap',
				);
				if (descriptor?.get)
					Reflect.defineProperty(
						this.client.global.CSSStyleRule.prototype,
						'styleMap',
						{
							...descriptor,
							get: proxyModule.wrapFunction(
								descriptor.get,
								(target, that, args) => {
									const map = Reflect.apply(target, that, args);
									if (map && typeof map === 'object') mapRules.set(map, that);
									return map;
								},
							),
						},
					);
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
											this.client.baseURL,
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
		const keyframeStyle = Reflect.getOwnPropertyDescriptor(
			this.client.global.CSSKeyframeRule?.prototype ?? {},
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
			this.client.global.StyleSheet.prototype,
			'ownerNode',
		)!.get!;
		const changedSheets = new WeakSet<CSSStyleSheet>();
		this.copyRules = (sheet) => {
			if (!uncontrolled() || changedSheets.has(sheet)) return;
			changedSheets.add(sheet);
			queueMicrotask(() => {
				changedSheets.delete(sheet);
				let style: StyleElement | null;
				try {
					style = this.client.styleElement(Reflect.apply(ownerNode, sheet, []));
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
		const nativeQueryAll =
			this.client.global.Document.prototype.querySelectorAll;
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
		this.client.writtenLoads = (document) => {
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
				this.client.baseURL.toString(),
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
							new StompURL(action, this.client.baseURL),
							this.client.baseURL,
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
							new StompURL(action, this.client.baseURL),
							this.client.baseURL,
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
				this.client.baseURL.toString(),
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
								this.client.baseURL.toString(),
							),
							this.client.baseURL,
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
			// the clone a document's markup is rewritten on (an inert
			// document's, see Client.load and WriteStream): the parser makes the
			// real element from the markup serialized from it, which gets its
			// copy after the write (writtenLoads). A copy settled here would
			// land on the clone, and the real one would load nothing
			if (element.ownerDocument !== this.client.global.document) {
				loads.delete(element);
				element.removeAttribute(attribute);
				return;
			}
			const resource = new StompURL(
				new URL(written, this.client.baseURL.toString()),
				this.client.baseURL,
			);
			const routedOf = () =>
				routeHTML(
					resource,
					this.client.baseURL,
					this.client.config,
					false,
					this.client.childRoute,
				);
			let routed = routedOf();
			if (!ROUTE_PROTOCOLS.includes(resource.url.protocol)) {
				// data:, blob: and the like: as routeHTML leaves them
				element.setAttribute(attribute, routed);
				return;
			}
			// mixed content (src/mixedContent.ts): the resource is copied here,
			// never reaching the worker as the element's, so the page's URL
			// decides here. A blocked one fails to load, as natively (an object
			// fires error); an upgraded one loads over https
			const mixed = this.client
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
					this.client.getModule(MixedContentModule)!.report(mixed.notices);
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
			// the copy goes out as the load it stands for (loadGrants.ts)
			loadFetch(
				this.client,
				new URL(routeXHR(resource), scopePrefix(this.client)).href,
				// Chrome loads an object's or embed's resource as a nested
				// context: mode navigate, destination its element
				attribute === 'data' ? 'object navigate' : 'embed navigate',
			)
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
										undefined,
										this.client.scriptNonce,
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
				? new URL(written, this.client.baseURL.toString()).toString()
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
										new URL(token, this.client.baseURL.toString()),
										this.client.baseURL,
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
			[this.client.global.HTMLVideoElement, 'poster', originalURL('poster')],
		]);

		// <button formaction>, <input formaction>: the form's method decides how
		// the query travels, as for <form action>
		domHooksModule.useAttributes(
			routeAttribute('formaction', (resource) =>
				routeHTML(
					resource,
					this.client.baseURL,
					this.client.config,
					true,
					this.client.nestedRoute,
				),
			),
			[
				['BUTTON', 'formaction'],
				['INPUT', 'formaction'],
				[
					this.client.global.HTMLButtonElement,
					'formAction',
					originalURL('formaction'),
				],
				[
					this.client.global.HTMLInputElement,
					'formAction',
					originalURL('formaction'),
				],
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
										new URL(src.url, this.client.baseURL.toString()),
										this.client.baseURL,
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

		// a child frame's csp or credentialless attribute would put its
		// document outside what the service worker can serve or rewrite:
		// dropped, read back as written. Setting the property
		// (`iframe.credentialless = true`) drops it at once too, so it is not
		// dropped later on insertion, behind attributes the page set after it.
		// Not `csp`: the property hook applies a string property's value again,
		// which would bring the attribute back
		const iframePrototype = this.client.global.HTMLIFrameElement.prototype;
		for (const [attribute, property] of [
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
				const lists = this.client.getModule(TokenListsModule);
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
					this.client.allows('allow-scripts')
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
							[
								this.client.global.HTMLIFrameElement,
								'sandbox',
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
						this.client.baseURL.toString(),
					).toString(),
			],
			[this.client.global.HTMLFormElement, 'method', () => false],
		]);

		// a base's href resolves against the document's URL, not against the
		// base URL (which client.baseURL follows once a base is in place, and
		// is the page's own base while loadHTML rewrites the markup)
		const documentURL = () => this.client.url;
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
