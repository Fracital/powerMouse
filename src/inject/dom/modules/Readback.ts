import Module from '../../Module';
import ProxyModule, { usePrototype } from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import { blobLoads } from '../blobLoads';
import DocumentClient from '../Client';
import {
	nativeDocumentFragment,
	nativeHTMLScriptElement,
} from './DOMContentHooks';
import { nativeElement, nativeNode } from './DOMHooks';

/** what the page wrote into a script, and what the rewriter made of it */
interface ScriptSource {
	written: string;
	rewritten: string;
}

/**
 * What a page reads back about itself is its own, never the route:
 * document.documentURI and window.origin agree with document.URL and
 * location, hashchange oldURL/newURL and the Navigation API's entry and
 * destination URLs are the page's, and a script element the page inserted
 * reads back (text, textContent, innerHTML, outerHTML, its text node) the
 * source the page wrote rather than the rewritten one that ran (an SVG
 * script its textContent).
 */
export default class ReadbackModule extends Module<DocumentClient> {
	apply() {
		this.applyURLs();
		this.applyScriptSource();
	}
	applyURLs() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global as typeof globalThis &
			Record<string, any>;

		const documentURI = Reflect.getOwnPropertyDescriptor(
			global.Document.prototype,
			'documentURI',
		)!;
		Reflect.defineProperty(global.Document.prototype, 'documentURI', {
			...documentURI,
			get: proxyModule.wrapFunction(documentURI.get!, (target, that, args) => {
				// the native getter only throws for a non-document
				Reflect.apply(target, that, args);
				return this.client.location.toString();
			}),
		});

		// an own accessor of the window, like location
		const origin = Reflect.getOwnPropertyDescriptor(global, 'origin');
		if (origin?.get)
			Reflect.defineProperty(global, 'origin', {
				...origin,
				get: proxyModule.wrapFunction(origin.get, (target, that, args) => {
					Reflect.apply(target, that, args);
					return this.client.origin;
				}),
			});

		// a routed URL the browser stored comes back as the page's
		const unrouteGetter = (target: object | undefined, key: string) => {
			if (!target) return;
			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
			if (!descriptor?.get) return;
			Reflect.defineProperty(target, key, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (get, that, args) => {
					const value = Reflect.apply(get, that, args);
					if (typeof value !== 'string') return value;
					// a copy the inject loaded for a document no worker controls
					const copied = blobLoads.get(value);
					if (copied !== undefined) return copied;
					return unrouteURL(this.client, value) ?? value;
				}),
			});
		};
		unrouteGetter(global.HashChangeEvent?.prototype, 'oldURL');
		unrouteGetter(global.HashChangeEvent?.prototype, 'newURL');
		unrouteGetter(global.NavigationHistoryEntry?.prototype, 'url');
		unrouteGetter(global.NavigationDestination?.prototype, 'url');
		// the candidate the browser picked from src / srcset, as the page wrote it
		unrouteGetter(global.HTMLImageElement?.prototype, 'currentSrc');
		unrouteGetter(global.HTMLMediaElement?.prototype, 'currentSrc');
	}
	applyScriptSource() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		const sources = new WeakMap<HTMLScriptElement, ScriptSource>();

		const HTML = 'http://www.w3.org/1999/xhtml';
		const SVG = 'http://www.w3.org/2000/svg';
		// an SVG script has no `text`: its source is its textContent
		const nativeText = (script: HTMLScriptElement): string =>
			usePrototype(script, nativeElement, (element) => element.namespaceURI) ===
			HTML
				? usePrototype(script, nativeHTMLScriptElement, (script) => script.text)
				: (usePrototype(script, nativeNode, (node) => node.textContent) ?? '');
		const parentNodeGet = Reflect.getOwnPropertyDescriptor(
			global.Node.prototype,
			'parentNode',
		)!.get!;

		// the script elements (HTML or SVG) an insertion argument brings along
		const isScript = (element: Element) =>
			usePrototype(
				element,
				nativeElement,
				(element) =>
					element.localName === 'script' &&
					(element.namespaceURI === HTML || element.namespaceURI === SVG),
			);
		const scriptsIn = (node: unknown): HTMLScriptElement[] => {
			if (typeof node !== 'object' || node === null) return [];
			try {
				return usePrototype(node as Node, nativeNode, (native) => {
					if (native.nodeType === 1) {
						if (isScript(node as Element)) return [node as HTMLScriptElement];
						return usePrototype(node as Element, nativeElement, (element) =>
							[...element.querySelectorAll('script')].filter(isScript),
						) as HTMLScriptElement[];
					}
					if (native.nodeType === 11)
						return usePrototype(
							node as DocumentFragment,
							nativeDocumentFragment,
							(fragment) =>
								[...fragment.querySelectorAll('script')].filter(isScript),
						) as HTMLScriptElement[];
					return [];
				});
			} catch (error) {
				return [];
			}
		};

		// Our wrapper runs outside DOMContentHooks' (registered later, so
		// wrapped last): the text before the call is what the page wrote, the
		// text after is what the rewriter made of it. A script whose text is
		// unchanged since the last insertion (a rewritten script moved) keeps
		// its record.
		const recordAround = <T>(nodes: unknown[], call: () => T): T => {
			const pending: [HTMLScriptElement, string][] = [];
			for (const node of nodes)
				for (const script of scriptsIn(node)) {
					const text = nativeText(script);
					// a record of a script that was not rewritten (inserted into a
					// detached fragment first) is no reason to skip it
					const record = sources.get(script);
					if (
						!record ||
						record.written === record.rewritten ||
						record.rewritten !== text
					)
						pending.push([script, text]);
				}
			try {
				return call();
			} finally {
				for (const [script, written] of pending)
					sources.set(script, { written, rewritten: nativeText(script) });
			}
		};
		const wrapInsert = (
			prototype: object,
			name: string,
			pick: (args: any[]) => unknown[],
		) => {
			const fn = (prototype as Record<string, any>)[name];
			if (typeof fn !== 'function') return;
			(prototype as Record<string, any>)[name] = proxyModule.wrapFunction(
				fn,
				(target, that, args) =>
					recordAround(pick(args), () => Reflect.apply(target, that, args)),
			);
		};
		const first = (args: any[]) => [args[0]];
		const all = (args: any[]) => args;
		wrapInsert(global.Node.prototype, 'appendChild', first);
		wrapInsert(global.Node.prototype, 'insertBefore', first);
		wrapInsert(global.Node.prototype, 'replaceChild', first);
		for (const name of [
			'append',
			'prepend',
			'before',
			'after',
			'replaceWith',
			'replaceChildren',
		])
			wrapInsert(global.Element.prototype, name, all);
		// markup the page writes (document.write) is re-created into a
		// fragment, whose scripts are rewritten as they land in it
		for (const prototype of [
			global.DocumentFragment.prototype,
			global.Document.prototype,
		])
			for (const name of ['append', 'prepend', 'replaceChildren'])
				wrapInsert(prototype, name, all);
		wrapInsert(global.Element.prototype, 'insertAdjacentElement', (args) => [
			args[1],
		]);

		// the source the page wrote, while the element still holds the
		// rewritten text; a script the page edited afterwards reads natively
		const written = (script: HTMLScriptElement): string | undefined => {
			const record = sources.get(script);
			if (!record) return;
			const text = nativeText(script);
			if (record.written !== record.rewritten)
				return text === record.rewritten ? record.written : undefined;
			// recorded before the hooks rewrote it where no wrapper here saw
			// (markup a hook parses and inserts itself: insertAdjacentHTML)
			const rewritten = this.client.rewrittenScripts.get(script);
			if (
				rewritten !== undefined &&
				rewritten !== record.written &&
				text === rewritten
			) {
				sources.set(script, { written: record.written, rewritten });
				return record.written;
			}
		};
		// the recorded script `that` reads from: itself, or its text node
		const scriptOf = (that: unknown): HTMLScriptElement | undefined => {
			if (typeof that !== 'object' || that === null) return;
			if (sources.has(that as HTMLScriptElement))
				return that as HTMLScriptElement;
			try {
				const parent = Reflect.apply(
					parentNodeGet,
					that,
					[],
				) as HTMLScriptElement | null;
				if (parent && sources.has(parent)) return parent;
			} catch (error) {
				// not a node
			}
		};
		const wrapTextGetter = (prototype: object, key: string) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
			if (!descriptor?.get) return;
			Reflect.defineProperty(prototype, key, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					const value = Reflect.apply(target, that, args);
					const script = scriptOf(that);
					if (!script || typeof value !== 'string') return value;
					const source = written(script);
					// the text node holds the whole rewritten script
					return source !== undefined &&
						value === sources.get(script)!.rewritten
						? source
						: value;
				}),
			});
		};
		wrapTextGetter(global.Node.prototype, 'textContent');
		wrapTextGetter(global.Node.prototype, 'nodeValue');
		wrapTextGetter(global.CharacterData.prototype, 'data');
		wrapTextGetter(global.HTMLScriptElement.prototype, 'text');
		// Chrome (Trusted Types) gives scripts their own textContent and
		// innerText accessors, which shadow the ones on Node and HTMLElement
		wrapTextGetter(global.HTMLScriptElement.prototype, 'textContent');
		wrapTextGetter(global.HTMLScriptElement.prototype, 'innerText');

		// a connected script's text set by the page runs at once, rewritten by
		// the setter (prepareScriptText): what it was given is what it wrote
		const isScriptNode = (that: unknown): that is HTMLScriptElement => {
			try {
				return (
					typeof that === 'object' &&
					that !== null &&
					usePrototype(that as Node, nativeNode, (node) => node.nodeType) ===
						1 &&
					isScript(that as Element)
				);
			} catch (error) {
				return false;
			}
		};
		const wrapTextSetter = (prototype: object, key: string) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
			if (!descriptor?.set) return;
			Reflect.defineProperty(prototype, key, {
				...descriptor,
				set: proxyModule.wrapFunction(descriptor.set, (target, that, args) => {
					const result = Reflect.apply(target, that, args);
					if (isScriptNode(that)) {
						// unchanged (detached, or the running script restoring its
						// source): recorded as written, for a rewrite on insertion
						sources.set(that, {
							written: String(args[0]),
							rewritten: nativeText(that),
						});
					}
					return result;
				}),
			});
		};
		wrapTextSetter(global.HTMLScriptElement.prototype, 'text');
		wrapTextSetter(global.Node.prototype, 'textContent');
		wrapTextSetter(global.HTMLScriptElement.prototype, 'textContent');

		// serialised markup: the rewritten text of every recorded script in
		// it (the element itself included) replaced by what the page wrote
		const restoreScripts = (that: Element, markup: string): string => {
			for (const script of scriptsIn(that)) {
				const source = written(script);
				if (source === undefined) continue;
				const { rewritten } = sources.get(script)!;
				const index = markup.indexOf(rewritten);
				if (index === -1) continue;
				markup =
					markup.slice(0, index) +
					source +
					markup.slice(index + rewritten.length);
			}
			return markup;
		};
		const wrapMarkupGetter = (key: string) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				global.Element.prototype,
				key,
			);
			if (!descriptor?.get) return;
			Reflect.defineProperty(global.Element.prototype, key, {
				...descriptor,
				get: proxyModule.wrapFunction(
					descriptor.get,
					(target, that: Element, args) =>
						restoreScripts(that, Reflect.apply(target, that, args)),
				),
			});
		};
		wrapMarkupGetter('innerHTML');
		wrapMarkupGetter('outerHTML');
		// getHTML is a method: the same for what it returns
		const getHTML = (global.Element.prototype as { getHTML?: unknown }).getHTML;
		if (typeof getHTML === 'function')
			(global.Element.prototype as { getHTML: unknown }).getHTML =
				proxyModule.wrapFunction(
					getHTML as (options?: unknown) => string,
					(target, that: Element, args) =>
						restoreScripts(that, Reflect.apply(target, that, args) as string),
				);
	}
}
