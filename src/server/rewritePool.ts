// The service worker's side of the controller's rewrite workers: a port to
// each, a script sent to the one with the least in hand. A rewrite comes
// back from a worker or not at all: null tells the caller to make it
// itself, which it does whenever no worker is ready (the controller started
// none, a worker has not started yet or failed to load, its port closed
// with the page or a crash) or the worker took longer than the timeout. A
// port that closed or timed out is not used again.
import type { Config } from '../config';
import { minified, ScriptSource, ScriptType } from '../rewriteJS';
import { REWRITE_READY, REWRITE_RPC, RewriteBound } from '../rewriteMessages';
import { routeScopeList } from '../routeURL';
import { SPLIT_MIN, splitSources, stitch } from '../splitRewrite';
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
	#rewriteOne(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
		compact?: boolean,
		source?: ScriptSource,
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
				...(source === undefined ? {} : { source }),
			},
			script.length,
		);
	}
	/**
	 * A large webpack or Closure bundle rewritten by every live worker at
	 * once (splitRewrite): one plans the split, then the skeleton and each
	 * group go, the largest first, to the one with the least in hand. Null
	 * when it is not split (not a page's classic script, too small, not
	 * minified, fewer than two workers,
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
		);
		if (!plan) return null;
		const { skeleton, parts, skeletonSource, partSources } = splitSources(
			script,
			plan,
		);
		// the largest first, each to the worker with the least in hand, so
		// the work evens out across them
		const texts = [skeleton, ...parts];
		const outputs: (string | null)[] = new Array(texts.length);
		await Promise.all(
			texts
				.map((text, i) => i)
				.sort((a, b) => texts[b]!.length - texts[a]!.length)
				.map(async (i) => {
					outputs[i] = await this.#rewriteOne(
						texts[i]!,
						url,
						config,
						type,
						true,
						i === 0 ? skeletonSource : partSources[i - 1],
					);
				}),
		);
		if (outputs.some((output) => output === null)) return null;
		// a run of statements the rewriter could not parse on its own comes
		// back as it went (the rewriter's fallback), which would put code
		// that was never rewritten into the whole: the whole is rewritten
		// instead (a rewritten run never equals its input, whose wrapper has
		// line breaks the compact output does not)
		if (
			plan.kind === 'statements' &&
			parts.some((part, i) => outputs[i + 1] === part)
		)
			return null;
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
