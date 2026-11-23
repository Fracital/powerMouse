// The service worker's scope in a dedicated worker (the offline-html build,
// scripts/build-offline.mjs). dist/serviceWorker.js runs unchanged after
// this script, in the same worker: what it reads of a
// ServiceWorkerGlobalScope (registration, clients, skipWaiting, the install,
// activate, fetch and message events, the Client classes) is made here, and
// the page (./host.mjs) hands it its requests as fetch events and the
// controller's messages as message events. The worker's own origin is
// opaque (a blob: worker), so it reads the page's as its own: `origin` in
// its name.
import { profileOfScript, profileStoreName } from '../../src/profile.ts';

const KEY = '__pmOffline';
const { origin, scope, query = '' } = JSON.parse(self.name);

// A file: URL's origin is `file://` in Chrome and the opaque `null` in
// Firefox, which the worker's location then shares, and the routes made on
// it (`file:///stomp/...`) would never be its own: there a file: URL reads
// the origin the page gives
const nativeOrigin = Object.getOwnPropertyDescriptor(
	URL.prototype,
	'origin',
).get;
if (
	origin === 'file://' &&
	Reflect.apply(nativeOrigin, new URL('file:///'), []) === 'null'
)
	Object.defineProperty(URL.prototype, 'origin', {
		get() {
			const own = Reflect.apply(nativeOrigin, this, []);
			return own === 'null' && this.protocol === 'file:' ? origin : own;
		},
		configurable: true,
		enumerable: true,
	});
const workerURL = new URL(`${origin}${scope}serviceWorker.js${query}`);
const post = (message, transfer = []) =>
	self.postMessage({ [KEY]: message }, transfer);

// what the worker reads as its own location: the proxy origin's
Object.defineProperty(self, 'location', {
	value: workerURL,
	configurable: true,
	enumerable: true,
});

class Client {
	constructor({ id, url, type = 'window', frameType = 'top-level' }) {
		this.id = id;
		this.url = url;
		this.type = type;
		this.frameType = frameType;
	}
	postMessage(data, transfer = []) {
		post({ kind: 'client', id: this.id, data }, transfer);
	}
}
class WindowClient extends Client {
	focused = true;
	visibilityState = 'visible';
	async focus() {
		return this;
	}
	async navigate() {
		return null;
	}
}
self.Client = Client;
self.WindowClient = WindowClient;

/** the page's documents, by client id (the host page's, and each written frame's) */
const known = new Map();
self.clients = {
	get: async (id) => known.get(id),
	matchAll: async ({ type = 'window' } = {}) =>
		[...known.values()].filter(
			(client) => type === 'all' || client.type === type,
		),
	claim: async () => {},
	openWindow: async () => null,
};
const never = async () => {};
self.registration = {
	scope: `${origin}${scope}`,
	active: { state: 'activated', scriptURL: workerURL.href },
	installing: null,
	waiting: null,
	navigationPreload: {
		enable: never,
		disable: never,
		setHeaderValue: never,
		getState: async () => ({ enabled: false, headerValue: '' }),
	},
	addEventListener() {},
	removeEventListener() {},
	update: never,
	unregister: async () => true,
};
self.skipWaiting = never;

// A synchronous wait in a document can never be answered here (nothing
// serves a document's synchronous request), as where a waiting page stops
// the worker: the worker learns it from the store it reads it from at
// start (src/server/createServer.ts syncFrozen, syncAnswers). That store is
// its profile's, as the worker names it from its script's query (Tor mode's
// is `stompConfig|tor`): seeded in the default profile's alone, Tor mode's
// worker never knew, its documents read their stores through the bridge,
// and a streamed one's first read (primeStore) failed its markup, so the
// tab said Loading for good
const seeded = new Promise((resolve) => {
	try {
		const open = indexedDB.open(
			profileStoreName('stompConfig', profileOfScript(query)),
			1,
		);
		open.onupgradeneeded = () => open.result.createObjectStore('consts');
		open.onerror = () => resolve();
		open.onsuccess = () => {
			const db = open.result;
			try {
				const tx = db.transaction('consts', 'readwrite');
				tx.objectStore('consts').put(true, 'syncFrozen');
				tx.objectStore('consts').put(false, 'syncAnswers');
				tx.oncomplete =
					tx.onerror =
					tx.onabort =
						() => {
							db.close();
							resolve();
						};
			} catch {
				db.close();
				resolve();
			}
		};
	} catch {
		resolve();
	}
});

/** an install or activate event: settles when what it waits for has */
function lifecycle(type) {
	const event = new Event(type);
	const lasting = [];
	Object.defineProperty(event, 'waitUntil', {
		value: (promise) => lasting.push(Promise.resolve(promise).catch(() => {})),
	});
	self.dispatchEvent(event);
	return Promise.all(lasting);
}
// the worker's install and activation, once its script (after this one,
// in the same file) has run; it takes no event before
const started = seeded
	.then(() => new Promise((resolve) => setTimeout(resolve, 0)))
	.then(() => lifecycle('install'))
	.then(() => lifecycle('activate'));

// The files the worker fetches from its own origin (the inject bundles it
// keeps, the blocker's lists, the host's error page) are the page's
let asked = 0;
const assets = new Map();
const nativeFetch = self.fetch.bind(self);
self.fetch = function fetch(input, init) {
	let url;
	try {
		url = new URL(
			input instanceof Request ? input.url : String(input),
			workerURL,
		);
	} catch {
		return nativeFetch(input, init);
	}
	// (a blob: URL of this origin is one the browser holds or fails, as a
	// service worker's read of one a realm minted fails: rewrites.ts
	// handedBlobs)
	if (url.origin !== origin || url.protocol === 'blob:')
		return nativeFetch(input, init);
	const id = ++asked;
	return new Promise((resolve, reject) => {
		assets.set(id, { resolve, reject });
		post({ kind: 'asset', id, path: `${url.pathname}${url.search}` });
	});
};

/** a Request as the browser hands a worker one, with what a script cannot set (its mode, destination, referrer) */
function requestOf(given) {
	const navigate = given.mode === 'navigate';
	const init = {
		method: given.method,
		headers: given.headers,
		credentials: given.credentials === 'omit' ? 'omit' : 'include',
		cache: given.cache || 'default',
		redirect: navigate ? 'manual' : given.redirect || 'follow',
		integrity: given.integrity || '',
		keepalive: !!given.keepalive,
		...(given.body !== null &&
		given.body !== undefined &&
		!['GET', 'HEAD'].includes(given.method)
			? { body: given.body, duplex: 'half' }
			: {}),
	};
	if (!navigate && given.mode && given.mode !== 'same-origin')
		init.mode = given.mode;
	const request = new Request(given.url, init);
	return dress(
		request,
		{
			mode: given.mode || 'cors',
			destination: given.destination || '',
			referrer: given.referrer ?? '',
			referrerPolicy: given.referrerPolicy || '',
		},
		init.body,
	);
}
// Firefox's Request has no `body` (its service worker's fetch event's
// request has one), which the worker reads to know that a request has a
// body to send: every POST went out empty there
const NO_BODY = !('body' in Request.prototype);
function dress(request, facts, body) {
	for (const [name, value] of Object.entries(facts))
		Object.defineProperty(request, name, { value, configurable: true });
	if (NO_BODY && body !== undefined) {
		let stream = null;
		Object.defineProperty(request, 'body', {
			get() {
				stream ??= new Response(body).body;
				return stream;
			},
			configurable: true,
		});
	}
	Object.defineProperty(request, 'clone', {
		value() {
			return dress(Request.prototype.clone.call(this), facts, body);
		},
		configurable: true,
	});
	return request;
}

/** one of the page's requests, as a fetch event */
async function fetchEvent(given) {
	const request = requestOf(given);
	const event = new Event('fetch', { cancelable: true });
	let answer = null;
	const lasting = [];
	// (configurable, as a FetchEvent's are accessors of its prototype: the
	// worker views an event through a Proxy that answers some of them
	// itself, src/server/called.ts calledRequest's view)
	const facts = {
		request,
		clientId: given.clientId || '',
		resultingClientId: given.resultingClientId || '',
		replacesClientId: '',
		isReload: !!given.isReload,
		preloadResponse: Promise.resolve(undefined),
		handled: Promise.resolve(),
		respondWith(promise) {
			if (answer) throw new DOMException('responded', 'InvalidStateError');
			answer = Promise.resolve(promise);
		},
		waitUntil(promise) {
			lasting.push(Promise.resolve(promise).catch(() => {}));
		},
	};
	for (const [name, value] of Object.entries(facts))
		Object.defineProperty(event, name, { value, configurable: true });
	self.dispatchEvent(event);
	return answer ?? nativeFetch(request);
}

async function answerFetch(given) {
	try {
		const response = await fetchEvent(given);
		const body =
			given.method === 'HEAD' || !response.body ? null : response.body;
		post(
			{
				kind: 'response',
				id: given.id,
				status: response.status,
				statusText: response.statusText,
				headers: [...response.headers],
				url: response.url,
				redirected: response.redirected,
				type: response.type,
				body,
			},
			body ? [body] : [],
		);
	} catch (error) {
		post({ kind: 'response', id: given.id, error: String(error) });
	}
}

/** the page's messages, as the worker's message events, each from a client */
function messageEvent(message, ports) {
	const event = new MessageEvent('message', { data: message.data, ports });
	Object.defineProperties(event, {
		source: { value: known.get(message.source) ?? null },
		waitUntil: { value: (promise) => Promise.resolve(promise).catch(() => {}) },
	});
	self.dispatchEvent(event);
}

self.addEventListener('message', (event) => {
	const message = event.data?.[KEY];
	if (!message) return;
	// (the worker's own message listeners hear the event made of it)
	event.stopImmediatePropagation();
	const ports = [...event.ports];
	switch (message.kind) {
		case 'client':
			if (message.gone) known.delete(message.id);
			else
				known.set(
					message.id,
					message.type === 'window' || message.type === undefined
						? new WindowClient(message)
						: new Client(message),
				);
			break;
		case 'message':
			started.then(() => messageEvent(message, ports));
			break;
		case 'fetch':
			started.then(() => answerFetch(message));
			break;
		case 'asset': {
			const waiting = assets.get(message.id);
			assets.delete(message.id);
			if (!waiting) break;
			if (message.blob)
				waiting.resolve(
					new Response(message.blob, {
						headers: { 'content-type': message.type || '' },
					}),
				);
			else
				waiting.resolve(
					new Response('not found', { status: 404, statusText: 'Not Found' }),
				);
			break;
		}
	}
});
