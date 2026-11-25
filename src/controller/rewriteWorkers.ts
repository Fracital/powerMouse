import {
	REWRITE_MODULES,
	REWRITE_PORT,
	REWRITE_WARM_BLOCKER,
} from '../transport/messages';

/** rewrite workers when the host does not say: half the cores, one to four */
export function defaultRewriteWorkers(): number {
	const cores = navigator.hardwareConcurrency || 2;
	return Math.min(4, Math.max(1, Math.floor(cores / 2)));
}

/** how long the service worker waits for a rewrite worker's answer before rewriting itself, when the host does not say */
export const DEFAULT_REWRITE_TIMEOUT_MS = 10000;

/**
 * The controller's rewrite workers (dist/rewriteWorker.js,
 * src/rewriteWorker.ts): dedicated Workers that rewrite scripts for the
 * service worker, which cannot start a Worker itself. Each handshake hands
 * the service worker a fresh port to every one still running (a port
 * travels once; a restarted service worker shakes hands again). A worker
 * that fails to start or errors is let go; the service worker rewrites in
 * its own thread whenever no worker answers.
 */
export default class RewriteWorkers {
	#workers: Worker[] = [];
	/** the wasm modules each worker said it holds (src/wasm/thread.ts) */
	#held = new Map<Worker, string[]>();
	constructor(url: URL, size: number) {
		for (let i = 0; i < size; i++) {
			let worker: Worker;
			try {
				worker = new Worker(url);
			} catch (error) {
				console.warn('Stomp: a rewrite worker could not start', error);
				break;
			}
			worker.addEventListener('error', () => {
				worker.terminate();
				this.#workers = this.#workers.filter((other) => other !== worker);
				this.#held.delete(worker);
			});
			worker.addEventListener('message', (event) => {
				const held = event.data?.[REWRITE_MODULES];
				if (Array.isArray(held)) this.#held.set(worker, held);
			});
			this.#workers.push(worker);
		}
	}
	/**
	 * The compiled wasm modules, to every worker now (`rewriter: 'wasm'`). A
	 * dedicated worker shares this page's agent cluster, so the compiled
	 * module itself crosses and no worker compiles anything.
	 */
	adopt(modules: Record<string, WebAssembly.Module>) {
		for (const worker of this.#workers)
			worker.postMessage({ [REWRITE_MODULES]: modules });
	}
	/**
	 * The blocker's compiled module, to one worker to run on a small engine
	 * (src/blocker/warm.ts): never adopted as one of its modules, the
	 * blocker runs in the service worker alone
	 */
	warmBlocker(module: WebAssembly.Module) {
		this.#workers[0]?.postMessage({ [REWRITE_WARM_BLOCKER]: module });
	}
	/** the modules each running worker holds, as it last said */
	held(): string[][] {
		return this.#workers.map((worker) => this.#held.get(worker) ?? []);
	}
	/** how many workers are running */
	get size(): number {
		return this.#workers.length;
	}
	/**
	 * Hand each running worker one of `ports`, in order (the site pool: a
	 * slot's agent made the channels, its worker holds the other ends)
	 */
	servePorts(ports: MessagePort[]) {
		this.#workers.forEach((worker, i) => {
			const port = ports[i];
			if (port) worker.postMessage({ [REWRITE_PORT]: true }, [port]);
		});
		for (const port of ports.slice(this.#workers.length)) port.close();
	}
	/** a port to each running worker, for the service worker's end of a handshake */
	ports(): MessagePort[] {
		return this.#workers.map((worker) => {
			const channel = new MessageChannel();
			worker.postMessage({ [REWRITE_PORT]: true }, [channel.port1]);
			return channel.port2;
		});
	}
}
