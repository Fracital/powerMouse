// The cookie fixture's worker (sw-cookies.html): what its cookieStore
// answers, which `url` it may name, its registration's cookie change
// subscriptions, and the cookiechange events they bring.
const settle = async (call) => {
	try {
		const value = await call();
		return `ok ${JSON.stringify(value === undefined ? 'undefined' : value)}`;
	} catch (error) {
		return `${error.name}: ${error.message}`;
	}
};
const names = (list) =>
	list.map((cookie) => `${cookie.name}=${cookie.value} ${cookie.path}`).sort();
const events = [];
// Chrome weighs a cookie change against the registration's subscriptions
// when it tells the worker of it, a little after the write: a change made
// just before a subscription can arrive under it (natively h's set and d's
// deletion did, now and then, under the subscription to the whole scope).
// Changes arrive in the order they were made, so once a change to a cookie
// of the worker's own, subscribed to alone, has arrived, every earlier one
// has been weighed, against no subscription.
const FLUSH = 'swc_flush';
let flushed = () => {};
const flush = async () => {
	const subscription = [{ name: FLUSH, url: registration.scope }];
	const heard = new Promise((resolve) => (flushed = resolve));
	await registration.cookies.subscribe(subscription);
	await cookieStore.set(FLUSH, String(Date.now()));
	await Promise.race([
		heard,
		new Promise((resolve) => setTimeout(resolve, 5000)),
	]);
	await registration.cookies.unsubscribe(subscription);
};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('cookiechange', (event) => {
	if (event.changed.some((cookie) => cookie.name === FLUSH)) return flushed();
	events.push([
		event.constructor.name,
		event instanceof ExtendableCookieChangeEvent,
		event.changed.map((cookie) => [
			cookie.name,
			cookie.value,
			cookie.path,
			cookie.domain,
			cookie.secure,
			cookie.sameSite,
			cookie.expires,
			cookie.partitioned,
		]),
		event.deleted.map((cookie) => [
			cookie.name,
			cookie.path,
			Object.keys(cookie),
		]),
	]);
});
self.addEventListener('message', (event) =>
	event.waitUntil(
		(async () => {
			if (event.data === 'events') return event.source.postMessage(events);
			const scope = registration.scope;
			const report = {
				proto: Object.getOwnPropertyNames(CookieStore.prototype),
				onchange: 'onchange' in cookieStore,
				store: String(cookieStore),
				getAll: await settle(async () => names(await cookieStore.getAll())),
				script: await settle(async () =>
					names(await cookieStore.getAll({ url: location.href })),
				),
				relative: await settle(async () =>
					names(await cookieStore.getAll({ url: 'sw-cookies.js' })),
				),
				hash: await settle(async () =>
					names(await cookieStore.getAll({ url: `${location.href}#h` })),
				),
				query: await settle(async () =>
					names(await cookieStore.getAll({ url: `${location.href}?q` })),
				),
				scope: await settle(() => cookieStore.getAll({ url: scope })),
				inScope: await settle(() =>
					cookieStore.getAll({ url: `${scope}page.html` }),
				),
				other: await settle(() =>
					cookieStore.getAll({ url: `${location.origin}/other/x` }),
				),
				cross: await settle(() =>
					cookieStore.get({ url: 'http://localhost:1/' }),
				),
				empty: await settle(() => cookieStore.get()),
				emptyObject: await settle(() => cookieStore.get({})),
				named: await settle(async () => {
					const cookie = await cookieStore.get('b');
					return cookie && [cookie.name, cookie.path, cookie.domain];
				}),
				set: await settle(() => cookieStore.set('d', '4')),
				afterSet: await settle(async () => names(await cookieStore.getAll())),
				setPath: await settle(() =>
					cookieStore.set({ name: 'h', value: '8', path: '/pages/deep/swc/' }),
				),
				badPath: await settle(() =>
					cookieStore.set({ name: 'i', value: '9', path: 'x' }),
				),
				delete: await settle(() => cookieStore.delete('d')),
				afterDelete: await settle(async () =>
					names(await cookieStore.getAll()),
				),
				// what came of the writes above is weighed before any subscription
				flushed: await settle(flush),
				subscribeOutside: await settle(() =>
					registration.cookies.subscribe([
						{ name: 'x', url: `${location.origin}/other/` },
					]),
				),
				subscribe: await settle(() =>
					registration.cookies.subscribe([
						{ name: 'e', url: scope },
						{ url: scope },
					]),
				),
				subscriptions: await settle(() =>
					registration.cookies.getSubscriptions(),
				),
			};
			await registration.cookies.unsubscribe([{ url: scope }]);
			report.afterUnsubscribe = await settle(() =>
				registration.cookies.getSubscriptions(),
			);
			await registration.cookies.subscribe([
				{ name: 'e', url: scope },
				{ name: 'g', url: scope },
			]);
			event.source.postMessage(report);
		})(),
	),
);
