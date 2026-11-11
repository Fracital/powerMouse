// Permissions per proxied site (src/server/permissions.ts, the Permissions
// inject module, docs/permissions.md), against Chrome in both modes. Site A
// (127.0.0.1) and site B (localhost) are a recorder's pages; the probe page
// asks permissions.query for every permission and reads
// Notification.permission, then (when told) asks for the location,
// the microphone and notifications, and records each answer.
//
// - Chrome shows a top-level site `prompt` for what it has not decided;
//   through the proxy the host's frame had no allow list and the page read
//   `denied` and was refused at once. Compared with Chrome as a top-level
//   page, as a frame of another site without and with an allow attribute,
//   and after its requests (headless Chrome answers its own prompts with a
//   denial, so the site reads `denied` afterwards).
// - The browser keeps one permission for every proxied site: once the
//   host's origin holds geolocation, site A still reads `prompt`, its
//   request asks the user through the host (the demo's prompt: Allow), site
//   B is not granted by that and is asked again (Block), and each keeps its
//   answer across a reload.
// - Chrome looks for the device before the policy and the permission: with
//   no microphone or no camera getUserMedia ends in NotFoundError even for
//   a frame its policy refuses, and through the proxy that frame was told
//   NotAllowedError (a CI runner has neither device, a workstation both, so
//   the suite passed on one and failed on the other). The requests are
//   compared on the machine's own devices and again in a Chrome with a
//   microphone and a camera, with no camera, and with no microphone.
// - Chrome settles the constraints before the policy and the permission
//   too (TypeError, OverconstrainedError): the ORDER requests are made
//   before the site is asked anything and after it was refused, in each of
//   those Chromes, and by a granted site.
// - A site reads its own devices (ids per origin, named only where it may
//   use them), and hears devicechange only where it may read what changed
//   (on a private sound server without hardware, where there is one).
// - A kind is asked for by `audio: null`, by any object and by a
//   constraints object that is a function or document.all, as much as by
//   `true`: such a request went to the browser unasked, and a site that
//   was refused got the device the browser lets the proxy origin use.
// - The controller's frame under a host's own headers (a
//   Content-Security-Policy, a sandbox, a Permissions-Policy, an embedder
//   policy): the page reads what it reads natively and waits on no timeout.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
	demoBehind,
	done,
	HOST,
	launch,
	launchPrivateSound,
	NO_AUDIO,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
} from '../lib.mjs';

const NAMES = [
	'geolocation',
	'camera',
	'microphone',
	'notifications',
	'push',
	'clipboard-read',
	'clipboard-write',
	'midi',
	'persistent-storage',
	'screen-wake-lock',
	'accelerometer',
	'background-sync',
	'local-fonts',
	'idle-detection',
	'window-management',
	'display-capture',
	'payment-handler',
];

// requests Chrome ends before it looks at the permissions policy or the
// permission (docs/permissions.md), and four it does not: malformed
// constraints, constraints no device satisfies (audio is settled before
// video), a kind asked for with null, a constraint only an advanced set or
// an ideal value names
const ORDER = {
	malformed: { video: { mandatory: {}, width: 1 } },
	malformedAudio: { audio: { mandatory: {}, deviceId: 'x' } },
	notAString: { audio: { deviceId: { exact: {} } } },
	neither: {},
	overVideo: { video: { width: { min: 99999 } } },
	overAudio: { audio: { deviceId: { exact: 'nope' } } },
	malformedOver: {
		audio: { deviceId: { exact: 'nope' } },
		video: { mandatory: {}, width: 1 },
	},
	overAudioVideo: { audio: { deviceId: { exact: 'nope' } }, video: true },
	audioOverVideo: { audio: true, video: { width: { min: 99999 } } },
	overBoth: {
		audio: { deviceId: { exact: 'nope' } },
		video: { width: { min: 99999 } },
	},
	overGroup: { audio: { groupId: { exact: 'nope' } } },
	overGroupWidth: {
		video: { groupId: { exact: 'nope' }, width: { min: 99999 } },
	},
	overIdGroup: {
		audio: { deviceId: { exact: 'nope' }, groupId: { exact: 'nope' } },
	},
	overGroupVideo: {
		audio: { groupId: { exact: 'nope' } },
		video: { width: { min: 99999 } },
	},
	// a member that is null is a set of constraints, an empty one
	nullAudio: { audio: null },
	nullVideo: { video: null },
	advanced: {
		audio: { advanced: [{ groupId: { exact: 'nope' } }] },
		video: { advanced: [{ width: { min: 99999 } }] },
	},
	ideal: { video: { width: 99999 } },
};

const probe = `<!doctype html><title>permissions</title><script>
(async () => {
	const ask = new URLSearchParams(location.search).get('ask') || '';
	const out = { states: {}, after: {} };
	const query = async (into) => {
		for (const name of ${JSON.stringify(NAMES)}) {
			try {
				const status = await navigator.permissions.query(name === 'push' ? { name, userVisibleOnly: true } : { name });
				into[name] = status.state;
			} catch (error) {
				into[name] = error.name;
			}
		}
	};
	await query(out.states);
	out.notification = Notification.permission;
	if (ask.includes('geo'))
		out.geo = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve('pending'), 8000);
			navigator.geolocation.getCurrentPosition(
				(position) => { clearTimeout(timer); resolve('position ' + position.coords.latitude); },
				(error) => { clearTimeout(timer); resolve('error ' + error.code + ' ' + error.message + ' ' + (error instanceof GeolocationPositionError)); },
			);
		});
	// how long the slowest request took is kept beside the answers (a host's
	// own headers must not leave one waiting on a timeout)
	window.__slowest = 0;
	const media = async (constraints) => {
		const from = performance.now();
		const answer = await Promise.race([
			navigator.mediaDevices.getUserMedia(constraints).then(() => 'stream', (error) => error.name + ': ' + error.message + (error.constraint ? ' [' + error.constraint + ']' : '')),
			new Promise((resolve) => setTimeout(() => resolve('pending'), 8000)),
		]);
		window.__slowest = Math.max(window.__slowest, performance.now() - from);
		return answer;
	};
	// each request, and whether it changed what the site may do
	const order = async () => {
		const answers = {};
		for (const [name, constraints] of Object.entries(${JSON.stringify(ORDER)})) {
			const state = async () => (await navigator.permissions.query({ name: 'microphone' })).state + ' ' + (await navigator.permissions.query({ name: 'camera' })).state;
			const before = await state();
			answers[name] = await media(constraints);
			const after = await state();
			if (after !== before) answers[name] += ' (' + before + ' -> ' + after + ')';
		}
		return answers;
	};
	// before the site was asked anything, and again after it was refused
	if (ask.includes('order')) out.orderFirst = await order();
	if (ask.includes('mic')) {
		out.devices = [...new Set((await navigator.mediaDevices.enumerateDevices()).map((device) => device.kind))].sort().join(' ');
		out.mic = await media({ audio: true });
		out.afterMic = {};
		await query(out.afterMic);
	}
	if (ask.includes('cam')) out.cam = await media({ video: true });
	if (ask.includes('both')) out.both = await media({ audio: true, video: true });
	if (ask.includes('order')) out.order = await order();
	if (ask.includes('notify'))
		out.notify = await Promise.race([
			Notification.requestPermission(),
			new Promise((resolve) => setTimeout(() => resolve('pending'), 8000)),
		]);
	if (ask) {
		await query(out.after);
		out.notificationAfter = Notification.permission;
	}
	window.__perm = out;
})();
</script>`;

// what a page reads of the devices: window.run(op, argument)
const devices = `<!doctype html><title>devices</title><script>
const media = navigator.mediaDevices;
const failure = (error) => error.name + ': ' + error.message + (error.constraint ? ' [' + error.constraint + ']' : '');
const ids = (value) => ({ deviceId: value.deviceId, groupId: value.groupId });
const late = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('pending'), 6000))]);
const odd = {
	nullAudio: () => ({ audio: null }),
	nullVideo: () => ({ video: null }),
	nullBoth: () => ({ audio: null, video: null }),
	anObject: () => ({ audio: [] }),
	aFunction: () => Object.assign(function () {}, { audio: true }),
	documentAll: () => { document.all.audio = true; return document.all; },
	// read once, as the browser reads it: false
	flips: () => { let reads = 0; return { get audio() { return reads++ > 0; } }; },
	falsy: () => ({ audio: 0, video: '' }),
};
const ops = {
	list: async () => (await media.enumerateDevices()).map((device) => ({
		kind: device.kind,
		deviceId: device.deviceId,
		groupId: device.groupId,
		label: device.label,
		type: device.constructor.name,
		json: JSON.stringify(device.toJSON()) === JSON.stringify({ deviceId: device.deviceId, kind: device.kind, label: device.label, groupId: device.groupId }),
		capabilities: device.getCapabilities ? { ...ids(device.getCapabilities()), others: Object.keys(device.getCapabilities()).length } : null,
	})),
	open: (constraints) => late(media.getUserMedia(constraints).then((stream) => {
		window.stream = stream;
		return stream.getTracks().map((track) => ({ kind: track.kind, label: track.label, settings: ids(track.getSettings()), capabilities: ids(track.getCapabilities()), constraints: track.getConstraints() }));
	}, failure)),
	apply: (constraints) => {
		const [track] = window.stream.getTracks();
		return late(track.applyConstraints(constraints).then(() => ({ settings: ids(track.getSettings()), constraints: track.getConstraints() }), failure));
	},
	stop: async () => {
		for (const track of window.stream ? window.stream.getTracks() : []) track.stop();
		window.stream = null;
	},
	// constraints no message carries, made here: what the request gives
	odd: (name) => late(media.getUserMedia(odd[name]()).then((stream) => {
		const kinds = stream.getTracks().map((track) => track.kind).sort().join(' ');
		for (const track of stream.getTracks()) track.stop();
		return 'stream ' + kinds;
	}, failure)),
	watch: async () => {
		window.changes = 0;
		media.addEventListener('devicechange', () => window.changes++);
	},
	changes: async () => window.changes,
	sink: async (id) => {
		const out = { selectAudioOutput: 'selectAudioOutput' in media };
		const element = new Audio();
		out.element = await element.setSinkId(id).then(() => 'sinkId ' + element.sinkId, failure);
		const context = new AudioContext();
		out.context = await context.setSinkId(id).then(() => 'sinkId ' + context.sinkId, failure);
		await context.close();
		try {
			const made = new AudioContext({ sinkId: id });
			out.constructed = 'sinkId ' + made.sinkId;
			await made.close();
		} catch (error) {
			out.constructed = failure(error);
		}
		return out;
	},
};
window.run = (op, argument) => ops[op](argument);
window.ready = new URLSearchParams(location.search).get('v');
</script>`;

// the controller's mediaVerdict as a script, and the headers a document
// that runs it is served with (the verdict rows below)
let verdictScript = '';
const UNDER = {
	'no header': {},
	"Content-Security-Policy: frame-src 'none'": {
		'Content-Security-Policy': "frame-src 'none'",
	},
	"Content-Security-Policy: child-src 'none'": {
		'Content-Security-Policy': "child-src 'none'",
	},
	"Content-Security-Policy: default-src 'none'": {
		'Content-Security-Policy': "default-src 'none'; script-src 'self'",
	},
	'Content-Security-Policy: sandbox allow-scripts allow-same-origin': {
		'Content-Security-Policy': 'sandbox allow-scripts allow-same-origin',
	},
	'Permissions-Policy: camera=(), microphone=()': {
		'Permissions-Policy': 'camera=(), microphone=()',
	},
	'Cross-Origin-Embedder-Policy: require-corp': {
		'Cross-Origin-Embedder-Policy': 'require-corp',
	},
	'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp':
		{
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
	// a document of no origin: its own frame is another origin's
	'Content-Security-Policy: sandbox allow-scripts': {
		'Content-Security-Policy': 'sandbox allow-scripts',
	},
};
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/verdict.js') {
		res.setHeader('content-type', 'text/javascript; charset=utf-8');
		res.end(verdictScript);
		return;
	}
	res.setHeader('content-type', 'text/html; charset=utf-8');
	if (url.pathname === '/verdict') {
		for (const [name, value] of Object.entries(
			UNDER[url.searchParams.get('under')] ?? {},
		))
			res.setHeader(name, value);
		res.end(
			'<!doctype html><title>verdict</title><script src="/verdict.js"></script>',
		);
		return;
	}
	// a top-level page whose own policy turns the devices off
	if (url.searchParams.has('off'))
		res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
	if (url.pathname === '/frame') {
		const allow = url.searchParams.get('allow');
		const ask = url.searchParams.get('ask') ?? '';
		const inner =
			url.searchParams.get('page') === 'devices'
				? `devices?v=${url.searchParams.get('v')}`
				: `probe?ask=${ask}`;
		res.end(
			`<!doctype html><iframe${allow ? ` allow="${allow}"` : ''} src="${B}/${inner}"></iframe>`,
		);
		return;
	}
	res.end(url.pathname === '/devices' ? devices : probe);
});
// every interface: localhost may resolve to ::1 for the demo's wisp
await new Promise((resolve) => server.listen(0, resolve));
const A = `http://127.0.0.1:${server.address().port}`;
const B = `http://localhost:${server.address().port}`;

const isProbe = (frame) =>
	frame.evaluate(() => !!window.__perm).catch(() => false);
async function result(frames) {
	for (let i = 0; i < 120; i++) {
		for (const frame of frames())
			if (await isProbe(frame)) return frame.evaluate(() => window.__perm);
		await sleep(250);
	}
	return null;
}

const CASES = [
	['a top-level site', (base) => `${base}/probe`],
	['a frame of another site without allow', (base) => `${base}/frame`],
	[
		'a frame of another site allowed geolocation, camera, microphone',
		(base) =>
			`${base}/frame?allow=${encodeURIComponent('geolocation; camera; microphone')}`,
	],
];
const ASK = 'geo,mic,cam,both,order,notify';
const ASKING = [
	['a top-level site that asks', (base) => `${base}/probe?ask=${ASK}`],
	['a frame of another site that asks', (base) => `${base}/frame?ask=${ASK}`],
	[
		'a frame of another site allowed geolocation, camera, microphone that asks',
		(base) =>
			`${base}/frame?ask=${ASK}&allow=${encodeURIComponent('geolocation; camera; microphone')}`,
	],
];

// the devices Chrome finds: this machine's own, then each set a launch can
// make on any machine. `has` is what its device list must then name
const DEVICES = [
	{ label: '', cases: [...CASES, ...ASKING] },
	{
		label: 'a microphone and a camera',
		args: ['--use-fake-device-for-media-stream'],
		has: { audioinput: true, videoinput: true },
	},
	{
		label: 'a microphone and no camera',
		args: ['--use-fake-device-for-media-stream=device-count=0'],
		has: { audioinput: true, videoinput: false },
	},
	{
		label: 'no microphone',
		env: NO_AUDIO,
		has: { audioinput: false },
	},
];

const proxiedFrames = (tab) => () =>
	tab.frames().filter((frame) => /\/stomp\/[\w-]+\/html/.test(frame.url()));
const describe = (value) => JSON.stringify(value);
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];

let browser = null;
for (const { label, args = [], env = null, has, cases = ASKING } of DEVICES) {
	await browser?.close();
	browser = await launch(args, { env });
	const where = label ? `, ${label}` : '';
	const native = new Map();
	for (const [name, url] of cases) {
		const page = await browser.newPage();
		await page.goto(url(A));
		native.set(name, await result(() => page.frames()));
		await page.context().close();
	}
	if (has) {
		const kinds =
			native.get(ASKING[0][0])?.devices?.split(' ').filter(Boolean) ?? null;
		ok(
			`natively${where}: Chrome finds those devices`,
			kinds !== null &&
				Object.entries(has).every(
					([kind, present]) => kinds.includes(kind) === present,
				),
			describe(kinds),
		);
	}
	for (const [mode, base] of MODES)
		for (const [name, url] of cases) {
			const tab = await openDemo(browser, base);
			await submitLanding(tab, url(A));
			const proxied = await result(proxiedFrames(tab));
			let expected = native.get(name);
			// in isolation mode the proxied top is a frame of another origin than
			// the host, and Chrome never shows a frame of another origin the
			// notification prompt (allow cannot change it): the request is
			// dismissed, the site stays undecided
			if (
				mode === 'isolated' &&
				expected?.notify === 'denied' &&
				expected.states.notifications === 'prompt'
			)
				expected = {
					...expected,
					after: {
						...expected.after,
						notifications: 'prompt',
						push: 'prompt',
					},
					notify: 'default',
					notificationAfter: 'default',
				};
			ok(
				`${mode}${where}: ${name} reads and asks as natively`,
				describe(proxied) === describe(expected),
				`\n  proxied ${describe(proxied)}\n  native  ${describe(expected)}`,
			);
			await tab.context().close();
		}
}

await browser.close();
browser = await launch();
for (const [mode, base] of MODES) {
	// one site's permission is never another's
	const tab = await openDemo(browser, base);
	const context = tab.context();
	await context.grantPermissions(['geolocation'], {
		origin: new URL(base).origin,
	});
	await context.setGeolocation({ latitude: 12, longitude: 34 });
	const prompts = [];
	const answer = async (choice) => {
		const button = await tab.waitForSelector(`#permissionPrompt .${choice}`, {
			timeout: 15000,
		});
		prompts.push(
			await tab.evaluate(
				() => document.querySelector('#permissionPrompt p').textContent,
			),
		);
		await button.click();
	};
	const before = Date.now();
	const fresh = async () => {
		for (let i = 0; i < 40; i++) {
			const frame = proxiedFrames(tab)().at(-1);
			if (
				frame &&
				(await frame
					.evaluate((t) => window.__perm && performance.timeOrigin > t, before)
					.catch(() => false))
			)
				return;
			await sleep(250);
		}
	};
	// site A, then site B, then site A again: each a new document
	await submitLanding(tab, `${A}/probe?ask=geo`);
	await answer('allow');
	const siteA = await result(() => proxiedFrames(tab)().slice(-1));
	await submitOmni(tab, `${B}/probe?ask=geo`);
	await sleep(1000);
	await answer('block');
	await fresh();
	const siteB = await result(() => proxiedFrames(tab)().slice(-1));
	await submitOmni(tab, `${A}/probe`);
	await sleep(1500);
	const againA = await result(() => proxiedFrames(tab)().slice(-1));
	await submitOmni(tab, `${B}/probe`);
	await sleep(1500);
	const againB = await result(() => proxiedFrames(tab)().slice(-1));
	ok(
		`${mode}: the host's geolocation is not site A's until the user allows it for A`,
		siteA?.states.geolocation === 'prompt' &&
			siteA?.geo === 'position 12' &&
			siteA?.after.geolocation === 'granted' &&
			prompts[0] ===
				`127.0.0.1:${server.address().port} wants to know your location`,
		describe({ siteA, prompts }),
	);
	ok(
		`${mode}: site B is asked again, and its Block is its own`,
		siteB?.states.geolocation === 'prompt' &&
			siteB?.geo === 'error 1 User denied Geolocation true' &&
			siteB?.after.geolocation === 'denied' &&
			prompts.length === 2,
		describe({ siteB, prompts }),
	);
	ok(
		`${mode}: each site keeps its answer`,
		againA?.states.geolocation === 'granted' &&
			againB?.states.geolocation === 'denied',
		describe({ againA: againA?.states, againB: againB?.states }),
	);
	await context.close();
}

// The devices a site reads (enumerateDevices, a track's settings, a sink):
// Chrome gives every origin its own deviceIds, shows ids and labels only
// where the site has the permission, and takes an id only from the origin
// it was given to. Every proxied site is the proxy origin to the browser.
const HEX = /^[0-9a-f]{64}$/;
const form = (id) =>
	id === '' ? 'none' : id === 'default' ? 'default' : HEX.test(id) ? 'id' : id;
const shape = (list) =>
	list.map(
		(device) =>
			`${device.kind} ${form(device.deviceId)} "${device.label}" group ${form(device.groupId)} ${device.type}` +
			(device.json ? '' : ' toJSON differs') +
			(device.capabilities
				? device.capabilities.others === 0
					? ' capabilities {}'
					: device.capabilities.deviceId === device.deviceId &&
						  device.capabilities.groupId === device.groupId
						? ' capabilities with its ids'
						: ' capabilities with other ids'
				: ''),
	);
const idsOf = (list, key = 'deviceId') =>
	list.map((device) => device[key]).filter((id) => HEX.test(id));
const shared = (one, other, key = 'deviceId') =>
	idsOf(one, key).filter((id) => idsOf(other, key).includes(id)).length;
const pick = (list, kind) =>
	list.find((device) => device.kind === kind && HEX.test(device.deviceId));
/** `value` as text, every id in `names` written as its name */
const named = (value, names) => {
	let text = JSON.stringify(value);
	for (const [id, name] of names) text = text.replaceAll(id, `<${name}>`);
	return text;
};

/**
 * What two sites read, as a table of rows. `visit(url)` loads a new
 * document and resolves to its `run`; `grant(run, origin, names)` gives
 * the site those permissions (all it has from then on).
 */
const SPEAKERS =
	'its own output id as a sink in a frame allowed the microphone and speaker-selection';
async function deviceRows({ visit, grant, after, mark = () => {} }) {
	const rows = {};
	let a = await visit(`${A}/devices`);
	rows['a site that has not asked'] = shape(await a('list'));
	await grant(a, A, ['microphone']);
	rows['a site granted the microphone only'] = shape(await a('list'));
	await grant(a, A, ['microphone', 'camera']);
	const listA = await a('list');
	rows['a site granted both'] = shape(listA);
	// every id either site read, by what it is
	const idNames = (list, whose) =>
		list.flatMap((device, i) => [
			[device.deviceId, `${whose} ${device.kind} ${i}`],
			[device.groupId, `${whose} ${device.kind} ${i} group`],
		]);
	const ownA = idNames(listA, 'its').filter(([id]) => HEX.test(id));
	mark('granted');
	const micA = pick(listA, 'audioinput')?.deviceId;
	const groupA = pick(listA, 'audioinput')?.groupId;
	const camA = pick(listA, 'videoinput')?.deviceId;
	const outA = pick(listA, 'audiooutput')?.deviceId;
	rows['getUserMedia with its own microphone id'] = named(
		await a('open', { audio: { deviceId: { exact: micA } } }),
		ownA,
	);
	rows['applyConstraints with its own id'] = named(
		await a('apply', { deviceId: { exact: micA } }),
		ownA,
	);
	await a('stop');
	rows['getUserMedia with its own camera id'] = named(
		await a('open', { video: { deviceId: { exact: camA } } }),
		ownA,
	);
	await a('stop');
	rows['getUserMedia with its own groupId'] = named(
		await a('open', { audio: { groupId: { exact: groupA } } }),
		ownA,
	);
	await a('stop');
	// Chrome's answer to the constraints comes before the permission, so a
	// granted site gets it too
	rows['a granted site, malformed constraints'] = await a(
		'open',
		ORDER.malformed,
	);
	rows['a granted site, constraints no camera satisfies'] = await a(
		'open',
		ORDER.audioOverVideo,
	);
	rows['its own output id as a sink'] = named(await a('sink', outA), ownA);
	rows['default as a sink'] = named(await a('sink', 'default'), ownA);
	mark('asked');

	const b = await visit(`${B}/devices`);
	rows['another site that has not asked, the first granted'] = shape(
		await b('list'),
	);
	rows['default as a sink for a site that has not asked'] = named(
		await b('sink', 'default'),
		ownA,
	);
	rows["the first site's output id as a sink for it"] = named(
		await b('sink', outA),
		idNames(listA, "the first site's").filter(([id]) => HEX.test(id)),
	);
	// an id that is not this site's own is no device's: Chrome says so
	// before anybody is asked
	rows["getUserMedia with the first site's microphone id, before it is asked"] =
		named(
			await b('open', { audio: { deviceId: { exact: micA } } }),
			idNames(listA, "the first site's").filter(([id]) => HEX.test(id)),
		);
	await grant(b, B, ['microphone', 'camera']);
	const listB = await b('list');
	rows['the other site granted both'] = shape(listB);
	rows['ids the two sites share'] =
		`${shared(listA, listB)} deviceIds, ${shared(listA, listB, 'groupId')} groupIds`;
	const both = [
		...idNames(listA, "the first site's"),
		...idNames(listB, 'its'),
	].filter(([id]) => HEX.test(id));
	rows["getUserMedia with the first site's microphone id, exact"] = named(
		await b('open', { audio: { deviceId: { exact: micA } } }),
		both,
	);
	await b('stop');
	rows["getUserMedia with the first site's microphone id, ideal"] = named(
		await b('open', { audio: { deviceId: micA } }),
		both,
	);
	rows["applyConstraints with the first site's id"] = named(
		await b('apply', { deviceId: { exact: micA } }),
		both,
	);
	await b('stop');
	rows["getUserMedia with the first site's groupId"] = named(
		await b('open', { audio: { groupId: { exact: groupA } } }),
		both,
	);
	await b('stop');
	rows["the first site's output id as a sink"] = named(
		await b('sink', outA),
		both,
	);

	a = await visit(`${A}/devices`);
	const again = await a('list');
	rows['a new document of the first site keeps'] =
		`${shared(listA, again)} of ${idsOf(listA).length} deviceIds, ${shared(listA, again, 'groupId')} groupIds`;
	const allowed = encodeURIComponent('camera; microphone');
	let frame = await visit(`${A}/frame?page=devices&allow=${allowed}`);
	const inFrame = await frame('list');
	rows['the other site in a frame of the first, allowed both'] = shape(inFrame);
	rows["that frame's deviceIds"] =
		`${shared(inFrame, listB)} of the other site's, ${shared(inFrame, listA)} of the first's`;
	rows["that frame's own output id as a sink"] = named(
		await frame('sink', pick(inFrame, 'audiooutput')?.deviceId),
		idNames(inFrame, 'its').filter(([id]) => HEX.test(id)),
	);
	frame = await visit(`${A}/frame?page=devices`);
	rows['the same frame without allow'] = shape(await frame('list'));
	rows['the frame without allow, constraints no microphone satisfies'] =
		await frame('open', ORDER.overAudioVideo);
	rows['the frame without allow, constraints a device satisfies'] = await frame(
		'open',
		ORDER.ideal,
	);
	rows['default as a sink in the frame without allow'] = named(
		await frame('sink', 'default'),
		[],
	);
	frame = await visit(`${A}/frame?page=devices&allow=microphone`);
	rows['the same frame allowed the microphone'] = shape(await frame('list'));
	// Chrome 156 lets an allow attribute give a frame its AudioContext's
	// output; before, no frame of another origin had it
	frame = await visit(
		`${A}/frame?page=devices&allow=${encodeURIComponent('microphone; speaker-selection')}`,
	);
	const speaking = await frame('list');
	rows[SPEAKERS] = named(
		await frame('sink', pick(speaking, 'audiooutput')?.deviceId),
		idNames(speaking, 'its').filter(([id]) => HEX.test(id)),
	);
	return { rows, listA, listB, cleared: after ? await after(visit) : null };
}

await browser.close();
browser = await launch(['--use-fake-device-for-media-stream']);
let visits = 0;
const stamped = (url) => `${url}${url.includes('?') ? '&' : '?'}v=${++visits}`;
const runIn = async (frames, stamp) => {
	for (let i = 0; i < 120; i++) {
		for (const frame of frames())
			if (
				await frame
					.evaluate((v) => window.ready === String(v), stamp)
					.catch(() => false)
			)
				return (op, argument) =>
					frame.evaluate(([o, a]) => window.run(o, a), [op, argument]);
		await sleep(250);
	}
	throw new Error(`no document for visit ${stamp}`);
};
const listOf = async (run) => run('list');
const nativeContext = await browser.newContext();
const nativePage = await nativeContext.newPage();
const nativeDevices = await deviceRows({
	visit: async (url) => {
		await nativePage.goto(stamped(url));
		return runIn(() => nativePage.frames(), visits);
	},
	grant: (run, origin, names) =>
		nativeContext.grantPermissions(names, { origin }),
});
await nativeContext.close();
for (const [mode, base] of MODES) {
	const tab = await openDemo(browser, base);
	// the browser lets the proxy origin use both: each site is asked for by
	// the host (the demo's prompt)
	await tab.context().grantPermissions(['microphone', 'camera'], {
		origin: new URL(base).origin,
	});
	const granted = new Map();
	let landed = false;
	// Chrome's line for a request in a frame its policy refuses: the
	// controller's verdict frame is one (docs/permissions.md)
	const violations = [];
	const marks = {};
	tab.on('console', (message) => {
		if (/Permissions policy violation/.test(message.text()))
			violations.push(message.text());
	});
	const proxied = await deviceRows({
		mark: (name) => {
			marks[name] = violations.length;
		},
		visit: async (url) => {
			await (landed ? submitOmni : submitLanding)(tab, stamped(url));
			landed = true;
			return runIn(proxiedFrames(tab), visits);
		},
		grant: async (run, origin, names) => {
			for (const name of names) {
				if (granted.get(origin)?.includes(name)) continue;
				granted.set(origin, [...(granted.get(origin) ?? []), name]);
				const opened = run(
					'open',
					name === 'camera' ? { video: true } : { audio: true },
				);
				const allow = await tab
					.waitForSelector('#permissionPrompt .allow', { timeout: 15000 })
					.catch(() => null);
				await allow?.click();
				await opened;
				await run('stop');
			}
		},
		// the host wipes the first site's cookies (controller.cookies.clear):
		// its ids go with them, as Chrome's do with a site's cookies (measured
		// in a profile on disk; a context like this one never resets them)
		after: async (visit) => {
			await tab.evaluate(
				(origin) => window.controller.cookies.clear(origin),
				A,
			);
			return {
				a: await listOf(await visit(`${A}/devices`)),
				b: await listOf(await visit(`${B}/devices`)),
			};
		},
	}).catch((error) => ({ rows: { failed: String(error) } }));
	for (const [row, native] of Object.entries(nativeDevices.rows)) {
		let expected = native;
		// in isolation mode the proxied top is a frame of another origin than
		// the host, and before Chrome 156 no frame of another origin chooses
		// an AudioContext's output (allow cannot change it): where Chrome
		// would have taken the id, it refuses
		const sink =
			mode === 'isolated' &&
			!/"context":"sinkId /.test(nativeDevices.rows[SPEAKERS]) &&
			/"context":"sinkId /.test(native);
		if (sink)
			expected = JSON.stringify({
				...JSON.parse(native),
				context:
					'NotAllowedError: Permissions-Policy disallows speaker selection.',
			});
		ok(
			`${mode}, devices: ${row}, as natively`,
			describe(proxied.rows[row]) === describe(expected),
			`\n  proxied ${describe(proxied.rows[row])}\n  native  ${describe(expected)}`,
		);
	}
	// a granted site's request goes straight to the browser's call: the
	// controller is asked for no verdict, and its console gets no line. A
	// site the host is asked about gets one (the other site, before it is
	// asked)
	ok(
		`${mode}, devices: a granted site's requests leave no policy violation in the host's console`,
		marks.asked === marks.granted && violations.length > marks.asked,
		`${marks.asked - marks.granted} lines for its requests, ${violations.length - marks.asked} after`,
	);
	ok(
		`${mode}, devices: a site's ids are forgotten with its cookies, and only its own`,
		proxied.cleared &&
			idsOf(proxied.cleared.a).length === idsOf(proxied.listA).length &&
			shared(proxied.cleared.a, proxied.listA) === 0 &&
			shared(proxied.cleared.b, proxied.listB) === idsOf(proxied.listB).length,
		proxied.cleared &&
			`the first site kept ${shared(proxied.cleared.a, proxied.listA)} of ${idsOf(proxied.listA).length}, the other ${shared(proxied.cleared.b, proxied.listB)} of ${idsOf(proxied.listB).length}`,
	);
	await tab.context().close();
}

// A kind asked for in the ways `true` is not: a member that is null or an
// object, constraints that are a function or document.all, a getter that
// answers differently the second time. The browser lets the proxy origin
// use both devices here, so a request that reached its call unasked would
// open them for a site that was refused. Natively the refused site is one
// whose prompt headless Chrome answered.
const ODD = [
	'nullAudio',
	'nullVideo',
	'nullBoth',
	'anObject',
	'aFunction',
	'documentAll',
	'flips',
	'falsy',
];
const oddRows = async (run) => {
	const rows = {};
	for (const name of ODD) rows[name] = await run('odd', name);
	return rows;
};
const nativeOdd = {};
{
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(stamped(`${A}/devices`));
	let run = await runIn(() => page.frames(), visits);
	await run('open', { audio: true });
	await run('open', { video: true });
	nativeOdd.refused = await oddRows(run);
	await context.grantPermissions(['microphone', 'camera'], { origin: B });
	await page.goto(stamped(`${B}/devices`));
	run = await runIn(() => page.frames(), visits);
	nativeOdd.granted = await oddRows(run);
	await context.close();
}
ok(
	'natively: audio: null asks for the microphone, and a function is constraints',
	nativeOdd.granted.nullAudio === 'stream audio' &&
		nativeOdd.granted.nullBoth === 'stream audio video' &&
		nativeOdd.granted.aFunction === 'stream audio' &&
		/^NotAllowedError/.test(nativeOdd.refused.nullAudio) &&
		/^NotAllowedError/.test(nativeOdd.refused.aFunction),
	describe(nativeOdd),
);
for (const [mode, base] of MODES) {
	const tab = await openDemo(browser, base);
	await tab.context().grantPermissions(['microphone', 'camera'], {
		origin: new URL(base).origin,
	});
	const violations = [];
	tab.on('console', (message) => {
		if (/Permissions policy violation/.test(message.text()))
			violations.push(message.text());
	});
	// the site's request, answered at the host's prompt
	const answered = async (run, constraints, choice) => {
		const opened = run('open', constraints);
		const button = await tab
			.waitForSelector(`#permissionPrompt .${choice}`, { timeout: 15000 })
			.catch(() => null);
		await button?.click();
		await opened;
		await run('stop');
	};
	let rows = {};
	let bare = null;
	try {
		await submitLanding(tab, stamped(`${A}/devices`));
		let run = await runIn(proxiedFrames(tab), visits);
		await answered(run, { audio: true }, 'block');
		await answered(run, { video: true }, 'block');
		// refused now, and asked again for the kinds and nothing of them
		await run('open', { audio: true, video: true });
		bare = violations.length;
		rows.refused = await oddRows(run);
		await submitOmni(tab, stamped(`${B}/devices`));
		run = await runIn(proxiedFrames(tab), visits);
		await answered(run, { audio: true }, 'allow');
		await answered(run, { video: true }, 'allow');
		rows.granted = await oddRows(run);
	} catch (error) {
		rows = { failed: String(error) };
	}
	for (const state of ['refused', 'granted'])
		ok(
			`${mode}: a site that was ${state} asks with null, an object, a function, document.all and a getter, as natively`,
			describe(rows[state]) === describe(nativeOdd[state]),
			`\n  proxied ${describe(rows[state] ?? rows)}\n  native  ${describe(nativeOdd[state])}`,
		);
	// only a missing device ends such a request before the policy: the
	// controller is asked for no verdict
	ok(
		`${mode}: requests for a kind and nothing of it leave no policy violation in the host's console`,
		bare === 0,
		`${bare} lines`,
	);
	await tab.context().close();
}

// A host with policy headers of its own. The controller asks Chrome for
// its answer to a request's constraints in a frame of the host's document
// (the same-origin host page, or the controller frame in isolation mode),
// so the host's headers are that frame's too: under each the page must
// read what it reads natively, and no request may wait on a timeout
// because the frame could not answer. Under a Permissions-Policy that
// turns the devices off natively means a page under that policy itself.
const HOST_ASK = 'mic,cam,both,order';
const HOST_CASES = [
	['a top-level site', (base, more) => `${base}/probe?ask=${HOST_ASK}${more}`],
	[
		'a frame of another site without allow',
		(base, more) => `${base}/frame?ask=${HOST_ASK}${more}`,
	],
	[
		'a frame of another site allowed the camera and the microphone',
		(base, more) =>
			`${base}/frame?ask=${HOST_ASK}&allow=${encodeURIComponent('camera; microphone')}${more}`,
	],
];
const HOSTS = [
	{
		label:
			'a Content-Security-Policy whose frame-src, child-src and default-src name no about:blank',
		headers: (port) => {
			const proxy = `http://127.0.0.1:${port}`;
			const both = `${proxy} http://localhost:${port} ws://127.0.0.1:${port} ws://localhost:${port}`;
			return {
				'Content-Security-Policy': `default-src 'self' 'unsafe-inline' 'unsafe-eval' ${both}; frame-src 'self' ${proxy}; child-src 'self' ${proxy}`,
			};
		},
	},
	{
		label: 'a Content-Security-Policy sandbox',
		headers: () => ({
			'Content-Security-Policy':
				'sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
		}),
	},
	{
		label: 'Permissions-Policy: camera=(), microphone=()',
		headers: () => ({ 'Permissions-Policy': 'camera=(), microphone=()' }),
		native: '&off',
	},
	{
		// Chrome loads no frame under this policy that does not send it too,
		// and a proxied document does not (the worker drops the header): no
		// page loads at all, so there is nothing to compare until one does
		label: 'Cross-Origin-Embedder-Policy: require-corp',
		headers: () => ({ 'Cross-Origin-Embedder-Policy': 'require-corp' }),
		loads: false,
	},
];
const probeFrame = async (frames, tries = 120) => {
	for (let i = 0; i < tries; i++) {
		for (const frame of frames()) if (await isProbe(frame)) return frame;
		await sleep(250);
	}
	return null;
};
// Chrome's line for each request a document's policy refuses, in that
// document's console
const policyLines = (page) => {
	const lines = [];
	page.on('console', (message) => {
		if (/Permissions policy violation/.test(message.text()))
			lines.push(message.text());
	});
	return lines;
};
const nativeUnder = new Map();
const nativeLines = new Map();
for (const more of ['', '&off'])
	for (const [name, url] of HOST_CASES) {
		const page = await browser.newPage();
		const lines = policyLines(page);
		await page.goto(url(A, more));
		nativeUnder.set(name + more, await result(() => page.frames()));
		nativeLines.set(name + more, lines.length);
		await page.context().close();
	}
for (const { label, headers, native = '', loads = true } of HOSTS) {
	const front = await demoBehind(headers);
	if (!loads) {
		const tab = await openDemo(browser, front.proxy);
		await submitLanding(tab, HOST_CASES[0][1](A, ''));
		const loaded = await probeFrame(proxiedFrames(tab), 40);
		await tab.context().close();
		if (!loaded) {
			console.log(
				`SKIP permissions, a host with ${label}: no proxied page loads under it`,
			);
			front.close();
			continue;
		}
	}
	for (const [mode, base] of [
		['same-origin', front.proxy],
		['isolated', front.host],
	]) {
		let slowest = 0;
		for (const [name, url] of HOST_CASES) {
			const tab = await openDemo(browser, base);
			const lines = policyLines(tab);
			await submitLanding(tab, url(A, ''));
			const frame = await probeFrame(proxiedFrames(tab));
			const proxied = frame && (await frame.evaluate(() => window.__perm));
			slowest = Math.max(
				slowest,
				frame ? await frame.evaluate(() => window.__slowest) : Infinity,
			);
			const expected = nativeUnder.get(name + native);
			ok(
				`${mode}, a host with ${label}: ${name} reads and asks as natively`,
				describe(proxied) === describe(expected),
				`\n  proxied ${describe(proxied)}\n  native  ${describe(expected)}`,
			);
			// what the browser's own policy refuses, the browser answers: its
			// call is the page's, in the page's document, and the lines in the
			// console are the ones a page under that policy leaves
			if (native)
				ok(
					`${mode}, a host with ${label}: ${name} leaves Chrome's lines in the console, as many as natively`,
					lines.length === nativeLines.get(name + native) && lines.length > 0,
					`${lines.length} lines, natively ${nativeLines.get(name + native)}`,
				);
			await tab.context().close();
		}
		// the verdict's own timeouts are 4 s and 6 s
		ok(
			`${mode}, a host with ${label}: no request waits on a timeout`,
			slowest < 3500,
			`the slowest took ${Math.round(slowest)} ms`,
		);
	}
	front.close();
}

// The verdict itself under a host's headers: the controller's mediaVerdict
// in a document served with each. No proxied page is needed (none loads
// under some of them), and the controller's frame is made and asked the
// same way under all. A document sandboxed out of its origin cannot read
// its own frame: no verdict there, and no wait either.
let esbuild = null;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.log(
		"SKIP permissions, the verdict under a host's headers: esbuild is not installed",
	);
}
if (esbuild) {
	const built = await esbuild.build({
		stdin: {
			contents:
				"import { mediaVerdict } from './src/controller/mediaVerdict.ts';\nwindow.mediaVerdict = mediaVerdict;\n",
			resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
			loader: 'ts',
		},
		bundle: true,
		format: 'iife',
		write: false,
		logLevel: 'silent',
	});
	verdictScript = built.outputFiles[0].text;
	const ASKED = {
		malformed: {},
		unsatisfied: { audio: { deviceId: { exact: 'nope' } } },
		satisfied: { audio: { echoCancellation: true }, video: { width: 320 } },
	};
	const verdicts = async (under) => {
		const page = await browser.newPage();
		await page.goto(`${A}/verdict?under=${encodeURIComponent(under)}`);
		const out = await page.evaluate(async (asked) => {
			const answers = {};
			let slowest = 0;
			for (const [name, constraints] of Object.entries(asked)) {
				const from = performance.now();
				const verdict = await window.mediaVerdict(constraints);
				slowest = Math.max(slowest, performance.now() - from);
				answers[name] =
					verdict &&
					verdict.name + (verdict.constraint ? ` ${verdict.constraint}` : '');
			}
			return {
				answers,
				slowest: Math.round(slowest),
				frames: document.querySelectorAll('iframe').length,
			};
		}, ASKED);
		await page.context().close();
		return out;
	};
	const [plain, ...under] = Object.keys(UNDER);
	const expected = await verdicts(plain);
	ok(
		"the controller's frame: Chrome's answer before its policy and its permission",
		describe(expected.answers) ===
			describe({
				malformed: 'TypeError',
				unsatisfied: 'OverconstrainedError deviceId',
				satisfied: 'NotAllowedError',
			}),
		describe(expected),
	);
	for (const name of under) {
		const got = await verdicts(name);
		const none = name === 'Content-Security-Policy: sandbox allow-scripts';
		ok(
			`the controller's frame under ${name}: ${none ? 'no verdict' : 'the same verdict'}, at once, and no frame left`,
			describe(got.answers) ===
				describe(
					none
						? { malformed: null, unsatisfied: null, satisfied: null }
						: expected.answers,
				) &&
				// the controller gives a frame 4 s
				got.slowest < 3500 &&
				got.frames === 0,
			describe(got),
		);
	}
}

// devicechange: Chrome fires it only where the site may read the devices
// that changed. Fake devices never change and a test never reaches the
// machine's real ones, so this part runs on a private sound server
// without hardware (launchPrivateSound), where a virtual output can be
// plugged in, and is left out where there is none (a CI runner). Chrome
// on Linux notices a new device when a page lists the devices again.
const sound = await launchPrivateSound();
if (!sound)
	console.log(
		'SKIP permissions, devicechange: no private PipeWire server can be started here',
	);
else {
	const CHANGES = [
		['a site that has not asked', `${A}/devices`, false],
		['a site granted the microphone', `${A}/devices`, true],
		[
			'a frame of another site without allow, its top granted',
			`${A}/frame?page=devices`,
			true,
		],
		[
			'a frame of another site allowed the microphone, its top granted',
			`${A}/frame?page=devices&allow=microphone`,
			true,
		],
	];
	/** what the document behind `run` hears of an output plugged in */
	const heard = async (run) => {
		await run('watch');
		const outputs = async () =>
			(await run('list')).filter(
				(device) => device.kind === 'audiooutput' && device.label,
			).length;
		const before = await outputs();
		sound.plug();
		// heard at once where it is heard at all; 2 s say it is not
		let after = before;
		let changes = 0;
		for (let i = 0; i < 8 && !(changes && after > before); i++) {
			await sleep(250);
			after = await outputs();
			changes = await run('changes');
		}
		return `${changes} devicechange, ${after - before} more outputs named`;
	};
	const nativeHeard = new Map();
	for (const [name, url, grant] of CHANGES) {
		const context = await sound.browser.newContext();
		if (grant)
			for (const origin of [A, B])
				await context.grantPermissions(['microphone'], { origin });
		const page = await context.newPage();
		await page.goto(stamped(url));
		nativeHeard.set(
			name,
			await heard(await runIn(() => page.frames(), visits)),
		);
		await context.close();
	}
	ok(
		'natively, devicechange: an output plugged in is an event for a site granted the microphone, none for one that has not asked',
		nativeHeard.get(CHANGES[1][0]) === '1 devicechange, 1 more outputs named' &&
			nativeHeard.get(CHANGES[0][0]) === '0 devicechange, 0 more outputs named',
		describe([...nativeHeard]),
	);
	for (const [mode, base] of MODES)
		for (const [name, url, grant] of CHANGES) {
			const tab = await openDemo(sound.browser, base);
			await tab.context().grantPermissions(['microphone'], {
				origin: new URL(base).origin,
			});
			let proxied;
			try {
				if (grant) {
					// the site is granted through the host's prompt, on a document
					// of its own
					await submitLanding(tab, stamped(`${A}/devices`));
					const run = await runIn(proxiedFrames(tab), visits);
					const opened = run('open', { audio: true });
					const allow = await tab.waitForSelector('#permissionPrompt .allow', {
						timeout: 15000,
					});
					await allow.click();
					await opened;
					await run('stop');
					await submitOmni(tab, stamped(url));
				} else await submitLanding(tab, stamped(url));
				proxied = await heard(await runIn(proxiedFrames(tab), visits));
			} catch (error) {
				proxied = String(error);
			}
			ok(
				`${mode}, devicechange: ${name}, as natively`,
				proxied === nativeHeard.get(name),
				`\n  proxied ${proxied}\n  native  ${nativeHeard.get(name)}`,
			);
			await tab.context().close();
		}
	await sound.close();
}

server.close();
await done(browser);
