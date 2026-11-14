// The service worker's side of the controller's rewrite workers: a port to
// each, a script sent to the one with the least in hand. A rewrite comes
// back from a worker or not at all: null tells the caller to make it
// itself, which it does whenever no worker is ready (the controller started
// none, a worker has not started yet or failed to load, its port closed
// with the page or a crash) or the worker took longer than the timeout. A
// port that closed or timed out is not used again.
import type { Config } from '../config';
import { RewrittenBy, ScriptSource, ScriptType } from '../rewriteJS';
import { REWRITE_READY, REWRITE_RPC, RewriteBound } from '../rewriteMessages';
import { routeScopeList } from '../routeURL';
import type StompURL from '../StompURL';
import { RpcHelper } from '../transport/rpc';

interface Member {
	rpc: RpcHelper<Record<string, never>, RewriteBound>;
	port: MessagePort;
	/** rewrites sent and not yet answered */
	busy: number;
	/** the characters of script those rewrites hold */
	load: number;
	alive: boolean;
	/** the worker said it serves this port (REWRITE_READY): until then nothing is sent */
	ready: boolean;
}

export class RewritePool {
	#members: Member[];
	#timeout: number;
	constructor(ports: MessagePort[], timeout: number) {
		this.#timeout = timeout;
		this.#members = ports.map((port) => {
			const member: Member = {
				port,
				busy: 0,
				load: 0,
				alive: true,
				ready: false,
				rpc: new RpcHelper<Record<string, never>, RewriteBound>(
					{},
					REWRITE_RPC,
					(data, transfer) => port.postMessage(data, transfer),
				),
			};
			port.addEventListener('message', (event) => {
				if (event.data?.[REWRITE_READY] === true) member.ready = true;
				else member.rpc.receive(event.data);
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
	}
	/** let every worker go (the controller was replaced or closed) */
	close() {
		for (const member of this.#members) this.#drop(member, 'released');
	}
	/**
	 * The worker with the least script in hand, then the fewest scripts: a
	 * count alone sent two of a split bundle's 2.5 MB parts to one worker
	 * while another had two small ones
	 */
	#pick(): Member | undefined {
		let member: Member | undefined;
		for (const candidate of this.#members)
			if (
				candidate.alive &&
				candidate.ready &&
				(!member ||
					candidate.load < member.load ||
					(candidate.load === member.load && candidate.busy < member.busy))
			)
				member = candidate;
		return member;
	}
	/** a call to the worker with the least in hand (`size` characters more), null when none answered in time */
	async #call<K extends keyof RewriteBound>(
		method: K,
		request: RewriteBound[K][0],
		size: number,
	): Promise<RewriteBound[K][1] | null> {
		const member = this.#pick();
		if (!member) return null;
		member.busy++;
		member.load += size;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				member.rpc.call(method, request),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						this.#drop(member, `took over ${this.#timeout} ms`);
						reject(new Error('rewrite worker timed out'));
					}, this.#timeout);
				}),
			]);
		} catch (error) {
			return null;
		} finally {
			clearTimeout(timer);
			member.busy--;
			member.load -= size;
		}
	}
	async #rewriteOne(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
		source?: ScriptSource,
		preamble?: string,
		told?: RewrittenBy,
	): Promise<string | null> {
		const answer = await this.#call(
			'rewrite',
			{
				script,
				url: url.toString(),
				directory: url.directory,
				codecKey: url.codec.key,
				config,
				type,
				scopes: routeScopeList(),
				...(source === undefined ? {} : { source }),
				...(preamble ? { preamble } : {}),
			},
			script.length,
		);
		// the worker says the wasm module rewrote it (the only backend)
		if (answer === null || typeof answer === 'string') return answer;
		if (told) told.by = answer.by;
		return answer.output;
	}
	/**
	 * A document's inline script, rewritten by the worker with the least in
	 * hand (with its preamble). Null when none is ready or answered in time.
	 */
	async rewriteInline(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
		preamble: string,
	): Promise<string | null> {
		return this.#rewriteOne(script, url, config, type, undefined, preamble);
	}
	/**
	 * The script rewritten by a worker, or null when the caller must rewrite
	 * it itself (none is ready or answered in time). `told` is which backend
	 * rewrote it: always the wasm module. The wasm rewriter takes even a 12 MB
	 * bundle whole faster than the old split's plan alone, so nothing is split.
	 */
	async rewrite(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
		told?: RewrittenBy,
	): Promise<string | null> {
		return this.#rewriteOne(
			script,
			url,
			config,
			type,
			undefined,
			undefined,
			told,
		);
	}
}
