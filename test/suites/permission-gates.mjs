// The APIs a permission gates, and the device APIs, per proxied site
// (src/inject/permissionGates.ts, src/inject/deviceGrants.ts,
// docs/permissions.md), against Chrome in both modes. The browser keeps one
// grant for every proxied site, so the proxied runs give the proxy origin
// each permission first, as if another site had been granted it, and the
// site under test was never asked: where the host is asked about it, the
// user blocks it (the demo's prompt). Natively the same page runs on an
// origin that was refused each permission (or never asked, where an API
// does not ask: a notification, persist(), the permission elements), and
// the proxied page must read what it reads:
//
// - getScreenDetails, queryLocalFonts, requestMIDIAccess, Clipboard read
//   and readText, the callback getUserMedia and webkitGetUserMedia and a
//   SpeechRecognition's start: each used the proxy origin's grant;
// - a notification (window and dedicated worker): shown on the proxy
//   origin's grant where natively it fires error, and its icon, image and
//   badge read the proxy's URLs; a worker's Notification.permission read
//   the proxy origin's `granted`;
// - navigator.storage.persist() and persisted(), on the proxy origin's;
// - <geolocation autolocate>: delivered the position on the proxy origin's
//   grant, with permissionStatus `granted`;
// - navigator.usb, .hid and .serial in a document and a worker (no device
//   to choose: what is listed, and requestDevice without a gesture).
//
// Web Bluetooth, with its emulated adapter, is bluetooth-grants.
import { createServer } from 'node:http';
import {
	done,
	HOST,
	launch,
	NO_AUDIO,
	ok,
	openDemo,
	PROXY,
	sleep,
	submitLanding,
} from '../lib.mjs';

const describe = (value) => JSON.stringify(value);

// what the page asks, each answer as the page reads it
const probe = `<!doctype html><meta charset=utf-8><title>gates</title><body>
<geolocation id=g autolocate></geolocation>
<script>
const E = (e) => e && (Object.prototype.toString.call(e) + ' ' + e.name + ': ' + e.message);
const late = (p, ms = 6000) => Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), ms))]);
window.__events = [];
g.addEventListener('location', () => __events.push('location'));
const notify = (options) => new Promise((resolve) => {
	try {
		const n = new Notification('title', options);
		const read = () => ['title', 'body', 'tag', 'icon', 'image', 'badge', 'dir', 'lang', 'renotify', 'silent', 'requireInteraction', 'data'].map((k) => k + '=' + JSON.stringify(n[k])).join(' ') + ' vibrate=' + JSON.stringify(n.vibrate) + ' actions=' + n.actions.length + ' ts=' + typeof n.timestamp + ' instance=' + (n instanceof Notification) + ' ' + Object.prototype.toString.call(n);
		n.onshow = () => { resolve('show ' + read()); n.close(); };
		n.onerror = (e) => resolve('error ' + e.type + ' ' + read());
		setTimeout(() => resolve('pending ' + read()), 4000);
	} catch (e) { resolve('threw ' + E(e)); }
});
const legacy = (name) => new Promise((resolve) => {
	try { navigator[name]({ audio: true }, (s) => { s.getTracks().forEach((t) => t.stop()); resolve('stream'); }, (e) => resolve('callback ' + E(e))); } catch (e) { resolve('threw ' + E(e)); }
	setTimeout(() => resolve('pending'), 8000);
});
const RUN = {
	screen: async () => { try { return (await late(getScreenDetails())).screens.length + ' screens'; } catch (e) { return E(e); } },
	fonts: async () => { try { const fonts = await late(queryLocalFonts()); return Array.isArray(fonts) ? fonts.length + ' fonts' : fonts; } catch (e) { return E(e); } },
	midi: async () => { try { return String(await late(navigator.requestMIDIAccess())); } catch (e) { return E(e); } },
	readText: async () => { try { return 'text ' + await late(navigator.clipboard.readText()); } catch (e) { return E(e); } },
	read: async () => { try { return 'items ' + (await late(navigator.clipboard.read())).length; } catch (e) { return E(e); } },
	getUserMedia: () => legacy('getUserMedia'),
	webkitGetUserMedia: () => legacy('webkitGetUserMedia'),
	legacyArguments: () => { const out = []; for (const args of [[{ audio: true }], [{ audio: true }, 1, () => {}], [{ audio: true }, () => {}, null]]) try { navigator.getUserMedia(...args); out.push('ok'); } catch (e) { out.push(E(e)); } return out.join(' | '); },
	speech: () => new Promise((resolve) => {
		const events = [];
		const done = () => resolve(events.join(','));
		try {
			const s = new webkitSpeechRecognition();
			for (const t of ['start', 'audiostart', 'error', 'end']) s.addEventListener(t, (e) => { events.push(t + (e.error ? ':' + e.error + ':' + JSON.stringify(e.message) : '')); if (t === 'end' || t === 'audiostart') done(); });
			s.start();
			try { s.start(); } catch (e) { events.push('again ' + E(e)); }
		} catch (e) { events.push(E(e)); }
		setTimeout(() => { events.push('timeout'); done(); }, 8000);
	}),
	notification: () => notify({ tag: 'x', body: 'b', icon: 'icon.png', image: '/image.png', badge: 'http://[', dir: 'rtl', lang: 'fr', data: { a: 1 }, vibrate: [1, 2], requireInteraction: true }),
	notificationPlain: () => notify(undefined),
	notificationChecks: async () => [await notify({ actions: [{ action: 'a', title: 't' }] }), await notify({ renotify: true }), await notify({ silent: true, vibrate: 5 }), await notify({ dir: 'up' })].join(' | '),
	notificationPermission: () => Notification.permission,
	persist: async () => { try { return String(await navigator.storage.persist()) + ' ' + String(await navigator.storage.persisted()); } catch (e) { return E(e); } },
	element: () => new Promise((resolve) => setTimeout(() => resolve({ events: __events.join(), position: g.position && g.position.coords.latitude, status: g.permissionStatus, initial: g.initialPermissionStatus }), 2000)),
	// (each request once the last gesture's activation is over)
	devices: async () => { const out = { noGesture: {} }; await new Promise((r) => setTimeout(r, 5500)); for (const [k, f] of Object.entries({ usb: () => navigator.usb.requestDevice({ filters: [] }), hid: () => navigator.hid.requestDevice({ filters: [] }), serial: () => navigator.serial.requestPort() })) { try { await late(f(), 3000); out.noGesture[k] = 'resolved'; } catch (e) { out.noGesture[k] = E(e); } } for (const [k, f] of Object.entries({ usb: () => navigator.usb.getDevices(), hid: () => navigator.hid.getDevices(), serial: () => navigator.serial.getPorts() })) { try { out[k] = (await f()).length; } catch (e) { out[k] = E(e); } } return out; },
	worker: () => new Promise((resolve) => { const w = new Worker('/worker.js'); w.onmessage = (e) => resolve(e.data); setTimeout(() => resolve('timeout'), 8000); }),
	// a site granted notifications: what its worker reads once its states are in
	granted: async () => { const asked = await Notification.requestPermission(); const r = await RUN.worker(); return asked + ' ' + r.later + ' ' + r.shown; },
};
window.run = async (name) => RUN[name]();
window.__ready = true;
</script>`;

const worker = `
const E = (e) => e && (e.name + ': ' + e.message);
(async () => {
	const r = { permission: Notification.permission };
	await new Promise((resolve) => setTimeout(resolve, 500));
	r.later = Notification.permission;
	try { const n = new Notification('w', { tag: 't', icon: 'icon.png' }); r.icon = n.icon; r.tag = n.tag; r.shown = await new Promise((res) => { n.onshow = () => res('show'); n.onerror = () => res('error'); setTimeout(() => res('pending'), 4000); }); } catch (e) { r.shown = E(e); }
	for (const [k, f] of Object.entries({ usb: () => navigator.usb.getDevices(), hid: () => navigator.hid.getDevices(), serial: () => navigator.serial.getPorts() })) { try { r[k] = (await f()).length; } catch (e) { r[k] = E(e); } }
	postMessage(r);
})();`;

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x/');
	if (url.pathname === '/worker.js') {
		res.setHeader('content-type', 'text/javascript; charset=utf-8');
		return res.end(worker);
	}
	if (url.pathname.endsWith('.png')) {
		res.setHeader('content-type', 'image/png');
		return res.end();
	}
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.end(probe);
});
// every interface: localhost may resolve to ::1 for the demo's wisp
await new Promise((resolve) => server.listen(0, resolve));
const A = `http://127.0.0.1:${server.address().port}`;
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];

/** each permission as Browser.setPermission names it, for an origin of the page's context */
async function setPermissions(browser, page, origin, names, setting) {
	const session = await page.context().newCDPSession(page);
	const { targetInfo } = await session.send('Target.getTargetInfo');
	await session.detach();
	const cdp = await browser.newBrowserCDPSession();
	for (const name of names)
		await cdp.send('Browser.setPermission', {
			permission: typeof name === 'string' ? { name } : name,
			setting,
			origin,
			browserContextId: targetInfo.browserContextId,
		});
	// (kept: the browser drops a session's overrides when it detaches)
}
const ASKED = [
	'window-management',
	'local-fonts',
	'midi',
	'clipboard-read',
	'microphone',
];
// what the proxy origin holds: every permission above, notifications,
// persistent storage and geolocation (none of which the site asks for)
const HELD = [
	...ASKED,
	'notifications',
	'persistent-storage',
	'geolocation',
	'camera',
];
const CHECKS = [
	'devices',
	'screen',
	'fonts',
	'midi',
	'readText',
	'read',
	'getUserMedia',
	'webkitGetUserMedia',
	'legacyArguments',
	'speech',
	'notification',
	'notificationPlain',
	'notificationChecks',
	'notificationPermission',
	'persist',
	'element',
	'worker',
];
// (a notification's timestamp is the time it was made: only its type is read)

const frameOf = async (page, title, ready = '__ready') => {
	for (let i = 0; i < 160; i++) {
		for (const frame of page.frames().reverse())
			if (
				(await frame.evaluate(() => document.title).catch(() => '')) ===
					title &&
				(await frame.evaluate((r) => !!window[r], ready).catch(() => false))
			)
				return frame;
		await sleep(250);
	}
	return null;
};

const browser = await launch(['--use-fake-device-for-media-stream'], {
	env: NO_AUDIO,
});
// natively: an origin refused what it asks for, and never asked the rest
const nativeContext = await browser.newContext({
	geolocation: { latitude: 12, longitude: 34 },
});
const nativePage = await nativeContext.newPage();
await setPermissions(browser, nativePage, A, ASKED, 'denied');
await nativePage.goto(`${A}/gates`);
await nativePage.bringToFront();
await nativePage.waitForFunction(() => window.__ready);
const native = {};
for (const name of CHECKS)
	native[name] = await nativePage.evaluate((n) => window.run(n), name);
await nativeContext.close();
// natively: an origin granted notifications
const grantedContext = await browser.newContext();
const grantedPage = await grantedContext.newPage();
await setPermissions(browser, grantedPage, A, ['notifications'], 'granted');
await grantedPage.goto(`${A}/gates`);
await grantedPage.waitForFunction(() => window.__ready);
native.granted = await grantedPage.evaluate(() => window.run('granted'));
await grantedContext.close();
ok(
	'natively, each request is refused and the notification not shown',
	/NotAllowedError/.test(native.screen) &&
		/^error /.test(native.notification) &&
		native.element?.position === null,
	describe(native).slice(0, 2000),
);

for (const [mode, base] of MODES) {
	const tab = await openDemo(browser, base);
	await tab.context().setGeolocation({ latitude: 12, longitude: 34 });
	// another site was granted all of it: the proxy origin holds it
	await setPermissions(browser, tab, new URL(base).origin, HELD, 'granted');
	const held = await tab.evaluate(async () => ({
		geolocation: (await navigator.permissions.query({ name: 'geolocation' }))
			.state,
		notifications: Notification.permission,
	}));
	ok(
		`${mode}: the browser holds the permissions for the proxy origin`,
		held.geolocation === 'granted' && held.notifications === 'granted',
		describe(held),
	);
	await submitLanding(tab, `${A}/gates`);
	const frame = await frameOf(tab, 'gates');
	const proxied = {};
	// (before the host's prompt is watched: what reads the host's page
	// gives it an activation, which a same-origin frame shares)
	proxied.devices = frame
		? await frame.evaluate(() => window.run('devices')).catch(String)
		: null;
	// the user blocks every site the host asks about (and at the end
	// allows its notifications)
	let answering = true;
	let answer = '.block';
	const prompts = [];
	void (async () => {
		while (answering) {
			const button = await tab
				.$(`#permissionPrompt ${answer}`)
				.catch(() => null);
			if (button) {
				prompts.push(
					await tab
						.evaluate(
							() => document.querySelector('#permissionPrompt p')?.textContent,
						)
						.catch(() => ''),
				);
				await button.click().catch(() => {});
			}
			await sleep(150);
		}
	})();
	for (const name of CHECKS) {
		if (name === 'devices') continue;
		// the clipboard reads a focused document's, as the native page is
		if (/^read/.test(name))
			await tab
				.evaluate(() => document.querySelector('.frame:not(.hidden)')?.focus())
				.catch(() => {});
		proxied[name] = frame
			? await frame.evaluate((n) => window.run(n), name).catch(String)
			: null;
	}
	// a site the user let show notifications: its worker asks the service
	// worker's route as that site (Chrome never prompts a frame of another
	// origin for notifications: same-origin mode only)
	if (mode === 'same-origin') {
		answer = '.allow';
		proxied.granted = frame
			? await frame.evaluate(() => window.run('granted')).catch(String)
			: null;
		ok(
			`${mode}: a site granted notifications: its worker reads granted and shows one, as natively`,
			describe(proxied.granted) === describe(native.granted),
			`\n  proxied ${describe(proxied.granted)}\n  native  ${describe(native.granted)}`,
		);
	}
	answering = false;
	for (const name of CHECKS) {
		// a URL the page wrote reads its own origin, the proxy's natively
		const want = describe(native[name]);
		const got = describe(proxied[name]);
		ok(
			`${mode}: ${name}: a site that was not granted reads what a refused origin reads natively`,
			want === got,
			`\n  proxied ${got}\n  native  ${want}`,
		);
	}
	ok(
		`${mode}: the host was asked for this site (and blocked it), never the browser`,
		prompts.length > 0 && prompts.every((p) => p.startsWith('127.0.0.1:')),
		describe(prompts),
	);
	await tab.context().close();
}
server.close();
await done(browser);
