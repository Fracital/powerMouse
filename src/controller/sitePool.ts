// The slots of the site pool (ControllerInit.sitePool): a small fixed list of
// origins the host serves the proxy on (the same host name on other ports
// needs no name of its own), each a renderer process of its own to the
// browser. A proxied site (its registrable domain, as the window membrane
// and the cookie jar key it) is shown from one slot, and keeps it: what a
// page stores in the browser's own stores (IndexedDB, Cache Storage, the
// origin private file system) is the slot origin's, so a site that moved
// would leave its data behind.

/** what a host gives for the site pool */
export interface SitePoolInit {
	/**
	 * The slots: origins that serve `directory` as the host page's origin
	 * does, none of them the host page's own, all of its site (another port
	 * of its host: nothing is partitioned between them and the cookies the
	 * server sees are shared). Their order and number are part of where
	 * every site's data is kept: a changed list is another pool.
	 */
	origins: string[];
}

/**
 * Where the host origin keeps which site has which slot (localStorage): a
 * fixed text that names neither the project nor a proxy, as the kept ids'
 * key (src/controller/id.ts).
 */
const KEY = 'kept-site-slots';
/** where the host origin keeps the slot that took a navigation last, in any tab (SiteSlots.last) */
const LAST_KEY = 'last-site-slot';
/** at most this many sites are remembered for a pool; the oldest assignments go first */
const KEPT_SITES = 4096;
/** at most this many pools are remembered (a host has one; a changed list is another) */
const KEPT_POOLS = 4;

interface Kept {
	/** the pool the assignments are for */
	origins: string[];
	/** site -> index into `origins`, oldest assignment first */
	sites: Record<string, number>;
}

/** the pool's origins, checked: http(s) origins, each once, none the page's own */
export function poolOrigins(init: SitePoolInit, own: string): string[] {
	const origins: string[] = [];
	for (const given of init?.origins ?? []) {
		const url = new URL(given);
		if (url.protocol !== 'http:' && url.protocol !== 'https:')
			throw new TypeError(
				`Stomp: a site pool origin is an http(s) origin, not ${given}`,
			);
		if (url.origin === own)
			throw new TypeError(
				'Stomp: the host page origin cannot be a slot of its own site pool',
			);
		if (!origins.includes(url.origin)) origins.push(url.origin);
	}
	if (!origins.length)
		throw new TypeError('Stomp: a site pool needs at least one origin');
	return origins;
}

/**
 * Which slot shows which site. An assignment is kept for good (in the host
 * origin's localStorage, so every tab of the host agrees and a later visit
 * finds the site's data where it left it). A site seen for the first time
 * gets a slot no site has yet; when there is none, the slot that was used
 * longest ago in this page, never the one the navigation comes from when
 * there is another: a frame of another site is then in another process
 * than the document that embeds it, and with more sites than slots the
 * ones that share a process are the ones farthest apart in time.
 */
export class SiteSlots {
	readonly origins: string[];
	#storage: Storage | null;
	/** when each slot last took a navigation in this page */
	#used: number[];
	/** this page's own view, for a browser without storage */
	#sites = new Map<string, number>();
	#clock = 0;
	constructor(origins: string[], storage: Storage | null = keptStorage()) {
		this.origins = origins;
		this.#storage = storage;
		this.#used = origins.map(() => 0);
	}
	/** every pool's assignments as kept, this pool's last */
	#kept(): Kept[] {
		let kept: unknown = null;
		try {
			kept = JSON.parse(this.#storage?.getItem(KEY) ?? 'null');
		} catch (error) {
			// not ours, or cut short: start over
		}
		const pools = (Array.isArray(kept) ? kept : []).filter(
			(pool: Kept | null) =>
				typeof pool === 'object' &&
				pool !== null &&
				Array.isArray(pool.origins) &&
				typeof pool.sites === 'object' &&
				pool.sites !== null,
		) as Kept[];
		const own = (pool: Kept) =>
			pool.origins.length === this.origins.length &&
			pool.origins.every((origin, i) => origin === this.origins[i]);
		return [
			...pools.filter((pool) => !own(pool)),
			pools.find(own) ?? { origins: this.origins, sites: {} },
		];
	}
	#read(): Map<string, number> {
		if (!this.#storage) return this.#sites;
		const sites = new Map<string, number>();
		for (const [site, index] of Object.entries(this.#kept().at(-1)!.sites))
			if (Number.isInteger(index) && index >= 0 && index < this.origins.length)
				sites.set(site, index);
		return sites;
	}
	#write(sites: Map<string, number>) {
		this.#sites = sites;
		if (!this.#storage) return;
		const pools = this.#kept();
		pools[pools.length - 1] = {
			origins: this.origins,
			sites: Object.fromEntries([...sites].slice(-KEPT_SITES)),
		};
		try {
			this.#storage.setItem(KEY, JSON.stringify(pools.slice(-KEPT_POOLS)));
		} catch (error) {
			// no room: this page's own view stands
			this.#storage = null;
		}
	}
	/** the slot of `site` when it has one */
	known(site: string): string | null {
		const index = this.#read().get(site);
		return index === undefined ? null : this.origins[index];
	}
	/**
	 * The slot `site` is shown from, given one now when it has none. `from`
	 * is the slot of the document the navigation comes from, when it comes
	 * from one; a slot in `dead` (one that did not answer from this network)
	 * is given to no new site. Throws when every slot is dead.
	 */
	originOf(site: string, from?: string, dead?: Set<string>): string {
		// read again each time: another tab of the host may have assigned it
		const sites = this.#read();
		let index = sites.get(site);
		if (index === undefined) {
			index = this.#pick(sites, from, dead);
			if (index === -1) throw new Error('no slot of the site pool answers');
			sites.set(site, index);
			this.#write(sites);
		}
		this.#used[index] = ++this.#clock;
		const origin = this.origins[index];
		try {
			if (this.#storage && this.#storage.getItem(LAST_KEY) !== origin)
				this.#storage.setItem(LAST_KEY, origin);
		} catch (error) {
			// no room: the next page warms the next new site's slot instead
		}
		return origin;
	}
	/**
	 * The slot that took a navigation last, in any tab of the host and any
	 * visit, when it is one of this pool's and not dead: the slot of the
	 * site a page is likely to show again
	 */
	last(dead?: Set<string>): string | null {
		let origin: string | null = null;
		try {
			origin = this.#storage?.getItem(LAST_KEY) ?? null;
		} catch (error) {
			// storage is blocked for this page
		}
		return origin && this.origins.includes(origin) && !dead?.has(origin)
			? origin
			: null;
	}
	/** whether a navigation of this page was shown from `origin` */
	usedHere(origin: string): boolean {
		const index = this.origins.indexOf(origin);
		return index !== -1 && this.#used[index] > 0;
	}
	/**
	 * The slot the next site seen for the first time would get, assigning
	 * nothing: from the slot used last in this page (a frame or a link of
	 * the page shown last), or from none before any was used. Null when
	 * every slot is dead.
	 */
	next(dead?: Set<string>): string | null {
		const last = this.#clock
			? this.origins[this.#used.indexOf(this.#clock)]
			: undefined;
		const index = this.#pick(this.#read(), last, dead);
		return index === -1 ? null : this.origins[index];
	}
	/** the slot a new site gets (see originOf), -1 when every slot is dead */
	#pick(sites: Map<string, number>, from?: string, dead?: Set<string>): number {
		const count = this.origins.map(() => 0);
		for (const taken of sites.values()) count[taken]++;
		const avoid = this.origins.length > 1 ? this.origins.indexOf(from!) : -1;
		let best = -1;
		const alive = this.origins.filter((origin) => !dead?.has(origin));
		if (!alive.length) return -1;
		for (let i = 0; i < this.origins.length; i++) {
			if (dead?.has(this.origins[i])) continue;
			// the slot the navigation comes from, unless it is the only one
			if (i === avoid && alive.length > 1) continue;
			if (
				best === -1 ||
				// an empty slot first, then the one used longest ago, then
				// the one with the fewest sites
				Number(count[i] > 0) < Number(count[best] > 0) ||
				(count[i] > 0 === count[best] > 0 &&
					(this.#used[i] < this.#used[best] ||
						(this.#used[i] === this.#used[best] && count[i] < count[best])))
			)
				best = i;
		}
		return best;
	}
}

function keptStorage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch (error) {
		// storage is blocked for this page
		return null;
	}
}

/**
 * A host frame's `allow` for a frame that shows the slots' documents: as
 * the host wrote it (`given`), with every slot added where the host let a
 * frame of its own origin have the feature (`'src'`, the default, `'self'`
 * or the host's origin), and each feature the host page itself has that
 * the attribute does not name delegated to the slots. Without a pool the
 * proxied top is of the host page's origin and has those by inheritance;
 * a slot is another origin to the browser, which gives it none of the
 * features whose default allowlist is `self` (the camera, geolocation,
 * WebAuthn's create and get, speaker selection) unless the frame's
 * container policy names it.
 */
export function slotAllow(
	given: string | null,
	slots: string[],
	own: string,
	features: string[],
): string {
	const named = new Set<string>();
	const entries: string[] = [];
	for (const entry of (given ?? '').split(';')) {
		const [feature, ...allowlist] = entry.trim().split(/\s+/);
		if (!feature) continue;
		named.add(feature.toLowerCase());
		const list = allowlist.length ? allowlist : ["'src'"];
		const ownToo = list.some(
			(source) =>
				source === "'src'" ||
				source === "'self'" ||
				source.replace(/\/$/, '') === own,
		);
		entries.push(
			[
				feature,
				...list,
				...(ownToo && !list.includes('*')
					? slots.filter((slot) => !list.includes(slot))
					: []),
			].join(' '),
		);
	}
	// 'self' as well: a document of the frame may be of this page's origin
	// after all (a slot that does not answer, Fallbacks in docs/site-pool.md),
	// which the attribute's absence let have them
	for (const feature of features)
		if (!named.has(feature))
			entries.push([feature, "'self'", ...slots].join(' '));
	return entries.join('; ');
}
