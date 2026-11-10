// The lifecycle fixture's worker: a slow install, an activate that claims
// the page, and a record of what its global looks like.
const shape = () => ({
	self: String(self),
	instance: self instanceof ServiceWorkerGlobalScope,
	dedicated: typeof DedicatedWorkerGlobalScope,
	postMessage: typeof postMessage,
	close: typeof close,
	XMLHttpRequest: typeof XMLHttpRequest,
	importScripts: typeof importScripts,
	clients: String(clients),
	skipWaiting: typeof skipWaiting,
	oninstall: 'oninstall' in self,
	onfetch: self.onfetch,
	location: location.href,
	scope: registration.scope,
	state: serviceWorker.state,
	scriptURL: serviceWorker.scriptURL,
	mine: registration.installing === serviceWorker,
	events: [
		typeof ExtendableEvent,
		typeof FetchEvent,
		typeof ExtendableMessageEvent,
		typeof Clients,
		typeof WindowClient,
	],
	extendable: new ExtendableEvent('x') instanceof Event,
	source: String(skipWaiting),
});
self.addEventListener('install', (event) => {
	const seen = shape();
	event.waitUntil(
		caches
			.open('swl-shape')
			.then((cache) => cache.put('shape', new Response(JSON.stringify(seen))))
			.then(() => new Promise((resolve) => setTimeout(resolve, 100))),
	);
});
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
