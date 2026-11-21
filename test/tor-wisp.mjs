// Standalone backend test: node --test test/tor-wisp.mjs
// A fake SOCKS5 endpoint (no real Tor or public DNS) confirms that Wisp's
// original .onion hostname, not its local DNS validation placeholder, reaches
// SOCKS. TCP round trips work, while UDP and literal-IP dials fail closed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import {
	createServer as createHttpServer,
	request as httpRequest,
} from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';
import {
	openValidationDns,
	parseTorSocks5,
	probeTorSocks5,
	startTorWisp,
	validationDnsAnswer,
} from '../demo/torWisp.js';

const close = (server) => new Promise((resolve) => server.close(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (read, desired, ms = 5000) => {
	const limit = Date.now() + ms;
	let last;
	while (Date.now() < limit) {
		last = read();
		if (desired(last)) return last;
		await pause(20);
	}
	assert.fail(`Timed out waiting: ${JSON.stringify(last)}`);
};

function dnsQuestion(name, type, id = 0x1234) {
	const parts = name.split('.').map((part) => {
		const chars = Buffer.from(part, 'ascii');
		return Buffer.concat([Buffer.from([chars.length]), chars]);
	});
	return Buffer.concat([
		Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
		...parts,
		Buffer.from([0, type >> 8, type & 255, 0, 1]),
	]);
}

function fakeSocks({ replyHTTP = false } = {}) {
	const requests = [];
	const sockets = new Set();
	const server = createNetServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		let step = 0;
		let pending = Buffer.alloc(0);
		socket.on('error', () => {});
		socket.on('data', (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length) {
				if (step === 0) {
					if (pending.length < 3) return;
					assert.deepEqual([...pending.subarray(0, 3)], [5, 1, 0]);
					pending = pending.subarray(3);
					socket.write(Buffer.from([5, 0]));
					step = 1;
				} else if (step === 1) {
					if (pending.length < 5) return;
					assert.equal(pending[0], 5);
					assert.equal(pending[1], 1); // CONNECT, not UDP ASSOCIATE
					assert.equal(pending[3], 3); // ATYP=domain, not placeholder IP
					const length = pending[4];
					if (pending.length < 7 + length) return;
					const hostname = pending.toString('ascii', 5, 5 + length);
					const port = pending.readUInt16BE(5 + length);
					requests.push({ hostname, port });
					pending = pending.subarray(7 + length);
					socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
					step = 2;
				} else {
					// Echo or answer an HTTP request without any real egress.
					if (
						replyHTTP &&
						/^GET |^POST /i.test(pending.toString('ascii', 0, 5))
					)
						socket.write(
							'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok',
						);
					else socket.write(pending);
					pending = Buffer.alloc(0);
				}
			}
		});
	});
	return {
		server,
		requests,
		close: () => {
			for (const socket of sockets) socket.destroy();
			return close(server);
		},
	};
}

function wispPacket(type, stream, payload = Buffer.alloc(0)) {
	const header = Buffer.alloc(5);
	header[0] = type;
	header.writeUInt32LE(stream, 1);
	return Buffer.concat([header, payload]);
}

async function openWisp(url) {
	const ws = new WebSocket(url);
	const packets = [];
	ws.on('message', (chunk) => packets.push(Buffer.from(chunk)));
	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});
	return { ws, packets };
}

// Ensure a broken test never leaves its mock server / Tor relay resident.
const cleanups = [];
after(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

test('synthetic DNS preserves original question, answers A only, and never resolves local names', () => {
	const a = dnsQuestion('foo.onion', 1);
	const answer = validationDnsAnswer(a);
	assert.equal(answer.readUInt16BE(6), 1);
	assert.equal(answer.readUInt16BE(2), 0x8180);
	assert.equal(answer.subarray(12, a.length).compare(a.subarray(12)), 0);
	assert.deepEqual([...answer.subarray(-4)], [1, 1, 1, 1]);
	const aaaa = validationDnsAnswer(dnsQuestion('foo.onion', 28));
	assert.equal(aaaa.readUInt16BE(6), 0);
	assert.equal(aaaa.readUInt16BE(3) & 15, 0);
	const local = validationDnsAnswer(dnsQuestion('localhost', 1));
	assert.equal(local[3] & 15, 3);
	assert.equal(local.readUInt16BE(6), 0);
	assert.equal(validationDnsAnswer(Buffer.from([1, 2, 3])), null);
});

test('shim accepts only loopback UDP queries and does not forward', async () => {
	const dns = await openValidationDns();
	const client = createSocket('udp4');
	try {
		const query = dnsQuestion('hiddenservice.onion', 1, 0x9315);
		const response = await new Promise((resolve, reject) => {
			client.once('message', resolve);
			client.once('error', reject);
			client.send(query, Number(dns.address.split(':')[1]), '127.0.0.1');
		});
		assert.equal(response.readUInt16BE(0), 0x9315);
		assert.equal(response.readUInt16BE(6), 1);
	} finally {
		client.close();
		await dns.close();
	}
});

test('SOCKS endpoint must be loopback-only socks5h without credentials', () => {
	assert.equal(parseTorSocks5('socks5h://127.0.0.1:9050').port, 9050);
	for (const invalid of [
		'socks5://127.0.0.1:9050',
		'socks5h://1.1.1.1:9050',
		'socks5h://evil.com',
		'socks5h://user:pass@127.0.0.1:9050',
	])
		assert.throws(() => parseTorSocks5(invalid));
});

test('unreachable SOCKS is fail-closed and hides Tor endpoint', async () => {
	const ss = createNetServer();
	await new Promise((resolve) => ss.listen(0, '127.0.0.1', resolve));
	const port = ss.address().port;
	await close(ss);
	assert.equal(
		await startTorWisp({ socks5: `socks5h://127.0.0.1:${port}` }),
		null,
	);
});

test('real holyWisp uses fake SOCKS for .onion TCP; rejects UDP and IP literals', async () => {
	const socks = fakeSocks();
	await new Promise((resolve) => socks.server.listen(0, '127.0.0.1', resolve));
	cleanups.push(() => socks.close());
	const proxy = parseTorSocks5(
		`socks5h://127.0.0.1:${socks.server.address().port}`,
	);
	await probeTorSocks5(proxy);
	const tor = await startTorWisp({ socks5: proxy.url });
	assert.ok(
		tor?.relay?.isRunning,
		'Tor-backed Wisp must start with fake SOCKS available',
	);
	cleanups.push(async () => {
		tor.relay.kill();
		if (tor.dns.socket.address()) await tor.dns.close();
	});
	const questions = [];
	tor.dns.socket.on('message', (data) => questions.push(Buffer.from(data)));
	assert.equal(tor.relay.config.allowUDP, false);
	assert.equal(tor.relay.config.proxyUDP, 'refuse');
	assert.equal(tor.relay.config.allowDirectIP, false);
	assert.deepEqual(tor.relay.config.dnsServers, [tor.dns.address]);

	const http = createHttpServer();
	http.on('upgrade', (req, socket, head) => {
		if (req.url === '/wisp-tor/') tor.relay.route(req, socket, head);
		else socket.destroy();
	});
	await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
	cleanups.push(() => close(http));
	const { ws, packets } = await openWisp(
		`ws://127.0.0.1:${http.address().port}/wisp-tor/`,
	);
	cleanups.push(
		() =>
			new Promise((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) return resolve();
				ws.once('close', resolve);
				ws.close();
			}),
	);
	await waitUntil(
		() => packets,
		(seen) => seen.some((p) => p[0] === 3 && p.readUInt32LE(1) === 0),
	); // v1 opening CONTINUE
	const onion = Buffer.from('testhiddenservice.onion');
	ws.send(
		wispPacket(1, 1, Buffer.concat([Buffer.from([1, 0xbb, 0x01]), onion])),
	);
	await waitUntil(
		() => socks.requests,
		(req) => req.length === 1,
	);
	assert.deepEqual(socks.requests, [{ hostname: onion.toString(), port: 443 }]);
	assert.ok(
		questions.some(
			(q) =>
				q.includes(Buffer.from('testhiddenservice')) &&
				q.includes(Buffer.from('onion')),
		),
		'local DNS validation queried the .onion name',
	);
	// Wisp v1 has no per-stream open confirmation; the SOCKS reply suffices.
	ws.send(wispPacket(2, 1, Buffer.from('ping')));
	await waitUntil(
		() => packets,
		(seen) =>
			seen.some(
				(p) =>
					p[0] === 2 &&
					p.readUInt32LE(1) === 1 &&
					p.subarray(5).equals(Buffer.from('ping')),
			),
	);

	ws.send(
		wispPacket(
			1,
			2,
			Buffer.concat([Buffer.from([2, 0x35, 0x00]), Buffer.from('example.org')]),
		),
	);
	await waitUntil(
		() => packets,
		(seen) => seen.some((p) => p[0] === 4 && p.readUInt32LE(1) === 2),
	);
	ws.send(
		wispPacket(
			1,
			3,
			Buffer.concat([Buffer.from([1, 0x50, 0]), Buffer.from('127.0.0.1')]),
		),
	);
	await waitUntil(
		() => packets,
		(seen) => seen.some((p) => p[0] === 4 && p.readUInt32LE(1) === 3),
	);
	assert.equal(
		socks.requests.length,
		1,
		'neither UDP nor a literal IP reached SOCKS',
	);
});

test('demo config, separate scope and WebKit sync relay stay on Tor', async () => {
	const socks = fakeSocks({ replyHTTP: true });
	await new Promise((resolve) => socks.server.listen(0, '127.0.0.1', resolve));
	cleanups.push(() => socks.close());
	const proxy = `socks5h://127.0.0.1:${socks.server.address().port}`;
	const launchDemo = async (socks5) => {
		const child = spawn(process.execPath, ['demo/server.js'], {
			cwd: new URL('../', import.meta.url),
			env: {
				...process.env,
				PORT: '0',
				STOMP_WISP_URL: 'ws://127.0.0.1:1/wisp/',
				STOMP_WISP_WEBTRANSPORT: '0',
				STOMP_TOR_WISP_URL: '',
				STOMP_TOR_SOCKS5: socks5,
				STOMP_SYNC_RELAY: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const logs = [];
		let port = null;
		child.stdout.on('data', (data) => {
			logs.push(data.toString());
			const match = logs.join('').match(/http:\/\/localhost:(\d+)/);
			if (match) port = Number(match[1]);
		});
		child.stderr.on('data', (data) => logs.push(data.toString()));
		cleanups.push(async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill('SIGTERM');
			await new Promise((resolve) => child.once('close', resolve));
		});
		await waitUntil(
			() => ({ port, exited: child.exitCode, logs: logs.join('').slice(-900) }),
			(state) => !!state.port || state.exited !== null,
			12000,
		);
		assert.ok(port, `Demo failed to start: ${logs.join('')}`);
		return { child, url: `http://127.0.0.1:${port}/` };
	};

	const online = await launchDemo(proxy);
	const config = await (await fetch(`${online.url}config.js`)).text();
	assert.match(config, /"torWisp":"\/wisp-tor\/"/);
	assert.equal((await fetch(`${online.url}wisp-tor/`)).status, 426);
	assert.equal((await fetch(`${online.url}wisp/`)).status, 404); // no accidental alias
	// The Tor scope serves precisely the same build, but under a separate SW
	// registration path; a force reload and uncontrolled script route are
	// handled as for /stomp/.
	const [normalJs, torJs] = await Promise.all([
		fetch(`${online.url}stomp/serviceWorker.js`),
		fetch(`${online.url}stomp-tor/serviceWorker.js`),
	]);
	assert.equal(torJs.status, 200);
	assert.equal(torJs.headers.get('content-type')?.includes('javascript'), true);
	assert.equal(await torJs.text(), await normalJs.text());
	const script = await fetch(`${online.url}stomp-tor/any/js:abc/example`, {
		headers: { 'cache-control': 'no-cache' },
	});
	assert.equal(script.status, 200);
	assert.match(script.headers.get('content-type'), /javascript/);
	// Node fetch hardcodes Sec-Fetch-Mode:cors. Use raw HTTP to emulate a
	// browser's forced document reload with Sec-Fetch-Mode:navigate.
	const reload = await new Promise((resolve, reject) => {
		const req = httpRequest(
			`${online.url}stomp-tor/any/htmlxyz/site`,
			{
				headers: {
					'cache-control': 'no-cache',
					'sec-fetch-mode': 'navigate',
					'sec-fetch-dest': 'document',
				},
			},
			(res) => {
				const chunks = [];
				res.on('data', (data) => chunks.push(data));
				res.on('end', () =>
					resolve({
						status: res.statusCode,
						text: Buffer.concat(chunks).toString(),
					}),
				);
			},
		);
		req.on('error', reject);
		req.end();
	});
	assert.equal(reload.status, 404);
	assert.match(reload.text, /serviceWorker/);

	const before = socks.requests.length;
	const sync = await fetch(`${online.url}stomp-tor/sync-relay`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			url: 'http://sync.onion/probe',
			method: 'GET',
			headers: [],
			redirect: 'manual',
		}),
	});
	assert.equal(sync.status, 200);
	const answered = await sync.json();
	assert.equal(answered.status, 200);
	assert.equal(Buffer.from(answered.body, 'base64').toString(), 'ok');
	assert.deepEqual(socks.requests.slice(before), [
		{ hostname: 'sync.onion', port: 80 },
	]);
	online.child.kill('SIGTERM');
	await new Promise((resolve) => online.child.once('close', resolve));

	// No Tor daemon: do not expose a Tor relay or fall back to ordinary Wisp.
	const dead = createNetServer();
	await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
	const unavailable = dead.address().port;
	await close(dead);
	const offline = await launchDemo(`socks5h://127.0.0.1:${unavailable}`);
	const unavailableConfig = await (
		await fetch(`${offline.url}config.js`)
	).text();
	assert.doesNotMatch(unavailableConfig, /torWisp/);
	assert.equal((await fetch(`${offline.url}wisp-tor/`)).status, 503);
	const refused = await fetch(`${offline.url}stomp-tor/sync-relay`, {
		method: 'POST',
		body: '{}',
	});
	assert.equal(refused.status, 503);
	assert.match((await refused.json()).error, /unavailable/);
});
