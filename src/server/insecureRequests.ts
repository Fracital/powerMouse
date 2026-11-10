import type { MixedContentNotice } from '../mixedContent';
import { MIXED_CONTENT_NOTICE } from '../transport/messages';

declare const clients: Clients | undefined;

/**
 * The documents whose policy upgrades insecure requests (a CSP header or
 * meta with upgrade-insecure-requests, or a parent's), by the routed URL
 * the worker served them at and by their client id once known. The
 * browser never sees the page's policy (the worker strips it), so its
 * requests are upgraded here. Kept in memory: a restarted worker forgets
 * it, and the page's requests then go out as written.
 */
const upgrading = new Map<string, true>();
const KEPT = 512;

const withoutHash = (url: string) => {
	const hash = url.indexOf('#');
	return hash === -1 ? url : url.slice(0, hash);
};

function remember(key: string) {
	upgrading.delete(key);
	if (upgrading.size >= KEPT) upgrading.delete(upgrading.keys().next().value!);
	upgrading.set(key, true);
}

/** the document served at `routed` (to the client `clientId`) upgrades its insecure requests */
export function rememberUpgradeInsecure(routed: string, clientId?: string) {
	remember(`url ${withoutHash(routed)}`);
	if (clientId) remember(`client ${clientId}`);
}

/** whether the client, or the document at one of `routed` (its URL, its referrer), upgrades insecure requests */
export function upgradesInsecure(
	clientId: string | undefined,
	...routed: (string | null | undefined)[]
): boolean {
	if (clientId && upgrading.has(`client ${clientId}`)) return true;
	for (const url of routed)
		if (url && upgrading.has(`url ${withoutHash(url)}`)) {
			if (clientId) remember(`client ${clientId}`);
			return true;
		}
	return false;
}

/**
 * Hand the page the console notices Chrome would have printed: to the
 * client that made the request, or for a navigation (which has none yet)
 * to the window at its referrer, the parent that asked for it. Never
 * awaited by the request.
 */
export async function postNotices(
	notices: MixedContentNotice[],
	clientId: string | undefined,
	referrer: string | null,
) {
	if (!notices.length || typeof clients === 'undefined') return;
	try {
		let client: Client | undefined;
		if (clientId) client = await clients.get(clientId);
		else if (referrer)
			client = (await clients.matchAll({ type: 'window' })).find(
				(candidate) => candidate.url === referrer,
			);
		client?.postMessage({ [MIXED_CONTENT_NOTICE]: notices });
	} catch (error) {
		// the client went away: nobody to tell
	}
}
