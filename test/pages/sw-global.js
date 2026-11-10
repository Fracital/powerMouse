// The global fixture's worker (sw-global.html): what its global holds, as
// a service worker's own code can see it, put in a cache for the page.
const CLASSES = [
	'ServiceWorker',
	'ServiceWorkerGlobalScope',
	'ServiceWorkerRegistration',
	'Client',
	'WindowClient',
	'Clients',
	'ExtendableEvent',
	'ExtendableMessageEvent',
	'InstallEvent',
	'FetchEvent',
	'NavigationPreloadManager',
	'PushManager',
	'PushEvent',
	'NotificationEvent',
	'SyncEvent',
	'CookieStore',
	'CookieStoreManager',
	'ExtendableCookieChangeEvent',
];
const EVENTS = [
	'ExtendableEvent',
	'ExtendableMessageEvent',
	'InstallEvent',
	'FetchEvent',
];
const shape = async () => {
	const report = {
		names: Object.getOwnPropertyNames(self).sort(),
		prototypes: {},
		sources: {},
		calls: {},
		objectURL: [typeof URL.createObjectURL, typeof URL.revokeObjectURL],
		registration: Object.getOwnPropertyNames(
			Object.getPrototypeOf(registration),
		),
		cookies: null,
	};
	for (const name of CLASSES) {
		const ctor = self[name];
		if (typeof ctor !== 'function') continue;
		const descriptor = Object.getOwnPropertyDescriptor(ctor, 'prototype');
		report.prototypes[name] = descriptor
			? [descriptor.writable, descriptor.enumerable, descriptor.configurable]
			: null;
		report.sources[name] = Function.prototype.toString.call(ctor);
	}
	for (const name of EVENTS) {
		try {
			self[name]('x');
			report.calls[name] = 'no throw';
		} catch (error) {
			report.calls[name] = `${error.name}: ${error.message}`;
		}
	}
	if (self.cookieStore) {
		try {
			report.cookies = (await cookieStore.getAll()).map((c) => c.name).sort();
		} catch (error) {
			report.cookies = `${error.name}: ${error.message}`;
		}
	}
	return report;
};
self.addEventListener('install', (event) =>
	event.waitUntil(
		shape().then((report) =>
			caches
				.open('swg')
				.then((cache) =>
					cache.put('report', new Response(JSON.stringify(report))),
				),
		),
	),
);
