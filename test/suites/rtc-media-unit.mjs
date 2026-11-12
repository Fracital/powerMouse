// The worker's media modules (src/rtc, docs/webrtc-over-wisp.md section
// 16), checked in node: the playout buffer on a clock of the test's own,
// G.711 against what Chrome's decoder gives, the audio level, the stack's
// formats read from the offers of two Chrome versions, the sender's times
// (an encoder that behaves as Chrome's was measured to), and sound sent
// through two stacks back to back (assets/rtc.wasm) as G.711, which needs
// no WebCodecs. The browser's part (Opus, tracks) is the webrtc-media
// suite's. Skips when esbuild is not installed, as rewriter-unit does.
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
export { AudioSender, AudioReceiver, levelOf } from ${from('audio.ts')};
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
		`Chrome ${version}'s offer gives its audio payloads in its order, less G.722`,
		codecs.slice(0, 7).join('|') ===
			'111,opus,48000,2,minptime=10;useinbandfec=1|63,red,48000,2,111/111|0,PCMU,8000,,|8,PCMA,8000,,|13,CN,8000,,|110,telephone-event,48000,,|126,telephone-event,8000,,',
		codecs.slice(0, 7).join('|'),
	);
	ok(
		`and its video payloads, each with the one that repeats it (${version})`,
		codecs[7] === '96,VP8,90000,,' &&
			codecs[8] === '97,rtx,90000,,apt=96' &&
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

/** what a sender makes of `inputs`, configured with `payloads` */
async function send(inputs, payloads) {
	const frames = [];
	const sender = new m.AudioSender(3, (frame, age) =>
		frames.push({ ...frame, age }),
	);
	sender.configure(payloads);
	sender.setActive(true);
	sender.setTrack(
		new ReadableStream({
			start(controller) {
				for (const input of inputs) controller.enqueue(input);
				controller.close();
			},
		}),
	);
	await sleep(50);
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
	// the track stops for a second after half a second
	const inputs = Array.from({ length: 100 }, (_, i) =>
		sound(i, { at: 7777 + i * 10000 + (i >= 50 ? 1000000 : 0) }),
	);
	const frames = await send(inputs, opus());
	const jump = steps(frames).findIndex((step) => step !== 960);
	ok(
		'a break in the track is a break in the times, and a new talkspurt',
		frames.length === 50 &&
			jump === 24 &&
			steps(frames)[jump] === 960 + 48000 &&
			talkspurts(frames).join() === '0,25',
		`${frames.length} frames, step ${steps(frames)[jump]} after frame ${jump}, talkspurts ${talkspurts(frames)}`,
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
	const none = await send(
		Array.from({ length: 20 }, (_, i) => sound(i)),
		m.parsePayloads('9,G722,16000,,|13,CN,8000,,'),
	);
	ok('and nothing where no payload can be encoded here', none.length === 0);
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
	constructor(engine, address) {
		this.engine = engine;
		this.address = address;
		this.events = [];
		this.frames = [];
		this.onFrame = null;
		this.id = engine.create({
			local: address,
			cert: m.hex(certificate.certificate),
			key: m.hex(certificate.privateKey),
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
		['111', '63', '0', '8', '13', '110', '126'].sort().join() &&
		offer.sdp.includes('a=rtpmap:111 opus/48000/2') &&
		!offer.sdp.includes('G722'),
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
a.engine.destroy(a.id);
b.engine.destroy(b.id);

await done();
