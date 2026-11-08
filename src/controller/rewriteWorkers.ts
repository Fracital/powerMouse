import { REWRITE_PORT } from '../transport/messages';

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
			});
			this.#workers.push(worker);
		}
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
