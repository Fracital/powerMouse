// Domain lists as Chromium matches them (url_pattern_index.cc
// GetLongestMatchingSubdomain and DoesHostMatchDomainLists, url_util.cc
// DomainIs): a list matches a host by its longest entry that is the host or
// a parent domain of it, and an excluded list wins only with a strictly
// longer entry than the longest included one. Lists are kept sorted as
// Chromium keeps them (longest first, then by code unit), which its
// binary search over the host's subdomains relies on (lists of more than
// five entries); a shorter list is walked with DomainIs, whose leading and
// trailing dot handling differs, and that difference is kept.

/** CompareDomains: longer first, then lexicographic */
export function compareDomains(a: string, b: string): number {
	if (a.length !== b.length) return a.length > b.length ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** url::DomainIs */
export function domainIs(host: string, domain: string): boolean {
	if (!host.length || !domain.length) return false;
	let hostLength = host.length;
	if (host[hostLength - 1] === '.' && domain[domain.length - 1] !== '.')
		hostLength--;
	if (hostLength < domain.length) return false;
	const first = hostLength - domain.length;
	if (host.slice(first, hostLength) !== domain) return false;
	return !(
		domain[0] !== '.' &&
		hostLength > domain.length &&
		host[first - 1] !== '.'
	);
}

/** GetLongestMatchingSubdomain over a sorted list */
export function longestMatchingSubdomain(
	host: string,
	domains: string[],
): number {
	if (!host.length) return 0;
	let end = host.length;
	while (end > 1 && host[end - 1] === '.') end--;
	if (end !== host.length) host = host.slice(0, end);
	if (domains.length <= 5) {
		for (const domain of domains)
			if (domainIs(host, domain)) return domain.length;
		return 0;
	}
	let left = 0;
	for (let position = 0; ; position++) {
		const subdomain = host.slice(position);
		let right = domains.length;
		while (left + 1 < right) {
			const middle = left + ((right - left) >> 1);
			if (compareDomains(domains[middle], subdomain) <= 0) left = middle;
			else right = middle;
		}
		if (domains[left] === subdomain) return subdomain.length;
		position = host.indexOf('.', position);
		if (position < 0) break;
	}
	return 0;
}

/** DoesHostMatchDomainLists */
export function hostMatchesLists(
	host: string,
	included: string[] | undefined,
	excluded: string[] | undefined,
): boolean {
	const longest = included ? longestMatchingSubdomain(host, included) : 1;
	if (longest && excluded)
		return longestMatchingSubdomain(host, excluded) < longest;
	return longest > 0;
}

/** a rule's domain list as Chromium indexes it (CanonicalizeDomains: lowercased, sorted) */
export function sortedDomains(domains: string[]): string[] {
	return domains.map((domain) => domain.toLowerCase()).sort(compareDomains);
}

/**
 * The key a domain entry is filed under in the matcher's domain buckets:
 * the entry without leading and trailing dots, so that every host the
 * entry can match (by DomainIs or by the binary search) has the key as one
 * of its label suffixes (hostSuffixes)
 */
export function bucketKey(domain: string): string {
	let begin = 0;
	let end = domain.length;
	while (begin < end && domain[begin] === '.') begin++;
	while (end > begin && domain[end - 1] === '.') end--;
	return domain.slice(begin, end);
}

const finalize = (x: number) => {
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return (x ^ (x >>> 16)) & 0x3fffffff;
};

/**
 * A domain bucket key as a small integer: FNV-1a over its characters from
 * the last to the first, so one pass over a host from its end yields the
 * key of each of its suffixes (suffixHashes)
 */
export function domainHash(domain: string): number {
	let h = 0x811c9dc5;
	for (let i = domain.length - 1; i >= 0; i--)
		h = Math.imul(h ^ domain.charCodeAt(i), 0x01000193);
	return finalize(h);
}

/** domainHash of the host and each parent domain of it (hostSuffixes' strings); returns the count */
export function suffixHashes(host: string, out: Int32Array): number {
	let end = host.length;
	while (end > 1 && host[end - 1] === '.') end--;
	let h = 0x811c9dc5;
	let count = 0;
	for (let i = end - 1; i >= 0; i--) {
		const code = host.charCodeAt(i);
		if (code === 0x2e && i + 1 < end) out[count++] = finalize(h);
		h = Math.imul(h ^ code, 0x01000193);
	}
	if (end > 0) out[count++] = finalize(h);
	return count;
}

/** the host and each parent domain of it, longest first, trailing dots dropped */
export function hostSuffixes(host: string, out: string[]): string[] {
	out.length = 0;
	let end = host.length;
	while (end > 1 && host[end - 1] === '.') end--;
	if (end !== host.length) host = host.slice(0, end);
	if (!host.length) return out;
	out.push(host);
	for (let at = host.indexOf('.'); at >= 0; at = host.indexOf('.', at + 1))
		if (at + 1 < host.length) out.push(host.slice(at + 1));
	return out;
}
