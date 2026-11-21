// The SharedWorker every tab's Tor transport shares
// (TransportDescriptor.sharedWorker, main.js): one Tor client for all tabs
// of the origin, so a second tab bootstraps nothing, its circuits are the
// same client's (isolated per site as in one tab) and one client holds the
// guard state. Each tab's transport (transport.mjs, remote.mjs) asks over
// its port; a response's body comes back on a port of its own, a chunk for
// each pull.
import { TorService } from './service.mjs';

/** `${wisp} ${storageName}`: the client and the ports it tells */
const services = new Map();

function serviceFor({ wisp, storageName }) {
	const key = `${wisp} ${storageName ?? ''}`;
	let entry = services.get(key);
	if (!entry) {
		const ports = new Set();
		const service = new TorService({
			wisp,
			storageName,
			// a tab's transport worker prints them too, where its page's
			// console (and the smoke) sees them
			say: (level, text) => {
				console[level](text);
				for (const port of ports)
					port.postMessage({ type: 'say', level, text });
			},
		});
		service.onStatus((status) => {
			for (const port of ports) port.postMessage({ type: 'status', status });
		});
		services.set(key, (entry = { service, ports }));
	}
	return entry;
}

const message = (error) => String(error?.message ?? error);

/** answer one fetch on its own port: the head, then a chunk at each pull */
function serveFetch(service, { url, init, site, reply }) {
	const abort = new AbortController();
	let reader = null;
	const done = () => {
		reply.onmessage = null;
		reply.close();
	};
	const fail = (error) => {
		reply.postMessage({ type: 'error', message: message(error) });
		done();
	};
	const pull = async () => {
		try {
			const { done: ended, value } = await reader.read();
			if (ended) {
				reply.postMessage({ type: 'end' });
				done();
				return;
			}
			// a copy: the chunk may be a view of the wasm's memory, which
			// cannot be transferred
			const chunk = value.slice();
			reply.postMessage({ type: 'chunk', chunk }, [chunk.buffer]);
		} catch (error) {
			fail(error);
		}
	};
	reply.onmessage = ({ data }) => {
		if (data?.type === 'pull' && reader) pull();
		else if (data?.type === 'cancel') {
			abort.abort(new Error('the request was cancelled'));
			reader?.cancel().catch(() => {});
			done();
		}
	};
	service.fetch(url, init, site, abort.signal).then(
		({ status, statusText, headers, body }) => {
			if (abort.signal.aborted) {
				body?.cancel().catch(() => {});
				return;
			}
			reader = body?.getReader() ?? null;
			reply.postMessage({
				type: 'head',
				status,
				statusText,
				headers,
				body: !!reader,
			});
			if (!reader) done();
		},
		(error) => {
			if (!abort.signal.aborted) fail(error);
		},
	);
}

self.addEventListener('connect', ({ ports: [port] }) => {
	let entry = null;
	const answer = (id, settled) =>
		settled.then(
			() => port.postMessage({ type: 'done', id }),
			(error) => port.postMessage({ type: 'done', id, error: message(error) }),
		);
	port.onmessage = ({ data }) => {
		if (data?.type === 'hello') {
			entry = serviceFor(data);
			entry.ports.add(port);
			port.postMessage({ type: 'status', status: entry.service.status });
			return;
		}
		if (!entry) return;
		const { service } = entry;
		if (data?.type === 'init') answer(data.id, service.init());
		else if (data?.type === 'admit')
			answer(data.id, service.admit(String(data.target)));
		else if (data?.type === 'fetch') serveFetch(service, data);
		else if (data?.type === 'newIdentity') service.newIdentity();
		else if (data?.type === 'newCircuit' && typeof data.url === 'string')
			service.newCircuitFor(data.url);
		else if (data?.type === 'bye') {
			entry.ports.delete(port);
			port.close();
		}
	};
});
