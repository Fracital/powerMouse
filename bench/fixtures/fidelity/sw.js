// The service worker of workers.html, scope /fidelity/sw-scope/: answers
// every navigation in its scope with a page that reports what it saw.
self.addEventListener('install', function () {
	self.skipWaiting();
});
self.addEventListener('activate', function (event) {
	event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function (event) {
	var info = {
		url: event.request.url,
		mode: event.request.mode,
		dest: event.request.destination,
		swHref: self.location.href,
		scope: self.registration.scope,
	};
	if (event.request.url.indexOf('/sw-scope/page') < 0) return;
	event.respondWith(
		new Response(
			'<!doctype html><script>parent.postMessage({ fid: "sw-page", info: ' +
				JSON.stringify(JSON.stringify(info)) +
				', href: location.href, controlled: !!navigator.serviceWorker.controller }, "*")</' +
				'script>',
			{ headers: { 'Content-Type': 'text/html' } },
		),
	);
});
