// WebRTC through the proxy is STomp's own stack over wisp
// (docs/webrtc-over-wisp.md): a page's RTCPeerConnection is a stand-in, and
// every packet of its connections leaves from the wisp server, as the page's
// fetches do. The browser's own RTCPeerConnection sends its packets itself,
// from the user's address, so a proxied page must never get one to send
// anything, and must never learn this machine's addresses.
// test/pages/webrtc.html runs the probes natively (the control: the browser's
// own sockets reach the fixtures) and through the proxy in both demo modes,
// in a browser that shows host candidates as mDNS names and in one that
// shows their real addresses (the proxy origin granted media access):
// - the fixtures (a STUN server that answers, a TURN server and a remote
//   candidate that only listen) do hear packets now, from the demo's wisp
//   server, which shares this machine with them. What they must never hear
//   is a socket of the browser's: the suite samples which process owns
//   which local port while the probes run (ss), and a packet from a port
//   the browser owned fails the check, whatever the page does: a pool,
//   setConfiguration, relay only, every realm it can reach;
// - nothing the page reads (candidate events, descriptions, stats, the ICE
//   transport, icecandidateerror) holds one of this machine's addresses. Its
//   own host candidates are names; a reflexive candidate is the wisp
//   server's address as the STUN server saw it (loopback here, the edge's in
//   a deployment); remote candidates read back as the page gave them;
// - the configuration, the icecandidateerror for an unreachable server, the
//   errors of bad calls and the API surface read as they do natively;
// - a data channel still opens between two connections of one page and
//   between two proxied pages in frames of their own.
import dgram from 'node:dgram';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';
import { tally, watchSockets } from '../sockets.mjs';

const target = `${FIXTURE}pages/webrtc.html`;
const child = `${FIXTURE}pages/webrtc-child.html`;
// mDNS host names resolve (the browser's own, between two connections here);
// every other name still fails, as in every suite
const RESOLVER =
	'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1, EXCLUDE *.local';

// whose socket sent a packet: test/sockets.mjs
const sockets = await watchSockets();
const { senders, arrival } = sockets;
const ANSWER_MS = 500;
/**
 * A fixture on one port: over UDP, a STUN server that answers Binding
 * Requests when `answers`, else one that only listens; with `tcp`, a TCP
 * server on the same port that accepts and says nothing
 */
async function fixtureServer({ answers = false, tcp = false } = {}) {
	for (let attempt = 0; ; attempt++) {
		const socket = dgram.createSocket('udp4');
		const packets = [];
		let closed = false;
		socket.on('message', (message, from) => {
			packets.push(arrival(from.port));
			if (!answers || message.length < 20 || message.readUInt16BE(0) !== 0x0001)
				return;
			const attribute = Buffer.alloc(12);
			attribute.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
			attribute.writeUInt16BE(8, 2);
			attribute.writeUInt8(1, 5);
			attribute.writeUInt16BE(from.port ^ 0x2112, 6);
			const cookie = [0x21, 0x12, 0xa4, 0x42];
			from.address
				.split('.')
				.forEach((octet, i) =>
					attribute.writeUInt8(Number(octet) ^ cookie[i], 8 + i),
				);
			const head = Buffer.alloc(20);
			head.writeUInt16BE(0x0101, 0);
			head.writeUInt16BE(attribute.length, 2);
			head.writeUInt32BE(0x2112a442, 4);
			message.copy(head, 8, 8, 20);
			// not at once: the socket that asked stays open for the answer,
			// long enough to be sampled
			setTimeout(() => {
				if (!closed)
					socket.send(
						Buffer.concat([head, attribute]),
						from.port,
						from.address,
					);
			}, ANSWER_MS);
		});
		await new Promise((resolve) => socket.bind(0, '0.0.0.0', resolve));
		const { port } = socket.address();
		const connections = [];
		const sockets = new Set();
		let listener = null;
		if (tcp) {
			listener = net.createServer((connection) => {
				connections.push(arrival(connection.remotePort, 'tcp'));
				sockets.add(connection);
				connection.on('error', () => {});
				connection.on('close', () => sockets.delete(connection));
			});
			const listening = await new Promise((resolve) => {
				listener.once('error', () => resolve(false));
				listener.listen(port, '0.0.0.0', () => resolve(true));
			});
			if (!listening) {
				// the port is taken over TCP: another one
				socket.close();
				if (attempt > 20) throw new Error('no port free over UDP and TCP');
				continue;
			}
		}
		return {
			port,
			packets,
			connections,
			close() {
				closed = true;
				socket.close();
				for (const connection of sockets) connection.destroy();
				listener?.close();
			},
		};
	}
}

// this machine's own addresses (loopback is in every SDP's origin line, and
// the fixture servers and the wisp server sit on it: see `leaked`)
const ADDRESSES = Object.values(networkInterfaces())
	.flat()
	.filter((entry) => !entry.internal)
	.map((entry) => entry.address.replace(/%.*$/, ''));
/**
 * What `value` (something a page read) gives away. An address of one of
 * this machine's interfaces always does, whole or redacted. Loopback is
 * what the fixtures and the wisp server share, so it is legitimate in two
 * places: a reflexive or relayed candidate (the wisp server's address as a
 * server saw it; the checks pin its port to a packet the fixture got from
 * the wisp server) and, with `remote`, the remote candidates the page chose
 * itself. A host candidate of the page's own is a name, never an address:
 * one at loopback, or anywhere else, is the browser's own gathering
 * showing through.
 */
const leaked = (value, { remote = false } = {}) => {
	const text = JSON.stringify(value);
	const found = ADDRESSES.filter((address) => text.includes(address));
	// a partly redacted one, as the browser writes it in icecandidateerror
	for (const address of ADDRESSES)
		if (address.includes('.')) {
			const prefix = `${address.split('.').slice(0, 3).join('.')}.x`;
			if (text.includes(prefix)) found.push(prefix);
		}
	if (
		!remote &&
		(candidatesOf(value).some(
			([address, type]) => type === 'host' && !address.endsWith('.local'),
		) ||
			[...objectsIn(value)].some(hostAtAddress))
	)
		found.push('host candidate at an address');
	// the address STomp once sent the browser's own connection to
	if (text.includes('255.255.255.255')) found.push('255.255.255.255');
	return found;
};
/** every object in `value` (something a page read), depth first */
function* objectsIn(value) {
	if (!value || typeof value !== 'object') return;
	yield value;
	for (const inner of Object.values(value)) yield* objectsIn(inner);
}
/**
 * A host candidate of the page's own at an address, as the page reads one
 * member by member: a local-candidate entry of getStats() of type host (a
 * reflexive or relayed one is at the address a server saw), or an
 * RTCIceCandidate's fields with type host
 */
const hostAtAddress = (object) =>
	((object.type === 'local-candidate' && object.candidateType === 'host') ||
		(object.type === 'host' && 'port' in object)) &&
	[object.address, object.ip].some(
		(address) =>
			typeof address === 'string' &&
			address !== '' &&
			!address.endsWith('.local'),
	);
/**
 * A native measurement showing the leak a proxied check guards against. How
 * the browser leaks depends on the machine (its interfaces, media access,
 * how it paces connectivity checks under load), so a native run that does
 * not show it here is reported, not failed: the proxied checks stay strict
 * either way, and what they compare with is this run's native reading.
 */
function precondition(name, holds, detail) {
	if (holds) ok(name, true, detail);
	else console.log(`note: ${name}: not so on this machine - ${detail}`);
}
/** every candidate in `value`: [address, type, port] */
function candidatesOf(value) {
	return [
		...JSON.stringify(value).matchAll(
			/candidate:\S+ \d \w+ \d+ (\S+) (\d+) typ (\w+)/g,
		),
	].map(([, address, port, type]) => [address, type, Number(port)]);
}
const NAME =
	/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.local$/;
/**
 * The candidates a proxied page may gather in `run`: host candidates at
 * mDNS-style names, and reflexive ones at the wisp server's address and
 * port as the run's STUN fixture saw them (it answers each request with
 * where the request came from)
 */
const foreign = (run, value = run.result) => {
	const mapped = new Set(run.stun.map(({ port }) => port));
	return candidatesOf(value).filter(
		([address, type, port]) =>
			!(type === 'host' && NAME.test(address)) &&
			!(type === 'srflx' && address === '127.0.0.1' && mapped.has(port)),
	);
};

/** `value` as JSON with the run's own fixture ports written PORT, to compare runs */
const portless = (run, value) =>
	run.ports.reduce(
		(text, port) => text.replace(new RegExp(`\\b${port}\\b`, 'g'), 'PORT'),
		JSON.stringify(value),
	);
// how the browser shows a host address in icecandidateerror without media access
const REDACTED = /^(?:0\.0\.0\.x|\[0:0:0:x:x:x:x:x\])(?::\d+)?$/;

/**
 * Run in every document before any script of it (the inject's included):
 * the browser's RTCPeerConnection reports each connection it really makes,
 * whether it was given a configuration, and every call that could make it
 * gather or send (a description, a candidate, a configuration, an ICE
 * restart, a channel). The stand-in is built on what it finds there, so a
 * connection of the browser's made on a proxied page's behalf is counted;
 * one the constructor refuses is not. The one such connection a document
 * may make is the stand-in's format template (docs/webrtc-over-wisp.md,
 * section 16): made with no configuration, asked for one offer and closed,
 * so it never gathers, has no server and sends nothing.
 */
const NATIVE_MADE = 'native RTCPeerConnection made';
const NATIVE_CONFIGURED = 'native RTCPeerConnection made with a configuration';
const NATIVE_USED = 'native RTCPeerConnection used';
const countNative = ([mark, configured, used]) => {
	const Native = window.RTCPeerConnection;
	if (typeof Native !== 'function') return;
	const debug = console.debug.bind(console);
	const Counting = new Proxy(Native, {
		construct(target, args, newTarget) {
			const made = Reflect.construct(
				target,
				args,
				newTarget === Counting ? target : newTarget,
			);
			debug(args[0] === undefined || args[0] === null ? mark : configured);
			return made;
		},
	});
	for (const name of [
		'setLocalDescription',
		'setRemoteDescription',
		'addIceCandidate',
		'setConfiguration',
		'restartIce',
		'createDataChannel',
	]) {
		const original = Native.prototype[name];
		if (typeof original !== 'function') continue;
		Native.prototype[name] = {
			[name](...args) {
				debug(used);
				return Reflect.apply(original, this, args);
			},
		}[name];
	}
	Native.prototype.constructor = Counting;
	window.RTCPeerConnection = Counting;
	if ('webkitRTCPeerConnection' in window)
		window.webkitRTCPeerConnection = Counting;
};
/**
 * counts them for `page`'s context from here on: `page.nativeMade` (all of
 * them), `page.nativeConfigured` (those given a configuration) and
 * `page.nativeUsed` (the calls on any of them that could gather)
 */
async function watchNative(page) {
	page.nativeMade = 0;
	page.nativeConfigured = 0;
	page.nativeUsed = 0;
	page.context().on('console', (message) => {
		const text = message.text();
		if (text === NATIVE_MADE) page.nativeMade++;
		else if (text === NATIVE_CONFIGURED) {
			page.nativeMade++;
			page.nativeConfigured++;
		} else if (text === NATIVE_USED) page.nativeUsed++;
	});
	await page
		.context()
		.addInitScript(countNative, [NATIVE_MADE, NATIVE_CONFIGURED, NATIVE_USED]);
}

async function nativePage(browser) {
	const page = await (await browser.newContext()).newPage();
	await watchNative(page);
	page.errors = [];
	page.on('pageerror', (error) => page.errors.push(error.message));
	await page.goto(target);
	await page.waitForFunction(() => window.__rtcReady);
	return { label: 'natively', page, frame: () => page.mainFrame() };
}

async function proxiedPage(browser, mode, base) {
	const page = await openDemo(browser, base);
	await watchNative(page);
	await submitLanding(page, target);
	const frame = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		if (
			await frame()
				?.evaluate(() => window.__rtcReady)
				.catch(() => false)
		)
			break;
	}
	return { label: mode, page, frame };
}

// Known differences (docs/webrtc.md, limits): an offer with a section Chrome
// answers as rejected (a protocol it does not know, a second data section)
// is refused whole by the stack; an offer after an answer that took Opus
// without RED leaves RED out
const REJECTED_SECTIONS = new Set([
	'errors.remote.mediaProtocolBad',
	'errors.remote.twoSections',
	// an answer that negotiated Opus without redundant audio: the stack
	// offers no RED again (docs/webrtc-over-wisp.md, section 16)
	'codecs.answers.pcmuOpus.again',
]);

/** collects garbage in the page's process and in its frame's, where that is another */
async function collect(entry) {
	await entry.page.requestGC();
	const frame = entry.frame();
	if (frame === entry.page.mainFrame()) return;
	const session = await entry.page
		.context()
		.newCDPSession(frame)
		.catch(() => null);
	if (!session) return;
	await session.send('HeapProfiler.collectGarbage');
	await session.detach();
}

/** `probe` in each page at once, with fresh fixtures for each (`tcp`: the sink listens over TCP too) */
async function each(pages, probe, arg = () => ({}), { tcp = false } = {}) {
	return Promise.all(
		pages.map(async (entry) => {
			const stun = await fixtureServer({ answers: true });
			const sink = await fixtureServer({ tcp });
			const fixtures = { stun: stun.port, sink: sink.port, child };
			let result;
			try {
				result = await entry
					.frame()
					.evaluate(probe, { ...fixtures, ...arg(fixtures) });
			} catch (error) {
				result = { threw: String(error).slice(0, 300) };
			}
			// late retransmissions, and a sample after the last packet
			await sleep(1000);
			stun.close();
			sink.close();
			return {
				...entry,
				result,
				stun: stun.packets,
				sink: sink.packets,
				connections: sink.connections,
				ports: [stun.port, sink.port],
			};
		}),
	);
}

async function suite(name, flags, raw) {
	const browser = await launch([RESOLVER, ...flags]);
	const native = await nativePage(browser);
	const proxied = [
		await proxiedPage(browser, `${name}, same-origin`, PROXY),
		await proxiedPage(browser, `${name}, isolated`, HOST),
	];
	const all = [native, ...proxied];

	// unreachable servers, the slow probe, in every page at once: STUN, TURN
	// over UDP and TCP and, on a connection of its own, TURN on a system port
	// (which the browser never allocates on: it only asks it as a STUN
	// server, and its closed loopback port hears nothing here either way)
	const unreachable = await each(all, async ({ sink }) => {
		const [servers, system] = await Promise.all([
			window.__rtc.gather(
				{
					iceServers: [
						{ urls: `stun:127.0.0.1:${sink}` },
						{
							urls: [
								`turn:127.0.0.1:${sink}`,
								`turn:127.0.0.1:${sink}?transport=tcp`,
							],
							username: 'u',
							credential: 'p',
						},
					],
				},
				{ ms: 60000 },
			),
			window.__rtc.gather(
				{
					iceServers: [
						{ urls: 'turn:127.0.0.1:22', username: 'u', credential: 'p' },
					],
				},
				{ ms: 60000 },
			),
		]);
		return { log: [...servers.log, ...system.log], servers, system };
	});
	const errorsOf = (run) =>
		(run.result.log ?? [])
			.filter(([kind]) => kind === 'error')
			.map(([, at, error]) => ({ at, ...error }));
	// what the errors say, in an order that does not depend on timing; one per
	// host candidate, so only as a set where the pages gathered on different
	// interfaces (an isolated frame has no media access of its own)
	const hosts = (run) =>
		(run.result.log ?? []).filter(
			([kind, , candidate]) => kind === 'candidate' && candidate,
		).length;
	const errorShape = (run, unique) => {
		const shapes = errorsOf(run)
			.map((error) =>
				portless(run, [
					error.url,
					error.errorCode,
					error.errorText,
					error.address === null,
				]),
			)
			.sort();
		return unique ? [...new Set(shapes)] : shapes;
	};
	const completeAt = (run) =>
		Math.max(
			...['servers', 'system'].map(
				(key) =>
					run.result[key]?.log?.find(
						([kind, , state]) => kind === 'gathering' && state === 'complete',
					)?.[1] ?? Infinity,
			),
		);
	precondition(
		`${name}, natively: unreachable STUN and TURN servers get requests from the browser's own sockets and each fails with 701 when gathering completes`,
		senders(unreachable[0].sink).includes('browser') &&
			errorsOf(unreachable[0]).some((error) => /^TURN/.test(error.errorText)) &&
			errorsOf(unreachable[0]).some((error) => /^STUN/.test(error.errorText)),
		JSON.stringify([
			tally(senders(unreachable[0].sink)),
			errorShape(unreachable[0]),
			completeAt(unreachable[0]),
		]),
	);
	for (const run of unreachable.slice(1)) {
		const errors = errorsOf(run);
		const unique = hosts(run) !== hosts(unreachable[0]);
		// the requests are retransmitted for as long as natively, on streams
		// the wisp server keeps open meanwhile: every one of them is seen to
		// be its own. A connection that never came up (TURN over TCP) has
		// no local address in its error, natively either: null, and ":0"
		ok(
			`${run.label}: unreachable servers hear the wisp server and never the browser, and the page sees the same 701s as natively, as late, with the host redacted`,
			run.sink.length > 0 &&
				senders(run.sink).every((who) => who === 'server') &&
				JSON.stringify(errorShape(run, unique)) ===
					JSON.stringify(errorShape(unreachable[0], unique)) &&
				errors.every((error) =>
					error.address === null
						? error.port === null && error.hostCandidate === ':0'
						: REDACTED.test(error.address) &&
							REDACTED.test(error.hostCandidate),
				) &&
				Math.abs(completeAt(run) - completeAt(unreachable[0])) < 5000 &&
				leaked(run.result).length === 0,
			JSON.stringify([
				tally(senders(run.sink)),
				errorShape(run, unique),
				errorShape(unreachable[0], unique),
				errors.map(({ address, hostCandidate }) => [address, hostCandidate]),
				completeAt(run),
				completeAt(unreachable[0]),
				leaked(run.result),
			]),
		);
	}

	// servers that answer or listen, a candidate pool
	const gathered = await each(all, (fixtures) =>
		window.__rtc.gather(
			{
				iceServers: [
					{ urls: `stun:127.0.0.1:${fixtures.stun}` },
					{
						urls: [`turn:127.0.0.1:${fixtures.sink}`],
						username: 'u',
						credential: 'p',
					},
				],
				iceCandidatePoolSize: 1,
			},
			{ ms: 3000 },
		),
	);
	const nativeTypes = candidatesOf(gathered[0].result).map(([, type]) => type);
	precondition(
		`${name}, natively: the STUN server hears the browser's own sockets and answers (a srflx candidate)`,
		// with real host addresses the browser drops a srflx that repeats one
		senders(gathered[0].stun).includes('browser') &&
			(raw || nativeTypes.includes('srflx')),
		JSON.stringify([tally(senders(gathered[0].stun)), nativeTypes]),
	);
	if (raw) {
		const shown = leaked(gathered[0].result).filter(
			(a) => !/\.x$|candidate|255/.test(a),
		);
		precondition(
			`${name}, natively: host candidates carry this machine's address`,
			shown.length > 0,
			shown.join(' '),
		);
	}
	for (const run of gathered.slice(1)) {
		const candidates = candidatesOf(run.result);
		const heard = [...senders(run.stun), ...senders(run.sink)];
		// each on a stream the wisp server keeps open until the answer, or
		// for as long as the allocation is retried
		ok(
			`${run.label}: the page's STUN and TURN servers hear the wisp server and never the browser, with a candidate pool too`,
			run.stun.length > 0 &&
				run.sink.length > 0 &&
				heard.every((who) => who === 'server'),
			JSON.stringify([tally(senders(run.stun)), tally(senders(run.sink))]),
		);
		// a reflexive candidate is where the STUN server saw the request
		// come from: the wisp server (on loopback here, with the fixtures),
		// at the very port the fixture answered. No relay candidate: the TURN
		// fixture never answers
		ok(
			`${run.label}: only mDNS host candidates and the wisp server's address as the STUN server saw it, and no address of this machine anywhere the page reads`,
			candidates.some(([, type]) => type === 'host') &&
				candidates.some(([, type]) => type === 'srflx') &&
				foreign(run).length === 0 &&
				leaked(run.result).length === 0,
			JSON.stringify([candidates, foreign(run), leaked(run.result)]),
		);
		ok(
			`${run.label}: getConfiguration reads back the page's servers and pool as natively`,
			portless(run, run.result.config) ===
				portless(gathered[0], gathered[0].result.config),
			JSON.stringify([run.result.config, gathered[0].result.config]),
		);
	}

	// relay only, and servers given after the connection was made
	const later = await each(all, async (fixtures) => {
		const relay = await window.__rtc.gather(
			{
				iceServers: [
					{
						urls: `turn:127.0.0.1:${fixtures.sink}`,
						username: 'u',
						credential: 'p',
					},
				],
				iceTransportPolicy: 'relay',
			},
			{ ms: 2000 },
		);
		const pc = new RTCPeerConnection();
		pc.setConfiguration({
			iceServers: [{ urls: `stun:127.0.0.1:${fixtures.stun}` }],
		});
		pc.createDataChannel('x');
		const candidates = [];
		pc.onicecandidate = (e) =>
			e.candidate && candidates.push(e.candidate.candidate);
		await pc.setLocalDescription();
		await new Promise((r) => setTimeout(r, 2000));
		const configured = pc.getConfiguration().iceServers;
		pc.restartIce();
		await pc.setLocalDescription();
		await new Promise((r) => setTimeout(r, 2000));
		pc.close();
		return { relay: relay.log, candidates, configured };
	});
	for (const run of later.slice(1)) {
		const heard = [...senders(run.stun), ...senders(run.sink)];
		// relay only: the TURN server (which never answers) is asked by the
		// wisp server and the page gets no candidate; the STUN server given
		// later answers it, as in the check above
		ok(
			`${run.label}: relay-only and setConfiguration (then an ICE restart) reach the servers from the wisp server and never from the browser`,
			run.stun.length > 0 &&
				run.sink.length > 0 &&
				heard.every((who) => who === 'server') &&
				candidatesOf(run.result.relay).length === 0 &&
				foreign(run).length === 0 &&
				leaked(run.result).length === 0 &&
				portless(run, run.result.configured) ===
					portless(later[0], later[0].result.configured),
			JSON.stringify([
				tally(senders(run.stun)),
				tally(senders(run.sink)),
				candidatesOf(run.result),
				run.result.configured,
			]),
		);
	}

	// remote candidates the page chose; the fixture listens over TCP too
	const remotes = await each(
		all,
		({ sink }) =>
			window.__rtc.pair(
				{},
				{
					remote: [
						`candidate:11 1 udp 2122260223 127.0.0.1 ${sink} typ host generation 0`,
						`candidate:12 1 udp 2122260223 example.com ${sink} typ host generation 0`,
						`candidate:13 1 udp 2122260223 0b5a0e4a-1111-4000-8000-000000000000.local ${sink} typ host generation 0`,
						`candidate:14 1 tcp 1518280447 127.0.0.1 ${sink} typ host tcptype passive generation 0`,
					],
				},
			),
		undefined,
		{ tcp: true },
	);
	precondition(
		`${name}, natively: a remote candidate on the fixture gets connectivity checks from the browser's own sockets`,
		senders(remotes[0].sink).includes('browser'),
		JSON.stringify([
			tally(senders(remotes[0].sink)),
			tally(senders(remotes[0].connections, 'tcp')),
		]),
	);
	for (const run of remotes.slice(1)) {
		const sdp = run.result.remote?.sdp ?? '';
		const connection = (text) => text.match(/^c=.*$/m)?.[0];
		// the checks go on for as long as the connection lives, on one
		// stream of the wisp server's: each is seen to be its own. Over TCP
		// the browser must not connect either (the stack may, or may not)
		ok(
			`${run.label}: remote candidates the page chose get their checks from the wisp server and never from the browser, and read back as the page gave them`,
			run.sink.length > 0 &&
				senders(run.sink).every((who) => who === 'server') &&
				!senders(run.connections, 'tcp').includes('browser') &&
				/ 127\.0\.0\.1 \d+ typ host/.test(sdp) &&
				sdp.includes('example.com') &&
				JSON.stringify(run.result.added) ===
					JSON.stringify(remotes[0].result.added) &&
				// natively, with real host addresses, the other connection's own
				// address can be the connection line's: not one the page may see
				(connection(sdp) === connection(remotes[0].result.remote?.sdp ?? '') ||
					leaked(connection(remotes[0].result.remote?.sdp ?? '')).length > 0) &&
				!JSON.stringify(run.result).includes('255.255.255.255'),
			JSON.stringify([
				tally(senders(run.sink)),
				tally(senders(run.connections, 'tcp')),
				run.result.added,
				remotes[0].result.added,
				sdp.split('\r\n').filter((l) => /cand|^c=/.test(l)),
				connection(remotes[0].result.remote?.sdp ?? ''),
			]),
		);
		ok(
			`${run.label}: a data channel between two connections of the page opens, with nothing of this machine in its stats`,
			run.result.open === 'open' &&
				run.result.message === 'hello' &&
				leaked(run.result, { remote: true }).length === 0,
			JSON.stringify([
				run.result.open,
				run.result.message,
				leaked(run.result, { remote: true }),
			]),
		);
	}

	const crossed = await each(all, ({ child }) =>
		window.__rtc.crossFrame(child),
	);
	for (const run of crossed.slice(1))
		ok(
			`${run.label}: a data channel opens with another proxied page in a frame of its own`,
			run.result.open === 'open' &&
				run.result.message === 'pong:ping' &&
				// no server and no remote candidate names the fixtures here
				run.stun.length + run.sink.length === 0 &&
				leaked(run.result).length === 0,
			JSON.stringify([run.result.open, run.result.message, leaked(run.result)]),
		);

	const realms = await each(all, (fixtures) =>
		window.__rtc.realms(
			{ iceServers: [{ urls: `stun:127.0.0.1:${fixtures.stun}` }] },
			fixtures.child,
		),
	);
	const nativeRealms = realms[0].result;
	precondition(
		`${name}, natively: a connection in every realm reaches the STUN server from the browser's own sockets`,
		senders(realms[0].stun).includes('browser'),
		JSON.stringify([tally(senders(realms[0].stun)), Object.keys(nativeRealms)]),
	);
	for (const run of realms.slice(1)) {
		const bad = Object.entries(run.result).filter(([realm, value]) => {
			if (realm === 'worker')
				return JSON.stringify(value) !== JSON.stringify(nativeRealms.worker);
			// in every realm the stand-in, over wisp: a name for the host
			// candidate, the wisp server's address from the STUN server
			return (
				!value?.candidates ||
				!candidatesOf(value).some(([, type]) => type === 'host') ||
				!candidatesOf(value).some(([, type]) => type === 'srflx') ||
				foreign(run, value).length > 0 ||
				leaked(value).length > 0 ||
				(value.source !== undefined &&
					value.source !== nativeRealms[realm]?.source)
			);
		});
		ok(
			`${run.label}: about:blank frames (by contentWindow and frames[i]), srcdoc, nested, blob:, data: and sandboxed frames and popups reach the server from the wisp server and never from the browser; workers still have no RTCPeerConnection`,
			run.stun.length > 0 &&
				senders(run.stun).every((who) => who === 'server') &&
				bad.length === 0 &&
				Object.keys(run.result).length === Object.keys(nativeRealms).length,
			JSON.stringify([
				tally(senders(run.stun)),
				bad.map(([realm, value]) => [
					realm,
					JSON.stringify(value).slice(0, 200),
				]),
			]),
		);
	}

	const edges = await each(all, ({ sink }) => window.__rtc.edges(sink));
	for (const run of edges.slice(1)) {
		const { remoteSdp, ...rest } = run.result;
		const { remoteSdp: nativeSdp, ...expected } = edges[0].result;
		const differ = Object.keys(expected).filter(
			(key) => portless(run, rest[key]) !== portless(edges[0], expected[key]),
		);
		// these connections never get a local description: natively nothing
		// is sent to the candidate at the fixture, and nothing is here
		ok(
			`${run.label}: bad calls, unawaited ones and constructed candidates answer as natively`,
			differ.length === 0 &&
				portless(run, remoteSdp) === portless(edges[0], nativeSdp) &&
				run.sink.length === 0,
			JSON.stringify([
				tally(senders(run.sink)),
				differ.map((key) => [key, rest[key], expected[key]]),
				remoteSdp,
				nativeSdp,
			]),
		);
	}

	// getStats() over a connection's life (test/pages/webrtc-stats.js): the
	// kinds of entries, the members of each and the values that do not vary.
	// What DTLS negotiated is Chrome's stack's with itself natively and the
	// proxy's stack's here: shown, not compared. With media access the
	// browser shows its host candidates at this machine's addresses, one for
	// each interface, and pairs each with each; what follows from those
	// addresses (how many candidates and pairs there are, which pair won
	// after how many changes, the network's type, an interface's priority)
	// is what the proxy keeps from the page, which reads names as it would
	// without media access, so it is not compared
	{
		const blind = (candidate) =>
			candidate && {
				...candidate,
				address: undefined,
				ip: undefined,
				networkType: undefined,
				priority: undefined,
			};
		const unique = (list) =>
			list && [...new Set(list.map((item) => JSON.stringify(item)))].sort();
		const told = ({ result }) => {
			const facts = { ...result.facts, dtls: undefined };
			if (!raw) return { ...result, facts };
			return {
				...result,
				shown: unique(result.shown),
				connected: result.connected && {
					...result.connected,
					order: undefined,
				},
				facts: {
					...facts,
					local: blind(facts.local),
					remote: blind(facts.remote),
					transport: facts.transport && {
						...facts.transport,
						changes: undefined,
					},
					selected: facts.selected && { ...facts.selected, bytes: undefined },
				},
			};
		};
		/** what differs between two results: each value that differs, by its path */
		const differences = (got, expected, path = '') => {
			if (
				got &&
				expected &&
				typeof got === 'object' &&
				typeof expected === 'object' &&
				Array.isArray(got) === Array.isArray(expected)
			)
				return [
					...new Set([...Object.keys(got), ...Object.keys(expected)]),
				].flatMap((key) =>
					differences(got[key], expected[key], `${path}.${key}`),
				);
			return JSON.stringify(got) === JSON.stringify(expected)
				? []
				: [[path, got, expected]];
		};
		const stats = await each(all, (fixtures) => window.__rtcStats(fixtures));
		const expected = told(stats[0]);
		precondition(
			`${name}, natively: getStats() tells of the connected transport, its pair and its candidates`,
			expected.facts?.selected?.state === 'succeeded' && !stats[0].result.threw,
			JSON.stringify(stats[0].result).slice(0, 600),
		);
		for (const run of stats.slice(1)) {
			const differ = differences(told(run), expected);
			ok(
				`${run.label}: getStats() has the browser's entries in its order, each with the browser's members, and a gathered candidate names its server`,
				differ.length === 0,
				`DTLS ${JSON.stringify(run.result.facts?.dtls)}, natively ${JSON.stringify(stats[0].result.facts?.dtls)}; differ: ${JSON.stringify(differ).slice(0, 5000)}`,
			);
		}

		// pc.sctp and its transports, the same way, without media access:
		// with it the browser's candidates are this machine's addresses, one
		// for each interface, and its gathering waits out a Binding request
		// from each (40 s here); the proxy's transports read the same either
		// way, as it gathers the same either way
		if (!raw) {
			const transports = await each(all, (fixtures) =>
				window.__rtcTransports(fixtures),
			);
			const native = transports[0].result;
			precondition(
				`${name}, natively: pc.sctp, its DTLS transport and its ICE transport tell of the connection`,
				native?.connected?.sctp?.[0] === 'connected' && !native.threw,
				JSON.stringify(native).slice(0, 600),
			);
			for (const run of transports.slice(1)) {
				const differ = differences(run.result, native);
				ok(
					`${run.label}: pc.sctp, its RTCDtlsTransport and its RTCIceTransport read as the browser's at each stage, fire its events, and a restart's candidates are of the next generation`,
					differ.length === 0,
					JSON.stringify(differ).slice(0, 5000),
				);
			}
		}
	}

	// every bad call of test/pages/webrtc-errors.js: natively the browser's
	// connection answers, here STomp's own reading of the configuration, the
	// description, the candidate and the channel dictionary does
	const errorTables = await each(all, (fixtures) =>
		window.__rtcErrors(fixtures),
	);
	// Chrome refuses a renderer its 501st connection until the closed ones
	// are collected, and so does the stand-in
	await Promise.all(all.map(collect));
	const urlTables = await each(all, (fixtures) => window.__rtcUrls(fixtures));
	await Promise.all(all.map(collect));
	const answerTables = await each(all, () => window.__rtcAnswers());
	await Promise.all(all.map(collect));
	const codecTables = await each(all, () => window.__rtcCodecs());
	{
		const flat = (index) => {
			const out = {};
			const walk = (run, path, value) => {
				if (value && typeof value === 'object' && !Array.isArray(value))
					for (const [key, inner] of Object.entries(value))
						walk(run, `${path}.${key}`, inner);
				else out[path] = portless(run, value);
			};
			walk(errorTables[index], 'errors', errorTables[index].result);
			walk(urlTables[index], 'urls', urlTables[index].result);
			walk(answerTables[index], 'answers', answerTables[index].result);
			walk(codecTables[index], 'codecs', codecTables[index].result);
			return out;
		};
		const expected = flat(0);
		const threw =
			errorTables[0].result.threw ??
			urlTables[0].result.threw ??
			answerTables[0].result.threw ??
			codecTables[0].result.threw ??
			'';
		precondition(
			`${name}, natively: the tables of bad calls run to their end`,
			Object.keys(expected).length > 500 && !threw,
			`${Object.keys(expected).length} cases ${threw}`,
		);
		for (const [at, run] of errorTables.entries()) {
			if (at === 0) continue;
			const got = flat(at);
			const differ = Object.keys({ ...expected, ...got }).filter(
				(key) => got[key] !== expected[key] && !REJECTED_SECTIONS.has(key),
			);
			ok(
				`${run.label}: a bad configuration, remote description, candidate, channel dictionary or codec preference gets the browser's own error, and a good one reads back as the browser's (codec preferences in the offers and answers too), case by case`,
				differ.length === 0 && Object.keys(got).length > 500,
				`${Object.keys(got).length} cases, ${differ.length} differ: ${JSON.stringify(
					differ.slice(0, 40).map((key) => [key, got[key], expected[key]]),
				).slice(0, 6000)}`,
			);
		}
	}

	// 500 connections to a renderer, the closed ones too until collected
	{
		await Promise.all(all.map(collect));
		const many = await each(all, () => window.__rtcMany());
		await Promise.all(all.map(collect));
		const after = await each(all, () => window.__rtcOneMore());
		// a connection or two of the steps above may still be held
		const told = ({ made, ...rest }, after) =>
			JSON.stringify([made > 490 && made <= 500, rest, after]);
		const seen = (index) =>
			`${JSON.stringify(many[index].result)} then ${after[index].result}`;
		const expected = told(many[0].result, after[0].result);
		precondition(
			`${name}, natively: the 501st connection is refused until the closed ones are collected`,
			many[0].result.made > 490 &&
				many[0].result.made <= 500 &&
				many[0].result.closed === 'UnknownError' &&
				after[0].result === 'made',
			seen(0),
		);
		for (const [at, run] of many.entries())
			if (at)
				ok(
					`${run.label}: a document holds as many connections as the browser lets it, and a closed one is let go of`,
					told(run.result, after[at].result) === expected,
					`${seen(at)}, natively ${seen(0)}`,
				);
	}

	// a hostile page: its own events, another document's members (that
	// document runs an inject of its own), its prototypes swapped
	const attacked = await each(all, (fixtures) =>
		window.__rtc.attacks(fixtures),
	);
	precondition(
		`${name}, natively: a remote candidate added through another document's member gets checks from the browser's own sockets`,
		senders(attacked[0].sink).includes('browser') &&
			senders(attacked[0].stun).includes('browser'),
		JSON.stringify([
			tally(senders(attacked[0].sink)),
			tally(senders(attacked[0].stun)),
		]),
	);
	for (const run of attacked.slice(1))
		// another document's members work on this document's objects, as
		// natively, and what they reach, they reach through the wisp server
		ok(
			`${run.label}: forged events, another document's members and swapped prototypes reach the fixtures from the wisp server and never from the browser, and read no address of this machine`,
			run.sink.length > 0 &&
				senders(run.sink).every((who) => who === 'server') &&
				run.stun.length > 0 &&
				senders(run.stun).every((who) => who === 'server') &&
				run.result.borrowedAdd === 'added' &&
				portless(run, run.result.borrowedConfiguration) ===
					portless(attacked[0], attacked[0].result.borrowedConfiguration) &&
				portless(run, run.result.forged) ===
					portless(attacked[0], attacked[0].result.forged) &&
				run.result.tampered?.watched === true &&
				!Object.values(run.result).some(
					(value) => typeof value === 'string' && value.startsWith('threw'),
				) &&
				leaked(run.result, { remote: true }).length === 0,
			JSON.stringify([
				tally(senders(run.sink)),
				tally(senders(run.stun)),
				leaked(run.result, { remote: true }),
				run.result,
			]).slice(0, 1500),
		);

	const surfaces = await each(all, async () => ({
		surface: window.__rtc.surface(),
		iterator: await window.__rtc.iteratorShape(),
	}));
	for (const run of surfaces.slice(1)) {
		const differ = [];
		const compare = (path, a, b) => {
			if (JSON.stringify(a) === JSON.stringify(b)) return;
			if (a && b && typeof a === 'object' && typeof b === 'object')
				for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
					compare(`${path}.${key}`, a[key], b[key]);
			else differ.push([path, a, b]);
		};
		compare('', run.result, surfaces[0].result);
		ok(
			`${run.label}: every RTC global, its statics, prototype members and errors read as natively`,
			differ.length === 0,
			JSON.stringify(differ.slice(0, 8)),
		);
	}

	// every probe above is behind this one
	precondition(
		`${name}, natively: the page's connections are the browser's own`,
		native.page.nativeMade > 0,
		String(native.page.nativeMade),
	);
	for (const entry of proxied)
		ok(
			`${entry.label}: no native RTCPeerConnection is given a configuration, a description, a candidate or a channel, in any realm, by any call above (the format template aside, none is made)`,
			entry.page.nativeConfigured === 0 && entry.page.nativeUsed === 0,
			JSON.stringify({
				made: entry.page.nativeMade,
				configured: entry.page.nativeConfigured,
				used: entry.page.nativeUsed,
			}),
		);

	const errors = proxied.flatMap((entry) => entry.page.errors);
	await browser.close();
	return errors;
}

const errors = [
	...(await suite('mDNS host names', [], false)),
	// the proxy origin allowed the camera and microphone: the browser shows
	// host candidates' real addresses
	...(await suite(
		'real host addresses',
		['--use-fake-ui-for-media-stream'],
		true,
	)),
];
console.log(`note: packets attributed: ${await sockets.stop()}`);
await done(null, errors);
