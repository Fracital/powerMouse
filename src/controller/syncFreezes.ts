// Whether a page that waits synchronously stops the other workers of its
// process (src/server/syncFrozen.ts): asked by the service worker once, and
// kept by it. A dedicated worker of this document starts an IndexedDB call
// while this thread spins for a moment; where the call can finish only once
// the spin ends (WebKit: it lands right after), the bridge's answers cannot
// come while a page waits. In Chrome and Firefox it lands meanwhile, in a
// few ms.
//
// The spin stops everything else of this thread, the transport too where
// it runs in the page (TransportDescriptor host 'page'): two rounds of
// 150 ms held each request of the controller's first page for up to 300 ms
// in Chrome (http3-fallback). A call that lands while the page still waits
// settles it at once, since an engine that stops workers cannot answer it
// then, so the first round is short and decides in Chrome and Firefox. Only
// an engine where it lands late spins longer, and there two long rounds
// must agree, so a busy machine that slows the call in one round does not
// decide it.

/** how long this thread spins in the first round, in ms: the call lands within a few ms where nothing stops it (Chrome 157: 1 ms, 20 ms on a contended core) */
const FIRST_MS = 30;
/** how long the worker waits before its call in the first round, in ms */
const FIRST_DELAY_MS = 5;
/** how long this thread spins in each later round, in ms */
const SPIN_MS = 150;
/** how long the worker waits before its call in a later round, in ms */
const DELAY_MS = 20;
/** how long after the spin a stopped call lands at most, in ms */
const AFTER_MS = 40;

const WORKER = `onmessage=async(e)=>{await new Promise(r=>setTimeout(r,e.data));const s=Date.now();try{await indexedDB.databases()}catch(e){}postMessage([s,Date.now()])}`;

/** one round of `spin` ms: true where the call landed only once the spin ended, false where it landed during it, null when it cannot tell */
async function round(
	worker: Worker,
	spin: number,
	delay: number,
): Promise<boolean | null> {
	const answer = new Promise<[number, number] | null>((resolve) => {
		worker.onmessage = (event) => resolve(event.data);
		worker.onerror = () => resolve(null);
		setTimeout(() => resolve(null), spin + 1000);
	});
	worker.postMessage(delay);
	const start = Date.now();
	while (Date.now() - start < spin);
	const end = Date.now();
	const times = await answer;
	if (!times) return null;
	const [began, landed] = times;
	// it began and landed while this thread waited: nothing stopped it
	if (began >= start && landed < end) return false;
	// it began well before the end, or it says nothing
	if (began >= end - 50) return null;
	if (landed < end) return false;
	return landed <= end + AFTER_MS ? true : null;
}

/** whether a waiting page stops its process's workers here; null: it could not tell */
export async function syncFreezes(): Promise<boolean | null> {
	if (typeof Worker !== 'function' || typeof indexedDB === 'undefined')
		return null;
	let worker: Worker;
	let url: string;
	try {
		url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
		worker = new Worker(url);
	} catch (error) {
		return null;
	}
	try {
		// started, before the first round
		await new Promise((resolve) => setTimeout(resolve, 50));
		if ((await round(worker, FIRST_MS, FIRST_DELAY_MS)) === false) return false;
		const second = await round(worker, SPIN_MS, DELAY_MS);
		if (second !== true) return second;
		return await round(worker, SPIN_MS, DELAY_MS);
	} finally {
		worker.terminate();
		URL.revokeObjectURL(url);
	}
}
