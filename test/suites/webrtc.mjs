// WebRTC sends its packets itself, outside the proxy (docs/webrtc.md). A
// proxied page must never learn this machine's addresses and never make the
// browser send a packet to a STUN/TURN server or a remote candidate it chose,
// while RTCPeerConnection stays the browser's own, as on a network that drops
// UDP. test/pages/webrtc.html runs the probes natively (the control: the
// fixture STUN server answers and hands the page a srflx candidate, a remote
// candidate gets connectivity checks) and through the proxy in both demo
// modes, in a browser that shows host candidates as mDNS names and in one
// that shows their real addresses (the proxy origin granted media access):
// - the UDP fixtures (a STUN server that answers, a TURN server and a remote
//   candidate that only listen) receive nothing, whatever the page does: a
//   pool, setConfiguration, relay only, every realm it can reach;
// - nothing the page reads (candidate events, descriptions, stats, the ICE
//   transport, icecandidateerror) holds one of this machine's addresses;
// - the configuration, the icecandidateerror for an unreachable server, the
//   errors of bad calls and the API surface read as they do natively;
// - a data channel still opens between two connections of one page and
//   between two proxied pages in frames of their own.
import dgram from 'node:dgram';
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

const target = `${FIXTURE}pages/webrtc.html`;
const child = `${FIXTURE}pages/webrtc-child.html`;
// mDNS host names resolve (the browser's own, between two connections here);
// every other name still fails, as in every suite
const RESOLVER =
	'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1, EXCLUDE *.local';

/** a UDP fixture: `answers` makes it a STUN server that answers Binding Requests */
function udpServer(answers = false) {
	const socket = dgram.createSocket('udp4');
	const packets = [];
	socket.on('message', (message, from) => {
		packets.push(`${from.address}:${from.port}`);
		if (!answers || message.length < 20 || message.readUInt16BE(0) !== 0x0001)
			return;
		const attribute = Buffer.alloc(12);
		attribute.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
		attribute.writeUInt16BE(8, 2);
		attribute.writeUInt8(1, 5);
		attribute.writeUInt16BE(from.port ^ 0x2112, 6);
		const cookie = [0x21, 0x12, 0xa4, 0x42];
		from.address
			.split('.')
			.forEach((octet, i) =>
				attribute.writeUInt8(Number(octet) ^ cookie[i], 8 + i),
			);
		const head = Buffer.alloc(20);
		head.writeUInt16BE(0x0101, 0);
		head.writeUInt16BE(attribute.length, 2);
		head.writeUInt32BE(0x2112a442, 4);
		message.copy(head, 8, 8, 20);
		socket.send(Buffer.concat([head, attribute]), from.port, from.address);
	});
	return new Promise((resolve) =>
		socket.bind(0, '0.0.0.0', () =>
			resolve({
				port: socket.address().port,
				packets,
				close: () => socket.close(),
			}),
		),
	);
}

// this machine's own addresses (loopback is in every SDP's origin line, and
// the fixture servers sit on it: it is checked as a candidate address only)
const ADDRESSES = Object.values(networkInterfaces())
	.flat()
	.filter((entry) => !entry.internal)
	.map((entry) => entry.address.replace(/%.*$/, ''));
const leaked = (value, { loopback = true } = {}) => {
	const text = JSON.stringify(value);
	const found = ADDRESSES.filter((address) => text.includes(address));
	// a partly redacted one, as the browser writes it in icecandidateerror
	for (const address of ADDRESSES)
		if (address.includes('.')) {
			const prefix = `${address.split('.').slice(0, 3).join('.')}.x`;
			if (text.includes(prefix)) found.push(prefix);
		}
	// a candidate on loopback, or the address STomp sends the browser to
	if (loopback && / 127\.0\.0\.1 \d+ typ |"address":"127\.0\.0\.1"/.test(text))
		found.push('127.0.0.1 candidate');
	if (text.includes('255.255.255.255')) found.push('255.255.255.255');
	return found;
};
/**
 * A native measurement showing the leak a proxied check guards against. How
 * the browser leaks depends on the machine (its interfaces, media access,
 * how it paces connectivity checks under load), so a native run that does
 * not show it here is reported, not failed: the proxied checks stay strict
 * either way, and what they compare with is this run's native reading.
 */
function precondition(name, holds, detail) {
	if (holds) ok(name, true, detail);
	else console.log(`note: ${name}: not so on this machine - ${detail}`);
}
const candidatesOf = (value) =>
	[
		...JSON.stringify(value).matchAll(
			/candidate:\S+ \d \w+ \d+ (\S+) \d+ typ (\w+)/g,
		),
	].map(([, address, type]) => [address, type]);

/** `value` as JSON with the run's own fixture ports written PORT, to compare runs */
const portless = (run, value) =>
	run.ports.reduce(
		(text, port) => text.replace(new RegExp(`\\b${port}\\b`, 'g'), 'PORT'),
		JSON.stringify(value),
	);
// how the browser shows a host address in icecandidateerror without media access
const REDACTED = /^(?:0\.0\.0\.x|\[0:0:0:x:x:x:x:x\])(?::\d+)?$/;

async function nativePage(browser) {
	const page = await (await browser.newContext()).newPage();
	page.errors = [];
	page.on('pageerror', (error) => page.errors.push(error.message));
	await page.goto(target);
	await page.waitForFunction(() => window.__rtcReady);
	return { label: 'natively', page, frame: () => page.mainFrame() };
}

async function proxiedPage(browser, mode, base) {
	const page = await openDemo(browser, base);
	await submitLanding(page, target);
	const frame = () =>
		page.frames().findLast((f) => /\/stomp\/[\w-]+\/html\//.test(f.url()));
	for (let i = 0; i < 160; i++) {
		await sleep(250);
		if (
			await frame()
				?.evaluate(() => window.__rtcReady)
				.catch(() => false)
		)
			break;
	}
	return { label: mode, page, frame };
}

/** `probe` in each page at once, with fresh UDP fixtures for each */
async function each(pages, probe, arg = () => ({})) {
	return Promise.all(
		pages.map(async (entry) => {
			const stun = await udpServer(true);
			const sink = await udpServer();
			const fixtures = { stun: stun.port, sink: sink.port, child };
			let result;
			try {
				result = await entry
					.frame()
					.evaluate(probe, { ...fixtures, ...arg(fixtures) });
			} catch (error) {
				result = { threw: String(error).slice(0, 300) };
			}
			// late retransmissions
			await sleep(1000);
			stun.close();
			sink.close();
			return {
				...entry,
				result,
				stun: stun.packets,
				sink: sink.packets,
				ports: [stun.port, sink.port],
			};
		}),
	);
}

async function suite(name, flags, raw) {
	const browser = await launch([RESOLVER, ...flags]);
	const native = await nativePage(browser);
	const proxied = [
		await proxiedPage(browser, `${name}, same-origin`, PROXY),
		await proxiedPage(browser, `${name}, isolated`, HOST),
	];
	const all = [native, ...proxied];

	// unreachable servers, the slow probe, in every page at once: STUN, TURN
	// over UDP and TCP and, on a connection of its own, TURN on a system port
	// (which the browser never allocates on; natively its closed loopback
	// port also keeps the browser from sending anything else)
	const unreachable = await each(all, async ({ sink }) => {
		const [servers, system] = await Promise.all([
			window.__rtc.gather(
				{
					iceServers: [
						{ urls: `stun:127.0.0.1:${sink}` },
						{
							urls: [
								`turn:127.0.0.1:${sink}`,
								`turn:127.0.0.1:${sink}?transport=tcp`,
							],
							username: 'u',
							credential: 'p',
						},
					],
				},
				{ ms: 60000 },
			),
			window.__rtc.gather(
				{
					iceServers: [
						{ urls: 'turn:127.0.0.1:22', username: 'u', credential: 'p' },
					],
				},
				{ ms: 60000 },
			),
		]);
		return { log: [...servers.log, ...system.log], servers, system };
	});
	const errorsOf = (run) =>
		(run.result.log ?? [])
			.filter(([kind]) => kind === 'error')
			.map(([, at, error]) => ({ at, ...error }));
	// what the errors say, in an order that does not depend on timing; one per
	// host candidate, so only as a set where the pages gathered on different
	// interfaces (an isolated frame has no media access of its own)
	const hosts = (run) =>
		(run.result.log ?? []).filter(
			([kind, , candidate]) => kind === 'candidate' && candidate,
		).length;
	const errorShape = (run, unique) => {
		const shapes = errorsOf(run)
			.map((error) =>
				portless(run, [
					error.url,
					error.errorCode,
					error.errorText,
					error.address === null,
				]),
			)
			.sort();
		return unique ? [...new Set(shapes)] : shapes;
	};
	const completeAt = (run) =>
		Math.max(
			...['servers', 'system'].map(
				(key) =>
					run.result[key]?.log?.find(
						([kind, , state]) => kind === 'gathering' && state === 'complete',
					)?.[1] ?? Infinity,
			),
		);
	precondition(
		`${name}, natively: unreachable STUN and TURN servers get requests and each fails with 701 when gathering completes`,
		unreachable[0].sink.length > 0 &&
			errorsOf(unreachable[0]).some((error) => /^TURN/.test(error.errorText)) &&
			errorsOf(unreachable[0]).some((error) => /^STUN/.test(error.errorText)),
		JSON.stringify([
			unreachable[0].sink.length,
			errorShape(unreachable[0]),
			completeAt(unreachable[0]),
		]),
	);
	for (const run of unreachable.slice(1)) {
		const errors = errorsOf(run);
		const unique = hosts(run) !== hosts(unreachable[0]);
		ok(
			`${run.label}: unreachable servers hear nothing, and the page sees the same 701s as natively, as late, with the host redacted`,
			run.sink.length === 0 &&
				JSON.stringify(errorShape(run, unique)) ===
					JSON.stringify(errorShape(unreachable[0], unique)) &&
				errors.every(
					(error) =>
						(error.address === null || REDACTED.test(error.address)) &&
						REDACTED.test(error.hostCandidate),
				) &&
				Math.abs(completeAt(run) - completeAt(unreachable[0])) < 5000 &&
				leaked(run.result).length === 0,
			JSON.stringify([
				run.sink.length,
				errorShape(run, unique),
				errorShape(unreachable[0], unique),
				errors.map(({ address, hostCandidate }) => [address, hostCandidate]),
				completeAt(run),
				completeAt(unreachable[0]),
				leaked(run.result),
			]),
		);
	}

	// servers that answer or listen, a candidate pool
	const gathered = await each(all, (fixtures) =>
		window.__rtc.gather(
			{
				iceServers: [
					{ urls: `stun:127.0.0.1:${fixtures.stun}` },
					{
						urls: [`turn:127.0.0.1:${fixtures.sink}`],
						username: 'u',
						credential: 'p',
					},
				],
				iceCandidatePoolSize: 1,
			},
			{ ms: 3000 },
		),
	);
	const nativeTypes = candidatesOf(gathered[0].result).map(([, type]) => type);
	precondition(
		`${name}, natively: the STUN server hears the browser and answers (a srflx candidate)`,
		// with real host addresses the browser drops a srflx that repeats one
		gathered[0].stun.length > 0 && (raw || nativeTypes.includes('srflx')),
		JSON.stringify([gathered[0].stun.length, nativeTypes]),
	);
	if (raw) {
		const shown = leaked(gathered[0].result).filter(
			(a) => !/\.x$|candidate|255/.test(a),
		);
		precondition(
			`${name}, natively: host candidates carry this machine's address`,
			shown.length > 0,
			shown.join(' '),
		);
	}
	for (const run of gathered.slice(1)) {
		const candidates = candidatesOf(run.result);
		ok(
			`${run.label}: the page's STUN and TURN servers hear nothing, with a candidate pool too`,
			run.stun.length === 0 && run.sink.length === 0,
			JSON.stringify([run.stun, run.sink]),
		);
		ok(
			`${run.label}: only mDNS host candidates, and no address of this machine anywhere the page reads`,
			candidates.length > 0 &&
				candidates.every(
					([address, type]) =>
						type === 'host' &&
						/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.local$/.test(
							address,
						),
				) &&
				leaked(run.result).length === 0,
			JSON.stringify([candidates, leaked(run.result)]),
		);
		ok(
			`${run.label}: getConfiguration reads back the page's servers and pool as natively`,
			portless(run, run.result.config) ===
				portless(gathered[0], gathered[0].result.config),
			JSON.stringify([run.result.config, gathered[0].result.config]),
		);
	}

	// relay only, and servers given after the connection was made
	const later = await each(all, async (fixtures) => {
		const relay = await window.__rtc.gather(
			{
				iceServers: [
					{
						urls: `turn:127.0.0.1:${fixtures.sink}`,
						username: 'u',
						credential: 'p',
					},
				],
				iceTransportPolicy: 'relay',
			},
			{ ms: 2000 },
		);
		const pc = new RTCPeerConnection();
		pc.setConfiguration({
			iceServers: [{ urls: `stun:127.0.0.1:${fixtures.stun}` }],
		});
		pc.createDataChannel('x');
		const candidates = [];
		pc.onicecandidate = (e) =>
			e.candidate && candidates.push(e.candidate.candidate);
		await pc.setLocalDescription();
		await new Promise((r) => setTimeout(r, 2000));
		const configured = pc.getConfiguration().iceServers;
		pc.restartIce();
		await pc.setLocalDescription();
		await new Promise((r) => setTimeout(r, 2000));
		pc.close();
		return { relay: relay.log, candidates, configured };
	});
	for (const run of later.slice(1))
		ok(
			`${run.label}: relay-only and setConfiguration (then an ICE restart) reach no server either`,
			run.stun.length === 0 &&
				run.sink.length === 0 &&
				!candidatesOf(run.result).some(([, type]) => type !== 'host') &&
				portless(run, run.result.configured) ===
					portless(later[0], later[0].result.configured),
			JSON.stringify([
				run.stun.length,
				run.sink.length,
				candidatesOf(run.result),
				run.result.configured,
			]),
		);

	// remote candidates the page chose
	const remotes = await each(all, ({ sink }) =>
		window.__rtc.pair(
			{},
			{
				remote: [
					`candidate:11 1 udp 2122260223 127.0.0.1 ${sink} typ host generation 0`,
					`candidate:12 1 udp 2122260223 example.com ${sink} typ host generation 0`,
					`candidate:13 1 udp 2122260223 0b5a0e4a-1111-4000-8000-000000000000.local ${sink} typ host generation 0`,
					`candidate:14 1 tcp 1518280447 127.0.0.1 ${sink} typ host tcptype passive generation 0`,
				],
			},
		),
	);
	precondition(
		`${name}, natively: a remote candidate on the fixture gets connectivity checks`,
		remotes[0].sink.length > 0,
		JSON.stringify(remotes[0].sink.length),
	);
	for (const run of remotes.slice(1)) {
		const sdp = run.result.remote?.sdp ?? '';
		const connection = (text) => text.match(/^c=.*$/m)?.[0];
		ok(
			`${run.label}: remote candidates the page chose get no packet, and read back as the page gave them`,
			run.sink.length === 0 &&
				/ 127\.0\.0\.1 \d+ typ host/.test(sdp) &&
				sdp.includes('example.com') &&
				JSON.stringify(run.result.added) ===
					JSON.stringify(remotes[0].result.added) &&
				// natively, with real host addresses, the other connection's own
				// address can be the connection line's: not one the page may see
				(connection(sdp) === connection(remotes[0].result.remote?.sdp ?? '') ||
					leaked(connection(remotes[0].result.remote?.sdp ?? '')).length > 0) &&
				!JSON.stringify(run.result).includes('255.255.255.255'),
			JSON.stringify([
				run.sink,
				run.result.added,
				remotes[0].result.added,
				sdp.split('\r\n').filter((l) => /cand|^c=/.test(l)),
				connection(remotes[0].result.remote?.sdp ?? ''),
			]),
		);
		ok(
			`${run.label}: a data channel between two connections of the page opens, with nothing of this machine in its stats`,
			run.result.open === 'open' &&
				run.result.message === 'hello' &&
				leaked(run.result, { loopback: false }).length === 0,
			JSON.stringify([
				run.result.open,
				run.result.message,
				leaked(run.result, { loopback: false }),
			]),
		);
	}

	const crossed = await each(all, ({ child }) =>
		window.__rtc.crossFrame(child),
	);
	for (const run of crossed.slice(1))
		ok(
			`${run.label}: a data channel opens with another proxied page in a frame of its own`,
			run.result.open === 'open' &&
				run.result.message === 'pong:ping' &&
				run.stun.length + run.sink.length === 0 &&
				leaked(run.result).length === 0,
			JSON.stringify([run.result.open, run.result.message, leaked(run.result)]),
		);

	const realms = await each(all, (fixtures) =>
		window.__rtc.realms(
			{ iceServers: [{ urls: `stun:127.0.0.1:${fixtures.stun}` }] },
			fixtures.child,
		),
	);
	const nativeRealms = realms[0].result;
	precondition(
		`${name}, natively: a connection in every realm reaches the STUN server`,
		realms[0].stun.length > 0,
		JSON.stringify(Object.keys(nativeRealms)),
	);
	for (const run of realms.slice(1)) {
		const bad = Object.entries(run.result).filter(([realm, value]) => {
			if (realm === 'worker')
				return JSON.stringify(value) !== JSON.stringify(nativeRealms.worker);
			return (
				!value?.candidates ||
				candidatesOf(value).some(([, type]) => type !== 'host') ||
				leaked(value).length > 0 ||
				(value.source !== undefined &&
					value.source !== nativeRealms[realm]?.source)
			);
		});
		ok(
			`${run.label}: about:blank frames (by contentWindow and frames[i]), srcdoc, nested, blob:, data: and sandboxed frames and popups reach no server; workers still have no RTCPeerConnection`,
			run.stun.length === 0 &&
				bad.length === 0 &&
				Object.keys(run.result).length === Object.keys(nativeRealms).length,
			JSON.stringify([
				run.stun.length,
				bad.map(([realm, value]) => [
					realm,
					JSON.stringify(value).slice(0, 200),
				]),
			]),
		);
	}

	const edges = await each(all, ({ sink }) => window.__rtc.edges(sink));
	for (const run of edges.slice(1)) {
		const { remoteSdp, ...rest } = run.result;
		const { remoteSdp: nativeSdp, ...expected } = edges[0].result;
		const differ = Object.keys(expected).filter(
			(key) => portless(run, rest[key]) !== portless(edges[0], expected[key]),
		);
		ok(
			`${run.label}: bad calls, unawaited ones and constructed candidates answer as natively`,
			differ.length === 0 &&
				portless(run, remoteSdp) === portless(edges[0], nativeSdp) &&
				run.sink.length === 0,
			JSON.stringify([
				differ.map((key) => [key, rest[key], expected[key]]),
				remoteSdp,
				nativeSdp,
			]),
		);
	}

	// a hostile page: its own events, another document's members (that
	// document runs an inject of its own), its prototypes swapped
	const attacked = await each(all, (fixtures) =>
		window.__rtc.attacks(fixtures),
	);
	precondition(
		`${name}, natively: a remote candidate added through another document's member gets checks`,
		attacked[0].sink.length > 0 && attacked[0].stun.length > 0,
		JSON.stringify([attacked[0].sink.length, attacked[0].stun.length]),
	);
	for (const run of attacked.slice(1))
		ok(
			`${run.label}: forged events, another document's members and swapped prototypes reach no server and read no address of this machine`,
			run.sink.length === 0 &&
				run.stun.length === 0 &&
				portless(run, run.result.forged) ===
					portless(attacked[0], attacked[0].result.forged) &&
				run.result.tampered?.watched === true &&
				!Object.values(run.result).some(
					(value) => typeof value === 'string' && value.startsWith('threw'),
				) &&
				leaked(run.result, { loopback: false }).length === 0,
			JSON.stringify([
				run.sink.length,
				run.stun.length,
				leaked(run.result, { loopback: false }),
				run.result,
			]).slice(0, 1500),
		);

	const surfaces = await each(all, async () => ({
		surface: window.__rtc.surface(),
		iterator: await window.__rtc.iteratorShape(),
	}));
	for (const run of surfaces.slice(1)) {
		const differ = [];
		const compare = (path, a, b) => {
			if (JSON.stringify(a) === JSON.stringify(b)) return;
			if (a && b && typeof a === 'object' && typeof b === 'object')
				for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
					compare(`${path}.${key}`, a[key], b[key]);
			else differ.push([path, a, b]);
		};
		compare('', run.result, surfaces[0].result);
		ok(
			`${run.label}: every RTC global, its statics, prototype members and errors read as natively`,
			differ.length === 0,
			JSON.stringify(differ.slice(0, 8)),
		);
	}

	const errors = proxied.flatMap((entry) => entry.page.errors);
	await browser.close();
	return errors;
}

const errors = [
	...(await suite('mDNS host names', [], false)),
	// the proxy origin allowed the camera and microphone: the browser shows
	// host candidates' real addresses
	...(await suite(
		'real host addresses',
		['--use-fake-ui-for-media-stream'],
		true,
	)),
];
await done(null, errors);
