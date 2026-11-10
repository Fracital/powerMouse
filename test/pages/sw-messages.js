// The messaging fixture's worker (sw-messages.html): answers a ping to its
// sender and to every client, answers on a port it was handed, describes
// its clients, and tries to open a window.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('message', (event) => {
	const { data, source } = event;
	const about = {
		event: event.constructor.name,
		extendable: event instanceof ExtendableEvent,
		origin: event.origin,
		source: source && source.constructor.name,
		window: source instanceof WindowClient,
		url: source && source.url,
		type: source && source.type,
		frameType: source && source.frameType,
		ports: event.ports.length,
	};
	if (data.kind === 'ping') {
		source.postMessage({ pong: data.n, about });
		event.waitUntil(
			clients
				.matchAll()
				.then((list) =>
					list.forEach((client) =>
						client.postMessage({ broadcast: list.length }),
					),
				),
		);
	}
	if (data.kind === 'port') event.ports[0].postMessage({ fromPort: true });
	if (data.kind === 'clients')
		event.waitUntil(
			(async () => {
				const all = await clients.matchAll({ includeUncontrolled: true });
				const workers = await clients.matchAll({ type: 'worker' });
				const own = await clients.get(source.id);
				const missing = await clients.get('no-such-client');
				source.postMessage({
					all: all.length,
					workers: workers.length,
					same: !!own && own.id === source.id,
					url: own && own.url,
					type: own && own.type,
					constructor: own && own.constructor.name,
					visibility: own && own.visibilityState,
					missing: String(missing),
				});
			})(),
		);
	if (data.kind === 'open')
		event.waitUntil(
			clients
				.openWindow('/elsewhere')
				.then(
					() => 'opened',
					(error) => `${error.name}: ${error.message}`,
				)
				.then((open) => source.postMessage({ open })),
		);
	if (data.kind === 'late')
		// after waitUntil can no longer be called
		setTimeout(() => {
			try {
				event.waitUntil(Promise.resolve());
				source.postMessage({ late: 'allowed' });
			} catch (error) {
				source.postMessage({ late: error.name });
			}
		}, 0);
});
