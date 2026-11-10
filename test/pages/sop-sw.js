// The sop-escapes suite's service worker (sop-sw.html): a request's `sw`
// parameter says what it does with it, so each case shows how the
// same-origin policy treats what a service worker answers and what it
// fetches itself (`target` names the URL it fetches)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	const action = url.searchParams.get('sw');
	const target = url.searchParams.get('target');
	switch (action) {
		// another origin's response fetched no-cors: opaque
		case 'opaque':
			event.respondWith(fetch(target, { mode: 'no-cors' }));
			break;
		// another origin's response fetched with CORS
		case 'cors':
			event.respondWith(fetch(target));
			break;
		// the worker's own read of another origin, its outcome as the body
		case 'own':
			event.respondWith(
				fetch(target).then(
					async (response) =>
						new Response(`${response.type} ${await response.text()}`),
					(error) => new Response(`${error.name}: ${error.message}`),
				),
			);
			break;
		// the page's request as it came
		case 'pass':
			event.respondWith(fetch(event.request));
			break;
		// another origin's responses kept in the worker's cache and read
		// back: what they read as there, as the body
		case 'cache':
			event.respondWith(
				(async () => {
					const cache = await caches.open('sop-sw');
					await cache.put('opaque', await fetch(target, { mode: 'no-cors' }));
					await cache.put('cors', await fetch(`${target}&acao=*`));
					const opaque = await cache.match('opaque');
					const cors = await cache.match('cors');
					return new Response(
						JSON.stringify({
							opaque: [opaque.type, opaque.status, await opaque.text()],
							cors: [cors.type, cors.status, await cors.text()],
						}),
					);
				})(),
			);
			break;
		// a body the worker makes
		case 'made':
			event.respondWith(
				new Response('made by the worker', {
					headers: { 'x-made': '1' },
				}),
			);
			break;
		default:
			break;
	}
});
