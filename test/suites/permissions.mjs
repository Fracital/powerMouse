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
import { createServer } from 'node:http';
import {
	done,
	HOST,
	launch,
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
	if (ask.includes('mic'))
		out.mic = await Promise.race([
			navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'stream', (error) => error.name + ': ' + error.message),
			new Promise((resolve) => setTimeout(() => resolve('pending'), 8000)),
		]);
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

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	res.setHeader('content-type', 'text/html; charset=utf-8');
	if (url.pathname === '/frame') {
		const allow = url.searchParams.get('allow');
		const ask = url.searchParams.get('ask') ?? '';
		res.end(
			`<!doctype html><iframe${allow ? ` allow="${allow}"` : ''} src="${B}/probe?ask=${ask}"></iframe>`,
		);
		return;
	}
	res.end(probe);
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
	['a top-level site that asks', (base) => `${base}/probe?ask=geo,mic,notify`],
	[
		'a frame of another site that asks',
		(base) => `${base}/frame?ask=geo,mic,notify`,
	],
];

const browser = await launch();
const native = new Map();
for (const [name, url] of CASES) {
	const page = await browser.newPage();
	await page.goto(url(A));
	native.set(name, await result(() => page.frames()));
	await page.context().close();
}
const proxiedFrames = (tab) => () =>
	tab.frames().filter((frame) => /\/stomp\/[\w-]+\/html/.test(frame.url()));

const describe = (value) => JSON.stringify(value);
for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
]) {
	for (const [name, url] of CASES) {
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
			`${mode}: ${name} reads and asks as natively`,
			describe(proxied) === describe(expected),
			`\n  proxied ${describe(proxied)}\n  native  ${describe(expected)}`,
		);
		await tab.context().close();
	}

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

server.close();
await done(browser);
