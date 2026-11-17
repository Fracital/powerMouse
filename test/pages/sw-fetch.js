// The fetch fixture's worker (sw-fetch.html): answers some requests itself
// (a body, a script, a redirect, a stream, an image, an echo of a POST, a
// network error, a value that is no Response), passes one to the network
// with fetch(event.request), leaves the rest alone, and remembers how each
// request looked to it. Three streams keep their chunks (one chunk, several
// at once, and a response it cloned, whose twin it reads only later): what
// the browser read of them leaves them as they were.
const seen = {};
const kept = {};
const encoded = (...parts) =>
	parts.map((part) => new TextEncoder().encode(part));
const streamOf = (chunks) =>
	new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
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
		case 'kept-one':
			kept.one = encoded('one');
			event.respondWith(new Response(streamOf(kept.one)));
			break;
		case 'kept-many':
			kept.many = encoded('a', 'bb', 'ccc');
			event.respondWith(new Response(streamOf(kept.many)));
			break;
		case 'kept-twin': {
			const original = new Response(streamOf(encoded('x', 'yy', 'zzz')));
			kept.twin = original.clone();
			event.respondWith(original);
			break;
		}
		case 'kept-check':
			event.respondWith(
				(async () =>
					new Response(
						JSON.stringify({
							one: kept.one?.map((chunk) => chunk.byteLength),
							many: kept.many?.map((chunk) => chunk.byteLength),
							twin: await kept.twin?.text(),
						}),
					))(),
			);
			break;
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
