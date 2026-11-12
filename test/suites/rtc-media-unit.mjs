// The worker's media modules (src/rtc, docs/webrtc-over-wisp.md section
// 16), checked in node: the playout buffer on a clock of the test's own,
// G.711 against what Chrome's decoder gives, the audio level, the stack's
// formats read from the offers of two Chrome versions, the sender's times
// (an encoder that behaves as Chrome's was measured to), and sound sent
// through two stacks back to back (assets/rtc.wasm) as G.711 and as G.722,
// which need no WebCodecs; G.722 also against the output of the ITU-T
// reference codec (G.191 STL) for one signal. The browser's part (Opus, tracks) is the webrtc-media
// suite's. Skips when esbuild is not installed, as rewriter-unit does.
import { X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { done, ok, OUT, sleep } from '../lib.mjs';

let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log('SKIP rtc-media-unit: esbuild is not installed');
	process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(OUT, { recursive: true });
const entry = `${OUT}rtc-media-unit-entry.mjs`;
const from = (file) => JSON.stringify(`${root}src/rtc/${file}`);
writeFileSync(
	entry,
	`export { Playout } from ${from('playout.ts')};
export * from ${from('g711.ts')};
export * from ${from('g722.ts')};
export { AudioSender, AudioReceiver, levelOf } from ${from('audio.ts')};
export { ToneSender, eventPayload, TONES } from ${from('dtmf.ts')};
export { ComfortNoise, parseNoise } from ${from('cn.ts')};
export { hasLbrr, repackLbrr, silkSymbols } from ${from('lbrr.ts')};
export { stackFormats, parsePayloads, parseParameters } from ${from('formats.ts')};
export * as records from ${from('records.ts')};
export { Stack } from ${from('connection.ts')};
export { wasiImports } from ${from('wasi.ts')};
export { generateCertificate, hex } from ${from('certificate.ts')};
`,
);
const bundle = `${OUT}rtc-media-unit.mjs`;
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: bundle,
	logLevel: 'silent',
});
const m = await import(`${bundle}?${Date.now()}`);
const { records } = m;

// --- the playout buffer ---

/** a buffer of 20 ms frames at 48 kHz, driven by `arrivals` (ms a frame comes at; null for lost) */
function play(arrivals, { until, energy = () => 1, options = {} } = {}) {
	const discarded = [];
	const playout = new m.Playout({
		rate: 48,
		discard: (value) => discarded.push(value),
		...options,
	});
	const events = arrivals
		.map((at, index) => ({ at, index }))
		.filter((event) => event.at !== null)
		.sort((a, b) => a.at - b.at);
	const out = [];
	let next = 0;
	const end = until ?? Math.max(...events.map((event) => event.at)) + 400;
	for (let now = 0; now <= end; now += 20) {
		while (next < events.length && events[next].at <= now) {
			const { index, at } = events[next++];
			playout.push(index * 960, 960, index, at, energy(index));
		}
		out.push(playout.pull(now));
	}
	return { playout, out, discarded };
}
const played = (out) => out.filter((value) => value !== null);
const inOrder = (values) => values.every((v, i) => !i || v > values[i - 1]);
/** nulls between the first and the last frame played */
const holes = (out) => {
	const first = out.findIndex((value) => value !== null);
	const last = out.findLastIndex((value) => value !== null);
	return out.slice(first, last).filter((value) => value === null).length;
};

{
	const { out, playout } = play(Array.from({ length: 200 }, (_, i) => i * 20));
	ok(
		'a steady stream plays every frame in order, once two of them are held',
		played(out).length === 200 &&
			inOrder(played(out)) &&
			holes(out) === 0 &&
			out.indexOf(0) === 1,
		`${played(out).length} played, ${holes(out)} holes, first at pull ${out.indexOf(0)}`,
	);
	ok(
		'and its delay stays at the floor',
		playout.stats.targetMs === 40 && playout.stats.dropped === 0,
		JSON.stringify(playout.stats),
	);
}
{
	const arrivals = Array.from({ length: 100 }, (_, i) => i * 20);
	arrivals[50] = null;
	const { out, playout } = play(arrivals);
	const at = out.indexOf(49);
	ok(
		'a lost frame is one frame of silence where it was due',
		played(out).length === 99 &&
			holes(out) === 1 &&
			out[at + 1] === null &&
			out[at + 2] === 51,
		`${holes(out)} holes, after 49: ${out.slice(at + 1, at + 3)}`,
	);
	ok(
		'the gap is counted',
		playout.stats.gaps >= 1,
		JSON.stringify(playout.stats),
	);
}
{
	const arrivals = Array.from({ length: 100 }, (_, i) => i * 20);
	// 60 comes after 61, within what a buffer that starts deeper holds
	arrivals[60] = 61 * 20 + 5;
	const { out } = play(arrivals, { options: { initialMs: 80 } });
	ok(
		'frames that swap places on the way play in order',
		played(out).length === 100 && inOrder(played(out)) && holes(out) === 0,
		`${played(out).length} played, ${holes(out)} holes`,
	);
}
{
	// a frame lost on the way is rebuilt from the next one, which comes a
	// frame later and a little more
	const arrivals = Array.from({ length: 100 }, (_, i) => i * 20);
	arrivals[50] = 51 * 20 + 5;
	const plain = play(arrivals);
	const held = play(arrivals, { options: { holdMs: 20 } });
	ok(
		'a buffer that holds one frame more plays a frame rebuilt from the next one; one that does not has a gap there',
		holes(plain.out) === 1 &&
			plain.playout.stats.late === 1 &&
			played(held.out).length === 100 &&
			holes(held.out) === 0 &&
			held.playout.stats.targetMs === plain.playout.stats.targetMs + 20,
		`${holes(plain.out)} ${JSON.stringify(plain.playout.stats)} ${holes(held.out)} ${JSON.stringify(held.playout.stats)}`,
	);
}
{
	const arrivals = Array.from({ length: 100 }, (_, i) => i * 20);
	// 30 comes when 35 is playing
	arrivals[30] = 37 * 20;
	const { out, playout, discarded } = play(arrivals);
	ok(
		'a frame that comes after its time is dropped and counted late',
		playout.stats.late === 1 &&
			discarded.includes(30) &&
			!out.includes(30) &&
			holes(out) === 1,
		`${JSON.stringify(playout.stats)} discarded ${discarded}`,
	);
}
{
	// arrivals that vary by up to 60 ms, then steady again
	let seed = 7;
	const random = () =>
		(seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const arrivals = Array.from(
		{ length: 900 },
		(_, i) => i * 20 + (i < 300 ? Math.floor(random() * 60) : 0),
	);
	const loud = (index) => (index % 7 === 3 ? 0.001 : 1);
	const { out, playout, discarded } = play(arrivals, { energy: loud });
	const late = out.slice(0, 300 / 1).filter((v) => v === null).length;
	ok(
		'arrivals that vary are held longer: the delay follows their spread',
		playout.stats.dropped > 0 && late < 12,
		`${late} silent pulls while they varied, ${JSON.stringify(playout.stats)}`,
	);
	// (the first 60 frames are while the buffer learns the spread)
	const settled = out.slice(80, 320);
	ok(
		'and once it does, nothing more is missing',
		settled.every((value) => value !== null),
		`${settled.filter((v) => v === null).length} silent of ${settled.length}`,
	);
	ok(
		'a buffer deeper than the arrivals ask for gives up frames, the quiet ones first',
		playout.stats.targetMs === 40 &&
			discarded.length >= 2 &&
			discarded.filter((index) => loud(index) < 1).length >=
				discarded.length - 1,
		`target ${playout.stats.targetMs}, gave up ${discarded}`,
	);
	const tail = out.slice(320);
	const first = tail.findIndex((value) => value !== null);
	ok(
		'and giving one up is not heard as a gap',
		holes(tail.slice(first)) === 0 && inOrder(played(tail)),
		`${holes(tail.slice(first))} holes`,
	);
}
{
	// a sender that stops for two seconds (silence it does not send) and goes on
	const arrivals = Array.from({ length: 200 }, (_, i) =>
		i < 100 ? i * 20 : i * 20 + 2000,
	);
	const discarded = [];
	const playout = new m.Playout({
		rate: 48,
		discard: (v) => discarded.push(v),
	});
	const out = [];
	const running = [];
	let next = 0;
	for (let now = 0; now <= 6400; now += 20) {
		while (next < arrivals.length && arrivals[next] <= now) {
			// the media time moves on with the pause
			const time = next < 100 ? next * 960 : next * 960 + 96000;
			playout.push(time, 960, next, arrivals[next]);
			next++;
		}
		out.push(playout.pull(now));
		running.push(playout.running);
	}
	const resumed = out.indexOf(100);
	ok(
		'a stream that pauses stops playing, and plays again from where it resumes',
		played(out).length === 200 &&
			inOrder(played(out)) &&
			running[150] === false &&
			resumed * 20 - arrivals[100] <= 60 &&
			holes(out.slice(resumed)) === 0,
		`${played(out).length} played, resumed ${resumed * 20 - arrivals[100]} ms after, running in the pause: ${running[150]}`,
	);
}
{
	const discarded = [];
	const playout = new m.Playout({
		rate: 48,
		discard: (v) => discarded.push(v),
	});
	for (let i = 0; i < 100; i++) playout.push(i * 960, 960, i, 0);
	let held = 0;
	for (let now = 0; playout.pull(now) !== null || now < 100; now += 20) held++;
	ok(
		'a burst is held up to the longest delay and the oldest of it go',
		discarded.length >= 70 && inOrder(discarded) && playout.stats.dropped >= 70,
		`${discarded.length} dropped, ${held} pulls`,
	);
	playout.push(200 * 960, 960, 'x', 5000);
	playout.clear();
	ok('clear gives up what is held', discarded.includes('x'));
}
{
	const playout = new m.Playout({ rate: 48 });
	playout.push(0, 960, 'a', 0);
	playout.push(960, 960, 'b', 20);
	const first = [playout.pull(20), playout.pull(40)];
	// the same frame again (a retransmission that was not needed)
	const discarded = [];
	const again = new m.Playout({ rate: 48, discard: (v) => discarded.push(v) });
	again.push(0, 960, 'a', 0);
	again.push(0, 960, 'a2', 1);
	ok(
		'a frame that comes twice is played once',
		discarded.length === 1 && discarded[0] === 'a2' && first.includes('a'),
		`${discarded}`,
	);
}

// --- G.711 ---

{
	// what Chrome's AudioDecoder gives for the bytes (i * 7) & 255 (ulaw and alaw, 16-bit)
	const bytes = Uint8Array.from({ length: 40 }, (_, i) => (i * 7) & 255);
	const ulaw = [
		-32124, -24956, -17788, -13436, -9852, -7164, -5372, -3772, -2876, -1980,
		-1500, -1052, -748, -524, -340, -228, -120, -64, -8, 27005, 19837, 14460,
		10876, 7676, 5884, 4092, 3132, 2236, 1628, 1180, 812, 588, 372, 260, 148,
		80, 24, -29052, -21884, -15484,
	];
	const alaw = [
		-5504, -4736, -7040, -2112, -3264, -23040, -32256, -10496, -15104, -13568,
		-312, -392, -24, -232, -1504, -1824, -688, -592, -880, 4224, 6528, 2880,
		4032, 20992, 30208, 27136, 9984, 12544, 280, 488, 120, 200, 1376, 1184,
		1760, 528, 816, -5760, -8064, -2624,
	];
	// Chrome rounds its 16-bit samples from floats: one off at most
	const near = (decode, expected) =>
		[...bytes].every((byte, i) => Math.abs(decode(byte) - expected[i]) <= 1);
	ok('mu-law decodes as Chrome decodes it', near(m.ulawDecode, ulaw));
	ok('A-law decodes as Chrome decodes it', near(m.alawDecode, alaw));
	let worst = 0;
	let unstable = 0;
	for (let sample = -32768; sample <= 32767; sample += 7) {
		const u = m.ulawDecode(m.ulawEncode(sample));
		const a = m.alawDecode(m.alawEncode(sample));
		// companding: the step grows with the sample
		const bound = 16 + Math.abs(sample) * 0.05;
		worst = Math.max(
			worst,
			Math.abs(u - sample) / bound,
			Math.abs(a - sample) / bound,
		);
		if (m.ulawDecode(m.ulawEncode(u)) !== u) unstable++;
		if (m.alawDecode(m.alawEncode(a)) !== a) unstable++;
	}
	ok(
		'both laws encode to within a companding step, and what they decode to stays put',
		worst <= 1 && unstable === 0,
		`worst ${worst.toFixed(3)} of the bound, unstable ${unstable}`,
	);
	const tone = Float32Array.from(
		{ length: 160 },
		(_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 8000),
	);
	const back = m.g711Decode('PCMU', m.g711Encode('PCMU', tone));
	let error = 0;
	for (let i = 0; i < 160; i++)
		error = Math.max(error, Math.abs(back[i] - tone[i]));
	ok('a tone survives a packet', error < 0.02, `${error.toFixed(4)}`);
	for (const rate of [48000, 44100, 16000, 8000]) {
		const down = new m.Downsampler(rate, 8000);
		let made = 0;
		let sum = 0;
		for (let block = 0; block < 100; block++) {
			const out = down.push(new Float32Array(rate / 100).fill(0.25));
			made += out.length;
			for (const value of out) sum += value;
		}
		ok(
			`a second at ${rate} Hz is a second at 8000 Hz`,
			Math.abs(made - 8000) <= 1 && Math.abs(sum / made - 0.25) < 1e-4,
			`${made} samples, mean ${(sum / made).toFixed(5)}`,
		);
	}
}

// --- the audio level ---

ok(
	'the level of a full-scale sine is 3, of half that 9, of silence 127',
	m.levelOf(0.5 * 480, 480) === 3 &&
		m.levelOf(0.125 * 480, 480) === 9 &&
		m.levelOf(0, 480) === 127 &&
		m.levelOf(0, 0) === 127 &&
		m.levelOf(1e-20, 1) === 127 &&
		m.levelOf(4, 1) === 0,
);

// --- formats ---

const template = (version) =>
	readFileSync(`${root}test/fixtures/rtc/chrome-${version}-offer.sdp`, 'utf8');
for (const version of ['152', '156']) {
	const formats = m.stackFormats(template(version));
	const codecs = formats.codecs.split('|');
	ok(
		`Chrome ${version}'s offer gives its audio payloads in its order`,
		codecs.slice(0, 8).join('|') ===
			'111,opus,48000,2,minptime=10;useinbandfec=1|63,red,48000,2,111/111|9,G722,8000,,|0,PCMU,8000,,|8,PCMA,8000,,|13,CN,8000,,|110,telephone-event,48000,,|126,telephone-event,8000,,',
		codecs.slice(0, 8).join('|'),
	);
	ok(
		`and its video payloads, each with the one that repeats it (${version})`,
		codecs[8] === '96,VP8,90000,,' &&
			codecs[9] === '97,rtx,90000,,apt=96' &&
			codecs.some((entry) =>
				/^\d+,H264,90000,,.*profile-level-id=42e01f/.test(entry),
			) &&
			codecs.some((entry) => /^\d+,AV1,90000,,/.test(entry)),
		codecs.slice(7, 12).join('|'),
	);
	const exts = formats.exts.split('|');
	ok(
		`and each header extension once (${version})`,
		exts.includes('1:urn:ietf:params:rtp-hdrext:ssrc-audio-level') &&
			exts.includes('4:urn:ietf:params:rtp-hdrext:sdes:mid') &&
			exts.includes('13:urn:3gpp:video-orientation') &&
			new Set(exts.map((entry) => entry.split(':')[0])).size === exts.length,
		formats.exts,
	);
}
ok(
	'an offer without media gives nothing',
	m.stackFormats(
		'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
	) === null && m.stackFormats('') === null,
);
{
	const payloads = m.parsePayloads(
		'111,opus,48000,2,minptime=10;useinbandfec=1|63,red,48000,2,111/111|0,PCMU,8000,,',
	);
	ok(
		"the stack's payload list reads back",
		payloads.length === 3 &&
			payloads[0].pt === 111 &&
			payloads[0].name === 'opus' &&
			payloads[0].channels === 2 &&
			payloads[0].parameters.useinbandfec === '1' &&
			payloads[2].name === 'PCMU' &&
			payloads[2].clock === 8000 &&
			payloads[2].channels === 1,
		JSON.stringify(payloads),
	);
	const parameters = m.parseParameters(
		'minptime=10; useinbandfec=1;stereo=1 ;usedtx=1',
	);
	ok(
		'and so do format parameters',
		parameters.stereo === '1' &&
			parameters.usedtx === '1' &&
			parameters.minptime === '10',
	);
}

// --- sound as the worker hands it around: AudioData as far as the modules use it ---

class FakeAudioData {
	constructor(init) {
		this.format = init.format;
		this.sampleRate = init.sampleRate;
		this.numberOfFrames = init.numberOfFrames;
		this.numberOfChannels = init.numberOfChannels;
		this.timestamp = init.timestamp;
		this.duration = (init.numberOfFrames / init.sampleRate) * 1e6;
		this.data = new Float32Array(init.data);
		this.closed = false;
	}
	copyTo(destination, { planeIndex }) {
		const frames = this.numberOfFrames;
		destination.set(
			this.data.subarray(planeIndex * frames, (planeIndex + 1) * frames),
		);
	}
	close() {
		this.closed = true;
	}
}
globalThis.AudioData = FakeAudioData;

/** 10 ms of a tone, as a track gives it */
function sound(
	index,
	{ rate = 48000, channels = 1, amplitude = 0.5, at = index * 10000 } = {},
) {
	const frames = rate / 100;
	const data = new Float32Array(frames * channels);
	for (let channel = 0; channel < channels; channel++)
		for (let i = 0; i < frames; i++)
			data[channel * frames + i] =
				amplitude * Math.sin((2 * Math.PI * 440 * (index * frames + i)) / rate);
	return new FakeAudioData({
		format: 'f32-planar',
		sampleRate: rate,
		numberOfFrames: frames,
		numberOfChannels: channels,
		timestamp: at,
		data,
	});
}

// An Opus encoder that keeps time as Chrome's was measured to (Chrome 152):
// 20 ms frames, their timestamps the first input's plus what it has made,
// input it was not configured for refused, and with usedtx nothing made
// (nor counted) once silence has lasted a while.
class FakeEncoder {
	static made = [];
	constructor(init) {
		this.init = init;
		this.state = 'unconfigured';
		this.encodeQueueSize = 0;
		FakeEncoder.made.push(this);
	}
	configure(config) {
		this.config = config;
		this.state = 'configured';
		this.first = null;
		this.count = 0;
		this.pending = 0;
		this.quiet = 0;
		this.loud = false;
	}
	encode(data) {
		if (
			data.sampleRate !== this.config.sampleRate ||
			data.numberOfChannels !== this.config.numberOfChannels
		)
			throw new Error(
				'Input audio buffer is incompatible with codec parameters',
			);
		if (this.first === null) this.first = data.timestamp;
		this.pending += data.duration;
		if (data.data.some((value) => value !== 0)) this.loud = true;
		while (this.pending >= 20000 - 1) {
			this.pending -= 20000;
			const loud = this.loud;
			this.loud = false;
			this.quiet = loud ? 0 : this.quiet + 1;
			if (this.config.opus.usedtx && this.quiet > 20) continue;
			const timestamp = this.first + this.count++ * 20000;
			queueMicrotask(() => {
				if (this.state !== 'configured') return;
				this.init.output({
					timestamp,
					duration: 20000,
					byteLength: 3,
					copyTo: (bytes) => bytes.set([0x78, 1, 2]),
				});
			});
		}
	}
	close() {
		this.state = 'closed';
	}
}
globalThis.AudioEncoder = FakeEncoder;

/**
 * What a sender makes of `inputs`, configured with `payloads`; with
 * `pause`, the track gives nothing for `ms` before input number `before`
 */
async function send(inputs, payloads, pause = { before: Infinity, ms: 0 }) {
	const frames = [];
	const sender = new m.AudioSender(3, (frame, age) =>
		frames.push({ ...frame, age }),
	);
	sender.configure(payloads);
	sender.setActive(true);
	sender.setTrack(
		new ReadableStream({
			async start(controller) {
				for (const [at, input] of inputs.entries()) {
					if (at === pause.before) await sleep(pause.ms);
					controller.enqueue(input);
				}
				controller.close();
			},
		}),
	);
	await sleep(50 + (pause.before < inputs.length ? pause.ms : 0));
	sender.close();
	return frames;
}
const opus = (fmtp = 'minptime=10;useinbandfec=1') =>
	m.parsePayloads(`111,opus,48000,2,${fmtp}`);
const steps = (frames) =>
	frames.slice(1).map((frame, i) => Number(frame.time - frames[i].time));
const talkspurts = (frames) =>
	frames
		.map((frame, i) => (frame.flags & records.FLAG_TALKSPURT ? i : -1))
		.filter((i) => i !== -1);

{
	const inputs = Array.from({ length: 100 }, (_, i) =>
		sound(i, { at: 7777 + i * 10000 }),
	);
	const frames = await send(inputs, opus());
	ok(
		'a track becomes 20 ms Opus frames, 960 apart, on the section and payload negotiated',
		frames.length === 50 &&
			steps(frames).every((step) => step === 960) &&
			frames.every(
				(frame) => frame.media === 3 && frame.pt === 111 && frame.rid === '',
			),
		`${frames.length} frames, steps ${[...new Set(steps(frames))]}`,
	);
	ok(
		'the first frame starts a talkspurt, every frame says how loud it is, and each input is closed',
		talkspurts(frames).join() === '0' &&
			frames.every(
				(frame) =>
					frame.level === 9 &&
					frame.flags & records.FLAG_VOICE &&
					frame.age >= 0,
			) &&
			inputs.every((input) => input.closed),
		`talkspurts at ${talkspurts(frames)}, levels ${[...new Set(frames.map((f) => f.level))]}`,
	);
	const encoder = FakeEncoder.made.at(-1);
	ok(
		"the encoder is the browser's for a voice: one channel, 32 kbit/s, 20 ms, FEC as negotiated",
		encoder.config.numberOfChannels === 1 &&
			encoder.config.bitrate === 32000 &&
			encoder.config.opus.frameDuration === 20000 &&
			encoder.config.opus.useinbandfec === true &&
			encoder.config.opus.usedtx === false &&
			encoder.state === 'closed',
		JSON.stringify(encoder.config),
	);
}
{
	// the track stops for 0.3 s after half a second, and so do its times
	const inputs = Array.from({ length: 100 }, (_, i) =>
		sound(i, { at: 7777 + i * 10000 + (i >= 50 ? 300000 : 0) }),
	);
	const frames = await send(inputs, opus(), { before: 50, ms: 300 });
	const jump = steps(frames).findIndex((step) => step !== 960);
	const gap = steps(frames)[jump] - 960;
	ok(
		'a break in the track is a break in the times, as long as the clock says, and a new talkspurt',
		frames.length === 50 &&
			jump === 24 &&
			gap % 120 === 0 &&
			gap > 0.2 * 48000 &&
			gap < 0.5 * 48000 &&
			steps(frames).filter((step) => step !== 960).length === 1 &&
			talkspurts(frames).join() === '0,25',
		`${frames.length} frames, ${gap / 48} ms after frame ${jump}, talkspurts ${talkspurts(frames)}`,
	);
}
{
	// a track whose times are another clock's: below zero, and five
	// seconds back in the middle of the sound (Chrome 152 and 156 hand a
	// worker times below zero for a track a page writes itself)
	const inputs = Array.from({ length: 100 }, (_, i) =>
		sound(i, { at: -1035000 + i * 10000 - (i >= 50 ? 5000000 : 0) }),
	);
	const frames = await send(inputs, opus());
	ok(
		"the times that go out are the sender's own: they start at its number and never go back, whatever the track's are",
		frames.length === 50 &&
			steps(frames).every((step) => step === 960) &&
			frames[0].time >= 0n &&
			frames[0].time < 2n ** 32n &&
			talkspurts(frames).join() === '0,25',
		`${frames.length} frames, steps ${[...new Set(steps(frames))]}, talkspurts ${talkspurts(frames)}`,
	);
}
{
	const stereo = await send(
		Array.from({ length: 20 }, (_, i) => sound(i)),
		opus('minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=96000;cbr=1'),
	);
	const encoder = FakeEncoder.made.at(-1);
	ok(
		'a peer that asks for stereo gets two channels (one twice, of a track with one), at the rate it asks for',
		stereo.length === 10 &&
			encoder.config.numberOfChannels === 2 &&
			encoder.config.bitrate === 96000 &&
			encoder.config.bitrateMode === 'constant',
		`${stereo.length} frames ${JSON.stringify(encoder.config)}`,
	);
	const mixed = await send(
		Array.from({ length: 20 }, (_, i) => sound(i, { channels: 2 })),
		opus(),
	);
	ok(
		'and a track with two channels is sent as one to a peer that did not',
		mixed.length === 10 &&
			FakeEncoder.made.at(-1).config.numberOfChannels === 1,
		`${mixed.length} frames`,
	);
	const other = await send(
		Array.from({ length: 20 }, (_, i) => sound(i, { rate: 44100 })),
		opus(),
	);
	ok(
		"the encoder is made for the track's own rate",
		other.length === 10 &&
			FakeEncoder.made.at(-1).config.sampleRate === 44100 &&
			steps(other).every((step) => step === 960),
		`${other.length} frames at ${FakeEncoder.made.at(-1).config.sampleRate}`,
	);
}
{
	// 0.6 s of sound, 2 s of silence, 0.6 s of sound, to a peer that asked for silence to be left out
	const inputs = Array.from({ length: 320 }, (_, i) =>
		sound(i, { amplitude: i < 60 || i >= 260 ? 0.5 : 0 }),
	);
	const frames = await send(
		inputs,
		opus('minptime=10;useinbandfec=1;usedtx=1'),
	);
	const jump = steps(frames).findIndex((step) => step !== 960);
	const skipped = steps(frames)[jump] / 960 - 1;
	// 30 frames of sound and 20 of silence are made before the encoder stops
	ok(
		'frames an encoder leaves out of a silence are time that passed',
		frames.length === 80 &&
			jump === 49 &&
			Math.abs(skipped - 80) <= 2 &&
			steps(frames).filter((step) => step !== 960).length === 1 &&
			talkspurts(frames).join() === '0,50',
		`${frames.length} frames, ${skipped} skipped after frame ${jump}, talkspurts ${talkspurts(frames)}`,
	);
	ok(
		'and the silence it does send says so',
		frames[40].level === 127 && !(frames[40].flags & records.FLAG_VOICE),
		`level ${frames[40].level}`,
	);
}
{
	const frames = await send(
		Array.from({ length: 100 }, (_, i) => sound(i, { rate: 44100 })),
		m.parsePayloads('8,PCMA,8000,,|0,PCMU,8000,,'),
	);
	const tone = m.g711Decode('PCMA', frames[10].payload);
	let power = 0;
	for (const value of tone) power += value * value;
	ok(
		'without Opus the first G.711 payload is sent: 160 bytes every 160, from any rate',
		frames.length >= 49 &&
			frames.every((frame) => frame.pt === 8 && frame.payload.length === 160) &&
			steps(frames).every((step) => step === 160) &&
			Math.abs(Math.sqrt(power / 160) - 0.5 / Math.SQRT2) < 0.02 &&
			frames[10].level === 9,
		`${frames.length} frames, rms ${Math.sqrt(power / 160).toFixed(3)}, level ${frames[10].level}`,
	);
	const wide = await send(
		Array.from({ length: 100 }, (_, i) => sound(i, { rate: 44100 })),
		m.parsePayloads('9,G722,8000,,|0,PCMU,8000,,'),
	);
	const decoded = m
		.g722Decode(
			new m.G722Decoder(),
			new Uint8Array(wide.slice(0, 11).flatMap((frame) => [...frame.payload])),
		)
		.subarray(320 * 10);
	let squares = 0;
	for (const value of decoded) squares += value * value;
	ok(
		'G.722 before G.711 is sent as G.722: 160 bytes of 16 kHz sound every 320 of the stack count',
		wide.length >= 49 &&
			wide.every((frame) => frame.pt === 9 && frame.payload.length === 160) &&
			steps(wide).every((step) => step === 320) &&
			Math.abs(Math.sqrt(squares / 320) - 0.5 / Math.SQRT2) < 0.03,
		`${wide.length} frames, steps ${[...new Set(steps(wide))]}, rms ${Math.sqrt(squares / 320).toFixed(3)}`,
	);
	const none = await send(
		Array.from({ length: 20 }, (_, i) => sound(i)),
		m.parsePayloads('13,CN,8000,,|126,telephone-event,8000,,'),
	);
	ok('and nothing where no payload can be encoded here', none.length === 0);
}

// --- DTMF (RFC 4733), as Chrome's sender puts it on the wire ---

/**
 * The packets a ToneSender makes in place of audio frames `step` apart (on
 * the audio's clock) for an event of `ms` on a payload of clock `rate`,
 * frames coming every 20 ms; null where the audio frame goes out
 */
function tonePackets(ms, rate, step, { frames = 40, start = 1000 } = {}) {
	const tones = new m.ToneSender();
	tones.add(5, ms);
	const out = [];
	for (let n = 0; n < frames; n++) {
		const packets = tones.frame(start + n * step, rate, 1000 + n * 20);
		out.push(
			packets &&
				packets.map(
					(packet) =>
						`${packet.marker ? 'M' : '-'}${packet.time - start}:${[...packet.payload].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
				),
		);
	}
	return out;
}
{
	// measured on Chrome 152 and 156 against a peer that logged every
	// packet: '1' for 100 ms with PCMU and telephone-event/8000
	const pcmu = tonePackets(100, 8000, 160);
	ok(
		"an event's packets replace the audio frames of its time, counting its duration up, then end three times",
		JSON.stringify(pcmu.slice(0, 7)) ===
			JSON.stringify([
				[],
				['M0:050a00a0'],
				['-0:050a0140'],
				['-0:050a01e0'],
				['-0:050a0280'],
				['-0:058a0320', '-0:058a0320', '-0:058a0320'],
				null,
			]) && pcmu.slice(6).every((packets) => packets === null),
		JSON.stringify(pcmu.slice(0, 7)),
	);
	// Opus's events go on telephone-event/8000 and count on Opus's clock:
	// 100 ms is 800 units, which the first packet (960) is already past
	const opus = tonePackets(100, 8000, 960);
	ok(
		"with Opus and an event payload at 8 kHz, Chrome's arithmetic: the first packet ends it, marked three times",
		JSON.stringify(opus.slice(0, 3)) ===
			JSON.stringify([[], ['M0:058a03c0', 'M0:058a03c0', 'M0:058a03c0'], null]),
		JSON.stringify(opus.slice(0, 3)),
	);
	const long = tonePackets(500, 8000, 960);
	ok(
		'and 500 ms of it five packets, the last 4800',
		JSON.stringify(long.slice(0, 7)) ===
			JSON.stringify([
				[],
				['M0:050a03c0'],
				['-0:050a0780'],
				['-0:050a0b40'],
				['-0:050a0f00'],
				['-0:058a12c0', '-0:058a12c0', '-0:058a12c0'],
				null,
			]),
		JSON.stringify(long.slice(0, 7)),
	);
	// at 48 kHz on both sides an event longer than 65535 units goes on in
	// a segment of its own (RFC 4733, 2.5.2.3)
	const segments = tonePackets(2000, 48000, 960, { frames: 110 })
		.flat()
		.filter((packet) => packet && packet.length);
	const restart = segments.findIndex((packet) => /^-66240:/.test(packet));
	ok(
		'an event longer than a report holds goes on in a new segment',
		segments.includes('-0:050affff') &&
			restart !== -1 &&
			segments.at(-1).includes(':058a') &&
			segments.slice(-3).every((packet) => packet === segments.at(-1)),
		JSON.stringify(segments.slice(66, 72)),
	);
	const tones = new m.ToneSender();
	tones.add(1, 40);
	tones.add(2, 40);
	const gaps = [];
	for (let n = 0; n < 12; n++)
		gaps.push(tones.frame(n * 160, 8000, n * 20)?.length ?? null);
	ok(
		'the next tone waits for 50 ms after the last ended, the audio going out meanwhile',
		JSON.stringify(gaps) ===
			JSON.stringify([0, 1, 3, null, null, 0, 1, 3, null, null, null, null]),
		JSON.stringify(gaps),
	);
	const payloads = m.parsePayloads(
		'111,opus,48000,2,minptime=10;useinbandfec=1|110,telephone-event,48000,,0-15|126,telephone-event,8000,,0-15',
	);
	ok(
		"the event payload is the first of the lowest clock, as Chrome's sender picks it",
		m.eventPayload(payloads)?.pt === 126 &&
			m.eventPayload(payloads.slice(0, 2))?.pt === 110 &&
			m.eventPayload(payloads.slice(0, 1)) === null,
	);
}
{
	// the sender: tones go out on the event payload in place of its frames
	const payloads = m.parsePayloads(
		'0,PCMU,8000,1,|110,telephone-event,48000,,0-15|126,telephone-event,8000,,0-15',
	);
	const frames = [];
	const sender = new m.AudioSender(2, (frame) => frames.push(frame));
	sender.configure(payloads);
	sender.setActive(true);
	sender.tone('#', 100);
	sender.tone('x', 100);
	sender.setTrack(
		new ReadableStream({
			start(controller) {
				for (let n = 0; n < 30; n++) controller.enqueue(sound(n));
				controller.close();
			},
		}),
	);
	await sleep(50);
	sender.close();
	const kinds = frames.map((frame) => frame.pt);
	const events = frames.filter((frame) => frame.pt === 126);
	const first = events[0];
	const audioAfter = frames[kinds.lastIndexOf(126) + 1];
	ok(
		'a tone goes out on telephone-event/8000 in place of the frames of its time, stamped with the time its event began, without a level',
		sender.canTone &&
			kinds.join() === '126,126,126,126,126,126,126,0,0,0,0,0,0,0,0,0' &&
			events.every(
				(frame) =>
					frame.time === first.time &&
					frame.level === records.ABSENT &&
					frame.media === 2,
			) &&
			first.flags === records.FLAG_TALKSPURT &&
			events.slice(1).every((frame) => frame.flags === 0) &&
			[...events.at(-1).payload].join() === '11,138,3,32' &&
			Number(audioAfter.time - first.time) === 6 * 160 &&
			!(audioAfter.flags & records.FLAG_TALKSPURT),
		JSON.stringify(
			frames.map((frame) => [frame.pt, Number(frame.time), frame.flags]),
		),
	);
	const none = new m.AudioSender(2, () => {});
	none.configure(m.parsePayloads('0,PCMU,8000,1,'));
	ok('a section without an event payload cannot tone', !none.canTone);
}

// --- comfort noise (RFC 3389) ---
{
	const flat = m.parseNoise(Uint8Array.of(40));
	const shaped = m.parseNoise(Uint8Array.of(60, 200, 90, 127));
	const rms = (samples) =>
		Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
	const db = (samples) => 20 * Math.log10(rms(samples));
	const noise = new m.ComfortNoise(8000);
	noise.update(flat);
	noise.make(800);
	const at40 = db(noise.make(8000));
	const other = new m.ComfortNoise(8000);
	other.update(shaped);
	other.make(800);
	const at60 = db(other.make(8000));
	ok(
		'a comfort noise packet reads as its level and its reflection coefficients',
		flat.level === 40 &&
			flat.reflections.length === 0 &&
			shaped.level === 60 &&
			shaped.reflections.join() === [73 / 128, -37 / 128, 0].join(),
	);
	ok(
		"the noise made of it is where Chrome plays it, 2.6 dB below the packet's level, whatever its shape",
		Math.abs(at40 + 42.6) < 1 && Math.abs(at60 + 62.6) < 1,
		`${at40.toFixed(2)} dB, ${at60.toFixed(2)} dB`,
	);
}

// --- G.722 against the ITU-T reference ---

{
	// a sweep across the whole band at -3 dBFS, 4 s of it at 16 kHz; the
	// hashes are of what the G.191 STL's encg722 and decg722 (mode 1) make
	// of it
	const pcm = new Int16Array(4 * 16000);
	for (let at = 0; at < pcm.length; at++) {
		const t = at / 16000;
		const value = Math.round(
			32767 *
				Math.pow(10, -3 / 20) *
				Math.sin(2 * Math.PI * (20 * t + ((8000 - 20) / 8) * t * t)),
		);
		pcm[at] = Math.max(-32768, Math.min(32767, value));
	}
	const { createHash } = await import('node:crypto');
	const sha = (bytes) =>
		createHash('sha256')
			.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
			.digest('hex');
	const encoder = new m.G722Encoder();
	const codes = new Uint8Array(pcm.length / 2);
	for (let at = 0; at < pcm.length; at += 320)
		codes.set(encoder.encode(pcm.subarray(at, at + 320)), at / 2);
	const decoder = new m.G722Decoder();
	const out = new Int16Array(pcm.length);
	for (let at = 0; at < codes.length; at += 160)
		out.set(decoder.decode(codes.subarray(at, at + 160)), at * 2);
	ok(
		'G.722 encodes and decodes a sweep, packet by packet, as the ITU-T reference does, bit for bit',
		sha(codes) ===
			'd53e90016beb4c02ad41d20797a97b9f21087af3bfdfcf201ba5fc7fbe456c7c' &&
			sha(out) ===
				'c00bc4c4842a9fa10ae8aa127c297474a25eddbd5940bc7e73e2eb083e569e6d',
		`${sha(codes)} ${sha(out)}`,
	);
}

// --- a lost Opus packet ---

{
	// A decoder that answers each chunk with 20 ms, as Chrome's does, and
	// keeps what it was given
	const given = [];
	class FakeDecoder {
		constructor({ output }) {
			this.output = output;
			this.state = 'unconfigured';
			this.decodeQueueSize = 0;
		}
		configure() {
			this.state = 'configured';
		}
		decode(chunk) {
			given.push(chunk);
			this.output(
				new FakeAudioData({
					format: 'f32-planar',
					sampleRate: 48000,
					numberOfFrames: 960,
					numberOfChannels: 1,
					timestamp: chunk.timestamp,
					data: new Float32Array(960).fill(
						chunk.data.length === 1 ? 0.25 : 0.5,
					),
				}),
			);
		}
		close() {
			this.state = 'closed';
		}
	}
	class FakeChunk {
		constructor({ timestamp, data }) {
			this.timestamp = timestamp;
			this.data = new Uint8Array(data);
		}
	}
	globalThis.AudioDecoder = FakeDecoder;
	globalThis.EncodedAudioChunk = FakeChunk;
	const receiver = new m.AudioReceiver();
	receiver.setTrack(new WritableStream({ write() {} }));
	const packet = (time, flags = records.FLAG_CONTIGUOUS) =>
		receiver.frame({
			codec: 'opus',
			time: BigInt(time),
			// SILK wideband, 20 ms, one frame (RFC 6716, 3.1)
			payload: Uint8Array.of(0x4b, 1, 2, 3),
			flags,
		});
	packet(0);
	packet(960);
	// two lost
	packet(3840, 0);
	// a pause of a second: a sender that left silence out
	packet(51840, 0);
	// a talkspurt after a short gap
	packet(54720, records.FLAG_TALKSPURT);
	receiver.close();
	delete globalThis.AudioDecoder;
	delete globalThis.EncodedAudioChunk;
	const seen = given.map(
		(chunk) => `${chunk.timestamp}:${[...chunk.data].join('.')}`,
	);
	ok(
		'a lost Opus packet is concealed by the decoder (a frame of one byte, the last first byte of one frame), not left silent; a pause and a talkspurt are not',
		seen.join() ===
			[
				'0:75.1.2.3',
				'20000:75.1.2.3',
				'40000:72',
				'60000:72',
				'80000:75.1.2.3',
				'1080000:75.1.2.3',
				'1140000:75.1.2.3',
			].join() && receiver.stats.concealed === 2,
		`${seen.join()} concealed ${receiver.stats.concealed}`,
	);
}

// --- Opus in-band FEC ---

{
	// Packets of libopus 1.5.2 (narrowband, mediumband, wideband: the copy
	// decodes bit for bit as libopus's decode_fec does, stomp-work's
	// fecpair harness) and of Chrome 156 (wideband SILK and fullband
	// hybrid), each with the copy made of its LBRR frame
	const fixture = JSON.parse(
		readFileSync(`${root}test/fixtures/rtc/opus-lbrr.json`, 'utf8'),
	);
	const bytes = (text) => Uint8Array.from(Buffer.from(text, 'base64'));
	const wrong = [];
	for (const [packet, copy] of fixture) {
		const made = m.repackLbrr(bytes(packet));
		const text = made && Buffer.from(made).toString('base64');
		const symbols = m.silkSymbols(bytes(packet), true).join();
		if (
			text !== copy ||
			m.hasLbrr(bytes(packet)) !== (copy !== null) ||
			(copy && m.silkSymbols(made, false).join() !== symbols) ||
			(copy && (made[0] & 7) !== 0)
		)
			wrong.push(packet.slice(0, 12));
	}
	ok(
		'the LBRR copy a packet carries becomes a packet of its own, with the same symbols (narrowband to fullband hybrid; none from a packet without one or a CELT packet)',
		fixture.length === 13 && !wrong.length,
		wrong.join(),
	);

	const given = [];
	class FakeDecoder {
		constructor({ output }) {
			this.output = output;
			this.state = 'unconfigured';
			this.decodeQueueSize = 0;
		}
		configure() {
			this.state = 'configured';
		}
		decode(chunk) {
			given.push(chunk);
			this.output(
				new FakeAudioData({
					format: 'f32-planar',
					sampleRate: 48000,
					numberOfFrames: 960,
					numberOfChannels: 1,
					timestamp: chunk.timestamp,
					data: new Float32Array(960),
				}),
			);
		}
		close() {
			this.state = 'closed';
		}
	}
	class FakeChunk {
		constructor({ timestamp, data }) {
			this.timestamp = timestamp;
			this.data = new Uint8Array(data);
		}
	}
	globalThis.AudioDecoder = FakeDecoder;
	globalThis.EncodedAudioChunk = FakeChunk;
	const receiver = new m.AudioReceiver();
	receiver.setTrack(new WritableStream({ write() {} }));
	const silk = bytes(fixture[4][0]);
	const copy = bytes(fixture[4][1]);
	const plain = bytes(fixture[11][0]);
	const celt = bytes(fixture[12][0]);
	const packet = (time, payload, flags = records.FLAG_CONTIGUOUS) =>
		receiver.frame({ codec: 'opus', time: BigInt(time), payload, flags });
	packet(0, silk);
	packet(960, silk);
	// one lost: the next one's copy
	packet(2880, silk, 0);
	// three lost: the last from the copy, the others concealed
	packet(6720, silk, 0);
	// after a CELT-only packet libopus conceals instead
	packet(7680, celt);
	packet(9600, silk, 0);
	// a packet with no copy
	packet(10560, plain);
	packet(12480, plain, 0);
	receiver.close();
	delete globalThis.AudioDecoder;
	delete globalThis.EncodedAudioChunk;
	const name = (data) =>
		data.length === 1
			? `lost${data[0]}`
			: data.every((value, i) => value === copy[i]) &&
				  data.length === copy.length
				? 'copy'
				: data === silk || data.length === silk.length
					? 'silk'
					: data.length === celt.length
						? 'celt'
						: 'plain';
	const seen = given.map(
		(chunk) => `${chunk.timestamp / 20000}:${name(chunk.data)}`,
	);
	const want = [
		'0:silk',
		'1:silk',
		'2:copy',
		'3:silk',
		`4:lost${silk[0] & 0xfc}`,
		`5:lost${silk[0] & 0xfc}`,
		'6:copy',
		'7:silk',
		'8:celt',
		`9:lost${celt[0] & 0xfc}`,
		'10:silk',
		'11:plain',
		`12:lost${plain[0] & 0xfc}`,
		'13:plain',
	];
	const stats = receiver.stats;
	ok(
		"a lost Opus packet is decoded from the next one's FEC copy, as Chrome's NetEq does: only the last of a burst, never after a CELT-only packet; the rest is concealed",
		seen.join() === want.join() &&
			stats.concealed === 4 &&
			stats.fecPacketsReceived === 5 &&
			stats.fecPacketsDiscarded === 3,
		`${seen.join()} ${JSON.stringify(stats)}`,
	);
}

// --- two stacks back to back ---

const wasm = await WebAssembly.compile(readFileSync(`${root}assets/rtc.wasm`));
async function stack() {
	let exports = null;
	const instance = await WebAssembly.instantiate(
		wasm,
		m.wasiImports(() => exports.memory),
	);
	exports = instance.exports;
	return new m.Stack(instance);
}
const certificate = await m.generateCertificate();
const formats = m.stackFormats(template('152'));

class Peer {
	constructor(engine, address, own = certificate) {
		this.engine = engine;
		this.address = address;
		this.events = [];
		this.frames = [];
		this.onFrame = null;
		this.id = engine.create({
			local: address,
			cert: m.hex(own.certificate),
			key: m.hex(own.privateKey),
			...formats,
		});
	}
	control(fields) {
		this.engine.input(this.id, records.IN_CONTROL, records.encodeText(fields));
		return this.drain(true);
	}
	drain(wantResult = false) {
		let result = null;
		for (;;) {
			const record = this.engine.output(this.id);
			if (!record) break;
			const payload = record.subarray(1);
			if (record[0] === records.OUT_TRANSMIT) {
				const transmit = records.decodeTransmit(payload);
				if (transmit.destination === this.other.address) {
					this.other.engine.input(
						this.other.id,
						records.IN_DATAGRAM,
						records.encodeDatagram(
							'udp',
							transmit.source,
							transmit.destination,
							transmit.payload,
						),
					);
					this.other.pending = true;
				}
			} else if (record[0] === records.OUT_EVENT)
				this.events.push(records.decodeText(payload));
			else if (record[0] === records.OUT_MEDIA_DATA) {
				const frame = records.decodeMediaData(payload);
				this.frames.push(frame);
				this.onFrame?.(frame);
			} else if (record[0] === records.OUT_RESULT && wantResult)
				result = records.decodeText(payload);
		}
		return result;
	}
	tick() {
		this.engine.tick(this.id);
		this.drain();
	}
}

const engine = await stack();
const a = new Peer(engine, '198.51.100.1:5000');
const b = new Peer(await stack(), '198.51.100.2:5000');
a.other = b;
b.other = a;
ok(
	"the stack takes the browser's formats",
	a.id >= 0 && b.id >= 0,
	`${a.id} ${b.id}`,
);

const index = Number(
	a.control({
		op: 'media',
		kind: 'audio',
		dir: 'sendrecv',
		stream: 's',
		track: 't',
	}).index,
);
const offer = a.control({ op: 'offer' });
const audio =
	offer.sdp.split('\r\n').find((line) => line.startsWith('m=audio')) ?? '';
ok(
	"its offer lists the browser's audio payloads, by the browser's numbers",
	audio.split(' ').slice(3).sort().join() ===
		['111', '63', '9', '0', '8', '13', '110', '126'].sort().join() &&
		offer.sdp.includes('a=rtpmap:111 opus/48000/2') &&
		offer.sdp.includes('a=rtpmap:9 G722/8000'),
	audio,
);
const answer = b.control({
	op: 'remote_offer',
	sdp: offer.sdp,
	dir0: 'sendrecv',
});
ok(
	'the answerer numbers the offered section at once',
	/^\d+:/.test(answer.mids ?? ''),
	`mids ${answer.mids}`,
);
const remote = Number((answer.mids ?? '0:').split(':')[0]);
a.control({ op: 'answer', sdp: answer.sdp });
a.control({
	op: 'remote_candidate',
	candidate: `candidate:1 1 udp 2113937151 198.51.100.2 5000 typ host`,
});
b.control({
	op: 'remote_candidate',
	candidate: `candidate:1 1 udp 2113937151 198.51.100.1 5000 typ host`,
});
const connected = (peer) =>
	peer.events.some((event) => event.ev === 'connected');
for (let i = 0; i < 1500 && !(connected(a) && connected(b)); i++) {
	a.tick();
	b.tick();
	await sleep(2);
}
ok('two stacks connect back to back', connected(a) && connected(b));

const negotiated = a.control({ op: 'payloads', index });
ok(
	'the section negotiated Opus first, both ways',
	m.parsePayloads(negotiated.codecs ?? '')[0]?.name === 'opus' &&
		negotiated.dir === 'sendrecv',
	`${negotiated.codecs} ${negotiated.dir}`,
);

// sound from a to b as G.711: the sender, the stack, the receiver, a track's sink
const sender = new m.AudioSender(index, (frame, age) => {
	a.engine.input(a.id, records.IN_MEDIA_WRITE, records.encodeFrame(frame, age));
	a.drain();
});
sender.configure(
	m
		.parsePayloads(negotiated.codecs ?? '')
		.filter((payload) => payload.name === 'PCMU'),
);
sender.setActive(true);
const written = [];
const receiver = new m.AudioReceiver();
let started = 0;
receiver.onStart = () => started++;
receiver.setTrack(
	new WritableStream({
		write(data) {
			written.push(data);
		},
	}),
);
b.onFrame = (frame) => {
	if (frame.media === remote) receiver.frame(frame);
};
let source = null;
sender.setTrack(
	new ReadableStream({
		start(controller) {
			source = controller;
		},
	}),
);
const began = performance.now();
for (let n = 0; n < 150;) {
	// 10 ms frames as time passes
	while (n < 150 && n * 10 <= performance.now() - began)
		source.enqueue(sound(n++));
	a.tick();
	b.tick();
	await sleep(2);
}
await sleep(150);
source.close();
sender.close();

ok(
	'frames written on one side come out on the other, with their level',
	b.frames.length >= 70 &&
		b.frames.every(
			(frame) =>
				frame.codec === 'PCMU' &&
				frame.pt === 0 &&
				frame.payload.length === 160,
		) &&
		b.frames
			.slice(1)
			.every((frame, i) => frame.time - b.frames[i].time === 160n) &&
		b.frames[5].level === 9,
	`${b.frames.length} frames, level ${b.frames[5]?.level}`,
);
ok(
	'the first of them has its talkspurt flag and the rest do not',
	(b.frames[0].flags & records.FLAG_TALKSPURT) !== 0 &&
		b.frames.slice(1).every((frame) => !(frame.flags & records.FLAG_TALKSPURT)),
);
{
	// the silence of the pulls after the sender stopped is not the tone's
	const silent = (data) => data.data.every((value) => value === 0);
	const sounding = [...written];
	while (sounding.length && silent(sounding.at(-1))) sounding.pop();
	const heard = new Float32Array(
		sounding.reduce((sum, data) => sum + data.numberOfFrames, 0),
	);
	let at = 0;
	for (const data of sounding) {
		heard.set(data.data.subarray(0, data.numberOfFrames), at);
		at += data.numberOfFrames;
	}
	// the tone's strength and phase, 5 ms at a time
	const w = (2 * Math.PI * 440) / 48000;
	const amplitudes = [];
	const phases = [];
	for (let i = 0; i + 240 <= heard.length; i += 240) {
		let I = 0;
		let Q = 0;
		for (let k = 0; k < 240; k++) {
			I += heard[i + k] * Math.cos(w * (i + k));
			Q += heard[i + k] * Math.sin(w * (i + k));
		}
		amplitudes.push(Math.hypot(I, Q) / 120);
		phases.push(Math.atan2(Q, I));
	}
	let jumps = 0;
	for (let i = 1; i < phases.length; i++) {
		const turn = phases[i] - phases[i - 1];
		if (Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) > 0.2) jumps++;
	}
	const weak = amplitudes.filter(
		(value) => Math.abs(value - 0.5) > 0.05,
	).length;
	// a machine that stalls the test for a moment has the receiver play a
	// frame of silence for one that had not come: each is four windows
	// weak and a break either side, and there are few
	const stalls = sounding.filter(silent).length;
	ok(
		'the receiver writes the tone to its track at 48 kHz, whole and unbroken',
		started === 1 &&
			written.length >= 65 &&
			written.every(
				(data) =>
					data.sampleRate === 48000 &&
					data.numberOfFrames === 960 &&
					data.numberOfChannels === 1,
			) &&
			stalls <= 3 &&
			weak <= 1 + 4 * stalls &&
			jumps <= 1 + 2 * stalls,
		`${stalls} stalls, ${written.length} frames of ${[...new Set(written.map((d) => d.numberOfFrames))]}, ${weak} weak and ${jumps} broken of ${amplitudes.length} windows`,
	);
	ok(
		'on a steady time of its own',
		written
			.slice(1)
			.every((data, i) => data.timestamp - written[i].timestamp === 20000),
	);
	const stats = receiver.stats;
	ok(
		'and counts what it did',
		stats.frames === b.frames.length &&
			stats.played >= 65 &&
			stats.late <= 2 &&
			stats.dropped <= 2,
		JSON.stringify(stats),
	);
}
receiver.close();

// the same as G.722, which the stack counts at 16 kHz and writes at 8000
{
	const wideSender = new m.AudioSender(index, (frame, age) => {
		a.engine.input(
			a.id,
			records.IN_MEDIA_WRITE,
			records.encodeFrame(frame, age),
		);
		a.drain();
	});
	wideSender.configure(
		m
			.parsePayloads(negotiated.codecs ?? '')
			.filter((payload) => payload.name === 'G722'),
	);
	wideSender.setActive(true);
	const heard = [];
	const wideReceiver = new m.AudioReceiver();
	wideReceiver.setTrack(
		new WritableStream({
			write(data) {
				heard.push(data);
			},
		}),
	);
	const first = b.frames.length;
	b.onFrame = (frame) => {
		if (frame.media === remote) wideReceiver.frame(frame);
	};
	let wideSource = null;
	wideSender.setTrack(
		new ReadableStream({
			start(controller) {
				wideSource = controller;
			},
		}),
	);
	const start = performance.now();
	for (let n = 0; n < 150;) {
		while (n < 150 && n * 10 <= performance.now() - start)
			wideSource.enqueue(sound(n++));
		a.tick();
		b.tick();
		await sleep(2);
	}
	await sleep(150);
	wideSource.close();
	wideSender.close();
	wideReceiver.close();
	// (the last G.711 frames of the run before may still come in)
	const frames = b.frames
		.slice(first)
		.filter((frame) => frame.codec !== 'PCMU');
	const sounding = heard.filter((data) => data.data.some((value) => value));
	const samples = new Float32Array(
		sounding.reduce((sum, data) => sum + data.numberOfFrames, 0),
	);
	let at = 0;
	for (const data of sounding) {
		samples.set(data.data.subarray(0, data.numberOfFrames), at);
		at += data.numberOfFrames;
	}
	// the tone's strength, 5 ms at a time, past the first frames
	const w = (2 * Math.PI * 440) / 48000;
	const amplitudes = [];
	for (let i = 4800; i + 240 <= samples.length - 4800; i += 240) {
		let I = 0;
		let Q = 0;
		for (let k = 0; k < 240; k++) {
			I += samples[i + k] * Math.cos(w * (i + k));
			Q += samples[i + k] * Math.sin(w * (i + k));
		}
		amplitudes.push(Math.hypot(I, Q) / 120);
	}
	const strong = amplitudes.filter((value) => Math.abs(value - 0.5) < 0.05);
	ok(
		'G.722 frames come out on the other side at 16 kHz on the stack count, and the receiver writes the tone',
		frames.length >= 70 &&
			frames.every(
				(frame) =>
					frame.codec === 'G722' &&
					frame.pt === 9 &&
					frame.payload.length === 160,
			) &&
			frames
				.slice(1)
				.every((frame, i) => frame.time - frames[i].time === 320n) &&
			heard.every(
				(data) => data.sampleRate === 48000 && data.numberOfFrames === 960,
			) &&
			amplitudes.length > 100 &&
			strong.length >= amplitudes.length - 8,
		`${frames.length} frames, ${strong.length} of ${amplitudes.length} windows at the tone's strength`,
	);
}
// DTMF through the stacks: the events of a tone arrive on their own
// payload as the sender wrote them, and the receiver plays no sound of them
{
	const toneSender = new m.AudioSender(index, (frame, age) => {
		a.engine.input(
			a.id,
			records.IN_MEDIA_WRITE,
			records.encodeFrame(frame, age),
		);
		a.drain();
	});
	toneSender.configure(
		m
			.parsePayloads(negotiated.codecs ?? '')
			.filter((payload) => ['PCMU', 'telephone-event'].includes(payload.name)),
	);
	toneSender.setActive(true);
	toneSender.tone('7', 100);
	const toneReceiver = new m.AudioReceiver();
	const heard = [];
	toneReceiver.setTrack(
		new WritableStream({
			write(data) {
				heard.push(data);
			},
		}),
	);
	const first = b.frames.length;
	// from the first event on: the last frames of the runs before, on
	// another clock, would have the receiver hold far more than it needs
	let begun = false;
	b.onFrame = (frame) => {
		begun ||= frame.codec === 'telephone-event';
		if (frame.media === remote && begun) toneReceiver.frame(frame);
	};
	let toneSource = null;
	toneSender.setTrack(
		new ReadableStream({
			start(controller) {
				toneSource = controller;
			},
		}),
	);
	const start = performance.now();
	for (let n = 0; performance.now() - start < 1600;) {
		while (n < 120 && n * 10 <= performance.now() - start)
			toneSource.enqueue(sound(n++));
		a.tick();
		b.tick();
		await sleep(2);
	}
	toneSource.close();
	toneSender.close();
	toneReceiver.close();
	const frames = b.frames.slice(first);
	frames.splice(
		0,
		frames.findIndex((frame) => frame.codec === 'telephone-event'),
	);
	const events = frames.filter((frame) => frame.codec === 'telephone-event');
	const voice = frames.filter((frame) => frame.codec === 'PCMU');
	ok(
		'a tone crosses the stacks as its RFC 4733 events, on telephone-event/8000, and the sound after it as PCMU',
		events.length === 7 &&
			events.every(
				(frame) => frame.pt === 126 && frame.time === events[0].time,
			) &&
			events.map((frame) => [...frame.payload].join(' ')).join() ===
				[
					'7 10 0 160',
					'7 10 1 64',
					'7 10 1 224',
					'7 10 2 128',
					'7 138 3 32',
					'7 138 3 32',
					'7 138 3 32',
				].join() &&
			(events[0].flags & records.FLAG_TALKSPURT) !== 0 &&
			voice.length >= 20 &&
			Number(voice[0].time - events[0].time) === 6 * 160,
		JSON.stringify(
			frames.map((frame) => [
				frame.codec,
				Number(frame.time),
				[...frame.payload.slice(0, 4)],
			]),
		).slice(0, 600),
	);
	// what the receiver wrote: the event's two tones (852 and 1209 Hz for
	// '7') where the sound of its time would be, at Chrome's levels
	const all = new Float32Array(
		heard.reduce((sum, data) => sum + data.numberOfFrames, 0),
	);
	let at = 0;
	for (const data of heard) {
		all.set(data.data.subarray(0, data.numberOfFrames), at);
		at += data.numberOfFrames;
	}
	const amplitude = (from, hz) => {
		let I = 0;
		let Q = 0;
		for (let k = 0; k < 960; k++) {
			I += all[from + k] * Math.cos((2 * Math.PI * hz * k) / 48000);
			Q += all[from + k] * Math.sin((2 * Math.PI * hz * k) / 48000);
		}
		return Math.hypot(I, Q) / 480;
	};
	// 20 ms windows every 5 ms: a tone of 100 ms fills 17 of them
	const windows = [];
	for (let from = 0; from + 960 <= all.length; from += 240)
		windows.push([amplitude(from, 852), amplitude(from, 1209)]);
	const toned = windows.filter(
		([low, high]) =>
			Math.abs(20 * Math.log10(low) + 19.2) < 1 &&
			Math.abs(20 * Math.log10(high) + 16.2) < 1,
	);
	ok(
		"the receiver plays the event as its two tones, at Chrome's levels, for its 100 ms",
		toneReceiver.stats.frames === frames.length &&
			heard.every((data) => data.sampleRate === 48000) &&
			toned.length >= 14 &&
			toned.length <= 20,
		`${toned.length} windows of the tones; ${JSON.stringify(toneReceiver.stats)}`,
	);
}
// comfort noise after G.711, as Chrome's sender sends it in a silence
{
	const quiet = [];
	const noiseReceiver = new m.AudioReceiver();
	noiseReceiver.setTrack(
		new WritableStream({
			write(data) {
				quiet.push(data);
			},
		}),
	);
	const start = performance.now();
	const pcm = new Uint8Array(160).fill(0xff);
	for (let n = 0; n < 50; n++) {
		const now = start + n * 20;
		while (performance.now() < now) await sleep(2);
		// one second of silence, then a noise packet each 100 ms
		const frame =
			n < 10
				? { codec: 'PCMU', pt: 0, time: BigInt(n * 160), payload: pcm }
				: (n - 10) % 5 === 0
					? {
							codec: 'CN',
							pt: 13,
							time: BigInt(n * 160),
							payload: Uint8Array.of(40),
						}
					: null;
		if (frame) noiseReceiver.frame(frame);
	}
	await sleep(100);
	noiseReceiver.close();
	const tail = quiet.slice(-20);
	let squares = 0;
	let count = 0;
	for (const data of tail)
		for (const value of data.data) {
			squares += value * value;
			count++;
		}
	const level = 10 * Math.log10(squares / count);
	ok(
		"after speech the receiver plays a comfort noise packet's noise, at Chrome's level, until speech comes again",
		tail.length === 20 && Math.abs(level + 42.6) < 2,
		`${level.toFixed(2)} dB over ${tail.length} frames of ${quiet.length}`,
	);
}
a.engine.destroy(a.id);
b.engine.destroy(b.id);

// --- the certificate's DER ---

// A serial is 64 random bits, as Chrome's. Written with a zero byte first
// where none belongs (the first random byte zero and the next under 0x80,
// one certificate in 256), the far end's parser refused the certificate:
// the handshake stopped there and the connection stayed "connecting"
const random = crypto.getRandomValues.bind(crypto);
async function withSerial(first) {
	crypto.getRandomValues = (array) => {
		random(array);
		if (array.length === 8) array.set(first);
		return array;
	};
	try {
		return await m.generateCertificate();
	} finally {
		crypto.getRandomValues = random;
	}
}
const serials = [];
for (const first of [
	[0x00, 0x01],
	[0x00, 0x00, 0x00],
	[0x00, 0x80],
	[0x80, 0x01],
	[0x7f],
]) {
	const made = await withSerial(first);
	let read;
	try {
		const parsed = new X509Certificate(made.certificate);
		read = parsed.verify(parsed.publicKey) ? parsed.serialNumber : 'unsigned';
	} catch (error) {
		read = `refused: ${error.message}`;
	}
	serials.push([first.map((byte) => byte.toString(16)).join(), read, made]);
}
ok(
	'a certificate parses and verifies whatever its serial begins with, the serial in the fewest bytes DER allows',
	serials.every(
		([first, read]) =>
			/^[0-9A-F]+$/.test(read) &&
			read.length <= 18 &&
			// a serial that begins with a set bit has a sign byte (not shown)
			(first.startsWith('80') ? read.startsWith('80') : true),
	),
	JSON.stringify(serials.map(([first, read]) => [first, read])),
);
{
	// two stacks, each with a certificate whose serial begins with a zero byte
	const own = serials[0][2];
	const c = new Peer(await stack(), '198.51.100.3:5000', own);
	const d = new Peer(await stack(), '198.51.100.4:5000', serials[1][2]);
	c.other = d;
	d.other = c;
	c.control({
		op: 'media',
		kind: 'audio',
		dir: 'sendrecv',
		stream: 's',
		track: 't',
	});
	const offered = c.control({ op: 'offer' });
	const answered = d.control({
		op: 'remote_offer',
		sdp: offered.sdp,
		dir0: 'sendrecv',
	});
	c.control({ op: 'answer', sdp: answered.sdp });
	c.control({
		op: 'remote_candidate',
		candidate: `candidate:1 1 udp 2113937151 198.51.100.4 5000 typ host`,
	});
	d.control({
		op: 'remote_candidate',
		candidate: `candidate:1 1 udp 2113937151 198.51.100.3 5000 typ host`,
	});
	for (let i = 0; i < 1500 && !(connected(c) && connected(d)); i++) {
		c.tick();
		d.tick();
		await sleep(2);
	}
	ok(
		'two stacks whose serials begin with a zero byte connect',
		connected(c) && connected(d),
		JSON.stringify([...c.events, ...d.events].filter((e) => e.ev === 'error')),
	);
	c.engine.destroy(c.id);
	d.engine.destroy(d.id);
}

await done();
