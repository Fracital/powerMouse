import { getDomain } from 'tldts';
import {
	BrowserCookieArray,
	type FloatingCookie,
} from '../../../server/Cookies';
import { COOKIES_CHANGED, CookiesChange } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule, { invokeGlobal } from '../../modules/Proxy';
import DocumentClient from '../Client';
import SyncModule from './Sync';

/**
 * document.cookie is a sync round trip to the jar, so the string is cached
 * and dropped when it may have changed: the page's own write; a write by
 * another document of the site, seen synchronously through a version the
 * writer bumps in the proxy origin's own localStorage (unhooked, shared by
 * every frame and tab of the proxy origin); a response that reached this
 * page (fetch, XHR); the service worker's broadcast for Set-Cookie headers
 * it applied, which it sends before answering the response that carried
 * them.
 */
export class CookiesModule extends Module<DocumentClient> {
	private cookieDescriptor: PropertyDescriptor;
	#cache: string | null = null;
	#cacheVersion = '';
	// the proxy origin's real localStorage, taken before the Storage module
	// hands the page its own
	#versions: Storage | null = null;
	#getItem?: Storage['getItem'];
	#setItem?: Storage['setItem'];
	constructor(client: DocumentClient) {
		super(client);

		this.cookieDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Document.prototype,
			'cookie',
		)!;
		try {
			const global = this.client.global;
			const descriptor = Reflect.getOwnPropertyDescriptor(
				global,
				'localStorage',
			);
			this.#versions =
				(descriptor?.get?.call(global) as Storage | undefined) ?? null;
			this.#getItem = global.Storage.prototype.getItem;
			this.#setItem = global.Storage.prototype.setItem;
		} catch (error) {
			// no storage (an opaque origin): every read goes to the jar
		}
	}
	/** the key other documents of this site bump when they write a cookie */
	get #versionKey() {
		const { hostname } = this.client.url.url;
		return `$stomp$cookies:${getDomain(hostname) ?? hostname}`;
	}
	#version(): string {
		try {
			return this.#getItem?.call(this.#versions, this.#versionKey) ?? '';
		} catch (error) {
			return '';
		}
	}
	/** the jar changed for this site: every document of it reads fresh */
	#bump() {
		this.#cache = null;
		try {
			this.#setItem?.call(
				this.#versions,
				this.#versionKey,
				`${Date.now()}:${Math.random()}`,
			);
		} catch (error) {
			// no storage: this document's cache is dropped at least
		}
	}
	/** this document's next read goes to the jar */
	invalidate() {
		this.#cache = null;
	}
	get cookie() {
		return this.cookieDescriptor.get!.call(this.client.global.document);
	}
	set cookie(value: string) {
		this.cookieDescriptor.set!.call(this.client.global.document, value);
	}
	get pageCookies() {
		const version = this.#version();
		if (this.#cache !== null && version === this.#cacheVersion)
			return this.#cache;

		const syncModule = this.client.getModule(SyncModule)!;
		this.client.cookieReads++;
		// the jar answers without its HttpOnly cookies (the route filters)
		const cookies: FloatingCookie[] = syncModule.jsonAPI(
			`${this.client.directory}cookies/get`,
			this.client.url.toString(),
		);
		const value = new BrowserCookieArray(
			...cookies.filter((cookie) => !cookie.httpOnly),
		).toString();
		this.#cache = value;
		this.#cacheVersion = version;
		return value;
	}
	set pageCookies(value: string) {
		const syncModule = this.client.getModule(SyncModule)!;

		// a script-set cookie can neither create nor replace an HttpOnly one
		syncModule.jsonAPI(
			`${this.client.directory}cookies/set`,
			value,
			this.client.url.toString(),
			'script',
		);
		this.#bump();
	}
	apply() {
		// the Cookie Store API would bypass the jar: pages see document.cookie
		// only, like a browser without it
		const global = this.client.global as unknown as Record<string, unknown>;
		Reflect.deleteProperty(global, 'cookieStore');
		const windowPrototype = (global.Window as { prototype?: object })
			?.prototype;
		if (windowPrototype) Reflect.deleteProperty(windowPrototype, 'cookieStore');

		const proxyModule = this.client.getModule(ProxyModule)!;

		this.client.responseListeners.add(() => this.invalidate());
		// Set-Cookie the worker applied for a document of this site
		this.client.onServiceWorkerMessage((data) => {
			const change = (data as Record<string, CookiesChange> | null)?.[
				COOKIES_CHANGED
			];
			if (!change) return;
			const { hostname } = this.client.url.url;
			if (
				change.domain === '' ||
				hostname === change.domain ||
				hostname.endsWith(`.${change.domain}`)
			)
				this.#bump();
		});

		Reflect.defineProperty(this.client.global.Document.prototype, 'cookie', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				this.cookieDescriptor.get!,
				(target, that) => {
					invokeGlobal(that, this.client.global.document);
					return this.pageCookies;
				},
			),
			set: proxyModule.wrapFunction(
				this.cookieDescriptor.set!,
				(target, that, args) => {
					invokeGlobal(that, this.client.global.document);
					this.pageCookies = String(args[0]);
				},
			),
		});
	}
}
