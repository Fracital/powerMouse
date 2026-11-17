// The slots of the site pool (docs/site-pool.md, "Thin slots"): a
// slot's service worker builds no blocker engine of its own. The engine is
// the biggest thing a worker holds (the default lists compile to some 80 MB
// of the wasm instance's memory, and a cold build fetches 6 MB of lists and
// takes a second or two of a core), and every slot's worker would hold a
// copy. Its questions go over a MessagePort to the hub's worker, the host
// origin's, whose engine answers for every slot (serveBlocker); the hub's
// page hands that worker the port's other end. An answer that does not come
// in time is no verdict, as while an engine is still loading: the request
// goes on, and the port is asked for again.
import type { AdblockPage } from '../blocker/types';
import {
	scriptletKey,
	type Blocker,
	type BlockerLike,
	type BlockerRequest,
	type CosmeticResources,
	type Decision,
} from './blocker';

type BlockerOp =
	'state' | 'settled' | 'decide' | 'socket' | 'cosmetic' | 'csp' | 'classIds';

/** slot worker -> hub worker */
export interface BlockerCall {
	blocker: number;
	op: BlockerOp;
	args: unknown[];
}
/** hub worker -> slot worker */
export interface BlockerReply {
	blocker: number;
	result: unknown;
	/** the hub's engine answers */
	ready: boolean;
}

/** how long a question waits for the hub's worker */
const ASK_MS = 2000;
/** scriptlet rewrites kept, by their lines (as Blocker keeps them) */
const SCRIPT_MEMO = 64;

/** the hub worker's end: answer a slot's worker on `port` from the engine `blocker()` gives */
export function serveBlocker(
	port: MessagePort,
	blocker: () => Blocker | undefined,
) {
	port.addEventListener('message', async (event) => {
		const call = event.data as BlockerCall | null;
		if (typeof call !== 'object' || call === null || !Array.isArray(call.args))
			return;
		const engine = blocker();
		let result: unknown = null;
		try {
			if (engine) result = await answer(engine, call);
		} catch (error) {
			result = null;
		}
		const reply: BlockerReply = {
			blocker: call.blocker,
			result,
			ready: !!engine?.ready,
		};
		port.postMessage(reply);
	});
	port.start();
}

async function answer(engine: Blocker, { op, args }: BlockerCall) {
	const text = (index: number) => String(args[index] ?? '');
	switch (op) {
		case 'state':
			return engine.ready;
		case 'settled':
			return engine.settled(
				args[0] !== false,
				Math.min(Number(args[1]) || 0, 10000),
			);
		case 'decide':
			return engine.decide(args[0] as BlockerRequest);
		case 'socket':
			return engine.socket(
				text(0),
				text(1),
				args[2] === 'webtransport' ? 'webtransport' : undefined,
			);
		case 'cosmetic':
			return engine.ready ? engine.cosmeticResources(text(0)) : null;
		case 'csp':
			return engine.documentCsp(
				text(0),
				args[1] === null ? null : text(1),
				args[2] === undefined ? undefined : text(2),
			);
		case 'classIds':
			return engine.classIds(
				args[0] as string[],
				args[1] as string[],
				args[2] as string[],
			);
		default:
			return null;
	}
}

interface Pending {
	call: BlockerCall;
	resolve: (value: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * A slot's worker's blocker: the hub's engine, asked on the newest port its
 * controller handed it. `renew` asks the controller for another when the
 * port closed or an answer did not come (the hub's worker was stopped and
 * started again, which closes every port it held).
 */
export class RemoteBlocker implements BlockerLike {
	#port: MessagePort | null = null;
	#next = 0;
	#pending = new Map<number, Pending>();
	#ready = false;
	#renewing = false;
	#scripts = new Map<string, string>();
	lastError: string | null = null;
	readonly failed = false;
	renew?: () => Promise<MessagePort | null>;
	get ready(): boolean {
		return this.#ready;
	}
	bind(port: MessagePort) {
		this.#port?.close();
		this.#port = port;
		port.addEventListener('message', (event) => {
			const reply = event.data as BlockerReply | null;
			if (typeof reply !== 'object' || reply === null) return;
			this.#ready = reply.ready === true;
			const pending = this.#pending.get(reply.blocker);
			if (!pending) return;
			this.#pending.delete(reply.blocker);
			clearTimeout(pending.timer);
			pending.resolve(reply.result);
		});
		port.addEventListener('close', () => {
			if (this.#port === port) this.#lost();
		});
		port.start();
		for (const { call } of this.#pending.values()) port.postMessage(call);
		void this.#ask('state', []);
	}
	#lost() {
		this.#ready = false;
		if (this.#renewing || !this.renew) return;
		this.#renewing = true;
		this.renew()
			.then((port) => {
				if (port) this.bind(port);
			})
			.catch(() => {})
			.finally(() => (this.#renewing = false));
	}
	#ask(op: BlockerOp, args: unknown[], ms = ASK_MS): Promise<unknown> {
		return new Promise((resolve) => {
			const call: BlockerCall = { blocker: this.#next++, op, args };
			const timer = setTimeout(() => {
				if (!this.#pending.delete(call.blocker)) return;
				this.lastError = 'the hub worker did not answer';
				resolve(null);
				this.#lost();
			}, ms);
			this.#pending.set(call.blocker, { call, resolve, timer });
			this.#port?.postMessage(call);
		});
	}
	async settled(build = true, ms = 5000): Promise<boolean> {
		if (this.#ready) return true;
		return (await this.#ask('settled', [build, ms], ms + ASK_MS)) === true;
	}
	async decide(request: BlockerRequest): Promise<Decision | null> {
		return ((await this.#ask('decide', [request])) as Decision | null) ?? null;
	}
	async socket(
		url: string,
		source: string,
		type?: 'webtransport',
	): Promise<boolean> {
		return (await this.#ask('socket', [url, source, type])) === true;
	}
	async cosmetic(
		url: string,
		rewrite: (script: string) => string,
	): Promise<AdblockPage | null> {
		const resources = (await this.#ask('cosmetic', [
			url,
		])) as CosmeticResources | null;
		if (!resources) return null;
		let script = '';
		if (resources.injected_script) {
			const key = scriptletKey(resources.injected_script);
			const memo = this.#scripts.get(key);
			if (memo !== undefined) script = memo;
			else {
				try {
					script = rewrite(resources.injected_script);
				} catch (error) {
					console.warn('Stomp: the scriptlets could not be rewritten', error);
					script = '';
				}
				if (this.#scripts.size >= SCRIPT_MEMO)
					this.#scripts.delete(this.#scripts.keys().next().value!);
				this.#scripts.set(key, script);
			}
		}
		return {
			hide: resources.hide_selectors,
			procedural: resources.procedural_actions,
			exceptions: resources.exceptions,
			script,
			generichide: resources.generichide,
		};
	}
	async documentCsp(
		url: string,
		top: string | null,
		sealer?: string,
	): Promise<string | null> {
		return (
			((await this.#ask('csp', [url, top, sealer])) as string | null) ?? null
		);
	}
	async classIds(
		classes: string[],
		ids: string[],
		exceptions: string[],
	): Promise<string[]> {
		const answer = await this.#ask('classIds', [classes, ids, exceptions]);
		return Array.isArray(answer) ? (answer as string[]) : [];
	}
}
