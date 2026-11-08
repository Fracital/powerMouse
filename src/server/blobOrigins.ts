// The real origin of each blob: URL a proxied document minted, as the
// service worker verified it (the minting document's routed URL, decoded).
// A blob: worker's client URL is the blob: URL itself, which decodes to no
// real URL; its requests are judged by this origin instead.
//
// An entry outlives revocation: pages revoke right after `new Worker()`,
// and the worker's requests come later, which would then be judged as
// their target's own again (with its SameSite=Strict cookies). It goes when
// the document that minted it is gone (its dedicated workers went with it),
// checked at most once a minute, and the oldest go first past KEPT.
declare const self: ServiceWorkerGlobalScope;

const KEPT = 1024;
const PRUNE_EVERY_MS = 60000;
const origins = new Map<string, { origin: string; minter: string }>();
let pruned = 0;

async function prune() {
	pruned = Date.now();
	let live: Set<string>;
	try {
		live = new Set(
			(
				await self.clients.matchAll({ includeUncontrolled: true, type: 'all' })
			).map((client) => client.id),
		);
	} catch (error) {
		return;
	}
	for (const [url, { minter }] of origins)
		if (!live.has(minter)) origins.delete(url);
}

/** record a blob: URL minted by the client `minter`, of real origin `origin` */
export function recordBlobOrigin(url: string, origin: string, minter: string) {
	origins.delete(url);
	origins.set(url, { origin, minter });
	if (origins.size > KEPT) origins.delete(origins.keys().next().value!);
	if (Date.now() - pruned > PRUNE_EVERY_MS) void prune();
}

/** the real origin a blob: URL was minted by, as a URL, when it is known */
export function blobOriginOf(url: string): URL | null {
	// a client's URL may carry a fragment the blob: URL did not
	const entry = origins.get(url.split('#')[0]);
	return entry ? new URL(entry.origin) : null;
}
