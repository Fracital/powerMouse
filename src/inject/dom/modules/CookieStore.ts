import { isSecureURL, type JarCookie } from '../../../server/Cookies';
import type {
	CookieStoreMethod,
	CookieStoreMethods,
} from '../../cookieStoreMethods';
import Module from '../../Module';
import ProxyModule from '../../modules/Proxy';
import { withStack } from '../../nativeErrors';
import DocumentClient from '../Client';
import { deferred } from '../deferred';
import { CookiesModule } from './Cookies';

const METHODS: CookieStoreMethod[] = ['get', 'getAll', 'set', 'delete'];

type Method = CookieStoreMethod;

/**
 * The Cookie Store API over the proxy's jar, the one document.cookie reads
 * and writes. The page's `cookieStore` is the browser's own CookieStore (its
 * identity, prototype, `onchange` and event methods are native); its four
 * methods answer from the jar instead of the proxy origin's real cookies,
 * with the browser's results and errors (a call on anything else is the
 * native method's), and the change events are the jar's: the browser's own
 * (about the proxy origin's cookies, which the sync bridge writes) never
 * reach the page, and a change of the jar this document can see (its own
 * writes, a response's Set-Cookie, another document's write, all of which
 * the worker broadcasts) is dispatched as a CookieChangeEvent, one per
 * cookie. A script cannot make an event trusted, so `isTrusted` is false
 * where natively it is true. The API exists only in a secure context: a
 * document whose real URL is not secure has none of it, as natively.
 */
export default class CookieStoreModule extends Module<DocumentClient> {
	apply() {
		const client = this.client;
		const global = client.global as typeof globalThis & Record<string, any>;
		const getter = Reflect.getOwnPropertyDescriptor(global, 'cookieStore');
		const CookieStore = global.CookieStore as Function | undefined;
		const CookieChangeEvent = global.CookieChangeEvent as
			(new (type: string, init: object) => Event) | undefined;
		if (
			!getter?.get ||
			typeof CookieStore !== 'function' ||
			typeof CookieChangeEvent !== 'function'
		)
			return;
		if (!isSecureURL(client.url.url)) {
			for (const name of ['cookieStore', 'CookieStore', 'CookieChangeEvent'])
				Reflect.deleteProperty(global, name);
			return;
		}

		const proxyModule = client.getModule(ProxyModule)!;
		const cookies = client.getModule(CookiesModule)!;
		const store = Reflect.apply(getter.get, global, []) as EventTarget;
		const prototype = CookieStore.prototype as Record<Method, Function>;
		const nativeAdd = global.EventTarget.prototype.addEventListener;
		const nativeDispatch = global.EventTarget.prototype.dispatchEvent;
		const stopImmediate = global.Event.prototype.stopImmediatePropagation;

		// The browser's events are about the proxy origin's cookies (the sync
		// bridge's answers ride in them): dropped before any page listener.
		// The page reaches the store only through the getter below, so the
		// listener is added at its first read: the browser tells a document
		// of cookie changes only while its store has a listener, and every
		// proxied document listening made each answer of the bridge an event
		// in each of them (apnews.com's top document had 99,000 in 40 s).
		// A capture listener, as one at the target runs before the page's of
		// either phase
		let dropping = false;
		const dropBrowserEvents = () => {
			dropping = true;
			Reflect.apply(nativeAdd, store, [
				'change',
				(event: Event) => {
					if (event.isTrusted) Reflect.apply(stopImmediate, event, []);
				},
				true,
			]);
		};

		const withoutHash = (url: URL) => url.href.replace(/#[^]*$/, '');

		// the four methods and their dictionaries, as the browser answers
		// them, over this document's view of the jar: a deferred part of the
		// bundle (../deferred.ts), made at the page's first call
		let made: CookieStoreMethods | null = null;
		const shared = (): CookieStoreMethods =>
			(made ??= deferred('cookieStoreMethods')({
				global,
				base: () => client.url.toString(),
				refuseURL: (url) =>
					!url || withoutHash(url) !== withoutHash(client.url.url)
						? 'URL must match the document URL'
						: null,
				host: () => client.url.url.hostname,
				jar: () => cookies.jarCookies(),
				store: (write) => cookies.store(write),
				refused: (method) => opaque(method),
				crossSite: () => cookies.crossSite,
				look: () => watch(),
			}));

		// what the page has seen of the jar, from its first look at the API
		let seen: Map<string, JarCookie> | null = null;
		let watching: Promise<void> | null = null;
		let refreshing = false;
		let again = false;
		const watch = () => {
			cookies.recordWrites();
			return (watching ??= cookies.jarCookies().then(
				(list) => {
					seen = new Map(list.map((cookie) => [cookie.id, cookie]));
				},
				() => {
					// the jar did not answer: the next look asks again, and
					// nothing is reported until it has
					watching = null;
				},
			));
		};
		const differs = (a: JarCookie, b: JarCookie) =>
			a.value !== b.value ||
			a.expires !== b.expires ||
			a.secure !== b.secure ||
			a.sameSite !== b.sameSite ||
			a.hostOnly !== b.hostOnly;
		const dispatch = (changed: object[], deleted: object[]) =>
			Reflect.apply(nativeDispatch, store, [
				new CookieChangeEvent('change', { changed, deleted }),
			]);
		const refresh = async () => {
			if (!watching) return;
			if (refreshing) {
				again = true;
				return;
			}
			refreshing = true;
			try {
				await watching;
				do {
					again = false;
					if (!seen) return;
					// this document's own writes first, each an event of its own in
					// the order written, as natively (taken before the jar is
					// asked, which has them all); then what else changed
					const writes = cookies.takeWrites();
					const list = await cookies.jarCookies();
					const before = new Map(seen);
					// a write made here and the jar's copy of it: the same
					// cookie, its Max-Age counted a moment apart
					const logged = new Set<string>();
					for (const [id, cookie] of writes) {
						logged.add(id);
						const old = before.get(id);
						if (cookie) {
							if (!old || differs(old, cookie))
								dispatch([shared().item(cookie)], []);
							before.set(id, cookie);
						} else if (old) {
							dispatch([], [shared().deletedItem(old)]);
							before.delete(id);
						}
					}
					const now = new Map(list.map((cookie) => [cookie.id, cookie]));
					seen = now;
					for (const [id, cookie] of before)
						if (!now.has(id)) dispatch([], [shared().deletedItem(cookie)]);
					for (const cookie of list) {
						const old = before.get(cookie.id);
						if (
							!old ||
							(logged.has(cookie.id)
								? differs({ ...old, expires: cookie.expires }, cookie) ||
									Math.abs((old.expires ?? 0) - (cookie.expires ?? 0)) > 2000
								: differs(old, cookie))
						)
							dispatch([shared().item(cookie)], []);
					}
				} while (again);
			} catch (error) {
				// the jar did not answer: the next change reads it again
			} finally {
				refreshing = false;
			}
		};
		cookies.changeListeners.add(() => void refresh());

		/** a refusal of an opaque origin, as natively */
		const opaque = (method: Method) =>
			client.sandboxedOpaque
				? withStack(
						new global.DOMException(
							`Failed to execute '${method}' on 'CookieStore': Access to the CookieStore API is denied in this context.`,
							'SecurityError',
						),
					)
				: null;

		for (const method of METHODS)
			if (typeof prototype[method] === 'function')
				prototype[method] = proxyModule.wrapFunction(
					prototype[method],
					(target, that, args) =>
						that === store
							? shared().methods[method](args)
							: Reflect.apply(target, that, args),
				);

		// the page's first look at the API starts the record of what it has
		// seen, so a change after it is reported
		Reflect.defineProperty(global, 'cookieStore', {
			...getter,
			get: proxyModule.wrapFunction(getter.get, (target, that, args) => {
				const result = Reflect.apply(target, that, args);
				// (the store this module took while the frame was there is
				// still the getter's once it is removed, where natively the
				// window of a removed frame answers null)
				if (result === store && global.closed) return null;
				if (result === store) {
					if (!dropping) dropBrowserEvents();
					watch();
				}
				return result;
			}),
		});
	}
}
