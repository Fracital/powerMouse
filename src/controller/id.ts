// A controller's id names its address under the scope (`/stomp/<id>/`), so
// two host tabs on one scope do not replace each other in the service worker.
// A host may give one; without, the controller keeps one from visit to visit
// (keptControllerId), so the tab's history entries, reloads and copied links
// keep resolving and the browser keeps the compiled code of what it loaded.

/** what an id may look like: a path segment that needs no encoding */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const ID_LENGTH = 8;
const ID_ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** the id the host gave, checked */
export function controllerId(id: string): string {
	if (typeof id !== 'string' || !ID_PATTERN.test(id))
		throw new TypeError(
			`Stomp: a controller id is 1 to 32 characters of [A-Za-z0-9_-], not ${JSON.stringify(id)}`,
		);
	return id;
}

function mintId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
	let id = '';
	for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
	return id;
}

/**
 * Where the host origin's ids are kept (localStorage: the ids, oldest
 * first; sessionStorage: this tab's own, by controller), the name of the
 * Web Lock one claim at a time holds, and the prefix of each id's lock. A
 * fixed text that names neither the project nor a proxy: a host that
 * rewrites such names in what it ships, or mints its `names` per build,
 * would otherwise keep its ids under a new key with every deploy, lose them
 * each time and leave the old key behind (controller-ids suite: the built
 * controller has it verbatim).
 */
const KEY = 'kept-tab-ids';
/** at most this many ids are kept: one for each controller open at once */
const KEPT_IDS = 16;
/** how long a reloaded tab waits for its old document to let go of its id */
const RELOAD_WAIT_MS = 1000;
/** how long a claim waits its turn among the origin's tabs before it settles for an id of its own */
const CLAIM_WAIT_MS = 3000;

/** this document's controllers that were given no id, so far */
let claims = 0;
/** the ids this document's controllers hold */
const HELD = new Set<string>();

/** the valid ids of a stored list, each once; '' where an entry is not one */
function storedIds(text: string | null): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text ?? '[]');
	} catch (error) {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const seen = new Set<string>();
	return parsed.map((id: unknown) => {
		if (typeof id !== 'string' || !ID_PATTERN.test(id) || seen.has(id))
			return '';
		seen.add(id);
		return id;
	});
}
/** the kept ids, oldest first */
const keptIds = () =>
	storedIds(localStorage.getItem(KEY)).filter((id) => id !== '');

/**
 * The id of a controller whose host gave none: one that stays the same from
 * visit to visit. The routed URL of every script a proxied page loads
 * starts with the id, and a browser keeps a script's compiled code (V8's
 * code cache) only for the same URL, so with a new id for every page a
 * returning visit compiled everything again, and the rewrite cache, whose
 * key includes the address, rewrote it first.
 *
 * The ids are kept in the host origin's localStorage, and each is held by
 * one controller at a time with a Web Lock, let go when its page goes: two
 * tabs open at once are two controllers side by side, and one id for both
 * would make the second replace the first in the service worker. A
 * controller takes the id it had before its tab reloaded (sessionStorage,
 * by its place among the document's controllers, while the id is still
 * kept), else the oldest kept one nobody holds, else a new one, which it
 * holds like the others. One claim at a time picks among the kept ids and
 * writes the list (a lock of its own), so two tabs opening together neither
 * take one id nor lose each other's. Without Web Locks or storage, where
 * they refuse (a sandboxed document, a partition that blocks storage), or
 * when a claim does not get its turn in CLAIM_WAIT_MS, the id is a new
 * random one that is not kept, as every id was before.
 *
 * The answer is the only id the controller ever has: nothing is routed,
 * registered or handed to a frame before it (the controllers hold their
 * first handshake for it), so no URL exists under an id that was only a
 * guess.
 *
 * What it costs: the id is random (no page can guess another's) and names
 * nothing but the address, and it is kept where only the host's own origin
 * reads it. But it is in every routed URL, and it lasts: a proxied page is
 * never shown a routed URL, and one that got hold of one through a hole in
 * that would have a name for this browser on this host that outlives the
 * site's cookies. So the ids are forgotten when the cookies are
 * (forgetControllerIds, on `cookies.clear()` for every site), and with the
 * host origin's own site data.
 */
export function keptControllerId(): Promise<string> {
	const place = claims++;
	return claimKeptId(place).catch(() => mintId());
}

async function claimKeptId(place: number): Promise<string> {
	const locks = (globalThis.navigator as Navigator | undefined)?.locks;
	if (!locks || typeof locks.request !== 'function') return mintId();
	// storage that refuses throws here: nothing can be kept, a new id
	const kept = keptIds();
	const own = storedIds(sessionStorage.getItem(KEY))[place];

	// this controller's own id from before a reload: the old document lets
	// go of it a moment after it is gone. Only while it is still kept:
	// forgotten ids do not come back with a tab's reload. A duplicated tab
	// has its original's ids, and waits here in vain while that one is open
	if (own && kept.includes(own) && !HELD.has(own))
		if (await hold(locks, own, RELOAD_WAIT_MS)) return remember(place, own);

	return locks.request(
		KEY,
		{ signal: AbortSignal.timeout(CLAIM_WAIT_MS) },
		async () => {
			// read again: the list is only written under this lock
			const kept = keptIds();
			for (const id of kept)
				if (!HELD.has(id) && (await hold(locks, id)))
					return remember(place, id);
			// a new one, held like the others; one this page cannot hold
			// (locks that refuse) is not kept, and serves this page alone
			const id = mintId();
			if (!(await hold(locks, id))) return id;
			try {
				// the oldest dropped: the list never grows past KEPT_IDS
				localStorage.setItem(
					KEY,
					JSON.stringify([...kept, id].slice(-KEPT_IDS)),
				);
			} catch (error) {
				// not kept (a full store): the id still serves this page
			}
			return remember(place, id);
		},
	);
}

/**
 * Hold an id's lock until the page goes. Let go on pagehide: a closed tab's
 * document can outlive it by half a minute (its workers too), and a tab
 * opened in that time would take another id. `wait`: how long to wait for a
 * holder to let go, else the id is taken only when it is free.
 */
function hold(locks: LockManager, id: string, wait = 0): Promise<boolean> {
	const gone = () =>
		new Promise<void>((release) =>
			globalThis.addEventListener?.('pagehide', (event) => {
				if (!(event as PageTransitionEvent).persisted) release();
			}),
		);
	return new Promise<boolean>((resolve) => {
		locks
			.request(
				`${KEY}:${id}`,
				wait ? { signal: AbortSignal.timeout(wait) } : { ifAvailable: true },
				(lock) => {
					if (lock === null) return resolve(false);
					HELD.add(id);
					resolve(true);
					return gone();
				},
			)
			.catch(() => resolve(false));
	});
}

/** this tab's ids, by the place of the controller that holds each */
function remember(place: number, id: string): string {
	try {
		const own = storedIds(sessionStorage.getItem(KEY));
		for (let index = own.length; index < place; index++) own[index] = '';
		own[place] = id;
		sessionStorage.setItem(KEY, JSON.stringify(own.slice(0, KEPT_IDS)));
	} catch (error) {
		// not remembered: after a reload the tab takes a free one
	}
	return id;
}

/**
 * Forget the host origin's kept ids: the next page gets a new one, and so
 * does every open tab when it reloads (a controller keeps the id it holds
 * until then). Under the claims' lock, so a claim in another tab that read
 * the list before does not write it back.
 */
export async function forgetControllerIds(): Promise<void> {
	const forget = () => {
		try {
			localStorage.removeItem(KEY);
			sessionStorage.removeItem(KEY);
		} catch (error) {
			// no storage: nothing was kept
		}
	};
	const locks = (globalThis.navigator as Navigator | undefined)?.locks;
	try {
		if (locks && typeof locks.request === 'function')
			return await locks.request(
				KEY,
				{ signal: AbortSignal.timeout(CLAIM_WAIT_MS) },
				forget,
			);
	} catch (error) {
		// no turn in time, or locks that refuse: forget all the same
	}
	forget();
}
