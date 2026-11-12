// The network side of a proxied page's RTCPeerConnection
// (docs/webrtc-over-wisp.md, sections 5 and 15): what the wisp streams of
// a connection do over its life. test/pages/webrtc-peer.html is the page,
// natively (the control) and through the proxy in both demo modes; the far
// end is a peer in this process (werift, bound to loopback), and the
// remote candidates nothing answers at are UDP sinks of this process.
// A stream is a socket of the demo's wisp server connected to one remote
// (test/sockets.mjs counts them); the browser's own sockets never are.
import { createSocket } from 'node:dgram';
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
import { watchSockets } from '../sockets.mjs';

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
function nodeEnd() {
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
				iceInterfaceAddresses: { udp4: '127.0.0.1' },
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

const browser = await launch();
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

const errors = pages.flatMap((entry) => entry.page.errors);
await sockets.stop();
await done(browser, errors);
