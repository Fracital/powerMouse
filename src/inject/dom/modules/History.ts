import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import { withStack } from '../../nativeErrors';
import { LazyWeakMap } from '../../ownCollections';
import DocumentClient from '../Client';
import { destinationURL } from '../freshContext';
import { Pool } from '../pool';
import { nativeEventTarget } from './DOMHooks';
import FragmentModule from './Fragment';
import NavigationHintModule from './NavigationHint';
import VisitedModule from './Visited';

/**
 * The Navigation API, scoped to this frame's own entries. TypeScript's DOM
 * lib does not declare it; browsers without it (none of ours) fall back to
 * the native History methods.
 */
interface NavigationLike {
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly currentEntry: { readonly index: number } | null;
	entries(): { readonly key: string }[];
	back(): { committed: Promise<unknown>; finished: Promise<unknown> };
	forward(): { committed: Promise<unknown>; finished: Promise<unknown> };
	traverseTo(key: string): {
		committed: Promise<unknown>;
		finished: Promise<unknown>;
	};
}

// a URL as the browser quotes it in a message (KURL::ElidedString): one
// over 1024 characters as its first 511, "..." and its last 510
const elided = (value: string) =>
	value.length <= 1024
		? value
		: `${value.slice(0, 511)}...${value.slice(-510)}`;

/**
 * The page sees a history that is its own, as a top-level page would:
 * pushState/replaceState URLs are routed, `length` counts the frame's
 * entries rather than the joint session history of the host page and every
 * frame in it, and back/forward/go step those entries only. A traversal
 * past either end does nothing, which is what a top-level page gets; the
 * joint history would hand the step to the host or to a sibling frame.
 */
export default class HistoryModule extends Module<DocumentClient> {
	/**
	 * Whether the frame's own history can step back (-1) or forward (1), all
	 * of it (the host's buttons step it, across origins too); null without
	 * the Navigation API
	 */
	canStep: (step: -1 | 1) => boolean | null = () => null;
	/**
	 * The document's entry and the count of the entries around it the
	 * browser lists (`[index, length]`, the Navigation API's own view: under
	 * a site pool, its slot's stretch of the frame's history); null without
	 * the Navigation API; only for a top document under a site pool
	 */
	ownRun?: () => [number, number] | null;
	/** the browser's own pushState and replaceState, from before any module wrapped them */
	native?: Pick<History, 'pushState' | 'replaceState'>;
	/**
	 * `after` replaced the current entry `before` for the proxy's own reasons
	 * (the Fragment module seals the URL the browser committed): to the page
	 * it is still the entry it had, the same object with the same id, which
	 * natively was never replaced. Unset without the Navigation API.
	 */
	alias: (before: object, after: object) => void = () => {};
	apply() {
		const moduleClient = this.client;
		const proxyModule = moduleClient.getModule(ProxyModule)!;
		const global = moduleClient.global;
		const prototype = global.History.prototype;
		// taken before any page code runs
		const navigation = (global as { navigation?: NavigationLike }).navigation;
		this.native = {
			pushState: prototype.pushState,
			replaceState: prototype.replaceState,
		};

		const updateState = (name: 'pushState' | 'replaceState') =>
			function (
				this: HistoryModule,
				target: typeof history.pushState,
				that: History,
				args: any[],
			) {
				// no URL, or the empty string, keeps the entry's URL as it is, its
				// fragment too (the browser's own rule: resolved like any other
				// URL, '' would be the base URL without one)
				if (args[2] !== undefined && args[2] !== null && args[2] !== '') {
					// the browser refuses a URL of another origin (every proxied URL
					// looks same-origin to it, so the check is made here on the real
					// origins), one that names other credentials than the document's
					// and one that does not parse, with a SecurityError quoting the
					// URL resolved (the text itself when it does not parse)
					const page = this.client.url.url;
					// converted once, as the browser does, and with no call of the
					// inject's own between the page's toString and its caller
					// (`String(value)` is a frame of its own in the page's stack)
					const text = `${args[2]}`;
					let url: URL | null;
					try {
						url = new URL(text, this.client.baseHref);
					} catch (error) {
						url = null;
					}
					if (
						!url ||
						// (a blob: URL's origin is its creator's, its scheme another)
						url.protocol !== page.protocol ||
						url.origin !== page.origin ||
						url.username !== page.username ||
						url.password !== page.password
					)
						throw withStack(
							new this.client.global.DOMException(
								`Failed to execute '${name}' on 'History': A history state object with URL '${elided(url ? url.href : text)}' cannot be created in a document with origin '${page.origin}' and URL '${elided(page.href)}'.`,
								'SecurityError',
							),
						);
					args[2] = routeHTML(
						new StompURL(url, this.client.url),
						this.client.url,
						this.client.config,
						false,
						this.client.nestedRoute,
					);
					// a new entry is a visit the browser's history records: made
					// at the link route first (the Visited module)
					if (
						name === 'pushState' &&
						this.client
							.getModule(VisitedModule)
							?.pushState(target, that, args, url)
					)
						return undefined;
				}

				return Reflect.apply(target, that, args);
			};

		prototype.pushState = proxyModule.wrapFunction(
			prototype.pushState,
			updateState('pushState').bind(this),
		);

		prototype.replaceState = proxyModule.wrapFunction(
			prototype.replaceState,
			updateState('replaceState').bind(this),
		);

		if (!navigation) return;

		// the traversal promises reject when the step is cancelled or the
		// document goes away; history.* methods return nothing either way
		const quiet = (result: {
			committed: Promise<unknown>;
			finished: Promise<unknown>;
		}) => {
			result.committed.catch(() => {});
			result.finished.catch(() => {});
		};

		// the frame's entries as the browser has them, taken before the
		// Navigation API's own view is narrowed below
		const navigationProto = Reflect.getPrototypeOf(navigation) as Record<
			string,
			unknown
		>;
		const method = (name: string) =>
			Reflect.getOwnPropertyDescriptor(navigationProto, name)!.value as (
				...args: unknown[]
			) => unknown;
		const accessor = (proto: object, name: string) =>
			Reflect.getOwnPropertyDescriptor(proto, name)!.get!;
		type Entry = { readonly key: string };
		// navigation.navigate(url): the page's URL, resolved against its own
		// address, is routed as a navigation of the document is
		// (location.assign, or with `history: 'replace'` location.replace).
		// Unhooked, the URL resolved against the proxy's address and the frame
		// left the proxy for the proxy origin's own path.
		if (typeof navigationProto.navigate === 'function')
			navigationProto.navigate = proxyModule.wrapFunction(
				method('navigate'),
				(target, that, args) => {
					if (that !== navigation || !args.length)
						return Reflect.apply(target, that, args);
					let destination: URL;
					try {
						destination = new URL(String(args[0]), moduleClient.url.toString());
					} catch (error) {
						// the browser's own SyntaxError
						return Reflect.apply(target, that, args);
					}
					const options = args[1] as { history?: unknown } | undefined;
					const routed =
						options?.history === 'replace'
							? routeHTML(
									new StompURL(destination, moduleClient.url),
									moduleClient.url,
									moduleClient.config,
									false,
									moduleClient.nestedRoute,
								)
							: moduleClient.navigationRoute(destination);
					// to a fragment of this document as written (the Fragment module)
					const live =
						moduleClient
							.getModule(FragmentModule)
							?.live(new URL(routed, moduleClient.global.location.href).href) ??
						routed;
					return Reflect.apply(target, that, [live, ...args.slice(1)]);
				},
			);
		const nativeEntries = method('entries');
		const nativeTraverseTo = method('traverseTo');
		const nativeCurrent = accessor(navigationProto, 'currentEntry');
		const allEntries = () =>
			Reflect.apply(nativeEntries, navigation, []) as Entry[];
		const currentEntry = () =>
			Reflect.apply(nativeCurrent, navigation, []) as Entry | null;
		const entryProto = global.NavigationHistoryEntry?.prototype;
		const nativeIndex = entryProto && accessor(entryProto, 'index');
		const nativeEntryURL = entryProto && accessor(entryProto, 'url');
		const nativeKey = entryProto && accessor(entryProto, 'key');
		const indexOf = (entry: Entry) =>
			Reflect.apply(nativeIndex!, entry, []) as number;
		const traverse = (key: string) =>
			Reflect.apply(nativeTraverseTo, navigation, [key]) as ReturnType<
				NavigationLike['traverseTo']
			>;

		this.canStep = (step) => {
			const current = currentEntry();
			if (!current) return false;
			const index = indexOf(current) + step;
			return index >= 0 && index < allEntries().length;
		};
		// (the site pool's, for a top document: a frame without one, or with
		// a parent in reach, makes no closure for it)
		if (moduleClient.sites && !moduleClient.nested)
			this.ownRun = () => {
				const current = currentEntry();
				return current ? [indexOf(current), allEntries().length] : null;
			};

		const lengthDescriptor = Reflect.getOwnPropertyDescriptor(
			prototype,
			'length',
		)!;
		// The browser applies a step when its task runs, from wherever the
		// steps queued before it leave the history: history.back() twice in
		// one task goes back two entries. Counted from the current entry at
		// the call, both went to the same one, so a step still under way is
		// counted on. (A step to another document never settles here; that
		// document is gone with its count.)
		let queued = 0;
		let landing = -1;
		// the site pool: the entries of another site's documents are of
		// another origin, which the browser lists to nobody here; past this
		// site's run a step back or forward is the browser's own, across
		// origins
		const sites = moduleClient.sites;
		const step = (
			that: History,
			delta: number,
			name: 'back' | 'forward' | 'go',
			native?: Function,
		) => {
			// the native getter first: it throws for anything but a History, and
			// for the History of a document that is not fully active (a removed
			// frame's), as the browser's own back, forward and go do
			Reflect.apply(lengthDescriptor.get!, that, []);
			// another window's History, the method borrowed across realms
			// (`frame.contentWindow.history.back.call(history)`): the step is
			// that window's, as natively, made by that window's own method
			if (that !== global.history) {
				const own = (Reflect.getPrototypeOf(that) as History | null)?.[name];
				if (typeof own === 'function' && own !== prototype[name])
					Reflect.apply(own, that, name === 'go' ? [delta] : []);
				return;
			}
			const current = currentEntry();
			// a frame's initial about:blank has no entries to step
			if (!current) return;
			const entries = allEntries();
			const index = (queued > 0 ? landing : indexOf(current)) + delta;
			if (index < 0 || index >= entries.length) {
				if (sites && native) Reflect.apply(native, that, []);
				return;
			}
			const result = traverse(entries[index].key);
			queued++;
			landing = index;
			const settled = () => {
				if (--queued === 0) landing = -1;
			};
			result.finished.then(settled, settled);
			quiet(result);
		};

		prototype.back = proxyModule.wrapFunction(prototype.back, (target, that) =>
			step(that, -1, 'back', target),
		);

		prototype.forward = proxyModule.wrapFunction(
			prototype.forward,
			(target, that) => step(that, 1, 'forward', target),
		);

		prototype.go = proxyModule.wrapFunction(
			prototype.go,
			(target, that, args) => {
				// go() and go(0) reload the document
				const delta = args.length ? Number(args[0]) : 0;
				if (delta === 0 || Number.isNaN(delta))
					return Reflect.apply(target, that, [0]);
				step(that, Math.trunc(delta), 'go');
			},
		);

		Reflect.defineProperty(prototype, 'length', {
			...lengthDescriptor,
			get: proxyModule.wrapFunction(lengthDescriptor.get!, (target, that) => {
				// the native getter first: it throws for anything but a History
				Reflect.apply(target, that, []);
				// (the site pool: and the frame's entries in other slots, which
				// the browser lists to nobody here)
				return allEntries().length + this.client.pool[Pool.HistoryAcross];
			}),
		});

		if (!entryProto || !nativeEntryURL) return;

		// the entries the page holds for the ones the proxy re-wrote (alias)
		const toPage = new LazyWeakMap<object, Entry>();
		const toReal = new LazyWeakMap<object, Entry>();
		const pageOf = <T>(entry: T): T =>
			(entry && (toPage.get(entry as object) as T)) ?? entry;
		const realOf = <T>(entry: T): T =>
			(entry && (toReal.get(entry as object) as T)) ?? entry;
		this.alias = (before, after) => {
			const page = pageOf(before) as Entry;
			toPage.set(after, page);
			toReal.set(page, after as Entry);
		};
		const currentDescriptor = Reflect.getOwnPropertyDescriptor(
			navigationProto,
			'currentEntry',
		)!;
		Reflect.defineProperty(navigationProto, 'currentEntry', {
			...currentDescriptor,
			get: proxyModule.wrapFunction(nativeCurrent, (target, that, args) =>
				pageOf(Reflect.apply(target, that, args)),
			),
		});
		// an alias answers for the entry it stands for (its id is its own: the
		// page's entry was never replaced natively)
		for (const name of ['key', 'url', 'sameDocument']) {
			const descriptor = Reflect.getOwnPropertyDescriptor(entryProto, name);
			if (!descriptor?.get) continue;
			Reflect.defineProperty(entryProto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) =>
					Reflect.apply(target, realOf(that), args),
				),
			});
		}
		const getState = Reflect.getOwnPropertyDescriptor(entryProto, 'getState');
		if (typeof getState?.value === 'function')
			Reflect.defineProperty(entryProto, 'getState', {
				...getState,
				value: proxyModule.wrapFunction(getState.value, (target, that, args) =>
					Reflect.apply(target, realOf(that), args),
				),
			});
		const changeProto = (
			global as { NavigationCurrentEntryChangeEvent?: { prototype: object } }
		).NavigationCurrentEntryChangeEvent?.prototype;
		const changeFrom =
			changeProto && Reflect.getOwnPropertyDescriptor(changeProto, 'from');
		if (changeProto && changeFrom?.get)
			Reflect.defineProperty(changeProto, 'from', {
				...changeFrom,
				get: proxyModule.wrapFunction(changeFrom.get, (target, that, args) =>
					pageOf(Reflect.apply(target, that, args)),
				),
			});
		// The Navigation API shows a document only the entries of its own
		// origin around it: every route is same-origin to the browser, so the
		// entries of another site's documents in this frame (their URLs, their
		// keys) were listed, and canGoBack said yes into another site. History
		// keeps the frame's whole list (history.back() crosses origins
		// natively too)
		const own = () =>
			moduleClient.opaqueRequests ? 'null' : moduleClient.url.url.origin;
		const originOf = (entry: Entry): string => {
			const raw = Reflect.apply(nativeEntryURL, entry, []) as string | null;
			if (raw === null) return 'null';
			try {
				return new URL(unrouteURL(moduleClient, raw) ?? raw).origin;
			} catch (error) {
				return 'null';
			}
		};
		/** a traversal the browser refuses: both of its promises reject */
		const failed = (message: string) => {
			const error = withStack(
				new global.DOMException(message, 'InvalidStateError'),
			);
			const committed = global.Promise.reject(error);
			const finished = global.Promise.reject(error);
			finished.catch(() => {});
			return { committed, finished };
		};
		/** the run of entries of this document's origin around the current one */
		const visible = (): Entry[] => {
			const entries = allEntries();
			const current = currentEntry();
			if (!current) return [];
			const at = indexOf(current);
			if (at < 0) return [];
			const origin = own();
			let start = at;
			let end = at;
			while (start > 0 && originOf(entries[start - 1]) === origin) start--;
			while (end < entries.length - 1 && originOf(entries[end + 1]) === origin)
				end++;
			return entries.slice(start, end + 1);
		};
		// the entry the document was navigated from is shown only when it is
		// of the document's own origin, as natively (every route is
		// same-origin to the browser, so another site's document read the
		// whole URL of the page that linked to it)
		const activationProto = (
			global as { NavigationActivation?: { prototype: object } }
		).NavigationActivation?.prototype;
		const from =
			activationProto &&
			Reflect.getOwnPropertyDescriptor(activationProto, 'from');
		if (activationProto && from?.get)
			Reflect.defineProperty(activationProto, 'from', {
				...from,
				get: proxyModule.wrapFunction(from.get, (target, that, args) => {
					const entry = Reflect.apply(target, that, args) as Entry | null;
					return entry && originOf(entry) !== own() ? null : entry;
				}),
			});
		navigationProto.entries = proxyModule.wrapFunction(
			nativeEntries,
			(target, that, args) => {
				Reflect.apply(target, that, args);
				return visible().map(pageOf);
			},
		);
		const visibleKeys = () =>
			visible().map((entry) => Reflect.apply(nativeKey!, entry, []) as string);
		// a key of an entry outside that run is as unknown as natively: the
		// browser's list has every site's entries of the frame, and
		// traverseTo() went into another site's document
		navigationProto.traverseTo = proxyModule.wrapFunction(
			nativeTraverseTo,
			(target, that, args) => {
				if (that !== navigation || !args.length)
					return Reflect.apply(target, that, args);
				const key = `${args[0]}`;
				return visibleKeys().includes(key)
					? Reflect.apply(target, that, [key, ...args.slice(1)])
					: failed('Invalid key');
			},
		);
		// A traversal to an entry outside the run is not heard of in this
		// document, as natively: its navigate event showed the other site's
		// URL and state. Heard first (captured), before the page's listeners;
		// the worker still hears where it goes (NavigationHint)
		const { NavigateEvent, NavigationDestination } = global as {
			NavigateEvent?: { prototype: object };
			NavigationDestination?: { prototype: object };
		};
		const eventProto = NavigateEvent?.prototype;
		const destinationProto = NavigationDestination?.prototype;
		/** the origin the latest cross-document navigation set out for (pageswap, below) */
		let setOut: string | undefined;
		if (eventProto && destinationProto) {
			const destinationOf = accessor(eventProto, 'destination');
			const typeOf = accessor(eventProto, 'navigationType');
			const destinationKey = accessor(destinationProto, 'key');
			const destinationHref = accessor(destinationProto, 'url');
			const destinationSame = accessor(destinationProto, 'sameDocument');
			const keyOf = (event: object) =>
				Reflect.apply(
					destinationKey,
					Reflect.apply(destinationOf, event, []),
					[],
				) as string;
			Reflect.apply(nativeEventTarget.addEventListener, navigation, [
				'navigate',
				(event: Event) => {
					try {
						const to = Reflect.apply(destinationOf, event, []);
						if (!Reflect.apply(destinationSame, to, [])) {
							const raw = String(Reflect.apply(destinationHref, to, []));
							setOut = new URL(unrouteURL(moduleClient, raw) ?? raw).origin;
						}
					} catch (error) {
						setOut = 'null';
					}
					try {
						if (
							Reflect.apply(typeOf, event, []) !== 'traverse' ||
							visibleKeys().includes(keyOf(event))
						)
							return;
						const routed = destinationURL(
							Reflect.apply(destinationOf, event, []),
						);
						if (routed !== null)
							moduleClient
								.getModule(NavigationHintModule)
								?.hint(unrouteURL(moduleClient, routed) ?? routed);
					} catch (error) {
						return;
					}
					event.stopImmediatePropagation();
				},
				true,
			]);
			// its index is the entry's in that run
			const index = Reflect.getOwnPropertyDescriptor(destinationProto, 'index');
			if (index?.get)
				Reflect.defineProperty(destinationProto, 'index', {
					...index,
					get: proxyModule.wrapFunction(index.get, (target, that, args) => {
						const at = Reflect.apply(target, that, args) as number;
						if (at < 0) return at;
						return visibleKeys().indexOf(
							Reflect.apply(destinationKey, that, []) as string,
						);
					}),
				});
		}
		// what pageswap shows of a navigation to another site's document:
		// nothing, as natively, and nothing of one that set out for another
		// site and was redirected back (Chrome's null for a cross-origin
		// redirect: a page never reads the URL another site sent its visitor
		// on to, an OAuth code)
		const swapProto = (global as { PageSwapEvent?: { prototype: object } })
			.PageSwapEvent?.prototype;
		const swap =
			swapProto && Reflect.getOwnPropertyDescriptor(swapProto, 'activation');
		const activationEntry =
			activationProto &&
			Reflect.getOwnPropertyDescriptor(activationProto, 'entry')?.get;
		if (swapProto && swap?.get && activationEntry)
			Reflect.defineProperty(swapProto, 'activation', {
				...swap,
				get: proxyModule.wrapFunction(swap.get, (target, that, args) => {
					const activation = Reflect.apply(target, that, args) as object | null;
					const entry =
						activation &&
						(Reflect.apply(activationEntry, activation, []) as Entry | null);
					const origin = own();
					return entry &&
						(originOf(entry) !== origin ||
							(setOut !== undefined && setOut !== origin))
						? null
						: activation;
				}),
			});
		Reflect.defineProperty(entryProto, 'index', {
			...Reflect.getOwnPropertyDescriptor(entryProto, 'index')!,
			get: proxyModule.wrapFunction(nativeIndex!, (target, that, args) => {
				const index = Reflect.apply(target, realOf(that), args) as number;
				if (index < 0) return index;
				return visible().indexOf(realOf(that) as Entry);
			}),
		});
		for (const [name, step] of [
			['canGoBack', -1],
			['canGoForward', 1],
		] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				navigationProto,
				name,
			)!;
			Reflect.defineProperty(navigationProto, name, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get!, (target, that, args) => {
					Reflect.apply(target, that, args);
					const entries = visible();
					const current = currentEntry();
					const index = current ? entries.indexOf(current) : -1;
					return (
						index >= 0 && index + step >= 0 && index + step < entries.length
					);
				}),
			});
		}
		// back() and forward() step through that run only; past its end they
		// fail as the browser's do
		for (const [name, step, message] of [
			['back', -1, 'Cannot go back'],
			['forward', 1, 'Cannot go forward'],
		] as const) {
			const native = method(name);
			navigationProto[name] = proxyModule.wrapFunction(
				native,
				(target, that, args) => {
					if (that !== navigation) return Reflect.apply(target, that, args);
					const entries = visible();
					const current = currentEntry();
					const index = current ? entries.indexOf(current) : -1;
					const next = entries[index + step];
					if (index >= 0 && next)
						return Reflect.apply(nativeTraverseTo, that, [
							Reflect.apply(nativeKey!, next, []),
							...args,
						]);
					return failed(message);
				},
			);
		}
	}
}
