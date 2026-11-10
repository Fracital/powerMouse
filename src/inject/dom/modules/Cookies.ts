import { partitionSite } from '../../../partition';
import {
	BrowserCookieArray,
	compareCookies,
	cookieMatches,
	parseCookie,
	type CookieRequestContext,
	type CookieStoreWrite,
	type FloatingCookie,
	type JarCookie,
} from '../../../server/Cookies';
import { COOKIES_CHANGED, CookiesChange } from '../../../transport/messages';
import Module from '../../Module';
import ProxyModule, { invokeGlobal } from '../../modules/Proxy';
import { routedPrefix } from '../../modules/Unroute';
import { getDomain, getPublicSuffix } from '../../rewriter';
import DocumentClient from '../Client';
import SyncModule, { BEACON_QUOTA, WRITE_BUDGET } from './Sync';

// with private domains (the rewriter library asks for them)
const publicSuffix = (host: string) => getPublicSuffix(host);

const expired = (cookie: JarCookie, now: number) =>
	cookie.expires !== undefined && cookie.expires <= now;

/**
 * `list` with a script write applied the way the jar applies it: the
 * cookie of that domain, path and name replaced (moved to the end of its
 * group unless its value is unchanged) or, for an expired one, removed
 */
function applyWrite(list: JarCookie[], cookie: JarCookie, now: number) {
	const index = list.findIndex((other) => other.id === cookie.id);
	const existing = index === -1 ? undefined : list[index];
	if (index !== -1) list.splice(index, 1);
	if (expired(cookie, now)) return;
	let created = now;
	for (const other of list) created = Math.max(created, other.created + 1);
	list.push({
		...cookie,
		created: existing?.value === cookie.value ? existing.created : created,
	});
}

/** a script write sent asynchronously that may not be in the jar yet */
interface Unsettled {
	cookie: JarCookie;
	seq: number;
}

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
	#defaultView?: () => Window | null;
	/**
	 * The jar's cookies for this document as last read, with this document's
	 * writes since applied; `#fresh` while nothing else may have changed
	 * them (the version below tells of other documents' writes)
	 */
	#known: JarCookie[] | null = null;
	#fresh = false;
	#cacheVersion = '';
	// The writes the synchronous bridge could not carry: its beacon was
	// refused, because the page's own beacons (weather.com's analytics) hold
	// the quota they share, and natively a cookie write never throws. They
	// go to the worker with fetch, numbered so it applies them in order, and
	// while any is in flight every later write follows it. Until each lands,
	// reads answer with it applied over what the jar says.
	#sender = Math.random().toString(36).slice(2);
	#seq = 0;
	#inflight = new Set<number>();
	#unsettled = new Map<string, Unsettled>();
	// the proxy origin's real localStorage, taken before the Storage module
	// hands the page its own
	#versions: Storage | null = null;
	#getItem?: Storage['getItem'];
	#setItem?: Storage['setItem'];
	/**
	 * called when the jar may have changed for this document: its own
	 * writes, and the worker's broadcast of any change of its site's cookies
	 * (a response's Set-Cookie, another document's write); the Cookie Store
	 * module reads the jar again and reports what changed
	 */
	readonly changeListeners = new Set<() => void>();
	#changed() {
		for (const listener of this.changeListeners) listener();
	}
	constructor(client: DocumentClient) {
		super(client);

		this.cookieDescriptor = Reflect.getOwnPropertyDescriptor(
			this.client.global.Document.prototype,
			'cookie',
		)!;
		this.#defaultView = Reflect.getOwnPropertyDescriptor(
			this.client.global.Document.prototype,
			'defaultView',
		)?.get as (() => Window | null) | undefined;
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
	/**
	 * The partition of this document's Partitioned cookies: its top-level
	 * site when that is another site (src/partition.ts), else none
	 */
	get #partitionKey(): string | undefined {
		return partitionSite(this.client.partition) ?? undefined;
	}
	/** what the jar is told of this document's partition with every call */
	get #context(): CookieRequestContext | undefined {
		const partitionKey = this.#partitionKey;
		return partitionKey === undefined ? undefined : { partitionKey };
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
		this.#fresh = false;
		this.#stamp();
	}
	/** a new version for this site; null when there is no storage for one */
	#stamp(): string | null {
		const version = `${Date.now()}:${Math.random()}`;
		try {
			if (!this.#setItem) return null;
			this.#setItem.call(this.#versions, this.#versionKey, version);
			return version;
		} catch (error) {
			// no storage: this document's cache is dropped at least
			return null;
		}
	}
	/**
	 * Other documents read the jar again; this one keeps what it knows when
	 * that was current (it has this document's own write applied)
	 */
	#restamp() {
		const current = this.#fresh && this.#version() === this.#cacheVersion;
		const version = this.#stamp();
		if (current && version !== null) this.#cacheVersion = version;
		else this.#fresh = false;
	}
	/**
	 * What document.cookie reads for `list` (which has this document's
	 * unsettled writes applied already): the cookies for this document's URL
	 */
	#show(list: JarCookie[]): string {
		const now = Date.now();
		const url = this.client.url.url;
		const context = this.#context;
		const shown = list.filter(
			(cookie) => !expired(cookie, now) && cookieMatches(cookie, url, context),
		);
		shown.sort(compareCookies);
		return new BrowserCookieArray(...shown).toString();
	}
	/** a write the bridge cannot carry now: applied here, sent with fetch */
	#later(value: string) {
		const now = Date.now();
		const cookie = this.#parse(value, now);
		const seq = this.#seq++;
		this.#inflight.add(seq);
		let base = seq;
		for (const other of this.#inflight) base = Math.min(base, other);
		if (cookie) {
			this.#unsettled.set(cookie.id, { cookie, seq });
			if (this.#known) applyWrite(this.#known, cookie, now);
		}
		// every other document of the site reads the jar, which waits for it
		this.#restamp();
		const settle = () => {
			this.#inflight.delete(seq);
			for (const [id, entry] of this.#unsettled)
				if (entry.seq === seq) this.#unsettled.delete(id);
			// in the jar now: a document that read before the worker heard of
			// it reads again
			this.#restamp();
		};
		const url = new URL(`${routedPrefix(this.client)}cookies/ordered`);
		url.searchParams.set('sender', this.#sender);
		url.searchParams.set('seq', String(seq));
		url.searchParams.set('base', String(base));
		this.client
			.routedFetch(url.href, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify([
					value,
					this.client.url.toString(),
					this.#partitionKey,
				]),
			})
			.then((response) => {
				if (!response.ok)
					throw new Error(`${response.status} ${response.statusText}`);
			})
			.catch((error) => {
				console.error(`Stomp: a cookie write could not be stored: ${error}`);
			})
			.finally(settle);
	}
	/**
	 * A Cookie Store API write, in this document's order with its other
	 * writes the bridge could not carry (the same numbering), done when the
	 * jar has it. Unlike a document.cookie write it is not applied to this
	 * document's view before: natively document.cookie shows it only once
	 * the promise of the write settles.
	 */
	async store(write: CookieStoreWrite): Promise<void> {
		const seq = this.#seq++;
		this.#inflight.add(seq);
		let base = seq;
		for (const other of this.#inflight) base = Math.min(base, other);
		const url = new URL(`${routedPrefix(this.client)}cookies/ordered`);
		url.searchParams.set('sender', this.#sender);
		url.searchParams.set('seq', String(seq));
		url.searchParams.set('base', String(base));
		try {
			const response = await this.client.routedFetch(url.href, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify([
					write,
					this.client.url.toString(),
					this.#partitionKey,
				]),
			});
			if (!response.ok)
				throw new Error(`${response.status} ${response.statusText}`);
		} finally {
			this.#inflight.delete(seq);
			this.#bump();
			this.#changed();
		}
	}
	/**
	 * The jar's cookies for this document, as page script may see them
	 * (no HttpOnly), with its writes the jar may not have yet: asked
	 * asynchronously, for the Cookie Store API
	 */
	async jarCookies(): Promise<JarCookie[]> {
		const response = await this.client.routedFetch(
			`${routedPrefix(this.client)}cookies/get`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify([this.client.url.toString(), this.#context]),
			},
		);
		if (!response.ok)
			throw new Error(`${response.status} ${response.statusText}`);
		const list = (await response.json()) as JarCookie[];
		return this.#withUnsettled(list.filter((cookie) => !cookie.httpOnly));
	}
	/**
	 * A document without a browsing context (one a navigation replaced, one
	 * from createHTMLDocument, this one once the page removed its frame): its
	 * cookie is "" and a write does nothing, so the native accessor answers
	 * for it. Anything that is not a document stays an illegal invocation.
	 */
	#cookieAverse(that: unknown): boolean {
		if (!this.#defaultView) return false;
		try {
			return Reflect.apply(this.#defaultView, that, []) === null;
		} catch (error) {
			return false;
		}
	}
	/** this document's next read goes to the jar */
	invalidate() {
		this.#fresh = false;
	}
	get pageCookies() {
		const version = this.#version();
		if (this.#known && this.#fresh && version === this.#cacheVersion)
			return this.#show(this.#known);

		const syncModule = this.client.getModule(SyncModule)!;
		this.client.cookieReads++;
		// the jar answers without its HttpOnly cookies (the route filters)
		const answer = syncModule.tryJsonAPI(
			BEACON_QUOTA,
			`${this.client.directory}cookies/get`,
			this.client.url.toString(),
			this.#context,
		);
		if (answer) {
			this.#known = this.#withUnsettled(
				(answer.value as FloatingCookie[]).filter((cookie) => !cookie.httpOnly),
			);
			this.#fresh = true;
			this.#cacheVersion = version;
			return this.#show(this.#known);
		}
		// The bridge cannot ask now (the page's own beacons hold the quota),
		// and a read never throws natively: what this document knew, with its
		// own writes since, which is all the jar has unless another document
		// or a response changed it in the meantime
		return this.#show(this.#known ?? this.#withUnsettled([]));
	}
	/** `list` with the writes the jar may not have yet, in the order made */
	#withUnsettled(list: JarCookie[]): JarCookie[] {
		const now = Date.now();
		for (const { cookie } of [...this.#unsettled.values()].sort(
			(a, b) => a.seq - b.seq,
		))
			applyWrite(list, cookie, now);
		return list;
	}
	/** `value` as the jar applies a script write, or null when it ignores it */
	#parse(value: string, now: number): JarCookie | null {
		return parseCookie(value, this.client.url.url, publicSuffix, {
			source: 'script',
			now,
			partitionKey: this.#partitionKey,
		});
	}
	set pageCookies(value: string) {
		const syncModule = this.client.getModule(SyncModule)!;

		// a script-set cookie can neither create nor replace an HttpOnly one
		if (
			!this.#inflight.size &&
			syncModule.tryJsonAPI(
				WRITE_BUDGET,
				`${this.client.directory}cookies/set`,
				value,
				this.client.url.toString(),
				'script',
				this.#partitionKey,
			)
		) {
			// kept for a read the bridge cannot make later
			const now = Date.now();
			const cookie = this.#known && this.#parse(value, now);
			if (cookie) applyWrite(this.#known!, cookie, now);
			this.#bump();
			this.#changed();
			return;
		}
		this.#later(value);
		this.#changed();
	}
	apply() {
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
			) {
				this.#bump();
				this.#changed();
			}
		});

		Reflect.defineProperty(this.client.global.Document.prototype, 'cookie', {
			configurable: true,
			enumerable: true,
			get: proxyModule.wrapFunction(
				this.cookieDescriptor.get!,
				(target, that) => {
					if (this.#cookieAverse(that)) return Reflect.apply(target, that, []);
					invokeGlobal(that, this.client.global.document);
					return this.pageCookies;
				},
			),
			set: proxyModule.wrapFunction(
				this.cookieDescriptor.set!,
				(target, that, args) => {
					if (this.#cookieAverse(that)) return;
					invokeGlobal(that, this.client.global.document);
					this.pageCookies = String(args[0]);
				},
			),
		});
	}
}
