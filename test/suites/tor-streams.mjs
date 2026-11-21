// Tor mode's plumbing on Tor streams, without Tor: epoxy over the Wisp
// server Tor mode runs in its transport worker
// (demo/public/tor-client/wispServer.mjs), each stream relayed over a
// MessagePort as the shared Tor client relays its streams to a tab
// (streamPort.mjs). The streams are TCP through the demo's /wisp/ to the
// fixture, standing in for TorClient.connect (which needs the Tor network:
// test/tor-client-smoke.mjs). Checked: a page, an upload and a download
// larger than the windows each way, requests together, a WebSocket, a
// refused UDP stream and a port nothing listens on.
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, FIXTURE, HOST, launch, ok, PORT } from '../lib.mjs';

const BIG = 'pages/vendor-three.min.js';
const bigBytes = statSync(
	fileURLToPath(new URL(`../${BIG}`, import.meta.url)),
).size;

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`${HOST}config.js`);

const results = await page.evaluate(
	async ({ wisp, fixture, big }) => {
		const { default: Epoxy } = await import('/epoxy/index.mjs');
		const { wispServer } = await import('/tor-client/wispServer.mjs');
		const { serveStream, streamOverPort } =
			await import('/tor-client/streamPort.mjs');
		// TCP over the demo's wisp, as `{ readable, writable }`: what
		// TorClient.connect gives
		const tcp = (url) => {
			const ws = new WebSocket(url);
			ws.binaryType = 'arraybuffer';
			const ready = new Promise((resolve, reject) => {
				ws.onopen = resolve;
				ws.onerror = reject;
			});
			const streams = new Map();
			let next = 1;
			const packet = (type, id, payload) => {
				const out = new Uint8Array(5 + payload.byteLength);
				out[0] = type;
				new DataView(out.buffer).setUint32(1, id, true);
				out.set(payload, 5);
				return out;
			};
			// what the wisp server lets a new stream send before its CONTINUE
			let initial = 32;
			ws.onmessage = ({ data }) => {
				const view = new DataView(data);
				if (view.getUint8(0) === 3 && view.getUint32(1, true) === 0)
					initial = view.getUint32(5, true);
				const stream = streams.get(view.getUint32(1, true));
				if (!stream) return;
				const type = view.getUint8(0);
				if (type === 2) stream.controller.enqueue(new Uint8Array(data, 5));
				else if (type === 3) {
					stream.credit = view.getUint32(5, true);
					stream.wake?.();
				} else if (type === 4) {
					streams.delete(view.getUint32(1, true));
					try {
						stream.controller.close();
					} catch {
						// cancelled
					}
				}
			};
			return async (host, port) => {
				await ready;
				const id = next++;
				const stream = { credit: initial };
				streams.set(id, stream);
				const name = new TextEncoder().encode(host);
				const connect = new Uint8Array(3 + name.byteLength);
				connect[0] = 1;
				new DataView(connect.buffer).setUint16(1, port, true);
				connect.set(name, 3);
				ws.send(packet(1, id, connect));
				const close = () => {
					if (streams.delete(id)) ws.send(packet(4, id, new Uint8Array([2])));
				};
				return {
					readable: new ReadableStream({
						start: (controller) => (stream.controller = controller),
						cancel: close,
					}),
					writable: new WritableStream({
						async write(chunk) {
							for (let at = 0; at < chunk.byteLength; at += 60000) {
								while (stream.credit <= 0)
									await new Promise((resolve) => (stream.wake = resolve));
								stream.credit--;
								ws.send(packet(2, id, chunk.subarray(at, at + 60000)));
							}
						},
						close,
						abort: close,
					}),
				};
			};
		};
		const open = tcp(wisp);
		let opened = 0;
		// each stream relayed over a port, as shared.mjs relays the Tor client's
		const relayed = async (host, port) => {
			opened++;
			const stream = await open(host, port);
			const { port1, port2 } = new MessageChannel();
			serveStream(stream, port1);
			return streamOverPort(port2);
		};
		const server = wispServer(relayed);
		const epoxy = new Epoxy({ wisp: server });
		await epoxy.init();
		const timed = (promise, ms = 20000) =>
			Promise.race([
				promise,
				new Promise((resolve) => setTimeout(() => resolve('HUNG'), ms)),
			]);
		const get = (path, init = {}) =>
			timed(
				epoxy
					.request(
						new URL(path, fixture),
						init.method ?? 'GET',
						init.body ?? null,
						init.headers ?? [],
						undefined,
					)
					.then(async (response) => ({
						status: response.status,
						bytes: (await new Response(response.body).arrayBuffer()).byteLength,
					})),
			).catch((error) => `failed: ${error?.message ?? error}`);
		const out = {};
		out.page = await get('pages/walk-1.html');
		out.download = await get(big);
		const upload = new Uint8Array(3 * 1024 * 1024);
		for (let i = 0; i < upload.length; i += 4096) upload[i] = i & 0xff;
		out.upload = await timed(
			epoxy
				.request(
					new URL('echo-body', fixture),
					'POST',
					upload,
					[['content-type', 'application/octet-stream']],
					undefined,
				)
				.then((response) => new Response(response.body).json()),
		).catch((error) => `failed: ${error?.message ?? error}`);
		out.together = await Promise.all(
			['walk-1', 'walk-2', 'walk-3', 'walk-4'].map((name) =>
				get(`pages/${name}.html?together`).then((r) => r.status ?? r),
			),
		);
		out.socket = await timed(
			new Promise((resolve) => {
				const said = [];
				epoxy.connect(
					new URL('ws-echo', fixture.replace('http:', 'ws:')),
					[],
					[],
					() => {},
					(data) => said.push(typeof data === 'string' ? data : 'binary'),
					(code) => resolve({ code, said }),
					(error) => resolve({ error: String(error), said }),
				);
			}),
		);
		// a UDP stream on the Wisp server: CLOSE, reason 0x48 (blocked)
		const { read, write } = await server();
		const reader = read.getReader();
		await reader.read(); // the CONTINUE for stream 0
		const writer = write.getWriter();
		const udp = new Uint8Array([
			1,
			9,
			0,
			0,
			0,
			2,
			53,
			0,
			...new TextEncoder().encode('127.0.0.1'),
		]);
		await writer.write(udp);
		const answer = new Uint8Array(
			await timed(
				reader.read().then(({ value }) => value),
				5000,
			),
		);
		out.udp = Array.from(answer);
		reader.cancel();
		out.closedPort = await get('http://127.0.0.1:1/', {});
		out.opened = opened;
		return out;
	},
	{ wisp: `ws://127.0.0.1:${PORT}/wisp/`, fixture: FIXTURE, big: BIG },
);

ok(
	'a page loads through epoxy on relayed streams',
	results.page?.status === 200 && results.page.bytes > 0,
	JSON.stringify(results.page),
);
ok(
	'a download larger than the windows arrives whole',
	results.download?.status === 200 && results.download.bytes === bigBytes,
	`${JSON.stringify(results.download)} (the file has ${bigBytes})`,
);
ok(
	'an upload larger than the windows arrives whole',
	results.upload?.bytes === 3 * 1024 * 1024,
	JSON.stringify(results.upload),
);
ok(
	'requests started together all answer',
	results.together.every((status) => status === 200),
	JSON.stringify(results.together),
);
ok(
	'a WebSocket opens, hears the server and closes',
	results.socket?.said?.length === 1 && results.socket.code !== undefined,
	JSON.stringify(results.socket),
);
ok(
	'a UDP stream is refused: CLOSE with reason 0x48',
	results.udp?.[0] === 4 && results.udp[1] === 9 && results.udp[5] === 0x48,
	JSON.stringify(results.udp),
);
ok(
	'a port nothing listens on fails the request, not hangs it',
	typeof results.closedPort === 'string' &&
		results.closedPort.startsWith('failed'),
	JSON.stringify(results.closedPort),
);

await done(browser);
