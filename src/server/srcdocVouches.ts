// The about:srcdoc documents a routed document vouched for (SRCDOC_VOUCH in
// src/transport/messages.ts). A srcdoc document's URL names no origin, and
// under a no-referrer policy its requests carry no Referer: the worker would
// judge them as an opaque origin's. The document's inject makes a token as
// it starts, its nearest routed ancestor vouches for the token (the worker
// binds it to that ancestor's real origin and partition, as it reads them
// from the ancestor's own route), and the document's own client claims it:
// from then on that client is judged as that origin. The binding is kept
// with the other clients whose URL names no origin (blobOrigins), so a
// service worker restart does not lose it.
//
// The two messages come from two clients, in either order, and the frame's
// first requests (what the preload scanner finds while the inject loads)
// can come before both: a request of an about:srcdoc client the worker
// cannot place another way waits a little for its claim.
import { knownOriginOf, knownTopSiteOf, recordBlobOrigin } from './blobOrigins';

export interface Vouched {
	origin: string;
	/** the top-level site of its partition (src/partition.ts), null for first-party */
	top: string | null;
}

/** how long a vouch waits for its claim, or a claim for its vouch */
const PAIR_MS = 10_000;
/** how long a request of an unplaced about:srcdoc client waits for its claim */
const CLAIM_WAIT_MS = 1_500;
/** the clients known to have no binding, oldest first out */
const UNBOUND_KEPT = 256;

const vouches = new Map<string, Vouched & { expires: number }>();
const claimants = new Map<string, { client: string; expires: number }>();
/** clients that claimed nothing, or never claimed while a request waited */
const unbound = new Set<string>();
const waiters = new Map<string, Set<(vouched: Vouched | null) => void>>();

const keyOf = (clientId: string) => `srcdoc:${clientId}`;

function sweep(now: number) {
	for (const [token, entry] of vouches)
		if (entry.expires <= now) vouches.delete(token);
	for (const [token, entry] of claimants)
		if (entry.expires <= now) claimants.delete(token);
}

function settle(clientId: string, vouched: Vouched | null) {
	if (vouched) {
		unbound.delete(clientId);
		recordBlobOrigin(keyOf(clientId), vouched.origin, clientId, vouched.top);
	} else {
		if (unbound.size >= UNBOUND_KEPT)
			unbound.delete(unbound.values().next().value!);
		unbound.add(clientId);
	}
	for (const wake of waiters.get(clientId) ?? []) wake(vouched);
	waiters.delete(clientId);
}

/** a routed document of `vouched.origin` vouched for `token` */
export function vouch(token: string, vouched: Vouched) {
	const now = Date.now();
	sweep(now);
	const claimant = claimants.get(token);
	if (claimant) {
		claimants.delete(token);
		settle(claimant.client, vouched);
	} else vouches.set(token, { ...vouched, expires: now + PAIR_MS });
}

/**
 * An about:srcdoc client presented `token`: it is of the origin vouched
 * for it. An empty token says none vouches for it.
 */
export function claim(token: string, clientId: string) {
	const now = Date.now();
	sweep(now);
	if (token === '') {
		settle(clientId, null);
		return;
	}
	const entry = vouches.get(token);
	if (entry) {
		vouches.delete(token);
		settle(clientId, { origin: entry.origin, top: entry.top });
	} else claimants.set(token, { client: clientId, expires: now + PAIR_MS });
}

/**
 * What an about:srcdoc client is bound as, null for none. With `wait`, a
 * client that has not claimed yet is waited for a little (once: one that
 * never claims is not waited for again).
 */
export async function boundClient(
	clientId: string,
	wait: boolean,
): Promise<{ client: URL; top: string | null } | null> {
	const key = keyOf(clientId);
	const known = async () => {
		const client = await knownOriginOf(key);
		return client ? { client, top: await knownTopSiteOf(key) } : null;
	};
	const bound = await known();
	if (bound || !wait || unbound.has(clientId)) return bound;
	const vouched = await new Promise<Vouched | null>((resolve) => {
		let set = waiters.get(clientId);
		if (!set) waiters.set(clientId, (set = new Set()));
		const wake = (result: Vouched | null) => {
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			set.delete(wake);
			settle(clientId, null);
			resolve(null);
		}, CLAIM_WAIT_MS);
		set.add(wake);
	});
	return vouched ? { client: new URL(vouched.origin), top: vouched.top } : null;
}
