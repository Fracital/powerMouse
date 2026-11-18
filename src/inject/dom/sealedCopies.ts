/**
 * Sealed copies. A copy the inject makes of an image for a document no
 * service worker controls (DOMAttributes) is a blob: URL in the element's
 * attribute, which any realm of the proxy's origin could fetch. When the
 * image is another origin's and the page may not read it (an opaque copy),
 * the URL the element gets is one nothing can fetch any more:
 *
 * the URL is made in a worker of the bundle's (a blob: URL lives as long as
 * the context that made it), an image element the inject keeps loads it in
 * the document while it is alive, and the worker is terminated. From then
 * on the URL names nothing to a fetch, an XMLHttpRequest or a navigation,
 * while the renderer's memory cache still answers an element or a style
 * that names it (the kept image holds the entry). Measured in plain Chrome
 * 152 and 156: the image loads synchronously from the cache, in any frame
 * of the process; `URL.revokeObjectURL` would not do, it purges the cache.
 *
 * One worker serves every copy that is on its way at the same time (2 ms
 * for fifty images, measured). A second URL the worker made, for nothing,
 * tells when its URLs are gone: the worker's end is not synchronous, and a
 * fetch that fails drops the cache entry of the URL it names. That fetch
 * is asked of another worker of the bundle's (the prober, ended once it
 * has been idle a while): Chrome reports a document's failed fetch in its
 * console ("Failed to load resource: net::ERR_FILE_NOT_FOUND", one for
 * every batch, which the page never caused natively), a worker's not
 * (measured, plain Chrome 157).
 *
 * A document whose policy refuses a worker from a blob: URL (a list's
 * `$csp=worker-src 'none'`, or a script-src without blob:, through the
 * blocker) has the worker made from a route of the service worker's
 * instead, which the carried policy names among its worker sources
 * (src/blocker/csp.ts): the first worker's error before it answered says
 * so, and the copies it was to make are made again by the other.
 *
 * Everything is taken when the bundle loads, before the page runs
 * (./sealerNatives.ts): this file is a deferred part of the document bundle
 * (./deferredParts.ts), evaluated with the copies of a document no service
 * worker controls (./uncontrolledCopies.ts), the one file that calls it.
 */
import { SEALER_SOURCE } from '../../transport/messages';
import { trustedScriptURL } from '../trusted';
import type { SealerNatives } from './sealerNatives';

/** the natives, taken by the bundle at load (./sealerNatives.ts) */
let held: SealerNatives = null;

/** how long a worker takes new copies: a slow one never holds later ones up */
const BATCH_MS = 100;
/** how long a URL is waited for (a worker that never starts) */
const MINT_MS = 3_000;
/** how long the prober is kept with nothing to ask */
const PROBER_IDLE_MS = 5_000;

interface Batch {
	worker: Worker;
	opened: number;
	closed: boolean;
	pending: number;
	next: number;
	waiting: Map<number, (url: string | null) => void>;
	sentinel: Promise<string | null>;
	/** settles once the worker's URLs name nothing */
	dead: Promise<void>;
	die: () => void;
	/** whether the worker was started from the route */
	routed: boolean;
	/** whether it has answered: an error before means it never ran */
	answered: boolean;
	/** the document's policy refused it */
	refused: boolean;
}

let batch: Batch | null = null;
/** the worker's script, made when the first copy is sealed */
let source: string | null = null;
/** this realm's policy refused a worker from a blob: URL: workers come from the route */
let blobRefused = false;

function fail(from: Batch) {
	for (const settle of from.waiting.values()) settle(null);
	from.waiting.clear();
}

function mint(from: Batch, blob: Blob): Promise<string | null> {
	return new Promise((resolve) => {
		const id = from.next++;
		from.waiting.set(id, resolve);
		held!.setTimeout(() => {
			if (from.waiting.delete(id)) resolve(null);
		}, MINT_MS);
		try {
			Reflect.apply(held!.post, from.worker, [[id, blob]]);
		} catch (error) {
			from.waiting.delete(id);
			resolve(null);
		}
	});
}

function open(route: string | null, fromRoute = false): Batch | null {
	const taken = held;
	if (!taken) return null;
	try {
		const routed = (fromRoute || blobRefused) && route !== null;
		if (!routed)
			source ??= Reflect.apply(taken.createObjectURL, taken.URL, [
				new taken.Blob([SEALER_SOURCE], { type: 'text/javascript' }),
			]) as string;
		const worker = new taken.Worker(
			trustedScriptURL(routed ? route! : source!),
		);
		let die!: () => void;
		const made: Batch = {
			worker,
			opened: taken.now(),
			closed: false,
			pending: 0,
			next: 0,
			waiting: new Map(),
			sentinel: Promise.resolve(null),
			dead: new Promise<void>((resolve) => (die = resolve)),
			die,
			routed,
			answered: false,
			refused: false,
		};
		Reflect.apply(taken.listen, worker, [
			'message',
			(event: MessageEvent) => {
				made.answered = true;
				const data = Reflect.apply(taken.dataOf, event, []) as [number, string];
				const settle = made.waiting.get(data[0]);
				made.waiting.delete(data[0]);
				settle?.(data[1]);
			},
		]);
		Reflect.apply(taken.listen, worker, [
			'error',
			() => {
				// a worker that never ran: the policy refused its script
				if (!made.answered && !made.routed) made.refused = blobRefused = true;
				fail(made);
			},
		]);
		made.sentinel = mint(made, new taken.Blob(['']));
		return made;
	} catch (error) {
		return null;
	}
}

/**
 * The worker that asks whether a URL is alive: a blob: one, or the
 * route's where the document's policy refuses a blob: fetch (which a
 * blob: worker inherits) or a blob: worker
 */
let prober: Batch | null = null;
/** the prober's last use, for its idle end */
let probed = 0;

function endProber(ended: Batch) {
	ended.closed = true;
	if (prober === ended) prober = null;
	try {
		Reflect.apply(held!.terminate, ended.worker, []);
	} catch (error) {
		// gone already
	}
	fail(ended);
}

/** the prober to ask, started if there is none (when a batch opens too, so it is up when the batch ends) */
function proberFor(route: string | null, fromRoute: boolean): Batch | null {
	const routed = (fromRoute || blobRefused) && route !== null;
	if (prober && (prober.closed || prober.refused || prober.routed !== routed))
		endProber(prober);
	if (!prober) {
		prober = open(route, fromRoute);
		const opened = prober;
		if (opened) {
			const idle = () => {
				if (prober !== opened) return;
				const left = probed + PROBER_IDLE_MS - held!.now();
				if (left > 0) held!.setTimeout(idle, left);
				else endProber(opened);
			};
			held!.setTimeout(idle, PROBER_IDLE_MS);
		}
	}
	probed = held!.now();
	return prober;
}

/** whether a fetch of `url` succeeds, asked of the prober (null when it cannot say) */
async function probe(
	url: string,
	route: string | null,
	fromRoute: boolean,
): Promise<boolean | null> {
	const asked = proberFor(route, fromRoute);
	if (!asked) return null;
	const answer = await new Promise<string | null>((resolve) => {
		const id = asked.next++;
		asked.waiting.set(id, resolve);
		held!.setTimeout(() => {
			if (asked.waiting.delete(id)) resolve(null);
		}, MINT_MS);
		try {
			Reflect.apply(held!.post, asked.worker, [[id, url]]);
		} catch (error) {
			asked.waiting.delete(id);
			resolve(null);
		}
	});
	return answer === null ? null : answer === '1';
}

/**
 * End a worker, and wait until what it made is gone, as the prober finds
 * it. `fetchRefused`: the route's worker asks, for a document whose policy
 * refuses a blob: fetch (the page would see the violation)
 */
async function close(
	ended: Batch,
	route: string | null,
	fetchRefused: boolean,
) {
	ended.closed = true;
	if (batch === ended) batch = null;
	const sentinel = await ended.sentinel;
	try {
		Reflect.apply(held!.terminate, ended.worker, []);
	} catch (error) {
		// gone already
	}
	fail(ended);
	if (sentinel !== null)
		for (let tries = 0; tries < 400; tries++) {
			let alive = await probe(sentinel, route, fetchRefused);
			// no worker to ask: this realm's own fetch, which the console
			// reports when it fails (one the policy refuses is not made)
			if (alive === null && !fetchRefused)
				alive = await fetch(sentinel).then(
					() => true,
					() => false,
				);
			if (alive !== true) break;
			await new Promise((resolve) => held!.setTimeout(resolve, 1));
		}
	ended.die();
}

/**
 * A blob: URL of `blob` that nothing can fetch by the time it is handed
 * over. `prime` is given the URL while it is alive: it loads it where it
 * is to be shown and says whether that worked. Null when it did not, or
 * when no worker can be had: the caller makes an ordinary URL. `route` is
 * the service worker's route of the worker's script, for a document whose
 * policy refuses a blob: one.
 */
export async function sealedURL(
	/** the natives the bundle took at load (./sealerNatives.ts) */
	natives: SealerNatives,
	blob: Blob,
	prime: (url: string) => Promise<boolean>,
	route: string | null = null,
	/** what the document's own policy refuses of blob: URLs (src/csp.ts): a worker, a fetch */
	refuses: { worker: boolean; fetch: boolean } = {
		worker: false,
		fetch: false,
	},
): Promise<string | null> {
	held = natives;
	// a refusal the page's policy makes would show the page a violation:
	// the route's worker, from the start
	if (refuses.worker && route !== null) blobRefused = true;
	for (;;) {
		if (
			!batch ||
			batch.closed ||
			(held !== null && held.now() - batch.opened > BATCH_MS)
		) {
			batch = open(route);
			proberFor(route, refuses.fetch);
		}
		const mine = batch;
		if (!mine) return null;
		mine.pending++;
		let made: string | null = null;
		const url = await mint(mine, blob)
			.then(async (minted) => {
				made = minted;
				return minted !== null && (await prime(minted)) ? minted : null;
			})
			.catch(() => null);
		if (--mine.pending === 0 && !mine.closed)
			close(mine, route, refuses.fetch).catch(() => mine.die());
		await mine.dead;
		// refused: once more, from the route (a routed worker is not refused again)
		if (made !== null || !mine.refused || route === null) return url;
	}
}
