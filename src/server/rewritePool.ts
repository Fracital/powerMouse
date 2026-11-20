// The service worker's side of the controller's rewrite workers: a port to
// each, a script sent to the one with the least in hand. A rewrite comes
// back from a worker or not at all: null tells the caller to make it
// itself, which it does whenever no worker is ready (the controller started
// none, a worker has not started yet or failed to load, its port closed
// with the page or a crash) or the worker took longer than the timeout. A
// port that closed or timed out is not used again.
import type { Config } from '../config';
import type { PackedRewrite } from '../prewrite';
import {
	RewrittenBy,
	SCRIPT_FILE,
	ScriptSource,
	ScriptType,
} from '../rewriteJS';
import {
	REWRITE_READY,
	REWRITE_RPC,
	RewriteBound,
	type EngineBuild,
} from '../rewriteMessages';
import { routeScopeList } from '../routeURL';
import type StompURL from '../StompURL';
import { RpcHelper } from '../transport/rpc';
import type { BodyBytes } from './bodyBytes';

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

/** how long the blocker's engine may take in a worker before the service worker compiles it itself */
const ENGINE_BUILD_WAIT_MS = 60_000;

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
	/**
	 * a call to the worker with the least in hand (`size` characters more),
	 * null when none answered in time; a worker that took longer than the
	 * rewrite timeout is let go, unless `wait` gives the call its own
	 */
	async #call<K extends keyof RewriteBound>(
		method: K,
		request: RewriteBound[K][0],
		size: number,
		wait?: number,
		transfer?: Transferable[],
	): Promise<RewriteBound[K][1] | null> {
		const member = this.#pick();
		if (!member) return null;
		member.busy++;
		member.load += size;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				member.rpc.call(method, request, transfer),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						if (wait === undefined)
							this.#drop(member, `took over ${this.#timeout} ms`);
						reject(new Error('rewrite worker timed out'));
					}, wait ?? this.#timeout);
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
				...(url.mark === undefined ? {} : { mark: url.mark }),
				...(source === undefined ? {} : { source }),
				...(preamble ? { preamble } : {}),
			},
			script.length,
		);
		// the worker says the wasm module rewrote it (the only backend)
		if (answer === null || typeof answer === 'string') return answer;
		if (told) {
			told.by = answer.by;
			if (answer.map) told.map = answer.map;
		}
		return answer.output;
	}
	/**
	 * The script whose UTF-8 bytes `body` holds, rewritten by a worker from
	 * its bytes (src/wasm/rewriteBytes.ts): a Blob of its output's bytes,
	 * or the output as text where the worker made it of the decoded text;
	 * null when the caller must rewrite it itself. The bytes are handed
	 * over (BodyBytes.handOver): the caller has them again of `body` when
	 * no worker answers.
	 */
	rewriteBytes(
		body: BodyBytes,
		url: StompURL,
		config: Config,
		type: ScriptType,
		/** code to run first, after the worker's bootstrap (modifyJS's) */
		preamble?: string,
	): Promise<Blob | string | null> {
		const bytes = body.handOver();
		return this.#call(
			'rewriteBytes',
			{
				bytes,
				url: url.toString(),
				directory: url.directory,
				codecKey: url.codec.key,
				config,
				type,
				scopes: routeScopeList(),
				...(url.mark === undefined ? {} : { mark: url.mark }),
				...(preamble ? { preamble } : {}),
			},
			body.size,
			undefined,
			[bytes],
		);
	}
	/**
	 * The content blocker's engine compiled by the worker with the least in
	 * hand (src/blocker/build.ts), which counts the lists' text as its load
	 * so scripts go to the others meanwhile. Null when none is ready, the
	 * module refused the lists or no answer came in ENGINE_BUILD_WAIT_MS:
	 * the caller compiles it itself. The worker is kept either way.
	 */
	async buildEngine(
		build: EngineBuild,
	): Promise<Uint8Array<ArrayBuffer> | null> {
		const size = build.lists.reduce((sum, list) => sum + list.text.length, 0);
		const engine = await this.#call(
			'buildEngine',
			build,
			size,
			ENGINE_BUILD_WAIT_MS,
		);
		return engine ? new Uint8Array(engine) : null;
	}
	/**
	 * A document's inline script, rewritten by the worker with the least in
	 * hand (with its preamble). Null when none is ready or answered in time.
	 * `told` has the map of the output the rewrite handed over apart
	 * (src/prewrite.ts).
	 */
	async rewriteInline(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
		preamble: string,
		told?: RewrittenBy,
	): Promise<string | null> {
		return this.#rewriteOne(
			script,
			url,
			config,
			type,
			{ apart: true },
			preamble,
			told,
		);
	}
	/**
	 * A document's inline script, rewritten with its preamble (a classic
	 * one's) and packed for the table (packRewrite under the access helper
	 * `access`) by the worker with the least in hand: the worker makes the
	 * preamble and cuts it and the holder out, so this thread never copies,
	 * hashes or compares the script's text and its rewrite (CNN's 2.46 MB
	 * inline script and its 7.9 MB rewrite held it 60 ms). Null when none is
	 * ready or answered in time, or the rewrite is the script as written.
	 */
	async packInline(
		script: string,
		url: StompURL,
		config: Config,
		type: ScriptType,
		access: string,
		told?: RewrittenBy,
	): Promise<PackedRewrite | null> {
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
				...(url.mark === undefined ? {} : { mark: url.mark }),
				source: { apart: true },
				pack: access,
			},
			script.length,
		);
		// (unpacked: the rewrite is the script as written, or a worker of an
		// older bundle made it without the preamble it was not sent; the page
		// rewrites it then)
		if (answer === null || typeof answer === 'string' || !answer.packed)
			return null;
		if (told) {
			told.by = answer.by;
			if (answer.map) told.map = answer.map;
		}
		return [answer.output, ...answer.packed];
	}
	/**
	 * A handler of a document's markup (an onclick's text), rewritten by the
	 * worker with the least in hand as the client rewrites it (`preamble`,
	 * src/prewrite.ts handlerPreamble): the text is kept by the client, so
	 * the output holds no holder statement. Null when none is ready or
	 * answered in time; `told` has the map handed over apart.
	 */
	async rewriteHandler(
		script: string,
		url: StompURL,
		config: Config,
		preamble: string,
		told?: RewrittenBy,
	): Promise<string | null> {
		return this.#rewriteOne(
			script,
			url,
			config,
			'generic',
			{ apart: true, text: null },
			preamble,
			told,
		);
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
		/** code to run first, after the worker's bootstrap (modifyJS's) */
		preamble?: string,
	): Promise<string | null> {
		return this.#rewriteOne(
			script,
			url,
			config,
			type,
			SCRIPT_FILE,
			preamble,
			told,
		);
	}
}
