import { parseConfig } from '../../../config';
import { FRESH_FRAME_EVENT } from '../../../freshFrame';
import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import {
	CSP_FACTS,
	FRESH_RETURN,
	type FreshReturnMessage,
} from '../../../transport/messages';
import { isLinkRoute } from '../../../visited';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { scopePrefix, unrouteURL } from '../../modules/Unroute';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { addClientModules } from '../document';
import {
	containerOf,
	destinationURL,
	frameDestination,
	frameWindow,
	freshFrame,
	recordFresh,
	swappingFrames,
} from '../freshContext';
import { pageSandbox, sandboxTokens } from '../sandbox';
import ContextModule, { initialBlank, isStomp } from './Context';
import { nativeElement } from './DOMHooks';
import { MARKER } from './MutationObserver';

export default class IFrameModule extends Module<DocumentClient> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;

		const injectContext = (context: typeof globalThis) => {
			if (this.client.names.client in context) return;

			// the document is its creator's, and so is its script policy
			// (src/csp.ts): the client takes what this one was told
			Reflect.defineProperty(context, CSP_FACTS, {
				value: { ...this.client.scriptFacts },
				configurable: true,
			});
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
		// on a fresh frame). Or in a window a link or a form of this page
		// opened by its target (`<a target="name" href="javascript:...">`),
		// which no call of the page's made: it is on its initial about:blank,
		// this page is its opener (whose document it is: DocumentClient url).
		// Only a child or such a popup of this page, so a page
		// cannot have another document's window injected with its bundle
		this.client.injectChild = (context) => {
			const self = this.client.global as unknown;
			const popup =
				Reflect.get(context, 'parent') === (context as unknown) &&
				Reflect.get(context, 'opener') === self &&
				initialBlank(context);
			if (Reflect.get(context, 'parent') !== self && !popup) return;
			injectContext(context);
			const client = (context as Record<string, any>)[
				this.client.names.client
			] as DocumentClient;
			if (client.applied) return;
			if (popup) this.client.openedWindows.add(context);
			client.apply();
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
			if (windowModule.restrictedContexts.has(reached)) return null;
			// a window this page held before the frame got a fresh context
			// stands for the frame's window, whose document is another
			// origin's (freshContext.ts)
			if (reached !== view && isStomp(view, this.client.names.client))
				return null;
			return document;
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

		// A frame's load event for the shell its document still is: the
		// shell writes the page from a timer (DocumentClient.loadHTML), and
		// when Chrome runs the shell's load task first the element fires
		// `load` twice, for the shell and for the page, where natively it
		// fires once, for the page. The first is kept from the page, before
		// any listener of its own: a capture listener of the document's (a
		// load event's path ends there, never at the window), added before
		// the page's first script and again after each open, which erases
		// the document's listeners
		const nativeContentWindows = embedders.map(
			(ctor) =>
				[
					ctor,
					Reflect.getOwnPropertyDescriptor(ctor.prototype, 'contentWindow')
						?.get,
				] as const,
		);
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;
		const shellLoads = () =>
			global.document.addEventListener(
				'load',
				(event) => {
					const target = event.target;
					for (const [ctor, get] of nativeContentWindows) {
						if (!get || !(target instanceof ctor)) continue;
						// the empty context a frame given a fresh one starts on
						// (freshContext.ts): its load is the inject's own
						if (swappingFrames.has(target as Element)) {
							swappingFrames.delete(target as Element);
							Reflect.apply(stopImmediate, event, []);
							return;
						}
						try {
							const child = get.call(target) as Record<string, any> | null;
							if (child?.[this.client.names.client]?.shellPending === true)
								Reflect.apply(stopImmediate, event, []);
						} catch (error) {
							// another origin's document: not a shell of ours
						}
						return;
					}
				},
				true,
			);
		shellLoads();
		addDocumentOpenListener(global, shellLoads);

		// a frame's navigation its site redirected to another origin: the
		// worker's document in the frame asks for a fresh context here
		// (src/freshFrame.ts), for a route of the proxy's scope alone
		const freshFrameAsked = () =>
			global.document.addEventListener(
				FRESH_FRAME_EVENT,
				(event) => {
					const target = event.target as Element;
					if (
						!(target instanceof global.HTMLIFrameElement) &&
						!(target instanceof global.HTMLFrameElement)
					)
						return;
					Reflect.apply(stopImmediate, event, []);
					const to = (event as CustomEvent).detail;
					if (
						typeof to === 'string' &&
						to.startsWith(scopePrefix(this.client)) &&
						this.client.freshFrame?.(target, to)
					)
						event.preventDefault();
				},
				true,
			);
		freshFrameAsked();
		addDocumentOpenListener(global, freshFrameAsked);

		// A frame of this document that is to show another origin's document
		// gets a fresh browsing context first (freshContext.ts): asked by the
		// frame's own document, which may run another bundle
		this.client.freshFrame = (element, routed, formData, page) => {
			const old = frameWindow(element);
			if (!freshFrame(element, routed, formData)) return false;
			recordFresh(
				this.client,
				element,
				old,
				page ??
					(routed === null ? '' : (unrouteURL(this.client, routed) ?? routed)),
				(native, hook) =>
					proxyModule.wrapFunction(native, (target, that, args) => hook(args)),
			);
			return true;
		};

		// This document, when it is a frame still on its initial about:blank
		// (which fires no navigate event): a navigation of it to another
		// origin (its location set, window.open or a link or form aimed at
		// it by name) gets its fresh context here, as the src setter does
		// (DOMAttributes)
		this.client.freshTo = (destination, formData, empty) => {
			if (!/^(https?|data):$/.test(destination.protocol)) return false;
			if (!initialBlank(global)) return false;
			const origin =
				destination.protocol === 'data:' ? null : destination.origin;
			if (origin === this.client.originKey) return false;
			const container = containerOf(global, this.client.names.client);
			if (!container?.parent.freshFrame) return false;
			return container.parent.freshFrame(
				container.element,
				empty
					? null
					: routeHTML(
							new StompURL(destination, this.client.url),
							this.client.url,
							this.client.config,
							false,
							this.client.nestedRoute,
						),
				formData,
				destination.href,
			);
		};

		// a link or form of this document aimed by name at a frame of it still
		// on its initial about:blank: decided once the page's own listeners
		// had the event (one may cancel it), as the browser does
		const blankTarget = (name: string | null) => {
			if (!name || name.startsWith('_')) return null;
			const element = this.client.frameNamed(name);
			const view = element && frameWindow(element);
			if (!view) return null;
			try {
				const client = (view as unknown as Record<string, unknown>)[
					this.client.names.client
				] as DocumentClient | undefined;
				return client?.freshTo ? client : null;
			} catch (error) {
				return null;
			}
		};
		const baseTarget = () =>
			global.document.querySelector('base[target]')?.getAttribute('target') ??
			null;
		// the frame gets its fresh context, still empty, and the browser goes
		// on with the link or form as natively (its ping, its request)
		const afterPage = (event: Event, then: () => unknown) =>
			global.addEventListener(
				event.type,
				(late) => {
					if (late === event && !event.defaultPrevented) then();
				},
				{ once: true },
			);
		const onClick = (event: MouseEvent) => {
			if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
			if (event.shiftKey || event.altKey) return;
			const link = event
				.composedPath()
				.find(
					(node): node is HTMLAnchorElement | HTMLAreaElement =>
						node instanceof global.Element &&
						(node.nodeName === 'A' || node.nodeName === 'AREA') &&
						node.hasAttribute('href'),
				);
			if (!link || link.hasAttribute('download')) return;
			const target = blankTarget(link.getAttribute('target') || baseTarget());
			if (!target) return;
			afterPage(event, () =>
				target.freshTo!(
					new URL(link.getAttribute('href')!, this.client.baseURL.toString()),
					null,
					true,
				),
			);
		};
		// a form's submission (its submit event, or submit(), which fires none)
		const submission = (
			form: HTMLFormElement,
			submitter: HTMLButtonElement | HTMLInputElement | null,
		) => {
			const own = (name: string) => !!submitter?.hasAttribute(name);
			const target = blankTarget(
				(own('formtarget')
					? submitter!.getAttribute('formtarget')
					: form.getAttribute('target')) || baseTarget(),
			);
			if (!target) return null;
			const method = (
				(own('formmethod') ? submitter!.formMethod : form.method) || 'get'
			).toLowerCase();
			if (method !== 'get' && method !== 'post') return null;
			return () => {
				try {
					const url = new URL(
						own('formaction') ? submitter!.formAction : form.action,
					);
					const data = new global.FormData(form, submitter ?? undefined);
					if (method === 'get')
						url.search = new URLSearchParams(
							data as unknown as Record<string, string>,
						).toString();
					return target.freshTo!(url, null, true);
				} catch (error) {
					return false;
				}
			};
		};
		const onSubmit = (event: Event) => {
			const form = event.target;
			if (!(form instanceof global.HTMLFormElement)) return;
			const go = submission(
				form,
				(event as SubmitEvent).submitter as
					HTMLButtonElement | HTMLInputElement | null,
			);
			if (go) afterPage(event, go);
		};
		const listenTargets = () => {
			global.addEventListener('click', onClick, true);
			global.addEventListener('submit', onSubmit, true);
		};
		listenTargets();
		addDocumentOpenListener(global, listenTargets);
		global.HTMLFormElement.prototype.submit = proxyModule.wrapFunction(
			global.HTMLFormElement.prototype.submit,
			(target, that, args) => {
				if (that instanceof global.HTMLFormElement) submission(that, null)?.();
				return Reflect.apply(target, that, args);
			},
		);

		// This document, when it is a frame: a navigation of its own context
		// to another origin's document is cancelled before anything of that
		// document arrives, and its parent gives the frame a fresh context
		// with the same request (a link, a form, a location write, the
		// parent's src, another frame's location or named target: every
		// navigation whose initiator is a proxied document, which is the
		// proxy's origin, fires `navigate` here first). Heard before any
		// listener of the page's
		this.#guardNavigations();

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
						? windowModule.pending(
								context,
								frameDestination(this.client, element),
							)
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
						// the window this page held before the frame got a fresh
						// context, which stands for the frame's window now: its
						// document is another origin's (freshContext.ts)
						if (
							(context as unknown) !==
							getContentWindowDescriptor.get!.call(that)
						)
							return null;

						return context.document;
					},
				),
			});
		}
	}
	/** the frame element of this document's window in its parent, and the parent's client */
	#container(): { element: Element; parent: DocumentClient } | null {
		return containerOf(this.client.global, this.client.names.client);
	}
	#guardNavigations() {
		const global = this.client.global as typeof globalThis & {
			navigation?: EventTarget;
		};
		const navigation = global.navigation;
		if (!navigation || (global.parent as unknown) === (global as unknown))
			return;
		global.EventTarget.prototype.addEventListener.call(
			navigation,
			'navigate',
			(event: Event) => {
				const navigate = event as Event & {
					cancelable: boolean;
					navigationType: string;
					hashChange: boolean;
					downloadRequest: string | null;
					formData: FormData | null;
					destination: { url: string; sameDocument: boolean };
				};
				if (
					!navigate.cancelable ||
					navigate.destination.sameDocument ||
					navigate.hashChange ||
					navigate.downloadRequest !== null ||
					navigate.navigationType === 'traverse' ||
					navigate.navigationType === 'reload'
				)
					return;
				// the page reads the destination unrouted (Readback); the
				// browser's is the route the navigation goes to
				let routed = destinationURL(navigate.destination);
				if (!routed) return;
				let origin: string;
				try {
					const page = new URL(unrouteURL(this.client, routed) ?? routed);
					if (!/^(https?|data):$/.test(page.protocol)) return;
					origin = page.origin;
					// a link route (src/visited.ts) takes its kind of route from
					// the navigation's referrer, which the fresh context's is not
					// (its parent's): this frame's own route instead. A fresh
					// context's first document makes no history entry, so no
					// visit is recorded either way
					if (isLinkRoute(routed, scopePrefix(this.client)))
						routed = routeHTML(
							new StompURL(page, this.client.url),
							this.client.url,
							this.client.config,
							false,
							this.client.nestedRoute,
						);
				} catch (error) {
					return;
				}
				if (origin === this.client.originKey) return;
				const container = this.#container();
				if (!container) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				const formData = navigate.formData;
				// the request is the parent's element's now: the worker takes
				// this document for its referrer and initiator, as it was
				const routedClient = this.client.routedClient();
				routedClient?.postToWorker({
					[FRESH_RETURN]: {
						directory: routedClient.directory,
						url: routed,
					} satisfies FreshReturnMessage,
				});
				// in the parent's realm, once this event is over: the frame is
				// taken out of its document, this one with it
				container.parent.global.setTimeout(() =>
					container.parent.freshFrame?.(container.element, routed, formData),
				);
			},
			true,
		);
	}
}
