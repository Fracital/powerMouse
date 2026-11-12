import { routeHTML } from '../../../rewriteHTML';
import { openFragment, sealedFragmentText } from '../../../routeURL';
import StompURL, { sealFragmentText } from '../../../StompURL';
import { beforeFragment } from '../../../urlShape';
import Module from '../../Module';
import { unrouteURL } from '../../modules/Unroute';
import DocumentClient, { addDocumentOpenListener } from '../Client';
import HistoryModule from './History';
import { hookWrite } from './MutationObserver';

const SAME_FRAME = ['', '_self', '_top', '_parent', '_unfencedtop'];

type Entry = object;
interface NavigationLike extends EventTarget {
	readonly currentEntry: Entry | null;
	navigate(url: string, options?: unknown): unknown;
	updateCurrentEntry(options: { state: unknown }): void;
}
interface NavigateEventLike extends Event {
	readonly navigationType: string;
	readonly hashChange: boolean;
	readonly destination: {
		readonly url: string;
		readonly sameDocument: boolean;
	};
}

/**
 * A document's fragment is sealed in its route (docs/codec.md), so the
 * frame's address and its history entries name no part of the page. The
 * browser reads the fragment itself, though: it scrolls to the element it
 * names, matches `:target`, opens a closed `<details>` around it, decides
 * whether a navigation is the same document's and whether `hashchange`
 * fires. So every navigation the page makes to a fragment (through the
 * location, the Navigation API or a link) goes to the fragment as written,
 * the document's current entry made the same a moment before, and the
 * browser does all of that natively; once it is done the entry is sealed
 * again. Where the browser arrives at a sealed fragment on its own (a
 * document loaded at one, a traversal to an entry of one) the module has
 * it apply the fragment as written to the document the same way. The proxy's
 * own history calls (a replaceState, a replacing fragment navigation) are
 * the page's no more: their events never reach it, and the entry they
 * replace is the one it keeps (the History module's alias).
 */
export default class FragmentModule extends Module<DocumentClient> {
	/**
	 * The route of a navigation the page makes to `url` (`routed`, sealed)
	 * as the browser should go there: with the fragment as written, the
	 * current entry made the same first when it is this document's
	 */
	live: (routed: string) => string = (routed) => routed;
	apply() {
		const global = this.client.global;
		const codec = this.client.codec;
		const navigation = (global as { navigation?: NavigationLike }).navigation;
		const location = global.location;
		// taken before any module or page wraps them
		const replaceState = global.History.prototype.replaceState;
		const stateGetter = Reflect.getOwnPropertyDescriptor(
			global.History.prototype,
			'state',
		)!.get!;
		const nativeReplace = location.replace;
		const hrefGetter = Reflect.getOwnPropertyDescriptor(location, 'href')!.get!;
		const href = () => Reflect.apply(hrefGetter, location, []) as string;
		const historyObject = global.history;
		const state = () => Reflect.apply(stateGetter, historyObject, []);
		const currentGetter =
			navigation &&
			Reflect.getOwnPropertyDescriptor(
				Reflect.getPrototypeOf(navigation)!,
				'currentEntry',
			)?.get;
		const current = (): Entry | null =>
			currentGetter
				? (Reflect.apply(currentGetter, navigation, []) as Entry | null)
				: null;
		const updateCurrent =
			navigation &&
			(Reflect.getPrototypeOf(navigation) as NavigationLike).updateCurrentEntry;
		const getState = (
			global as {
				NavigationHistoryEntry?: { prototype: { getState(): unknown } };
			}
		).NavigationHistoryEntry?.prototype.getState;
		const history = () => this.client.getModule(HistoryModule);
		const getElementById = global.Document.prototype.getElementById;
		const getAttribute = global.Element.prototype.getAttribute;
		const setAttribute = global.Element.prototype.setAttribute;
		const addListener = global.EventTarget.prototype.addEventListener;
		const scrollTo = global.scrollTo;
		const post = (callback: () => void) => {
			const channel = new global.MessageChannel();
			channel.port1.onmessage = () => {
				channel.port1.close();
				callback();
			};
			channel.port2.postMessage(null);
		};

		/** `routed` split at its fragment: everything before the `#`, and the fragment (null for none) */
		const split = (routed: string): [string, string | null] => {
			const at = routed.indexOf('#');
			return at === -1
				? [routed, null]
				: [routed.slice(0, at), routed.slice(at + 1)];
		};
		const liveOf = (routed: string) => {
			const [base, fragment] = split(routed);
			return fragment === null
				? routed
				: `${base}#${openFragment(codec, fragment)}`;
		};
		const sealedOf = (routed: string) => {
			const [base, fragment] = split(routed);
			if (fragment === null || sealedFragmentText(codec, fragment) !== null)
				return routed;
			return `${base}#${sealFragmentText(codec, fragment)}`;
		};

		// The proxy's own history calls. Every event they fire synchronously
		// is stopped before the page's listeners (the module's are the first
		// on the window and on the Navigation API), and the navigatesuccess
		// (or navigateerror) of the last one, which comes later
		let quiet = 0;
		let pending = false;
		const swallow = (event: Event) => {
			if (quiet) event.stopImmediatePropagation();
		};
		/** what is left to do after the page's last navigation (a seal, a fragment to apply) */
		let due: (() => void) | null = null;
		/** the page's same-document navigations not yet done */
		let inFlight = 0;
		const runDue = () => {
			const work = due;
			due = null;
			work?.();
		};
		const listenWindow = () => {
			global.addEventListener('popstate', swallow, true);
			global.addEventListener(
				'hashchange',
				(event) => {
					if (quiet) return swallow(event);
					runDue();
				},
				true,
			);
		};
		listenWindow();
		addDocumentOpenListener(global, listenWindow);
		/** run `calls` (native history calls) as the proxy's own, the current entry staying the page's */
		const quietly = (calls: () => void) => {
			const before = current();
			let navigationState: unknown;
			try {
				navigationState =
					before && getState ? Reflect.apply(getState, before, []) : undefined;
			} catch (error) {
				navigationState = undefined;
			}
			// the replaced entry's dispose is the proxy's, not the page's
			if (before)
				Reflect.apply(addListener, before, ['dispose', swallow, true]);
			quiet++;
			try {
				calls();
				if (navigationState !== undefined && updateCurrent)
					Reflect.apply(updateCurrent, navigation, [
						{ state: navigationState },
					]);
			} finally {
				quiet--;
			}
			pending = true;
			const after = current();
			if (before && after && before !== after) history()?.alias(before, after);
		};
		if (navigation) {
			for (const type of ['navigate', 'currententrychange']) {
				navigation.addEventListener(type, swallow, true);
			}
			const settled = (event: Event) => {
				if (quiet) return event.stopImmediatePropagation();
				if (!pending) return;
				pending = false;
				event.stopImmediatePropagation();
			};
			navigation.addEventListener('navigatesuccess', settled, true);
			navigation.addEventListener('navigateerror', settled, true);
		}

		/** the current entry with its fragment sealed, when the browser committed it as written */
		const seal = () => {
			const now = href();
			const sealed = sealedOf(now);
			if (sealed === now) return;
			quietly(() =>
				Reflect.apply(replaceState, historyObject, [state(), '', sealed]),
			);
		};
		/** the current entry with its fragment as written, when it is sealed (before a page's navigation from it) */
		const unseal = () => {
			const now = href();
			const live = liveOf(now);
			if (live === now) return;
			quietly(() =>
				Reflect.apply(replaceState, historyObject, [state(), '', live]),
			);
		};
		/**
		 * The browser applies the current entry's fragment, as written, to
		 * the document (the scroll, `:target`, a `<details>` it opens), the
		 * entry staying sealed; `scroll: false` keeps every scroll position
		 * as it is (a traversal restores its own)
		 */
		const applyFragment = (scroll: boolean) => {
			const now = href();
			const [base, fragment] = split(now);
			if (fragment === null) return;
			const text = sealedFragmentText(codec, fragment);
			if (text === null) return;
			// the fragment directive is not the fragment (Client.location)
			const directive = text.indexOf(':~:');
			const written = directive === -1 ? text : text.slice(0, directive);
			if (!written) return;
			const live = `${base}#${written}`;
			// what the fragment can scroll: the window and every box around
			// the element it names
			const positions: [Element | null, number, number][] = [];
			if (!scroll) {
				positions.push([null, global.scrollX, global.scrollY]);
				let name = written;
				try {
					name = decodeURIComponent(written);
				} catch (error) {
					// as written
				}
				for (
					let element: Element | null = Reflect.apply(
						getElementById,
						global.document,
						[name],
					);
					element;
					element = element.parentElement
				)
					positions.push([element, element.scrollLeft, element.scrollTop]);
			}
			quietly(() => {
				Reflect.apply(replaceState, historyObject, [state(), '', live]);
				Reflect.apply(nativeReplace, location, [live]);
				Reflect.apply(replaceState, historyObject, [state(), '', now]);
			});
			for (const [element, left, top] of positions)
				if (element) {
					element.scrollLeft = left;
					element.scrollTop = top;
				} else Reflect.apply(scrollTo, global, [left, top]);
		};

		this.live = (routed: string) => {
			// another document's (or a link route, src/visited.ts): it loads at
			// the sealed fragment and applies it then
			if (split(routed)[0] !== split(href())[0]) return routed;
			const live = liveOf(routed);
			// this document's: the browser compares it with the current entry
			// (sealed again once the navigation is done: the navigate listener)
			if (live !== routed) unseal();
			return live;
		};

		if (navigation) {
			// a navigation of the browser's own (a link, a traversal) to an
			// entry of this document: sealed again once it is done, its
			// fragment applied when it arrived sealed
			// (every listener the module needs is added now, before any page
			// script: one added later would count as the page's, src/inject/dom/
			// modules/Visited.ts `observes`)
			let finishing: (() => void) | null = null;
			navigation.addEventListener('navigate', (event) => {
				if (quiet) return;
				const navigate = event as NavigateEventLike;
				if (!navigate.destination?.sameDocument) return;
				const traverse = navigate.navigationType === 'traverse';
				const hashChange = navigate.hashChange;
				inFlight = 1;
				finishing = () => {
					inFlight = 0;
					// before the page's hashchange listeners (the browser has
					// applied a fragment by then), or a task later
					due = () => {
						const now = href();
						const fragment = split(now)[1];
						if (fragment === null) return;
						if (sealedFragmentText(codec, fragment) === null) seal();
						else if (hashChange || traverse) applyFragment(!traverse);
					};
					post(runDue);
				};
			});
			const finish = () => {
				if (quiet) return;
				const work = finishing;
				finishing = null;
				work?.();
			};
			navigation.addEventListener('navigatesuccess', finish);
			navigation.addEventListener('navigateerror', finish);
		}

		// A link the page's user (or script) activates navigates to its route
		// with the fragment as written: its href is that route for the time of
		// the activation only. Not one that opens elsewhere (a modifier, a new
		// window, a download): there the route is what shows
		const onClick = (event: MouseEvent) => {
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
			if (!link || link.hasAttribute('download')) return;
			const target = (
				link.getAttribute('target') ||
				global.document.querySelector('base[target]')?.getAttribute('target') ||
				''
			).toLowerCase();
			if (!SAME_FRAME.includes(target) && !this.client.hasFrameNamed(target))
				return;
			const routed = Reflect.apply(getAttribute, link, ['href']) as
				string | null;
			if (!routed || split(routed)[1] === null) return;
			// the URL it stands for (a link route's too), as this document's
			// own address would name it: a link to this document only
			let address: string;
			try {
				const real = unrouteURL(this.client, new URL(routed, href()).href);
				if (real === null) return;
				const url = new URL(real);
				if (beforeFragment(url) !== beforeFragment(this.client.url.url)) return;
				address = new URL(
					routeHTML(
						new StompURL(url, this.client.url),
						this.client.url,
						this.client.config,
						false,
						this.client.nestedRoute,
					),
					href(),
				).href;
			} catch (error) {
				return;
			}
			const live = this.live(address);
			if (live === address) return;
			const set = (value: string) =>
				hookWrite(
					link,
					() => ['href'],
					() => Reflect.apply(setAttribute, link, ['href', value]),
				);
			set(live);
			// back as soon as the browser took it (it navigates right after the
			// click, or never: a cancelled click)
			post(() => {
				set(routed);
				// a click the page cancelled: the entry made ready for it is sealed
				if (!inFlight) seal();
			});
		};
		const listenClicks = () => global.addEventListener('click', onClick, true);
		listenClicks();
		addDocumentOpenListener(global, listenClicks);

		// A document loaded at a fragment: the browser found nothing for it
		// (its shell had no content yet, or the fragment was sealed), so the
		// module applies it once the page's markup is parsed: scrolled to on a
		// new navigation and not on a reload or a traversal, which restore their
		// own position. Natively the browser keeps the element in view until
		// the load event, so it is applied again then, unless the user has
		// scrolled since. A shell's own DOMContentLoaded comes before the page
		// is written (document.open()); the page's comes after
		const kind = (() => {
			try {
				return (
					(
						global.performance.getEntriesByType('navigation')[0] as
							PerformanceNavigationTiming | undefined
					)?.type ?? 'navigate'
				);
			} catch (error) {
				return 'navigate';
			}
		})();
		const scroll = kind === 'navigate';
		const atLoad = split(href())[1];
		if (atLoad !== null && atLoad !== '') {
			let applied: [number, number] | null = null;
			const parsed = () => {
				seal();
				applyFragment(scroll);
				applied = [global.scrollX, global.scrollY];
			};
			// (a reload or a traversal: the browser applies the URL's fragment,
			// the sealed one, again as it restores the position, and finds
			// nothing)
			const loaded = () =>
				applyFragment(
					scroll &&
						!!applied &&
						applied[0] === global.scrollX &&
						applied[1] === global.scrollY,
				);
			const listenLoad = () => {
				global.addEventListener('DOMContentLoaded', parsed, {
					once: true,
					capture: true,
				});
				global.addEventListener('load', loaded, { once: true, capture: true });
			};
			listenLoad();
			addDocumentOpenListener(global, listenLoad);
		}
	}
}
