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
			await c.ready;
			await until(() => reg.active.state === 'activated');
			push('registered', reg.active.scriptURL.replace(/run=.*/, ''), reg.active.state);
			return;
		}
		const reg = await c.getRegistration();
		push('persisted', !!reg, reg && reg.active && reg.active.state);
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
};

/** sw-update.js: skips waiting, claims; its bytes carry the run's version */
const updateWorker = (version) => `// version ${version}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
`;

export async function startSite() {
	const versions = new Map();
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
