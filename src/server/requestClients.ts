import { CLIENT_ID } from '../transport/messages';

/**
 * Whose a request is, for the host's request log. The controller maps a
 * client id to a frame from what the client's document tells the host (it
 * asks `whoami`), and two kinds of client cannot: a worker has no window to
 * tell the host from, and a document on about:srcdoc has no URL of the
 * proxy's to ask at. So a worker's requests name the document that made it
 * (RequestInfo.owner). The request for a worker's script carries both ids
 * (`resultingClientId`; measured in Chrome 152 and 156 for classic, module
 * and shared workers), and a worker started from a blob: URL, whose script
 * no fetch event sees, is found by that URL, which its creator names when it
 * asks for the worker's transport. A document on about:srcdoc is told its
 * id on its first request and tells the host like any other document.
 * Nothing costs a frame a request: a client is looked up once, when it
 * first makes a request the host hears of. What is known here goes with the
 * worker; the controller keeps what it learned.
 */

/** how many clients, and blob: URLs of workers yet to make a request, are kept (the oldest go first) */
const LIMIT = 2048;
/** the clients seen: a worker's creator, null for a document, or a worker nobody named */
const owners = new Map<string, string | null>();
/** the blob: URL a worker starts from -> the client that made the worker */
const blobWorkers = new Map<string, string>();
/** the clients being looked up */
const pending = new Map<string, Promise<void>>();

function remember<V>(map: Map<string, V>, key: string, value: V) {
	map.delete(key);
	map.set(key, value);
	if (map.size > LIMIT) map.delete(map.keys().next().value as string);
}

/**
 * The clients of a fetch event: a document a navigation makes says who it
 * is itself, and a worker's script names the client that made the worker
 */
export function noteRequestClients(
	destination: string,
	clientId: string,
	resultingClientId: string,
) {
	if (!resultingClientId) return;
	const worker = destination === 'worker' || destination === 'sharedworker';
	remember(owners, resultingClientId, worker && clientId ? clientId : null);
}

/** `creator` asked for the transport of a worker it starts from the blob: URL `url` */
export function noteBlobWorker(url: string, creator: string) {
	remember(blobWorkers, url, creator);
}

/** the document at the end of a worker's creators (a worker may make workers) */
function ownerOf(client: string): string | undefined {
	let owner = owners.get(client);
	for (let depth = 0; owner && depth < 8; depth++) {
		const next = owners.get(owner);
		if (!next) break;
		owner = next;
	}
	return owner ?? undefined;
}

async function identify(id: string) {
	let owner: string | null = null;
	try {
		const client = await clients.get(id);
		if (client && client.type !== 'window') {
			owner = blobWorkers.get(client.url) ?? null;
			blobWorkers.delete(client.url);
		} else if (client && client.url === 'about:srcdoc')
			client.postMessage({ [CLIENT_ID]: id });
	} catch (error) {
		// the client went away: nobody to name
	}
	remember(owners, id, owner);
}

/**
 * The owner to report with a request of `client`: at once for a client seen
 * before, after one look at a new one
 */
export function requestOwner(
	client: string,
): string | undefined | Promise<string | undefined> {
	if (owners.has(client) || typeof clients === 'undefined')
		return ownerOf(client);
	let lookup = pending.get(client);
	if (!lookup) {
		lookup = identify(client).finally(() => pending.delete(client));
		pending.set(client, lookup);
	}
	return lookup.then(() => ownerOf(client));
}
