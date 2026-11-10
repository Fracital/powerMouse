// A test-only service worker standing in for a host application's own root
// worker (foreign-sw suite): it takes control of the pages under /test/ at
// once and, on activation and on request, posts to every client a message
// shaped like STomp's revive broadcast plus a plain one. It serves nothing.
const broadcast = async () => {
	const clients = await self.clients.matchAll({ includeUncontrolled: true });
	for (const client of clients) {
		client.postMessage({ $stomp$swRevive: { build: 'foreign' } });
		client.postMessage({ hello: 'from the host root worker' });
	}
};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
	event.waitUntil(self.clients.claim().then(broadcast)),
);
self.addEventListener('message', (event) => {
	if (event.data === 'broadcast') event.waitUntil(broadcast());
});
