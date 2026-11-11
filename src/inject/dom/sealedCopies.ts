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
 * fetch that fails drops the cache entry of the URL it names.
 *
 * Everything is taken when the bundle loads, before the page runs.
 */
type Post = (message: unknown) => void;

const taken = (() => {
	try {
		const Worker = globalThis.Worker;
		return {
			Worker,
			createObjectURL: globalThis.URL.createObjectURL,
			URL: globalThis.URL,
			Blob: globalThis.Blob,
			post: Worker.prototype.postMessage as Post,
			terminate: Worker.prototype.terminate,
			listen: globalThis.EventTarget.prototype.addEventListener,
			dataOf: Reflect.getOwnPropertyDescriptor(
				globalThis.MessageEvent.prototype,
				'data',
			)!.get!,
			setTimeout: globalThis.setTimeout.bind(globalThis),
			now: Date.now,
		};
	} catch (error) {
		return null;
	}
})();

/** how long a worker takes new copies: a slow one never holds later ones up */
const BATCH_MS = 100;
/** how long a URL is waited for (a worker that never starts) */
const MINT_MS = 3_000;

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
}

let batch: Batch | null = null;
/** the worker's script, made when the first copy is sealed */
let source: string | null = null;

function fail(from: Batch) {
	for (const settle of from.waiting.values()) settle(null);
	from.waiting.clear();
}

function mint(from: Batch, blob: Blob): Promise<string | null> {
	return new Promise((resolve) => {
		const id = from.next++;
		from.waiting.set(id, resolve);
		taken!.setTimeout(() => {
			if (from.waiting.delete(id)) resolve(null);
		}, MINT_MS);
		try {
			Reflect.apply(taken!.post, from.worker, [[id, blob]]);
		} catch (error) {
			from.waiting.delete(id);
			resolve(null);
		}
	});
}

function open(): Batch | null {
	if (!taken) return null;
	try {
		source ??= Reflect.apply(taken.createObjectURL, taken.URL, [
			new taken.Blob(
				[
					'onmessage=function(e){postMessage([e.data[0],URL.createObjectURL(e.data[1])])}',
				],
				{ type: 'text/javascript' },
			),
		]) as string;
		const worker = new taken.Worker(source);
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
		};
		Reflect.apply(taken.listen, worker, [
			'message',
			(event: MessageEvent) => {
				const data = Reflect.apply(taken.dataOf, event, []) as [number, string];
				const settle = made.waiting.get(data[0]);
				made.waiting.delete(data[0]);
				settle?.(data[1]);
			},
		]);
		Reflect.apply(taken.listen, worker, ['error', () => fail(made)]);
		made.sentinel = mint(made, new taken.Blob(['']));
		return made;
	} catch (error) {
		return null;
	}
}

/** end a worker, and wait until what it made is gone */
async function close(ended: Batch) {
	ended.closed = true;
	if (batch === ended) batch = null;
	const sentinel = await ended.sentinel;
	try {
		Reflect.apply(taken!.terminate, ended.worker, []);
	} catch (error) {
		// gone already
	}
	fail(ended);
	if (sentinel !== null)
		for (let tries = 0; tries < 400; tries++) {
			try {
				await fetch(sentinel);
			} catch (error) {
				break;
			}
			await new Promise((resolve) => taken!.setTimeout(resolve, 1));
		}
	ended.die();
}

/**
 * A blob: URL of `blob` that nothing can fetch by the time it is handed
 * over. `prime` is given the URL while it is alive: it loads it where it
 * is to be shown and says whether that worked. Null when it did not, or
 * when no worker can be had: the caller makes an ordinary URL.
 */
export async function sealedURL(
	blob: Blob,
	prime: (url: string) => Promise<boolean>,
): Promise<string | null> {
	if (
		!batch ||
		batch.closed ||
		(taken !== null && taken.now() - batch.opened > BATCH_MS)
	)
		batch = open();
	const mine = batch;
	if (!mine) return null;
	mine.pending++;
	const url = await mint(mine, blob)
		.then(async (made) => (made !== null && (await prime(made)) ? made : null))
		.catch(() => null);
	if (--mine.pending === 0 && !mine.closed) close(mine).catch(() => mine.die());
	await mine.dead;
	return url;
}
