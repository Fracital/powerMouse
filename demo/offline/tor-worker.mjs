// offline.html's Tor client (scripts/build-offline.mjs bundles this as a
// classic script, /tor-client/worker.js): what the served demo runs in its
// SharedWorker (demo/public/tor-client/shared.mjs), here in a dedicated
// worker the page starts (./host.mjs torOptions). Chrome starts no
// SharedWorker and no module worker of a blob: URL on file:, and a worker
// there fetches none of the page's blob: URLs, so arti's wasm comes
// compiled in the page's first message. Each port after it is a tab
// transport's, as a SharedWorker's connect event would bring it; the
// client's IndexedDB is the file: page's own, kept across visits.
import { useWasm } from '../public/tor-client/service.mjs';
import '../public/tor-client/shared.mjs';

self.addEventListener('message', ({ data, ports }) => {
	if (data?.type === 'wasm') useWasm(data.module);
	else if (data?.type === 'connect' && ports[0])
		self.dispatchEvent(new MessageEvent('connect', { ports: [ports[0]] }));
});
