import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { unrouteURL } from '../../modules/Unroute';
import { withStack } from '../../nativeErrors';
import DocumentClient from '../Client';
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
	/** the browser's own pushState and replaceState, from before any module wrapped them */
	native?: Pick<History, 'pushState' | 'replaceState'>;
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
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
				if (args[2] !== undefined && args[2] !== null) {
					// the browser refuses a URL of another origin (every proxied URL
					// looks same-origin to it, so the check is made here on the real
					// origins) and one that does not parse, with a SecurityError
					const page = this.client.url.url;
					let url: URL | null;
					try {
						url = new URL(String(args[2]), this.client.baseURL.toString());
					} catch (error) {
						url = null;
					}
					if (!url || url.origin !== page.origin)
						throw withStack(
							new this.client.global.DOMException(
								`Failed to execute '${name}' on 'History': A history state object with URL '${String(args[2])}' cannot be created in a document with origin '${page.origin}' and URL '${page.href}'.`,
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

		prototype.back = proxyModule.wrapFunction(prototype.back, () => {
			const index = indexOf(currentEntry()!);
			if (index > 0) quiet(traverse(allEntries()[index - 1].key));
		});

		prototype.forward = proxyModule.wrapFunction(prototype.forward, () => {
			const entries = allEntries();
			const index = indexOf(currentEntry()!);
			if (index >= 0 && index < entries.length - 1)
				quiet(traverse(entries[index + 1].key));
		});

		prototype.go = proxyModule.wrapFunction(
			prototype.go,
			(target, that, args) => {
				// go() and go(0) reload the document
				const delta = args.length ? Number(args[0]) : 0;
				if (delta === 0 || Number.isNaN(delta))
					return Reflect.apply(target, that, [0]);
				const entries = allEntries();
				const current = currentEntry();
				const index = (current ? indexOf(current) : -1) + Math.trunc(delta);
				if (index < 0 || index >= entries.length) return;
				quiet(traverse(entries[index].key));
			},
		);

		const lengthDescriptor = Reflect.getOwnPropertyDescriptor(
			prototype,
			'length',
		)!;
		Reflect.defineProperty(prototype, 'length', {
			...lengthDescriptor,
			get: proxyModule.wrapFunction(lengthDescriptor.get!, (target, that) => {
				// the native getter first: it throws for anything but a History
				Reflect.apply(target, that, []);
				return allEntries().length;
			}),
		});

		if (!entryProto || !nativeEntryURL) return;
		// The Navigation API shows a document only the entries of its own
		// origin around it: every route is same-origin to the browser, so the
		// entries of another site's documents in this frame (their URLs, their
		// keys) were listed, and canGoBack said yes into another site. History
		// keeps the frame's whole list (history.back() crosses origins
		// natively too)
		const own = () =>
			this.client.opaqueRequests ? 'null' : this.client.url.url.origin;
		const originOf = (entry: Entry): string => {
			const raw = Reflect.apply(nativeEntryURL, entry, []) as string | null;
			if (raw === null) return 'null';
			try {
				return new URL(unrouteURL(this.client, raw) ?? raw).origin;
			} catch (error) {
				return 'null';
			}
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
				return visible();
			},
		);
		Reflect.defineProperty(entryProto, 'index', {
			...Reflect.getOwnPropertyDescriptor(entryProto, 'index')!,
			get: proxyModule.wrapFunction(nativeIndex!, (target, that, args) => {
				const index = Reflect.apply(target, that, args) as number;
				if (index < 0) return index;
				return visible().indexOf(that as Entry);
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
					const entries = visible();
					const current = currentEntry();
					const index = current ? entries.indexOf(current) : -1;
					const next = entries[index + step];
					if (index >= 0 && next)
						return Reflect.apply(nativeTraverseTo, that, [next.key, ...args]);
					const error = new global.DOMException(message, 'InvalidStateError');
					const committed = global.Promise.reject(error);
					const finished = global.Promise.reject(error);
					finished.catch(() => {});
					return { committed, finished };
				},
			);
		}
	}
}
