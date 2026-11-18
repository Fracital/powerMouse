import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { failsToParse, withStack } from '../../nativeErrors';
import { OwnWeakMap } from '../../ownCollections';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { deferred } from '../deferred';
import type { DeferredParts } from '../deferredParts';
import { Pool } from '../pool';
import { siteWindows } from '../siteWindows';

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
						return Reflect.apply(value, location, args);
					});
				if (get)
					descriptor.get = wrap(get, () => Reflect.apply(get, location, []));
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
						}
						Reflect.apply(set, location, args);
					});
				Reflect.defineProperty(view, key, descriptor);
			}
			Reflect.setPrototypeOf(view, Reflect.getPrototypeOf(location));
			if (!unclaimed) gated.set(real as object, view);
			return view;
		};

		// a link to the top (or to the parent, when the parent is the top) in
		// a sandboxed document: the hooks leave its target as the page wrote
		// it (DOMAttributes), so the browser refuses it, unless the sandbox
		// allows top navigation; then the proxied top goes there, from its own
		// realm (the browser would not let this frame navigate it).
		//
		// And a link to the parent or the top in a frame under the proxied
		// top, sandboxed or not: the hooks made its target the frame itself
		// (the browser's `_parent` and `_top` are not the page's: the host
		// frames the proxied top sandboxed, and its top is the host), so the
		// window the page means is navigated here, from its own realm, with
		// the URL routed as its document. A javascript: URL runs there.
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
			const target = (
				link.getAttribute('target') ||
				global.document.querySelector('base[target]')?.getAttribute('target') ||
				''
			).toLowerCase();
			if (client.sandboxFlags === null) {
				const aimed = client.targetWindow(target);
				// the site pool: the window is another slot's, asked to go
				// there itself; a javascript: URL runs in no window of another
				// origin, as natively
				const across =
					aimed || !client.sites
						? null
						: siteWindows().targetAcross(client, target);
				if (!aimed && !across) return;
				const destination = resolve(link.getAttribute('href'));
				if (!['http:', 'https:', 'javascript:'].includes(destination.protocol))
					return;
				event.preventDefault();
				if (!aimed) {
					if (destination.protocol !== 'javascript:')
						deferred('navigateAcross')(client, across!, {
							kind: 'link',
							url: destination.href,
						});
					return;
				}
				aimed.client.callIn(nativeAssign, aimed.window.location, [
					// a document is one of that window's own navigations; a
					// javascript: URL's code is rewritten to run there
					destination.protocol === 'javascript:'
						? routeHTML(
								new StompURL(destination, client.url),
								client.url,
								client.config,
								false,
								aimed.client.nestedRoute,
							)
						: aimed.client.navigationRoute(destination),
				]);
				return;
			}
			const top = client.proxiedTop;
			if (!(
				target === '_top' ||
				(target === '_parent' && client.parent === top)
			))
				return;
			if (top === global) return;
			const destination = resolve(link.getAttribute('href'));
			if (!['http:', 'https:'].includes(destination.protocol)) return;
			if (!client.mayNavigate(top)) return;
			event.preventDefault();
			const topClient = (top as Record<string, any>)[client.names.client] as
				DocumentClient | undefined;
			if (!topClient) return;
			topClient.callIn(nativeAssign, top.location, [
				routeHTML(
					new StompURL(destination, client.url),
					client.url,
					client.config,
				),
			]);
		};
		// A form aimed at the proxied parent or top, from a frame under the
		// top: a javascript: action runs in that window. Any other is
		// submitted by that window, from a copy of the form made in its
		// document with the form's entry list (the browser builds it once,
		// here, as it would have for the submission this stands in for), so
		// the action is routed as that window's document and the response
		// lands there.
		// Returns whether it took the submission.
		const nativeSubmit = global.HTMLFormElement.prototype.submit;
		const submitAimed = (
			form: HTMLFormElement,
			submitter: HTMLElement | null,
		): boolean => {
			if (client.sandboxFlags !== null) return false;
			const keyword =
				submitter?.getAttribute('formtarget') ||
				form.getAttribute('target') ||
				global.document.querySelector('base[target]')?.getAttribute('target');
			const aimed = client.targetWindow(keyword);
			// the site pool: a window of another slot (see onClick)
			const across =
				aimed || !client.sites
					? null
					: siteWindows().targetAcross(client, keyword);
			if (!aimed && !across) return false;
			const method = (
				submitter?.getAttribute('formmethod') ??
				form.getAttribute('method') ??
				''
			).toLowerCase();
			// (a dialog's form navigates nothing)
			if (method === 'dialog') return false;
			// a form with no action submits to its document
			const destination = resolve(
				submitter?.getAttribute('formaction') ??
					form.getAttribute('action') ??
					'',
			);
			// what the form's document's form-action refuses is left to the
			// browser, which refuses it as natively (NavigationHint)
			if (
				client
					.pageRefusals('form-action', destination)
					.some(({ policy }) => policy.disposition === 'enforce')
			)
				return false;
			if (destination.protocol === 'javascript:') {
				if (aimed)
					aimed.client.callIn(nativeAssign, aimed.window.location, [
						routeHTML(
							new StompURL(destination, client.url),
							client.url,
							client.config,
							false,
							aimed.client.nestedRoute,
						),
					]);
				return true;
			}
			if (!['http:', 'https:'].includes(destination.protocol)) return false;
			// the copy of the form that window submits, or the ask of a window
			// of another slot (a deferred part, ../siteAcross.ts); a submission
			// whose part cannot be had goes nowhere (never the browser's own,
			// which lands in this frame: the form's target reads `_self` to
			// the browser)
			let submitAcross: DeferredParts['submitAimed'];
			try {
				submitAcross = deferred('submitAimed');
			} catch (error) {
				return true;
			}
			submitAcross(
				client,
				form,
				submitter,
				destination,
				aimed,
				across,
				nativeSubmit,
			);
			return true;
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
		const onSubmit = (event: SubmitEvent) => {
			if (event.defaultPrevented) return;
			const form = event.target;
			if (!(form instanceof global.HTMLFormElement)) return;
			if (submitAimed(form, event.submitter)) event.preventDefault();
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
