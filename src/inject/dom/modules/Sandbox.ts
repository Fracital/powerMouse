import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import { failsToParse, withStack } from '../../nativeErrors';
import { OwnWeakMap } from '../../ownCollections';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';
import type { DeferredParts } from '../deferredParts';
import { Pool } from '../pool';

const LACKS_SAME_ORIGIN =
	"The document is sandboxed and lacks the 'allow-same-origin' flag.";

/**
 * What an opaque origin may not touch. A document the page sandboxed
 * without allow-same-origin is natively an opaque origin, but through the
 * proxy the frame keeps allow-same-origin (the service worker could not
 * serve it otherwise; see sandbox.ts), so its storage would be the site's.
 * Each throws the SecurityError Chrome throws in an opaque document:
 * localStorage, sessionStorage, document.cookie, IndexedDB and Cache
 * Storage. The decision is made at each call, from the document's sandbox
 * (DocumentClient.sandboxedOpaque), so it holds for every document of the
 * window.
 *
 * And where a sandboxed document may navigate: the real frame cannot decide
 * it, since the proxied top is not the browser's top (the frame's real
 * sandbox never has the top navigation flags) and a write to another
 * window's location runs that window's own inject, a navigation the browser
 * takes for the target's. Another window's location, read by a document,
 * navigates that window as the document's own navigation (the Context
 * module's navigateWindow, which refuses what Chrome refuses, a sandboxed
 * document's what DocumentClient.mayNavigate refuses, with the browser's
 * SecurityError); a target=_top link (or _parent, when the parent
 * is the top) navigates the proxied top when the sandbox allows it, and is
 * left to the browser, which refuses it, when it does not.
 */
export default class SandboxModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global;
		const proxyModule = client.getModule(ProxyModule)!;
		const opaque = () => client.sandboxedOpaque;
		const securityError = (message: string) =>
			withStack(new global.DOMException(message, 'SecurityError'));

		const guardGetter = (
			owner: object,
			property: string,
			message: string,
			setMessage?: string,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(owner, property);
			if (!descriptor?.get) return;
			// what the refusal is about: this window, or its document. Called
			// on anything else (the prototype itself) the accessor is the
			// browser's, which refuses the receiver before the sandbox
			const subject = (that: unknown) =>
				owner === global
					? that === global || that === undefined || that === null
					: that === global.document;
			Reflect.defineProperty(owner, property, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					if (opaque() && subject(that)) throw securityError(message);
					return Reflect.apply(target, that, args);
				}),
				...(descriptor.set && setMessage
					? {
							set: proxyModule.wrapFunction(
								descriptor.set,
								(target, that, args) => {
									if (opaque() && subject(that))
										throw securityError(setMessage);
									return Reflect.apply(target, that, args);
								},
							),
						}
					: {}),
			});
		};

		for (const store of ['localStorage', 'sessionStorage'])
			guardGetter(
				global,
				store,
				`Failed to read the '${store}' property from 'Window': ${LACKS_SAME_ORIGIN}`,
			);
		guardGetter(
			global.Document.prototype,
			'cookie',
			`Failed to read the 'cookie' property from 'Document': ${LACKS_SAME_ORIGIN}`,
			`Failed to set the 'cookie' property on 'Document': ${LACKS_SAME_ORIGIN}`,
		);
		guardGetter(
			global,
			'caches',
			"Failed to read the 'caches' property from 'Window': Cache storage is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.",
		);
		const resolve = (value: unknown) => new URL(String(value), client.baseHref);
		const LOCATION_PARTS = [
			'href',
			'protocol',
			'host',
			'hostname',
			'port',
			'pathname',
			'search',
			'hash',
		];
		/** the window of the proxied world whose location is `real` */
		const windowOf = (real: unknown): typeof globalThis | null => {
			const queue: (typeof globalThis)[] = [client.proxiedTop];
			for (let seen = 0; queue.length && seen < 256; seen++) {
				const context = queue.shift()!;
				try {
					if (context.location === real) return context;
					for (let index = 0; index < context.length; index++)
						queue.push(
							(context as unknown as Record<number, typeof globalThis>)[index],
						);
				} catch (error) {
					// a window being torn down
				}
			}
			return null;
		};
		// Browsing context names (DocumentClient namedWindow), read by the
		// browser's own getter, taken before any page script. The browser
		// looks for a name in this window and its frames, then in the rest
		// of the tab, then in the windows the tab opened; for a frame under
		// the sandboxed host frame it navigates no frame of the second
		const nativeName = Reflect.getOwnPropertyDescriptor(global, 'name')?.get;
		const nameOf = (context: unknown): string | null => {
			try {
				return String(Reflect.apply(nativeName!, context, []));
			} catch (error) {
				// a window of another real origin, or one going away
				return null;
			}
		};
		const framesOf = (root: typeof globalThis): (typeof globalThis)[] => {
			const found: (typeof globalThis)[] = [];
			const queue = [root];
			while (queue.length && found.length < 256) {
				const context = queue.shift()!;
				found.push(context);
				try {
					for (let index = 0; index < context.length; index++)
						queue.push(
							(context as unknown as Record<number, typeof globalThis>)[index],
						);
				} catch (error) {
					// a window being torn down
				}
			}
			return found;
		};
		client.namedWindow = (name, popups = false) => {
			if (!name || name.startsWith('_') || !nativeName) return null;
			if (client.sandboxFlags !== null) return null;
			const own = framesOf(global);
			if (own.some((context) => nameOf(context) === name)) return null;
			const top = client.proxiedTop;
			for (const context of framesOf(top))
				if (!own.includes(context) && nameOf(context) === name) return context;
			if (!popups) return null;
			let opened: WeakRef<typeof globalThis>[] | undefined;
			try {
				opened = (
					(top as Record<string, any>)[client.names.client] as
						DocumentClient | undefined
				)?.tabPopups;
			} catch (error) {
				// the proxied top went away
			}
			for (const reference of opened ?? []) {
				const context = reference.deref();
				try {
					if (context && !context.closed && nameOf(context) === name)
						return context;
				} catch (error) {
					// a window going away
				}
			}
			return null;
		};
		// one gated location per window, so a page comparing two reads sees one
		const gated = new OwnWeakMap<object, object>();
		// Another window's location, as this document reads it: its
		// navigation of that window (a location set, assign, replace) is this
		// document's own, refused or made as Chrome would (Context
		// navigateWindow); a sandboxed document's reload, or a write of a
		// part of the URL, is refused where it may not navigate the window
		client.gateLocation = (real, standIn, container) => {
			if (
				real === global.location ||
				typeof standIn !== 'object' ||
				standIn === null
			)
				return standIn;
			// (a window that runs nothing of ours yet, unclaimedWindow: gated
			// over its own Location, and not kept, since its client gives the
			// Location a stand-in when its bundle runs)
			const unclaimed = standIn === real;
			const known = unclaimed ? undefined : gated.get(real as object);
			if (known) return known;
			// the window it was read off (`w.location`, `w.document.location`),
			// else found by a walk of the proxied world's frames
			let target: typeof globalThis | null = null;
			try {
				const owner =
					container !== null &&
					typeof container === 'object' &&
					(container as { window?: unknown }).window === container
						? container
						: (container as Document | undefined)?.defaultView;
				if (owner && (owner as typeof globalThis).location === real)
					target = owner as typeof globalThis;
			} catch (error) {
				// a window of another real origin
			}
			target ??= windowOf(real);
			if (!target || (unclaimed && !client.unclaimedWindow?.(target)))
				return standIn;
			const location = standIn as Location;
			// (a window that runs nothing of ours yet: its own Location's URL
			// is the route of its document, which reads as the URL it routes,
			// as the browser shows the document that committed)
			const hrefGetter = unclaimed
				? Reflect.getOwnPropertyDescriptor(location, 'href')?.get
				: undefined;
			const shown = (): URL | null => {
				try {
					const href = String(Reflect.apply(hrefGetter!, location, []));
					return new URL(unrouteURL(client, href) ?? href);
				} catch (error) {
					return null;
				}
			};
			const check = (member: string, call: boolean, destination: URL) => {
				if (client.sandboxFlags !== null && !client.mayNavigate(target))
					throw client.navigationRefused(member, call, destination);
			};
			const navigate = (
				member: 'href' | 'assign' | 'replace',
				url: string,
			): boolean => !!client.navigateWindow?.(target, url, member);
			// A Location of its own, every member the stand-in's with its
			// descriptor (unforgeable, so a Proxy could not answer for them),
			// each function reading as the native one and acting on the stand-in;
			// the navigating ones go through `navigate` first
			const view = {} as Location;
			const wrap = (native: Function, own: (args: unknown[]) => unknown): any =>
				proxyModule.wrapFunction(native, (method, that, args) =>
					that === view ? own(args) : Reflect.apply(method, that, args),
				);
			for (const key of Reflect.ownKeys(location)) {
				const descriptor = Reflect.getOwnPropertyDescriptor(location, key)!;
				const { value, get, set } = descriptor;
				// (valueOf is the realm's own, which answers for what it is called on)
				if (typeof value === 'function' && key !== 'valueOf')
					descriptor.value = wrap(value, (args) => {
						if (key === 'assign' || key === 'replace') {
							// no URL, or one that does not parse: the stand-in hands
							// the call to the browser, whose error the page gets
							if (!args.length) return Reflect.apply(value, location, []);
							const url = String(args[0]);
							if (!failsToParse(client, url)) {
								if (navigate(key, url)) return undefined;
								check(key, true, resolve(url));
							}
							return Reflect.apply(value, location, [url]);
						} else if (key === 'reload')
							check(key, true, new URL(location.href));
						else if (key === 'toString' && hrefGetter) {
							const url = shown();
							if (url) return url.href;
						}
						return Reflect.apply(value, location, args);
					});
				if (get)
					descriptor.get = wrap(get, () => {
						if (
							hrefGetter &&
							typeof key === 'string' &&
							(key === 'origin' || LOCATION_PARTS.includes(key))
						) {
							const url = shown();
							if (url) return url[key as 'href'];
						}
						return Reflect.apply(get, location, []);
					});
				if (set)
					descriptor.set = wrap(set, (args) => {
						if (key === 'href') {
							// (converted once; one that does not parse is the stand-in's
							// to refuse, as the browser does)
							const url = String(args[0]);
							if (!failsToParse(client, url)) {
								if (navigate('href', url)) return;
								check(key, false, resolve(url));
							}
							Reflect.apply(set, location, [url]);
							return;
						}
						if (typeof key === 'string' && LOCATION_PARTS.includes(key)) {
							const destination = new URL(location.href);
							Reflect.set(destination, key, String(args[0]));
							check(key, false, destination);
							// (the part of the URL the window's document routes: set
							// on its route, it went past the proxy, to another host)
							const url = hrefGetter && shown();
							if (url) {
								Reflect.set(url, key, String(args[0]));
								if (navigate('href', url.href)) return;
							}
						}
						Reflect.apply(set, location, args);
					});
				Reflect.defineProperty(view, key, descriptor);
			}
			Reflect.setPrototypeOf(view, Reflect.getPrototypeOf(location));
			if (!unclaimed) gated.set(real as object, view);
			return view;
		};

		// A link or a form whose target (or its document's base target, as the
		// page wrote it) may name another window than its own: `_top`,
		// `_parent`, `_unfencedtop` or a name. The proxied parent or top (the
		// browser's `_parent` and `_top` are not the page's: the host frames
		// the proxied top sandboxed), a window of another slot (the site pool)
		// and a window by a name the browser would not navigate for this frame
		// (DocumentClient namedWindow) are navigated by a deferred part
		// (../siteAcross.ts linkAimed and submitAimed). Without it the link or
		// the submit event navigates nothing and submit() throws: never the
		// browser's own navigation, which for `_top` and `_parent` lands in
		// this frame (the hooks made the target `_self` to the browser)
		const aimsAway = (target: string) =>
			/^(?:_(?:parent|top|unfencedtop)$|[^_])/i.test(target);
		const nativeAssign = global.location.assign;
		const onClick = (event: MouseEvent) => {
			if (event.defaultPrevented) return;
			if (
				event.button !== 0 ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey
			)
				return;
			const link = event
				.composedPath()
				.find(
					(node): node is HTMLAnchorElement | HTMLAreaElement =>
						node instanceof global.Element &&
						(node.nodeName === 'A' || node.nodeName === 'AREA') &&
						node.hasAttribute('href'),
				);
			if (!link) return;
			const aim =
				link.getAttribute('target') ||
				global.document.querySelector('base[target]')?.getAttribute('target') ||
				'';
			if (!aimsAway(aim)) return;
			let linkAimed: DeferredParts['linkAimed'];
			try {
				linkAimed = deferred('linkAimed');
			} catch (error) {
				event.preventDefault();
				return;
			}
			linkAimed(client, event, link, aim, nativeAssign);
		};
		// Returns whether it took the submission (throws without the part)
		const nativeSubmit = global.HTMLFormElement.prototype.submit;
		const submitAimed = (
			form: HTMLFormElement,
			submitter: HTMLElement | null,
			/** the user's own submission (onSubmit) */
			user = false,
		): boolean => {
			if (client.sandboxFlags !== null) return false;
			const keyword =
				submitter?.getAttribute('formtarget') ||
				form.getAttribute('target') ||
				global.document.querySelector('base[target]')?.getAttribute('target') ||
				'';
			return (
				aimsAway(keyword) &&
				deferred('submitAimed')(
					client,
					form,
					submitter,
					keyword,
					user,
					nativeAssign,
					nativeSubmit,
				)
			);
		};
		// the site pool: what a frame of another slot under this window asks
		// of it (navigateAcross), carried out here as this window's own
		// navigation: a document routed as its own, a form submitted from a
		// copy in its document
		client.pool[Pool.AcceptAcross] = (request) =>
			deferred('acceptAcross')(client, request, {
				assign: nativeAssign,
				submit: nativeSubmit,
			});
		// Whether a submit event is of the user's own submission (natively
		// its navigation's userInitiated): the browser fires a trusted one
		// for requestSubmit() and for a script's click() of a submit button
		// too, whose navigations are not the user's. A click is kept from
		// its capture until a microtask after it: one a script dispatched
		// (click()) is still kept when the button submits, synchronously,
		// and the user's is not (the browser runs microtasks after each of
		// its listeners)
		let requesting = false;
		let clicking: Event | null = null;
		const nativeQueueMicrotask = global.queueMicrotask;
		const onClickCapture = (event: Event) => {
			clicking = event;
			Reflect.apply(nativeQueueMicrotask, global, [
				() => {
					if (clicking === event) clicking = null;
				},
			]);
		};
		const nativeRequestSubmit = global.HTMLFormElement.prototype.requestSubmit;
		if (nativeRequestSubmit)
			global.HTMLFormElement.prototype.requestSubmit = proxyModule.wrapFunction(
				nativeRequestSubmit,
				(target, that, args) => {
					const was = requesting;
					requesting = true;
					try {
						return Reflect.apply(target, that, args);
					} finally {
						requesting = was;
					}
				},
			);
		const onSubmit = (event: SubmitEvent) => {
			if (event.defaultPrevented) return;
			const form = event.target;
			if (!(form instanceof global.HTMLFormElement)) return;
			const user =
				event.isTrusted &&
				!requesting &&
				!(clicking !== null && !(clicking as Event).isTrusted);
			let took = true;
			try {
				took = submitAimed(form, event.submitter, user);
			} catch (error) {
				// no part: the submission goes nowhere
			}
			if (took) event.preventDefault();
		};
		// submit() fires no event
		global.HTMLFormElement.prototype.submit = proxyModule.wrapFunction(
			nativeSubmit,
			(target, that, args) => {
				let form = false;
				try {
					form = that instanceof global.HTMLFormElement;
				} catch (error) {
					// no form: the call throws on its own
				}
				if (form && submitAimed(that, null)) return;
				return Reflect.apply(target, that, args);
			},
		);
		const install = () => {
			global.addEventListener('click', onClickCapture, true);
			global.addEventListener('click', onClick);
			global.addEventListener('submit', onSubmit);
		};
		install();
		addDocumentOpenListener(global, install);

		const factory = global.IDBFactory?.prototype as
			(IDBFactory & Record<string, unknown>) | undefined;
		if (factory)
			for (const method of ['open', 'deleteDatabase', 'databases']) {
				const native = factory[method];
				if (typeof native !== 'function') continue;
				factory[method] = proxyModule.wrapFunction(
					native,
					(target, that, args) => {
						// (the browser refuses a receiver that is not the
						// factory, and a call without its argument, before
						// the sandbox)
						if (
							opaque() &&
							that === global.indexedDB &&
							args.length >= target.length
						) {
							// (Chrome words databases()'s refusal its own way)
							const error = securityError(
								method === 'databases'
									? "Failed to execute 'databases' on 'IDBFactory': Access to the IndexedDB API is denied in this context."
									: `Failed to execute '${method}' on 'IDBFactory': access to the Indexed Database API is denied in this context.`,
							);
							// databases() rejects, the others throw
							if (method === 'databases') return global.Promise.reject(error);
							throw error;
						}
						return Reflect.apply(target, that, args);
					},
				);
			}
	}
}
