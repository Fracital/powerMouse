// A site of the service-worker suites' own (docs/service-workers.md), on a
// free port of 127.0.0.1: the suites change its worker script's bytes
// (`bump`) and take it offline (`close`), which the shared fixture cannot.
// Everything it serves is generated here from `run`, the name a page carries
// in its query, so a native run and the proxied runs keep their own versions.
import { createServer } from 'node:http';

const html = (body) => `<!doctype html><meta charset="utf-8">${body}`;

/** the page script every page of the site shares: a log the suite reads */
const LOG = `<script>
	const log = [];
	window.__sw = { log, done: false };
	const push = (...parts) =>
		log.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
	const params = new URLSearchParams(location.search);
	const run = params.get('run') || 'default';
	window.__sw.step = params.get('step');
	const until = async (test, ms = 10000) => {
		for (let waited = 0; !test() && waited < ms; waited += 50)
			await new Promise((resolve) => setTimeout(resolve, 50));
		return test();
	};
	const finish = (work) =>
		work().then(
			() => (window.__sw.done = true),
			(error) => {
				push('fail', String(error), error && error.stack);
				window.__sw.done = true;
			},
		);
</script>`;

const PAGES = {
	// register, then (in a later load) check it persisted and update it
	'/app/update.html': html(`<title>SW UPDATE</title>${LOG}<script>
	finish(async () => {
		const c = navigator.serviceWorker;
		const step = params.get('step');
		if (step === '1') {
			const reg = await c.register('sw-update.js?run=' + run);
			// a page busy elsewhere: the worker is active by the time it asks
			// for ready, which must not resolve before the registration object
			// itself shows the active worker
			await new Promise((resolve) => setTimeout(resolve, 500));
			await c.ready;
			await until(() => reg.active.state === 'activated');
			push('registered', reg.active.scriptURL.replace(/run=.*/, ''), reg.active.state);
			return;
		}
		if (step === '3') {
			// the suite changed the bytes before this navigation: the update
			// check after it finds them, and the new worker claims the page
			// (before or after this script runs: the version is asked for)
			const expected = Number(params.get('expect'));
			let version = null;
			c.addEventListener('message', (event) => (version = event.data.version));
			for (let waited = 0; version !== expected && waited < 20000; waited += 250) {
				if (c.controller) c.controller.postMessage('version');
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			push('soft update', version === expected);
			return;
		}
		const reg = await c.getRegistration();
		push('persisted', !!reg, reg && reg.active && reg.active.state, String(c.controller && c.controller.state));
		const first = reg.active;
		await reg.update();
		push('same bytes', !!reg.installing, !!reg.waiting, reg.active === first);
		window.__sw.readyForBump = true;
		await until(() => window.__sw.bumped, 20000);
		const states = [];
		reg.addEventListener('updatefound', () => {
			const next = reg.installing;
			push('updatefound', next.state);
			next.addEventListener('statechange', () => states.push(next.state));
		});
		await reg.update();
		await until(() => states.includes('activated'));
		push('new bytes', states, reg.active !== first, first.state, !!reg.waiting);
	});
</script>`),
	// a cache-first app: step 1 registers, step 2 is a reload (controlled
	// from the start), step 3 a load while the site is unreachable, which
	// the worker answers from its cache
	'/app/offline.html': html(`<title>SW OFFLINE</title>
<link rel="stylesheet" href="offline.css">${LOG}<body><p>offline app</p><script>
	finish(async () => {
		const c = navigator.serviceWorker;
		const step = params.get('step');
		push('start', step, String(c.controller && c.controller.state), location.pathname + location.search.replace(/run=[^&]*/, ''), document.title);
		if (step === '1') {
			await c.register('sw-offline.js?run=' + run);
			await until(() => c.controller);
			await until(() => c.controller.state === 'activated');
			push('controlled', c.controller.state);
			return;
		}
		push('data', await (await fetch('offline-data.json')).json());
		push('style', getComputedStyle(document.querySelector('p')).color);
		const reg = await c.getRegistration();
		push('registration', reg.active === c.controller, (await c.ready) === reg);
	});
</script>`),
	// site A of the isolation suite: a worker that takes the whole origin
	// (step 1), then a report of what it saw (step 2)
	'/a/iso.html': html(`<title>SW ISOLATION A</title>${LOG}<script>
	finish(async () => {
		const c = navigator.serviceWorker;
		if (params.get('step') === '1') {
			await c.register('/a/sw-iso.js', { scope: '/' });
			await until(() => c.controller);
			// passed through the worker to the network, where Stomp's HTTP
			// cache keeps it (max-age): the worker's caches must not see it
			push('cacheable', (await (await fetch('/a/cacheable.txt')).text()).trim());
			return;
		}
		const report = new Promise((resolve) =>
			c.addEventListener('message', (event) => resolve(event.data)),
		);
		c.controller.postMessage({ secret: params.get('secret') });
		window.__sw.report = await report;
	});
</script>`),
};

/**
 * preload.html: what the site sent for this load, and how (the navigation
 * preload header, the request's destination and mode); step 1 registers a
 * worker with navigation preload on, the later steps are loads it answers
 * the way `how` says
 */
const preloadPage = (request) => {
	const header = request.headers['service-worker-navigation-preload'] ?? '';
	const sent = [
		header || 'no preload header',
		request.headers['sec-fetch-dest'],
		request.headers['sec-fetch-mode'],
	].join(' ');
	return html(`<title>SERVED</title><meta name="sent" content="${sent}">${LOG}<script>
	finish(async () => {
		const c = navigator.serviceWorker;
		const step = params.get('step');
		if (step === '1') {
			const reg = await c.register('sw-preload.js?run=' + run);
			await until(() => c.controller && c.controller.state === 'activated');
			for (let i = 0; i < 100 && !(await reg.navigationPreload.getState()).enabled; i++)
				await new Promise((resolve) => setTimeout(resolve, 100));
			push('registered', await reg.navigationPreload.getState());
			return;
		}
		push(
			'load',
			params.get('how'),
			document.title,
			document.querySelector('meta[name=sent]').content,
			String(c.controller && c.controller.state),
		);
	});
</script>`);
};

/** sw-preload.js: navigation preload on; passes the preload on, reads it, or leaves the load alone */
const preloadWorker = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
	event.waitUntil(
		Promise.all([
			clients.claim(),
			self.registration.navigationPreload.enable(),
			self.registration.navigationPreload.setHeaderValue('stomp-test'),
		]),
	),
);
self.addEventListener('fetch', (event) => {
	if (event.request.mode !== 'navigate') return;
	const how = new URL(event.request.url).searchParams.get('how');
	if (how === 'pass')
		event.respondWith(
			Promise.resolve(event.preloadResponse).then(
				(response) => response || fetch(event.request),
			),
		);
	else if (how === 'read')
		event.respondWith(
			(async () => {
				const response = await event.preloadResponse;
				const text = await response.text();
				return new Response(text.replace('SERVED', 'SERVED READ'), {
					headers: response.headers,
				});
			})(),
		);
	else if (how === 'kind')
		event.respondWith(
			(async () => {
				const response = await event.preloadResponse;
				const kind = [
					String(response),
					response.type,
					response.url.replace(/run=[^&]*/, ''),
					response.status,
					response.redirected,
					response.headers.get('content-type'),
				].join(' ');
				const text = await response.text();
				return new Response(text.replace('SERVED', kind), {
					headers: response.headers,
				});
			})(),
		);
});
`;

/** sw-iso.js: remembers every request it gets, answers /probe itself, and reports */
const isolationWorker = `const seen = [];
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('fetch', (event) => {
	seen.push(event.request.url);
	if (event.request.url.includes('probe')) event.respondWith(new Response('from A'));
});
self.addEventListener('message', (event) =>
	event.waitUntil(
		(async () => {
			const all = await clients.matchAll({ includeUncontrolled: true, type: 'all' });
			const shared = await caches.match(event.data.secret);
			const stomp = await caches.match(new URL('/a/cacheable.txt', location.href).href);
			event.source.postMessage({
				seen,
				clients: all.map((client) => client.url),
				keys: await caches.keys(),
				shared: shared ? await shared.text() : null,
				stomp: stomp ? await stomp.text() : null,
			});
		})(),
	),
);
`;

/** sw-offline.js: precaches the app, network first for documents, cache first for the rest */
const offlineWorker = `const CACHE = 'offline-v1';
self.addEventListener('install', (event) =>
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(['offline.html', 'offline.css', 'offline-data.json'])),
	),
);
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).catch(() => caches.match(request, { ignoreSearch: true })),
		);
		return;
	}
	event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
`;

/** sw-update.js: skips waiting, claims; its bytes carry the run's version */
const updateWorker = (version) => `// version ${version}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
self.addEventListener('message', (event) => event.source.postMessage({ version: ${version} }));
`;

export async function startSite() {
	const versions = new Map();
	/** the requests for preload.html, per run */
	const preloads = new Map();
	let online = true;
	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://x');
		const run = url.searchParams.get('run') ?? 'default';
		if (!online) {
			req.socket.destroy();
			return;
		}
		res.setHeader('cache-control', 'no-store');
		if (url.pathname === '/bump') {
			versions.set(run, (versions.get(run) ?? 0) + 1);
			return res.end('bumped');
		}
		if (url.pathname === '/a/sw-iso.js') {
			res.setHeader('content-type', 'text/javascript');
			res.setHeader('service-worker-allowed', '/');
			return res.end(isolationWorker);
		}
		if (url.pathname === '/a/cacheable.txt') {
			res.setHeader('content-type', 'text/plain');
			res.setHeader('cache-control', 'max-age=600');
			return res.end('cacheable from A');
		}
		if (url.pathname === '/app/preload.html') {
			const seen = preloads.get(run) ?? [];
			seen.push(
				`${url.searchParams.get('step')} ${req.headers['service-worker-navigation-preload'] ?? 'none'}`,
			);
			preloads.set(run, seen);
			res.setHeader('content-type', 'text/html; charset=utf-8');
			return res.end(preloadPage(req));
		}
		if (url.pathname === '/app/sw-preload.js') {
			res.setHeader('content-type', 'text/javascript');
			return res.end(preloadWorker);
		}
		if (url.pathname === '/app/sw-offline.js') {
			res.setHeader('content-type', 'text/javascript');
			return res.end(offlineWorker);
		}
		if (url.pathname === '/app/offline.css') {
			res.setHeader('content-type', 'text/css');
			return res.end('p { color: rgb(1, 2, 3); }');
		}
		if (url.pathname === '/app/offline-data.json') {
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify({ from: 'the site' }));
		}
		if (url.pathname === '/app/sw-update.js') {
			res.setHeader('content-type', 'text/javascript');
			return res.end(updateWorker(versions.get(run) ?? 0));
		}
		if (PAGES[url.pathname]) {
			res.setHeader('content-type', 'text/html; charset=utf-8');
			return res.end(PAGES[url.pathname]);
		}
		res.statusCode = 404;
		res.end('not found');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	return {
		origin,
		bump: (run) => versions.set(run, (versions.get(run) ?? 0) + 1),
		/** the requests preload.html got in `run`: its step and preload header */
		preloadRequests: (run) => preloads.get(run) ?? [],
		/** stop answering: every connection is dropped, as an unreachable site's */
		offline: () => (online = false),
		online: () => (online = true),
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(resolve);
			}),
	};
}
