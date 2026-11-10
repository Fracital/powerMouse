// The slow fixture's worker (sw-slow.html): a respondWith whose promise
// never settles, then a handler that keeps the worker busy for a minute.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('fetch', (event) => {
	const { search } = new URL(event.request.url);
	if (search === '?hang') event.respondWith(new Promise(() => {}));
	if (search === '?busy') {
		const end = Date.now() + 60000;
		while (Date.now() < end);
	}
});
