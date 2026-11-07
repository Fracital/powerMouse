import Module from '../../Module';
import ProxyModule, { usePrototype } from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
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
 * source the page wrote rather than the rewritten one that ran.
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
					return this.client.url.url.origin;
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
					return typeof value === 'string'
						? (unrouteURL(this.client, value) ?? value)
						: value;
				}),
			});
		};
		unrouteGetter(global.HashChangeEvent?.prototype, 'oldURL');
		unrouteGetter(global.HashChangeEvent?.prototype, 'newURL');
		unrouteGetter(global.NavigationHistoryEntry?.prototype, 'url');
		unrouteGetter(global.NavigationDestination?.prototype, 'url');
	}
	applyScriptSource() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		const sources = new WeakMap<HTMLScriptElement, ScriptSource>();

		const nativeText = (script: HTMLScriptElement): string =>
			usePrototype(script, nativeHTMLScriptElement, (script) => script.text);
		const parentNodeGet = Reflect.getOwnPropertyDescriptor(
			global.Node.prototype,
			'parentNode',
		)!.get!;

		// the script elements an insertion argument brings along
		const scriptsIn = (node: unknown): HTMLScriptElement[] => {
			if (typeof node !== 'object' || node === null) return [];
			try {
				return usePrototype(node as Node, nativeNode, (native) => {
					if (native.nodeType === 1) {
						if (native.nodeName === 'SCRIPT')
							return [node as HTMLScriptElement];
						return usePrototype(node as Element, nativeElement, (element) => [
							...element.querySelectorAll('script'),
						]);
					}
					if (native.nodeType === 11)
						return usePrototype(
							node as DocumentFragment,
							nativeDocumentFragment,
							(fragment) => [...fragment.querySelectorAll('script')],
						);
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
					if (sources.get(script)?.rewritten !== text)
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
		for (const name of ['append', 'prepend', 'before', 'after', 'replaceWith'])
			wrapInsert(global.Element.prototype, name, all);
		wrapInsert(global.Element.prototype, 'insertAdjacentElement', (args) => [
			args[1],
		]);

		// the source the page wrote, while the element still holds the
		// rewritten text; a script the page edited afterwards reads natively
		const written = (script: HTMLScriptElement): string | undefined => {
			const record = sources.get(script);
			if (
				record &&
				record.written !== record.rewritten &&
				nativeText(script) === record.rewritten
			)
				return record.written;
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

		// serialised markup: the rewritten text of every recorded script in
		// it (the element itself included) replaced by what the page wrote
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
					(target, that: Element, args) => {
						let markup: string = Reflect.apply(target, that, args);
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
					},
				),
			});
		};
		wrapMarkupGetter('innerHTML');
		wrapMarkupGetter('outerHTML');
	}
}
