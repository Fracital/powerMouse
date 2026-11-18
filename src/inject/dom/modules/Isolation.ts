import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';
import { deferred } from '../deferred';

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
		proto.measureUserAgentSpecificMemory = proxyModule.wrapFunction(
			measure,
			(target, that, args) =>
				new NativePromise((resolve, reject) => {
					// (a deferred part, ../measuredMemory.ts: without it the
					// promise rejects before the browser measures anything)
					const own = deferred('measuredMemory')(client);
					const pending = Reflect.apply(target, that, args) as Promise<unknown>;
					Reflect.apply(then, pending, [
						(measured: unknown) => resolve(own(measured)),
						reject,
					]);
				}),
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
