import { parseConfig } from '../../../config';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { addClientModules } from '../document';
import { pageSandbox, sandboxTokens } from '../sandbox';
import ContextModule, { initialBlank, isStomp } from './Context';
import { nativeElement } from './DOMHooks';
import { MARKER } from './MutationObserver';

export default class IFrameModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const injectContext = (context: typeof globalThis) => {
			if (this.client.names.client in context) return;

			const client = new DocumentClient(
				parseConfig(this.client.config, this.client.codec.key),
				context,
			);

			addClientModules(client);

			Reflect.defineProperty(context, this.client.names.client, {
				value: client,
				configurable: false,
				enumerable: false,
			});
		};

		// a javascript: URL a frame navigates to runs in the frame's own
		// window: an iframe's initial about:blank, which nothing injected when
		// the page never read its contentWindow (`iframe.src = 'javascript:...'`
		// on a fresh frame). Only a child of this page, so a page cannot have
		// another document's window injected with its bundle
		this.client.injectChild = (context) => {
			if (Reflect.get(context, 'parent') !== (this.client.global as unknown))
				return;
			injectContext(context);
			const client = (context as Record<string, any>)[this.client.names.client];
			if (!client.applied) client.apply();
		};

		const windowModule = this.client.getModule(ContextModule)!;

		// a popup the page opens without a URL (about:blank) is a document
		// nobody fetched: inject it like a child frame, so what the page writes
		// into it is rewritten; the page gets the window as a top-level page
		// would. Wraps the DOMHooks hook, which routed the URL (or handed a
		// tab to the host and returned null).
		this.client.global.open = proxyModule.wrapFunction(
			this.client.global.open,
			(target, that, args) => {
				const page = args[0];
				const opened = Reflect.apply(target, that, args) as
					typeof globalThis | null;
				if (!opened) return opened;
				// a window this page opened it may navigate, sandboxed or not (whether
				// it is held as itself is decided where it is handed out)
				this.client.openedWindows.add(opened);
				try {
					if (opened.location.href === 'about:blank') {
						injectContext(opened);
						if (
							!(opened as Record<string, any>)[this.client.names.client]!
								.applied
						)
							(opened as Record<string, any>)[
								this.client.names.client
							]!.apply();
					}
				} catch (error) {
					// cross-origin: not ours to inject
				}
				// the window as the page may hold it: one of its own origin as
				// itself, wherever it navigates later (its messages' source is
				// this object), one of another site (an existing frame by name,
				// or one whose next document is the URL given) restricted
				if (!isStomp(opened, this.client.names.client)) {
					windowModule.hold(opened);
					return opened;
				}
				return windowModule.pending(opened, page);
			},
		);

		// the document an embedding element hands out, as its window is: the
		// document of a window this page may hold as itself, null for one of
		// another site (the browser's own answer across origins)
		const reachableDocument = (document: Document | null) => {
			if (!document) return document;
			const view = document.defaultView as typeof globalThis | null;
			if (!view) return document;
			const reached = windowModule.newRestricted(view);
			return windowModule.restrictedContexts.has(reached) ? null : document;
		};
		const hookSVGDocument = (prototype: object, native: Function) =>
			Reflect.defineProperty(prototype, 'getSVGDocument', {
				configurable: true,
				enumerable: true,
				writable: true,
				value: proxyModule.wrapFunction(native, (target, that, args) =>
					reachableDocument(Reflect.apply(target, that, args)),
				),
			});
		// <embed> has no contentWindow, only this
		const embed = this.client.global.HTMLEmbedElement?.prototype as
			{ getSVGDocument?: unknown } | undefined;
		if (embed && typeof embed.getSVGDocument === 'function')
			hookSVGDocument(embed, embed.getSVGDocument);

		// a frame whose document is an opaque origin natively: the page
		// sandboxed it without allow-same-origin (its value is in the marker),
		// or this document is opaque itself. Never injected from this side (its
		// own shell injects it), restricted like a frame of another origin
		const sandboxedOpaque = (element: Element) => {
			if (this.client.sandboxedOpaque) return true;
			const sandbox = pageSandbox(element, MARKER);
			return (
				sandbox !== null && !sandboxTokens(sandbox).has('allow-same-origin')
			);
		};

		// A child window still on its initial about:blank runs nothing of
		// ours, and the page can reach it without a read the inject mediates
		// (a literal name, `frames.x`; a native copy of the window's
		// children): its own natives then hand the page what the hooks would
		// not, its evaluator above all, which runs code with the browser's
		// `top`. So every frame is injected as it connects, as reading its
		// contentWindow injects it: from every insertion hook and markup
		// setter, from the preamble of every parser-inserted inline script
		// (the parser runs it inside the write that made the frame), and from
		// an observer for the rest (records arrive before the next task). A
		// walk of the window's children, so its cost is the number of frames,
		// not the size of what was inserted.
		// whether a frame element names a document of its own to load (the
		// real attribute: a hook writes routes and markers into it)
		const loadsDocument = (element: Element): boolean => {
			for (const attribute of ['src', 'srcdoc', 'data']) {
				const value = Reflect.apply(nativeElement.getAttribute, element, [
					attribute,
				]) as string | null;
				if (
					value !== null &&
					value !== '' &&
					!(attribute !== 'srcdoc' && /^\s*about:blank\s*$/i.test(value))
				)
					return true;
			}
			return false;
		};
		const sweepChild = (context: typeof globalThis) => {
			try {
				if (this.client.names.client in context || !initialBlank(context))
					return;
				const element = Reflect.get(context, 'frameElement') as Element | null;
				if (
					element &&
					(this.client.opaqueFrames.has(element) ||
						sandboxedOpaque(element) ||
						// a frame on its way to a document (a src, a srcdoc) is
						// about to leave its about:blank: the browser keeps the
						// Window for a document of this origin, and that document
						// would run this page's client, not its own. The page
						// reaches it as the frame of its next document, which its
						// own shell injects (a read of contentWindow before then
						// still injects it, as it always did)
						loadsDocument(element))
				)
					return;
				if (Reflect.get(context, 'parent') !== (this.client.global as unknown))
					return;
			} catch (error) {
				// a window of another real origin, or one being torn down
				return;
			}
			injectContext(context);
			const client = (context as Record<string, any>)[this.client.names.client];
			if (client && !client.applied) client.apply();
		};
		const global = this.client.global;
		this.client.sweepFrames = () => {
			// a document that runs no script of the page (a sandbox without
			// allow-scripts) has no code that could reach a child's realm, and
			// a client in the child would guard that child's own document
			if (!this.client.allows('allow-scripts')) return;
			const count = global.length;
			for (let index = 0; index < count; index++) {
				let child: typeof globalThis | undefined;
				try {
					child = (global as unknown as Record<number, typeof globalThis>)[
						index
					];
				} catch (error) {
					continue;
				}
				if (child) sweepChild(child);
			}
		};
		// the native observer: the MutationObserver module wraps the page's,
		// and is added after this one
		const NativeMutationObserver = global.MutationObserver;
		if (typeof NativeMutationObserver === 'function') {
			const observer = new NativeMutationObserver(() =>
				this.client.sweepFrames?.(),
			);
			const observe = () =>
				observer.observe(global.document, { childList: true, subtree: true });
			observe();
			// document.open() keeps the document node, but a written document
			// may be a new one in this window's realm
			addDocumentOpenListener(global, observe);
		}

		const reachable = (context: typeof globalThis): boolean => {
			try {
				Reflect.get(context, 'document');
				return true;
			} catch (error) {
				return false;
			}
		};

		// the three elements that embed a document the page can reach: iframe,
		// the frameset's frame, and object with an HTML or SVG document (embed
		// exposes none of this)
		const embedders = [
			this.client.global.HTMLIFrameElement,
			this.client.global.HTMLFrameElement,
			this.client.global.HTMLObjectElement,
		].filter((ctor) => typeof ctor === 'function');
		for (const ctor of embedders) {
			const getContentWindowDescriptor = Reflect.getOwnPropertyDescriptor(
				ctor.prototype,
				'contentWindow',
			);
			const getContentDocumentDescriptor = Reflect.getOwnPropertyDescriptor(
				ctor.prototype,
				'contentDocument',
			);
			if (
				!getContentWindowDescriptor?.get ||
				!getContentDocumentDescriptor?.get
			)
				continue;

			const getContentWindow = (element: Element) => {
				const context = getContentWindowDescriptor.get!.call(element) as
					typeof globalThis | null;

				// a navigation the browser did not show (a document its
				// embedder's policy refused, a network error) leaves the
				// browser's own error document: of another origin to everyone,
				// as natively, and nothing of this page's to inject
				if (context && !reachable(context))
					return windowModule.restrictOpaque(context);

				if (
					context &&
					(this.client.opaqueFrames.has(element) || sandboxedOpaque(element))
				)
					// an opaque (data:) document: another origin from here, never
					// injected by this page (its own shell injects it)
					return windowModule.restrictOpaque(context);

				if (context) {
					injectContext(context);

					// still on its initial about:blank while the document its src
					// names is on the way: that document decides
					const restricted = initialBlank(context)
						? windowModule.pending(context, Reflect.get(element, 'src'))
						: windowModule.newRestricted(context);
					if (
						!(context as Record<string, any>)[this.client.names.client]!.applied
					) {
						(context as Record<string, any>)[this.client.names.client]!.apply();
					}

					return restricted;
				}

				return null;
			};

			Reflect.defineProperty(ctor.prototype, 'contentWindow', {
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(
					getContentWindowDescriptor.get,
					(target, that) => getContentWindow(that),
				),
			});

			// getSVGDocument() hands out the document like contentDocument (an
			// SVG one): never another site's
			const getSVGDocument = (ctor.prototype as { getSVGDocument?: unknown })
				.getSVGDocument;
			if (typeof getSVGDocument === 'function')
				hookSVGDocument(ctor.prototype, getSVGDocument);

			Reflect.defineProperty(ctor.prototype, 'contentDocument', {
				configurable: true,
				enumerable: true,
				get: proxyModule.wrapFunction(
					getContentDocumentDescriptor.get,
					(target, that) => {
						const context = getContentWindow(that);

						if (!context || windowModule.restrictedContexts.has(context)) {
							return null;
						}

						return context.document;
					},
				),
			});
		}
	}
}
