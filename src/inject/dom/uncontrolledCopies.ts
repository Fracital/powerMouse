// The copies a document no service worker controls makes of its loads
// (./modules/DOMAttributes.ts): an about:blank frame or popup the page
// built, a document it opened, a blob: document. Chrome hands none of them
// to the page's worker, so a load there is fetched through the proxy and
// the element gets a blob: URL of the copy, written underneath the hooks.
// A deferred part of the document bundle (../deferred.ts), made at the
// first load such a document copies; a controlled document never makes it.
// The natives are taken by the module at load and handed over. Without the
// part a load keeps its routed value (which fails as a failed copy does)
// and a style's or a sheet's loads are not copied.
import { proxyBlobURL } from '../../routeURL';
import {
	LOAD_HEADER,
	OPAQUE_COPY_HEADER,
	SEALER_ROUTE,
} from '../../transport/messages';
import { opaqueCopy, opaqueMarked } from '../modules/Fetch';
import { usePrototype } from '../modules/Proxy';
import { scopePrefix, unrouteURL } from '../modules/Unroute';
import { LazyWeakMap, LazyWeakSet } from '../ownCollections';
import { blobLoads, opaqueCopies } from './blobLoads';
import type DocumentClient from './Client';
import type { StyleElement } from './Client';
import { deferred } from './deferred';
import type { DeferredParts } from './deferredParts';
import { loadFetch, loadSource } from './loadGrants';
import { CustomElement, nativeElement } from './modules/DOMHooks';
import { hookWrite } from './modules/MutationObserver';
import { sealedURL } from './sealedCopies';
import type { SealerNatives } from './sealerNatives';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** DOMAttributes' placeLoad, which a copy that failed once calls again */
type PlaceLoad = (
	element: CustomElement,
	attribute: string,
	routed: string,
	urls?: { routed: string; page: string }[] | null,
	compose?: (copies: string[]) => string,
	retried?: boolean,
) => void;

/** the natives DOMAttributes takes at load, before the page or a later hook could replace them */
export interface CopyNatives {
	createObjectURL: typeof URL.createObjectURL;
	revokeObjectURL: typeof URL.revokeObjectURL;
	createElement: Document['createElement'];
	isConnected: () => boolean;
	nativeDeclaration: {
		setProperty: CSSStyleDeclaration['setProperty'];
		getPropertyValue: CSSStyleDeclaration['getPropertyValue'];
		getPropertyPriority: CSSStyleDeclaration['getPropertyPriority'];
		item: CSSStyleDeclaration['item'];
		length: () => number;
	};
	stopImmediate: Event['stopImmediatePropagation'];
	nativeQuery: Document['querySelector'];
	scriptAsync: (() => boolean) | undefined;
	ruleText: () => string;
	nativeRules: {
		sheet: {
			insert: CSSStyleSheet['insertRule'];
			delete: CSSStyleSheet['deleteRule'];
		};
		group: {
			insert: CSSGroupingRule['insertRule'];
			delete: CSSGroupingRule['deleteRule'];
		};
	};
	ruleStyle: () => CSSStyleDeclaration;
	keyframeStyle: (() => CSSStyleDeclaration) | undefined;
	ownerNode: () => unknown;
}

export interface CopyContext {
	moduleClient: DocumentClient;
	realm: typeof globalThis;
	NativeBlob: typeof Blob;
	uncontrolled: () => boolean;
	isRoute: (value: string) => boolean;
	placeLoad: PlaceLoad;
	/** what a sealed copy's URL is made with (./sealerNatives.ts) */
	sealerNatives: SealerNatives;
	/** how the CSSOM pass of each <style> marks a rule it need not redo (DOMAttributes keeps it: it is set whether or not the document is uncontrolled) */
	sheetMarks: WeakMap<StyleElement, (rule: CSSRule) => void>;
	natives: CopyNatives;
}

export function uncontrolledCopies(ctx: CopyContext) {
	const {
		moduleClient,
		realm,
		NativeBlob,
		uncontrolled,
		isRoute,
		placeLoad,
		sealerNatives,
		sheetMarks,
		natives: {
			createObjectURL,
			revokeObjectURL,
			createElement,
			isConnected,
			nativeDeclaration,
			stopImmediate,
			nativeQuery,
			scriptAsync,
			ruleText,
			nativeRules,
			ruleStyle,
			keyframeStyle,
			ownerNode,
		},
	} = ctx;
	// per element and attribute: the routed value the copy is for, and its
	// blob: URL once it is in (a hook that runs again for the same value
	// keeps the copy)
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
			sealerNatives,
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
			for (const url of urls) Reflect.apply(revokeObjectURL, realm.URL, [url]);
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
			routesIn(text).map(async (target) => {
				const load = kinds.get(target) ?? null;
				const page = unrouteURL(moduleClient, target) ?? target;
				const copy = () =>
					copyOf(target, page, state, depth, load, [
						...(fragments.get(target) ?? []),
					]);
				// a font face's source is copied when the browser needs it
				copied.set(
					target,
					(load === 'font cors' && lazyFont(target, page, copy)) ||
						(await copy()),
				);
			}),
		);
		return copied;
	};
	// the part that makes them (./lazyFonts.ts), with what it puts a face
	// back with
	let sentinels: ReturnType<DeferredParts['lazyFonts']> | undefined;
	const lazyFont = (
		...args: Parameters<ReturnType<DeferredParts['lazyFonts']>>
	) => {
		try {
			return (sentinels ??= deferred('lazyFonts')(moduleClient, {
				textOf,
				rules: nativeRules,
				marks: sheetMarks,
			}))(...args);
		} catch (error) {
			// no part: copied at once
			return null;
		}
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
			const value = call(nativeDeclaration.getPropertyValue, [name]) as string;
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
					: // an external <use> document: Chrome's request is an
						// image's of the document's origin only (Chrome 157,
						// blank-load-metadata)
						name === 'use'
						? 'image same-origin'
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
						['image', 'script', 'style', 'audio', 'video', 'track'].includes(as)
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
	/**
	 * A copy's credentials, as the load it stands for has them: a no-cors
	 * load and a `crossorigin=use-credentials` one send them, any other
	 * CORS load (an anonymous one, a font, a module script) only to its
	 * own origin, so an answer that allows any origin (`*`, as Google
	 * Fonts and most CDNs send) passes its CORS check
	 */
	const loadCredentials = (
		load: string | null,
		element: Element | null = null,
	): RequestCredentials => {
		let owner = element;
		if (element?.localName === 'source') {
			const parent = element.parentElement;
			owner =
				parent?.localName === 'picture' ? parent.querySelector('img') : parent;
		}
		return load?.endsWith(' cors') &&
			owner?.getAttribute('crossorigin')?.toLowerCase() !== 'use-credentials'
			? 'same-origin'
			: 'include';
	};
	/** a routed URL's copy, as a blob: URL (the proxy's form) */
	const copyOf = async (
		routed: string,
		page: string,
		state: Copy,
		depth = 4,
		load: string | null = null,
		fragments: string[] | null = null,
		credentials = loadCredentials(load),
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
			{ credentials },
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
		credentials: RequestCredentials = 'include',
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
					credentials,
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
	/** a load attribute's copy (DOMAttributes placeLoad, past its fast path) */
	const placeCopy = (
		element: CustomElement,
		attribute: string,
		routed: string,
		urls: { routed: string; page: string }[] | null,
		compose: (copies: string[]) => string,
		retried: boolean,
		targets: { routed: string; page: string }[],
	) => {
		const perAttribute = copies.get(element);
		const current = perAttribute?.get(attribute);
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
		// a module script's copy is its graph's (./moduleGraph.ts): one that
		// does not load gets a URL that fails, as its load does natively
		const module =
			element.localName === 'script' &&
			loadKind(element, attribute) === 'script cors';
		// markup the page writes: the element here is the clone the markup
		// is rewritten on; the parser makes the real one, which gets its copy
		// after the write (writtenLoads). A classic script is copied at once
		// below. (A module script does not hold up the parser, and one the
		// parser made with no src and no text has not started: it runs once
		// it gets its copy)
		if (moduleClient.writing && (element.localName !== 'script' || module)) {
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
			const load = loadKind(element, attribute);
			const url = syncCopyOf(
				routed,
				targets[0].page,
				state,
				load,
				loadCredentials(load, element),
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
					? module
						? deferred('moduleGraph')(moduleClient).load(
								new URL(routed, scopePrefix(moduleClient)).href,
							)
						: copyOf(
								routed,
								page,
								state,
								4,
								loadKind(element, attribute),
								null,
								loadCredentials(loadKind(element, attribute), element),
							)
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
				settle(
					module
						? `blob:${new URL(scopePrefix(moduleClient)).origin}/0`
						: routed,
				);
				release(state);
			}
		});
	};
	/** an element's inline style, its routes copied into its declaration */
	const copyInline = (element: Element, declaration: CSSStyleDeclaration) =>
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
	const textOf = (rule: CSSRule) => Reflect.apply(ruleText, rule, []) as string;
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
							Reflect.apply(keyframeStyle, keyframe, []) as CSSStyleDeclaration,
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
	const copySheet = (style: StyleElement, mark: (rule: CSSRule) => void) =>
		copyOwned(
			style,
			'sheet',
			() => sheetText(style.sheet),
			(copied) => {
				if (style.sheet) putBack(style.sheet, copied, mark);
			},
		);
	// A sheet whose rules the page changed through the CSSOM in a document
	// no service worker controls (insertRule, addRule, replace,
	// replaceSync, deleteRule, a rule put inside another, a rule's own
	// declarations): the same. A <style>'s sheet is copied as its
	// element's, so the copies go when its text changes; any other (a
	// constructed sheet, a <link>'s, an @import's) holds its own. Once
	// for the writes of a task: a page that builds a sheet rule by rule
	// has it read once.
	const changedSheets = new LazyWeakSet<CSSStyleSheet>();
	const copyRules = (sheet: CSSStyleSheet) => {
		if (!uncontrolled() || changedSheets.has(sheet)) return;
		changedSheets.add(sheet);
		queueMicrotask(() => {
			changedSheets.delete(sheet);
			let style: StyleElement | null;
			try {
				style = moduleClient.styleElement(Reflect.apply(ownerNode, sheet, []));
			} catch (error) {
				return;
			}
			if (style) {
				// the sheet the element has now: one the page kept from before
				// its text changed shows nothing
				if (style.sheet === sheet)
					copySheet(style, sheetMarks.get(style) ?? (() => {}));
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

	return { copies, release, placeCopy, copyInline, copySheet, copyRules };
}

export type UncontrolledCopies = ReturnType<typeof uncontrolledCopies>;
