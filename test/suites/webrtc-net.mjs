// The network side of a proxied page's RTCPeerConnection
// (docs/webrtc-over-wisp.md, sections 5 and 15): what the wisp streams of
// a connection do over its life, TURN servers over TCP and TLS
// (test/turn.mjs), an ICE restart the peer starts, and ICE-TCP.
// test/pages/webrtc-peer.html is the page,
// natively (the control) and through the proxy in both demo modes; the far
// end is a peer in this process (werift, bound to loopback), and the
// remote candidates nothing answers at are UDP sinks of this process.
// A stream is a socket of the demo's wisp server connected to one remote
// (test/sockets.mjs counts them); the browser's own sockets never are.
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { RTCPeerConnection } from 'werift';
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
import { startTurn } from '../turn.mjs';

const target = `${FIXTURE}pages/webrtc-peer.html`;
const sockets = await watchSockets();

async function until(test, ms, what) {
	const end = Date.now() + ms;
	while (!(await test())) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(50);
	}
}

/** a UDP socket on loopback that reads and never answers: a remote candidate nobody is at */
async function sink() {
	const socket = createSocket('udp4');
	const packets = [];
	socket.on('message', (message, from) =>
		packets.push({ at: Date.now(), port: from.port }),
	);
	await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
	const { port } = socket.address();
	return {
		address: `127.0.0.1:${port}`,
		packets,
		candidate: (mid) => ({
			candidate: `candidate:${port} 1 udp 2122260223 127.0.0.1 ${port} typ host generation 0`,
			sdpMid: mid,
			sdpMLineIndex: 0,
		}),
		close: () => socket.close(),
	};
}

/** a connection of the page in `frame`: steps are window.__peer's */
let names = 0;
function pageEnd(frame) {
	const name = `n${names++}`;
	return {
		call: (step, ...args) =>
			frame().evaluate(
				([step, name, args]) => window.__peer[step](name, ...args),
				[step, name, args],
			),
	};
}

// werift cannot ask the browser's resolver for a .local name: it learns the
// page's address from the page's first check
const withoutNames = (sdp) =>
	sdp
		.split('\r\n')
		.filter((line) => !/^a=candidate:.*\.local /.test(line))
		.join('\r\n');

/** the peer in this process, with the page's steps that the checks use */
function nodeEnd(options = {}) {
	let pc;
	const channels = new Map();
	const complete = () =>
		until(() => pc.iceGatheringState === 'complete', 30000, 'peer gathering');
	const steps = {
		open() {
			pc = new RTCPeerConnection({
				iceServers: [],
				iceUseDefaultStunServer: false,
				iceUseIpv6: false,
				iceAdditionalHostAddresses: ['127.0.0.1'],
				iceInterfaceAddresses: { udp4: '127.0.0.1', tcp4: '127.0.0.1' },
				...options,
			});
			pc.onDataChannel.subscribe((channel) => {
				const state = { channel, messages: [] };
				channels.set(channel.label, state);
				channel.onMessage.subscribe((data) =>
					state.messages.push(String(data)),
				);
			});
		},
		async answer(sdp) {
			await pc.setRemoteDescription({ type: 'offer', sdp: withoutNames(sdp) });
			await pc.setLocalDescription(await pc.createAnswer());
			await complete();
			return pc.localDescription.sdp;
		},
		/** an offer of this end's, a restart of ICE with `restart` */
		async offer({ restart = false } = {}) {
			if (restart) pc.restartIce();
			await pc.setLocalDescription(await pc.createOffer());
			await complete();
			return pc.localDescription.sdp;
		},
		async accept(sdp) {
			await pc.setRemoteDescription({ type: 'answer', sdp: withoutNames(sdp) });
		},
		async opened(name) {
			await until(
				() => channels.get(name)?.channel.readyState === 'open',
				30000,
				`${name} open at the peer`,
			);
		},
		send(name, text) {
			channels.get(name).channel.send(text);
		},
		async received(name, count) {
			const state = channels.get(name);
			await until(
				() => state.messages.length >= count,
				30000,
				`${count} messages`,
			).catch(() => {});
			return state.messages.slice(0, count);
		},
		/** where the peer sees the page: its selected pair's remote end */
		read() {
			const remote = pc.iceTransports[0]?.connection.nominated?.remoteCandidate;
			return (
				remote && {
					port: remote.port,
					protocol: remote.transport.toLowerCase(),
				}
			);
		},
		close: () => pc.close(),
	};
	return { call: async (step, ...args) => steps[step](...args) };
}

/** the address of the first host candidate in a description */
const hostIn = (sdp) => {
	const found = / udp \d+ ([\d.]+) (\d+) typ host/.exec(sdp);
	return found && `${found[1]}:${found[2]}`;
};

async function page(browser, base) {
	let opened;
	let frame;
	if (base) {
		opened = await openDemo(browser, base);
		await submitLanding(opened, target);
		frame = () =>
			opened.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	} else {
		opened = await (await browser.newContext()).newPage();
		await opened.goto(target);
		frame = () => opened.mainFrame();
	}
	opened.errors = [];
	opened.on('pageerror', (error) => opened.errors.push(error.message));
	await until(
		() =>
			frame()
				?.evaluate(() => window.__peerReady)
				.catch(() => false),
		40000,
		'the page',
	);
	return { page: opened, frame };
}

// TURN over TLS: the fixture's certificate is trusted by its key here,
// and through the proxy by the test transport (test/turn.mjs)
const tlsTurn = await startTurn({
	transport: 'tls',
	arrival: sockets.arrival,
});
const browser = await launch([
	`--ignore-certificate-errors-spki-list=${tlsTurn.spki}`,
]);
const pages = [];

// --- the streams of a connection over its life (section 5.2) ---
//
// The page connects to the peer and is then given three more of the peer's
// candidates, at sinks that never answer: the agent checks each, gives up
// on their pairs, and goes on over the peer's. Natively the browser's
// sockets are its candidates', one whatever it checks; through the proxy
// each remote is a stream of its own, and the ones of the pairs the agent
// gave up are closed long before the connection is.

/** how long the agent checks a remote that never answers, with room: str0m gives up after about 19 s */
const GIVE_UP_MS = 40000;

for (const [label, base] of [
	['natively', null],
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	const proxied = base !== null;
	const opened = await page(browser, base);
	pages.push(opened);
	const own = pageEnd(opened.frame);
	const peer = nodeEnd();
	const sinks = await Promise.all([sink(), sink(), sink()]);
	let failure = null;
	const life = [];
	let latest = null;
	let opening = null;
	let after = null;
	let closed = null;
	try {
		await own.call('open', { iceServers: [] });
		await own.call('channels', [['chat', {}]]);
		await peer.call('open');
		const offer = await own.call('offer');
		const answer = await peer.call('answer', offer);
		await own.call('accept', answer);
		const far = hostIn(answer);
		await own.call('opened', 'chat');
		await peer.call('opened', 'chat');
		const mid = /^a=mid:(.*)$/m.exec(offer.replace(/\r/g, ''))?.[1] ?? '0';
		for (const one of sinks) await own.call('add', one.candidate(mid));
		const start = Date.now();
		const count = async () => {
			const counts = await sockets.connected([
				far,
				...sinks.map((one) => one.address),
			]);
			const entry = {
				at: Math.round((Date.now() - start) / 100) / 10,
				peer: counts[far],
				sinks: sinks.reduce((sum, one) => sum + counts[one.address], 0),
				heard: sinks.reduce((sum, one) => sum + one.packets.length, 0),
			};
			if (
				life.at(-1)?.peer !== entry.peer ||
				life.at(-1)?.sinks !== entry.sinks
			)
				life.push(entry);
			latest = entry;
			return entry;
		};
		// the checks to the sinks begin, each on a stream of its own
		await until(
			async () =>
				(await count()).heard >= 3 &&
				sinks.every((one) => one.packets.length) &&
				(!proxied || latest.sinks === 3),
			10000,
			'checks to every sink',
		).catch(() => {});
		opening = latest;
		// until the agent gives up on them, and a little longer
		await until(
			async () => proxied && (await count()).sinks === 0,
			GIVE_UP_MS,
			'the given up streams closed',
		).catch(() => {});
		const quiet = Date.now();
		const heard = sinks.reduce((sum, one) => sum + one.packets.length, 0);
		await sleep(proxied ? 3000 : 0);
		await own.call('send', 'chat', { text: 'still here' });
		await peer.call('send', 'chat', 'and here');
		after = {
			...(await count()),
			since: sinks.reduce((sum, one) => sum + one.packets.length, 0) - heard,
			there: (await peer.call('received', 'chat', 1))[0],
			here: (await own.call('received', 'chat', 1))[0]?.text,
			lastCheck:
				Math.round(
					(Math.max(...sinks.flatMap((one) => one.packets.map((p) => p.at))) -
						start) /
						100,
				) / 10,
			quietFor: Math.round((Date.now() - quiet) / 100) / 10,
		};
		await own.call('close');
		await until(
			async () => !proxied || (await count()).peer === 0,
			10000,
			'the last stream closed',
		).catch(() => {});
		closed = await count();
	} catch (error) {
		failure = String(error).slice(0, 300);
	}
	await peer.call('close').catch(() => {});
	for (const one of sinks) one.close();
	const story = JSON.stringify({ opening, after, closed, life });
	if (!proxied) {
		// the browser's sockets are not connected to a remote, and what
		// it does with a candidate that never answers is its own business:
		// told, not checked
		ok(
			'natively: the page connects to the peer and checks the sinks',
			!failure &&
				opening?.heard >= 3 &&
				after?.there === 'still here' &&
				after?.here === 'and here' &&
				opening.peer === 0 &&
				opening.sinks === 0,
			failure ?? story,
		);
		console.log(
			`note: natively the sinks heard ${after?.heard ?? '?'} checks, the last ${after?.lastCheck ?? '?'} s after they were added`,
		);
		continue;
	}
	ok(
		`${label}: a stream opens to each remote the agent checks, the peer's and every sink's`,
		!failure && opening?.peer === 1 && opening?.sinks === 3,
		failure ?? story,
	);
	ok(
		`${label}: the streams of the pairs ICE gave up are closed while the connection goes on, and the sinks hear nothing after`,
		!failure &&
			after?.sinks === 0 &&
			after?.peer === 1 &&
			after?.since === 0 &&
			after?.there === 'still here' &&
			after?.here === 'and here',
		failure ?? story,
	);
	ok(
		`${label}: closing the connection closes its last stream`,
		!failure && closed?.peer === 0 && closed?.sinks === 0,
		failure ?? story,
	);
	console.log(
		`note: ${label}: streams to the peer and the sinks over the connection's life: ${life
			.map((entry) => `${entry.at} s ${entry.peer}+${entry.sinks}`)
			.join(
				', ',
			)}; the sinks' last check ${after?.lastCheck ?? '?'} s after they were added`,
	);
}

// --- TURN over TCP and over TLS (section 5.1) ---
//
// One connection names a server of each kind that works and of each kind
// that fails: what the page reads of each, as candidates, errors and
// stats entries, is Chrome's (measured on 152 and 156: a relay over TCP
// has type preference 1 and relayProtocol 'tcp', over TLS 0 and 'tls',
// both 'udp' candidates with the server's URL; a connection that fails is
// a 701 with no local address at once, one that never answers the
// allocate timeout after 40 s, no TLS within 30 s a 701 then). Then a
// connection that may only relay reaches the peer over each, and the
// server hears only the wisp server.

/** a port nothing listens on */
const freePort = () =>
	new Promise((resolve) => {
		const server = createServer().listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

const tcpTurn = await startTurn({
	transport: 'tcp',
	arrival: sockets.arrival,
});
const silentTcp = await startTurn({ transport: 'tcp', silent: true });
const deadTls = await startTurn({ transport: 'tls', handshake: false });
const good = { username: 'user', credential: 'secret' };
const at = (server) => `127.0.0.1:${server.port}`;
const SERVERS = [
	{ urls: `turn:${at(tcpTurn)}?transport=tcp`, ...good },
	{ urls: `turns:${at(tlsTurn)}`, ...good },
	{
		urls: `turn:${at(tcpTurn)}?transport=tcp`,
		username: 'user',
		credential: 'wrong',
	},
	{ urls: `turn:127.0.0.1:${await freePort()}?transport=tcp`, ...good },
	{ urls: `turns:127.0.0.1:${await freePort()}`, ...good },
	{ urls: `turn:${at(silentTcp)}?transport=tcp`, ...good },
	{ urls: `turns:${at(deadTls)}`, ...good },
];

/** in the page: a connection with `iceServers` gathers; what it read of each server */
const gatherProbe = async ([iceServers, ms]) => {
	const pc = new RTCPeerConnection({ iceServers });
	const started = performance.now();
	const candidates = [];
	const errors = [];
	pc.onicecandidate = ({ candidate }) => {
		if (candidate?.type === 'relay')
			candidates.push({
				url: candidate.url,
				protocol: candidate.protocol,
				relayProtocol: candidate.relayProtocol,
				priority: candidate.priority,
				address: candidate.address,
				line: candidate.candidate.split(' ').slice(2, 8).join(' '),
			});
	};
	pc.onicecandidateerror = (event) =>
		errors.push({
			url: event.url,
			errorCode: event.errorCode,
			errorText: event.errorText,
			address: event.address,
			port: event.port,
			hostCandidate: event.hostCandidate,
			at: Math.round(performance.now() - started),
		});
	pc.createDataChannel('probe');
	await pc.setLocalDescription(await pc.createOffer());
	const end = performance.now() + ms;
	while (pc.iceGatheringState !== 'complete' && performance.now() < end)
		await new Promise((resolve) => setTimeout(resolve, 100));
	const stats = [];
	(await pc.getStats()).forEach((entry) => {
		if (entry.type === 'local-candidate' && entry.candidateType === 'relay')
			stats.push({
				url: entry.url,
				protocol: entry.protocol,
				relayProtocol: entry.relayProtocol,
				priority: entry.priority,
			});
	});
	pc.close();
	return {
		candidates,
		errors,
		stats,
		complete: Math.round(performance.now() - started),
	};
};

/** each server's name in the checks, by its address */
const roles = new Map([
	[at(tcpTurn), 'tcp'],
	[at(tlsTurn), 'tls'],
	[at(silentTcp), 'tcp silent'],
	[at(deadTls), 'tls without a handshake'],
]);
/** what compares between the browser and the proxy: by server, without ports or times */
const byServer = (list, fields, sorted = true) => {
	const lines = list.map((entry) => {
		const [, scheme, address] = /^(\w+):([^?]+)/.exec(entry.url);
		const role = roles.get(address) ?? 'refused';
		return `${scheme} ${role}: ${fields.map((field) => entry[field]).join(' ')}`;
	});
	return sorted ? lines.sort() : lines;
};

const probes = [
	['natively', null],
	['same-origin', PROXY],
	['isolated', HOST],
];
const opened = await Promise.all(probes.map(([, base]) => page(browser, base)));
pages.push(...opened);
const gathered = await Promise.all(
	opened.map(({ frame }) =>
		frame()
			.evaluate(gatherProbe, [SERVERS, 60000])
			.catch((error) => ({ failure: String(error).slice(0, 300) })),
	),
);
const native = gathered[0];
const relayFields = ['protocol', 'relayProtocol', 'priority', 'line'];
const errorFields = ['errorCode', 'errorText'];
const legacy = browser.version().startsWith('152.');
ok(
	'natively: a relay over TCP and over TLS, a 401 and four 701s',
	!native.failure &&
		native.candidates.length === 2 &&
		native.errors.length === 5 &&
		native.stats.length === 2,
	JSON.stringify(native),
);
for (const [i, [label]] of probes.entries()) {
	if (!i) continue;
	const got = gathered[i];
	const shape = (result) =>
		JSON.stringify([
			byServer(
				result.candidates.map((candidate) => ({
					...candidate,
					// the relayed port is the server's to choose
					line: candidate.line.replace(/ \d+ typ/, ' X typ'),
				})),
				relayFields,
			),
			byServer(result.stats, ['protocol', 'relayProtocol', 'priority']),
			byServer(result.errors, errorFields),
			// in the order they came
			byServer(result.errors, ['errorCode'], false)
				.map((line) => line.replace(/^(\w+ [^:]+):.*/, '$1'))
				.join(),
		]);
	ok(
		`${label}: the relay candidates, their stats and the errors of TURN servers over TCP and TLS read as Chrome's`,
		!got.failure && !native.failure && shape(got) === shape(native),
		got.failure ?? `${shape(got)} natively ${shape(native)}`,
	);
	// the errors have no local address: the browser's would be a socket of
	// this machine, the proxy has none (a failed TLS connection is written
	// on the address Chrome 152 hides)
	const wrong = got.errors?.filter(
		(error) =>
			error.address !== null ||
			error.port !== null ||
			error.hostCandidate !==
				(legacy &&
				error.url.startsWith('turns:') &&
				error.errorText === 'Failed to establish connection'
					? '0.0.0.x:0'
					: ':0'),
	);
	ok(
		`${label}: an error of a TURN server over TCP or TLS has no local address`,
		!got.failure && wrong.length === 0,
		JSON.stringify(wrong ?? got),
	);
	const timing = Object.fromEntries(
		(got.errors ?? []).map((error) => [error.url, error.at]),
	);
	console.log(
		`note: ${label}: errors at ${JSON.stringify(timing)} ms, gathering complete at ${got.complete} ms; natively ${JSON.stringify(Object.fromEntries((native.errors ?? []).map((error) => [error.url, error.at])))}, ${native.complete} ms`,
	);
}
for (const entry of opened) await entry.page.close();

// a connection that may only relay, over each, to the peer
for (const [kind, server] of [
	['TCP', { urls: `turn:${at(tcpTurn)}?transport=tcp`, ...good }],
	['TLS', { urls: `turns:${at(tlsTurn)}`, ...good }],
]) {
	const turn = kind === 'TCP' ? tcpTurn : tlsTurn;
	for (const [label, base] of probes) {
		const opened = await page(browser, base);
		pages.push(opened);
		const own = pageEnd(opened.frame);
		const peer = nodeEnd();
		const connections = turn.connections.length;
		const relayed = turn.relayed;
		let failure = null;
		let result = null;
		try {
			await own.call('open', {
				iceServers: [server],
				iceTransportPolicy: 'relay',
			});
			await own.call('channels', [['chat', {}]]);
			await peer.call('open');
			const offer = await own.call('offer');
			const answer = await peer.call('answer', offer);
			await own.call('accept', answer);
			await own.call('opened', 'chat');
			await peer.call('opened', 'chat');
			await own.call('send', 'chat', { text: `over ${kind}` });
			await peer.call('send', 'chat', 'and back');
			const read = await own.call('read');
			result = {
				there: (await peer.call('received', 'chat', 1))[0],
				here: (await own.call('received', 'chat', 1))[0]?.text,
				pair: read.pair,
				offered: / typ relay /.test(offer) && !/ typ (host|srflx) /.test(offer),
			};
		} catch (error) {
			failure = String(error).slice(0, 300);
		}
		await own.call('close').catch(() => {});
		await peer.call('close').catch(() => {});
		const heard = sockets.senders(turn.connections.slice(connections), 'tcp');
		const by = base ? 'server' : 'browser';
		ok(
			`${label}: a connection that may only relay reaches the peer through a TURN server over ${kind}, which hears only ${base ? 'the wisp server' : 'the browser'}`,
			!failure &&
				result.there === `over ${kind}` &&
				result.here === 'and back' &&
				result.offered &&
				result.pair?.local?.type === 'relay' &&
				turn.relayed > relayed &&
				heard.length > 0 &&
				heard.every((who) => who === by),
			failure ?? JSON.stringify({ ...result, heard: tally(heard) }),
		);
		await opened.page.close();
	}
}
tcpTurn.close();
tlsTurn.close();
silentTcp.close();
deadTls.close();

// --- an ICE restart the peer starts (section 5.3) ---
//
// The page offers, the peer answers, and once messages flow the peer
// restarts ICE: its new offer has new credentials, the page answers it
// and gathers again, and the channel goes on. What the page reads on the
// way (its events, its new candidates and credentials) is what it reads
// natively, with werift and with Chrome's own stack as the peer; Chrome's
// connection stays connected throughout (152 sometimes reads disconnected
// for a moment when the offer carries its candidates, 156 never does).

// the far end's browser: its pages have media access, so its own stack
// shows its host candidates' addresses
const far = await launch(['--use-fake-ui-for-media-stream']);
const farPage = await page(far, null);
const ufragOf = (sdp) => /a=ice-ufrag:(\S+)/.exec(sdp ?? '')?.[1];
/** what the page's own log says of a restart, its transitions of ICE and of the connection apart */
const restartLog = (log) =>
	log.filter((entry) => !/^(ice|connection):/.test(entry)).join();
const restarts = {};
for (const peerKind of ['werift', 'Chrome']) {
	for (const [label, base] of probes) {
		const opened = await page(browser, base);
		pages.push(opened);
		const own = pageEnd(opened.frame);
		const peer = peerKind === 'werift' ? nodeEnd() : pageEnd(farPage.frame);
		let failure = null;
		let result = null;
		try {
			await own.call('open', { iceServers: [] });
			await own.call('channels', [['chat', {}]]);
			await peer.call('open', { iceServers: [] });
			const offer = await own.call('offer');
			const answer = await peer.call('answer', offer);
			await own.call('accept', answer);
			await own.call('opened', 'chat');
			await own.call('send', 'chat', { text: 'before' });
			const before = await own.call('read');
			const shown = (await own.call('candidates')).candidates.length;
			const restart =
				peerKind === 'werift'
					? await peer.call('offer', { restart: true })
					: (await peer.call('restart'), await peer.call('offer'));
			const again = await own.call('answer', restart);
			await peer.call('accept', again);
			await own.call('send', 'chat', { text: 'after' });
			await peer.call(
				'send',
				'chat',
				peerKind === 'werift' ? 'and back' : { text: 'and back' },
			);
			await own.call('state', 'connected', 10000);
			const read = await own.call('read');
			const gathered = (await own.call('candidates')).candidates;
			result = {
				log: restartLog(read.log.slice(before.log.length)),
				transitions: read.log
					.slice(before.log.length)
					.filter((entry) => /^(ice|connection):/.test(entry))
					.join(),
				connection: read.connection,
				fresh:
					ufragOf(again) !== ufragOf(before.local) &&
					ufragOf(again) === ufragOf(read.local),
				candidates: gathered.map((candidate) =>
					candidate.candidate
						.replace(/^candidate:\d+ /, 'candidate:X ')
						.replace(/ \S+ \d+ typ/, ' X X typ')
						.replace(
							/ ufrag \S+/,
							` ufrag ${candidate.usernameFragment === ufragOf(again) ? 'new' : 'old'}`,
						),
				),
				earlier: shown,
				there: (await peer.call('received', 'chat', 2)).map(
					(message) => message.text ?? message,
				),
				here: (await own.call('received', 'chat', 1))[0]?.text,
			};
		} catch (error) {
			failure = String(error).slice(0, 300);
		}
		await own.call('close').catch(() => {});
		await peer.call('close').catch(() => {});
		await opened.page.close();
		restarts[`${peerKind} ${label}`] = result;
		const native = restarts[`${peerKind} natively`];
		const summary = failure ?? JSON.stringify(result);
		if (!base) {
			ok(
				`natively, with ${peerKind}: the peer restarts ICE, the page answers with new credentials and the channel goes on`,
				!failure &&
					result.fresh &&
					result.connection === 'connected' &&
					result.here === 'and back',
				summary,
			);
			continue;
		}
		ok(
			`${label}, with ${peerKind}: the peer restarts ICE, the page answers with new credentials, gathers again as natively, and the channel goes on`,
			!failure &&
				native &&
				result.fresh &&
				result.connection === 'connected' &&
				result.log === native.log &&
				JSON.stringify(result.candidates) ===
					JSON.stringify(native.candidates) &&
				result.there.join() === 'before,after' &&
				result.here === 'and back',
			`${summary} natively ${JSON.stringify(native)}`,
		);
		ok(
			`${label}, with ${peerKind}: the connection stays connected through the peer's restart`,
			!failure && !/checking|failed|closed/.test(result.transitions),
			summary,
		);
	}
}
await far.close();

/**
 * In the page: two connections of its own (over the bridge between
 * documents of this browser), the answerer restarts ICE and each side sets
 * the other's description at once, before it has its new candidates;
 * then a candidate nobody is at, which the agent gives up on
 */
const restartAtOnce = async (ms) => {
	const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));
	const connect = async (from, to) => {
		await from.setLocalDescription();
		await to.setRemoteDescription(from.localDescription);
		await to.setLocalDescription();
		await from.setRemoteDescription(to.localDescription);
	};
	const a = new RTCPeerConnection();
	const b = new RTCPeerConnection();
	for (const [one, other] of [
		[a, b],
		[b, a],
	])
		one.onicecandidate = ({ candidate }) =>
			candidate && other.addIceCandidate(candidate).catch(() => {});
	const channel = a.createDataChannel('restart');
	const got = [];
	b.ondatachannel = ({ channel: theirs }) => {
		theirs.onmessage = ({ data }) => got.push(data);
	};
	await connect(a, b);
	for (let i = 0; i < 100 && channel.readyState !== 'open'; i++)
		await wait(100);
	for (const pc of [a, b]) pc.onicecandidate = null;
	b.restartIce();
	await connect(b, a);
	await a.addIceCandidate({
		candidate: 'candidate:7 1 udp 2122260223 127.0.0.1 9 typ host',
		sdpMid: '0',
		sdpMLineIndex: 0,
	});
	await wait(ms);
	channel.send('still here');
	await wait(500);
	const states = [a, b].map((pc) => pc.connectionState).join();
	a.close();
	b.close();
	return { states, got: got.join() };
};
for (const [label, base] of probes.slice(1)) {
	const opened = await page(browser, base);
	pages.push(opened);
	const result = await opened
		.frame()
		.evaluate(restartAtOnce, 25000)
		.catch((error) => ({ failure: String(error).slice(0, 300) }));
	await opened.page.close();
	ok(
		`${label}: after a restart whose descriptions carry no candidates yet, both connections stay connected once a pair is given up, and the channel goes on`,
		!result.failure &&
			result.states === 'connected,connected' &&
			result.got === 'still here',
		JSON.stringify(result),
	);
}

// --- ICE-TCP (RFC 6544; section 5.2) ---
//
// A peer whose only candidate is a passive TCP one (an SFU's ICE-TCP, here
// werift's): Chrome connects to it from its own TCP candidate, which it
// gathers behind mDNS names without showing it (152 and 156, measured),
// and the connection runs over that TCP connection. Through the proxy the
// TCP connection is a wisp stream, RFC 4571 framing on it, and the peer
// sees it come from the wisp server.
const passiveOnly = (sdp) =>
	sdp
		.split('\r\n')
		.filter(
			(line) =>
				!line.startsWith('a=candidate:') ||
				/ tcp \d+ \S+ \d+ typ host tcptype passive/.test(line),
		)
		.join('\r\n');
for (const [label, base] of probes) {
	const opened = await page(browser, base);
	pages.push(opened);
	const own = pageEnd(opened.frame);
	const peer = nodeEnd({ iceUseTcp: true, iceTcpPassive: true });
	let failure = null;
	let result = null;
	try {
		await own.call('open', { iceServers: [] });
		await own.call('channels', [['chat', {}]]);
		await peer.call('open');
		const offer = await own.call('offer');
		const answer = await peer.call('answer', offer);
		if (!/ tcp \d+ \S+ \d+ typ host tcptype passive/.test(answer))
			throw new Error('the peer offers no passive TCP candidate');
		await own.call('accept', passiveOnly(answer));
		await own.call('opened', 'chat');
		await peer.call('opened', 'chat');
		await own.call('send', 'chat', { text: 'over TCP' });
		await peer.call('send', 'chat', 'and back');
		const seen = await peer.call('read');
		result = {
			there: (await peer.call('received', 'chat', 1))[0],
			here: (await own.call('received', 'chat', 1))[0]?.text,
			seen,
			owner: seen && (await sockets.owner(seen.port, 'tcp')),
			pair: (await own.call('read')).pair,
		};
	} catch (error) {
		failure = String(error).slice(0, 300);
	}
	await own.call('close').catch(() => {});
	await peer.call('close').catch(() => {});
	await opened.page.close();
	ok(
		`${label}: a connection to a peer whose only candidate is a passive TCP one runs over TCP, from ${base ? "the wisp server's socket" : "the browser's"}`,
		!failure &&
			result.there === 'over TCP' &&
			result.here === 'and back' &&
			result.seen?.protocol === 'tcp' &&
			result.owner === (base ? 'server' : 'browser') &&
			result.pair?.local?.protocol === 'tcp',
		failure ?? JSON.stringify(result),
	);
}

const errors = pages.flatMap((entry) => entry.page.errors);
await sockets.stop();
await done(browser, errors);
