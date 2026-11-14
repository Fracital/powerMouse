// packages/demo/public/sw.js verbatim: import the controller's service worker
// and forward whatever its router accepts.
importScripts('/controller/controller.sw.js');

addEventListener('fetch', (e) => {
	if ($ramjetController.shouldRoute(e)) {
		e.respondWith($ramjetController.route(e));
	}
});
