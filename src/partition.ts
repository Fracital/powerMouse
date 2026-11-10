// Chrome's third-party storage partitioning, as the proxy keys it. Natively
// a context's storage key is its origin and, when the top-level site is
// another site, that site too: a site framed by another shares no
// localStorage, IndexedDB, Cache Storage, OPFS, Web Locks, BroadcastChannel,
// SharedWorker or service worker registration with its own top-level pages,
// and a Partitioned cookie (CHIPS) is kept per top-level site. Every proxied
// site shares the proxy's real origin, so the proxy keys each store by a
// string of its own: the proxied origin, plus `^<top-level site>` when that
// differs (the partition). A first-party context's key is its origin alone,
// what every store was keyed by before partitioning, so nothing stored
// before is lost.

/**
 * tldts getPublicSuffix with the private list (github.io counts): the public
 * suffix of a host, or null
 */
export type PublicSuffix = (host: string) => string | null;

/**
 * The registrable domain of `host` (the public suffix and one label more),
 * or the host itself for an IP, a public suffix or a name with none
 */
function registrableDomain(host: string, publicSuffix: PublicSuffix): string {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return host;
	const suffix = publicSuffix(host);
	if (!suffix || host === suffix || !host.endsWith(`.${suffix}`)) return host;
	const rest = host.slice(0, -suffix.length - 1);
	return `${rest.slice(rest.lastIndexOf('.') + 1)}.${suffix}`;
}

/**
 * The site of `origin` as Chrome keys partitions by it: the scheme and the
 * registrable domain, without the port
 */
export function siteOf(
	origin: string | URL,
	publicSuffix: PublicSuffix,
): string {
	const url = typeof origin === 'string' ? new URL(origin) : origin;
	return `${url.protocol}//${registrableDomain(url.hostname, publicSuffix)}`;
}

/**
 * The partition of a context of `origin` whose top-level document is of
 * `topOrigin`: '' when the two are one site and no frame between them is of
 * another site (`crossAncestor`), else `^<top-level site>`. A site framed by
 * a frame of another site under its own top-level page (A in B in A) is
 * keyed apart from that page, as Chrome keys it (the ancestor chain bit of
 * its storage key): its key names its own site as the top-level one, which
 * no first-party key does.
 */
export function partitionOf(
	origin: string,
	topOrigin: string,
	publicSuffix: PublicSuffix,
	crossAncestor = false,
): string {
	if (crossAncestor) return `^${siteOf(topOrigin, publicSuffix)}`;
	if (origin === topOrigin) return '';
	const top = new URL(topOrigin);
	const own = new URL(origin);
	// one host and scheme is one site without asking the suffix list
	if (top.protocol === own.protocol && top.hostname === own.hostname) return '';
	const site = siteOf(top, publicSuffix);
	return site === siteOf(own, publicSuffix) ? '' : `^${site}`;
}

/** the top-level site a partition names, or null for a first-party one */
export function partitionSite(partition: string): string | null {
	return partition.startsWith('^') ? partition.slice(1) : null;
}

/**
 * A worker's route kind names its partition (`js:worker:top:<site>`): the
 * worker reads it from its own location before any of the page's script
 * runs, and the service worker from the client's route (its Partitioned
 * cookies). A first-party worker's route is as it always was.
 */
const WORKER_TOP = /^js:(?:worker|workerModule):top:([^/]*)$/;

/** the route kind of a worker of `type` in `partition` */
export function workerKind(type: string, partition: string): string {
	const site = partitionSite(partition);
	return site === null
		? `js:${type}`
		: `js:${type}:top:${encodeURIComponent(site)}`;
}

/** the partition a worker's route kind names, '' for none */
export function workerKindPartition(kind: string): string {
	const match = WORKER_TOP.exec(kind);
	if (!match) return '';
	try {
		const site = decodeURIComponent(match[1]);
		return site ? `^${site}` : '';
	} catch (error) {
		return '';
	}
}

const NESTED = /^html(?::form)?:nested:(.*)$/;

/** what a nested route's marker adds to the top origin when a frame above the document is of another site than the top */
const CROSS_ANCESTOR = '/x';

/**
 * A nested document's route marker: the top origin, and `/x` after it when
 * a frame between the document and the top is of another site than the top
 * (its partition then names the top's site whatever its own: see
 * partitionOf). Read as an origin, the marker is the top origin either way.
 */
export function nestedMark(topOrigin: string, crossAncestor: boolean): string {
	return crossAncestor ? `${topOrigin}${CROSS_ANCESTOR}` : topOrigin;
}

/** a nested route's marker as nestedMark made it, or null */
export function parseNestedMark(
	mark: string,
): { top: string; crossAncestor: boolean } | null {
	try {
		const url = new URL(mark);
		return { top: url.origin, crossAncestor: url.pathname === CROSS_ANCESTOR };
	} catch (error) {
		return null;
	}
}

/**
 * The partition a route kind names for a context of `origin`: a nested
 * document's (its top origin is in the kind) or a partitioned worker's; ''
 * for any other (a top-level document, a first-party worker)
 */
export function kindPartition(
	kind: string,
	origin: string,
	publicSuffix: PublicSuffix,
): string {
	const nested = NESTED.exec(kind);
	if (!nested) return workerKindPartition(kind);
	let mark: ReturnType<typeof parseNestedMark>;
	try {
		mark = parseNestedMark(decodeURIComponent(nested[1]));
	} catch (error) {
		return '';
	}
	return mark
		? partitionOf(origin, mark.top, publicSuffix, mark.crossAncestor)
		: '';
}
