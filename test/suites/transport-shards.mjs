// The transport's TLS on several threads (TransportDescriptor.shards,
// src/transport/ShardedTransport.ts): the transport worker runs epoxy
// itself as shard 1 and starts more shards, workers of its own, over its
// one Wisp connection, split into a lane per shard
// (src/transport/wispSplit.ts). Through test/wisp-wt.mjs in front of the
// demo's holyWisp:
//
// - with `shards: { max: 4, start: 4 }` (three workers from the start):
//   downloads from four HTTPS origins at once, two from each, arrive byte
//   for byte (SHA-256 against what each server sent), each origin placed
//   on one shard, the four on the three workers (shard 1 relays their
//   packets and takes none while they run), and the relay sees one session
//   for all of them over its WebTransport listener and, with webTransport
//   off, one WebSocket (wisp-split has the handshake and the stream ids);
//   with epoxy in Wisp v2 and the carrier host off, the relay's lane 0 its
//   own (INFO and CONTINUE at once), the same downloads arrive and the
//   relay takes the first lane's INFO first (nothing incompatible);
//   a proxied page loads from one of them and fetches from the others; a
//   WebSocket through a shard echoes text and binary and closes with the
//   server's code;
// - with `shards: 4` (the default's shape): the same downloads of a few
//   hundred KB start no worker, every origin on shard 1; downloads that
//   shard 1 cannot keep up with start workers, and the downloads moved to
//   them arrive byte for byte; the workers close once they carried nothing
//   for 30 s;
// - `shards: 1` runs the transport alone: no shard is named, the bodies are
//   the same.
import { createHash, randomBytes } from 'node:crypto';
import { createSecureServer } from 'node:http2';
import { WebSocketServer } from 'ws';
import { done, launch, ok, PORT, PROXY } from '../lib.mjs';
import { startWispWebTransport } from '../wisp-wt.mjs';
import { startWebTransportServer } from '../wtserver.mjs';

const ORIGINS = 4;
const BYTES = 4 * 1024 * 1024;
/** ShardedTransport.ts IDLE_MS, and a little */
const IDLE_WAIT_MS = 32 * 1000;

// a leaf for 127.0.0.1 signed by the test CA, which epoxy is given
const wt = await startWebTransportServer();
const { certPem, keyPem, caPem } = wt;

/** by request id, the SHA-256 of the body a server sent */
const sent = new Map();
const servers = [];
for (let i = 0; i < ORIGINS; i++) {
	const server = createSecureServer(
		{ cert: certPem, key: keyPem, allowHTTP1: true },
		(req, res) => {
			const url = new URL(req.url, 'https://x');
			if (url.pathname === '/page') {
				res.writeHead(200, { 'content-type': 'text/html' });
				return void res.end(`<!doctype html><title>shard ${i}</title>`);
			}
			const n = Number(url.searchParams.get('n'));
			const body = randomBytes(n);
			sent.set(
				url.searchParams.get('id'),
				createHash('sha256').update(body).digest('hex'),
			);
			res.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': String(n),
				'cache-control': 'no-store',
				'access-control-allow-origin': '*',
			});
			res.end(body);
		},
	);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(`https://127.0.0.1:${server.address().port}`);
}

const echo = new WebSocketServer({ port: 0, host: '127.0.0.1' });
echo.on('connection', (ws) =>
	ws.on('message', (m, binary) => {
		if (!binary && String(m) === 'bye') return void ws.close(4001, 'bye');
		ws.send(m, { binary });
	}),
);
await new Promise((resolve) => echo.once('listening', resolve));
const wsEcho = `ws://127.0.0.1:${echo.address().port}/`;

const relay = await startWispWebTransport(`ws://127.0.0.1:${PORT}/wisp/`);
const browser = await launch();
const errors = [];

/** a controller page whose worker transport has `shards` and webTransport on or off (epoxy in Wisp v2 with `v2`) */
async function controllerPage(
	shards,
	webTransport,
	wisp = relay.wisp,
	carrierHost = true,
	v2 = false,
) {
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(error.message));
	page.logs = [];
	page.on('console', (message) => page.logs.push(message.text()));
	await page.goto(`${PROXY}stomp/controllerFrame.html`);
	await page.evaluate(
		async ({ wisp, caPem, shards, webTransport, carrierHost, v2 }) => {
			const { StompController } = await import('/stomp/controller.mjs');
			const registration = await StompController.register('/stomp/');
			const controller = new StompController({
				serviceworker: registration,
				transport: {
					module: '/epoxy/index.mjs',
					options: [{ wisp, pem_files: [caPem], ...(v2 && { wisp_v2: true }) }],
					host: 'worker',
					shards,
					...(webTransport && { webTransport: { timeoutMs: 3000 } }),
				},
				directory: '/stomp/',
				codec: 'xor',
				debugTransport: true,
				...(!carrierHost && { carrierHost: false }),
			});
			await controller.wait();
			if (!controller.transport.ready) await controller.transport.init();
			const element = document.createElement('iframe');
			document.body.append(element);
			Object.assign(window, {
				controller,
				element,
				frame: controller.createFrame(element),
			});
		},
		{ wisp, caPem, shards, webTransport, carrierHost, v2 },
	);
	return { context, page };
}

/**
 * two downloads from each origin at once through the host's transport
 * (`chunks` of `bytes` one after another, each its own request): their ids,
 * SHA-256s and sizes
 */
const downloads = (page, tag, bytes = BYTES, chunks = 1) =>
	page.evaluate(
		async ({ servers, bytes, tag, chunks }) => {
			const one = async (origin, id) => {
				const response = await window.controller.transport.request(
					new URL(`${origin}/bytes?n=${bytes}&id=${id}`),
					'GET',
					null,
					[],
					undefined,
				);
				const body = await new Response(response.body).arrayBuffer();
				const digest = await crypto.subtle.digest('SHA-256', body);
				return [
					id,
					[...new Uint8Array(digest)]
						.map((b) => b.toString(16).padStart(2, '0'))
						.join(''),
					body.byteLength,
				];
			};
			const series = async (origin, id) => {
				const got = [];
				for (let k = 0; k < chunks; k++)
					got.push(await one(origin, `${id}-${k}`));
				return got;
			};
			return Promise.all(
				servers.flatMap((origin, i) => [
					series(origin, `${tag}-${i}-a`),
					series(origin, `${tag}-${i}-b`),
				]),
			).then(
				(all) => all.flat(),
				(error) => String(error),
			);
		},
		{ servers, bytes, tag, chunks },
	);

/** whether every download arrived whole and as sent */
function intact(got, bytes = BYTES, chunks = 1) {
	if (!Array.isArray(got)) return [false, String(got)];
	const bad = got.filter(
		([id, hash, length]) => length !== bytes || sent.get(id) !== hash,
	);
	return [
		got.length === ORIGINS * 2 * chunks && !bad.length,
		JSON.stringify(bad),
	];
}

/** the shard each origin runs on, from the verbose log */
function placements(page) {
	const placed = new Map();
	for (const line of page.logs) {
		const match = /\[net\] (\S+) runs on transport shard (\d+) of (\d+)/.exec(
			line,
		);
		if (match)
			placed.set(match[1], [...(placed.get(match[1]) ?? []), +match[2]]);
	}
	return placed;
}

/** the verbose log's lines about shards' workers starting and closing */
const workerLines = (page) =>
	page.logs.filter((line) =>
		/transport shard \d+ (of \d+ starts|closes|cannot keep up)/.test(line),
	);

const EAGER = { max: 4, start: 4 };

// ---- four shards, over the relay's WebTransport session ---------------------

{
	const before = { ...relay.stats, protocols: [...relay.stats.protocols] };
	const { context, page } = await controllerPage(EAGER, true);
	const carrier = await page.evaluate(async () => {
		for (let i = 0; i < 60 && !window.controller.carrier; i++)
			await new Promise((resolve) => setTimeout(resolve, 50));
		return window.controller.carrier?.carrier ?? null;
	});
	ok(
		'four shards: the wisp connection rides the session',
		carrier === 'webtransport',
		carrier,
	);

	const [whole, bad] = intact(await downloads(page, 'wt'));
	ok(
		'four shards: eight downloads from four origins arrive byte for byte',
		whole,
		bad,
	);

	const placed = placements(page);
	const shards = servers.map((origin) => placed.get(origin) ?? []);
	ok(
		'four shards: each origin is placed once, on a shard of four',
		shards.every((list) => list.length === 1),
		JSON.stringify(shards),
	);
	ok(
		"four shards: four origins at once run on the three workers, none on the transport worker's own",
		new Set(shards.flat()).size === 3 && !shards.flat().includes(1),
		JSON.stringify(shards),
	);
	ok(
		'four shards: the relay sees one session for every shard',
		// (and the WebSocket a first start opens on standby, closed)
		relay.stats.sessions - before.sessions === 1 &&
			relay.stats.protocols.length - before.protocols.length === 1 &&
			relay.stats.ws - before.ws <= 1,
		`sessions ${before.sessions} -> ${relay.stats.sessions}, ws ${before.ws} -> ${relay.stats.ws}`,
	);

	// a proxied page from one origin, its fetches to the others (cross-origin, CORS *)
	const loaded = await page.evaluate(
		async ({ servers }) => {
			await window.frame.go(`${servers[0]}/page`);
			const win = window.element.contentWindow;
			const title = window.element.contentDocument?.title;
			const sizes = await Promise.all(
				servers.slice(1).map((origin, i) =>
					Reflect.apply(win.fetch, win, [
						`${origin}/bytes?n=65536&id=page-${i}`,
					])
						.then((r) => r.arrayBuffer())
						.then((b) => b.byteLength)
						.catch((error) => String(error)),
				),
			);
			return { title, sizes };
		},
		{ servers },
	);
	ok(
		'four shards: a proxied page loads from one origin and fetches from the others',
		loaded.title === 'shard 0' && loaded.sizes.every((n) => n === 65536),
		JSON.stringify(loaded),
	);

	const socket = await page.evaluate(
		(url) =>
			new Promise((resolve) => {
				const got = [];
				const [send, close] = window.controller.transport.connect(
					new URL(url),
					[],
					[],
					() => {
						send('hello');
						send(new Uint8Array([1, 2, 3]).buffer);
						send('bye');
					},
					(data) =>
						got.push(
							typeof data === 'string'
								? data
								: [...new Uint8Array(data)].join(','),
						),
					(code, reason) => resolve({ got, code, reason }),
					(error) => resolve({ got, error }),
				);
				setTimeout(() => {
					close(1000, '');
					resolve({ got, hung: true });
				}, 10000);
			}),
		wsEcho,
	);
	ok(
		"four shards: a WebSocket through a shard echoes and closes with the server's code",
		socket.got?.join('|') === 'hello|1,2,3' &&
			socket.code === 4001 &&
			socket.reason === 'bye',
		JSON.stringify(socket),
	);
	await context.close();
}

// ---- four shards, Wisp v2, the carrier host off ----------------------------

{
	const before = { ...relay.stats };
	const { context, page } = await controllerPage(
		EAGER,
		true,
		relay.wisp,
		false,
		true,
	);
	const [whole, bad] = intact(await downloads(page, 'split-v2'));
	ok(
		'Wisp v2, carrier host off: eight downloads from four origins arrive byte for byte',
		whole,
		bad,
	);
	ok(
		"Wisp v2, carrier host off: the relay opened lane 0, one session, and took the first lane's INFO first",
		relay.stats.sessions - before.sessions === 1 &&
			relay.stats.serverStreams - before.serverStreams === 1 &&
			relay.stats.incompatible === before.incompatible,
		JSON.stringify({
			sessions: relay.stats.sessions - before.sessions,
			serverStreams: relay.stats.serverStreams - before.serverStreams,
			incompatible: relay.stats.incompatible - before.incompatible,
		}),
	);
	ok(
		'Wisp v2, carrier host off: the origins run on the three workers',
		new Set([...placements(page).values()].flat()).size === 3,
		JSON.stringify([...placements(page)]),
	);
	await context.close();
}

// ---- four shards, over the relay's WebSocket --------------------------------

{
	const before = { ...relay.stats };
	const { context, page } = await controllerPage(EAGER, false);
	const [whole, bad] = intact(await downloads(page, 'ws'));
	ok(
		'WebSocket carrier: eight downloads from four origins arrive byte for byte',
		whole,
		bad,
	);
	ok(
		'WebSocket carrier: the relay sees one WebSocket for every shard',
		relay.stats.ws - before.ws === 1 &&
			relay.stats.sessions === before.sessions,
		`ws ${before.ws} -> ${relay.stats.ws}, sessions ${before.sessions} -> ${relay.stats.sessions}`,
	);
	ok(
		'WebSocket carrier: the origins run on the three workers',
		new Set([...placements(page).values()].flat()).size === 3,
		JSON.stringify([...placements(page)]),
	);
	await context.close();
}

// ---- up to four shards, started as they are needed -------------------------

{
	// straight to the demo's holyWisp: this script's relay would be the slower one
	const { context, page } = await controllerPage(
		4,
		false,
		`ws://127.0.0.1:${PORT}/wisp/`,
	);
	const small = 256 * 1024;
	const [whole, bad] = intact(await downloads(page, 'lazy', small), small);
	ok('lazy: small downloads arrive byte for byte', whole, bad);
	const placed = [...placements(page).values()].flat();
	ok(
		'lazy: small downloads start no worker, every origin on shard 1',
		placed.length === ORIGINS &&
			placed.every((shard) => shard === 1) &&
			!workerLines(page).some((line) => /starts/.test(line)),
		JSON.stringify({ placed, workers: workerLines(page) }),
	);

	// eight downloads at once, each a run of 6 MB requests: more than one
	// thread decrypts as fast as the relay sends
	const big = 6 * 1024 * 1024;
	const chunks = 8;
	const [heavyWhole, heavyBad] = intact(
		await downloads(page, 'heavy', big, chunks),
		big,
		chunks,
	);
	ok(
		'lazy: downloads that shard 1 cannot keep up with arrive byte for byte',
		heavyWhole,
		heavyBad,
	);
	const lines = workerLines(page);
	const started = lines.filter((line) => /starts/.test(line)).length;
	const saturated = lines.some((line) =>
		/transport shard 1 cannot keep up/.test(line),
	);
	const moved = page.logs.filter((line) =>
		/moves from transport shard 1 to/.test(line),
	).length;
	ok(
		'lazy: shard 1 that cannot keep up starts workers, and downloads move to them',
		saturated ? started >= 1 && moved >= 1 : started === 0,
		JSON.stringify({ saturated, started, moved, lines: lines.slice(0, 12) }),
	);
	if (started) {
		await page.waitForTimeout(IDLE_WAIT_MS);
		const closed = workerLines(page).filter((line) =>
			/closes/.test(line),
		).length;
		ok(
			'lazy: the workers close once they carried nothing for 30 s',
			closed === started,
			JSON.stringify({ started, closed }),
		);
	}
	await context.close();
}

// ---- one shard: the transport alone ----------------------------------------

{
	const { context, page } = await controllerPage(1, true);
	const [whole, bad] = intact(await downloads(page, 'one'));
	ok('one shard: the downloads arrive byte for byte', whole, bad);
	ok(
		'one shard: no shard is named',
		placements(page).size === 0,
		JSON.stringify([...placements(page)]),
	);
	await context.close();
}

relay.close?.();
await wt.close?.();
await done(browser, errors);
