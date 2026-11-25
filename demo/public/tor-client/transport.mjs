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
		wasm,
		// the page's token of a new Tor session it began (TorService.newSession)
		session,
		// the server's directory snapshot, for a first visit (snapshot.mjs)
		bootstrap,
	} = {}) {
		if (typeof wisp !== 'string') throw new TypeError('wisp: a URL');
		this.#service =
			typeof MessagePort === 'function' && sharedWorker instanceof MessagePort
				? RemoteService.for(sharedWorker, {
						wisp,
						storageName,
						wasm,
						session,
						bootstrap,
					})
				: new TorService({ wisp, storageName, wasm, bootstrap });
		// the host page's channel to this transport (its status, New Identity,
		// New circuit for this site); none where the page is of another origin
		if (typeof channel === 'string' && typeof BroadcastChannel === 'function') {
			this.#channel = new BroadcastChannel(channel);
			this.#channel.onmessage = ({ data }) => this.#heard(data);
		}
		this.#service.onStatus((status) => {
			// the shared client started again (Forget Tor state in another
			// tab): the connections of the old one are gone with it
			if (status?.state === 'starting' && this.ready) {
				this.ready = false;
				for (const [site, entry] of [...this.#sites]) this.#forget(site, entry);
			}
			this.#tell();
		});
		// the shared client bootstraps at once, as Tor Browser does, not at
		// the first request: a transport the page hosts (offline.html's) is
		// asked nothing until a tab loads (a failure is the status's, and
		// the next request's). A client of the transport's own starts when
		// it is used (a transport made only to ask admit())
		if (this.#service instanceof RemoteService) this.init().catch(() => {});
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
		else if (data?.type === 'circuit' && typeof data.url === 'string')
			this.#service.circuitFor(data.url).then(
				(circuit) =>
					this.#channel?.postMessage({
						type: 'circuit',
						id: data.id,
						url: data.url,
						circuit,
					}),
				(error) =>
					this.#channel?.postMessage({
						type: 'circuit',
						id: data.id,
						url: data.url,
						error: String(error?.message ?? error),
					}),
			);
		else if (data?.type === 'forgetState')
			this.forgetState(String(data.id ?? '')).catch(() => {});
	}

	/**
	 * Forget Tor state (TorService.forgetState): the client's guards and
	 * directory forgotten and the client started again; no connection of
	 * before is used again. `token` names the page's ask, which each
	 * transport of the page hears: the client acts on it once.
	 */
	async forgetState(token = '') {
		for (const [site, entry] of [...this.#sites]) this.#forget(site, entry);
		this.ready = false;
		const done = await this.#service.forgetState(token);
		if (done) this.#channel?.postMessage({ type: 'forgotten', ...done });
		return done;
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
