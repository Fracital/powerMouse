// The order the rewrite workers take scripts in. Sent to a worker as they
// came, they queued in each worker's message queue: at a page's start
// Discord's ~690 preloaded chunks filled every queue, and the 13 MB main
// bundle (split or not) waited behind them. Held here instead and handed out
// one at a time to a worker that is free: the parts of a split bundle first
// (they are what the page waits on longest), then the largest first (the
// order that finishes a batch soonest), and anything that has waited longer
// than AGED_MS before all of these, oldest first, so a small script is never
// held up indefinitely by large ones that keep coming.

/** a job waiting this long goes before every other not as old */
export const AGED_MS = 1000;

export interface Queued<T> {
	/** the larger, the sooner (a script's length) */
	size: number;
	/** 0 for the parts of a split bundle, 1 for the rest */
	tier: number;
	/** when it was queued (performance.now()) */
	at: number;
	job: T;
}

export class RewriteQueue<T> {
	readonly #items: Queued<T>[] = [];
	#now: () => number;
	constructor(now: () => number = () => performance.now()) {
		this.#now = now;
	}
	get length() {
		return this.#items.length;
	}
	add(job: T, size: number, tier: number) {
		this.#items.push({ job, size, tier, at: this.#now() });
	}
	/** the job to hand out next, taken off the queue */
	take(): T | undefined {
		if (!this.#items.length) return undefined;
		const now = this.#now();
		let best = 0;
		for (let i = 1; i < this.#items.length; i++)
			if (before(this.#items[i], this.#items[best], now)) best = i;
		return this.#items.splice(best, 1)[0].job;
	}
	/** every job still waiting, taken off the queue */
	drain(): T[] {
		return this.#items.splice(0).map((item) => item.job);
	}
}

function before<T>(a: Queued<T>, b: Queued<T>, now: number): boolean {
	const agedA = now - a.at >= AGED_MS;
	const agedB = now - b.at >= AGED_MS;
	if (agedA !== agedB) return agedA;
	if (agedA) return a.at < b.at;
	if (a.tier !== b.tier) return a.tier < b.tier;
	if (a.size !== b.size) return a.size > b.size;
	return a.at < b.at;
}
