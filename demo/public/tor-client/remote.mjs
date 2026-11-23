// A tab's side of the shared Tor client (shared.mjs): the same calls as
// service.mjs's TorService, over the port the controller gave the
// transport (TransportDescriptor.sharedWorker). Where the SharedWorker does
// not answer in SHARED_ANSWER_MS (it could not start, its module failed),
// the tab runs a client of its own as it would with no SharedWorker.
import { TorService } from './service.mjs';
import { streamOverPort } from './streamPort.mjs';

const SHARED_ANSWER_MS = 15000;

/** one per port: a transport made again (RevivingTransport) gets the same */
const remotes = new WeakMap();

export class RemoteService {
	status = { state: 'starting', progress: 0, summary: 'Starting' };
	#port;
	#calls = new Map();
	#next = 1;
	#listeners = new Set();
	/** settles with null once the SharedWorker answered, or with the tab's own client */
	#settled;

	static for(port, options) {
		let remote = remotes.get(port);
		if (!remote) remotes.set(port, (remote = new RemoteService(port, options)));
		return remote;
	}

	constructor(port, { wisp, storageName, wasm, session }) {
		this.#port = port;
		let heard;
		const answered = new Promise((resolve) => (heard = resolve));
		port.onmessage = ({ data }) => {
			if (data?.type === 'status') {
				heard();
				this.#status(data.status);
			} else if (data?.type === 'say') console[data.level]?.(data.text);
			else if (data?.type === 'done') {
				const call = this.#calls.get(data.id);
				this.#calls.delete(data.id);
				if (data.error === undefined) call?.resolve(data.value);
				else call?.reject(new Error(data.error));
			}
		};
		// (a URL only: a compiled module does not reach a SharedWorker)
		port.postMessage({
			type: 'hello',
			wisp,
			storageName,
			...(typeof wasm === 'string' && { wasm }),
			...(typeof session === 'string' && { session }),
		});
		let timer;
		this.#settled = Promise.race([
			answered.then(() => null),
			new Promise((resolve) => {
				timer = setTimeout(() => {
					console.warn(
						'[tor] the shared Tor client did not answer: this tab runs its own',
					);
					const own = new TorService({ wisp, storageName, wasm });
					own.onStatus((status) => this.#status(status));
					resolve(own);
				}, SHARED_ANSWER_MS);
			}),
		]).finally(() => clearTimeout(timer));
	}

	#status(status) {
		this.status = status;
		for (const listener of this.#listeners) listener(status);
	}

	onStatus(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#call(type, extra = {}) {
		const id = this.#next++;
		return new Promise((resolve, reject) => {
			this.#calls.set(id, { resolve, reject });
			this.#port.postMessage({ type, id, ...extra });
		});
	}

	async init() {
		const own = await this.#settled;
		return own ? own.init() : this.#call('init');
	}

	async admit(target) {
		const own = await this.#settled;
		return own ? own.admit(target) : this.#call('admit', { target });
	}

	async newIdentity() {
		const own = await this.#settled;
		if (own) own.newIdentity();
		else this.#port.postMessage({ type: 'newIdentity' });
	}

	async newCircuitFor(url) {
		const own = await this.#settled;
		if (own) own.newCircuitFor(url);
		else this.#port.postMessage({ type: 'newCircuit', url });
	}

	async circuitFor(url) {
		const own = await this.#settled;
		return own ? own.circuitFor(url) : this.#call('circuit', { url });
	}

	async forgetState(token) {
		const own = await this.#settled;
		return own ? own.forgetState(token) : this.#call('forgetState', { token });
	}

	async connect(host, port, site) {
		const own = await this.#settled;
		if (own) return own.connect(host, port, site);
		const { port1, port2 } = new MessageChannel();
		return new Promise((resolve, reject) => {
			port1.onmessage = ({ data }) => {
				if (data?.type === 'open') resolve(streamOverPort(port1));
				else if (data?.type === 'error') {
					port1.close();
					reject(new Error(data.message));
				}
			};
			this.#port.postMessage(
				{ type: 'connect', host, port, site, stream: port2 },
				[port2],
			);
		});
	}
}
