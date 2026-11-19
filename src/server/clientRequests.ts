declare const self: ServiceWorkerGlobalScope;

// A document's requests end with it. Chrome cancels what a document still
// has in flight as the document goes (a fetch waiting for its answer, a
// hanging XMLHttpRequest, an image), and the connection each held goes to
// the next request of its server. A fetch event hears of none of it while
// the answer has not come (Chrome fires no abort on its request when the
// client goes), so such a request held one of its server's six connections
// (src/transport/socketPool.ts) until the server answered: a page's hanging
// requests outlived it, and the next page of the same server waited behind
// them (a fixture whose server holds four requests a minute: the next
// visit's navigation waited 50 s, natively 11 ms). So the requests of each
// client are held here, and those of a client that is gone are given up as
// the page's own abort gives one up.
//
// A client is gone once the browser lists it no more after the worker saw
// it listed: a worker's first imports come before the browser lists it.
// The clients are looked at as a new one makes its first request (a
// document that replaced another makes its first requests as the other
// goes), and every SWEEP_MS while anything is held (a frame removed, a tab
// closed). A keepalive request (a
// beacon, fetchLater, the storage writes sent as a page goes) outlives its
// document natively and is never held here.

/** how often the clients are looked at while requests are held */
const SWEEP_MS = 1000;

/** by client, how to give up each of its requests in flight */
const held = new Map<string, Set<() => void>>();
/** the clients the browser was seen to list, the oldest dropped first */
const seen = new Set<string>();
const SEEN_KEPT = 2048;
let timer: ReturnType<typeof setTimeout> | undefined;
let sweeping = false;
/** a new client came while the clients were being looked at: again at once */
let soon = false;

function sweepIn(ms: number) {
	if (timer !== undefined || sweeping) return;
	timer = setTimeout(sweep, ms);
}

async function sweep() {
	timer = undefined;
	if (!held.size) return;
	sweeping = true;
	let live: Set<string>;
	try {
		live = new Set(
			(
				await self.clients.matchAll({ includeUncontrolled: true, type: 'all' })
			).map((client) => client.id),
		);
	} catch (error) {
		live = new Set([...held.keys()]);
	}
	sweeping = false;
	for (const [client, aborts] of held)
		if (live.has(client)) {
			if (seen.has(client)) continue;
			if (seen.size >= SEEN_KEPT) seen.delete(seen.values().next().value!);
			seen.add(client);
		} else if (seen.has(client)) {
			held.delete(client);
			seen.delete(client);
			for (const abort of aborts) abort();
		}
	if (held.size) sweepIn(soon ? 0 : SWEEP_MS);
	soon = false;
}

/**
 * Hold a request of `client` in flight: `abort` gives it up when the client
 * is gone. Returns what lets it go once its answer came.
 */
export function holdRequest(client: string, abort: () => void): () => void {
	let aborts = held.get(client);
	if (!aborts) held.set(client, (aborts = new Set()));
	if (seen.has(client)) sweepIn(SWEEP_MS);
	else if (sweeping) soon = true;
	else {
		clearTimeout(timer);
		timer = undefined;
		sweepIn(0);
	}
	const own = aborts;
	own.add(abort);
	return () => {
		own.delete(abort);
		if (!own.size && held.get(client) === own) held.delete(client);
	};
}
