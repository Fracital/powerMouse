// The in-browser Tor client's transport (docs/tor-over-wisp.md), Tor mode
// wherever STOMP_CONFIG.torClient. The client itself (service.mjs: arti
// through tor-js, the Wisp streams to Tor relays alone) runs once for every
// tab of the origin in the SharedWorker the controller gives this
// transport a port to (`sharedWorker`, shared.mjs), or in this transport
// worker where there is none (Chrome on Android).
//
// A prototype: requests go through tor-js's own fetch (it has no stream API
// yet, so epoxy cannot run on a Tor stream), and WebSockets are refused.
import { RemoteService } from './remote.mjs';
import { TorService } from './service.mjs';

const NETWORK_PARTITION = '$stomp$network';

/** `body` as tor-js sends it (and a port carries it) */
async function sendable(body) {
	if (body === null || body === undefined) return undefined;
	if (typeof body === 'string') return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body))
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
	return new Uint8Array(await new Response(body).arrayBuffer());
}

export default class TorClientTransport {
	ready = false;
	// the service worker's top-level site for each request, the key of its
	// circuits (docs/tor-over-wisp.md "Per-site circuits"); never sent
	fieldSupport = { partition: NETWORK_PARTITION };
	#service;
	#channel = null;

	constructor({
		wisp,
		storageName = 'stomp-tor-client',
		channel,
		sharedWorker,
	} = {}) {
		if (typeof wisp !== 'string') throw new TypeError('wisp: a URL');
		this.#service =
			typeof MessagePort === 'function' && sharedWorker instanceof MessagePort
				? RemoteService.for(sharedWorker, { wisp, storageName })
				: new TorService({ wisp, storageName });
		// the host page's channel to this transport (its status, New Identity,
		// New circuit for this site); none where the page is of another origin
		if (typeof channel === 'string' && typeof BroadcastChannel === 'function') {
			this.#channel = new BroadcastChannel(channel);
			this.#channel.onmessage = ({ data }) => this.#heard(data);
		}
		this.#service.onStatus(() => this.#tell());
	}

	/** what bootstrap took and what it is doing, for the page and the smoke */
	get status() {
		return this.#service.status;
	}

	#heard(data) {
		if (data?.type === 'ask') this.#tell();
		else if (data?.type === 'newIdentity') this.newIdentity();
		else if (data?.type === 'newCircuit' && typeof data.url === 'string')
			this.newCircuitFor(data.url);
	}

	#tell() {
		this.#channel?.postMessage({ type: 'status', ...this.status });
	}

	/** refuse a link to anything that is not a Tor relay (service.mjs) */
	admit(target) {
		return this.#service.admit(target);
	}

	async init() {
		await this.#service.init();
		this.ready = true;
	}

	/** New circuit for the site of `url` (the tab's address) */
	newCircuitFor(url) {
		this.#service.newCircuitFor(url);
	}

	/** New Identity: no circuit of before is used again, in any tab */
	newIdentity() {
		this.#service.newIdentity();
	}

	async request(remote, method, body, headers, signal) {
		if (!this.ready) await this.init();
		let partition;
		const fields = {};
		for (const [name, value] of headers) {
			const lower = name.toLowerCase();
			if (lower === NETWORK_PARTITION) partition = value;
			else if (lower in fields)
				fields[lower] += `${lower === 'cookie' ? '; ' : ', '}${value}`;
			else fields[lower] = value;
		}
		const site = partition?.split(' ')[0] || 'opaque';
		const init = { method, headers: fields, body: await sendable(body) };
		const {
			status,
			statusText,
			headers: raw,
			body: answer,
		} = await this.#service.fetch(String(remote), init, site, signal);
		return {
			body: answer ?? new ArrayBuffer(0),
			headers: raw,
			status,
			statusText,
		};
	}

	// Tor mode refuses WebSockets for now (docs/tor-over-wisp.md "HTTPS, DNS
	// and what Tor mode refuses")
	connect(_url, _protocols, _headers, _onopen, _onmessage, onclose, onerror) {
		queueMicrotask(() => {
			onerror('WebSockets are not available in Tor mode');
			onclose(1006, '');
		});
		return [() => {}, () => {}];
	}
}
