import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { scopePrefix, unrouteURL } from '../../modules/Unroute';
import type DocumentClient from '../Client';
import { nativeElement } from './DOMHooks';
import { MARKER } from './MutationObserver';

const FEATURE = 'cross-origin-isolated';

/**
 * Cross-origin isolation in a host page that is isolated
 * (src/isolation.ts). The service worker serves a document that is not
 * isolated natively with `Permissions-Policy: cross-origin-isolated=()`, and
 * Chrome then gives it what a page without isolation has. What that header
 * shows of itself is put right here: `document.featurePolicy` says of the
 * feature what the page's own headers and its embedder make of it (a page
 * without isolation has the permission all the same), and a window Chrome
 * kept from the frame's initial about:blank (a first navigation within one
 * origin keeps it, with the globals an isolated embedder's blank document
 * had) loses its SharedArrayBuffer global. Nothing is installed when the
 * host's page is not isolated.
 */
export default class IsolationModule extends Module<DocumentClient> {
	/**
	 * performance.measureUserAgentSpecificMemory() (an isolated page has it)
	 * says where the memory it measured is: the URL of every window and
	 * worker of the page's own origin and, for a frame, its element's id and
	 * `src`. The browser measures everything that shares the page's agent
	 * cluster, and names it by what it has: the page's and its frames'
	 * routes, the routed `src` the inject wrote, and the host's page, the
	 * controller's frame and the proxy's own workers, which are no part of
	 * the page. The result shows the page's own URLs, its frames' `src` as
	 * the page wrote them, and nothing of what is not the page's: those
	 * parts leave the breakdown and their bytes the total.
	 */
	applyMeasuredMemory(proxyModule: ProxyModule) {
		const client = this.client;
		const global = client.global as typeof globalThis & Record<string, any>;
		const proto = global.Performance?.prototype as unknown as
			Record<string, unknown> | undefined;
		const measure = proto?.measureUserAgentSpecificMemory;
		if (!proto || typeof measure !== 'function') return;
		const NativePromise = global.Promise as PromiseConstructor;
		const then = NativePromise.prototype.then;
		const origin = new URL(scopePrefix(client)).origin;
		/** the `src` the page gave the frame whose element has `routed` */
		const written = (id: unknown, routed: string): string => {
			try {
				for (const element of global.document.querySelectorAll(
					'iframe,frame,object,embed',
				) as Iterable<Element>) {
					const get = (name: string) =>
						Reflect.apply(nativeElement.getAttribute, element, [name]) as
							string | null;
					const name = element.localName === 'object' ? 'data' : 'src';
					if (get(name) !== routed || (get('id') ?? '') !== id) continue;
					const marked = get(`${MARKER}${name}`);
					if (marked !== null) return marked;
				}
			} catch (error) {
				// no document to look in: the route's URL
			}
			return unrouteURL(client, routed) ?? routed;
		};
		/** whether a place the browser named is the page's; its URLs made the page's */
		const pages = (where: Record<string, any>): boolean => {
			const container = where.container as
				{ id?: unknown; src?: unknown } | null | undefined;
			if (container && typeof container.src === 'string' && container.src)
				container.src = written(container.id, container.src);
			if (where.scope === 'cross-origin-aggregated')
				// (what is around the page, not in it: the host, in another origin)
				return !!container;
			if (typeof where.url !== 'string' || !where.url.startsWith(origin))
				return true;
			const real = where.url.startsWith(scopePrefix(client))
				? unrouteURL(client, where.url)
				: null;
			if (real === null) return false;
			where.url = real;
			return true;
		};
		const own = (measured: unknown) => {
			try {
				const result = measured as {
					bytes: number;
					breakdown: { bytes: number; attribution: Record<string, any>[] }[];
				};
				for (let index = result.breakdown.length - 1; index >= 0; index--) {
					const part = result.breakdown[index];
					if (!part.attribution.length) continue;
					const kept = part.attribution.filter(pages);
					if (kept.length === part.attribution.length) continue;
					if (!kept.length) {
						result.bytes -= part.bytes;
						result.breakdown.splice(index, 1);
					} else part.attribution.splice(0, part.attribution.length, ...kept);
				}
			} catch (error) {
				// not the shape this knows: as the browser gave it
			}
			return measured;
		};
		proto.measureUserAgentSpecificMemory = proxyModule.wrapFunction(
			measure,
			(target, that, args) => {
				const pending = Reflect.apply(target, that, args) as Promise<unknown>;
				return new NativePromise((resolve, reject) => {
					Reflect.apply(then, pending, [
						(measured: unknown) => resolve(own(measured)),
						reject,
					]);
				});
			},
		);
	}
	apply() {
		const client = this.client;
		const global = client.global as typeof globalThis & {
			FeaturePolicy?: { prototype: Record<string, unknown> };
		};
		if (!client.hostIsolated) return;
		client.hideSharedArrayBuffer();
		const proxyModule = client.getModule(ProxyModule)!;
		this.applyMeasuredMemory(proxyModule);
		const prototype = global.FeaturePolicy?.prototype;
		const own = Reflect.getOwnPropertyDescriptor(
			global.Document.prototype,
			'featurePolicy',
		)?.get;
		if (!prototype || !own) return;
		// the answers are about this document's policy only: a frame
		// element's is the browser's
		const mine = (that: unknown) => {
			try {
				return that === Reflect.apply(own, global.document, []);
			} catch (error) {
				return false;
			}
		};
		const allowed = () => client.isolationFacts.includes('p');
		const wrap = (
			name: string,
			handler: (native: unknown, that: unknown, args: unknown[]) => unknown,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(prototype, name);
			if (typeof descriptor?.value !== 'function') return;
			Reflect.defineProperty(prototype, name, {
				...descriptor,
				value: proxyModule.wrapFunction(
					descriptor.value,
					(target, that, args) => {
						const native = Reflect.apply(target, that, args);
						return mine(that) ? handler(native, that, args) : native;
					},
				),
			});
		};
		const features = Reflect.getOwnPropertyDescriptor(prototype, 'features')
			?.value as (() => string[]) | undefined;
		wrap('allowsFeature', (native, _that, args) => {
			if (String(args[0]) !== FEATURE) return native;
			return (
				allowed() &&
				(args.length < 2 || String(args[1]) === client.url.url.origin)
			);
		});
		wrap('getAllowlistForFeature', (native, _that, args) => {
			if (String(args[0]) !== FEATURE) return native;
			return allowed() ? [client.url.url.origin] : [];
		});
		wrap('allowedFeatures', (native, that) => {
			const list = native as string[];
			if (list.includes(FEATURE) === allowed()) return list;
			if (!allowed()) return list.filter((name) => name !== FEATURE);
			// in its native place: the order of every feature the browser knows
			const order = features ? Reflect.apply(features, that, []) : [];
			const before = new Set(order.slice(0, order.indexOf(FEATURE)));
			const at = list.findIndex((name) => !before.has(name));
			return at === -1
				? [...list, FEATURE]
				: [...list.slice(0, at), FEATURE, ...list.slice(at)];
		});
	}
}
