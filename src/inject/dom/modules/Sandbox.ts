import { routeHTML } from '../../../rewriteHTML';
import StompURL from '../../../StompURL';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import DocumentClient, { addDocumentOpenListener } from '../Client';

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
 * takes for the target's. Another window's location, read by a sandboxed
 * document, refuses what DocumentClient.mayNavigate refuses with the
 * browser's SecurityError; a target=_top link (or _parent, when the parent
 * is the top) navigates the proxied top when the sandbox allows it, and is
 * left to the browser, which refuses it, when it does not.
 */
export default class SandboxModule extends Module<DocumentClient> {
	apply() {
		const global = this.client.global;
		const proxyModule = this.client.getModule(ProxyModule)!;
		const opaque = () => this.client.sandboxedOpaque;
		const securityError = (message: string) =>
			new global.DOMException(message, 'SecurityError');

		const guardGetter = (
			owner: object,
			property: string,
			message: string,
			setMessage?: string,
		) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(owner, property);
			if (!descriptor?.get) return;
			Reflect.defineProperty(owner, property, {
				...descriptor,
				get: proxyModule.wrapFunction(descriptor.get, (target, that, args) => {
					if (opaque()) throw securityError(message);
					return Reflect.apply(target, that, args);
				}),
				...(descriptor.set && setMessage
					? {
							set: proxyModule.wrapFunction(
								descriptor.set,
								(target, that, args) => {
									if (opaque()) throw securityError(setMessage);
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

		const client = this.client;
		const resolve = (value: unknown) =>
			new URL(String(value), client.baseURL.toString());
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
		this.client.gateNavigation = (target, value) => {
			if (client.sandboxFlags === null) return;
			const destination = resolve(value);
			if (!client.mayNavigate(target))
				throw client.navigationRefused('href', false, destination);
		};
		// one gated location per window, so a page comparing two reads sees one
		const gated = new WeakMap<object, object>();
		this.client.gateLocation = (real, standIn) => {
			if (
				client.sandboxFlags === null ||
				real === global.location ||
				typeof standIn !== 'object' ||
				standIn === null
			)
				return standIn;
			const known = gated.get(real as object);
			if (known) return known;
			const target = windowOf(real);
			if (!target) return standIn;
			const location = standIn as Location;
			const check = (member: string, call: boolean, destination: URL) => {
				if (!client.mayNavigate(target))
					throw client.navigationRefused(member, call, destination);
			};
			const proxy = new Proxy(location, {
				get: (object, property) => {
					const value = Reflect.get(object, property, object);
					if (typeof value !== 'function') return value;
					if (property === 'assign' || property === 'replace')
						return (url: unknown) => {
							check(property, true, resolve(url));
							return Reflect.apply(value, object, [url]);
						};
					if (property === 'reload')
						return () => {
							check(property, true, new URL(object.href));
							return Reflect.apply(value, object, []);
						};
					return (...args: unknown[]) => Reflect.apply(value, object, args);
				},
				set: (object, property, value) => {
					if (
						typeof property === 'string' &&
						LOCATION_PARTS.includes(property)
					) {
						const destination =
							property === 'href' ? resolve(value) : new URL(object.href);
						if (property !== 'href')
							Reflect.set(destination, property, String(value));
						check(property, false, destination);
					}
					return Reflect.set(object, property, value, object);
				},
			});
			gated.set(real as object, proxy);
			return proxy;
		};

		// a link to the top (or to the parent, when the parent is the top) in
		// a sandboxed document: the hooks leave its target as the page wrote
		// it (DOMAttributes), so the browser refuses it, unless the sandbox
		// allows top navigation; then the proxied top goes there, from its own
		// realm (the browser would not let this frame navigate it)
		const nativeAssign = global.location.assign;
		const onClick = (event: MouseEvent) => {
			if (client.sandboxFlags === null || event.defaultPrevented) return;
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
		const install = () => global.addEventListener('click', onClick);
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
						if (opaque()) {
							const error = securityError(
								`Failed to execute '${method}' on 'IDBFactory': access to the Indexed Database API is denied in this context.`,
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
