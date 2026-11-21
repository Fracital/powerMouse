// Profiles (docs/tor.md "Profiles"). A profile is a set of STomp's stores apart
// from every other set on the same origin: its cookie jar, storage
// partitions, HTTP and rewrite caches, extensions, permissions, passkeys,
// the transport's memories, and the stores the proxied sites make natively
// (IndexedDB, Cache Storage, Web Locks, BroadcastChannel, the origin private
// file system, Storage Buckets). The default profile ('') has the names
// STomp always used; any other is a name of its own, which every store name
// carries at its end after PROFILE_MARK, so that a name tells which profile
// it is of (profileOfName) and a profile can be forgotten whole
// (src/controller/profiles.ts).
//
// Every name of a store STomp opens goes through storeName (STomp's own) or
// nativeStoreKey (a proxied context's, the `@<key>` suffix of its names):
// test/store-names.mjs fails on a store opened by a literal name elsewhere.

/** what separates a store's name from its profile's: a character no origin, site or STomp name has */
export const PROFILE_MARK = '|';
/** a profile's id: a short lower-case name */
export const PROFILE_PATTERN = /^[a-z][a-z0-9]{0,15}$/;
const PROFILE_SUFFIX = /\|([a-z][a-z0-9]{0,15})$/;

/** `id` checked: '' for the default profile, else a valid id; a TypeError otherwise */
export function checkProfile(id: unknown): string {
	if (id === undefined || id === null || id === '') return '';
	if (typeof id !== 'string' || !PROFILE_PATTERN.test(id))
		throw new TypeError(
			`A STomp profile is a short lower-case name (${PROFILE_PATTERN.source}), not ${JSON.stringify(id)}`,
		);
	return id;
}

/** the name of one of STomp's stores (a database, a cache, a key, a channel, a lock) in `profile` */
export function profileStoreName(base: string, profile: string): string {
	return profile ? `${base}${PROFILE_MARK}${profile}` : base;
}

/**
 * The key a proxied context's native stores are suffixed with (`name@<key>`,
 * the IndexedDB, Partition and Storage modules): its storage key
 * (Client.storageKey: origin and partition) in `profile`
 */
export const nativeStoreKey = profileStoreName;

/**
 * The profile a store's name is of: '' for the default profile. A name the
 * default profile has never ends with the mark and an id: a site's own part
 * comes before `@<origin>`, and an origin has no `|`.
 */
export function profileOfName(name: string): string {
	return PROFILE_SUFFIX.exec(name)?.[1] ?? '';
}

let realm: string | undefined;
let used = false;

/**
 * The profile of this realm's stores. A worker's is in its script's URL
 * (`serviceWorker.js?profile=<id>`, `transportWorker.js?profile=<id>`,
 * which the controller and StompController.register add); a controller's
 * page is told it (useProfile). A proxied context never asks: its stores
 * are named by nativeStoreKey with its config's profile.
 */
export function realmProfile(): string {
	if (realm === undefined) {
		const scope = globalThis as unknown as {
			document?: unknown;
			location?: { search?: string };
		};
		// a worker of STomp's own (the service worker, the transport worker
		// and the workers it starts, the carrier host) knows from its own
		// URL before anything else ran
		realm =
			scope.document === undefined && typeof scope.location?.search === 'string'
				? profileOfScript(scope.location.search)
				: '';
	}
	used = true;
	return realm;
}

/** the profile a service worker script's query names ('' for none) */
export function profileOfScript(search: string): string {
	try {
		return checkProfile(new URLSearchParams(search).get('profile'));
	} catch (error) {
		// a worker of no valid profile keeps nothing apart: refuse to run
		// rather than open the default profile's stores
		throw new TypeError('This service worker names no valid profile', {
			cause: error,
		});
	}
}

/**
 * Set this realm's profile. Once a store's name was made with one, another
 * is refused: one realm opens one profile's stores, never two.
 */
export function useProfile(id: string | undefined): string {
	const profile = checkProfile(id);
	if (realm !== undefined && realm !== profile && used)
		throw new Error(
			`This page already opened profile ${JSON.stringify(realm)}'s stores; a controller of profile ${JSON.stringify(profile)} needs a page of its own`,
		);
	realm = profile;
	return profile;
}

/** the name of one of STomp's stores in this realm's profile */
export function storeName(base: string): string {
	return profileStoreName(base, realmProfile());
}

/**
 * The service worker script URL of `profile`. The query's other parts stay
 * as they are written: URLSearchParams writes a bare hash
 * (`transportWorker.js?<hash>`, src/version.ts) back as `?<hash>=`, which
 * names no hash to a host that keeps the file for good under it (the demo's
 * askedByHash), so every reload revalidated the transport worker.
 */
export function profileScriptURL(script: URL, profile: string): URL {
	const url = new URL(script);
	const parts = url.search
		.slice(1)
		.split('&')
		.filter((part) => part !== '' && !new URLSearchParams(part).has('profile'));
	if (profile) parts.push(`profile=${encodeURIComponent(profile)}`);
	url.search = parts.length ? `?${parts.join('&')}` : '';
	return url;
}

/**
 * `db` (one of STomp's own databases, opened with the browser's API) closes
 * when it is deleted (a profile forgotten), so the deletion does not wait
 * for this realm to go; src/storeDB.ts does the same for idb's
 */
export function closeOnDelete(db: IDBDatabase, closed?: () => void): void {
	db.addEventListener('versionchange', (event) => {
		if ((event as IDBVersionChangeEvent).newVersion !== null) return;
		db.close();
		closed?.();
	});
}
