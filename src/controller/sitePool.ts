// The slots of the site pool (ControllerInit.sitePool): a small fixed list of
// origins the host serves the proxy on (the same host name on other ports
// needs no name of its own), each a renderer process of its own to the
// browser. A proxied site (its registrable domain, as the window membrane
// and the cookie jar key it) is shown from one slot, and keeps it: what a
// page stores in the browser's own stores (IndexedDB, Cache Storage, the
// origin private file system) is the slot origin's, so a site that moved
// would leave its data behind.

import { openDB, type IDBPDatabase } from 'idb';

/** what a host gives for the site pool */
export interface SitePoolInit {
	/**
	 * The slots: origins that serve `directory` as the host page's origin
	 * does, none of them the host page's own, all of its site (another port
	 * of its host: nothing is partitioned between them and the cookies the
	 * server sees are shared). A site keeps the slot it was given while
	 * that origin is in the list, in any order and whatever else the list
	 * gains or loses; a site whose slot is taken out is given another, and
	 * what it stored stays in the one taken out.
	 */
	origins: string[];
}

/**
 * Where the host origin keeps which site has which slot: an IndexedDB
 * database of its own, under a fixed text that names neither the project
 * nor a proxy, as the kept ids' key (src/controller/id.ts). `sites` holds,
 * by site, the slot origins it was given, newest first (one, unless the
 * list changed under it); `slots`, by slot origin, how many sites were
 * given that slot.
 */
const DATABASE = 'kept-site-slots';
const SITES = 'sites';
const COUNTS = 'slots';
/**
 * where an earlier build kept the assignments (the host origin's
 * localStorage: per pool, at most four, site to index), read into the
 * database once and removed
 */
const LEGACY_KEY = 'kept-site-slots';
/** where the host origin keeps the slot that took a navigation last, in any tab (SiteSlots.last) */
const LAST_KEY = 'last-site-slot';

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

/** a kept record's slot origins (`sites`) */
const slotList = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((origin): origin is string => typeof origin === 'string')
		: [];
/** a kept count (`slots`) */
const counted = (value: unknown): number =>
	Number.isInteger(value) && (value as number) > 0 ? (value as number) : 0;

/**
 * Which slot shows which site. An assignment is kept for good, in the host
 * origin's IndexedDB, so every tab of the host agrees and a later visit
 * finds the site's data where it left it: by slot origin, never dropped,
 * so a changed list keeps every site whose slot it still has, and a site
 * is one record, read by its key, however many there are. A site seen
 * for the first time gets a slot no site has yet; when there is none, the
 * slot that was used longest ago in this page, never the one the
 * navigation comes from when there is another: a frame of another site is
 * then in another process than the document that embeds it, and with more
 * sites than slots the ones that share a process are the ones farthest
 * apart in time. What this page read or gave stays its answer while it
 * lives (an assignment moves only when a list has lost its slot).
 */
export class SiteSlots {
	readonly origins: string[];
	#storage: Storage | null;
	/** the kept assignments, null where the page has no IndexedDB */
	#db: Promise<IDBPDatabase | null>;
	/** when each slot last took a navigation in this page */
	#used: number[];
	/** what this page read or gave, by site (all there is without a database) */
	#sites = new Map<string, number>();
	/** the sites being read or given now: a page and its frame ask once */
	#asked = new Map<string, Promise<number>>();
	#clock = 0;
	constructor(
		origins: string[],
		storage: Storage | null = keptStorage(),
		db: Promise<IDBPDatabase | null> = keptDatabase(storage),
	) {
		this.origins = origins;
		this.#storage = storage;
		this.#db = db;
		this.#used = origins.map(() => 0);
	}
	/** the first of a site's kept slots that is one of this pool's, -1 when none is */
	#own(kept: string[]): number {
		for (const origin of kept) {
			const index = this.origins.indexOf(origin);
			if (index !== -1) return index;
		}
		return -1;
	}
	/** how many sites each slot has, as far as this page knows (without a database) */
	#counts(): number[] {
		const count = this.origins.map(() => 0);
		for (const taken of this.#sites.values()) count[taken]++;
		return count;
	}
	/**
	 * The kept slot of `site`, or one given it now and kept, in one
	 * transaction (two tabs that see a new site at once give it one slot);
	 * -1 when it has none and every slot is dead
	 */
	async #keep(
		db: IDBPDatabase,
		site: string,
		from?: string,
		dead?: Set<string>,
	): Promise<number> {
		const tx = db.transaction([SITES, COUNTS], 'readwrite');
		tx.done.catch(() => {});
		const sites = tx.objectStore(SITES);
		const counts = tx.objectStore(COUNTS);
		const kept = slotList(await sites.get(site));
		let index = this.#own(kept);
		if (index === -1) {
			const count = await Promise.all(
				this.origins.map(async (origin) => counted(await counts.get(origin))),
			);
			index = this.#pick(count, from, dead);
			if (index !== -1) {
				const origin = this.origins[index];
				// the slots it had stay listed after it: the list of another
				// tab, or of a later visit, may still have one
				sites.put([origin, ...kept.filter((other) => other !== origin)], site);
				counts.put(count[index] + 1, origin);
			}
		}
		await tx.done;
		return index;
	}
	/** the slot `site` gets (originOf), kept where the page can */
	async #give(
		site: string,
		from?: string,
		dead?: Set<string>,
	): Promise<number> {
		let index: number | undefined;
		const db = await this.#db;
		if (db)
			try {
				index = await this.#keep(db, site, from, dead);
			} catch (error) {
				// the database refused (no room, or closed for a newer
				// version): this page's own view stands
			}
		index ??= this.#pick(this.#counts(), from, dead);
		if (index === -1) throw new Error('no slot of the site pool answers');
		this.#sites.set(site, index);
		return index;
	}
	/** the slot of `site` when it has one */
	async known(site: string): Promise<string | null> {
		let index = this.#sites.get(site);
		if (index === undefined) {
			const db = await this.#db;
			try {
				index = db ? this.#own(slotList(await db.get(SITES, site))) : -1;
			} catch (error) {
				index = -1;
			}
			if (index === -1) return null;
			this.#sites.set(site, index);
		}
		return this.origins[index];
	}
	/**
	 * The slot `site` is shown from, given one now when it has none. `from`
	 * is the slot of the document the navigation comes from, when it comes
	 * from one; a slot in `dead` (one that did not answer from this network)
	 * is given to no new site. Rejects when every slot is dead.
	 */
	async originOf(
		site: string,
		from?: string,
		dead?: Set<string>,
	): Promise<string> {
		let index = this.#sites.get(site);
		if (index === undefined) {
			let asked = this.#asked.get(site);
			if (!asked) {
				asked = this.#give(site, from, dead).finally(() =>
					this.#asked.delete(site),
				);
				this.#asked.set(site, asked);
			}
			index = await asked;
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
	async next(dead?: Set<string>): Promise<string | null> {
		const last = this.#clock
			? this.origins[this.#used.indexOf(this.#clock)]
			: undefined;
		let count: number[] | null = null;
		const db = await this.#db;
		if (db)
			try {
				const counts = db.transaction(COUNTS).objectStore(COUNTS);
				count = await Promise.all(
					this.origins.map(async (origin) => counted(await counts.get(origin))),
				);
			} catch (error) {
				// the database refused: this page's own view
			}
		const index = this.#pick(count ?? this.#counts(), last, dead);
		return index === -1 ? null : this.origins[index];
	}
	/** the slot a new site gets (see originOf) given each slot's sites, -1 when every slot is dead */
	#pick(count: number[], from?: string, dead?: Set<string>): number {
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
 * The host origin's kept assignments, with what an earlier build kept in
 * its localStorage read in; null where the page has no IndexedDB (every
 * assignment is then this page's own)
 */
export async function keptDatabase(
	storage: Storage | null,
): Promise<IDBPDatabase | null> {
	let db: IDBPDatabase;
	try {
		db = await openDB(DATABASE, 1, {
			upgrade(db) {
				db.createObjectStore(SITES);
				db.createObjectStore(COUNTS);
			},
			// a later build's version: this page lets go, and keeps its own
			// view from then on
			blocking() {
				db.close();
			},
		});
	} catch (error) {
		// storage is blocked for this page
		return null;
	}
	await keepLegacy(db, storage);
	return db;
}

/**
 * The assignments an earlier build kept in the host origin's localStorage
 * (`kept-site-slots`: the last four pools, oldest first, each site to an
 * index into its origins), read into the database: a site keeps every
 * slot it had in any of them, newest first, after those the database has
 * for it (which are newer). Then the text is removed; a page of an earlier
 * build that writes it again is read in by the next page.
 */
async function keepLegacy(db: IDBPDatabase, storage: Storage | null) {
	let raw: string | null = null;
	try {
		raw = storage?.getItem(LEGACY_KEY) ?? null;
	} catch (error) {
		// storage is blocked for this page
	}
	if (raw === null) return;
	const given = new Map<string, string[]>();
	try {
		const pools: unknown = JSON.parse(raw);
		for (const pool of Array.isArray(pools) ? pools : []) {
			if (
				typeof pool !== 'object' ||
				pool === null ||
				!Array.isArray(pool.origins) ||
				typeof pool.sites !== 'object' ||
				pool.sites === null
			)
				continue;
			for (const [site, index] of Object.entries(pool.sites)) {
				const origin = Number.isInteger(index)
					? pool.origins[index as number]
					: undefined;
				if (typeof origin !== 'string') continue;
				const had = given.get(site) ?? [];
				given.set(site, [origin, ...had.filter((other) => other !== origin)]);
			}
		}
	} catch (error) {
		// not ours, or cut short: nothing to read in
	}
	try {
		const tx = db.transaction([SITES, COUNTS], 'readwrite');
		tx.done.catch(() => {});
		const sites = tx.objectStore(SITES);
		const counts = tx.objectStore(COUNTS);
		const added = new Map<string, number>();
		// the first page of this build has nothing to merge with (a put
		// without a get: 100,000 sites read in in about half the time)
		const empty = (await sites.count()) === 0;
		await Promise.all(
			[...given].map(async ([site, origins]) => {
				const had = empty ? [] : slotList(await sites.get(site));
				const more = origins.filter((origin) => !had.includes(origin));
				if (!more.length) return;
				sites.put([...had, ...more], site);
				for (const origin of more)
					added.set(origin, (added.get(origin) ?? 0) + 1);
			}),
		);
		await Promise.all(
			[...added].map(async ([origin, more]) =>
				counts.put(counted(await counts.get(origin)) + more, origin),
			),
		);
		await tx.done;
		storage?.removeItem(LEGACY_KEY);
	} catch (error) {
		// the database refused: the text stays for the next page
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
