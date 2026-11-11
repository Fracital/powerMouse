/**
 * Load grants: what lets the inject copy a page's load for a document no
 * service worker controls (an about:blank frame or popup, whose own
 * requests never reach this worker). The copy is a fetch from the nearest
 * controlled document, which the worker must judge as the load it stands
 * for (an image of another origin is read whole, where a page's own fetch
 * of it is refused). A header any realm can write cannot say so: the
 * inject announces each such request beforehand on a MessagePort its client
 * opened before any of the page's script ran (LOAD_CHANNEL), under a token
 * it made, and the request carries the token (LOAD_HEADER).
 *
 * A grant is for one request: the client that announced it, the URL and
 * the load it named, taken once, gone after GRANT_TTL_MS. A request whose
 * token names no such grant is the page's own, judged by its real mode.
 * The worker takes one channel per client for as long as it lives; what it
 * keeps is bounded (CHANNELS_KEPT, GRANTS_KEPT, GRANTS_PER_CLIENT).
 *
 * A worker that restarted has no channels. A token from a client without
 * one makes the worker ask that client, once, to open its channel again
 * (SW_REVIVE); the inject then tells its last few announcements again.
 */
import { SW_REVIVE } from '../transport/messages';

/** a token: 22 random characters of base64url */
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
/** how long an announced load waits for its request */
export const GRANT_TTL_MS = 30_000;
/** how long a request waits for its announcement (the two travel apart) */
export const GRANT_WAIT_MS = 1_000;
/** announcements kept in all, and for one client: the oldest go first */
export const GRANTS_KEPT = 2048;
export const GRANTS_PER_CLIENT = 512;
/** the longest URL an announcement may name */
const URL_MAX = 16_384;
/** channels kept: past it, those of clients that are gone are closed */
export const CHANNELS_KEPT = 512;
/** tokens remembered as taken, so that a replay is answered at once */
const SPENT_KEPT = 1024;
const LOAD = /^[a-z]+(?: [a-z-]+)?$/;

interface Grant {
	client: string;
	url: string;
	load: string;
	expires: number;
}

const channels = new Map<string, MessagePort>();
const grants = new Map<string, Grant>();
const perClient = new Map<string, number>();
const spent = new Set<string>();
const waiting = new Map<string, (grant: Grant | null) => void>();
/** clients asked to open their channel again, oldest first out */
const asked = new Map<string, number>();

/** a URL as two requests for it compare: absolute, without its fragment */
function comparable(url: string): string | null {
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		return parsed.href;
	} catch (error) {
		return null;
	}
}

function forget(token: string) {
	const grant = grants.get(token);
	if (!grant) return;
	grants.delete(token);
	const count = (perClient.get(grant.client) ?? 1) - 1;
	if (count > 0) perClient.set(grant.client, count);
	else perClient.delete(grant.client);
}

function spend(token: string) {
	spent.add(token);
	if (spent.size > SPENT_KEPT) spent.delete(spent.values().next().value!);
}

function announce(client: string, data: unknown) {
	const message = data as Partial<Record<string, unknown>> | null;
	if (
		!message ||
		typeof message !== 'object' ||
		typeof message.token !== 'string' ||
		!TOKEN.test(message.token) ||
		typeof message.url !== 'string' ||
		message.url.length > URL_MAX ||
		typeof message.load !== 'string' ||
		!LOAD.test(message.load)
	)
		return;
	const { token } = message;
	const url = comparable(message.url);
	// a token is announced once: a second announcement cannot replace it,
	// nor bring a taken one back
	if (url === null || grants.has(token) || spent.has(token)) return;
	const now = Date.now();
	const grant: Grant = {
		client,
		url,
		load: message.load,
		expires: now + GRANT_TTL_MS,
	};
	// its request is here already
	const waiter = waiting.get(token);
	if (waiter) {
		waiting.delete(token);
		waiter(grant);
		return;
	}
	for (const [kept, entry] of grants) {
		if (entry.expires > now) break;
		forget(kept);
	}
	if ((perClient.get(client) ?? 0) >= GRANTS_PER_CLIENT)
		for (const [kept, entry] of grants)
			if (entry.client === client) {
				forget(kept);
				break;
			}
	if (grants.size >= GRANTS_KEPT) forget(grants.keys().next().value!);
	grants.set(token, grant);
	perClient.set(client, (perClient.get(client) ?? 0) + 1);
}

/**
 * A client's load channel: the first it opens, for as long as this worker
 * lives (its inject opens it before any of its page's script runs). Whether
 * it was taken.
 */
export function openLoadChannel(client: string, port: MessagePort): boolean {
	if (channels.has(client)) {
		port.close();
		return false;
	}
	channels.set(client, port);
	port.addEventListener('message', (event) => announce(client, event.data));
	port.start();
	// the inject uses a channel it opened again only once it hears this
	port.postMessage(true);
	if (channels.size > CHANNELS_KEPT) sweepChannels().catch(() => {});
	return true;
}

/** close the channels of clients that are gone */
async function sweepChannels() {
	const alive = new Set(
		(
			await (self as unknown as ServiceWorkerGlobalScope).clients.matchAll({
				type: 'window',
			})
		).map((client) => client.id),
	);
	for (const [client, port] of channels)
		if (!alive.has(client)) {
			port.close();
			channels.delete(client);
		}
}

/**
 * Ask a client that has no channel to open one (this worker restarted
 * under it): once for each client. Whether its channel may still come:
 * it was asked now, or within the time a request waits.
 */
function ask(client: string): boolean {
	const before = asked.get(client);
	if (before !== undefined) return Date.now() - before < GRANT_WAIT_MS;
	asked.set(client, Date.now());
	if (asked.size > CHANNELS_KEPT) asked.delete(asked.keys().next().value!);
	(self as unknown as ServiceWorkerGlobalScope).clients
		.get(client)
		.then((found) => found?.postMessage({ [SW_REVIVE]: {} }))
		.catch(() => {});
	return true;
}

/**
 * The load a request's LOAD_HEADER was granted as, once: null for a value
 * that is no token, a token nothing announced (waited for briefly when its
 * client has a channel or was just asked for one, since the announcement
 * and the request travel apart), one taken before, one of another client or for another URL, or
 * an expired one.
 */
export async function takeLoadGrant(
	header: string | null,
	client: string | undefined,
	url: string,
): Promise<string | null> {
	if (header === null || !client || !TOKEN.test(header)) return null;
	if (spent.has(header)) return null;
	let grant = grants.get(header) ?? null;
	if (grant) forget(header);
	else if ((channels.has(client) || ask(client)) && !waiting.has(header))
		grant = await new Promise<Grant | null>((resolve) => {
			const timer = setTimeout(() => {
				waiting.delete(header);
				resolve(null);
			}, GRANT_WAIT_MS);
			waiting.set(header, (announced) => {
				clearTimeout(timer);
				resolve(announced);
			});
		});
	if (!grant) return null;
	// taken, whoever asked and whatever for
	spend(header);
	return grant.client === client &&
		grant.url === comparable(url) &&
		grant.expires > Date.now()
		? grant.load
		: null;
}

/** @internal what is kept right now, for the suites and the cost table */
export function loadGrantStats() {
	return {
		channels: channels.size,
		grants: grants.size,
		spent: spent.size,
		waiting: waiting.size,
	};
}
