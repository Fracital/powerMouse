// the service worker of worker-rewrites-sw.html: what it evaluates for a
// message
const made = (self.__made = {});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('message', (event) => {
	const fn = new Function('/* kept */ return [location.href, typeof top];');
	made.service = fn;
	event.source.postMessage([String(fn), fn(), (0, eval)('location.pathname')]);
});
