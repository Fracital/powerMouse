import type { EmbedderPolicy } from '../isolation';

/**
 * What the service worker remembers of each document's and worker's own
 * Cross-Origin-Embedder-Policy, by the routed URL it served them at and by
 * their client id once known (as insecureRequests.ts keeps a document's
 * upgrade-insecure-requests). The browser never sees the page's policy:
 * every proxied document is served with the proxy's own, so that it loads in
 * an isolated host's page, and what the page's policy would refuse (a
 * no-cors load of another origin without a Cross-Origin-Resource-Policy, a
 * worker's script without a policy) is refused here. Kept in memory: a
 * restarted worker forgets it, and the page's loads then go as they did
 * without a policy.
 */
export interface KeptEmbedderPolicy {
	policy: Exclude<EmbedderPolicy, 'unsafe-none'>;
}

const kept = new Map<string, KeptEmbedderPolicy | null>();
const KEPT = 512;

const withoutHash = (url: string) => {
	const hash = url.indexOf('#');
	return hash === -1 ? url : url.slice(0, hash);
};

function remember(key: string, value: KeptEmbedderPolicy | null) {
	kept.delete(key);
	if (kept.size >= KEPT) kept.delete(kept.keys().next().value!);
	kept.set(key, value);
}

/**
 * The document or worker served at `routed` (to the client `clientId`) has
 * this embedder policy; null says it has none, so an earlier document's at
 * the same URL is forgotten
 */
export function rememberEmbedderPolicy(
	routed: string,
	clientId: string | undefined,
	policy: KeptEmbedderPolicy | null,
) {
	const url = `url ${withoutHash(routed)}`;
	if (policy || kept.has(url)) remember(url, policy);
	if (clientId && policy) remember(`client ${clientId}`, policy);
}

/** the embedder policy of the client, or of the document at one of `routed` (its URL, its referrer) */
export function embedderPolicyOf(
	clientId: string | undefined,
	...routed: (string | null | undefined)[]
): KeptEmbedderPolicy | null {
	if (clientId) {
		const own = kept.get(`client ${clientId}`);
		if (own !== undefined) return own;
	}
	for (const url of routed) {
		const policy = url ? kept.get(`url ${withoutHash(url)}`) : undefined;
		if (policy !== undefined) {
			if (clientId) remember(`client ${clientId}`, policy);
			return policy;
		}
	}
	return null;
}
