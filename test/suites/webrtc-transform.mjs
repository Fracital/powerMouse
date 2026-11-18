// What a proxied page's encoded transforms (RTCRtpScriptTransform) are
// given, next to the browser's own: test/pages/webrtc-transform.html sends
// a tone and a canvas both ways, each sender and receiver through a
// transform whose worker writes down the first frames, to the same page
// loaded natively in a second context. The page is loaded natively (the
// control) and through the proxy, whose WebRTC goes over a wisp relay in
// front of the suite's (test/wisp-gate.mjs) that reads the RTP headers of
// what comes in, so a received frame's sequence number can be checked
// against the packet's.
import { spawn } from 'node:child_process';
import { createServer as createNet } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
	done,
	FIXTURE,
	launch,
	NO_AUDIO,
	ok,
	openDemo,
	PORT,
	sleep,
	submitLanding,
	waitForServer,
} from '../lib.mjs';
import { startWispGate } from '../wisp-gate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const target = `${FIXTURE}pages/webrtc-transform.html`;

// the packets the relay saw come in: "ssrc rtp seq"
const wire = new Set();
const gate = await startWispGate(`ws://127.0.0.1:${PORT}/wisp/`);
gate.tap = (bytes) => {
	// RTP (version 2, not RTCP's payload types), as SRTP leaves its header
	if (bytes.length < 12 || (bytes[0] & 0xc0) !== 0x80) return;
	const pt = bytes[1] & 0x7f;
	if (pt >= 64 && pt <= 95) return;
	wire.add(
		`${bytes.readUInt32BE(8)} ${bytes.readUInt32BE(4)} ${bytes.readUInt16BE(2)}`,
	);
};
const freePort = () =>
	new Promise((resolve, reject) => {
		const probe = createNet();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
const port = await freePort();
const server = spawn(process.execPath, [`${root}demo/server.js`], {
	env: { ...process.env, PORT: String(port), STOMP_WISP_URL: gate.url },
	stdio: ['ignore', 'ignore', 'inherit'],
});
process.on('exit', () => server.kill());
const BASE = `http://localhost:${port}/`;
await waitForServer(`${BASE}api/status`);

// the fake capture device (no real one is opened): a page allowed it gets
// the browser's host candidates
const FAKE = [
	'--use-fake-device-for-media-stream',
	'--use-fake-ui-for-media-stream',
	'--autoplay-policy=no-user-gesture-required',
];
const browser = await launch(FAKE, { env: NO_AUDIO });

let names = 0;
function end(page) {
	const name = `t${names++}`;
	return {
		label: page.label,
		call: (step, ...args) =>
			page
				.frame()
				.evaluate(
					([step, name, args]) => window.__transform[step](name, ...args),
					[step, name, args],
				)
				.catch((error) => {
					throw new Error(
						`${page.label}, ${step}: ${String(error.message).split('\n')[0]}`,
					);
				}),
	};
}
async function open(label, proxied) {
	let opened;
	let frame;
	if (proxied) {
		opened = await openDemo(browser, BASE);
		await submitLanding(opened, target);
		frame = () =>
			opened.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		// the page's microphone is asked of the user through the host (the
		// demo's prompt): allowed, as a user does
		void (async () => {
			while (!opened.isClosed()) {
				const button = await opened
					.waitForSelector('#permissionPrompt .allow', { timeout: 0 })
					.catch(() => null);
				await button?.click().catch(() => {});
				await sleep(200);
			}
		})();
	} else {
		opened = await (await browser.newContext()).newPage();
		await opened.goto(target);
		frame = () => opened.mainFrame();
	}
	for (let i = 0; i < 160; i++) {
		if (
			await frame()
				?.evaluate(() => window.__transformReady)
				.catch(() => false)
		)
			break;
		await sleep(250);
	}
	return { label, page: opened, frame };
}

/** a call of the page (`proxied` or natively) with the native far end: what both ends' transforms saw */
async function call(proxied, kind, codec) {
	const near = await open(proxied ? 'proxied' : 'natively', proxied);
	const far = await open('far end', false);
	const own = end(near);
	const other = end(far);
	try {
		await own.call('open', {});
		await other.call('open', {});
		await own.call('media', kind, { codec });
		await other.call('media', kind, { codec });
		await other.call('remote', 'offer', await own.call('local', 'offer'));
		await own.call('remote', 'answer', await other.call('local', 'answer'));
		await own.call('connected');
		await other.call('connected');
		const mine = await own.call('seen', 60);
		const theirs = await other.call('seen', 60);
		return { mine, theirs };
	} catch (error) {
		return { failure: error.message };
	} finally {
		await own.call('close').catch(() => {});
		await other.call('close').catch(() => {});
		await near.page.close().catch(() => {});
		await far.page.close().catch(() => {});
	}
}

const brief = (list) =>
	JSON.stringify(
		(list ?? [])
			.slice(0, 4)
			.map((f) => [f.type, f.id, f.deps, f.width, f.height, f.seq, f.keys]),
	);

/**
 * What a sender's frames read as in Chrome: the first a keyframe with id 1
 * depending on none, each id one more than the last, a delta frame
 * depending on the frame before (a later keyframe on none, or on the frame
 * before where the encoder makes it as part of the sequence: Chrome's
 * H.264 every so often), every frame of the size encoded
 */
const sentShape = (list, width, height) => {
	if (!list?.length) return 'no frames';
	const off = [];
	if (list[0].type !== 'key' || list[0].id !== 1 || list[0].deps?.length !== 0)
		off.push(`first ${JSON.stringify(list[0])}`);
	for (let i = 1; i < list.length; i++) {
		const f = list[i];
		const deps = JSON.stringify(f.deps);
		if (
			f.id !== list[i - 1].id + 1 ||
			(deps !== JSON.stringify([f.id - 1]) &&
				(f.type !== 'key' || deps !== '[]'))
		)
			off.push(`frame ${i} ${f.type} id ${f.id} deps ${f.deps}`);
		if (f.width !== width || f.height !== height)
			off.push(`frame ${i} ${f.width}x${f.height}`);
		if (off.length > 3) break;
	}
	return off.join('; ');
};
/** a receiver's: each keyframe of the size `key` (Chrome's for the codec), the rest 0 by 0 */
const receivedShape = (list, key) => {
	if (!list?.length) return 'no frames';
	if (!list.some((f) => f.type === 'key')) return 'no keyframe';
	const off = [];
	for (const [i, f] of list.entries()) {
		const want = f.type === 'key' ? key : [0, 0];
		if (f.width !== want[0] || f.height !== want[1])
			off.push(`frame ${i} ${f.type} ${f.width}x${f.height}`);
		if (off.length > 3) break;
	}
	return off.join('; ');
};

// ---- audio: a received frame's sequence number is its packet's ----------
{
	const want = await call(false, 'audio');
	const got = await call(true, 'audio');
	const consecutive = (list) =>
		list?.length > 1 &&
		list.every((f, i) => !i || f.seq === ((list[i - 1].seq + 1) & 0xffff));
	ok(
		'natively, audio: the receiver transform gets consecutive sequence numbers',
		!want.failure && consecutive(want.mine?.['recv audio']),
		want.failure ?? brief(want.mine?.['recv audio']),
	);
	const mine = got.mine?.['recv audio'];
	const missing = (mine ?? []).filter(
		(f) => !wire.has(`${f.ssrc} ${f.rtp} ${f.seq}`),
	);
	ok(
		'proxied, audio: a received frame has the sequence number of the packet it came in',
		!got.failure && mine?.length > 1 && missing.length === 0,
		got.failure ??
			`${missing.length} of ${mine?.length} not on the wire: ${brief(missing)} (${wire.size} packets seen)`,
	);
	ok(
		'proxied, audio: the received metadata has the keys Chrome gives',
		mine?.[0]?.keys === want.mine?.['recv audio']?.[0]?.keys,
		`${mine?.[0]?.keys} | natively ${want.mine?.['recv audio']?.[0]?.keys}`,
	);
}

// ---- video: sizes, ids and dependencies, per codec ---------------------------
for (const codec of ['video/VP8', 'video/VP9', 'video/H264', 'video/AV1']) {
	const want = await call(false, 'video', codec);
	const got = await call(true, 'video', codec);
	const name = codec.slice(6);
	// Chrome's for the codec, natively: a received keyframe's size
	const key = want.mine?.['recv video']?.find((f) => f.type === 'key');
	ok(
		`natively, ${name}: the transforms read as Chrome's always do`,
		!want.failure &&
			!sentShape(want.mine?.['send video'], 320, 180) &&
			key &&
			!receivedShape(want.mine?.['recv video'], [key.width, key.height]),
		want.failure ??
			`${sentShape(want.mine?.['send video'], 320, 180)} / ${brief(want.mine?.['recv video'])}`,
	);
	if (want.failure || !key) continue;
	const sent = got.mine?.['send video'];
	ok(
		`proxied, ${name}: a sent frame's type, id, dependencies and size read as natively`,
		!got.failure &&
			!sentShape(sent, 320, 180) &&
			sent[0].keys === want.mine['send video'][0].keys,
		got.failure ?? `${sentShape(sent, 320, 180)} ${brief(sent)}`,
	);
	const received = got.mine?.['recv video'];
	ok(
		`proxied, ${name}: a received keyframe has the size Chrome reads (${key.width}x${key.height}), the frames between none`,
		!got.failure &&
			!receivedShape(received, [key.width, key.height]) &&
			received[0].keys === want.mine['recv video'][0].keys,
		got.failure ??
			`${receivedShape(received, [key.width, key.height])} ${brief(received)}`,
	);
	// what the far end reads of the proxied page's keyframes, as of the
	// native page's (what the packets say of their size)
	const farKey = got.theirs?.['recv video']?.find((f) => f.type === 'key');
	const farWant = want.theirs?.['recv video']?.find((f) => f.type === 'key');
	ok(
		`proxied, ${name}: the far end reads the page's keyframes at the size it reads the browser's (${farWant?.width}x${farWant?.height})`,
		farKey &&
			farKey.width === farWant?.width &&
			farKey.height === farWant?.height,
		JSON.stringify(farKey ?? null),
	);
}

// ---- frames copied, cloned and posted on, as Chrome's are ---------------------
/** a call whose page's transforms copy, clone and post their sixth frame (COPIES): what each context made of it */
async function copiesCall(proxied, kind, codec) {
	const near = await open(proxied ? 'proxied' : 'natively', proxied);
	const far = await open('far end', false);
	const own = end(near);
	const other = end(far);
	try {
		await own.call('open', {});
		await other.call('open', {});
		await own.call('copies', kind, codec);
		await other.call('media', kind, { codec });
		await other.call('remote', 'offer', await own.call('local', 'offer'));
		await own.call('remote', 'answer', await other.call('local', 'answer'));
		await own.call('connected');
		return await own.call('copied');
	} catch (error) {
		return { failure: error.message };
	} finally {
		await own.call('close').catch(() => {});
		await other.call('close').catch(() => {});
		await near.page.close().catch(() => {});
		await far.page.close().catch(() => {});
	}
}
/** the entries of `got` that are not `want`'s */
const unlike = (got, want) =>
	Object.keys({ ...want, ...got })
		.filter((key) => JSON.stringify(got?.[key]) !== JSON.stringify(want?.[key]))
		.map(
			(key) =>
				`${key}: ${JSON.stringify(got?.[key])} (natively ${JSON.stringify(want?.[key])})`,
		);
for (const [kind, codec] of [
	['audio', null],
	['video', 'video/VP8'],
]) {
	const want = await copiesCall(false, kind, codec);
	const got = await copiesCall(true, kind, codec);
	ok(
		`natively, ${kind}: each context made something of the frames`,
		!want.failure &&
			Object.keys(want.worker ?? {}).length === 2 &&
			Object.keys(want.page ?? {}).length === 2 &&
			Object.keys(want.other ?? {}).length === 2,
		want.failure ?? JSON.stringify(want),
	);
	if (want.failure) continue;
	for (const op of [`send ${kind}`, `recv ${kind}`]) {
		const off = unlike(got.worker?.[op], want.worker[op]);
		ok(
			`proxied, ${op}: a frame's copies, its changed copies and its clones read as Chrome's`,
			!got.failure && got.worker?.[op] && !off.length,
			got.failure ?? off.join('; '),
		);
		ok(
			`proxied, ${op}: a frame posted to the page and through a port to another worker arrives as Chrome's`,
			!got.failure &&
				got.page?.[op] === want.page[op] &&
				got.other?.[op] === want.other[op],
			got.failure ??
				`page ${got.page?.[op]} (natively ${want.page[op]}); other ${got.other?.[op]} (natively ${want.other[op]})`,
		);
	}
}

// ---- createEncodedStreams() ----------------------------------------------------
{
	const rules = async (proxied) => {
		const page = await open(proxied ? 'proxied' : 'natively', proxied);
		try {
			return await end(page).call('streamRules');
		} catch (error) {
			return { failure: error.message };
		} finally {
			await page.page.close().catch(() => {});
		}
	};
	const want = await rules(false);
	const got = await rules(true);
	const off = unlike(got, want);
	ok(
		'proxied: createEncodedStreams() answers, refuses and reads its configuration as Chrome does',
		!want.failure && !got.failure && !off.length,
		got.failure ?? want.failure ?? off.join('; '),
	);
}

/**
 * A call whose sound goes through both ends' createEncodedStreams() (each
 * frame scrambled and marked on the way out, checked and unscrambled on the
 * way in, the receiver's streams transferred to a worker): `transform`, the
 * page's sender is also given a transform for a while
 */
async function streamsCall(proxied, { transform = false, flag = false } = {}) {
	const near = await open(proxied ? 'proxied' : 'natively', proxied);
	const far = await open('far end', false);
	const own = end(near);
	const other = end(far);
	try {
		await own.call('open', flag ? { encodedInsertableStreams: true } : {});
		await other.call('open', {});
		await own.call('streamsCall', { transform });
		await other.call('streamsCall', {});
		await other.call('remote', 'offer', await own.call('local', 'offer'));
		await own.call('remote', 'answer', await other.call('local', 'answer'));
		await own.call('connected');
		await other.call('connected');
		const first = {
			mine: await own.call('streamsSeen', 4000),
			theirs: await other.call('streamsSeen', 0),
		};
		if (!transform) return first;
		await own.call('untransform');
		await own.call('streamsSeen', 1000);
		const before = await other.call('streamsSeen', 0);
		const later = {
			mine: await own.call('streamsSeen', 3000),
			theirs: await other.call('streamsSeen', 0),
		};
		return { first, before, later };
	} catch (error) {
		return { failure: error.message };
	} finally {
		await own.call('close').catch(() => {});
		await other.call('close').catch(() => {});
		await near.page.close().catch(() => {});
		await far.page.close().catch(() => {});
	}
}
{
	const want = await streamsCall(false);
	const got = await streamsCall(true);
	const flows = (seen) =>
		seen?.mine?.sent?.frames > 20 &&
		seen.mine.received?.frames > 20 &&
		seen.mine.received.dropped === 0 &&
		seen.theirs?.received?.frames > 20 &&
		seen.theirs.received.dropped === 0;
	ok(
		'natively: the sound goes both ways through the encoded streams, transferred to a worker',
		!want.failure && flows(want),
		want.failure ?? JSON.stringify(want),
	);
	ok(
		"proxied: the page's sound goes both ways through its encoded streams, the receiver's transferred to a worker, none dropped",
		!got.failure &&
			flows(got) &&
			got.mine.transferred === want.mine?.transferred &&
			got.mine.sent.audio === got.mine.sent.frames &&
			got.mine.received.audio === got.mine.received.frames,
		got.failure ?? JSON.stringify(got),
	);
	ok(
		'proxied: the frames of the encoded streams have the metadata Chrome gives',
		got.mine?.sent?.keys === want.mine?.sent?.keys &&
			got.mine?.received?.keys === want.mine?.received?.keys,
		`${got.mine?.sent?.keys} / ${got.mine?.received?.keys} (natively ${want.mine?.sent?.keys} / ${want.mine?.received?.keys})`,
	);
}
// a transform has the frames while it is given; taken away, the streams
// have them again with encodedInsertableStreams, and nothing does without
for (const flag of [false, true]) {
	const want = await streamsCall(false, { transform: true, flag });
	const got = await streamsCall(true, { transform: true, flag });
	const shape = (seen) =>
		seen?.first
			? [
					seen.first.mine.byTransform > 20,
					seen.first.mine.sent.frames === 0,
					seen.first.theirs.received?.dropped > 0,
					seen.later.mine.byTransform === seen.first.mine.byTransform ||
						seen.later.mine.byTransform < seen.first.mine.byTransform + 60,
					seen.later.mine.sent.frames > 20,
					seen.later.theirs.received?.frames >
						(seen.before.received?.frames ?? 0) + 20,
					seen.later.theirs.received?.dropped === seen.before.received?.dropped,
				].join()
			: null;
	const config = flag ? ' with encodedInsertableStreams' : '';
	ok(
		`natively${config}: a transform given a sender with encoded streams has its frames until it is taken away`,
		!want.failure && /^true,true,true,true,/.test(shape(want) ?? ''),
		want.failure ?? `${shape(want)} ${JSON.stringify(want)}`,
	);
	ok(
		`proxied${config}: a transform given a sender with encoded streams has its frames until it is taken away, and then where Chrome sends them`,
		!got.failure && shape(got) === shape(want),
		got.failure ??
			`${shape(got)} (natively ${shape(want)}) ${JSON.stringify(got)}`,
	);
}
{
	// encodedInsertableStreams, the streams never made: nothing is sent
	const silent = async (proxied) => {
		const near = await open(proxied ? 'proxied' : 'natively', proxied);
		const far = await open('far end', false);
		const own = end(near);
		const other = end(far);
		try {
			await own.call('open', { encodedInsertableStreams: true });
			await other.call('open', {});
			await own.call('plain', 'audio');
			await other.call('media', 'audio', {});
			await other.call('remote', 'offer', await own.call('local', 'offer'));
			await own.call('remote', 'answer', await other.call('local', 'answer'));
			await own.call('connected');
			await other.call('connected');
			await sleep(3000);
			const seen = await other.call('seen', 0, 0);
			return { frames: seen?.['recv audio']?.length ?? 0 };
		} catch (error) {
			return { failure: error.message };
		} finally {
			await own.call('close').catch(() => {});
			await other.call('close').catch(() => {});
			await near.page.close().catch(() => {});
			await far.page.close().catch(() => {});
		}
	};
	const want = await silent(false);
	const got = await silent(true);
	ok(
		'proxied: with encodedInsertableStreams a sender whose streams the page never made sends nothing, as natively',
		!want.failure && !got.failure && got.frames === want.frames,
		got.failure ??
			want.failure ??
			`${got.frames} frames (natively ${want.frames})`,
	);
}

// ---- frames posted to windows and on a BroadcastChannel ------------------------------
{
	const child = `${FIXTURE}pages/webrtc-transform-child.html`;
	// another site: the fixture by another name
	const across = child.replace('//127.0.0.1:', '//localhost:');
	const postsCall = async (proxied) => {
		const near = await open(proxied ? 'proxied' : 'natively', proxied);
		const far = await open('far end', false);
		const own = end(near);
		const other = end(far);
		try {
			await own.call('open', {});
			await other.call('open', {});
			await own.call('posts', [child, across]);
			await other.call('media', 'audio', {});
			await other.call('remote', 'offer', await own.call('local', 'offer'));
			await own.call('remote', 'answer', await other.call('local', 'answer'));
			await own.call('connected');
			return await own.call('posted');
		} catch (error) {
			return { failure: error.message };
		} finally {
			await own.call('close').catch(() => {});
			await other.call('close').catch(() => {});
			await near.page.close().catch(() => {});
			await far.page.close().catch(() => {});
		}
	};
	const want = await postsCall(false);
	const got = await postsCall(true);
	ok(
		'natively: a frame posted to the page itself and to a frame of its origin arrives, to one of another site is a messageerror, on a BroadcastChannel is null',
		!want.failure &&
			want.self?.startsWith('[object RTCEncodedAudioFrame]') &&
			want.children?.[0]?.some((heard) =>
				heard.startsWith('message [object'),
			) &&
			want.children?.[1]?.some((heard) => heard.startsWith('messageerror')),
		want.failure ?? JSON.stringify(want),
	);
	const off = unlike(got, want);
	ok(
		"proxied: a frame posted with a window's postMessage (the page itself, a frame of its origin, one of another site) and on a BroadcastChannel arrives, fails and refuses as natively",
		!got.failure && !off.length,
		got.failure ?? off.join('; '),
	);
}

// ---- the empty frames of padding packets ------------------------------------------
/** an audio call of `seconds`: the empty frames each end's receiver transform was given */
async function paddingCall(proxied, seconds) {
	const near = await open(proxied ? 'proxied' : 'natively', proxied);
	const far = await open('far end', false);
	const own = end(near);
	const other = end(far);
	try {
		await own.call('open', {});
		await other.call('open', {});
		await own.call('media', 'audio', {});
		await other.call('media', 'audio', {});
		await other.call('remote', 'offer', await own.call('local', 'offer'));
		await own.call('remote', 'answer', await other.call('local', 'answer'));
		await own.call('connected');
		await other.call('connected');
		return {
			mine: (await own.call('empty', seconds * 1000))?.['recv audio'] ?? [],
			theirs: (await other.call('empty', 0))?.['recv audio'] ?? [],
		};
	} catch (error) {
		return { failure: error.message };
	} finally {
		await own.call('close').catch(() => {});
		await other.call('close').catch(() => {});
		await near.page.close().catch(() => {});
		await far.page.close().catch(() => {});
	}
}
{
	// Chrome's sender probes its bandwidth every 5 s or so with padding on the
	// sound's stream: each packet a frame of no bytes for the receiver's
	// transform, its sequence number its own, its RTP time the packet's
	// before, without an audio level
	const padded = (list) =>
		list.length > 0 &&
		list.every(
			(f) =>
				f.prevSeq !== null &&
				f.seq === ((f.prevSeq + 1) & 0xffff) &&
				f.rtp === f.prevRtp,
		);
	const want = await paddingCall(false, 12);
	const got = await paddingCall(true, 12);
	ok(
		"natively: a receiver's transform is given Chrome's padding as empty frames",
		!want.failure && padded(want.mine),
		want.failure ?? JSON.stringify(want.mine),
	);
	ok(
		"proxied: the page's receiver transform is given the far end's padding as empty frames, as natively",
		!got.failure &&
			padded(got.mine) &&
			got.mine[0].keys === want.mine?.[0]?.keys,
		got.failure ??
			`${JSON.stringify(got.mine)} (natively ${JSON.stringify(want.mine?.[0])})`,
	);
}

gate.close();
await done(browser);
