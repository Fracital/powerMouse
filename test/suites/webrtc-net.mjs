// The network side of a proxied page's RTCPeerConnection
// (docs/webrtc-over-wisp.md, sections 5 and 15): what the wisp streams of
// a connection do over its life, TURN servers over TCP and TLS
// (test/turn.mjs), an ICE restart the peer starts, ICE-TCP, and a far end
// that vanishes. test/pages/webrtc-peer.html is the page,
// natively (the control) and through the proxy in both demo modes; the far
// end is a peer in this process (werift, bound to loopback), and the
// remote candidates nothing answers at are UDP sinks of this process.
// A stream is a socket of the demo's wisp server connected to one remote
// (test/sockets.mjs counts them); the browser's own sockets never are.
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
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
		/** what the channel received so far */
		heard: (name) => channels.get(name)?.messages ?? [],
		close: () => pc.close(),
	};
	return { call: async (step, ...args) => steps[step](...args) };
}

/** a list of state transitions ({ at, what }) as text, and when one came */
const named = (list) => list.map((entry) => entry.what).join();
const when = (list, what) => list.find((entry) => entry.what === what)?.at;

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
	// the tone a page sends, from an AudioContext no gesture started
	'--autoplay-policy=no-user-gesture-required',
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
	let watched = null;
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
		await own.call('watch');
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
		watched = await own.call('watched');
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
	// getStats lists a sink's pair, waiting and then in progress, until the
	// turn that gives it up, its remote candidate with it (Chrome 157: 15.07
	// s after its first check); the worker used to list it for ever
	const listing = sinks.map((one) => {
		const pair = watched?.pairs[one.address];
		const first = one.packets[0]?.at;
		return {
			states: pair?.states.map(([, state]) => state).join(),
			gone: pair?.gone && first && pair.gone - first,
			remoteGone: pair?.gone && watched.remotes[one.address]?.gone - pair.gone,
		};
	});
	ok(
		`${label}: getStats lists the pair of each sink, waiting then in progress, until about 15 s after its first check, and its remote candidate with it`,
		!failure &&
			listing.every(
				({ states, gone, remoteGone }) =>
					/^(waiting,)?in-progress$/.test(states) &&
					gone >= 14900 &&
					gone <= 15500 &&
					Math.abs(remoteGone) <= 60,
			),
		failure ?? JSON.stringify(listing),
	);
	console.log(
		`note: ${label}: the sinks' pairs left getStats ${listing.map(({ gone }) => gone).join(', ')} ms after their first checks`,
	);
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

// --- a connection that never connects (section 5.3) ---
//
// The page's only remote is a sink. Chrome 157, measured: checking (the
// ICE transport too) as the candidate is added, and at the turn that
// gives up the pair, 15.05 s after its first check, iceConnectionState and
// the ICE transport read disconnected and the connection failed, told in
// that order in one task; the pair and its remote candidate leave getStats
// then, and the transport's iceState there reads failed. The stack's
// connection read failed for both, and its pair stayed in getStats.

const withoutCandidates = (sdp) =>
	sdp
		.split('\r\n')
		.filter((line) => !line.startsWith('a=candidate:'))
		.join('\r\n');

const never = await Promise.all(
	[
		['natively', null],
		['same-origin', PROXY],
		['isolated', HOST],
	].map(async ([label, base]) => {
		const opened = await page(browser, base);
		pages.push(opened);
		const own = pageEnd(opened.frame);
		const peer = nodeEnd();
		const one = await sink();
		const result = { label };
		try {
			await own.call('open', { iceServers: [] });
			await own.call('channels', [['chat', {}]]);
			await peer.call('open');
			const offer = await own.call('offer');
			const answer = await peer.call('answer', withoutCandidates(offer));
			await own.call('accept', withoutCandidates(answer));
			await own.call('watch');
			const mid = /^a=mid:(.*)$/m.exec(offer.replace(/\r/g, ''))?.[1] ?? '0';
			const start = Date.now();
			await own.call('add', one.candidate(mid));
			await until(
				async () =>
					(await own.call('timeline')).some(
						([at, what]) => at >= start && what === 'connection:failed',
					),
				25000,
				'failed',
			).catch(() => {});
			await sleep(300);
			const first = one.packets[0]?.at;
			result.told = (await own.call('timeline'))
				.filter(([at]) => at >= start)
				.map(([at, what]) => ({ at: at - first, what }));
			const watched = await own.call('watched');
			const pair = watched.pairs[one.address];
			result.reads = watched.reads.join();
			result.pair = pair?.states.map(([, state]) => state).join();
			result.pairGone = pair?.gone && pair.gone - first;
			result.remoteGone =
				watched.remotes[one.address]?.gone &&
				watched.remotes[one.address].gone - first;
			result.iceState = watched.iceState;
			result.read = await own.call('read');
		} catch (error) {
			result.failure = String(error).slice(0, 300);
		}
		await own.call('close').catch(() => {});
		await peer.call('close').catch(() => {});
		one.close();
		await opened.page.close();
		return result;
	}),
);
for (const result of never) {
	const native = never[0];
	const failed = when(result.told ?? [], 'connection:failed');
	const story = JSON.stringify({ ...result, read: undefined });
	// Chrome tells the three at the turn that gives up its pair in this
	// order, the ICE transport already disconnected at the first; natively
	// a loaded host may reorder them (as the far end gone below), so there
	// any order within the 5 ms
	const last = (result.told ?? []).slice(3).map(({ what }) => what);
	const states =
		!result.failure &&
		(named(result.told) ===
			'ice:checking,iceTransport:checking,connection:connecting,ice:disconnected,iceTransport:disconnected,connection:failed' ||
			(result === native &&
				named(result.told.slice(0, 3)) ===
					'ice:checking,iceTransport:checking,connection:connecting' &&
				last.length === 3 &&
				[
					'ice:disconnected',
					'iceTransport:disconnected',
					'connection:failed',
				].every((what) => last.includes(what)))) &&
		(result.reads === 'checking:checking,disconnected:disconnected' ||
			(result === native &&
				result.reads?.startsWith('checking:checking,disconnected:'))) &&
		result.told.at(-1).at - result.told.at(-3).at <= 5 &&
		failed >= 15000 &&
		failed <= 15150 &&
		result.read.ice === 'disconnected' &&
		result.read.connection === 'failed';
	const stats =
		!result.failure &&
		result.pair === 'in-progress' &&
		Math.abs(result.pairGone - failed) <= 60 &&
		Math.abs(result.remoteGone - failed) <= 60 &&
		result.iceState === 'failed';
	ok(
		`${result.label}, a connection that never connects: checking, then 15.05 s after its first check iceConnectionState and its ICE transport disconnected and the connection failed, in that order and at once${result === native ? '' : ', as natively'}`,
		states &&
			(result === native ||
				(native.told &&
					Math.abs(failed - when(native.told, 'connection:failed')) <= 100)),
		story,
	);
	ok(
		`${result.label}, a connection that never connects: getStats lists its pair in progress until then, its remote candidate with it, and then the transport's iceState failed`,
		stats,
		story,
	);
	console.log(
		`note: ${result.label}, a connection that never connects: ${named(result.told ?? [])} (${(result.told ?? []).map(({ at }) => at).join(', ')} ms after the first check), its pair gone ${result.pairGone} ms, getStats iceState ${result.iceState}`,
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

// --- the far end vanishes: consent freshness (RFC 7675, section 5.3) ---
//
// The page sends a tone and a message every 200 ms to the peer through a
// relay of this process, which then drops every datagram both ways, or
// closes the page's side so that the wisp server's socket is refused.
// Chrome 157, measured: its checks go unanswered, the connection reads
// disconnected 5 s after the first of them (iceConnectionState too) and
// sends nothing but checks from then on, and 10 s later it reads failed
// (iceConnectionState stays disconnected) and sends nothing at all. A
// check of the peer's that gets through again makes it disconnected, then
// connected; so does an ICE restart; and what the page sent meanwhile is
// sent again within 3 s (its SCTP timers back off to 3 s at most; with
// werift as the peer a message sent then arrived 1.3 to 15 s later). The
// stack's agent used to decide for itself, 22 s on, never failed, and went
// on sending media and retransmissions, opening a stream again now and
// then (10 s apart at the soonest) to a remote the wisp server refused.
//
// Chrome's checks of the pair it sends on, 157, measured: 2.656 s apart
// while it is answered, and from the turn after 2.5 s without a word from
// the peer every 62.5 ms, until it fails; disconnected 5 s after the first
// that went unanswered and failed 15 s after it, each on a turn of its
// 265.6 ms loop. The agent checked every 3 s. A path that passes nothing
// but checks (`stall`) leaves the connection connected; its data channel
// hands what the page sends to the network while it fits in 1191 bytes
// with what is outstanding, each message counting its chunk (20 bytes for
// these: 59 of them), and keeps the rest: send() says nothing, bufferedAmount reads only what it
// kept, and every message arrives, in order, once the path is back.
// sctp-proto handed on every one and read all it had not had acknowledged.

const kindOf = (bytes) =>
	bytes[0] < 4 ? (bytes[0] === 1 ? 'answer' : 'check') : 'traffic';

/** a relay between the page (at its socket `a`) and the peer, which can drop everything or close */
async function relay() {
	const a = createSocket('udp4');
	const b = createSocket('udp4');
	await new Promise((resolve) => a.bind(0, '127.0.0.1', resolve));
	await new Promise((resolve) => b.bind(0, '127.0.0.1', resolve));
	const state = { pass: true, peer: 0, page: null, sent: [], open: true };
	// `pass`: true, false, or 'stun' for checks and their answers only
	const passes = (message) =>
		state.pass === true || (state.pass === 'stun' && message[0] < 4);
	a.on('message', (message, from) => {
		state.sent.push({ at: Date.now(), kind: kindOf(message) });
		state.page = from;
		if (passes(message) && state.peer) b.send(message, state.peer, '127.0.0.1');
	});
	b.on('message', (message) => {
		if (passes(message) && state.page && state.open)
			a.send(message, state.page.port, state.page.address);
	});
	const { port } = a.address();
	return {
		port,
		state,
		/** the peer's description, with its UDP candidates moved here */
		through(sdp) {
			const found = / udp \d+ 127\.0\.0\.1 (\d+) typ host/.exec(sdp);
			if (found) state.peer = Number(found[1]);
			return sdp
				.split('\r\n')
				.filter((line) => !/^a=candidate:\S+ \d+ tcp /i.test(line))
				.map((line) =>
					line.replace(
						/ udp (\d+) 127\.0\.0\.1 \d+ typ/,
						` udp $1 127.0.0.1 ${port} typ`,
					),
				)
				.join('\r\n');
		},
		/** the page's side goes: its port is closed */
		refuse() {
			state.open = false;
			a.close();
		},
		close() {
			if (state.open) a.close();
			b.close();
		},
	};
}

/**
 * The streams the demo's wisp server opened to 127.0.0.1:`port`, each by
 * when it said so (ms after `start`): every one, from its log (the runner's
 * WISP_LOG), as a socket that opens and closes between two looks at the
 * system's list is never seen there
 */
async function streamsTo(port, start) {
	// what the server said last is on its way to the file
	await sleep(500);
	const opened = new RegExp(` stream \\d+ open to 127\\.0\\.0\\.1:${port}$`);
	return readFileSync(process.env.WISP_LOG, 'utf8')
		.split('\n')
		.filter((line) => opened.test(line))
		.map((line) => Number(line.slice(0, line.indexOf(' '))) - start)
		.filter((at) => at >= 0);
}

/** the page's state transitions from `start` on, at their times after it */
const transitionsSince = (timeline, start) =>
	timeline
		.filter(([at]) => at >= start)
		.map(([at, what]) => ({ at: at - start, what }));

/**
 * A connection through a relay to the peer, whose far end goes: `vanish`
 * (then an ICE restart once it failed), `revive` (the relay passes again
 * 20 s on, no restart) or `refuse`
 */
async function farEndGone(opened, how) {
	const own = pageEnd(opened.frame);
	const peer = nodeEnd();
	const path = await relay();
	const result = { how };
	let watching = true;
	try {
		await own.call('open', { iceServers: [] });
		await own.call('channels', [['chat', {}]]);
		await own.call('tone');
		await peer.call('open');
		const offer = await own.call('offer');
		await own.call('accept', path.through(await peer.call('answer', offer)));
		await own.call('opened', 'chat');
		await peer.call('opened', 'chat');
		await own.call('pulse', 'chat', 200);
		// long enough for the checks to settle (natively 2.656 s apart from
		// 4.9 s after it connected)
		await sleep(9000);
		const start = Date.now();
		if (how === 'refuse') path.refuse();
		else path.state.pass = false;
		// the checks it sends, as its getStats counts them, until it failed
		// (a pair it gave up leaves the report)
		const counted = [];
		const counting =
			how === 'refuse' &&
			(async () => {
				while (watching) {
					counted.push(await own.call('checks'));
					await sleep(100);
				}
			})();
		if (how === 'revive') {
			await sleep(20000);
			path.state.pass = true;
			result.resumed = Date.now() - start;
			await own.call('state', 'connected', 15000);
		} else {
			await until(
				async () =>
					named(transitionsSince(await own.call('timeline'), start)).includes(
						'connection:failed',
					),
				30000,
				'failed',
			).catch(() => {});
			// and what goes out once it failed
			await sleep(how === 'refuse' ? 10000 : 5000);
		}
		watching = false;
		result.gone = transitionsSince(await own.call('timeline'), start);
		const disconnected =
			when(result.gone, 'connection:disconnected') ?? Infinity;
		const failed = when(result.gone, 'connection:failed') ?? Infinity;
		const sent = path.state.sent
			.filter((packet) => packet.at >= start)
			.map((packet) => ({ ...packet, at: packet.at - start }));
		result.lastTraffic = Math.max(
			0,
			...sent.filter((p) => p.kind === 'traffic').map((p) => p.at),
		);
		result.lastAny = Math.max(0, ...sent.map((p) => p.at));
		result.trafficAfterDisconnected = sent.filter(
			(p) =>
				p.kind === 'traffic' &&
				p.at > disconnected + 300 &&
				p.at < (result.resumed ?? Infinity),
		).length;
		result.anyAfterFailed = sent.filter(
			(p) => p.at > failed + 300 && p.at < (result.resumed ?? Infinity),
		).length;
		// the checks: the last two gaps before it went, and after
		const checks = path.state.sent
			.filter((packet) => packet.kind === 'check')
			.map((packet) => packet.at - start);
		const before = checks.filter((at) => at < 0).slice(-3);
		result.steady = before.slice(1).map((at, n) => at - before[n]);
		const after = checks.filter(
			(at) => at >= 0 && at < (result.resumed ?? Infinity),
		);
		result.firstUnanswered = after[0];
		result.lastCheck = after.at(-1);
		const gaps = after.slice(1).map((at, n) => at - after[n]);
		const fastFrom = gaps.findIndex((gap) => gap < 100);
		result.fastFrom = fastFrom < 0 ? null : after[fastFrom];
		const fast = fastFrom < 0 ? [] : gaps.slice(fastFrom);
		result.fastChecks = fast.length;
		// natively 62 or 63 ms, as the relay's clock reads them; the
		// stack's went at its next wake for the bandwidth estimate, 50 and
		// 75 ms apart
		result.fastOff = fast.filter((gap) => gap < 55 || gap > 70).length;
		if (counting) {
			await counting;
			result.checks = Math.max(...counted) - counted[0];
			result.streams = await streamsTo(path.port, start);
		}
		let since = start + (result.resumed ?? 0);
		if (how === 'vanish') {
			since = Date.now();
			path.state.pass = true;
			const restart = await own.call('offer', { iceRestart: true });
			await own.call(
				'accept',
				path.through(await peer.call('answer', restart)),
			);
			await own.call('state', 'connected', 15000);
		}
		if (how !== 'refuse') {
			const back = Date.now();
			await own.call('send', 'chat', { text: 'back' });
			await until(
				async () => (await peer.call('heard', 'chat')).includes('back'),
				15000,
				'the message after',
			).catch(() => {});
			result.heardAfter = Date.now() - back;
			result.after = named(
				transitionsSince(await own.call('timeline'), since),
			).replace(
				/^(ice:disconnected,connection:disconnected,connection:failed,)/,
				'',
			);
		}
		result.ice = (await own.call('read')).ice;
	} catch (error) {
		result.failure = String(error).slice(0, 300);
	}
	watching = false;
	await own.call('close').catch(() => {});
	await peer.call('close').catch(() => {});
	path.close();
	return result;
}

/**
 * A connection through a relay to the peer that passes nothing but checks
 * and their answers for 14 s while the page sends a message every 200 ms:
 * what send() said, the bufferedAmount after each and what the peer heard
 */
async function stalled(opened) {
	const own = pageEnd(opened.frame);
	const peer = nodeEnd();
	const path = await relay();
	const result = { how: 'stall' };
	try {
		await own.call('open', { iceServers: [] });
		await own.call('channels', [['chat', {}]]);
		await peer.call('open');
		const offer = await own.call('offer');
		await own.call('accept', path.through(await peer.call('answer', offer)));
		await own.call('opened', 'chat');
		await peer.call('opened', 'chat');
		await own.call('pulse', 'chat', 200);
		await sleep(5000);
		const start = Date.now();
		path.state.pass = 'stun';
		await sleep(14000);
		path.state.pass = true;
		const back = Date.now();
		const pulses = await own.call('pulses', 'chat');
		const into = pulses.filter(([at]) => at >= start && at < back);
		// handed on: bufferedAmount reads the message just sent, not yet
		// taken, and nothing before it; so does it for the first kept, and
		// the one after it reads more
		result.handedOn =
			into.findIndex(([, n, amount]) => amount !== `p${n}`.length) - 1;
		result.held = into.at(-1)?.[2];
		// what it kept: every message from the first it did not hand on
		result.kept = into
			.slice(result.handedOn)
			.reduce((sum, [, n]) => sum + `p${n}`.length, 0);
		result.errors = pulses.filter(([, , , said]) => said).length;
		const last = into.at(-1)?.[1] ?? 0;
		const sent = Array.from({ length: last + 1 }, (_, n) => `p${n}`);
		const pulsed = () =>
			peer
				.call('heard', 'chat')
				.then((heard) => heard.filter((m) => /^p\d+$/.test(m)));
		await until(
			async () => (await pulsed()).length > last,
			15000,
			'the messages held',
		).catch(() => {});
		result.deliveredAfter = Date.now() - back;
		const heard = await pulsed();
		result.inOrder = sent.every((text, n) => heard[n] === text);
		result.heard = heard.length;
		result.ice = (await own.call('read')).ice;
		result.states = named(transitionsSince(await own.call('timeline'), start));
	} catch (error) {
		result.failure = String(error).slice(0, 300);
	}
	await own.call('close').catch(() => {});
	await peer.call('close').catch(() => {});
	path.close();
	return result;
}

const gone = await Promise.all(
	probes.flatMap(([label, base]) =>
		['vanish', 'revive', 'refuse', 'stall'].map(async (how) => {
			const opened = await page(browser, base);
			pages.push(opened);
			const result =
				how === 'stall' ? await stalled(opened) : await farEndGone(opened, how);
			await opened.page.close();
			return { label, base, ...result };
		}),
	),
);
for (const result of gone) {
	const { label, base, how } = result;
	const native = gone.find((one) => one.base === null && one.how === how);
	const story = `${JSON.stringify(result)}${base ? ` natively ${JSON.stringify(native)}` : ''}`;
	if (how === 'stall') {
		// natively 59 (1191 bytes at 20 a message), and the rest kept
		const held =
			!result.failure &&
			result.errors === 0 &&
			result.handedOn >= 55 &&
			result.handedOn <= 65 &&
			result.held === result.kept &&
			result.inOrder &&
			result.states === '';
		if (!base)
			ok(
				'natively, a path that passes only checks: the channel hands on 59 messages or so and keeps the rest, bufferedAmount reading what it keeps, send() says nothing, and all arrive in order once the path is back',
				held,
				story,
			);
		else
			ok(
				`${label}, a path that passes only checks: the channel hands on as many messages as natively and keeps the rest, bufferedAmount reading what it keeps, send() says nothing, and all arrive in order once the path is back`,
				held &&
					native &&
					Math.abs(result.handedOn - native.handedOn) <= 1 &&
					result.deliveredAfter < 4000,
				story,
			);
		console.log(
			`note: ${label}, a path that passes only checks: ${result.handedOn} messages handed on, bufferedAmount ${result.held} at the last, ${result.heard} heard ${result.deliveredAfter} ms after it was back (${result.states || 'connected throughout'})`,
		);
		continue;
	}
	const disconnected = when(result.gone ?? [], 'connection:disconnected');
	const failed = when(result.gone ?? [], 'connection:failed');
	const far = how === 'refuse' ? 'refused' : 'gone';
	// disconnected 5 s after the first check that went unanswered (the
	// last was answered up to a few seconds before), failed 10 s later.
	// Chrome tells iceconnectionstatechange first, but once on CI's loaded
	// 4-vCPU runner its connectionstatechange came first, in the same
	// millisecond: natively either order, through the proxy Chrome's usual
	const told = named(result.gone?.slice(0, 3) ?? []);
	const states =
		!result.failure &&
		(told === 'ice:disconnected,connection:disconnected,connection:failed' ||
			(!base &&
				told === 'connection:disconnected,ice:disconnected,connection:failed' &&
				result.gone[1].at - result.gone[0].at <= 50)) &&
		disconnected >= 4000 &&
		disconnected <= 10000 &&
		failed - disconnected >= 9000 &&
		failed - disconnected <= 11000;
	const quiet =
		result.trafficAfterDisconnected === 0 && result.anyAfterFailed === 0;
	// the relay sees the checks of the pair sent on unless its port closed.
	// Chrome checks it 2656.25 ms apart (2500 ms or more on its 265.625 ms
	// turns), but a loaded host holds a check: on CI's runner one came 98
	// ms late, 2573 and 2641 ms from the next ones. Natively a check may be
	// held 200 ms; through the proxy the gaps are Chrome's unloaded ones
	const slack = base ? 0 : 200;
	const cadence =
		how === 'refuse' ||
		(!result.failure &&
			result.steady.length === 2 &&
			result.steady.every(
				(gap) => gap >= 2600 - slack && gap <= 2720 + slack,
			) &&
			result.fastFrom >= 2100 &&
			result.fastFrom <= 3000 &&
			result.fastChecks >= 150 &&
			result.fastOff * 10 <= result.fastChecks &&
			disconnected - result.firstUnanswered >= 4950 &&
			disconnected - result.firstUnanswered <= 5350 &&
			failed - result.firstUnanswered >= 14950 &&
			failed - result.firstUnanswered <= 15350 &&
			result.lastCheck >= failed - 400 &&
			result.lastCheck <= failed + 300);
	if (!base) {
		ok(
			`natively, the far end ${far}: disconnected about 5 s after the first unanswered check and failed 10 s later, nothing but checks sent between and nothing after`,
			states && quiet,
			story,
		);
		if (how !== 'refuse')
			ok(
				`natively, the far end ${far}: the pair sent on checked 2.66 s apart, then every 62.5 ms from about 2.5 s on until it failed; disconnected 5 s and failed 15 s after the first unanswered check`,
				cadence,
				story,
			);
		console.log(
			`note: natively, the far end ${far} (${how}): checked ${result.steady?.join(', ')} ms apart, from ${result.firstUnanswered} ms unanswered and every 62.5 ms from ${result.fastFrom} ms (${result.fastChecks} checks, the last ${result.lastCheck} ms); disconnected ${disconnected} ms and failed ${failed} ms after, the last traffic sent ${result.lastTraffic} ms and the last packet ${result.lastAny} ms after${result.checks === undefined ? '' : `, ${result.checks} checks sent to the closed port`}${result.heardAfter === undefined ? '' : `; a message sent once it was back arrived in ${result.heardAfter} ms (${result.after})`}`,
		);
		continue;
	}
	ok(
		`${label}, the far end ${far}: the connection reads disconnected about 5 s after its first unanswered check and failed 10 s later, iceConnectionState staying disconnected, as natively`,
		states && native && result.ice === native.ice,
		story,
	);
	ok(
		`${label}, the far end ${far}: from disconnected on nothing but checks goes out, and from failed on nothing`,
		!result.failure && quiet,
		story,
	);
	if (how !== 'refuse')
		ok(
			`${label}, the far end ${far}: the pair sent on is checked as natively, 2.66 s apart and then every 62.5 ms from about 2.5 s on until it failed, so that it reads disconnected 5 s and failed 15 s after the first unanswered check`,
			cadence,
			story,
		);
	if (how === 'refuse')
		ok(
			`${label}: a remote the wisp server refused is asked again by each check, as Chrome sends each check to a port that refused the last: a stream for each (as many checks as natively), none once the connection failed`,
			!result.failure &&
				native &&
				// the first went on the stream the server then refused
				result.streams.length >= result.checks - 2 &&
				result.streams.length <= result.checks &&
				result.streams.length >= 150 &&
				Math.abs(result.checks - native.checks) <= native.checks / 10 &&
				result.streams.every((at) => at < failed + 300),
			story,
		);
	else
		ok(
			`${label}: ${how === 'vanish' ? 'an ICE restart after it failed' : 'a check of the peer that gets through after it failed'} connects it again as natively, and a message then arrives within 4 s`,
			!result.failure &&
				native &&
				result.after === native.after &&
				result.heardAfter < 4000,
			story,
		);
	console.log(
		`note: ${label}, the far end ${far} (${how}): checked ${result.steady?.join(', ')} ms apart, from ${result.firstUnanswered} ms unanswered and every 62.5 ms from ${result.fastFrom} ms (${result.fastChecks} checks, the last ${result.lastCheck} ms); disconnected ${disconnected} ms and failed ${failed} ms after, the last traffic sent ${result.lastTraffic} ms and the last packet ${result.lastAny} ms after${result.streams ? `, ${result.checks} checks and ${result.streams.length} streams opened, the last ${result.streams.at(-1)} ms after` : ''}${result.heardAfter === undefined ? '' : `; a message sent once it was back arrived in ${result.heardAfter} ms (${result.after})`}`,
	);
}

const errors = pages.flatMap((entry) => entry.page.errors);
await sockets.stop();
await done(browser, errors);
