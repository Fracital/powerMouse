import { getDomain } from '../rewriter';

function removeBlob(protocol: string): string {
	return protocol.startsWith('blob:') ? protocol.slice(5) : protocol;
}

/**
 * The site a document's URL belongs to, as the window membrane compares
 * windows: its scheme, registrable domain (by the public suffix list with
 * its private section, so two customers of github.io are two sites; the
 * host itself for an IP or a name with no public suffix) and port. Two
 * documents with the same key hold each other's windows as themselves; any
 * other pair is another origin to each other. Null for a URL whose origin
 * is opaque, which shares nothing (a sandboxed document's opacity is its
 * client's to add).
 */
export function siteKeyOf(url: string): string | null {
	const parsed = new URL(url);
	if (parsed.origin === 'null') return null;
	return `${removeBlob(parsed.protocol)}//${getDomain(parsed.hostname) ?? parsed.hostname}:${parsed.port}`;
}
