import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import { queryOf } from '../../../urlShape';
import { isLinkRoute } from '../../../visited';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import { nativeElement, nativeEventTarget } from './DOMHooks';
import HistoryModule from './History';
import { hookWrite } from './MutationObserver';
import XMLHttpRequestModule from './XMLHttpRequest';

/** the handler attributes of `navigation` a page may set instead of a listener */
const HANDLERS = [
	'onnavigate',
	'onnavigatesuccess',
	'onnavigateerror',
	'oncurrententrychange',
];

/**
 * What a document's own navigations do with link routes (src/visited.ts),
 * so that the browser's history records what Chrome records for the page.
 * Every proxied document is a frame of the host's page, and a frame's
 * navigation is recorded only when it makes a history entry, at the URL it
 * commits or through a redirect it follows. So:
 *
 * - a navigation of the document that makes an entry (`location.href`,
 *   `location.assign`, `window.open` on itself) goes to the link route,
 *   like a link's; a replacement keeps the document's address, and is not
 *   recorded (a frame's never is);
 * - `history.pushState` makes its entry at the link route and puts the
 *   document's address there in the same call;
 * - a fragment navigation that makes an entry (a link to `#part`,
 *   `location.hash`) is stopped in its navigate event and made again as
 *   the three steps the page cannot tell from it: the entry at the link
 *   route, the address the document had, and the fragment navigation as a
 *   replacement of that entry (the browser's own, with its scroll, its
 *   `:target`, its hashchange and popstate).
 *
 * No document may stay at a link route (the worker reads a client's site
 * and partition from its address). The two-step entries are seen by the
 * Navigation API's events, so a page that listens to any of them gets its
 * own navigations at the document's address, as before link routes; and
 * one that listens for `navigate` may intercept a navigation, which
 * commits the URL it names, so the link it follows is given the document's
 * address when clicked, and an interception of a navigation that names a
 * link route does not happen (the document loads).
 */
export default class VisitedModule extends Module<DocumentClient> {
	/**
	 * history.pushState with `args` (the URL already the document's address
	 * for the real `url`): through the link route when the page cannot see
	 * the difference; false when the caller should make the call as it is
	 */
	pushState: (
		native: History['pushState'],
		history: History,
		args: unknown[],
		url: URL,
	) => boolean = () => false;
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global as typeof globalThis & {
			navigation?: EventTarget;
			NavigateEvent?: { prototype: object };
			NavigationDestination?: { prototype: object };
		};
		const navigation = global.navigation;
		const location = global.location;
		// about:blank, about:srcdoc and blob: documents have no address under
		// the scope, and an initial about:blank fires no navigate events
		if (!navigation || !/^https?:$/.test(location.protocol)) return;
		const natives = this.client.getModule(HistoryModule)?.native;
		const getter = (proto: object | undefined, name: string) =>
			proto && Reflect.getOwnPropertyDescriptor(proto, name)?.get;
		const eventProto = global.NavigateEvent?.prototype;
		const destinationOf = getter(eventProto, 'destination');
		const destinationURL = getter(
			global.NavigationDestination?.prototype,
			'url',
		);
		const hashChange = getter(eventProto, 'hashChange');
		const navigationType = getter(eventProto, 'navigationType');
		const cancelable = getter(global.Event.prototype, 'cancelable');
		const downloadRequest = getter(eventProto, 'downloadRequest');
		const formData = getter(eventProto, 'formData');
		const preventDefault = global.Event.prototype.preventDefault;
		const setTimeout = global.setTimeout;
		if (
			!natives ||
			!eventProto ||
			!destinationOf ||
			!destinationURL ||
			!hashChange ||
			!navigationType ||
			!cancelable
		)
			return;

		const plain = (destination: URL) =>
			routeHTML(
				new StompURL(destination, this.client.url),
				this.client.url,
				this.client.config,
				false,
				this.client.nestedRoute,
			);
		const scope = `${location.origin}${this.client.scope}`;
		const absolute = (routed: string) => new URL(routed, location.href).href;
		/** the real URL a link route (absolute) stands for */
		const linked = (routed: string): URL | null => {
			if (!isLinkRoute(routed, scope)) return null;
			const real = unrouteURL(this.client, routed);
			return real === null ? null : new URL(real);
		};
		const link = (destination: URL) =>
			absolute(
				this.client.linkRoute(new StompURL(destination, this.client.url)),
			);
		/**
		 * Whether a navigation of this document to `target` stays in it,
		 * natively: to a fragment of its URL, or to its URL as it is (which
		 * replaces its entry)
		 */
		const ownURL = (target: URL): boolean => {
			const at = this.client.location.url;
			return (
				target.origin === at.origin &&
				target.pathname === at.pathname &&
				// an empty query is a query (src/urlShape.ts)
				queryOf(target) === queryOf(at) &&
				(target.href.includes('#') || target.href === at.href)
			);
		};

		// the page's listeners on `navigation` are counted from here on (the
		// inject's own were added before, or natively), its handler
		// attributes read when asked
		const tracker = this.client.getModule(XMLHttpRequestModule)?.listeners;
		const navigationProto = Reflect.getPrototypeOf(navigation)!;
		const handlers = HANDLERS.map((name) => getter(navigationProto, name));
		tracker?.track(navigation);
		/** whether the page listens to the Navigation API's events (any, or `navigate`) */
		const listens = (onlyNavigate: boolean): boolean => {
			if (!tracker || handlers.includes(undefined)) return true;
			try {
				return (
					(onlyNavigate
						? tracker.listeningFor(navigation, 'navigate')
						: tracker.listening(navigation)) ||
					handlers.some(
						(handler, index) =>
							(!onlyNavigate || index === 0) &&
							Reflect.apply(handler!, navigation, []) !== null,
					)
				);
			} catch (error) {
				return true;
			}
		};
		const observes = () => listens(false);
		const intercepts = () => listens(true);

		this.client.followsOwnLinks = true;
		this.client.navigationRoute = (destination) =>
			intercepts() || ownURL(destination)
				? plain(destination)
				: this.client.linkRoute(new StompURL(destination, this.client.url));

		// Chrome drops a frame's history calls past 200 in ten seconds
		// (NavigationRateLimiter), silently: a second step that was dropped
		// would leave the document at a link route. Every same-document
		// navigation is counted here (each fires navigate, the steps'
		// included), and a page that makes many gets them in one step each
		const WINDOW_MS = 10000;
		const SPARE = 80;
		const recent: number[] = [];
		const now = global.Date.now;
		const count = () => {
			const at = now();
			recent.push(at);
			while (recent.length && at - recent[0] > WINDOW_MS) recent.shift();
		};
		const spare = () => {
			const at = now();
			while (recent.length && at - recent[0] > WINDOW_MS) recent.shift();
			return recent.length < SPARE;
		};

		const history = global.history;
		const call = (
			method: 'pushState' | 'replaceState',
			state: unknown,
			url: string,
		) => Reflect.apply(natives[method], history, [state, '', url]);
		this.pushState = (native, that, args, url) => {
			if (that !== history || observes() || !spare()) return false;
			const route = link(url);
			if (!isLinkRoute(route, scope)) return false;
			Reflect.apply(native, that, [args[0], args[1], route]);
			Reflect.apply(natives.replaceState, that, args);
			return true;
		};

		// a fragment navigation that makes an entry, by a link (which names
		// its link route) or by script (which names the document's address)
		let stepping = false;
		Reflect.apply(nativeEventTarget.addEventListener, navigation, [
			'navigate',
			(event: Event) => {
				count();
				if (stepping || observes()) return;
				let routed: string;
				let real: URL | null;
				let push: boolean;
				try {
					if (!Reflect.apply(cancelable, event, [])) return;
					// a download and a form's submission are not a link's visit
					if (
						(downloadRequest &&
							Reflect.apply(downloadRequest, event, []) !== null) ||
						(formData && Reflect.apply(formData, event, []) !== null)
					)
						return;
					push = Reflect.apply(navigationType, event, []) === 'push';
					routed = String(
						Reflect.apply(
							destinationURL,
							Reflect.apply(destinationOf, event, []),
							[],
						),
					);
					real = linked(routed);
					if (real) {
						// a link's own navigation: a load, unless it names this
						// document
						if (!ownURL(real)) return;
					} else {
						if (!push || !Reflect.apply(hashChange, event, [])) return;
						const page = unrouteURL(this.client, routed);
						if (page === null || page === routed) return;
						real = new URL(page);
					}
				} catch (error) {
					return;
				}
				const address = absolute(plain(real));
				const route = link(real);
				const at = location.href;
				const entry = push && address !== at;
				const recorded = entry && isLinkRoute(route, scope) && spare();
				// the browser's own navigation to the document's address does
				// as well when the entry cannot be made at the link route
				if (!recorded && routed === address) return;
				Reflect.apply(preventDefault, event, []);
				stepping = true;
				try {
					if (recorded) {
						call('pushState', null, route);
						call('replaceState', null, at);
					}
					// the document's URL as it is replaces its entry, by a
					// fragment navigation or by a load, as natively
					Reflect.apply(
						entry && !recorded ? location.assign : location.replace,
						location,
						[address],
					);
				} finally {
					stepping = false;
				}
			},
		]);

		// an interception commits the URL the navigation names: never a link
		// route's (the navigation goes on as a document load instead)
		const prototype = eventProto as Record<string, unknown>;
		if (typeof prototype.intercept === 'function')
			prototype.intercept = proxyModule.wrapFunction(
				prototype.intercept as (...args: unknown[]) => unknown,
				(target, that, args) => {
					let names = false;
					try {
						names = isLinkRoute(
							String(
								Reflect.apply(
									destinationURL,
									Reflect.apply(destinationOf, that, []),
									[],
								),
							),
							scope,
						);
					} catch (error) {
						// not a navigate event: the native call says so
					}
					return names ? undefined : Reflect.apply(target, that, args);
				},
			);

		// a link followed on a page that listens: the document's address
		// while the click is handled, so what the page hears of (and may
		// intercept) is what it heard before link routes
		const composedPath = global.Event.prototype.composedPath;
		const Element = global.Element;
		const onClick = (event: Event) => {
			if (!observes()) return;
			let element: Element | undefined;
			for (const node of Reflect.apply(composedPath, event, []))
				if (
					node instanceof Element &&
					(node.localName === 'a' || node.localName === 'area')
				) {
					element = node;
					break;
				}
			if (!element) return;
			const written = nativeElement.getAttribute.call(element, 'href');
			if (written === null) return;
			let real: URL | null;
			try {
				real = linked(absolute(written));
			} catch (error) {
				return;
			}
			if (!real || !(intercepts() || ownURL(real))) return;
			const address = plain(real);
			const anchor = element;
			const write = (value: string) =>
				hookWrite(
					anchor,
					() => ['href'],
					() => nativeElement.setAttribute.call(anchor, 'href', value),
				);
			write(address);
			Reflect.apply(setTimeout, global, [
				() => {
					if (nativeElement.getAttribute.call(anchor, 'href') === address)
						write(written);
				},
				0,
			]);
		};
		const install = () =>
			Reflect.apply(nativeEventTarget.addEventListener, global, [
				'click',
				onClick,
				true,
			]);
		install();
		// document.open() drops a window's listeners
		addDocumentOpenListener(global, install);
	}
}
