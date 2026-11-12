// A proxied page's RTCPeerConnection carries sound
// (docs/webrtc-over-wisp.md, section 16): transceivers, senders, receivers
// and the track event as a page reads them, the descriptions line for line,
// and Opus both ways on wisp streams. test/pages/webrtc-media.html is one
// end, through the proxy in both demo modes; the far end is the browser's
// own stack, the same page loaded natively in a second browser. Every
// scenario runs first between two native connections (the control): what
// the proxied page reads at each step (its transceivers, its events in
// their order, the descriptions it makes) is compared with what the
// browser's own connection read at the same step, and what it hears with
// what the control heard.
// The only sound is tones the pages write sample for sample and the
// browsers' fake capture device (the far browser's origin takes it for
// media access, so its host candidates are addresses the wisp server can
// reach): no real device is opened. Chrome resolves no name but localhost,
// so nothing here reaches a network. What the far end sees as the page's
// address must be a socket of the demo's wisp server and never one of the
// browser's (test/sockets.mjs), and the proxied page's own candidates are
// names and never one of this machine's addresses.
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

const target = `${FIXTURE}pages/webrtc-media.html`;
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
/** a connection of the page in `frame`: steps are window.__media's */
function end(page, who = page.label) {
	const name = `c${names++}`;
	return {
		label: page.label,
		call: (step, ...args) =>
			page
				.frame()
				.evaluate(
					([step, name, args]) => window.__media[step](name, ...args),
					[step, name, args],
				)
				.catch((error) => {
					throw new Error(
						`${who}, ${step}(${args.join()}): ${String(error.message).split('\n')[0]}`,
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
				?.evaluate(() => window.__mediaReady)
				.catch(() => false)
		)
			break;
		await sleep(250);
	}
	return { label, page: opened, frame };
}

// --- what compares between two stacks ---

/**
 * A description's lines with what differs from one connection to the next
 * written as its order of appearance (ids, sources), candidates left out.
 * G.722 is the one payload of Chrome's the worker cannot carry yet
 * (docs/webrtc-over-wisp.md, section 16): its lines are left out of both.
 */
function shape(sdp) {
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
				!/^a=(candidate:|end-of-candidates|rtpmap:9 |rtcp-fb:9 )/.test(line),
		)
		.map((line) =>
			line
				.replace(/^(o=- )\d+ (\d+) IN IP4 \S+/, '$1X $2 IN IP4 X')
				.replace(/^(m=\w+ )(\d+)/, (all, m, port) => m + (+port ? 'X' : '0'))
				.replace(/^(m=audio \S+ \S+(?: \d+)*?) 9(?= |$)/, '$1')
				.replace(/^(c=IN IP4 )\S+/, '$1X')
				.replace(/^(a=rtcp:)\d+ IN IP4 \S+/, '$1X IN IP4 X')
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
/** a tone as it has to arrive: there, loud, itself, and unbroken */
const sounds = (heard, control) =>
	heard.seconds > 1 &&
	heard.level > 0.25 &&
	heard.purity > Math.min(0.9, control.purity - 0.05) &&
	heard.jumps <= control.jumps + 2 &&
	heard.dips <= control.dips + 2;

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

// --- scenarios: `own` is the end under test, `far` the browser's own stack ---

/** one description from `from` to `to`, and what `from` made */
async function describe(from, to, type) {
	const made = await from.call('local', type);
	await to.call('remote', type, made.sdp);
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
 * The page offers a tone in a stream and a data channel; the far end adds
 * its own tone to the transceiver the offer made and answers; the far end
 * then takes its track away with an offer of its own; the page stops the
 * transceiver.
 */
async function offering(own, far) {
	const record = { steps: [], heard: {}, failure: null };
	try {
		await own.call('open');
		await far.call('open');
		await own.call('channel', 'beside');
		record.sent = await own.call('tone', 440);
		await read(record, 'added', own);
		const offer = await describe(own, far, 'offer');
		await read(record, 'offered', own, { sdp: offer });
		await far.call('tone', 660);
		const answer = await describe(far, own, 'answer');
		record.farAnswer = answer;
		// a track is no longer muted once its sound arrives, which is
		// sooner or later after the answer: the page is read when it has
		await own.call('connected');
		await far.call('connected');
		await own.call('muted', 0, false);
		await far.call('muted', 0, false);
		await read(record, 'answered', own);
		[record.heard.own, record.heard.far] = await Promise.all([
			own.call('hear', 0, 660),
			far.call('hear', 0, 440),
		]);
		record.plays = await own.call('plays', 0);
		record.seen = await far.call('far');
		// who holds that socket, asked while the call is up: the wisp
		// server closes a stream's socket when the stream ends
		record.owner = record.seen?.remote
			? await sockets.owner(record.seen.remote.port)
			: 'no pair';
		record.read = await own.call('own');

		// the far end's own offer: its track taken away
		await far.call('remove', 0);
		const reoffer = await describe(far, own, 'offer');
		record.farOffer = reoffer;
		await read(record, 'offered a removal', own);
		const reanswer = await describe(own, far, 'answer');
		await read(record, 'answered a removal', own, { sdp: reanswer });
		record.heard.after = await far.call('hear', 0, 440, 1500);

		// the page's sender paused and resumed, and its track replaced
		await own.call('active', 0, false);
		await sleep(300);
		record.heard.paused = await far.call('hear', 0, 440, 1000);
		await own.call('active', 0, true);
		await own.call('replace', 0, 880);
		await sleep(300);
		record.heard.replaced = await far.call('hear', 0, 880, 1500);

		await own.call('stop', 0);
		await read(record, 'stopped', own);
		const last = await describe(own, far, 'offer');
		await read(record, 'offered a stop', own, { sdp: last });
		await describe(far, own, 'answer');
		await sleep(100);
		await read(record, 'answered a stop', own);
		record.farView = await far.call('view');
	} catch (error) {
		record.failure = String(error).slice(0, 400);
	}
	record.closed = await own.call('close').catch(String);
	await far.call('close').catch(() => {});
	return record;
}

/**
 * The far end offers a tone in a stream; the page gets the track, adds a
 * tone of its own to that transceiver and answers; then the page offers a
 * second transceiver that only receives.
 */
async function answering(own, far) {
	const record = { steps: [], heard: {}, failure: null };
	try {
		await own.call('open');
		await far.call('open');
		await far.call('tone', 660);
		const offer = await far.call('local', 'offer');
		await own.call('remote', 'offer', offer.sdp);
		await read(record, 'given an offer', own);
		record.sent = await own.call('tone', 440);
		await read(record, 'added', own);
		const answer = await describe(own, far, 'answer');
		await own.call('connected');
		await far.call('connected');
		await own.call('muted', 0, false);
		await far.call('muted', 0, false);
		await read(record, 'answered', own, { sdp: answer });
		[record.heard.own, record.heard.far] = await Promise.all([
			own.call('hear', 0, 660),
			far.call('hear', 0, 440),
		]);
		record.seen = await far.call('far');
		// who holds that socket, asked while the call is up: the wisp
		// server closes a stream's socket when the stream ends
		record.owner = record.seen?.remote
			? await sockets.owner(record.seen.remote.port)
			: 'no pair';
		record.read = await own.call('own');

		// the answerer's own offer: one more transceiver, and the first one
		// no longer sending
		await own.call('receive', 'audio');
		await own.call('direction', 0, 'recvonly');
		await read(record, 'changed', own);
		const reoffer = await describe(own, far, 'offer');
		await read(record, 'offered', own, { sdp: reoffer });
		await describe(far, own, 'answer');
		await read(record, 'settled', own);
		record.heard.still = await own.call('hear', 0, 660, 1500);
		record.farView = await far.call('view');
	} catch (error) {
		record.failure = String(error).slice(0, 400);
	}
	record.closed = await own.call('close').catch(String);
	await far.call('close').catch(() => {});
	return record;
}

/**
 * The page offers its tone and the far end answers with its own, listing
 * G.722 first: each end sends the first codec of the other's description,
 * so the page sends G.722 (the codec written by hand in the worker,
 * src/rtc/g722.ts) to Chrome's decoder, and Chrome sends Opus.
 */
async function wideband(own, far) {
	const record = { heard: {}, codecs: null, failure: null };
	try {
		await own.call('open');
		await far.call('open');
		await own.call('tone', 440);
		await describe(own, far, 'offer');
		await far.call('tone', 660);
		await far.call('prefer', 0, 'audio/G722');
		await describe(far, own, 'answer');
		await own.call('connected');
		await far.call('connected');
		await own.call('muted', 0, false);
		await far.call('muted', 0, false);
		[record.heard.own, record.heard.far] = await Promise.all([
			own.call('hear', 0, 660),
			far.call('hear', 0, 440),
		]);
		record.codecs = await far.call('codecs');
		record.seen = await far.call('far');
		record.owner = record.seen?.remote
			? await sockets.owner(record.seen.remote.port)
			: 'no pair';
	} catch (error) {
		record.failure = String(error).slice(0, 400);
	}
	await own.call('close').catch(() => {});
	await far.call('close').catch(() => {});
	return record;
}
const g722 = (record) =>
	!record.failure &&
	record.codecs?.['inbound-rtp'] === 'audio/G722' &&
	record.codecs?.['outbound-rtp'] === 'audio/opus' &&
	record.heard.own?.level > 0.25 &&
	record.heard.far?.level > 0.25 &&
	Math.abs(record.heard.own.pitch - 660) < 20 &&
	Math.abs(record.heard.far.pitch - 440) < 20;

// --- pages ---

const browser = await launch(FAKE);
const far = await launch(FAKE);
const native = await open(far, 'natively', null);
const control = await open(far, 'natively', null);
const pages = [
	await open(browser, 'same-origin', PROXY),
	await open(browser, 'isolated', HOST),
];
// the far origin has media access from here on
const device = await native.frame().evaluate(() => window.__media.capture());
ok(
	'the far browser captures from its fake device, never a real one',
	/^Fake /.test(device.label),
	JSON.stringify(device),
);

const shapes = await control.frame().evaluate(() => window.__media.shapes());
const natively = {
	offering: await offering(end(control), end(native, 'the far end')),
	answering: await answering(end(control), end(native, 'the far end')),
};
natively.wideband = await wideband(end(control), end(native, 'the far end'));
for (const [name, record] of Object.entries(natively))
	ok(
		`natively: the ${name} scenario runs to its end, with sound both ways`,
		!record.failure &&
			record.heard.own?.level > 0.25 &&
			record.heard.far?.level > 0.25,
		record.failure ?? JSON.stringify(record.heard),
	);

ok(
	'natively: with G.722 first in the answer, the offerer sends G.722 and the answerer Opus',
	g722(natively.wideband),
	JSON.stringify([natively.wideband.codecs, natively.wideband.heard]),
);

for (const proxied of pages) {
	const { label } = proxied;

	// --- the objects themselves ---
	{
		let got = null;
		let failure = null;
		try {
			got = await proxied.frame().evaluate(() => window.__media.shapes());
		} catch (error) {
			failure = String(error).slice(0, 400);
		}
		for (const key of Object.keys(shapes)) {
			const want = JSON.stringify(shapes[key]);
			const have = JSON.stringify(got?.[key]);
			let detail = failure ?? '';
			if (!failure && want !== have) {
				const wanted = Object.entries(shapes[key]);
				const had = got[key] ?? {};
				detail = wanted
					.filter(
						([at, value]) => JSON.stringify(had[at]) !== JSON.stringify(value),
					)
					.slice(0, 4)
					.map(
						([at, value]) =>
							`${at}: ${JSON.stringify(had[at])} | natively ${JSON.stringify(value)}`,
					)
					.join('; ');
			}
			ok(
				`${label}: a transceiver, its sender and its receiver read as the browser's own (${key})`,
				!failure && want === have,
				detail,
			);
		}
	}

	for (const [name, scenario] of [
		['offering', offering],
		['answering', answering],
	]) {
		const want = natively[name];
		const got = await scenario(end(proxied), end(native, 'the far end'));
		ok(
			`${label}, ${name}: the scenario runs to its end`,
			!got.failure,
			got.failure ?? got.steps.map((step) => step.step).join(),
		);
		// each step: the transceivers, the events and the description
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
			`${label}, ${name}: at every step the page reads its transceivers and gets its events as it does natively`,
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
			`${label}, ${name}: each description the page makes reads line for line as Chrome's`,
			!lines.length,
			lines.slice(0, 3).join(' /// '),
		);
		const answers = [];
		for (const key of ['farAnswer', 'farOffer'])
			if (want[key]) {
				const differences = got[key]
					? differ(got[key], want[key])
					: ['none made'];
				if (differences.length)
					answers.push(`${key}: ${differences.join('; ')}`);
			}
		ok(
			`${label}, ${name}: Chrome answers the page's descriptions as it answers its own`,
			!answers.length &&
				plain(got.farView ?? null) === plain(want.farView ?? null),
			answers.join(' /// ') ||
				`${plain(got.farView ?? null)} | natively ${plain(want.farView ?? null)}`,
		);
		ok(
			`${label}, ${name}: the page hears the far end's tone and the far end the page's, unbroken`,
			!!got.heard.own &&
				!!got.heard.far &&
				sounds(got.heard.own, want.heard.own) &&
				sounds(got.heard.far, want.heard.far),
			JSON.stringify([
				got.heard.own,
				got.heard.far,
				want.heard.own,
				want.heard.far,
			]),
		);
		if (name === 'offering') {
			ok(
				`${label}, ${name}: an element plays the track`,
				got.plays > 1,
				`${got.plays} s of 1.5`,
			);
			ok(
				`${label}, ${name}: a sender paused sends nothing, resumed with another track it sends that one`,
				!!got.heard.after &&
					sounds(got.heard.after, want.heard.after) &&
					got.heard.paused?.level < 0.01 &&
					!!got.heard.replaced &&
					sounds(got.heard.replaced, want.heard.replaced),
				JSON.stringify([
					got.heard.after,
					got.heard.paused,
					got.heard.replaced,
					want.heard.paused,
					want.heard.replaced,
				]),
			);
		} else
			ok(
				`${label}, ${name}: the far end's tone goes on after the page stops sending`,
				!!got.heard.still && sounds(got.heard.still, want.heard.still),
				JSON.stringify([got.heard.still, want.heard.still]),
			);
		ok(
			`${label}, ${name}: closed, the page reads what it reads natively`,
			plain(got.closed) === plain(want.closed),
			`${plain(got.closed)} | natively ${plain(want.closed)}`,
		);
		const owner = got.owner ?? 'not asked';
		ok(
			`${label}, ${name}: the far end hears the page from a socket of the wisp server`,
			owner === 'server' && got.seen.packets > 50,
			JSON.stringify([owner, got.seen]),
		);
		const leaks = got.read ? ownAddresses(got.read) : ['nothing read'];
		ok(
			`${label}, ${name}: the page's own descriptions and candidates hold no address of this machine`,
			leaks.length === 0 && /typ host/.test(JSON.stringify(got.read)),
			JSON.stringify(leaks),
		);
	}
	// G.722 both ways with Chrome's own stack
	{
		const got = await wideband(end(proxied), end(native, 'the far end'));
		ok(
			`${label}: with G.722 first in the far end's answer, the page sends G.722, Chrome's decoder plays it, and each end hears the other's tone from a socket of the wisp server`,
			g722(got) && got.owner === 'server',
			JSON.stringify([got.failure, got.codecs, got.heard, got.owner]),
		);
	}
}

const errors = pages.flatMap((entry) => entry.page.errors);
await sockets.stop();
await far.close();
await done(browser, errors);
