// A proxied page's RTCPeerConnection carries pictures
// (docs/webrtc-over-wisp.md, section 16): a canvas the page draws goes to
// Chrome's own stack and Chrome's comes back, through the proxy in both
// demo modes. test/pages/webrtc-video.html is one end; the far end is the
// browser's own stack, the same page loaded natively in a second browser.
// Every scenario runs first between two native connections (the control):
// what the proxied page reads at each step is compared with what the
// browser's own connection read, what it sees with what the control saw,
// and what the far end counts of the page (keyframes, keyframe requests)
// with what it counted of the control.
// The only pictures are canvases the pages draw: no camera is opened.
// Chrome resolves no name but localhost, so nothing here reaches a
// network. What the far end sees as the page's address must be a socket of
// the demo's wisp server and never one of the browser's
// (test/sockets.mjs), and the proxied page's own candidates are names and
// never one of this machine's addresses.
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
import { watchSockets } from '../sockets.mjs';

const target = `${FIXTURE}pages/webrtc-video.html`;
const FAKE = [
	'--use-fake-device-for-media-stream',
	'--use-fake-ui-for-media-stream',
	'--autoplay-policy=no-user-gesture-required',
];
const sockets = await watchSockets();
const ADDRESSES = Object.values(networkInterfaces())
	.flat()
	.filter((entry) => !entry.internal)
	.map((entry) => entry.address.replace(/%.*$/, ''));

let names = 0;
/** a connection of the page in `frame`: steps are window.__video's */
function end(page, who = page.label) {
	const name = `c${names++}`;
	return {
		label: page.label,
		call: (step, ...args) =>
			page
				.frame()
				.evaluate(
					([step, name, args]) => window.__video[step](name, ...args),
					[step, name, args],
				)
				.catch((error) => {
					throw new Error(
						`${who}, ${step}(${args.map((arg) => JSON.stringify(arg)).join()}): ${String(error.message).split('\n')[0]}`,
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
				?.evaluate(() => window.__videoReady)
				.catch(() => false)
		)
			break;
		await sleep(250);
	}
	return { label, page: opened, frame };
}

/** the payloads of Chrome's video section the stack does not carry: video RED, its rtx, ULPFEC */
const UNCARRIED = ['118', '119', '120'];
/**
 * A description's lines with what differs from one connection to the next
 * written as its order of appearance (ids, sources), candidates left out.
 * Two things are known to differ (docs/webrtc-over-wisp.md, section 16):
 * the payloads the stack has no format for (UNCARRIED) are left out of
 * both, and so are the header extensions' numbers, which the stack takes
 * from an offer with sound before pictures.
 */
function shape(sdp) {
	const uncarried = new RegExp(
		`^a=(rtpmap|fmtp|rtcp-fb):(${UNCARRIED.join('|')}) `,
	);
	const seen = new Map();
	const nth = (kind, value) => {
		const key = `${kind}:${value}`;
		if (!seen.has(key)) seen.set(key, `${kind}${seen.size}`);
		return seen.get(key);
	};
	return sdp
		.split('\r\n')
		.filter(
			(line) =>
				line &&
				!/^a=(candidate:|end-of-candidates)/.test(line) &&
				!uncarried.test(line),
		)
		.map((line) =>
			line
				.replace(/^(m=video .*)$/, (all) =>
					all
						.split(' ')
						.filter((word, at) => at < 3 || !UNCARRIED.includes(word))
						.join(' '),
				)
				.replace(/^a=extmap:\d+ /, 'a=extmap:N ')
				.replace(/^(o=- )\d+ (\d+) IN IP4 \S+/, '$1X $2 IN IP4 X')
				.replace(/^(m=\w+ )(\d+)/, (all, m, port) => m + (+port ? 'X' : '0'))
				.replace(/^(c=IN IP4 )\S+/, '$1X')
				.replace(/^(a=ice-ufrag:|a=ice-pwd:|a=fingerprint:sha-256 ).*/, '$1X')
				.replace(
					/^(a=ssrc:)(\d+) cname:.*/,
					(all, a, id) => `${a}${nth('S', id)} cname:C`,
				)
				.replace(/^(a=ssrc:)(\d+) /, (all, a, id) => `${a}${nth('S', id)} `)
				.replace(
					/^(a=ssrc-group:FID) (\d+) (\d+)/,
					(all, a, one, two) => `${a} ${nth('S', one)} ${nth('S', two)}`,
				)
				.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, (id) =>
					nth('U', id),
				),
		);
}
/** the first lines two descriptions differ in */
function differ(got, want) {
	const a = shape(got);
	const b = shape(want);
	const out = [];
	for (let i = 0; i < Math.max(a.length, b.length) && out.length < 6; i++)
		if (a[i] !== b[i]) out.push(`${i}: ${a[i]} | natively ${b[i]}`);
	return out;
}
/** a view with its ids as their order of appearance */
function plain(view) {
	const seen = new Map();
	return JSON.stringify(view).replace(
		/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,
		(id) => {
			if (!seen.has(id)) seen.set(id, `U${seen.size}`);
			return seen.get(id);
		},
	);
}

/** what a proxied page read of its own end: no address of this machine, hosts only as names */
function ownAddresses(read) {
	const text = JSON.stringify(read);
	const found = ADDRESSES.filter((address) => text.includes(address));
	for (const [, address, type] of text.matchAll(
		/candidate:\S+ \d \w+ \d+ (\S+) \d+ typ (\w+)/g,
	))
		if (type === 'host' && !address.endsWith('.local'))
			found.push(`host ${address}`);
	return found;
}

// the pictures each end draws: small, so that encoding them costs little
const OWN = {
	width: 320,
	height: 180,
	left: [200, 40, 40],
	right: [40, 40, 200],
	fps: 15,
};
const FAR = {
	width: 160,
	height: 96,
	left: [40, 180, 40],
	right: [220, 220, 40],
	fps: 15,
};
/** what a receiver saw is the far end's picture: its size, and its colours within what a codec changes */
const shows = (saw, drawn) =>
	!!saw &&
	saw.frames >= 10 &&
	saw.sizes.length === 1 &&
	saw.sizes[0] === `${drawn.width}x${drawn.height}` &&
	['left', 'right'].every((side) =>
		saw.last?.[side]?.every(
			(value, i) => Math.abs(value - drawn[side][i]) <= 24,
		),
	);

// --- scenarios: `own` is the end under test, `far` the browser's own stack ---

/** one description from `from` to `to`, and what `from` made */
async function describe(from, to, type, options) {
	const made = await from.call('local', type);
	await to.call('remote', type, made.sdp, options);
	return made.created;
}
const read = async (record, step, own, extra = {}) => {
	record.steps.push({
		step,
		view: await own.call('view'),
		log: await own.call('log'),
		...extra,
	});
};

/**
 * The page offers its canvas; the far end answers with its own, whose
 * sender lets its first keyframe go (so the page's receiver has to ask
 * for one), with `codec` first; the far end's receiver then asks the page
 * for a keyframe.
 */
async function offering(own, far, codec) {
	const record = { steps: [], failure: null };
	try {
		await own.call('open');
		await far.call('open');
		await own.call('canvas', OWN);
		await read(record, 'added', own);
		const offer = await describe(own, far, 'offer', {
			listen: 0,
			answer: { ...FAR, dropFirst: true },
			prefer: `video/${codec}`,
		});
		await read(record, 'offered', own, { sdp: offer });
		const answer = await describe(far, own, 'answer');
		record.farAnswer = answer;
		await own.call('connected');
		await far.call('connected');
		await own.call('muted', 0, false);
		await far.call('muted', 0, false);
		await read(record, 'answered', own);
		[record.ownSaw, record.farSaw] = await Promise.all([
			own.call('see', 0),
			far.call('see', 0),
		]);
		record.plays = await own.call('plays', 0);
		// the far end asks the page for a keyframe, and decodes one more
		const before = await far.call('counts');
		record.asked = await far.call('askKeyframe', 0);
		await sleep(1500);
		const after = await far.call('counts');
		record.counts = after;
		record.keyframes =
			(after.inbound?.keyframes ?? 0) - (before.inbound?.keyframes ?? 0);
		record.transformed = await far.call('transformed');
		record.seen = await far.call('far');
		// who holds that socket, asked while the call is up: the wisp
		// server closes a stream's socket when the stream ends
		record.owner = record.seen?.remote
			? await sockets.owner(record.seen.remote.port)
			: 'no pair';
		record.read = await own.call('own');
	} catch (error) {
		record.failure = String(error).slice(0, 400);
	}
	record.closed = await own.call('close').catch(String);
	await far.call('close').catch(() => {});
	return record;
}

/** The far end offers its canvas; the page answers with its own. */
async function answering(own, far) {
	const record = { steps: [], failure: null };
	try {
		await own.call('open');
		await far.call('open');
		await far.call('canvas', FAR);
		const offer = await far.call('local', 'offer');
		await own.call('remote', 'offer', offer.sdp);
		await read(record, 'given an offer', own);
		await own.call('canvas', OWN);
		await read(record, 'added', own);
		const answer = await describe(own, far, 'answer');
		await own.call('connected');
		await far.call('connected');
		await own.call('muted', 0, false);
		await far.call('muted', 0, false);
		await read(record, 'answered', own, { sdp: answer });
		[record.ownSaw, record.farSaw] = await Promise.all([
			own.call('see', 0),
			far.call('see', 0),
		]);
		record.counts = await far.call('counts');
		record.seen = await far.call('far');
		record.owner = record.seen?.remote
			? await sockets.owner(record.seen.remote.port)
			: 'no pair';
		record.read = await own.call('own');
	} catch (error) {
		record.failure = String(error).slice(0, 400);
	}
	record.closed = await own.call('close').catch(String);
	await far.call('close').catch(() => {});
	return record;
}

/**
 * The page sends noise (as many bits as it is given), the far end only
 * receives; the page's sender is limited (setParameters) in bitrate,
 * size and frame rate, turned off and on again, and refused what Chrome
 * refuses
 */
async function limits(own, far) {
	const record = { reads: {}, rates: {}, failure: null };
	try {
		await own.call('open');
		await far.call('open');
		record.made = await own.call('made');
		await own.call('canvas', { ...OWN, noise: true });
		await describe(own, far, 'offer');
		await describe(far, own, 'answer');
		await own.call('connected');
		await far.call('connected');
		await far.call('muted', 0, false);
		// the estimate starts low and has risen within seconds, natively
		record.rates.start = await far.call('rate', 0, 1000);
		await sleep(2000);
		record.rates.free = await far.call('rate', 0);
		const step = async (name, changes, ms = 1500) => {
			record.reads[name] = await own.call('encode', 0, changes);
			await sleep(ms);
			record.rates[name] = await far.call('rate', 0, 1500);
		};
		await step('capped', { maxBitrate: 150000 });
		await own.call('noise', 0, false);
		await step('halved', { maxBitrate: null, scaleResolutionDownBy: 2 });
		await step('slow', { scaleResolutionDownBy: null, maxFramerate: 5 });
		await step('still', { maxFramerate: 0 });
		await step('off', { maxFramerate: null, active: false });
		await step('on', { active: true });
		for (const [name, changes] of Object.entries({
			small: { scaleResolutionDownBy: 0.5 },
			backwards: { maxFramerate: -1 },
			rid: { rid: 'x' },
			wrapped: { maxBitrate: -5 },
			fraction: { maxBitrate: 100000.7, maxFramerate: 7.5 },
			text: { scaleResolutionDownBy: '3' },
		}))
			record.reads[name] = await own.call('encode', 0, changes);
	} catch (error) {
		record.failure = String(error).slice(0, 400);
	}
	await own.call('close').catch(() => {});
	await far.call('close').catch(() => {});
	return record;
}

// --- pages ---

const browser = await launch(FAKE);
const far = await launch(FAKE);
const native = await open(far, 'natively', null);
const control = await open(far, 'natively', null);
const pages = [
	await open(browser, 'same-origin', PROXY),
	await open(browser, 'isolated', HOST),
];
// the far origin has media access from here on, so its host candidates
// are addresses the wisp server can reach
await native
	.frame()
	.evaluate(() =>
		navigator.mediaDevices
			.getUserMedia({ video: true })
			.then((stream) => stream.getTracks().forEach((track) => track.stop())),
	);

// each codec Chrome offers for video, where this browser has it natively
// (a runner's Chrome may lack one): its WebCodecs name for the check
const ALL = {
	VP8: 'vp8',
	VP9: 'vp09.00.10.08',
	H264: 'avc1.42001f',
	AV1: 'av01.0.05M.08',
};
const CODECS = [];
for (const [codec, name] of Object.entries(ALL)) {
	const has = await native
		.frame()
		.evaluate(
			([mime, name]) => window.__video.capable(null, mime, name),
			[`video/${codec}`, name],
		);
	ok(
		`natively: this browser sends and receives ${codec} (or the codec's cases are left out)`,
		true,
		String(has),
	);
	if (has) CODECS.push(codec);
}
const natively = { answering: await answering(end(control), end(native)) };
for (const codec of CODECS)
	natively[codec] = await offering(end(control), end(native), codec);
natively.limits = await limits(end(control), end(native));
ok(
	'natively: limited, the sender sends what it is let send',
	!natively.limits.failure &&
		natively.limits.rates.capped?.kbps <= 200 &&
		natively.limits.rates.halved?.width === OWN.width / 2 &&
		natively.limits.rates.still?.fps === 0 &&
		natively.limits.rates.off?.fps === 0 &&
		natively.limits.rates.on?.fps > 2,
	natively.limits.failure ?? JSON.stringify(natively.limits.rates),
);
for (const [name, record] of Object.entries(natively))
	if (name !== 'limits')
		ok(
			`natively: the ${name} scenario runs to its end, with pictures both ways`,
			!record.failure &&
				shows(record.ownSaw, FAR) &&
				shows(record.farSaw, OWN) &&
				(record.keyframes === undefined || record.keyframes === 1),
			record.failure ??
				JSON.stringify([record.ownSaw, record.farSaw, record.keyframes]),
		);

for (const proxied of pages) {
	const { label } = proxied;
	const runs = [['answering', answering, null]];
	for (const codec of CODECS) runs.push([codec, offering, codec]);
	for (const [name, scenario, codec] of runs) {
		const want = natively[name];
		const got = await scenario(end(proxied), end(native, 'the far end'), codec);
		const title = codec ? `${label}, ${codec} offered` : `${label}, answering`;
		ok(
			`${title}: the scenario runs to its end`,
			!got.failure,
			got.failure ?? got.steps.map((step) => step.step).join(),
		);
		const off = [];
		for (let i = 0; i < want.steps.length; i++) {
			const wanted = want.steps[i];
			const had = got.steps[i];
			if (!had) {
				off.push(`${wanted.step}: not reached`);
				continue;
			}
			if (plain(had.view) !== plain(wanted.view))
				off.push(
					`${wanted.step}: reads ${plain(had.view)} | natively ${plain(wanted.view)}`,
				);
			if (had.log.join() !== wanted.log.join())
				off.push(
					`${wanted.step}: events ${had.log.join(' ')} | natively ${wanted.log.join(' ')}`,
				);
		}
		ok(
			`${title}: at every step the page reads its transceivers and gets its events as it does natively`,
			!off.length,
			off.slice(0, 4).join('; '),
		);
		const lines = [];
		for (let i = 0; i < want.steps.length; i++) {
			const wanted = want.steps[i];
			const had = got.steps[i];
			if (!wanted.sdp) continue;
			const differences = had?.sdp
				? differ(had.sdp, wanted.sdp)
				: ['none made'];
			if (differences.length)
				lines.push(`${wanted.step}: ${differences.join('; ')}`);
		}
		ok(
			`${title}: each description the page makes reads line for line as Chrome's`,
			!lines.length,
			lines.slice(0, 3).join(' /// '),
		);
		if (want.farAnswer) {
			const differences = got.farAnswer
				? differ(got.farAnswer, want.farAnswer)
				: ['none made'];
			ok(
				`${title}: Chrome answers the page's offer as it answers its own`,
				!differences.length,
				differences.join('; '),
			);
		}
		// the colours as natively, within a little: what a codec changes
		const alike = (saw, natively) =>
			saw?.last?.format === natively?.last?.format &&
			saw.last.space === natively.last.space &&
			['left', 'right'].every((side) =>
				saw.last[side].every(
					(value, i) => Math.abs(value - natively.last[side][i]) <= 6,
				),
			);
		ok(
			`${title}: the page sees the far end's picture at its size and colours (its color space as natively), and Chrome's decoder sees the page's`,
			shows(got.ownSaw, FAR) &&
				shows(got.farSaw, OWN) &&
				alike(got.ownSaw, want.ownSaw) &&
				alike(got.farSaw, want.farSaw),
			JSON.stringify([got.ownSaw, got.farSaw, want.ownSaw, want.farSaw]),
		);
		ok(
			`${title}: Chrome receives the page's pictures with ${codec ?? 'the codec it offered first'}, at the page's size`,
			!!got.counts?.inbound &&
				got.counts.inbound.codec === want.counts?.inbound?.codec &&
				got.counts.inbound.width === OWN.width &&
				got.counts.inbound.height === OWN.height,
			JSON.stringify([got.counts, want.counts]),
		);
		if (codec) {
			ok(
				`${title}: an element plays the far end's track at its size`,
				got.plays?.seconds >= 0.5 &&
					got.plays.width === FAR.width &&
					got.plays.height === FAR.height,
				JSON.stringify([got.plays, want.plays]),
			);
			ok(
				`${title}: the far end's first keyframe lost, the page asks for one (a PLI) and Chrome's sender makes it`,
				got.counts?.outbound?.pli >= 1 &&
					got.counts.outbound.keyframes >= 2 &&
					want.counts?.outbound?.pli >= 1,
				JSON.stringify([
					got.counts?.outbound,
					want.counts?.outbound,
					got.transformed,
					want.transformed,
				]),
			);
			ok(
				`${title}: Chrome's receiver asks the page for a keyframe and decodes one more, as natively`,
				got.asked === 'asked' && got.keyframes === want.keyframes,
				JSON.stringify([got.asked, got.keyframes, want.keyframes]),
			);
		}
		ok(
			`${title}: closed, the page reads what it reads natively`,
			plain(got.closed) === plain(want.closed),
			`${plain(got.closed)} | natively ${plain(want.closed)}`,
		);
		const owner = got.owner ?? 'not asked';
		ok(
			`${title}: the far end hears the page from a socket of the wisp server`,
			owner === 'server' && got.seen?.packets > 20,
			JSON.stringify([owner, got.seen]),
		);
		const leaks = got.read ? ownAddresses(got.read) : ['nothing read'];
		ok(
			`${title}: the page's own descriptions and candidates hold no address of this machine`,
			leaks.length === 0 && /typ host/.test(JSON.stringify(got.read)),
			JSON.stringify(leaks),
		);
	}
}

for (const proxied of pages) {
	const { label } = proxied;
	const want = natively.limits;
	const got = await limits(end(proxied), end(native, 'the far end'));
	ok(
		`${label}, limited: the scenario runs to its end`,
		!got.failure,
		got.failure ?? '',
	);
	const reads = [];
	for (const [name, read] of Object.entries({ ...want.made, ...want.reads }))
		if (
			JSON.stringify((got.made?.[name] ?? got.reads[name]) || null) !==
			JSON.stringify(read)
		)
			reads.push(
				`${name}: ${JSON.stringify(got.made?.[name] ?? got.reads[name])} | natively ${JSON.stringify(read)}`,
			);
	ok(
		`${label}, limited: the encodings a video sender is made with and set to read as natively, and what Chrome refuses is refused alike`,
		!reads.length,
		reads.slice(0, 4).join('; '),
	);
	const rates = got.rates;
	const detail = JSON.stringify([rates, want.rates]);
	ok(
		`${label}, limited: the encoder follows the estimate up, as Chrome's sender does (within half and one and a half times its rate)`,
		rates.free?.kbps >= want.rates.free?.kbps * 0.5 &&
			rates.free?.kbps <= want.rates.free?.kbps * 1.5,
		detail,
	);
	ok(
		`${label}, limited: at most 150 kbit/s it sends no more (as natively)`,
		rates.capped?.kbps <= 200 && rates.capped.kbps > 20,
		detail,
	);
	ok(
		`${label}, limited: scaled down by 2, Chrome receives the picture at half its size`,
		rates.halved?.width === OWN.width / 2 &&
			rates.halved.height === OWN.height / 2 &&
			rates.halved.fps > 5,
		detail,
	);
	ok(
		`${label}, limited: at most 5 pictures a second, it sends no more`,
		rates.slow?.fps <= 6 && rates.slow.fps >= 2 && want.rates.slow?.fps <= 6,
		detail,
	);
	ok(
		`${label}, limited: a frame rate of 0 or an encoding turned off sends nothing, turned on again it sends`,
		rates.still?.fps === 0 && rates.off?.fps === 0 && rates.on?.fps > 2,
		detail,
	);
}

const errors = pages.flatMap((entry) => entry.page.errors);
await sockets.stop();
await far.close();
await done(browser, errors);
