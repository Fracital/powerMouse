// A proxied page's RTCPeerConnection reaches real peers
// (docs/webrtc-over-wisp.md): STomp's stack in the page's WebRTC worker
// negotiates with another implementation and carries data channel messages
// both ways, every packet on a wisp stream. test/pages/webrtc-peer.html is
// one end, through the proxy in both demo modes; the far ends are
// - a peer in this process (werift, bound to loopback): the page offers, the
//   peer offers with trickled candidates, and a connection that may only
//   use a TURN relay (test/turn.mjs);
// - the browser's own stack, the same page loaded natively in a second
//   browser whose origin has media access (its host candidates are real
//   addresses, which a wisp server can reach): messages up to Chrome's
//   256 KiB limit both ways, an ICE restart, and the descriptions the
//   proxied page shows next to the ones Chrome writes;
// - another proxied page in the other browser, through the TURN server (two
//   proxied ends are each behind the wisp server, as behind a symmetric
//   NAT, and a relay is what joins them).
// Chrome resolves no name but localhost in either browser, so nothing here
// reaches a network. What the far end sees as the page's address must be a
// socket of the demo's wisp server and never one of the browser's
// (test/sockets.mjs samples which process owns which port), and the proxied
// page's own candidates are names and never one of this machine's
// addresses.
import { networkInterfaces } from 'node:os';
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
// a Binding answer waits, so that the stream that asked outlives a sample
const turn = await startTurn({ bindingDelay: 500 });
const turnServers = [
	{
		urls: `turn:127.0.0.1:${turn.port}`,
		username: 'user',
		credential: 'secret',
	},
];
const ADDRESSES = Object.values(networkInterfaces())
	.flat()
	.filter((entry) => !entry.internal)
	.map((entry) => entry.address.replace(/%.*$/, ''));

// --- the two kinds of end ---

const sum = (bytes) => {
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++)
		hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
	return hash;
};
const pattern = (size, seed = 0) => {
	const bytes = Buffer.alloc(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 255;
	return bytes;
};
/** what a message of `size` patterned bytes reads as at the far end */
const bytesOf = (size, seed = 0) => ({ size, sum: sum(pattern(size, seed)) });
const same = (got, want) =>
	got.length === want.length &&
	got.every((message, i) =>
		'text' in want[i]
			? message.text === want[i].text
			: message.size === want[i].size &&
				message.sum === want[i].sum &&
				(!want[i].kind || message.kind === want[i].kind),
	);
const brief = (messages) =>
	JSON.stringify(
		messages.map((message) =>
			'text' in message && message.text.length > 40
				? { text: `${message.text.slice(0, 40)}...`, size: message.text.length }
				: message,
		),
	);

async function until(test, ms, what) {
	const end = Date.now() + ms;
	while (!test()) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(25);
	}
}

/** a connection of the page in `frame`: steps are window.__peer's */
let names = 0;
function pageEnd(label, frame) {
	const name = `c${names++}`;
	return {
		label,
		call: (step, ...args) =>
			frame().evaluate(
				([step, name, args]) => window.__peer[step](name, ...args),
				[step, name, args],
			),
	};
}

// A name is no address to a peer that cannot ask the browser's resolver for
// it: it learns the page's address from the page's first check, as any
// peer of an end behind a NAT does
const withoutNames = (sdp) =>
	sdp
		.split('\r\n')
		.filter((line) => !/^a=candidate:.*\.local /.test(line))
		.join('\r\n');

/** a connection of the peer in this process, with the same steps */
function nodeEnd(label, options = {}) {
	let pc;
	const channels = new Map();
	const gathered = [];
	const track = (channel) => {
		const state = { channel, messages: [], events: [] };
		channels.set(channel.label, state);
		channel.onMessage.subscribe((data) =>
			state.messages.push(
				typeof data === 'string'
					? { text: data }
					: { kind: 'Buffer', size: data.length, sum: sum(data) },
			),
		);
		channel.stateChanged.subscribe((now) => state.events.push(now));
	};
	const complete = () =>
		until(() => pc.iceGatheringState === 'complete', 30000, 'peer gathering');
	const steps = {
		open() {
			pc = new RTCPeerConnection({
				// no server, and its own default (a public STUN server) off
				iceServers: [],
				iceUseDefaultStunServer: false,
				iceUseIpv6: false,
				iceAdditionalHostAddresses: ['127.0.0.1'],
				iceInterfaceAddresses: { udp4: '127.0.0.1' },
				...options,
			});
			pc.onDataChannel.subscribe(track);
			pc.onIceCandidate.subscribe((candidate) => {
				if (candidate) gathered.push(candidate.toJSON());
			});
		},
		channels(list) {
			for (const [name, init] of list) track(pc.createDataChannel(name, init));
		},
		async offer() {
			await pc.setLocalDescription(await pc.createOffer());
			await complete();
			return pc.localDescription.sdp;
		},
		async answer(sdp) {
			await pc.setRemoteDescription({ type: 'offer', sdp: withoutNames(sdp) });
			await pc.setLocalDescription(await pc.createAnswer());
			await complete();
			return pc.localDescription.sdp;
		},
		async accept(sdp) {
			await pc.setRemoteDescription({ type: 'answer', sdp: withoutNames(sdp) });
		},
		candidates() {
			return {
				candidates: gathered.splice(0),
				complete: pc.iceGatheringState === 'complete',
			};
		},
		async add(candidate) {
			if (!/\.local /.test(candidate.candidate))
				await pc.addIceCandidate(candidate);
		},
		async opened(name, ms = 30000) {
			await until(
				() => channels.get(name)?.channel.readyState === 'open',
				ms,
				`${name} open at the peer`,
			);
			const { channel } = channels.get(name);
			return {
				label: channel.label,
				ordered: channel.ordered,
				maxRetransmits: channel.maxRetransmits ?? null,
				maxPacketLifeTime: channel.maxPacketLifeTime ?? null,
				protocol: channel.protocol,
				negotiated: channel.negotiated,
				id: channel.id,
			};
		},
		send(name, what) {
			const { channel } = channels.get(name);
			channel.send('text' in what ? what.text : pattern(what.bytes, what.seed));
			return null;
		},
		async received(name, count, ms = 30000) {
			const state = channels.get(name);
			await until(
				() => state.messages.length >= count,
				ms,
				`${count} messages`,
			).catch((error) => state.messages.push({ error: error.message }));
			return state.messages.slice(0, count);
		},
		closeChannel(name) {
			channels.get(name).channel.close();
		},
		async channelState(name, state, ms = 30000) {
			const found = channels.get(name);
			await until(
				() => found.channel.readyState === state,
				ms,
				`${name} ${state}`,
			).catch(() => {});
			return { state: found.channel.readyState, events: found.events };
		},
		async state(state, ms = 30000) {
			await until(() => pc.connectionState === state, ms, state).catch(
				() => {},
			);
			return pc.connectionState;
		},
		read() {
			const remote = pc.iceTransports[0]?.connection.nominated?.remoteCandidate;
			return {
				connection: pc.connectionState,
				pair: remote && {
					remote: {
						address: remote.host,
						port: remote.port,
						type: remote.type,
					},
				},
			};
		},
		close() {
			return pc.close();
		},
	};
	return {
		label,
		call: async (step, ...args) => steps[step](...args),
	};
}

// --- signalling, carried by the suite ---

const stripped = (sdp) =>
	sdp
		.split('\r\n')
		.filter((line) => !/^a=(candidate:|end-of-candidates)/.test(line))
		.join('\r\n');
const candidatesIn = (sdp) =>
	sdp
		.split('\r\n')
		.filter((line) => line.startsWith('a=candidate:'))
		.map((line) => ({
			candidate: line.slice(2),
			sdpMid: /^a=mid:(.*)$/m.exec(sdp.replace(/\r/g, ''))?.[1] ?? '0',
			sdpMLineIndex: 0,
		}));

/**
 * An offer from `offerer` answered by `answerer`. With `trickle`, each
 * description travels without candidates and each candidate on its own
 * afterwards, as it is gathered (an end that only tells its candidates in
 * its description has them cut out of it and sent after).
 */
async function negotiate(offerer, answerer, { trickle = false, ...how } = {}) {
	const sent = { offerer: [], answerer: [] };
	if (!trickle) {
		const offer = await offerer.call('offer', how);
		const answer = await answerer.call('answer', offer);
		await offerer.call('accept', answer);
		return { offer, answer, sent };
	}
	const offer = await offerer.call('offer', { ...how, trickle: true });
	const answer = await answerer.call('answer', stripped(offer), {
		trickle: true,
	});
	await offerer.call('accept', stripped(answer));
	const pending = {
		offerer: candidatesIn(offer),
		answerer: candidatesIn(answer),
	};
	const end = Date.now() + 60000;
	for (;;) {
		const [from, to] = await Promise.all([
			offerer.call('candidates'),
			answerer.call('candidates'),
		]);
		pending.offerer.push(...from.candidates);
		pending.answerer.push(...to.candidates);
		for (const candidate of pending.offerer.splice(0)) {
			sent.offerer.push(candidate);
			await answerer.call('add', candidate);
		}
		for (const candidate of pending.answerer.splice(0)) {
			sent.answerer.push(candidate);
			await offerer.call('add', candidate);
		}
		if ((from.complete && to.complete) || Date.now() > end) break;
		await sleep(50);
	}
	return { offer, answer, sent };
}

/** each of `messages` sent from one end; `to` is who reads them */
async function carried(from, to, channel, messages) {
	const refused = [];
	for (const message of messages) {
		const error = await from.call('send', channel, message);
		if (error) refused.push(error);
	}
	return { refused };
}
const wanted = (messages) =>
	messages
		.filter((message) => !message.lost)
		.map((message) =>
			'text' in message
				? { text: message.text }
				: {
						...bytesOf(message.bytes, message.seed ?? 0),
						...(message.reads ? { kind: message.reads } : {}),
					},
		);

/**
 * An empty string and an empty binary message from `from` on `channel`,
 * then a marker: what `to` reads after the `seen` messages it has, and what
 * the sender's channel said it had buffered (and how often it said that was
 * low). An unordered channel may hand them over in any order.
 */
async function emptiesCarried(from, to, channel, seen, ordered = true) {
	const buffered = await from.call('empties', channel);
	await from.call('send', channel, { text: 'after the empty ones' });
	const got = (await to.call('received', channel, seen + 3)).slice(seen);
	const read = got.map((message) =>
		'text' in message ? `text:${message.text}` : `bytes:${message.size}`,
	);
	if (!ordered) read.sort();
	return { read: read.join(), buffered };
}
/** nothing buffered after them, at once or later, and no bufferedamountlow */
const QUIET = '0,0,0,0';
const EMPTIES = {
	ordered: 'text:,bytes:0,text:after the empty ones',
	unordered: 'bytes:0,text:,text:after the empty ones',
};

/** a channel's open and close events, in order */
const lifeOf = ({ events }) =>
	events.filter((event) => event !== 'bufferedamountlow').join();

/** who owns the socket the far end sees the page at */
async function seenAs(end) {
	let pair;
	// a pair is selected a moment after the channels open
	for (let i = 0; i < 40 && !pair?.remote; i++) {
		if (i) await sleep(250);
		pair = (await end.call('read')).pair;
	}
	if (!pair?.remote) return { owner: 'no pair', pair };
	return { owner: await sockets.owner(pair.remote.port), pair: pair.remote };
}

/** what a proxied page read of its own end: no address of this machine, hosts only as names */
function ownAddresses(read, sent) {
	const text = JSON.stringify([read.local, read.currentLocal, read.log, sent]);
	const found = ADDRESSES.filter((address) => text.includes(address));
	for (const [, address, type] of text.matchAll(
		/candidate:\S+ \d \w+ \d+ (\S+) \d+ typ (\w+)/g,
	))
		if (type === 'host' && !address.endsWith('.local'))
			found.push(`host ${address}`);
	return found;
}

// --- pages ---

async function page(browser, label, base) {
	let opened;
	let frame;
	if (base) {
		opened = await openDemo(browser, base);
		await submitLanding(opened, target);
		frame = () =>
			opened.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	} else {
		opened = await (await browser.newContext()).newPage();
		opened.errors = [];
		opened.on('pageerror', (error) => opened.errors.push(error.message));
		await opened.goto(target);
		frame = () => opened.mainFrame();
	}
	for (let i = 0; i < 160; i++) {
		if (
			await frame()
				?.evaluate(() => window.__peerReady)
				.catch(() => false)
		)
			break;
		await sleep(250);
	}
	return { label, page: opened, frame };
}

// a description's lines as they compare between two stacks: what differs
// from one connection to the next written X, candidates left out
const shape = (sdp) =>
	stripped(sdp)
		.split('\r\n')
		.filter(Boolean)
		.map((line) =>
			line
				.replace(/^(o=- )\d+ \d+ IN IP4 \S+/, '$1X X IN IP4 X')
				.replace(/^(m=application )\d+/, '$1X')
				.replace(/^(c=IN IP4 )\S+/, '$1X')
				.replace(/^(a=ice-ufrag:|a=ice-pwd:|a=fingerprint:sha-256 ).*/, '$1X'),
		);

const CHANNELS = [
	['chat', {}],
	['lossy', { ordered: false, maxRetransmits: 0 }],
	['timed', { maxPacketLifeTime: 500, protocol: 'timing' }],
	['fixed', { negotiated: true, id: 7 }],
];

const browser = await launch();
// the far end's browser: its pages have media access, so its own stack shows
// its host candidates' addresses
const far = await launch(['--use-fake-ui-for-media-stream']);
const native = await page(far, 'natively', null);
const proxiedFar = await page(far, 'the other browser, same-origin', PROXY);
const pages = [
	await page(browser, 'same-origin', PROXY),
	await page(browser, 'isolated', HOST),
];

// the measurement can tell a browser's socket: the browser's own stack
// reaches the peer in this process from one. Its host candidates are
// addresses a wisp server can send to when its origin has media access;
// where they are names all the same, it cannot be a far end here
let reachable = false;
{
	const peer = nodeEnd('peer', {
		iceAdditionalHostAddresses: undefined,
		iceInterfaceAddresses: undefined,
	});
	const own = pageEnd('natively', native.frame);
	await own.call('open');
	await peer.call('open');
	await own.call('channels', [['chat', {}]]);
	let seen;
	try {
		const { offer } = await negotiate(own, peer);
		reachable =
			/^a=candidate:\S+ \d udp \d+ (?!\S+\.local )\S+ \d+ typ host/m.test(
				offer,
			);
		await own.call('opened', 'chat', 20000);
		seen = await seenAs(peer);
	} catch (error) {
		seen = { owner: String(error).slice(0, 200) };
	}
	if (seen.owner === 'browser')
		ok(
			"natively: the peer sees the page at one of the browser's own sockets",
			true,
			JSON.stringify(seen),
		);
	else
		console.log(
			`note: natively: the peer does not see the browser's own socket on this machine - ${JSON.stringify(seen)}`,
		);
	await own.call('close');
	await peer.call('close');
}

// what Chrome writes for the same channels, to read the proxied pages'
// descriptions against
const nativeOffer = await (async () => {
	const end = pageEnd('natively', native.frame);
	await end.call('open');
	await end.call('channels', CHANNELS);
	const sdp = await end.call('draft');
	await end.call('close');
	return sdp;
})();
let nativeAnswer = null;

for (const proxied of pages) {
	const { label } = proxied;

	// --- the page offers to the peer in this process ---
	{
		const own = pageEnd(label, proxied.frame);
		const peer = nodeEnd('peer');
		await own.call('open');
		await peer.call('open');
		await own.call('channels', CHANNELS);
		await peer.call('channels', [['fixed', { negotiated: true, id: 7 }]]);
		const draft = await own.call('draft');
		ok(
			`${label}: the offer for four channels reads as Chrome's does`,
			JSON.stringify(shape(draft)) === JSON.stringify(shape(nativeOffer)),
			JSON.stringify([shape(draft), shape(nativeOffer)]),
		);
		let failure = null;
		const started = Date.now();
		let signalled = { sent: {} };
		try {
			signalled = await negotiate(own, peer);
			for (const [name] of CHANNELS) await own.call('opened', name);
		} catch (error) {
			failure = String(error).slice(0, 300);
		}
		const read = await own.call('read');
		ok(
			`${label}: a connection the page offers to a peer opens its channels`,
			!failure && read.connection === 'connected',
			failure ?? `${Date.now() - started} ms, ${read.log.join(' ')}`,
		);
		if (!failure) {
			const seen = await seenAs(peer);
			ok(
				`${label}: the peer sees the page at a socket of the wisp server`,
				seen.owner === 'server',
				JSON.stringify(seen),
			);
			const leaks = ownAddresses(read, signalled.offer);
			ok(
				`${label}: the page's own description and candidates hold no address of this machine`,
				leaks.length === 0 && /typ host/.test(signalled.offer),
				JSON.stringify(leaks),
			);
			const options = [];
			for (const [name] of CHANNELS.slice(0, 3))
				options.push(await peer.call('opened', name));
			ok(
				`${label}: the peer gets each channel as the page declared it`,
				options[0].ordered === true &&
					options[0].maxRetransmits === null &&
					options[1].ordered === false &&
					options[1].maxRetransmits === 0 &&
					options[2].maxPacketLifeTime === 500 &&
					options[2].protocol === 'timing' &&
					(await own.call('opened', 'fixed')).id === 7,
				JSON.stringify(options),
			);

			// text and bytes, every way a page sends them, up to the 64 KiB a
			// peer that says nothing more is sent
			// (a Blob is read before it is sent, natively too: last, so that
			// nothing sent after it overtakes it)
			const up = [
				{ text: 'hello' },
				{ text: 'h\xe9llo \u{1f600}' },
				{ bytes: 1, as: 'ArrayBuffer' },
				{ bytes: 1200, seed: 3, as: 'view' },
				{ bytes: 65536, seed: 9, as: 'ArrayBuffer' },
				{ bytes: 20000, seed: 5, as: 'Blob' },
			];
			const sentUp = await carried(own, peer, 'chat', up);
			const over = await own.call('send', 'chat', { bytes: 65537 });
			const gotUp = await peer.call('received', 'chat', wanted(up).length);
			ok(
				`${label}: the peer reads what the page sends: text, an ArrayBuffer, a view, a Blob, 64 KiB, and no more than the peer said it takes`,
				sentUp.refused.length === 0 &&
					same(gotUp, wanted(up)) &&
					/^TypeError: .*max-message-size/.test(over),
				JSON.stringify([sentUp.refused, brief(gotUp), over]),
			);
			const down = [
				{ text: 'welcome' },
				{ bytes: 5, seed: 1, reads: 'ArrayBuffer' },
				{ bytes: 65536, seed: 2, reads: 'ArrayBuffer' },
			];
			await carried(peer, own, 'chat', down);
			const gotDown = await own.call('received', 'chat', down.length);
			await own.call('binaryType', 'chat', 'blob');
			await carried(peer, own, 'chat', [{ bytes: 3000, seed: 4 }]);
			const asBlob = (await own.call('received', 'chat', down.length + 1))[
				down.length
			];
			ok(
				`${label}: the page reads what the peer sends, bytes as its binaryType says`,
				same(gotDown, wanted(down)) &&
					same([asBlob], [{ ...bytesOf(3000, 4), kind: 'Blob' }]),
				JSON.stringify([brief(gotDown), asBlob]),
			);
			for (const name of ['lossy', 'timed', 'fixed']) {
				await carried(own, peer, name, [{ text: `on ${name}` }]);
				await carried(peer, own, name, [{ text: `back on ${name}` }]);
			}
			const others = [];
			for (const name of ['lossy', 'timed', 'fixed'])
				others.push(
					(await peer.call('received', name, 1))[0]?.text,
					(await own.call('received', name, 1))[0]?.text,
				);
			ok(
				`${label}: an unordered channel, a timed one and a negotiated one carry messages both ways`,
				JSON.stringify(others) ===
					JSON.stringify(
						['lossy', 'timed', 'fixed'].flatMap((name) => [
							`on ${name}`,
							`back on ${name}`,
						]),
					),
				JSON.stringify(others),
			);

			// empty messages: one zero byte under the "empty" identifiers on
			// the wire (RFC 8831 6.6), an empty string or buffer to whoever
			// reads them, and nothing in bufferedAmount
			const emptyUp = [
				await emptiesCarried(own, peer, 'timed', 1),
				await emptiesCarried(own, peer, 'lossy', 1, false),
			];
			// (not from this peer: werift sends an empty message as a DATA
			// chunk without user data, which SCTP forbids and the stack
			// drops; Chrome is the far end for that direction)
			ok(
				`${label}: an empty string and an empty binary message reach the peer on an ordered and an unordered channel, in order, and count as nothing buffered`,
				emptyUp[0].read === EMPTIES.ordered &&
					emptyUp[1].read === EMPTIES.unordered &&
					emptyUp.every(({ buffered }) => buffered.join() === QUIET),
				JSON.stringify(emptyUp),
			);

			// the amount buffered: what the page sent and the stack has not
			// yet handed to the transport, back to nothing, with the event
			const burst = await own.call('burst', 'chat', 40, 16384, 65536);
			const sent = wanted(up).length;
			const flood = await peer.call('received', 'chat', sent + 40);
			ok(
				`${label}: bufferedAmount counts a burst as it is sent, drains to nothing and tells when it is low`,
				burst.first === 0 &&
					burst.afterOne === 16384 &&
					burst.most === 40 * 16384 &&
					burst.low &&
					burst.atLow <= 65536 &&
					burst.end === 0 &&
					flood.length === sent + 40 &&
					flood.slice(sent).every((message) => message.size === 16384),
				JSON.stringify([burst, flood.length]),
			);

			// a channel closed from either end: the end that closes it sees it
			// closed, the other sees it closing first, as natively
			await own.call('closeChannel', 'lossy');
			const closedHere = await own.call('channelState', 'lossy', 'closed');
			const closedThere = await peer.call('channelState', 'lossy', 'closed');
			await peer.call('closeChannel', 'timed');
			const farClosed = await own.call('channelState', 'timed', 'closed');
			await carried(own, peer, 'chat', [{ text: 'still here' }]);
			const after = await peer.call('received', 'chat', sent + 41);
			ok(
				`${label}: a channel either end closes closes at both, and the others go on`,
				closedHere.state === 'closed' &&
					lifeOf(closedHere) === 'open,close' &&
					closedThere.state === 'closed' &&
					farClosed.state === 'closed' &&
					lifeOf(farClosed) === 'open,closing,close' &&
					after.at(-1)?.text === 'still here',
				JSON.stringify([
					closedHere,
					closedThere.state,
					farClosed,
					after.at(-1),
				]),
			);
		}
		await own.call('close');
		await peer.call('close');
	}

	// --- the peer offers; candidates travel one by one ---
	{
		const own = pageEnd(label, proxied.frame);
		const peer = nodeEnd('peer');
		await own.call('open');
		await peer.call('open');
		await peer.call('channels', [['inbound', { protocol: 'p1' }]]);
		let failure = null;
		let signalled = { sent: { answerer: [] } };
		let options = null;
		try {
			signalled = await negotiate(peer, own, { trickle: true });
			options = await own.call('opened', 'inbound');
		} catch (error) {
			failure = String(error).slice(0, 300);
		}
		const read = await own.call('read');
		ok(
			`${label}: a connection a peer offers, its candidates trickled, opens the peer's channel in the page`,
			!failure &&
				options.label === 'inbound' &&
				options.protocol === 'p1' &&
				read.connection === 'connected',
			failure ?? JSON.stringify([options, read.log.join(' ')]),
		);
		if (!failure) {
			await carried(own, peer, 'inbound', [{ text: 'from the page' }]);
			await carried(peer, own, 'inbound', [{ text: 'from the peer' }]);
			const seen = await seenAs(peer);
			const leaks = ownAddresses(read, signalled.sent.answerer);
			ok(
				`${label}: it carries messages both ways from the wisp server's socket, and the page's trickled candidates are names`,
				(await peer.call('received', 'inbound', 1))[0]?.text ===
					'from the page' &&
					(await own.call('received', 'inbound', 1))[0]?.text ===
						'from the peer' &&
					seen.owner === 'server' &&
					leaks.length === 0 &&
					signalled.sent.answerer.length > 0,
				JSON.stringify([seen, leaks, signalled.sent.answerer]),
			);
			// the page closes its connection: the peer's channel closes
			await own.call('close');
			const gone = await peer.call('channelState', 'inbound', 'closed', 20000);
			ok(
				`${label}: closing the page's connection closes the peer's channel`,
				gone.state === 'closed',
				JSON.stringify(gone),
			);
		} else await own.call('close');
		await peer.call('close');
	}

	// --- relay only: every packet through the TURN server ---
	{
		const own = pageEnd(label, proxied.frame);
		const peer = nodeEnd('peer');
		const heard = turn.packets.length;
		const relayed = turn.relayed;
		await own.call('open', {
			iceServers: turnServers,
			iceTransportPolicy: 'relay',
		});
		await peer.call('open');
		await own.call('channels', [['relayed', {}]]);
		let failure = null;
		let signalled = { offer: '' };
		try {
			signalled = await negotiate(own, peer);
			await own.call('opened', 'relayed');
			await carried(own, peer, 'relayed', [{ bytes: 30000, seed: 6 }]);
			await carried(peer, own, 'relayed', [{ text: 'through the relay' }]);
		} catch (error) {
			failure = String(error).slice(0, 300);
		}
		const types = [...signalled.offer.matchAll(/ typ (\w+)/g)].map(
			([, type]) => type,
		);
		const seen = failure ? { owner: 'not connected' } : await seenAs(peer);
		const packets = turn.packets.slice(heard);
		ok(
			`${label}: a relay-only connection gathers only a relay candidate and reaches the peer from the TURN server's relay socket`,
			!failure &&
				types.join() === 'relay' &&
				turn.relays.has(seen.pair?.port) &&
				same(await peer.call('received', 'relayed', 1), [bytesOf(30000, 6)]) &&
				(await own.call('received', 'relayed', 1))[0]?.text ===
					'through the relay',
			failure ?? JSON.stringify([types, seen]),
		);
		ok(
			`${label}: the TURN server hears only the wisp server, and relays the connection`,
			packets.length > 0 &&
				sockets.senders(packets).every((who) => who === 'server') &&
				turn.relayed > relayed,
			JSON.stringify([tally(sockets.senders(packets)), turn.relayed - relayed]),
		);
		await own.call('close');
		await peer.call('close');
	}

	// --- the browser's own stack as the far end ---
	if (reachable) {
		// the page offers; 256 KiB each way; an ICE restart
		const own = pageEnd(label, proxied.frame);
		const chrome = pageEnd('natively', native.frame);
		await own.call('open');
		await chrome.call('open');
		await own.call('channels', CHANNELS);
		await chrome.call('channels', [['fixed', { negotiated: true, id: 7 }]]);
		let failure = null;
		let signalled = { answer: '' };
		try {
			signalled = await negotiate(own, chrome);
			for (const [name] of CHANNELS) await own.call('opened', name);
			await chrome.call('opened', 'chat');
		} catch (error) {
			failure = String(error).slice(0, 300);
		}
		nativeAnswer ??= signalled.answer;
		const read = await own.call('read');
		ok(
			`${label}: a connection the page offers to Chrome's own stack opens its channels`,
			!failure && read.connection === 'connected',
			failure ?? read.log.join(' '),
		);
		if (!failure) {
			const seen = await seenAs(chrome);
			ok(
				`${label}: Chrome sees the page at a socket of the wisp server`,
				seen.owner === 'server',
				JSON.stringify(seen),
			);
			const up = [
				{ text: 'x'.repeat(100000) },
				{ bytes: 262144, seed: 11, as: 'ArrayBuffer' },
				{ bytes: 200000, seed: 12, as: 'Blob' },
			];
			const sentUp = await carried(own, chrome, 'chat', up);
			const tooLarge = await own.call('send', 'chat', { bytes: 262145 });
			const refused = await chrome.call('send', 'chat', { bytes: 262145 });
			const gotUp = await chrome.call('received', 'chat', up.length);
			const down = [
				{ bytes: 262144, seed: 13, as: 'ArrayBuffer' },
				{ text: 'y'.repeat(262144) },
			];
			await carried(chrome, own, 'chat', down);
			const gotDown = await own.call('received', 'chat', down.length);
			ok(
				`${label}: messages up to 256 KiB travel both ways, and a larger one is refused as Chrome refuses it`,
				sentUp.refused.length === 0 &&
					same(gotUp, wanted(up)) &&
					same(gotDown, wanted(down)) &&
					tooLarge === refused &&
					/^TypeError/.test(tooLarge),
				JSON.stringify([
					sentUp.refused,
					brief(gotUp),
					brief(gotDown),
					tooLarge,
					refused,
				]),
			);

			// empty messages both ways, as Chrome's own stack sends and
			// reads them
			const emptyThere = [
				await emptiesCarried(own, chrome, 'chat', up.length),
				await emptiesCarried(own, chrome, 'lossy', 0, false),
			];
			const emptyBack = [
				await emptiesCarried(chrome, own, 'chat', down.length),
				await emptiesCarried(chrome, own, 'lossy', 0, false),
			];
			ok(
				`${label}: empty messages travel both ways with Chrome on an ordered and an unordered channel, and the page's channel says of them what Chrome's does`,
				[emptyThere, emptyBack].every(
					(way) =>
						way[0].read === EMPTIES.ordered &&
						way[1].read === EMPTIES.unordered &&
						way.every(({ buffered }) => buffered.join() === QUIET),
				),
				JSON.stringify([emptyThere, emptyBack]),
			);
			const there = up.length + 3;
			const here = down.length + 3;

			// an ICE restart: new credentials, new candidates, the same
			// channels
			await own.call('restart');
			const before = /a=ice-ufrag:(\S+)/.exec(read.local)?.[1];
			let restarted;
			try {
				const again = await negotiate(own, chrome, { iceRestart: true });
				const now = /a=ice-ufrag:(\S+)/.exec(again.offer)?.[1];
				await carried(own, chrome, 'chat', [{ text: 'after the restart' }]);
				await carried(chrome, own, 'chat', [{ text: 'and back' }]);
				restarted = {
					fresh: !!now && now !== before,
					there: (await chrome.call('received', 'chat', there + 1)).at(-1),
					here: (await own.call('received', 'chat', here + 1)).at(-1),
					state: await own.call('state', 'connected', 20000),
					seen: await seenAs(chrome),
				};
			} catch (error) {
				restarted = { error: String(error).slice(0, 300) };
			}
			ok(
				`${label}: an ICE restart renegotiates with new credentials and the channels go on, still from the wisp server`,
				restarted.fresh &&
					restarted.there?.text === 'after the restart' &&
					restarted.here?.text === 'and back' &&
					restarted.state === 'connected' &&
					restarted.seen.owner === 'server',
				JSON.stringify(restarted),
			);
		}
		if (!failure) {
			// Chrome closes its connection: the page's channels close at once
			// and its connection reads disconnected a few seconds later
			await chrome.call('close');
			const gone = await own.call('channelState', 'chat', 'closed', 20000);
			const early = (await own.call('read')).connection;
			const later = await own.call('state', 'disconnected', 20000);
			ok(
				`${label}: when Chrome closes its connection the page's channels close, and its connection is disconnected a while later, as natively`,
				gone.state === 'closed' &&
					/^open,closing,(error,)?close$/.test(lifeOf(gone)) &&
					early === 'connected' &&
					later === 'disconnected',
				JSON.stringify([gone, early, later]),
			);
		} else await chrome.call('close');
		await own.call('close');

		// Chrome offers, candidates trickled; the page answers
		const answering = pageEnd(label, proxied.frame);
		const offering = pageEnd('natively', native.frame);
		await answering.call('open');
		await offering.call('open');
		await offering.call('channels', CHANNELS.slice(0, 2));
		failure = null;
		let answered = { answer: '', sent: { answerer: [] } };
		let options = [];
		try {
			answered = await negotiate(offering, answering, { trickle: true });
			options = [
				await answering.call('opened', 'chat'),
				await answering.call('opened', 'lossy'),
			];
			await carried(offering, answering, 'chat', [
				{ bytes: 262144, seed: 21, as: 'ArrayBuffer' },
			]);
			await carried(answering, offering, 'lossy', [
				{ bytes: 262144, seed: 22, as: 'ArrayBuffer' },
			]);
		} catch (error) {
			failure = String(error).slice(0, 300);
		}
		const answerRead = await answering.call('read');
		const seen = failure ? { owner: 'not connected' } : await seenAs(offering);
		ok(
			`${label}: a connection Chrome's own stack offers opens its channels in the page and carries 256 KiB both ways from the wisp server's socket`,
			!failure &&
				options[1].ordered === false &&
				options[1].maxRetransmits === 0 &&
				same(await answering.call('received', 'chat', 1), [
					bytesOf(262144, 21),
				]) &&
				same(await offering.call('received', 'lossy', 1), [
					bytesOf(262144, 22),
				]) &&
				seen.owner === 'server' &&
				ownAddresses(answerRead, answered.sent.answerer).length === 0,
			failure ??
				JSON.stringify([
					options,
					seen,
					ownAddresses(answerRead, answered.sent.answerer),
				]),
		);
		if (!failure && nativeAnswer)
			ok(
				`${label}: the page's answer reads as Chrome's does`,
				JSON.stringify(shape(answered.answer)) ===
					JSON.stringify(shape(nativeAnswer)),
				JSON.stringify([shape(answered.answer), shape(nativeAnswer)]),
			);
		await answering.call('close');
		if (!failure) {
			const gone = await offering.call('channelState', 'chat', 'closed', 20000);
			ok(
				`${label}: closing the page's connection closes Chrome's channel`,
				gone.state === 'closed',
				JSON.stringify(gone),
			);
		}
		await offering.call('close');
	} else
		console.log(
			`note: ${label}: the far browser's own stack shows no host address, so it is not a far end here`,
		);

	// --- another proxied page, in the other browser, through the relay ---
	{
		const own = pageEnd(label, proxied.frame);
		const other = pageEnd(proxiedFar.label, proxiedFar.frame);
		const heard = turn.packets.length;
		const relayed = turn.relayed;
		await own.call('open', { iceServers: turnServers });
		await other.call('open', { iceServers: turnServers });
		await own.call('channels', [['between', {}]]);
		let failure = null;
		try {
			await negotiate(own, other, { trickle: true });
			await own.call('opened', 'between');
			await other.call('opened', 'between');
			await carried(own, other, 'between', [
				{ bytes: 262144, seed: 31, as: 'ArrayBuffer' },
			]);
			await carried(other, own, 'between', [{ text: 'across browsers' }]);
		} catch (error) {
			failure = String(error).slice(0, 300);
		}
		const packets = turn.packets.slice(heard);
		ok(
			`${label}: two proxied pages in different browsers connect through a TURN server, which hears only the wisp server`,
			!failure &&
				same(await other.call('received', 'between', 1), [
					bytesOf(262144, 31),
				]) &&
				(await own.call('received', 'between', 1))[0]?.text ===
					'across browsers' &&
				turn.relayed > relayed &&
				sockets.senders(packets).every((who) => who === 'server'),
			failure ??
				JSON.stringify([
					turn.relayed - relayed,
					tally(sockets.senders(packets)),
				]),
		);
		await own.call('close');
		await other.call('close');
	}
}

const errors = [...pages, proxiedFar].flatMap((entry) => entry.page.errors);
await sockets.stop();
turn.close();
await far.close();
await done(browser, errors);
