import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import type DocumentClient from '../Client';

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
	apply() {
		const global = this.client.global as typeof globalThis & {
			FeaturePolicy?: { prototype: Record<string, unknown> };
		};
		if (!this.client.hostIsolated) return;
		this.client.hideSharedArrayBuffer();
		const proxyModule = this.client.getModule(ProxyModule)!;
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
		const allowed = () => this.client.isolationFacts.includes('p');
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
				(args.length < 2 || String(args[1]) === this.client.url.url.origin)
			);
		});
		wrap('getAllowlistForFeature', (native, _that, args) => {
			if (String(args[0]) !== FEATURE) return native;
			return allowed() ? [this.client.url.url.origin] : [];
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
