// The in-browser Tor client against the real Tor network
// (docs/tor-over-wisp.md "Prototype"): node test/tor-client-smoke.mjs after
// `node build.js`. Not a suite: it needs the public Tor network, which no CI
// runner should depend on. SKIP_NETWORK=1 skips it.
//
// A demo server of its own (holyWisp logging every stream it opens), the
// demo in Tor mode with `?tor=client`, and a Chrome that resolves no name
// but localhost (test/lib.mjs launch), so nothing reaches the network but the
// Wisp connection. It loads https://check.torproject.org/api/ip, another
// site and the first again, then a fresh host page (the client's state kept)
// and the first once more, and checks that every Wisp stream went to an IP
// address (a relay, never a site's name) and that the site said IsTor.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

if (process.env.SKIP_NETWORK) {
	console.log('SKIP tor-client-smoke: SKIP_NETWORK is set');
	process.exit(0);
}

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

const port = String(await freePort());
process.env.PORT = port;
const {
	activeFrame,
	done,
	HOST,
	launch,
	ok,
	sleep,
	submitLanding,
	submitOmni,
	waitForServer,
} = await import('./lib.mjs');

const root = fileURLToPath(new URL('../', import.meta.url));
const env = {
	...process.env,
	PORT: port,
	HOLYWISP_LOG_LEVEL: 'debug',
	STOMP_DIALING: '0',
	STOMP_SITE_POOL: '0',
	STOMP_SLOT_PORTS: '0',
};
delete env.STOMP_WISP_URL;
delete env.STOMP_TOR_SOCKS5;
delete env.STOMP_PROXY_ORIGIN;
const server = spawn(process.execPath, [`${root}demo/server.js`], {
	env,
	stdio: ['ignore', 'pipe', 'inherit'],
});
const streams = [];
let partial = '';
server.stdout.on('data', (chunk) => {
	const lines = (partial + chunk).split('\n');
	partial = lines.pop();
	for (const line of lines) {
		const open = / stream \d+ open to (.+):(\d+)$/.exec(line);
		if (open) streams.push({ host: open[1], port: Number(open[2]) });
	}
});
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

const PAGE_MS = 240000;
// the demo server starts slowly on a loaded machine
await waitForServer(HOST, 600);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
const keep = (message) => {
	const text = message.text();
	if (/\[tor\]|bootstrap|Bootstrap/i.test(text)) logs.push(text);
};
page.on('console', keep);
// TOR_SMOKE_DEBUG=1: every console line of the page and its workers, timed
const debugStart = Date.now();
const debug = (where) => (message) => {
	if (process.env.TOR_SMOKE_DEBUG)
		console.log(`${Date.now() - debugStart} ${where}: ${message.text()}`);
};
page.on('console', debug('page'));
page.on('worker', (worker) => {
	if (process.env.TOR_SMOKE_DEBUG)
		console.log(`${Date.now() - debugStart} worker ${worker.url()}`);
	worker.on('console', debug('worker'));
});
page.on('crash', () =>
	console.log(`${Date.now() - debugStart} the page crashed`),
);
browser.on('disconnected', () =>
	console.log(`${Date.now() - debugStart} the browser went away`),
);
page.on('worker', (worker) => worker.on('console', keep));

/** the active frame's text once it holds `want`, and how long that took */
async function frameText(want) {
	const start = Date.now();
	while (Date.now() - start < PAGE_MS) {
		const frame = await activeFrame(page);
		const text = await frame
			?.evaluate(() => document.body?.innerText ?? '')
			.catch(() => '');
		if (text && want.test(text)) return { text, ms: Date.now() - start };
		await sleep(500);
	}
	return { text: '', ms: Date.now() - start };
}

async function openHost() {
	const start = Date.now();
	await page.goto(`${HOST}?tor=client`);
	await page.waitForFunction(
		() => /^(Ready|Error)/.test(document.getElementById('logMsg').textContent),
		null,
		{ timeout: PAGE_MS },
	);
	return Date.now() - start;
}

const isTor = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

try {
	const hostMs = await openHost();
	const status = await page.evaluate(
		() => document.getElementById('logMsg').textContent,
	);
	ok(
		'the host page is ready in Tor client mode',
		/^Ready/.test(status),
		status,
	);
	const started = Date.now();
	await submitLanding(page, 'https://check.torproject.org/api/ip');
	const first = await frameText(/IsTor/);
	const answer = isTor(first.text);
	ok(
		'check.torproject.org says IsTor through the client',
		answer?.IsTor === true,
		first.text.slice(0, 120),
	);
	console.log(
		`first load (bootstrap and a circuit): ${Date.now() - started} ms; host page ${hostMs} ms`,
	);

	const otherStart = Date.now();
	await submitOmni(page, 'https://api.ipify.org/?format=json');
	const other = await frameText(/"ip"/);
	const otherIP = isTor(other.text)?.ip;
	ok('another site loads through Tor', !!otherIP, other.text.slice(0, 120));
	console.log(
		`another site: ${Date.now() - otherStart} ms, exit ${otherIP} (check.torproject.org's: ${answer?.IP})`,
	);

	const againStart = Date.now();
	await submitOmni(page, 'https://check.torproject.org/api/ip?again');
	const again = isTor((await frameText(/IsTor/)).text);
	ok('the first site again is still Tor', again?.IsTor === true);
	console.log(
		`the first site again: ${Date.now() - againStart} ms, exit ${again?.IP} (same site, same circuit: ${again?.IP === answer?.IP})`,
	);

	// a fresh host page: a new transport worker and client, its directory
	// and guards read back from IndexedDB
	// arti writes its guards to storage on its own schedule (a minute or
	// so after it picked them); a visit shorter than that keeps none
	await sleep(Number(process.env.TOR_SMOKE_KEEP_MS ?? 90000));
	const coldStreams = streams.length;
	const warmStart = Date.now();
	await openHost();
	await submitLanding(page, 'https://check.torproject.org/api/ip?warm');
	const warm = isTor((await frameText(/IsTor/)).text);
	ok('a fresh client with the kept state reaches Tor', warm?.IsTor === true);
	console.log(`fresh client, kept state: ${Date.now() - warmStart} ms`);

	const names = streams.filter(
		({ host }) => !/^[\d.]+$/.test(host) && !host.includes(':'),
	);
	ok(
		'every Wisp stream went to an IP address, no site name',
		streams.length > 0 && names.length === 0,
		`${streams.length} streams, names: ${names.map((s) => s.host).join(', ')}`,
	);
	// the guards are kept (docs/tor-over-wisp.md "Guard persistence"): the
	// fresh client connects to relays the first one did, and to no
	// directory to bootstrap from
	const cold = new Set(
		streams.slice(0, coldStreams).map(({ host, port }) => `${host}:${port}`),
	);
	const warmTargets = streams
		.slice(coldStreams)
		.map(({ host, port }) => `${host}:${port}`);
	ok(
		'the fresh client goes to the guards the first one had',
		warmTargets.length > 0 && warmTargets.every((target) => cold.has(target)),
		`first client ${[...cold].join(' ')}; fresh client ${warmTargets.join(' ')}`,
	);
	console.log(
		'Wisp destinations:',
		[...new Set(streams.map(({ host, port }) => `${host}:${port}`))].join(' '),
	);
	console.log('client log:', logs.slice(-12).join('\n  '));
} catch (error) {
	ok('the smoke ran', false, error.stack);
}
stop();
await done(browser);
