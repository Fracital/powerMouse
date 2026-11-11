// How each load a kept script response answered was delivered. The rewrite
// cache's entry for a script goes to the page as the store's own Response
// (anything made from it loses the compiled code Chrome keeps with it), so
// it cannot carry what the worker marks every other answer with: whether
// this load was answered from the worker's caches, after a revalidation,
// or from the network (the origin sent the same bytes again). Resource
// timing says which natively (messages.ts Delivery), so the forward notes
// it here, by the routed URL and the time, and tells the window that
// asked (KEPT_LOAD), whose inject keeps the note for when the page reads
// the entry that carries the kept response's mark (KEPT_MARKER). A page
// that reads it before the message has come asks over the synchronous
// bridge: the worker that just answered the load is running, and has it
// here. Nothing is kept past the worker: a window has its notes already.
import { Delivery, KEPT_LOAD, KeptLoad } from '../transport/messages';
import type Router from './Router';
import { jsonAPI } from './Router';

const KEPT = 4096;

/** every load noted since the worker started, oldest first, by URL */
const loads = new Map<string, KeptLoad[]>();
let count = 0;

const keyOf = (url: string) => url.split('#')[0];

/** a kept script response answers, now, the load of the routed URL `url` that the client `clientId` asked for */
export function noteKeptLoad(
	url: string,
	delivery: Delivery,
	clientId: string | undefined,
) {
	const key = keyOf(url);
	const load: KeptLoad = [Date.now(), delivery];
	const list = loads.get(key);
	if (list) list.push(load);
	else loads.set(key, [load]);
	if (++count > KEPT) {
		// the URL noted longest ago gives up its oldest
		const [oldest, its] = loads.entries().next().value!;
		its.shift();
		count--;
		if (!its.length) loads.delete(oldest);
	}
	if (!clientId || typeof clients === 'undefined') return;
	clients
		.get(clientId)
		.then((client) => {
			// (a worker has no bridge to hear it on: its entries read as the
			// HTTP cache's)
			if (client?.type === 'window')
				client.postMessage({ [KEPT_LOAD]: [key, ...load] });
		})
		.catch(() => {
			// the client went away: nobody to tell
		});
}

/** the loads noted for each routed URL of `urls`, oldest first */
export function keptLoads(urls: string[]): KeptLoad[][] {
	return urls.map((url) => loads.get(keyOf(String(url))) ?? []);
}

/** the page-facing route: the inject asks by the URLs its timing entries have */
export function registerKeptLoads(router: Router) {
	router.routes.set(
		/^\/timing\/kept$/,
		jsonAPI((urls: string[]) => keptLoads(Array.isArray(urls) ? urls : [])),
	);
}
