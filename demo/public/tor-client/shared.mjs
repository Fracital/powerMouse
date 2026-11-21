// The SharedWorker every tab's Tor transport shares
// (TransportDescriptor.sharedWorker, main.js): one Tor client for all tabs
// of the origin, so a second tab bootstraps nothing, its circuits are the
// same client's (isolated per site as in one tab) and one client holds the
// guard state. Each tab's transport (transport.mjs, remote.mjs) asks over
// its port, and each Tor stream goes on a port of its own (streamPort.mjs).
import { TorService } from './service.mjs';
import { serveStream } from './streamPort.mjs';

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
		else if (data?.type === 'connect') {
			const { stream } = data;
			service
				.connect(String(data.host), Number(data.port), String(data.site))
				.then(
					(opened) => {
						stream.postMessage({ type: 'open' });
						serveStream(opened, stream);
					},
					(error) => {
						stream.postMessage({ type: 'error', message: message(error) });
						stream.close();
					},
				);
		} else if (data?.type === 'newIdentity') service.newIdentity();
		else if (data?.type === 'newCircuit' && typeof data.url === 'string')
			service.newCircuitFor(data.url);
		else if (data?.type === 'bye') {
			entry.ports.delete(port);
			port.close();
		}
	};
});
