// Whether a page that waits synchronously stops the other workers of its
// process (src/server/syncFrozen.ts): asked by the service worker once, and
// kept by it. A dedicated worker of this document starts an IndexedDB call
// while this thread spins for a moment; where the call can finish only once
// the spin ends (WebKit: it lands right after), the bridge's answers cannot
// come while a page waits. In Chrome and Firefox it lands meanwhile, in a
// few ms. Two rounds must agree, so a busy machine that slows the call in
// one round does not decide it.

/** how long this thread spins in each round, in ms */
const SPIN_MS = 150;
/** how long after the spin a stopped call lands at most, in ms */
const AFTER_MS = 40;

const WORKER = `onmessage=async()=>{await new Promise(r=>setTimeout(r,20));const s=Date.now();try{await indexedDB.databases()}catch(e){}postMessage([s,Date.now()])}`;

/** one round: true where the call landed only once the spin ended, false where it landed during it, null when it cannot tell */
async function round(worker: Worker): Promise<boolean | null> {
	const answer = new Promise<[number, number] | null>((resolve) => {
		worker.onmessage = (event) => resolve(event.data);
		worker.onerror = () => resolve(null);
		setTimeout(() => resolve(null), SPIN_MS + 1000);
	});
	worker.postMessage(0);
	const start = Date.now();
	while (Date.now() - start < SPIN_MS);
	const end = Date.now();
	const times = await answer;
	if (!times) return null;
	const [began, landed] = times;
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
		const first = await round(worker);
		if (first === null) return null;
		const second = await round(worker);
		return second === first ? first : null;
	} finally {
		worker.terminate();
		URL.revokeObjectURL(url);
	}
}
