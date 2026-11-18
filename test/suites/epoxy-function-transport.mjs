// epoxy with a function transport (`wisp` a function that hands it a
// ReadableStream and a WritableStream of Wisp packets, as the WebTransport
// carrier does, src/transport/wispWebTransport.ts) answers requests started
// together, one of them over TLS. Here the function hands it the demo's wisp
// WebSocket, written synchronously or after a macrotask, and the
// TLS requests go to a host the wisp server refuses, beside plain requests to
// the fixture.
//
// Before deploy/epoxy's epoxy-tls 0075 the function transport's sink waited
// on the stream's promises while holding wisp-mux's lock; rustls's handshake
// polls its flush once, so the lock stayed held while the actor waited on it
// to send the next stream's CONNECT and read nothing, and every request on
// the connection hung (only the first stream's CONNECT and ClientHello went
// out). The same requests in sequence, or the WebSocket handed as a URL,
// answered.
import { done, FIXTURE, launch, ok, PORT, PROXY } from '../lib.mjs';

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`${PROXY}stomp/controllerFrame.html`);

for (const write of ['sync', 'macrotask']) {
	const results = await page.evaluate(
		async ({ wisp, fixture, write }) => {
			const { default: Epoxy } = await import('/epoxy/index.mjs');
			const pipe = () =>
				new Promise((resolve, reject) => {
					const ws = new WebSocket(wisp);
					ws.binaryType = 'arraybuffer';
					let readable;
					const read = new ReadableStream({
						start: (controller) => (readable = controller),
					});
					ws.onmessage = (event) => readable.enqueue(event.data);
					ws.onclose = () => readable.close();
					const channel = new MessageChannel();
					const waiting = [];
					channel.port1.onmessage = () => waiting.shift()();
					const macrotask = () =>
						new Promise((done) => {
							waiting.push(done);
							channel.port2.postMessage(0);
						});
					const sink =
						write === 'sync'
							? { write: (packet) => ws.send(packet) }
							: {
									async write(packet) {
										ws.send(packet);
										await macrotask();
									},
								};
					ws.onopen = () => resolve({ read, write: new WritableStream(sink) });
					ws.onerror = reject;
				});
			const epoxy = new Epoxy({ wisp: pipe });
			await epoxy.init();
			const get = (url) =>
				Promise.race([
					epoxy
						.request(new URL(url), 'GET', null, [], undefined)
						.then(async (r) => {
							await new Response(r.body).arrayBuffer();
							return `status ${r.status}`;
						}),
					new Promise((done) => setTimeout(() => done('HUNG'), 8000)),
				]).catch(() => 'failed');
			const together = await Promise.all([
				get('https://a.refused.invalid/'),
				get(`${fixture}pages/walk-1.html?beside-tls`),
				get(`${fixture}pages/walk-2.html?beside-tls`),
			]);
			const tlsTogether = await Promise.all([
				get('https://b.refused.invalid/'),
				get('https://c.refused.invalid/'),
			]);
			const after = await get(`${fixture}pages/walk-3.html?after-tls`);
			return { together, tlsTogether, after };
		},
		{ wisp: `ws://127.0.0.1:${PORT}/wisp/`, fixture: FIXTURE, write },
	);
	ok(
		`${write} writes: a TLS request fails and two plain ones started with it answer`,
		JSON.stringify(results.together) ===
			JSON.stringify(['failed', 'status 200', 'status 200']),
		JSON.stringify(results.together),
	);
	ok(
		`${write} writes: two TLS requests started together both fail, not hang`,
		results.tlsTogether.every((r) => r === 'failed'),
		JSON.stringify(results.tlsTogether),
	);
	ok(
		`${write} writes: the connection answers after them`,
		results.after === 'status 200',
		results.after,
	);
}

await done(browser);
