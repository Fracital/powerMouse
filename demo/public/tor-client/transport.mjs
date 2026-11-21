// The in-browser Tor client's transport (docs/tor-over-wisp.md), Tor mode
// wherever STOMP_CONFIG.torClient. The client itself (service.mjs: arti
// through tor-js, the Wisp streams to Tor relays alone) runs once for every
// tab of the origin in the SharedWorker the controller gives this
// transport a port to (`sharedWorker`, shared.mjs), or in this transport
// worker where there is none (Chrome on Android).
//
// Epoxy runs on Tor streams (TorClient.connect, the Fracital build of
// tor-js: deploy/tor-js): an epoxy client for each top-level site, its
// function transport a Wisp server here (wispServer.mjs) whose every
// CONNECT is a Tor stream on that site's circuits, so connections are
// pooled and kept per site, HTTP/2 and WebSockets work, and the site's TLS
// is epoxy's (Chrome's ClientHello).
import Epoxy from '../epoxy/index.mjs';
import { RemoteService } from './remote.mjs';
import { siteMatches, TorService } from './service.mjs';
import { wispServer } from './wispServer.mjs';

const NETWORK_PARTITION = '$stomp$network';
// sites with an epoxy client kept (and its connections); the least lately
// used goes beyond that
const MAX_SITES = 32;

/** the request's top-level site (its circuits' key) and its other fields */
function siteOf(headers) {
	let site = 'opaque';
	const rest = [];
	const pairs = Array.isArray(headers)
		? headers
		: Object.entries(headers ?? {});
	for (const [name, value] of pairs)
		if (name.toLowerCase() === NETWORK_PARTITION)
			site = String(value).split(' ')[0] || 'opaque';
		else rest.push([name, value]);
	return { site, rest };
}

export default class TorClientTransport {
	ready = false;
	// the service worker's top-level site for each request, the key of its
	// circuits (docs/tor-over-wisp.md "Per-site circuits"); never sent. On
	// Tor streams, what epoxy reads too (it keeps its pools per partition)
	fieldSupport = {
		acceptEncoding: 'gzip, deflate, br, zstd',
		priority: true,
		partition: NETWORK_PARTITION,
		httpVersion: true,
		timing: true,
	};
	#service;
	#channel = null;
	/** site: its epoxy client over Tor streams on its circuits */
	#sites = new Map();

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

	/** site's epoxy client, made on its first request */
	#epoxyFor(site) {
		let entry = this.#sites.get(site);
		if (entry) {
			// the most lately used last
			this.#sites.delete(site);
			this.#sites.set(site, entry);
			return entry;
		}
		const wisp = wispServer((host, port) =>
			this.#service.connect(host, port, site),
		);
		const epoxy = new Epoxy({ wisp });
		entry = { epoxy, wisp, ready: epoxy.init() };
		entry.ready.catch(() => this.#forget(site, entry));
		this.#sites.set(site, entry);
		for (const [old, kept] of this.#sites) {
			if (this.#sites.size <= MAX_SITES) break;
			this.#forget(old, kept);
		}
		return entry;
	}

	/** site's epoxy client and its connections (on the circuits it had) gone */
	#forget(site, entry) {
		if (this.#sites.get(site) !== entry) return;
		this.#sites.delete(site);
		entry.wisp.close();
	}

	/**
	 * New circuit for the site of `url` (the tab's address): its next
	 * request builds one, on a connection of its own
	 */
	newCircuitFor(url) {
		this.#service.newCircuitFor(url);
		for (const [site, entry] of [...this.#sites])
			if (siteMatches(site, url)) this.#forget(site, entry);
	}

	/** New Identity: no circuit of before is used again, in any tab */
	newIdentity() {
		this.#service.newIdentity();
		for (const [site, entry] of [...this.#sites]) this.#forget(site, entry);
	}

	async request(remote, method, body, headers, signal) {
		if (!this.ready) await this.init();
		const { site } = siteOf(headers);
		const { epoxy, ready } = this.#epoxyFor(site);
		await ready;
		return epoxy
			.request(remote, method, body, headers, signal)
			.catch((error) => {
				// the console's own record of which origin failed (epoxy's
				// error names none)
				if (!signal?.aborted)
					console.warn(`[tor] ${method} ${remote.origin} failed`);
				throw error;
			});
	}

	connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
		const { site, rest } = siteOf(headers);
		// epoxy's connect needs its client made: a socket asked before
		// sends and closes once it is
		const opened = (async () => {
			if (!this.ready) await this.init();
			const { epoxy, ready } = this.#epoxyFor(site);
			await ready;
			return epoxy.connect(
				url,
				protocols,
				rest,
				onopen,
				onmessage,
				onclose,
				onerror,
			);
		})();
		opened.catch((error) => {
			onerror(String(error?.message ?? error));
			onclose(1006, '');
		});
		return [
			async (data) => (await opened)[0](data),
			async (code, reason) => (await opened)[1](code, reason),
		];
	}
}
