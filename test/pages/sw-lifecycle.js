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
// what the registration's managers bring to the worker: a sync event, and
// a background fetch's end with its records
const note = (key, value) =>
	caches.open('swl-shape').then((cache) => cache.put(key, new Response(value)));
self.addEventListener('sync', (event) =>
	event.waitUntil(
		note(
			'synced',
			[event.tag, event.lastChance, event instanceof SyncEvent].join(' '),
		),
	),
);
const fetched = (event) =>
	event.waitUntil(
		(async () => {
			const records = await event.registration.matchAll();
			const response = await records[0].responseReady;
			await note(
				'fetched',
				[
					event.type,
					event.registration.id,
					event.registration.result,
					records.length,
					(await response.text()).trim(),
				].join(' '),
			);
		})(),
	);
self.addEventListener('backgroundfetchsuccess', fetched);
self.addEventListener('backgroundfetchfail', fetched);
