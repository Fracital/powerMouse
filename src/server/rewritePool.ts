// The service worker's side of the controller's rewrite workers: a port to
// each, a script sent to the one with the fewest in hand. A rewrite comes
// back from a worker or not at all: null tells the caller to make it
// itself, which it does whenever no worker is ready (the controller started
// none, a worker has not started yet or failed to load, its port closed
// with the page or a crash) or the worker took longer than the timeout. A
// port that closed or timed out is not used again.
import type { Config } from '../config';
import type { ScriptType } from '../rewriteJS';
import { REWRITE_READY, REWRITE_RPC, RewriteBound } from '../rewriteMessages';
import { routeScopeList } from '../routeURL';
import type StompURL from '../StompURL';
import { RpcHelper } from '../transport/rpc';

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
	/** the script rewritten by a worker, or null when the caller must rewrite it itself */
	async rewrite(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
	): Promise<string | null> {
		let member: Member | undefined;
		for (const candidate of this.#members)
			if (
				candidate.alive &&
				candidate.ready &&
				(!member || candidate.busy < member.busy)
			)
				member = candidate;
		if (!member) return null;
		member.busy++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				member.rpc.call('rewrite', {
					script,
					url: url.toString(),
					directory: url.directory,
					codecKey: url.codec.key,
					config,
					type,
					scopes: routeScopeList(),
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						const late = member!;
						this.#drop(late, `took over ${this.#timeout} ms`);
						reject(new Error('rewrite worker timed out'));
					}, this.#timeout);
				}),
			]);
		} catch (error) {
			return null;
		} finally {
			clearTimeout(timer);
			member.busy--;
		}
	}
}
