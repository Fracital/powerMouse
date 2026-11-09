// The service worker's side of the controller's rewrite workers: a port to
// each, scripts held in a queue here (rewriteQueue) and handed to a worker
// one at a time, as it is free. A rewrite comes
// back from a worker or not at all: null tells the caller to make it
// itself, which it does whenever no worker is ready (the controller started
// none, a worker has not started yet or failed to load, its port closed
// with the page or a crash) or the worker took longer than the timeout. A
// port that closed or timed out is not used again.
import type { Config } from '../config';
import { minified, ScriptType } from '../rewriteJS';
import { REWRITE_READY, REWRITE_RPC, RewriteBound } from '../rewriteMessages';
import { routeScopeList } from '../routeURL';
import { SPLIT_MIN, splitSources, stitch } from '../splitRewrite';
import type StompURL from '../StompURL';
import { RpcHelper } from '../transport/rpc';
import { RewriteQueue } from './rewriteQueue';

/** what a worker is given at once: one, so the queue's order is the order they are done in */
const IN_FLIGHT = 1;

interface Job {
	/** sent to `member` */
	run(member: Member): void;
	/** no worker is left to send it to */
	fail(): void;
}

interface Member {
	rpc: RpcHelper<Record<string, never>, RewriteBound>;
	port: MessagePort;
	/** rewrites sent and not yet answered */
	busy: number;
	alive: boolean;
	/** the worker said it serves this port (REWRITE_READY): until then nothing is sent */
	ready: boolean;
}

export class RewritePool {
	#members: Member[];
	#timeout: number;
	readonly #queue = new RewriteQueue<Job>();
	constructor(ports: MessagePort[], timeout: number) {
		this.#timeout = timeout;
		this.#members = ports.map((port) => {
			const member: Member = {
				port,
				busy: 0,
				alive: true,
				ready: false,
				rpc: new RpcHelper<Record<string, never>, RewriteBound>(
					{},
					REWRITE_RPC,
					(data, transfer) => port.postMessage(data, transfer),
				),
			};
			port.addEventListener('message', (event) => {
				if (event.data?.[REWRITE_READY] === true) {
					member.ready = true;
					this.#pump();
				} else member.rpc.receive(event.data);
			});
			// the worker (or the page that started it) is gone: what it had in
			// hand fails at once, and nothing more is sent
			port.addEventListener('close', () => this.#drop(member, 'closed'));
			port.start();
			return member;
		});
	}
	/** whether any worker can take a script now */
	get live(): boolean {
		return this.#members.some((member) => member.alive && member.ready);
	}
	#drop(member: Member, reason: string) {
		if (!member.alive) return;
		member.alive = false;
		member.rpc.abort(`rewrite worker ${reason}`);
		member.port.close();
		this.#pump();
	}
	/** let every worker go (the controller was replaced or closed) */
	close() {
		for (const member of this.#members) this.#drop(member, 'released');
	}
	/** queued jobs to free workers; none left to take them, the rest fail */
	#pump() {
		for (;;) {
			const free = this.#members.find(
				(member) => member.alive && member.ready && member.busy < IN_FLIGHT,
			);
			if (!free) break;
			const job = this.#queue.take();
			if (!job) break;
			job.run(free);
		}
		if (!this.live) for (const job of this.#queue.drain()) job.fail();
	}
	/**
	 * A call to a worker when one is free and the queue comes to it, null
	 * when no worker answered in time (the timeout counts from the send)
	 */
	#call<K extends keyof RewriteBound>(
		method: K,
		request: RewriteBound[K][0],
		size: number,
		tier: number,
	): Promise<RewriteBound[K][1] | null> {
		return new Promise((resolve) => {
			this.#queue.add(
				{
					run: (member) => {
						member.busy++;
						let timer: ReturnType<typeof setTimeout> | undefined;
						Promise.race([
							member.rpc.call(method, request),
							new Promise<never>((_, reject) => {
								timer = setTimeout(() => {
									this.#drop(member, `took over ${this.#timeout} ms`);
									reject(new Error('rewrite worker timed out'));
								}, this.#timeout);
							}),
						])
							.then(resolve, () => resolve(null))
							.finally(() => {
								clearTimeout(timer);
								member.busy--;
								this.#pump();
							});
					},
					fail: () => resolve(null),
				},
				size,
				tier,
			);
			this.#pump();
		});
	}
	#rewriteOne(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
		compact?: boolean,
	): Promise<string | null> {
		return this.#call(
			'rewrite',
			{
				script,
				url: url.toString(),
				directory: url.directory,
				codecKey: url.codec.key,
				config,
				type,
				scopes: routeScopeList(),
				...(compact === undefined ? {} : { compact }),
			},
			script.length,
			// a part of a split bundle goes first
			compact === undefined ? 1 : 0,
		);
	}
	/**
	 * A large webpack bundle rewritten by every live worker at once
	 * (splitRewrite): one plans the split, then the skeleton and the groups
	 * go to the workers, ahead of other scripts. Null when it is not split (not a
	 * page's classic script, too small, not minified, fewer than two workers,
	 * a shape not recognised) or a part did not come back: the whole is then
	 * rewritten as one.
	 */
	async #split(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
	): Promise<string | null> {
		if (type !== 'generic' || script.length < SPLIT_MIN) return null;
		const live = this.#members.filter(
			(member) => member.alive && member.ready,
		).length;
		if (live < 2 || !minified(script)) return null;
		const plan = await this.#call(
			'plan',
			{ script, parts: live },
			script.length,
			0,
		);
		if (!plan) return null;
		const { skeleton, parts } = splitSources(script, plan);
		const outputs = await Promise.all(
			[skeleton, ...parts].map((text) =>
				this.#rewriteOne(text, url, config, type, true),
			),
		);
		if (outputs.some((output) => output === null)) return null;
		return stitch(outputs[0]!, outputs.slice(1) as string[], plan);
	}
	/**
	 * The script rewritten by the workers, or null when the caller must
	 * rewrite it itself. `split` is told when it was split across them.
	 */
	async rewrite(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
		split?: () => void,
	): Promise<string | null> {
		const parts = await this.#split(script, url, config, type);
		if (parts !== null) {
			split?.();
			return parts;
		}
		return this.#rewriteOne(script, url, config, type);
	}
}
