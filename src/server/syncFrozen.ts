// Whether a page that waits synchronously stops this worker (Config
// syncFrozen), as the controller's document measures it
// (src/controller/syncFreezes.ts), and what a document's shell carries
// where it does (Config syncSeed).
//
// In WebKit a page that spins or waits in a synchronous request stops every
// call of its process that needs the page's thread: this worker's fetch,
// Cache Storage, IndexedDB, cookieStore and clients, and a dedicated or
// shared worker's fetch, IndexedDB, WebSocket and ports all finish only once
// the page's wait ends (measured in WebKitGTK 2.52.4, with Chrome 157 and
// Firefox 160 beside it, where they finish meanwhile). So no answer of the
// synchronous bridge (src/inject/dom/modules/Sync.ts) can reach such a
// page: a synchronous XMLHttpRequest came back with status 0 after 30 s,
// localStorage and document.cookie threw a RangeError after 10 s. There a
// document is served what it reads synchronously (its cookies and its
// stores), writes asynchronously, and sends a synchronous request of its
// own to the host's server (src/inject/dom/syncRelay.ts), with the cookies
// a request to its URL carries: the HttpOnly ones too, which the inject
// keeps from page script, as it keeps the rest of its config.
import type { SyncSeed } from '../config';
import { partitionOf } from '../partition';
import { getPublicSuffix } from '../suffix';
import type Cookies from './Cookies';
import type { StorageHosts } from './Storage';

const publicSuffix = (host: string) => getPublicSuffix(host, true);

let frozen: boolean | undefined;
let asking: Promise<void> | undefined;
let ask: (() => Promise<boolean | null>) | undefined;
let remember: ((value: boolean) => void) | undefined;
/**
 * how long a document waits for the controller's answer: once, so a
 * controller that cannot answer slows one document only
 */
let patience = 1500;
/** how long one ask may take before it is asked again */
const ASK_MS = 5000;
/** the asks left: each spins the controller's thread for a moment */
let asks = 3;

const sleep = (ms: number) =>
	new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/** what is known: true where a waiting page stops this worker */
export const syncFrozen = (): boolean | undefined => frozen;

/**
 * What an earlier worker learned (`known`), how to ask the controller's
 * document, and how to keep its answer
 */
export function knowSyncFrozen(
	known: boolean | undefined,
	asker: () => Promise<boolean | null>,
	keep: (value: boolean) => void,
) {
	frozen ??= known;
	ask = asker;
	remember = keep;
	learnSyncFrozen();
}

/**
 * Ask the controller's document (again after it could not tell); what a
 * document's shell waits for, the first time at most `patience`
 */
export function learnSyncFrozen(): Promise<void> {
	if (frozen !== undefined || !ask || (!asking && !asks))
		return Promise.resolve();
	const asked = ask;
	if (!asking) asks--;
	asking ??= Promise.race([Promise.resolve().then(asked), sleep(ASK_MS)])
		.catch(() => null)
		.then((answer) => {
			asking = undefined;
			if (typeof answer !== 'boolean' || frozen !== undefined) return;
			frozen = answer;
			remember?.(answer);
		});
	if (!patience) return Promise.resolve();
	return Promise.race([
		asking,
		sleep(patience).then(() => {
			patience = 0;
		}),
	]);
}

/**
 * The cookies and stores of a document of `url` (its top `top`, the origin
 * of the top-level document, and whether a frame between is of another
 * site), as it reads them synchronously, where a waiting page stops this
 * worker: null elsewhere
 */
export async function syncSeed(
	url: URL,
	top: string,
	crossAncestor: boolean,
	cookies: Cookies,
	storage: StorageHosts | undefined,
): Promise<SyncSeed | undefined> {
	if (!frozen) return undefined;
	const partition = partitionOf(url.origin, top, publicSuffix, crossAncestor);
	const key = `${url.origin}${partition}`;
	const site = partition.startsWith('^') ? partition.slice(1) : undefined;
	const [jar, local, session] = await Promise.all([
		cookies
			.get(url.href, site ? { partitionKey: site, site: 'cross-site' } : {})
			.then((jar) => [...jar]),
		storage?.localStorage.getAll(key),
		storage?.sessionStorage.getAll(key),
	]);
	return { key, cookies: jar, local, session };
}
