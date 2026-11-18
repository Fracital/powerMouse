// What a call through a proxied page sounds like, measured against the
// browser's own: two browsers, each playing the same test file on its fake
// capture device (test/audio-quality.mjs: a sine sweep, then speech-like
// sound with pauses), call each other with sound both ways. One end is
// test/pages/webrtc-audio.html loaded natively (the control) or through the
// proxy (STomp's stack over the demo's wisp server); the far end is the
// same page loaded natively in the second browser. Each end records what
// it sends and what it receives, and the suite lines the two up: how late
// the sound comes, how steadily, how much of it is missing, how changed,
// and at what speed. The proxied page must sound as the browser's own
// connection does. No real device is opened.
import { mkdirSync, writeFileSync } from 'node:fs';
import { compare, testSignal, wav } from '../audio-quality.mjs';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	NO_AUDIO,
	ok,
	openDemo,
	OUT,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const target = `${FIXTURE}pages/webrtc-audio.html`;
mkdirSync(OUT, { recursive: true });
const file = `${OUT}webrtc-audio-${process.pid}.wav`;
writeFileSync(file, wav(testSignal(48000), 48000));
const FAKE = [
	'--use-fake-device-for-media-stream',
	'--use-fake-ui-for-media-stream',
	`--use-file-for-fake-audio-capture=${file}`,
	'--autoplay-policy=no-user-gesture-required',
];
const VERBOSE = process.env.AUDIO_VERBOSE === '1';

let names = 0;
function end(page) {
	const name = `c${names++}`;
	return {
		label: page.label,
		call: (step, ...args) =>
			page
				.frame()
				.evaluate(
					([step, name, args]) => window.__audio[step](name, ...args),
					[step, name, args],
				)
				.catch((error) => {
					throw new Error(
						`${page.label}, ${step}: ${String(error.message).split('\n')[0]}`,
					);
				}),
	};
}
async function open(browser, label, base) {
	let opened;
	let frame;
	if (base) {
		opened = await openDemo(browser, base);
		await submitLanding(opened, target);
		frame = () =>
			opened.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
		// the page's microphone is asked of the user through the host (the
		// demo's prompt): allowed, as a user does
		const allow = async () => {
			while (!opened.isClosed()) {
				const button = await opened
					.waitForSelector('#permissionPrompt .allow', { timeout: 0 })
					.catch(() => null);
				await button?.click().catch(() => {});
				await sleep(200);
			}
		};
		void allow();
	} else {
		opened = await (await browser.newContext()).newPage();
		await opened.goto(target);
		frame = () => opened.mainFrame();
	}
	for (let i = 0; i < 160; i++) {
		if (
			await frame()
				?.evaluate(() => window.__audioReady)
				.catch(() => false)
		)
			break;
		await sleep(250);
	}
	return { label, page: opened, frame };
}

// processing off: what is measured is the call, not the browser's echo
// canceller and gain control, which act on the capture track both ways
const PLAIN = {
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
};

const fmtpOf = (sdp) =>
	(sdp.match(/a=fmtp:\d+ .*/g) ?? []).find((line) =>
		new RegExp(
			`a=fmtp:${(sdp.match(/a=rtpmap:(\d+) opus\/48000/i) ?? [])[1]} `,
		).test(line),
	) ?? null;
const pick = (report, keys) =>
	report && Object.fromEntries(keys.map((key) => [key, report[key]]));
const INBOUND = [
	'packetsReceived',
	'packetsLost',
	'jitter',
	'jitterBufferDelay',
	'jitterBufferTargetDelay',
	'jitterBufferEmittedCount',
	'totalSamplesReceived',
	'concealedSamples',
	'silentConcealedSamples',
	'insertedSamplesForDeceleration',
	'removedSamplesForAcceleration',
	'fecPacketsReceived',
	'nackCount',
];

/**
 * A call: `own` offers, the far end answers, each sends its fake
 * microphone (`own` as `mic` says), and both record. `munge` rewrites
 * the answer before `own` takes it (what a page does to the far end's
 * description). With `also`, `own` sends a second track (`mic` as
 * `also` says) and the far end's two are compared with each other.
 * Resolves with each direction compared.
 */
async function call(
	own,
	far,
	{
		mic = {},
		also = null,
		munge = null,
		play = 'track',
		scramble = false,
	} = {},
) {
	const record = { failure: null };
	try {
		await own.call('open');
		await far.call('open');
		record.ownMic = await own.call('mic', { constraints: PLAIN, ...mic });
		if (also)
			record.alsoMic = await own.call('mic', { constraints: PLAIN, ...also });
		record.farMic = await far.call('mic', { constraints: PLAIN, scramble });
		const offer = await own.call('local', 'offer');
		await far.call('remote', 'offer', offer);
		let answer = await far.call('local', 'answer');
		if (munge) answer = munge(answer);
		await own.call('remote', 'answer', answer);
		record.fmtp = { offer: fmtpOf(offer), answer: fmtpOf(answer) };
		await own.call('connected');
		await far.call('connected');
		await own.call('unmuted');
		await far.call('unmuted');
		// the call settles
		await sleep(1500);
		const [sentByOwn, heardByFar, sentByFar, heardByOwn, alsoByFar] =
			await Promise.all([
				own.call('record', 'sent', 11000),
				sleep(1000).then(() => far.call('record', 'track', 9000)),
				far.call('record', 'sent', 11000),
				sleep(1000).then(() => own.call('record', play, 9000)),
				also && sleep(1000).then(() => far.call('record', 'track', 9000, 0, 1)),
			]);
		// how much later the second track's sound comes than the first's
		if (also) record.apart = compare(heardByFar, alsoByFar);
		// (AUDIO_KEEP=1: the recordings themselves, in the run's file in test/out)
		if (process.env.AUDIO_KEEP === '1')
			record.raw = { sentByOwn, heardByFar, sentByFar, heardByOwn };
		record.sends = compare(sentByOwn, heardByFar);
		record.receives = compare(sentByFar, heardByOwn);
		record.receives.context = heardByOwn.context ?? null;
		const [ownStats, farStats] = await Promise.all([
			own.call('stats'),
			far.call('stats'),
		]);
		record.sends.stats = pick(farStats['inbound-rtp']?.[0], INBOUND);
		record.receives.stats = pick(ownStats['inbound-rtp']?.[0], INBOUND);
		record.sends.rtt =
			farStats['candidate-pair']?.[0]?.currentRoundTripTime ?? null;
		record.receives.codec = ownStats.codec?.map((c) => c.sdpFmtpLine);
		if (scramble)
			record.seen = {
				own: await own.call('seen'),
				far: await far.call('seen'),
			};
	} catch (error) {
		record.failure = String(error).slice(0, 400);
	}
	await own.call('close').catch(() => {});
	await far.call('close').catch(() => {});
	return record;
}

const brief = (side) =>
	side &&
	JSON.stringify({
		latency: side.latencyMs,
		latencyMedian: side.latencyMedianMs,
		match: side.match,
		snr: side.segSnrDb,
		snrLow: side.segSnrLowDb,
		lsd: side.lsdDb,
		dropMs: side.dropMs,
		jumps: side.jumps,
		wander: side.wanderMsPerS,
		drift: side.driftMsPerS,
		speed: side.sweepSpeed,
		pitch: side.pitchRatio,
		rate: side.gotRate,
		stats: side.stats,
	});

/** the answer's Opus parameters as Discord writes them (its own answer, from its server's) */
const discordFmtp = (sdp) => {
	const pt = (sdp.match(/a=rtpmap:(\d+) opus\/48000/i) ?? [])[1];
	return pt
		? sdp.replace(
				new RegExp(`a=fmtp:${pt} [^\r\n]*`),
				`a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1`,
			)
		: sdp;
};

const SCENARIOS = {
	// the fake microphone's own track
	plain: {},
	// through an AudioContext at 44.1 kHz (the rate of many output
	// devices), as a page that processes its microphone (gain, noise
	// suppression) sends it
	processed: { mic: { context: 44100 } },
	// what the receiving page plays through an AudioContext of its own
	played: { play: 'context' },
	// as a Discord call: both ends encrypt end to end in an encoded
	// transform (DAVE), and the answer asks for Discord's Opus parameters
	// (silence left out)
	discord: { mic: { scramble: true }, scramble: true, munge: discordFmtp },
	// silence left out without a transform
	dtx: { munge: discordFmtp },
	// the microphone sent twice, through an AudioContext at 48 kHz (Opus's
	// own rate) and through one at 44.1 kHz: the far end hears the second
	// as soon after the first as natively
	rates: { mic: { context: 48000 }, also: { context: 44100 } },
};
const only = process.env.AUDIO_SCENARIOS?.split(',');

const own = await launch(FAKE, { env: NO_AUDIO });
const farBrowser = await launch(FAKE, { env: NO_AUDIO });
const far = await open(farBrowser, 'far', null);
const natively = await open(own, 'natively', null);
const proxied = [
	await open(own, 'same-origin', PROXY),
	await open(own, 'isolated', HOST),
];
if (process.env.AUDIO_KEEP === '1')
	for (const page of [far, natively, ...proxied])
		await page.frame().evaluate(() => window.__audio.keep());
const results = {};
const run = async (page, name) => {
	const got = await Promise.race([
		call(end(page), end(far), SCENARIOS[name]),
		sleep(150000).then(() => ({ failure: 'timed out' })),
	]);
	(results[name] ??= {})[page.label] = got;
	console.log(
		`  ${page.label} ${name}: ${got.failure ?? ''}\n    fmtp ${JSON.stringify(got.fmtp)} mic ${JSON.stringify(got.ownMic)}\n    sends    ${brief(got.sends)}\n    receives ${brief(got.receives)}${got.apart ? `\n    apart    ${brief(got.apart)}` : ''}${got.seen ? `\n    seen ${JSON.stringify(got.seen, (key, value) => (key === 'times' ? undefined : value))}` : ''}`,
	);
	if (VERBOSE) console.log(JSON.stringify(got));
	return got;
};

/**
 * What a direction sounds like next to the browser's own: as much of the
 * sound arrives, as little changed, at the same speed, and not much later
 */
const sounds = (got, want) => {
	const off = [];
	if (!got) return ['no sound compared'];
	if (got.segSnrDb === null || got.segSnrDb < want.segSnrDb - 3)
		off.push(`segmental SNR ${got.segSnrDb} dB | natively ${want.segSnrDb}`);
	if (got.lsdDb === null || got.lsdDb > want.lsdDb + 3)
		off.push(`spectral distance ${got.lsdDb} dB | natively ${want.lsdDb}`);
	if (got.dropMs > want.dropMs + 200)
		off.push(`${got.dropMs} ms missing | natively ${want.dropMs}`);
	// a sound at another sample rate is at another pitch (a 44.1 kHz
	// sound read as 48 kHz is 8.8 % high). Its speed only says it is not
	// far off: a receiver's jitter buffer stretches the sound while it
	// settles, by several percent on a loaded machine, natively too
	if (got.pitchRatio === null || Math.abs(got.pitchRatio - 1) > 0.01)
		off.push(`at ${got.pitchRatio} of its pitch`);
	if (got.sweepSpeed === null || Math.abs(got.sweepSpeed - 1) > 0.08)
		off.push(`plays at ${got.sweepSpeed} of its speed`);
	// (how well its first 2 s line up, which a stretch there lowers: only
	// a sound that is not there at all)
	if (got.match < Math.min(0.2, want.match - 0.3))
		off.push(
			`lines up with what was sent at ${got.match} | natively ${want.match}`,
		);
	if (got.latencyMs > Math.max(400, want.latencyMs + 250))
		off.push(`${got.latencyMs} ms late | natively ${want.latencyMs}`);
	return off;
};

for (const name of Object.keys(SCENARIOS)) {
	if (only && !only.includes(name)) continue;
	const want = await run(natively, name);
	const control = !want.failure && want.sends && want.receives;
	ok(
		`natively, ${name}: the call has sound both ways`,
		control &&
			want.sends.segSnrDb > 5 &&
			want.receives.segSnrDb > 5 &&
			Math.abs(want.sends.pitchRatio - 1) <= 0.01 &&
			Math.abs(want.receives.pitchRatio - 1) <= 0.01,
		want.failure ?? `${brief(want.sends)} / ${brief(want.receives)}`,
	);
	if (!control) continue;
	// the isolated mode for the calls that differ from it most
	const pages = name === 'plain' || name === 'discord' ? proxied : [proxied[0]];
	for (const page of pages) {
		const got = await run(page, name);
		for (const side of ['sends', 'receives']) {
			const off = got.failure ? [got.failure] : sounds(got[side], want[side]);
			ok(
				`${page.label}, ${name}: what the page ${side === 'sends' ? 'sends' : 'receives'} sounds as it does natively`,
				!off.length,
				off.join('; '),
			);
		}
		if (got.failure) continue;
		if (name === 'discord' || name === 'dtx') {
			// Chrome's sender sends the first frame of a silence it leaves
			// out as a byte, so the far end knows it is silence: it conceals
			// none of it. (Without the byte, about 56,000 samples a call; a
			// loaded machine makes the page's sound late now and then, a few
			// thousand, as without usedtx)
			const concealed = got.sends.stats?.concealedSamples;
			const natively = want.sends.stats?.concealedSamples;
			ok(
				`${page.label}, ${name}: the far end takes the silences the page leaves out for silence, as natively (it conceals no more of them)`,
				typeof concealed === 'number' && concealed <= natively + 9600,
				`concealed ${concealed} samples | natively ${natively}`,
			);
		}
		if (name === 'plain') {
			// the page's jitter buffer aims at the delay Chrome's NetEq aims
			// at for the same arrivals: a packet for a steady stream (40 ms
			// while it starts), a packet more where they vary (it aimed at 60
			// ms for every Opus stream, 40 and 20 for FEC; a loaded machine
			// makes the arrivals vary, natively too)
			const aim = (stats) =>
				stats?.jitterBufferEmittedCount
					? Math.round(
							(1000 * stats.jitterBufferTargetDelay) /
								stats.jitterBufferEmittedCount,
						)
					: null;
			const target = aim(got.receives.stats);
			const natively = aim(want.receives.stats);
			ok(
				`${page.label}, plain: the page's jitter buffer aims at the delay Chrome's does (within a packet)`,
				target !== null && natively !== null && target <= natively + 20,
				`${target} ms | natively ${natively}`,
			);
		}
		if (name === 'rates') {
			// (WebCodecs' Opus encoder held each frame of a 44.1 kHz track
			// 10 to 30 ms, which the far end's jitter buffer then added to)
			// (over the whole recording: the far end's jitter buffer moves
			// each stream's delay on its own, natively by up to 10 ms either
			// way, and further when the two line up badly; the tracks are
			// of one capture, so natively apart is no reason to be)
			const apart = got.apart?.latencyMedianMs;
			const natively = want.apart?.latencyMedianMs;
			ok(
				`${page.label}, rates: the sound of a 44.1 kHz track comes as soon after a 48 kHz one's as natively`,
				Number.isFinite(apart) &&
					Number.isFinite(natively) &&
					apart <= Math.max(natively, 0) + 15,
				`${apart} ms after | natively ${natively}; ${brief(got.apart)}`,
			);
		}
		if (name !== 'discord') continue;
		// the transforms' workers: every frame, with its stream and the
		// metadata Chrome gives it, and the far end's stream ids on ours
		const mine = got.seen?.own ?? {};
		const theirs = got.seen?.far ?? {};
		const natives = want.seen?.own ?? {};
		for (const op of ['send', 'recv']) {
			const at = mine[op];
			ok(
				`${page.label}, discord: the page's ${op} transform gets every frame, as audio frames with the metadata Chrome gives them`,
				at?.frames > 300 &&
					at.audio === at.frames &&
					at.ssrcs.length === 1 &&
					typeof at.ssrcs[0] === 'number' &&
					JSON.stringify(at.keys) === JSON.stringify(natives[op]?.keys) &&
					JSON.stringify(at.types) === JSON.stringify(natives[op]?.types),
				JSON.stringify({ proxied: at, natively: natives[op] }),
			);
		}
		ok(
			`${page.label}, discord: a frame's stream id is the one on the wire (the far end's for what it receives, its own for what it sends)`,
			mine.send?.ssrcs[0] === theirs.recv?.ssrcs[0] &&
				mine.recv?.ssrcs[0] === theirs.send?.ssrcs[0],
			JSON.stringify({ mine, theirs }),
		);
		// Chrome dates a sent frame from its first 10 ms block, so it comes
		// to the transform about 10 ms after its capture time (median)
		ok(
			`${page.label}, discord: the page's send transform gets each frame as long after its capture time as natively`,
			typeof mine.send?.captureLag === 'number' &&
				typeof natives.send?.captureLag === 'number' &&
				Math.abs(mine.send.captureLag - natives.send.captureLag) <= 4,
			`${mine.send?.captureLag} ms | natively ${natives.send?.captureLag}`,
		);
		// (natively about 19 of every 21 frames of a silence)
		ok(
			`${page.label}, discord: the page's send transform is handed the silence it leaves out as empty frames, and the far end's gets the byte that says so, as natively`,
			mine.send?.empty >= natives.send?.empty / 2 &&
				mine.send.empty <= natives.send.empty * 2 &&
				theirs.recv?.tiny >= want.seen?.far?.recv?.tiny / 2 &&
				theirs.recv.tiny <= want.seen.far.recv.tiny * 2 + 2,
			JSON.stringify({
				proxied: { empty: mine.send?.empty, tiny: theirs.recv?.tiny },
				natively: {
					empty: natives.send?.empty,
					tiny: want.seen?.far?.recv?.tiny,
				},
			}),
		);
		ok(
			`${page.label}, discord: the far end drops none of the page's frames (they are encrypted)`,
			theirs.recv?.frames > 300 && theirs.recv.dropped < 10,
			JSON.stringify(theirs.recv),
		);
	}
}
writeFileSync(
	`${OUT}webrtc-audio-${process.pid}.json`,
	JSON.stringify(results, null, 1),
);
await farBrowser.close();
await done(own);
