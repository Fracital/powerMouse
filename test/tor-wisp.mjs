// Standalone backend test: node --test test/tor-wisp.mjs
// A fake SOCKS5 endpoint (no real Tor or public DNS) confirms that Wisp's
// original .onion hostname, not its local DNS validation placeholder, reaches
// SOCKS. TCP round trips work, while UDP and literal-IP dials fail closed.
// A fake Tor control port drives the readiness monitor through down,
// bootstrapping, ready and back (reconnect), and the demo server's relay
// takes connections only while Tor is ready.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
	createServer as createHttpServer,
	request as httpRequest,
} from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';
import {
	blockedTorName,
	createTorMonitor,
	openTorControl,
	openValidationDns,
	parseBootstrapPhase,
	parseTorControl,
	parseTorEvent,
	parseTorProbe,
	parseTorSocks5,
	probeTorCircuit,
	probeTorSocks5,
	queryTorControl,
	startTorWisp,
	validationDnsAnswer,
} from '../demo/torWisp.js';
import { fakeControl } from './torFakes.mjs';

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

function fakeSocks({ replyHTTP = false, refuse = () => false } = {}) {
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
					if (refuse(hostname)) {
						// host unreachable, as Tor answers without a circuit
						socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
						return;
					}
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
		listen: (port = 0) =>
			new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, '127.0.0.1', () => {
					server.off('error', reject);
					resolve(server.address().port);
				});
			}),
		close: () => {
			for (const socket of sockets) socket.destroy();
			return server.listening ? close(server) : Promise.resolve();
		},
	};
}

// a port nothing listens on, for now
async function freePort() {
	const probe = createNetServer();
	await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const { port } = probe.address();
	await close(probe);
	return port;
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
	// a relay that drops the connection later is what some checks wait for
	ws.on('error', () => {});
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

test('unreachable SOCKS is fail-closed: the relay runs but says Tor is down', async () => {
	const port = await freePort();
	const tor = await startTorWisp({ socks5: `socks5h://127.0.0.1:${port}` });
	try {
		assert.equal(tor.monitor.snapshot().state, 'down');
		assert.equal(tor.monitor.accepting(), false);
	} finally {
		tor.monitor.stop();
		tor.relay.kill();
		await tor.dns.close();
	}
});

test('a malformed STOMP_TOR_SOCKS5 warns and leaves Tor off instead of crashing', async () => {
	const warnings = [];
	const warn = console.warn;
	console.warn = (...args) => warnings.push(args.join(' '));
	try {
		for (const value of [
			'not a url',
			'socks5h://127.0.0.1:notaport',
			'socks5h://127.0.0.1:70000',
			'socks5://127.0.0.1:9050',
			'socks5h://1.1.1.1:9050',
		]) {
			warnings.length = 0;
			assert.equal(await startTorWisp({ socks5: value }), null, value);
			assert.equal(warnings.length, 1, value);
			assert.match(warnings[0], /^Tor Wisp disabled: STOMP_TOR_SOCKS5 must be/);
		}
	} finally {
		console.warn = warn;
	}
});

test('names, probe targets and control addresses are checked', () => {
	for (const name of [
		'localhost',
		'a.localhost',
		'printer.local',
		'router',
		'x.internal',
		'foo.exit',
		'x.noconnect',
		'1.0.0.127.in-addr.arpa',
		'0x7f.1',
		'127.0.0.1',
		'site.test',
	])
		assert.equal(blockedTorName(name), true, name);
	for (const name of ['example.com', 'abc.onion', 'check.torproject.org'])
		assert.equal(blockedTorName(name), false, name);
	assert.equal(
		validationDnsAnswer(dnsQuestion('router', 1))[3] & 15,
		3,
		'a single-label name is NXDOMAIN',
	);
	assert.deepEqual(parseTorProbe('Check.TorProject.org:443'), {
		host: 'check.torproject.org',
		port: 443,
	});
	for (const invalid of ['1.1.1.1:443', 'localhost:80', 'example.com', 'a.b:0'])
		assert.throws(() => parseTorProbe(invalid), invalid);
	assert.deepEqual(parseTorControl('127.0.0.1:9051'), {
		host: '127.0.0.1',
		port: 9051,
	});
	assert.deepEqual(parseTorControl('unix:/run/tor/control'), {
		path: '/run/tor/control',
	});
	for (const invalid of ['10.0.0.1:9051', 'unix:relative', 'tor:9051'])
		assert.throws(() => parseTorControl(invalid), invalid);
	assert.deepEqual(
		parseBootstrapPhase(
			'NOTICE BOOTSTRAP PROGRESS=45 TAG=loading_descriptors SUMMARY="Loading relay \\"descriptors\\""',
		),
		{
			progress: 45,
			tag: 'loading_descriptors',
			summary: 'Loading relay "descriptors"',
			warning: false,
		},
	);
	assert.equal(parseBootstrapPhase('NOTICE BOOTSTRAP TAG=x'), null);
});

test('control port: NULL, password and SAFECOOKIE authentication, never plain COOKIE', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tor-control-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const cookie = {
		path: join(dir, 'control.authcookie'),
		bytes: Buffer.alloc(32, 9),
	};
	writeFileSync(cookie.path, cookie.bytes);
	for (const [options, query] of [
		[{ method: 'NULL' }, {}],
		[
			{ method: 'HASHEDPASSWORD', password: 's3cr"et' },
			{ password: 's3cr"et' },
		],
		[{ method: 'COOKIE,SAFECOOKIE', cookie }, {}],
	]) {
		const control = fakeControl(options);
		const port = await control.listen();
		control.tor.progress = 100;
		control.tor.circuit = true;
		const phase = await queryTorControl({ host: '127.0.0.1', port }, query);
		assert.equal(phase.progress, 100, options.method);
		assert.equal(phase.circuit, true);
		assert.equal(phase.summary, 'Done');
		await control.close();
	}
	// a port that only offers COOKIE would be handed the file's bytes: refused
	const plain = fakeControl({ method: 'COOKIE', cookie });
	const plainPort = await plain.listen();
	await assert.rejects(
		queryTorControl({ host: '127.0.0.1', port: plainPort }),
		/no usable control authentication/,
	);
	assert.ok(!plain.tor.seen.includes('AUTHENTICATE'));
	await plain.close();
	// a port that does not know the cookie fails its own proof
	const impostor = fakeControl({
		method: 'SAFECOOKIE',
		cookie: { path: cookie.path, bytes: Buffer.alloc(32, 1) },
	});
	const impostorPort = await impostor.listen();
	await assert.rejects(
		queryTorControl({ host: '127.0.0.1', port: impostorPort }),
		/does not know the cookie/,
	);
	assert.ok(!impostor.tor.seen.includes('AUTHENTICATE'));
	await impostor.close();
	// a wrong password is a failure, not a hang
	const wrong = fakeControl({ method: 'HASHEDPASSWORD', password: 'right' });
	const wrongPort = await wrong.listen();
	await assert.rejects(
		queryTorControl(
			{ host: '127.0.0.1', port: wrongPort },
			{ password: 'nope' },
		),
		/authentication failed/,
	);
	await wrong.close();
	// a control port that never answers is bounded
	const silent = createNetServer((socket) => socket.on('error', () => {}));
	await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
	const started = Date.now();
	await assert.rejects(
		queryTorControl(
			{ host: '127.0.0.1', port: silent.address().port },
			{ timeoutMs: 300 },
		),
		/timed out/,
	);
	assert.ok(Date.now() - started < 2000);
	silent.close();
});

test('monitor through the control port: down, bootstrapping, ready, down, ready again', async () => {
	const socksPort = await freePort();
	const socks = fakeSocks();
	cleanups.push(() => socks.close());
	const control = fakeControl();
	const controlPort = await control.listen();
	cleanups.push(() => control.close());
	const changes = [];
	const monitor = createTorMonitor({
		socks: { host: '127.0.0.1', port: socksPort },
		control: { host: '127.0.0.1', port: controlPort },
		fastMs: 50,
		slowMs: 50,
		minMs: 0,
		log: () => {},
	});
	cleanups.push(() => monitor.stop());
	monitor.on('change', (snapshot) => changes.push(snapshot.state));
	await monitor.check();
	assert.equal(monitor.snapshot().state, 'down');
	assert.equal(monitor.accepting(), false);

	await socks.listen(socksPort);
	control.tor.progress = 45;
	let state = await waitUntil(
		monitor.snapshot,
		(s) => s.state === 'bootstrapping',
	);
	assert.equal(state.progress, 45);
	assert.equal(state.summary, 'Loading relay descriptors');
	assert.equal(monitor.accepting(), false);

	// 100% but no circuit (the network went away) is not ready
	control.tor.progress = 100;
	state = await waitUntil(
		monitor.snapshot,
		(s) => s.summary === 'No Tor circuit established',
	);
	assert.equal(state.state, 'bootstrapping');
	control.tor.circuit = true;
	state = await waitUntil(monitor.snapshot, (s) => s.state === 'ready');
	assert.equal(state.progress, 100);
	assert.equal(state.via, 'control');
	assert.equal(monitor.accepting(), true);

	// what it knows comes from Tor's events on one connection: nothing is
	// asked again while it is open, however often the page asks
	assert.ok(control.tor.seen.includes('SETEVENTS'));
	const connections = control.tor.connections;
	const seen = control.tor.seen.length;
	for (let i = 0; i < 50; i++) monitor.refresh();
	await pause(400);
	assert.equal(control.tor.connections, connections, 'one connection');
	assert.equal(control.tor.seen.length, seen, 'no command while it is open');
	// an event says the circuit is gone, and another that it is back
	control.tor.circuit = false;
	await waitUntil(monitor.snapshot, (s) => s.state === 'bootstrapping');
	control.tor.circuit = true;
	await waitUntil(monitor.snapshot, (s) => s.state === 'ready');
	// the SOCKS listener goes while the control port still speaks: its
	// greeting (local, no circuit) says so
	await socks.close();
	await waitUntil(monitor.snapshot, (s) => s.state === 'down', 1000);
	assert.equal(monitor.accepting(), false);
	await socks.listen(socksPort);
	await waitUntil(monitor.snapshot, (s) => s.state === 'ready');
	assert.equal(control.tor.connections, connections, 'the same connection');
	// Tor stops (its control connection closes with it): down at once, and
	// back again when it starts
	await socks.close();
	await control.close();
	await waitUntil(monitor.snapshot, (s) => s.state === 'down', 1000);
	await socks.listen(socksPort);
	await control.listen(controlPort);
	await waitUntil(monitor.snapshot, (s) => s.state === 'ready');
	assert.deepEqual(
		changes.filter((s, i) => s !== changes[i - 1]),
		[
			'down',
			'bootstrapping',
			'ready',
			'bootstrapping',
			'ready',
			'down',
			'ready',
			'down',
			'ready',
		],
	);
});

test('control events: bootstrap, circuit and network liveness parse', () => {
	assert.deepEqual(
		parseTorEvent(
			'650 STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=85 TAG=ap_conn SUMMARY="Connecting to a relay to build circuits"',
		),
		{ progress: 85, summary: 'Connecting to a relay to build circuits' },
	);
	assert.deepEqual(
		parseTorEvent('650 STATUS_CLIENT NOTICE CIRCUIT_ESTABLISHED'),
		{ circuit: true },
	);
	assert.deepEqual(
		parseTorEvent(
			'650 STATUS_CLIENT NOTICE CIRCUIT_NOT_ESTABLISHED REASON=CLOCK_JUMPED',
		),
		{ circuit: false },
	);
	assert.deepEqual(parseTorEvent('650 NETWORK_LIVENESS DOWN'), {
		live: false,
	});
	assert.equal(parseTorEvent('650 STATUS_GENERAL NOTICE CLOCK_SKEW'), null);
});

test('control connection: the network going away and coming back', async () => {
	const control = fakeControl();
	const port = await control.listen();
	cleanups.push(() => control.close());
	control.tor.progress = 100;
	control.tor.circuit = true;
	const session = await openTorControl({ host: '127.0.0.1', port });
	cleanups.push(() => session.close());
	assert.equal(session.phase.circuit, true);
	control.tor.live = false;
	await waitUntil(
		() => session.phase,
		(phase) => phase.circuit === false && phase.live === false,
	);
	control.tor.live = true;
	await waitUntil(
		() => session.phase,
		(phase) => phase.circuit === true && phase.live === true,
	);
	const closed = new Promise((resolve) => session.once('close', resolve));
	await control.close();
	await closed;
});

test('monitor without a control port: a CONNECT through SOCKS proves a circuit', async () => {
	let circuits = false;
	const socks = fakeSocks({ refuse: () => !circuits });
	const port = await socks.listen();
	cleanups.push(() => socks.close());
	const probe = parseTorProbe('probe.torproject.org:443');
	await assert.rejects(
		probeTorCircuit({ host: '127.0.0.1', port }, probe, 2000),
		/reply 4/,
	);
	const monitor = createTorMonitor({
		socks: { host: '127.0.0.1', port },
		probe,
		fastMs: 50,
		slowMs: 50,
		probeFastMs: 50,
		probeSlowMs: 50,
		minMs: 0,
		log: () => {},
	});
	cleanups.push(() => monitor.stop());
	await monitor.check();
	await waitUntil(
		monitor.snapshot,
		(s) => s.summary === 'Waiting for a Tor circuit',
	);
	assert.equal(monitor.snapshot().state, 'bootstrapping');
	circuits = true;
	await waitUntil(monitor.snapshot, (s) => s.state === 'ready');
	assert.equal(monitor.snapshot().via, 'probe');
	assert.ok(
		socks.requests.every(
			(r) => r.hostname === 'probe.torproject.org' && r.port === 443,
		),
	);
	// one failed probe of a working Tor is not an outage; two are
	circuits = false;
	await waitUntil(monitor.snapshot, (s) => s.state === 'bootstrapping');
	circuits = true;
	await waitUntil(monitor.snapshot, (s) => s.state === 'ready');
	// with the probe turned off Tor answering is all it knows
	const blind = createTorMonitor({
		socks: { host: '127.0.0.1', port },
		log: () => {},
	});
	await blind.check();
	blind.stop();
	assert.equal(blind.snapshot().state, 'unknown');
	assert.equal(blind.accepting(), true);
});

test('monitor without a control port: traffic is the signal, the probe runs when idle or after failures', async () => {
	let circuits = true;
	const socks = fakeSocks({ refuse: () => !circuits });
	const port = await socks.listen();
	cleanups.push(() => socks.close());
	const counters = { out: 0, streams: 0 };
	let flowing = false;
	let stalling = false;
	const monitor = createTorMonitor({
		socks: { host: '127.0.0.1', port },
		probe: parseTorProbe('probe.torproject.org:443'),
		traffic: async () => {
			if (flowing) counters.out += 100;
			if (flowing || stalling) counters.streams++;
			return { ...counters };
		},
		fastMs: 30,
		slowMs: 30,
		probeFastMs: 60,
		probeSlowMs: 600,
		stallMs: 200,
		minMs: 0,
		log: () => {},
	});
	cleanups.push(() => monitor.stop());
	await monitor.check();
	// nothing known: probed at once
	await waitUntil(monitor.snapshot, (s) => s.state === 'ready');
	assert.equal(monitor.probes(), 1);
	// traffic flows: no probe, however long
	flowing = true;
	await waitUntil(monitor.snapshot, (s) => s.via === 'traffic');
	const probes = monitor.probes();
	await pause(900);
	assert.equal(monitor.probes(), probes, 'no probe while traffic flows');
	assert.equal(monitor.snapshot().state, 'ready');
	// idle: one probe after probeSlowMs
	flowing = false;
	await waitUntil(
		() => monitor.probes(),
		(count) => count > probes,
		2000,
	);
	// streams that get nothing back while circuits fail: probed, and two
	// failures are an outage
	circuits = false;
	stalling = true;
	await waitUntil(monitor.snapshot, (s) => s.state === 'bootstrapping', 3000);
	// traffic again is Tor working again
	stalling = false;
	circuits = true;
	flowing = true;
	await waitUntil(monitor.snapshot, (s) => s.state === 'ready', 3000);
	assert.ok(socks.requests.every((r) => r.hostname === 'probe.torproject.org'));
});

test('real holyWisp uses fake SOCKS for .onion TCP; rejects UDP and IP literals', async () => {
	const socks = fakeSocks();
	await new Promise((resolve) => socks.server.listen(0, '127.0.0.1', resolve));
	cleanups.push(() => socks.close());
	const proxy = parseTorSocks5(
		`socks5h://127.0.0.1:${socks.server.address().port}`,
	);
	await probeTorSocks5(proxy);
	const tor = await startTorWisp({ socks5: proxy.url, probe: 'off' });
	assert.ok(
		tor?.relay?.isRunning,
		'Tor-backed Wisp must start with fake SOCKS available',
	);
	cleanups.push(async () => {
		tor.monitor.stop();
		tor.relay.kill();
		// already closed when the relay's cleanup ran first
		await tor.dns.close().catch(() => {});
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
	// the browser's blocked ports and local or numeric names never reach Tor
	let stream = 4;
	for (const [port, name] of [
		[25, 'mail.example.com'],
		[22, 'ssh.example.com'],
		[443, 'printer.local'],
		[443, 'intranet'],
		[443, '0x7f.1'],
	]) {
		const id = stream++;
		ws.send(
			wispPacket(
				1,
				id,
				Buffer.concat([
					Buffer.from([1, port & 255, port >> 8]),
					Buffer.from(name),
				]),
			),
		);
		await waitUntil(
			() => packets,
			(seen) => seen.some((p) => p[0] === 4 && p.readUInt32LE(1) === id),
		);
	}
	assert.equal(
		socks.requests.length,
		1,
		'neither UDP, a literal IP, a blocked port nor a local name reached SOCKS',
	);
});

async function launchDemo(socks5, extra = {}) {
	const child = spawn(process.execPath, ['demo/server.js'], {
		cwd: new URL('../', import.meta.url),
		env: {
			...process.env,
			PORT: '0',
			STOMP_WISP_URL: 'ws://127.0.0.1:1/wisp/',
			STOMP_WISP_WEBTRANSPORT: '0',
			STOMP_TOR_WISP_URL: '',
			STOMP_TOR_SOCKS5: socks5,
			STOMP_TOR_CONTROL: '',
			STOMP_TOR_PROBE: 'off',
			STOMP_SYNC_RELAY: '1',
			...extra,
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
	return { child, logs, url: `http://127.0.0.1:${port}/` };
}

test('demo config, separate scope and WebKit sync relay stay on Tor', async () => {
	const socks = fakeSocks({ replyHTTP: true });
	await new Promise((resolve) => socks.server.listen(0, '127.0.0.1', resolve));
	cleanups.push(() => socks.close());
	const proxy = `socks5h://127.0.0.1:${socks.server.address().port}`;

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

	// No Tor daemon: the relay is configured (the page says Tor is down) but
	// takes no connection, and nothing falls back to ordinary Wisp.
	const unavailable = await freePort();
	const offline = await launchDemo(`socks5h://127.0.0.1:${unavailable}`);
	const unavailableConfig = await (
		await fetch(`${offline.url}config.js`)
	).text();
	assert.match(unavailableConfig, /"torWisp":"\/wisp-tor\/"/);
	const status = await (await fetch(`${offline.url}api/tor`)).json();
	assert.equal(status.state, 'down');
	assert.equal(status.summary, 'Tor is not running');
	assert.doesNotMatch(
		JSON.stringify(status),
		new RegExp(`127\\.0\\.0\\.1|socks5h|${unavailable}`),
	);
	assert.equal((await fetch(`${offline.url}wisp-tor/`)).status, 503);
	await assert.rejects(
		openWisp(`${offline.url.replace('http', 'ws')}wisp-tor/`),
		/503/,
	);
	const refused = await fetch(`${offline.url}stomp-tor/sync-relay`, {
		method: 'POST',
		body: '{}',
	});
	assert.equal(refused.status, 503);
	assert.match((await refused.json()).error, /unavailable/);
});

test('demo relay refuses until Tor is ready, drops its connections when Tor goes, and recovers', async () => {
	const socksPort = await freePort();
	const socks = fakeSocks();
	cleanups.push(() => socks.close());
	const control = fakeControl({
		method: 'HASHEDPASSWORD',
		password: 'pw-not-logged',
	});
	const controlPort = await control.listen();
	cleanups.push(() => control.close());
	const demo = await launchDemo(`socks5h://127.0.0.1:${socksPort}`, {
		STOMP_TOR_CONTROL: `127.0.0.1:${controlPort}`,
		STOMP_TOR_CONTROL_PASSWORD: 'pw-not-logged',
	});
	const wispURL = `${demo.url.replace('http', 'ws')}wisp-tor/`;
	const status = async () => (await fetch(`${demo.url}api/tor`)).json();
	const until = async (want) => {
		const limit = Date.now() + 10000;
		let last;
		while (Date.now() < limit) {
			last = await status();
			if (want(last)) return last;
			await pause(100);
		}
		assert.fail(`Timed out waiting: ${JSON.stringify(last)}`);
	};
	assert.equal((await status()).state, 'down');
	await assert.rejects(openWisp(wispURL), /503/);

	await socks.listen(socksPort);
	control.tor.progress = 60;
	let state = await until((s) => s.state === 'bootstrapping');
	assert.equal(state.progress, 60);
	await assert.rejects(openWisp(wispURL), /503/);
	assert.equal(
		(
			await fetch(`${demo.url}stomp-tor/sync-relay`, {
				method: 'POST',
				body: '{}',
			})
		).status,
		503,
	);

	control.tor.progress = 100;
	control.tor.circuit = true;
	state = await until((s) => s.state === 'ready');
	assert.equal(state.via, 'control');
	const first = await openWisp(wispURL);
	const closed = new Promise((resolve) => first.ws.once('close', resolve));
	first.ws.send(
		wispPacket(
			1,
			1,
			Buffer.concat([Buffer.from([1, 80, 0]), Buffer.from('up.onion')]),
		),
	);
	await waitUntil(
		() => socks.requests,
		(r) => r.some((q) => q.hostname === 'up.onion'),
	);

	// Tor goes away (its SOCKS and control ports with it): its connections
	// close at once, new ones are refused
	await socks.close();
	await control.close();
	await until((s) => s.state === 'down');
	await closed;
	await assert.rejects(openWisp(wispURL), /503/);

	// and comes back: no restart of the server, a new connection works
	await socks.listen(socksPort);
	await control.listen(controlPort);
	await until((s) => s.state === 'ready');
	const again = await openWisp(wispURL);
	again.ws.send(
		wispPacket(
			1,
			1,
			Buffer.concat([Buffer.from([1, 80, 0]), Buffer.from('back.onion')]),
		),
	);
	await waitUntil(
		() => socks.requests,
		(r) => r.some((q) => q.hostname === 'back.onion'),
	);
	again.ws.close();
	assert.doesNotMatch(demo.logs.join(''), /pw-not-logged/);
	assert.match(demo.logs.join(''), /Tor: ready \(control\)/);
	demo.child.kill('SIGTERM');
	await new Promise((resolve) => demo.child.once('close', resolve));
});
