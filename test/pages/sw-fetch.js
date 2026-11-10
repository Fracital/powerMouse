// The fetch fixture's worker (sw-fetch.html): answers some requests itself
// (a body, a script, a redirect, a stream, an image, an echo of a POST, a
// network error, a value that is no Response), passes one to the network
// with fetch(event.request), leaves the rest alone, and remembers how each
// request looked to it.
const seen = {};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	const name = url.pathname.split('/').pop();
	seen[name + url.search] = {
		mode: request.mode,
		destination: request.destination,
		credentials: request.credentials,
		method: request.method,
		redirect: request.redirect,
		referrer: request.referrer,
		client: typeof event.clientId === 'string' && event.clientId.length > 0,
		resulting: event.resultingClientId,
	};
	switch (name) {
		case 'greeting':
			event.respondWith(
				new Response('hello from the worker', {
					headers: { 'x-from': 'worker', 'content-type': 'text/plain' },
				}),
			);
			break;
		case 'outside':
			event.respondWith(new Response('outside, from the worker'));
			break;
		case 'sw-script.js':
			event.respondWith(
				new Response('window.__script = location.href;', {
					headers: { 'content-type': 'text/javascript' },
				}),
			);
			break;
		case 'redirect':
			event.respondWith(Response.redirect('sw-fetch-target.txt', 302));
			break;
		case 'stream': {
			const parts = ['a', 'b', 'c'];
			event.respondWith(
				new Response(
					new ReadableStream({
						async pull(controller) {
							await new Promise((resolve) => setTimeout(resolve, 50));
							const part = parts.shift();
							if (part === undefined) controller.close();
							else controller.enqueue(new TextEncoder().encode(part));
						},
					}),
				),
			);
			break;
		}
		case 'sw-fetch-data.json':
			event.respondWith(fetch(request));
			break;
		case 'error':
			event.respondWith(Response.error());
			break;
		case 'notresponse':
			event.respondWith('not a response');
			break;
		case 'echo':
			event.respondWith(
				request.text().then(
					(text) =>
						new Response(
							JSON.stringify({
								method: request.method,
								text,
								custom: request.headers.get('x-custom'),
							}),
						),
				),
			);
			break;
		case 'sw-image.svg':
			event.respondWith(
				new Response(
					'<svg xmlns="http://www.w3.org/2000/svg" width="7" height="5"></svg>',
					{ headers: { 'content-type': 'image/svg+xml' } },
				),
			);
			break;
		case 'seen':
			event.respondWith(new Response(JSON.stringify(seen)));
			break;
	}
});
