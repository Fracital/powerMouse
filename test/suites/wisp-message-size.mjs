// Uploads to a plain http site survive a wisp server that bounds its
// messages. Epoxy sent a request body as one wisp DATA packet, and the
// holyWisp relays (wss://holywisp.fracit.al/, max-message-size 262149)
// close a connection whose message is larger with 1009, which kills every
// stream on it: one 300 KB upload took the page's other requests and
// sockets down with it (measured 2026-11-10; HTTPS was spared because each
// TLS record is its own packet). Writes now go out in packets of at most
// 64 KiB, each within the stream's flow control credit
// (deploy/epoxy/patches/epoxy-tls).
//
// The suite's own relay sits in front of the demo's wisp and enforces the
// relays' limit the way holyWisp does (the `ws` library closes with 1009
// past maxPayload); it parses the packets going through, so it can tell
// the largest message, the streams and their DATA counts. A controller
// page talks to it; a proxied page uploads 300 KB, 3 MiB and 20 MiB to the
// suite's http server while other requests stream on the same wisp
// connection. Then flow control, on a second port (a fresh connection, so a
// fresh stream): the relay hands that stream's CONTINUE out itself, as
// strictly as holyWisp does (one window at a time, only once the window's
// last packet has arrived), and holds the first one back for a while. The
// upload must stop at its credit, never send past it, and finish. Last, a
// raw epoxy UDP stream: a datagram over the limit fails that send alone.
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { done, launch, ok, PORT, PROXY, sleep } from '../lib.mjs';

// holyWisp's max-message-size on the public relays: 256 KiB of payload plus
// the 5-byte wisp header
const LIMIT = 262149;
// epoxy's packet payload bound, plus the header
const PACKET = 64 * 1024 + 5;
const SIZES = [
	[300 * 1000, '300 KB'],
	[3 * 1024 * 1024, '3 MiB'],
	[20 * 1024 * 1024, '20 MiB'],
];

// the bytes a page uploads: position-dependent, so a reordered or lost
// packet shows
const byteAt = (i) => (i * 31 + (i >>> 8)) & 255;

const PAGE = `<!doctype html><title>uploads</title><script>
const body = (size) => {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >>> 8)) & 255;
	return bytes;
};
window.upload = async (size, base = '') =>
	(await fetch(base + '/upload?size=' + size, { method: 'POST', body: body(size) })).json();
window.drip = async (ms) =>
	(await (await fetch('/drip?ms=' + ms + '&r=' + Math.random())).arrayBuffer()).byteLength;
window.ping = async (base = '') => (await fetch(base + '/ping?r=' + Math.random())).text();
</script>`;

function site(req, res) {
	const url = new URL(req.url, 'http://x/');
	const headers = { 'access-control-allow-origin': '*' };
	if (url.pathname === '/upload') {
		let bytes = 0;
		let intact = true;
		req.on('data', (chunk) => {
			for (let i = 0; i < chunk.length; i++)
				if (chunk[i] !== byteAt(bytes + i)) intact = false;
			bytes += chunk.length;
		});
		req.on('end', () => {
			res.writeHead(200, { ...headers, 'content-type': 'application/json' });
			res.end(JSON.stringify({ bytes, intact }));
		});
		return;
	}
	if (url.pathname === '/drip') {
		// a response that keeps a stream busy while an upload runs
		res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
		const end = Date.now() + Number(url.searchParams.get('ms'));
		const timer = setInterval(() => {
			res.write(Buffer.alloc(1024, 120));
			if (Date.now() >= end) {
				clearInterval(timer);
				res.end();
			}
		}, 100);
		return;
	}
	if (url.pathname === '/ping') {
		res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
		res.end('pong');
		return;
	}
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end(PAGE);
}

const listen = (server, host = '127.0.0.1') =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, host, () => resolve(server.address().port));
	});

const siteServer = createServer(site);
// a second port: a fresh connection, so a fresh wisp stream, for the flow
// control check
const otherServer = createServer(site);
const sitePort = await listen(siteServer);
const otherPort = await listen(otherServer);
const SITE = `http://127.0.0.1:${sitePort}`;
const OTHER = `http://127.0.0.1:${otherPort}`;

const udp = createSocket('udp4');
udp.on('message', (message, from) =>
	udp.send(message, from.port, from.address),
);
const udpPort = await new Promise((resolve) =>
	udp.bind(0, '127.0.0.1', () => resolve(udp.address().port)),
);

// --- the relay ---------------------------------------------------------------
// strict: the port whose streams get their CONTINUE from the relay alone;
// hold: no CONTINUE for them for now
const relay = { conns: [], strict: null, hold: false };
const relayServer = createServer();
const wss = new WebSocketServer({
	server: relayServer,
	maxPayload: LIMIT,
	handleProtocols: (protocols) => protocols.values().next().value ?? false,
});
wss.on('connection', (client, req) => {
	const protocols = (req.headers['sec-websocket-protocol'] || '')
		.split(',')
		.map((token) => token.trim())
		.filter(Boolean);
	const upstream = new WebSocket(
		`ws://127.0.0.1:${PORT}/wisp/`,
		protocols.length ? protocols.slice(0, 1) : undefined,
	);
	const conn = {
		id: relay.conns.length + 1,
		largest: 0,
		messages: 0,
		credit: null,
		streams: new Map(),
		tooBig: false,
		closed: null,
	};
	relay.conns.push(conn);
	const pending = [];
	upstream.on('open', () => {
		for (const message of pending) upstream.send(message);
		pending.length = 0;
	});
	client.on('message', (data) => {
		const packet = Buffer.from(data);
		conn.messages++;
		conn.largest = Math.max(conn.largest, packet.length);
		const id = packet.readUInt32LE(1);
		if (packet[0] === 0x01) {
			const port = packet.readUInt16LE(6);
			conn.streams.set(id, {
				id,
				type: packet[5],
				port,
				strict: port === relay.strict,
				data: 0,
				bytes: 0,
				spent: 0,
				windows: 0,
				over: 0,
				owed: false,
				drained: false,
			});
		}
		const stream = conn.streams.get(id);
		if (packet[0] === 0x02 && stream) {
			stream.data++;
			stream.bytes += packet.length - 5;
			if (stream.strict && ++stream.spent > conn.credit) stream.over++;
			if (stream.strict && stream.spent === conn.credit) {
				stream.owed = true;
				grant(stream);
			}
		}
		if (upstream.readyState === WebSocket.OPEN) upstream.send(packet);
		else pending.push(packet);
	});
	// a full window for the stream, once it has spent the last one and the
	// server has said it is draining (its own CONTINUE, which the relay
	// keeps to itself), so the server's queue stays bounded
	const grant = (stream) => {
		if (relay.hold || !stream.owed || !stream.drained) return;
		stream.owed = false;
		stream.drained = false;
		stream.spent = 0;
		stream.windows++;
		const packet = Buffer.alloc(9);
		packet[0] = 0x03;
		packet.writeUInt32LE(stream.id, 1);
		packet.writeUInt32LE(conn.credit, 5);
		client.send(packet);
	};
	conn.release = () => {
		for (const stream of conn.streams.values()) grant(stream);
	};
	upstream.on('message', (data) => {
		const packet = Buffer.from(data);
		const id = packet.readUInt32LE(1);
		if (packet[0] === 0x03 && id === 0) conn.credit = packet.readUInt32LE(5);
		// the server's own CONTINUE for a strict stream is the relay's to give
		const stream = conn.streams.get(id);
		if (packet[0] === 0x03 && stream?.strict) {
			stream.drained = true;
			grant(stream);
			return;
		}
		client.send(packet);
	});
	client.on('error', (error) => {
		if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') conn.tooBig = true;
	});
	client.on('close', (code) => {
		conn.closed = code;
		upstream.close();
	});
	upstream.on('close', () => client.close());
	upstream.on('error', () => client.terminate());
});
const relayPort = await listen(relayServer);
const RELAY = `ws://127.0.0.1:${relayPort}/`;

const release = () => {
	relay.hold = false;
	for (const conn of relay.conns) conn.release?.();
};

// --- the browser ---------------------------------------------------------------
const browser = await launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`${PROXY}stomp/controllerFrame.html`);
const loaded = await page.evaluate(
	async ({ wisp, url }) => {
		const { StompController } = await import('/stomp/controller.mjs');
		const registration = await StompController.register('/stomp/');
		const controller = new StompController({
			serviceworker: registration,
			transport: { module: '/epoxy/index.mjs', options: [{ wisp }] },
			directory: '/stomp/',
			codec: 'xor',
		});
		await controller.wait();
		const element = document.createElement('iframe');
		element.id = 'site';
		document.body.append(element);
		const frame = controller.createFrame(element);
		await Promise.race([
			frame.go(url),
			new Promise((resolve) => setTimeout(resolve, 20000)),
		]);
		return element.contentDocument?.title ?? null;
	},
	{ wisp: RELAY, url: `${SITE}/` },
);
ok('the upload page loads through the relay', loaded === 'uploads', loaded);

// in the proxied page: drips that run across an upload, the upload, a ping
const run = (size, base = '') =>
	page.evaluate(
		async ({ size, base }) => {
			const win = document.getElementById('site').contentWindow;
			const timeout = (ms) =>
				new Promise((resolve) => setTimeout(() => resolve('HUNG'), ms));
			const settle = (promise, ms) =>
				Promise.race([promise, timeout(ms)]).catch((error) =>
					String(error?.message || error).slice(0, 160),
				);
			const drips = [1, 2, 3].map(() => settle(win.drip(2000), 30000));
			const upload = await settle(win.upload(size, base), 90000);
			return {
				upload,
				drips: await Promise.all(drips),
				ping: await settle(win.ping(), 10000),
			};
		},
		{ size, base },
	);

const before = () => relay.conns.map((conn) => conn.id);
const opened = before();
for (const [size, label] of SIZES) {
	const result = await run(size);
	ok(
		`a ${label} upload to an http site arrives whole`,
		result.upload?.bytes === size && result.upload?.intact === true,
		JSON.stringify(result.upload),
	);
	ok(
		`three responses streaming across the ${label} upload finish`,
		result.drips.every((bytes) => typeof bytes === 'number' && bytes >= 15360),
		JSON.stringify(result.drips),
	);
	ok(
		`a request after the ${label} upload answers`,
		result.ping === 'pong',
		result.ping,
	);
}
const main = relay.conns.find((conn) => conn.id === opened[0]);
ok(
	'the wisp connection the uploads went over is still open, never closed with 1009',
	main && main.closed === null && !relay.conns.some((conn) => conn.tooBig),
	JSON.stringify(
		relay.conns.map(({ id, closed, tooBig }) => ({ id, closed, tooBig })),
	),
);
ok(
	'the page used one wisp connection throughout',
	relay.conns.length === 1,
	`${relay.conns.length} connections`,
);
ok(
	`no message to the server was over ${PACKET} bytes`,
	relay.conns.every((conn) => conn.largest <= PACKET),
	relay.conns.map((conn) => conn.largest).join(', '),
);

// --- flow control --------------------------------------------------------------
relay.strict = otherPort;
relay.hold = true;
const flowSize = 20 * 1024 * 1024;
await page.evaluate(
	({ size, base }) => {
		const win = document.getElementById('site').contentWindow;
		window.flow = win.upload(size, base).catch((error) => String(error));
	},
	{ size: flowSize, base: OTHER },
);
// wait for the upload's stream to stop sending (or to send it all)
let flowStream;
let last = -1;
for (let stable = 0, t = 0; stable < 6 && t < 120; t++) {
	await sleep(250);
	flowStream = [...(main?.streams.values() ?? [])].find(
		(stream) => stream.port === otherPort && stream.bytes > 1024 * 1024,
	);
	const sent = flowStream?.data ?? -1;
	stable = sent === last && sent > 0 ? stable + 1 : 0;
	last = sent;
}
const credit = main?.credit;
ok(
	'with CONTINUE held back, the upload stops at its credit, its last packet sent',
	flowStream &&
		credit > 0 &&
		flowStream.data === credit &&
		flowStream.bytes < flowSize,
	`credit ${credit}, sent ${flowStream?.data} packets, ${flowStream?.bytes} bytes`,
);
const pingWhileHeld = await page.evaluate(async () => {
	const win = document.getElementById('site').contentWindow;
	return Promise.race([
		win.ping(),
		new Promise((resolve) => setTimeout(() => resolve('HUNG'), 10000)),
	]).catch((error) => String(error));
});
ok(
	'other streams keep working while one waits for credit',
	pingWhileHeld === 'pong',
	pingWhileHeld,
);
release();
const flow = await page.evaluate(() =>
	Promise.race([
		window.flow,
		new Promise((resolve) => setTimeout(() => resolve('HUNG'), 90000)),
	]),
);
ok(
	'with CONTINUE one window at a time, only once a window is spent, the upload arrives whole',
	flow?.bytes === flowSize && flow?.intact === true,
	JSON.stringify(flow),
);
ok(
	'the upload never sent past its credit',
	flowStream?.over === 0 && flowStream?.windows >= 2,
	`${flowStream?.over} packets over, ${flowStream?.windows} windows granted, ${flowStream?.data} packets`,
);

// --- UDP ---------------------------------------------------------------------
const udpResult = await page.evaluate(
	async ({ wisp, target, ping }) => {
		const { default: Epoxy } = await import('/epoxy/index.mjs');
		const transport = new Epoxy({ wisp });
		await transport.init();
		const socket = await transport.client.connect_udp(target);
		const reader = socket.read.getReader();
		const next = () =>
			Promise.race([
				reader
					.read()
					.then(({ value, done }) => (done ? 'closed' : value.byteLength)),
				new Promise((resolve) => setTimeout(() => resolve('none'), 5000)),
			]);
		const outcome = (promise) =>
			promise.then(
				() => 'sent',
				(error) => String(error?.message || error),
			);
		const out = { hasSend: typeof socket.send === 'function' };
		if (!out.hasSend) return out;
		await socket.send(new Uint8Array(1200));
		out.small = await next();
		out.big = await outcome(socket.send(new Uint8Array(70000)));
		await socket.send(new Uint8Array(60000));
		out.large = await next();
		const writer = socket.write.getWriter();
		out.bigWrite = await outcome(writer.write(new Uint8Array(70000)));
		await socket.send(new Uint8Array(1000));
		out.after = await next();
		const response = await transport.request(
			new URL(ping),
			'GET',
			null,
			[],
			undefined,
		);
		out.tcp = await new Response(response.body).text();
		return out;
	},
	{ wisp: RELAY, target: `udp://127.0.0.1:${udpPort}`, ping: `${SITE}/ping` },
);
ok('a UDP stream has send()', udpResult.hasSend, JSON.stringify(udpResult));
ok(
	'a 1200-byte datagram is echoed',
	udpResult.small === 1200,
	JSON.stringify(udpResult.small),
);
ok(
	'a 70000-byte datagram fails that send with EMSGSIZE',
	/EMSGSIZE/.test(udpResult.big),
	udpResult.big,
);
ok(
	'the stream still works after it: a 60000-byte datagram is echoed',
	udpResult.large === 60000,
	JSON.stringify(udpResult.large),
);
ok(
	'the WritableStream rejects the same datagram with EMSGSIZE',
	/EMSGSIZE/.test(udpResult.bigWrite),
	udpResult.bigWrite,
);
ok(
	'send() still works after the writable rejected, and so does TCP on the same connection',
	udpResult.after === 1000 && udpResult.tcp === 'pong',
	`${udpResult.after} ${udpResult.tcp}`,
);
ok(
	'no wisp connection was closed by the server',
	relay.conns.every((conn) => conn.closed === null && !conn.tooBig),
	JSON.stringify(
		relay.conns.map(({ id, closed, tooBig }) => ({ id, closed, tooBig })),
	),
);
ok('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
for (const conn of wss.clients) conn.terminate();
wss.close();
relayServer.close();
siteServer.close();
otherServer.close();
udp.close();
await done(null);
