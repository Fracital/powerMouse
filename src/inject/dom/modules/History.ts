import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient from '../Client';

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
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const global = this.client.global;
		const prototype = global.History.prototype;
		// taken before any page code runs
		const navigation = (global as { navigation?: NavigationLike }).navigation;

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
						url = new URL(String(args[2]), this.client.url.toString());
					} catch (error) {
						url = null;
					}
					if (!url || url.origin !== page.origin)
						throw new this.client.global.DOMException(
							`Failed to execute '${name}' on 'History': A history state object with URL '${String(args[2])}' cannot be created in a document with origin '${page.origin}' and URL '${page.href}'.`,
							'SecurityError',
						);
					args[2] = routeHTML(
						new StompURL(url, this.client.url),
						this.client.url,
						this.client.config,
						false,
						this.client.nestedRoute,
					);
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

		prototype.back = proxyModule.wrapFunction(prototype.back, () => {
			if (navigation.canGoBack) quiet(navigation.back());
		});

		prototype.forward = proxyModule.wrapFunction(prototype.forward, () => {
			if (navigation.canGoForward) quiet(navigation.forward());
		});

		prototype.go = proxyModule.wrapFunction(
			prototype.go,
			(target, that, args) => {
				// go() and go(0) reload the document
				const delta = args.length ? Number(args[0]) : 0;
				if (delta === 0 || Number.isNaN(delta))
					return Reflect.apply(target, that, [0]);
				const entries = navigation.entries();
				const index =
					(navigation.currentEntry?.index ?? -1) + Math.trunc(delta);
				if (index < 0 || index >= entries.length) return;
				quiet(navigation.traverseTo(entries[index].key));
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
				return navigation.entries().length;
			}),
		});
	}
}
