// Development client for the demo. index.html loads it (as a module) only when
// /config.js says `dev`, which demo/server.js sets under STOMP_DEV=1, so a
// production page never fetches it. main.js does not depend on it; when dev
// is on it leaves a few hooks on window.__stompDev (tabs, reloadFrames,
// isolated) that this file uses, and this file adds `state` for debugging.
//
// It keeps a WebSocket to /__dev open, reconnecting forever, and applies what
// the server announces:
//   a stylesheet under /pm/     swap the <link> in place, no navigation
//   any other static file       reload the page
//   dist/serviceWorker.js       update the registration, re-handshake the
//                               controller with the new worker, reload the
//                               proxied frames (isolated mode: reload the
//                               page, the worker lives in the controller frame)
//   dist/inject*.js,            reload every proxied frame
//   dist/rewriterLib.js
//   dist/transportWorker.js     reload the page (the running worker keeps
//                               the old code)
//   any other bundle            reload the page
//   a server with a new         reload the page (its code changed, or
//   startedAt on reconnect      /config.js did)
//   build errors                overlay with esbuild's message until the next
//                               clean build of that bundle

const CFG = window.STOMP_CONFIG || {};
const DIRECTORY = '/stomp/';
const STEP_MS = 250;
const MAX_WAIT_MS = 5000;
const JITTER_MS = 250;
/** bundles the host page itself runs, or starts as a worker it cannot restart
 * in place: nothing short of a reload picks them up */
const PAGE_BUNDLES = new Set([
	'Controller.js',
	'controller.mjs',
	'controllerFrame.js',
	'controllerFrame.html',
	'SearchBuilder.js',
	'transportWorker.js',
]);

// same badge as main.js, labelled Dev, so the console tells the two apart
const BADGE_LEFT =
	'padding: 1px 4px; border-radius: 3px 0 0 3px; color: #fff; background: #606060;';
const BADGE_RIGHT =
	'padding: 1px 4px; border-radius: 0 3px 3px 0; color: #fff; background: ';
const BADGE = {
	blue: '#1475b2',
	green: '#2e9e4f',
	orange: '#f2a20d',
	red: '#c0392b',
	grey: '#606060',
};

const state = {
	connected: false,
	attempts: 0, // reconnects tried since the socket was last open
	startedAt: CFG.startedAt ?? null, // the server this page was loaded from
	lastEvent: null,
	errors: new Map(), // bundle -> esbuild messages, while that bundle fails
	pendingReload: null, // reason for a reload that waits for the server
	updating: null, // step of a service worker update in progress
	log: [], // the last badge lines
};
const hooks = () => window.__stompDev || {};
window.__stompDev = Object.assign(window.__stompDev || {}, { state });

function badge(value, color = 'blue') {
	state.log.push(value);
	if (state.log.length > 50) state.log.shift();
	console.info(`%c Dev %c ${value} `, BADGE_LEFT, BADGE_RIGHT + BADGE[color]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

let reloading = false;
function reload(reason) {
	if (reloading) return;
	// a reload into a server that is down lands on an error page, which has
	// no client to reconnect with; wait for the socket to come back
	if (!state.connected) {
		if (!state.pendingReload)
			badge(`${reason}, reloading when the server is back`, 'orange');
		state.pendingReload = reason;
		return;
	}
	reloading = true;
	badge(`${reason}, reloading`, 'orange');
	location.reload();
}

function reloadFrames(reason) {
	const count = hooks().reloadFrames?.() ?? 0;
	badge(`${reason}, ${count} frame${count === 1 ? '' : 's'} reloaded`, 'green');
	return count;
}

// ---- socket ----------------------------------------------------------------

let delay = STEP_MS;
let downSince = null;

function connect() {
	const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
	const socket = new WebSocket(`${protocol}://${location.host}/__dev`);
	socket.addEventListener('open', () => {
		state.connected = true;
		badge(
			downSince === null
				? 'connected to /__dev'
				: `reconnected after ${seconds(Date.now() - downSince)}`,
			'green',
		);
		delay = STEP_MS;
		state.attempts = 0;
		downSince = null;
		if (state.pendingReload) reload(state.pendingReload);
	});
	socket.addEventListener('message', (event) => {
		try {
			handle(JSON.parse(event.data));
		} catch (error) {
			badge(`bad event: ${error.message}`, 'red');
		}
	});
	socket.addEventListener('close', () => {
		if (downSince === null) {
			downSince = Date.now();
			if (state.connected)
				badge('connection lost, server restarting?', 'orange');
		}
		state.connected = false;
		state.attempts++;
		// backoff doubles to MAX_WAIT_MS; jitter keeps many tabs from
		// hammering a server that just came back in the same instant
		const wait = delay + Math.random() * JITTER_MS;
		delay = Math.min(delay * 2, MAX_WAIT_MS);
		setTimeout(connect, wait);
	});
}

// ---- events ----------------------------------------------------------------

function handle(event) {
	state.lastEvent = event;
	switch (event.type) {
		case 'hello':
			// a different startedAt is a server that was restarted (its code or
			// its config changed), not merely a dropped socket
			if (state.startedAt !== null && event.startedAt !== state.startedAt)
				reload('server restarted');
			state.startedAt = event.startedAt;
			break;
		case 'static':
			onStatic(event.path);
			break;
		case 'dist':
			onDist(event);
			break;
	}
}

function onStatic(path) {
	// editor leftovers and source maps are not page resources
	if (/\.map$|~$|\/\.|\.sw[a-z]$/.test(path)) return;
	if (path.endsWith('.css')) {
		const links = [...document.querySelectorAll('link[rel=stylesheet]')].filter(
			(link) => new URL(link.href).pathname === path,
		);
		if (!links.length) return;
		for (const link of links) swapStylesheet(link);
		badge(`css swapped ${basename(path)}`, 'green');
		return;
	}
	reload(`${path} changed`);
}

/** load the new sheet beside the old one and drop the old one once it applies */
function swapStylesheet(link) {
	const next = link.cloneNode();
	const url = new URL(link.href);
	url.searchParams.set('dev', Date.now());
	next.href = url.href;
	next.addEventListener('load', () => link.remove(), { once: true });
	next.addEventListener('error', () => next.remove(), { once: true });
	link.after(next);
}

// Several bundles rebuild from one edit to a shared source file and each
// arrives as its own event; act once on the union, strongest action wins.
let batch = null;
function onDist(event) {
	const names = event.outputs
		.map(basename)
		.filter((name) => !name.endsWith('.map'));
	const bundle = names[0] || 'unknown';
	if (event.errors) {
		state.errors.set(bundle, event.messages);
		renderOverlay();
		badge(`build failed: ${bundle}`, 'red');
		return;
	}
	if (state.errors.delete(bundle)) {
		renderOverlay();
		badge(`build fixed: ${bundle}`, 'green');
	}
	if (!batch) {
		batch = new Set();
		setTimeout(() => {
			const changed = batch;
			batch = null;
			apply(changed).catch((error) => {
				badge(`${error.message}`, 'red');
				reload('live update failed');
			});
		}, 150);
	}
	for (const name of names) batch.add(name);
}

async function apply(changed) {
	const list = [...changed];
	const page = list.filter((name) => PAGE_BUNDLES.has(name));
	if (page.length) return reload(`${page.join(', ')} rebuilt`);
	const worker = changed.has('serviceWorker.js');
	const inject = list.filter(
		(name) => name.startsWith('inject') || name === 'rewriterLib.js',
	);
	if (worker) {
		// the worker is registered by the controller frame on the proxy origin,
		// which this page cannot reach: reloading re-registers it there
		if (hooks().isolated) return reload('service worker rebuilt');
		return updateServiceWorker();
	}
	if (inject.length) reloadFrames(`${inject.join(', ')} rebuilt`);
}

async function updateServiceWorker() {
	const registration = await navigator.serviceWorker.getRegistration(DIRECTORY);
	if (!registration) return reload('service worker rebuilt, no registration');
	state.updating = 'update';
	// A starting worker broadcasts "revive" and the controller answers with a
	// fresh handshake to whatever worker it knows, closing the port the still
	// active worker is serving requests over. Fetch events caught on that
	// port never settle, and Chrome holds a skipWaiting worker at "installed"
	// until the active one has no work left, so a rebuild during a frame load
	// would wedge the update for good. Hold the controller's revive guard
	// until our own handshake below (private in the typings; development only).
	const controller = window.controller;
	if (controller) controller.lastHandshake = Infinity;
	const found = new Promise((resolve) =>
		registration.addEventListener(
			'updatefound',
			() => resolve(registration.installing),
			{ once: true },
		),
	);
	await registration.update();
	const worker = await Promise.race([
		found,
		sleep(3000).then(() => registration.installing || registration.waiting),
	]);
	if (!worker) {
		// esbuild emitted the same bytes (a comment, a type), so the browser
		// keeps the worker it has and nothing needs to move
		if (controller) controller.lastHandshake = Date.now();
		state.updating = null;
		badge('service worker rebuilt, unchanged', 'grey');
		return;
	}
	state.updating = `activating (${worker.state})`;
	const activation = activated(worker);
	activation.catch(() => {}); // reported through the race below
	if (!(await Promise.race([activation, sleep(3000)]))) {
		// Still waiting on the old worker's work. A frame reload whose request
		// hung in the transport (epoxy: the first request after the origin
		// closed its keep-alive connection) is a fetch event that never
		// settles, even once the frame moves on; reloading the frames gets
		// their content back, but only re-registering frees the update.
		badge('new worker waiting on the old one, reloading frames', 'orange');
		hooks().reloadFrames?.();
		if (!(await Promise.race([activation, sleep(5000)]))) {
			// start over rather than leave a worker waiting forever
			await registration.unregister();
			return reload('service worker stuck, re-registering');
		}
	}
	state.updating = 'handshake';
	// This page is outside the worker's scope, so it has no `controller` and
	// the StompController keeps talking to the now redundant worker. Point it
	// at the new one and redo the handshake.
	if (controller && 'rebind' in controller) {
		await controller.rebind(worker);
		const until = Date.now() + 5000;
		while (!controller.isReady) {
			if (Date.now() > until)
				throw new Error('controller did not re-handshake');
			await sleep(50);
		}
	}
	state.updating = null;
	reloadFrames('service worker updated');
}

/** resolve once the worker is activated (it skips waiting and claims clients) */
function activated(worker) {
	if (worker.state === 'activated') return Promise.resolve(worker);
	return new Promise((resolve, reject) => {
		worker.addEventListener('statechange', () => {
			if (worker.state === 'activated') resolve(worker);
			else if (worker.state === 'redundant')
				reject(new Error('new service worker became redundant'));
		});
	});
}

// ---- build error overlay ----------------------------------------------------

let overlay = null;
function renderOverlay() {
	const messages = [...state.errors.values()].flat();
	if (!messages.length) {
		overlay?.remove();
		overlay = null;
		return;
	}
	if (!overlay) {
		overlay = document.createElement('pre');
		overlay.id = 'devOverlay';
		overlay.title = 'esbuild errors; clears on the next clean build';
		Object.assign(overlay.style, {
			position: 'fixed',
			top: '0',
			left: '0',
			right: '0',
			maxHeight: '60vh',
			margin: '0',
			padding: '12px 16px',
			overflow: 'auto',
			zIndex: '2147483647',
			background: 'rgba(48, 8, 8, 0.96)',
			color: '#ffb4b4',
			font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
			whiteSpace: 'pre-wrap',
			boxShadow: '0 2px 12px rgba(0, 0, 0, 0.6)',
		});
		document.body.append(overlay);
	}
	const broken = [...state.errors.keys()].join(', ');
	overlay.textContent = `esbuild: ${broken}\n\n${messages.join('\n')}`;
}

connect();
