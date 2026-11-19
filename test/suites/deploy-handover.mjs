// A deploy's new service worker taking over while the user navigates. Chrome
// stops the old worker as it activates the new one, and a navigation the
// old one was handed in that moment is never answered: the frame kept its
// old document and the host showed "Loading..." until a full reload (the
// first visit after a deploy). The host's frame sends such a navigation
// again once the new worker takes over, and the page arrives, through the
// new worker. Stood in for here by a worker script whose old version holds
// one navigation without answering it, stopped over CDP once the new
// version waits behind it. A deploy that lands as the user types arrives
// too, and nothing the pages ask in the handover reaches the host's server
// at a controller's address. Both modes, behind a front server that serves
// the worker script as each deploy has it.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import {
	done,
	FIXTURE,
	launch,
	ok,
	openDemo,
	PORT,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const browser = await launch();
const WORKER = '/stomp/serviceWorker.js';

// the old version's stand-in for a lost navigation: armed by a message from
// the test, it takes the next proxied frame navigation and never answers it
const HOLDS_ONE = `let heldNext = false;
self.addEventListener('message', (event) => {
	if (event.data && event.data.holdNextNavigation === true) {
		heldNext = true;
		event.stopImmediatePropagation();
	}
});
self.addEventListener('fetch', (event) => {
	if (!heldNext || event.request.mode !== 'navigate') return;
	if (!/\\/html\\//.test(new URL(event.request.url).pathname)) return;
	heldNext = false;
	event.stopImmediatePropagation();
	event.respondWith(new Promise(() => {}));
});
`;

/** the demo behind a server that serves the worker script of deploy `deploy` */
async function deployable() {
	const demo = Number(PORT);
	const state = { deploy: 0, holds: false, hits: [] };
	const front = createServer((req, res) => {
		const { pathname } = new URL(req.url, 'http://front');
		const script = pathname === WORKER;
		// a request at a controller's address that no worker answered
		if (/^\/stomp\/[\w-]{6,}\//.test(pathname))
			state.hits.push(`${req.method} ${pathname.slice(0, 60)}`);
		const headers = { ...req.headers };
		if (script) delete headers['accept-encoding'];
		const upstream = request(
			{
				host: '127.0.0.1',
				port: demo,
				path: req.url,
				method: req.method,
				headers,
			},
			(answer) => {
				if (!script || answer.statusCode !== 200) {
					res.writeHead(answer.statusCode, answer.headers);
					answer.pipe(res);
					return;
				}
				const chunks = [];
				answer.on('data', (chunk) => chunks.push(chunk));
				answer.on('end', () => {
					const body = Buffer.from(
						`${state.holds ? HOLDS_ONE : ''}// deploy ${state.deploy}\n${Buffer.concat(chunks)}`,
					);
					const out = { ...answer.headers };
					for (const name of ['content-length', 'etag', 'last-modified'])
						delete out[name];
					res.writeHead(200, {
						...out,
						'content-length': body.length,
						'cache-control': 'no-store',
					});
					res.end(body);
				});
			},
		);
		upstream.on('error', () => res.destroy());
		req.pipe(upstream);
	});
	// the wisp socket, as it came
	front.on('upgrade', (req, socket, head) => {
		const upstream = connect(demo, '127.0.0.1', () => {
			let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
			for (let i = 0; i < req.rawHeaders.length; i += 2)
				text += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
			upstream.write(`${text}\r\n`);
			upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		upstream.on('error', () => socket.destroy());
		socket.on('error', () => upstream.destroy());
	});
	await new Promise((resolve) => front.listen(0, resolve));
	const { port } = front.address();
	return {
		state,
		proxy: `http://127.0.0.1:${port}/`,
		host: `http://localhost:${port}/`,
		close: () => {
			front.closeAllConnections();
			front.close();
		},
	};
}

const frameOf = (page) =>
	page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));

/** `title` once the frame shows it within `ms`, else the last one read */
async function arrived(page, ms, want = 'HIST 1') {
	let title = null;
	for (const until = Date.now() + ms; Date.now() < until;) {
		title = await Promise.race([
			frameOf(page)
				?.evaluate(() => document.title)
				.catch(() => null),
			sleep(1000).then(() => null),
		]);
		if (title === want) return title;
		await sleep(250);
	}
	return title;
}

const front = await deployable();
for (const [mode, base] of [
	['same-origin', front.proxy],
	['isolated', front.host],
]) {
	front.state.deploy++;
	front.state.holds = true;
	const page = await openDemo(browser, base);
	// the controller's realm: the host page, else its controller frame
	const realm = () =>
		mode === 'same-origin'
			? page.mainFrame()
			: page.frames().find((f) => /controllerFrame/.test(f.url()));
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	const versions = new Map();
	cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: list }) => {
		for (const version of list) versions.set(version.versionId, version);
	});
	await sleep(1000);
	const activeVersion = () =>
		[...versions.values()].find(
			(version) =>
				version.status === 'activated' && version.scriptURL.endsWith(WORKER),
		);

	// the old worker takes the user's navigation and never answers it
	await realm().evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration(
			new URL('/stomp/', location.href).href,
		);
		registration.active.postMessage({ holdNextNavigation: true });
	});
	await sleep(300);
	const old = activeVersion();
	await submitLanding(page, `${FIXTURE}pages/hist-1.html`);
	await sleep(1000);
	// the deploy: a new worker, waiting behind the event the old one holds
	front.state.deploy++;
	front.state.holds = false;
	const hitsBefore = front.state.hits.length;
	await realm().evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration(
			new URL('/stomp/', location.href).href,
		);
		await registration.update();
	});
	let waiting = false;
	for (let i = 0; i < 40 && !waiting; i++) {
		await sleep(100);
		waiting = [...versions.values()].some(
			(version) =>
				version.versionId !== old?.versionId && version.status === 'installed',
		);
	}
	// Chrome stops the old worker as the new one takes over (again when a
	// request of the page's started it before the new one activated)
	const taken = () => {
		const active = activeVersion();
		return active !== undefined && active.versionId !== old?.versionId;
	};
	for (let i = 0; i < 10 && old && !taken(); i++) {
		await cdp
			.send('ServiceWorker.stopWorker', { versionId: old.versionId })
			.catch(() => {});
		for (let j = 0; j < 10 && !taken(); j++) await sleep(100);
	}
	const title = await arrived(page, 15000);
	ok(
		`${mode}: a navigation the old worker was handed as a deploy's new worker took over arrives`,
		title === 'HIST 1',
		JSON.stringify({ title, waiting, old: old?.versionId }),
	);
	ok(
		`${mode}: through the new worker`,
		taken(),
		JSON.stringify({ old: old?.versionId, active: activeVersion()?.versionId }),
	);

	// a deploy that lands as the user types: the page arrives, and nothing
	// the pages ask in the handover reaches the host's server
	front.state.deploy++;
	await realm().evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration(
			new URL('/stomp/', location.href).href,
		);
		registration.update();
	});
	await submitOmni(page, `${FIXTURE}pages/hist-2.html`);
	const again = await arrived(page, 15000, 'HIST 2');
	ok(
		`${mode}: a page typed as a deploy lands arrives`,
		again === 'HIST 2',
		JSON.stringify({ title: again }),
	);
	const hits = front.state.hits.slice(hitsBefore);
	ok(
		`${mode}: nothing the pages asked in the handovers reached the host's server at a controller's address`,
		hits.length === 0,
		JSON.stringify(hits.slice(0, 8)),
	);
	await cdp.detach().catch(() => {});
	await page.close();
}
front.close();
await done(browser);
