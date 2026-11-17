// Web Bluetooth per proxied site (src/inject/deviceGrants.ts,
// docs/permissions.md "Devices"), with Chrome's emulated adapter
// (BluetoothEmulation, the chooser answered through DeviceAccess; behind
// its flags, as on Linux): natively each origin lists, names and forgets
// its own device and reaches the services it named; before, proxied site B
// listed the device site A chose, read A's id for it, reached the services
// A named, and its forget() took A's device away.
import { createServer } from 'node:http';
import {
	done,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	submitLanding,
	submitOmni,
	waitForServer,
} from '../lib.mjs';

const describe = (value) => JSON.stringify(value);

// a page for Web Bluetooth: window.bt(op, ...)
const bluetooth = `<!doctype html><meta charset=utf-8><title>bluetooth</title><script>
const E = (e) => e && (e.name + ': ' + e.message);
let device = null;
const OPS = {
	request: async (options) => { try { device = await navigator.bluetooth.requestDevice(options); return { id: device.id, name: device.name }; } catch (e) { return E(e); } },
	list: async () => { try { return (await navigator.bluetooth.getDevices()).map((d) => d.id + ' ' + d.name + (d === device ? ' (held)' : '')); } catch (e) { return E(e); } },
	services: async () => {
		const d = device ?? (await navigator.bluetooth.getDevices())[0];
		if (!d) return 'no device';
		const out = {};
		try { await d.gatt.connect(); out.connect = 'ok'; } catch (e) { out.connect = E(e); }
		try { out.all = (await d.gatt.getPrimaryServices()).map((s) => s.uuid).sort().join(); } catch (e) { out.all = E(e); }
		for (const name of ['heart_rate', 'battery_service']) try { out[name] = (await d.gatt.getPrimaryService(name)).uuid; } catch (e) { out[name] = E(e); }
		try { d.gatt.disconnect(); } catch {}
		return out;
	},
	forget: async () => { const d = device ?? (await navigator.bluetooth.getDevices())[0]; if (!d) return 'no device'; try { await d.forget(); return 'forgot ' + (await navigator.bluetooth.getDevices()).length; } catch (e) { return E(e); } },
};
window.bt = (op, ...args) => OPS[op](...args);
window.__ready = true;
</script>`;

const server = createServer((req, res) => {
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.end(bluetooth);
});
// every interface: localhost may resolve to ::1 for the demo's wisp
await new Promise((resolve) => server.listen(0, resolve));
const A = `http://127.0.0.1:${server.address().port}`;
const B = `http://localhost:${server.address().port}`;
const MODES = [
	['same-origin', PROXY],
	['isolated', HOST],
];

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

// Web Bluetooth with the emulated adapter: site A chooses the device
// naming the battery service, site B the same device naming none
const FLAGS = [
	'--enable-experimental-web-platform-features',
	'--enable-features=WebBluetooth,WebBluetoothNewPermissionsBackend',
];
const ADDRESS = '09:09:09:09:09:09';
/** the emulated adapter, once a browser, with the device and its two services */
let emulation = null;
async function adapter(browser) {
	// (a new adapter for each walk: the last walk's ends with it)
	if (emulation) {
		await emulation.send('BluetoothEmulation.disable').catch(() => {});
		await emulation.detach().catch(() => {});
	}
	const session = (emulation = await browser.newBrowserCDPSession());
	await session.send('BluetoothEmulation.enable', {
		state: 'powered-on',
		leSupported: true,
	});
	await session.send('BluetoothEmulation.simulatePreconnectedPeripheral', {
		address: ADDRESS,
		name: 'Heart Rate',
		manufacturerData: [],
		knownServiceUuids: ['0000180d-0000-1000-8000-00805f9b34fb'],
	});
	for (const uuid of ['0000180d', '0000180f'])
		await session.send('BluetoothEmulation.addService', {
			address: ADDRESS,
			serviceUuid: `${uuid}-0000-1000-8000-00805f9b34fb`,
		});
	session.on('BluetoothEmulation.gattOperationReceived', (event) =>
		session
			.send('BluetoothEmulation.simulateGATTOperationResponse', {
				address: event.address,
				type: event.type,
				code: 0,
			})
			.catch(() => {}),
	);
}
/** a tab's chooser answered with its device, once the scan lists it */
// (one set for every session: a prompt answered twice ends the browser)
const answered = new Set();
/** a tab's (or an out-of-process frame's) chooser answered with its device */
async function chooser(page) {
	const context = (page.context ? page : page.page()).context();
	const session = await context.newCDPSession(page);
	await session.send('DeviceAccess.enable');
	session.on('DeviceAccess.deviceRequestPrompted', (event) => {
		const device = event.devices[0];
		// the emulated device is listed by the scan's start only: it
		// advertises again, as a real one keeps doing
		if (!device)
			emulation
				?.send('BluetoothEmulation.simulateAdvertisement', {
					entry: {
						deviceAddress: ADDRESS,
						rssi: -50,
						scanRecord: {
							name: 'Heart Rate',
							uuids: ['0000180d-0000-1000-8000-00805f9b34fb'],
						},
					},
				})
				.catch((error) => console.log(`advertisement: ${error.message}`));
		// once a prompt: a second answer ends the browser (a check fails)
		if (device && !answered.has(event.id) && answered.add(event.id))
			session
				.send('DeviceAccess.selectPrompt', {
					id: event.id,
					deviceId: device.id,
				})
				.catch(() => {});
	});
}
const REQUESTS = {
	A: {
		filters: [{ name: 'Heart Rate' }],
		optionalServices: ['battery_service'],
	},
	B: { filters: [{ name: 'Heart Rate' }] },
};
/** the steps, in one context: `at(site)` is the page of that site */
async function walk(at) {
	const out = {};
	// (the emulated scan can end the first chooser: asked again once)
	const request = async (bt, site) => {
		let answer = await bt('request', REQUESTS[site]);
		if (typeof answer === 'string' && /cancelled/.test(answer))
			answer = await bt('request', REQUESTS[site]);
		return answer;
	};
	let bt = await at('A');
	out.aRequest = await request(bt, 'A');
	out.aList = await bt('list');
	out.aServices = await bt('services');
	bt = await at('B');
	out.bListFirst = await bt('list');
	out.bRequest = await request(bt, 'B');
	out.bList = await bt('list');
	out.bServices = await bt('services');
	// a new document of each lists what its site kept
	bt = await at('A');
	out.aListAgain = await bt('list');
	bt = await at('B');
	out.bForget = await bt('forget');
	bt = await at('A');
	out.aListAfter = await bt('list');
	return out;
}
// ids differ by origin: what is compared is which are the same
const shape = (out) => {
	const id = (value) =>
		typeof value === 'object' && value ? value.id : String(value);
	const a = id(out.aRequest);
	const b = id(out.bRequest);
	// the emulated device's name is the first chooser's only: a second
	// chooser of the browser's origin empties it (natively A's after B's;
	// proxied, B's, which is the same origin's): names count in A's first
	// list and request only
	const name = (list, named = false) =>
		Array.isArray(list)
			? list.map((entry) =>
					(named ? entry : entry.replace(' Heart Rate', ' '))
						.replace(a, a === b ? 'SAME' : 'A-ID')
						.replace(b, a === b ? 'SAME' : 'B-ID'),
				)
			: list;
	return {
		aRequest: out.aRequest?.name ?? out.aRequest,
		sameId: a === b,
		idShape: /^[A-Za-z0-9+/]{22}==$/.test(a) && /^[A-Za-z0-9+/]{22}==$/.test(b),
		aList: name(out.aList, true),
		aServices: out.aServices,
		bListFirst: name(out.bListFirst),
		bRequest: typeof out.bRequest === 'object' ? 'a device' : out.bRequest,
		bList: name(out.bList),
		bServices: out.bServices,
		aListAgain: name(out.aListAgain),
		bForget: out.bForget,
		aListAfter: name(out.aListAfter),
	};
};
const browser = await launch(FLAGS);
await adapter(browser);
{
	// each step a new document of its site, in a tab of its own
	const context = await browser.newContext();
	const pages = {};
	const at = async (site) => {
		if (!pages[site]) {
			pages[site] = await context.newPage();
			await chooser(pages[site]);
		}
		await pages[site].goto(`${site === 'A' ? A : B}/bluetooth`);
		await pages[site].waitForFunction(() => window.__ready);
		await pages[site].bringToFront();
		return (op, ...args) =>
			pages[site].evaluate(([o, a]) => window.bt(o, ...a), [op, args]);
	};
	const native = shape(await walk(at));
	await context.close();
	ok(
		'natively, each origin lists, names and forgets its own device',
		native.aRequest === 'Heart Rate' &&
			native.bRequest === 'a device' &&
			!native.sameId &&
			native.idShape &&
			native.bListFirst?.length === 0 &&
			native.aListAfter?.length === 1,
		describe(native),
	);
	for (const [mode, base] of MODES) {
		await adapter(browser);
		// each site in a tab of its own, as natively, in one profile (the
		// service worker's)
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const tabs = {};
		const sessions = new Set();
		const at = async (site) => {
			const url = `${site === 'A' ? A : B}/bluetooth`;
			let page = tabs[site];
			if (!page) {
				page = tabs[site] = await context.newPage();
				await waitForServer(base);
				await page.goto(base);
				await page.waitForFunction(
					() =>
						/^(Ready|Error)/.test(
							document.getElementById('logMsg').textContent,
						),
					null,
					{ timeout: 45000 },
				);
				await chooser(page);
				await submitLanding(page, url);
			} else await submitOmni(page, url);
			await page.bringToFront();
			await sleep(500);
			const frame = await frameOf(page, 'bluetooth');
			// a frame in a process of its own (isolation mode) has its own
			// prompts
			if (frame && !sessions.has(frame)) {
				sessions.add(frame);
				await chooser(frame).catch(() => {});
			}
			// (a step that never answers is the step's answer)
			return (op, ...args) =>
				Promise.race([
					frame
						? frame.evaluate(([o, a]) => window.bt(o, ...a), [op, args])
						: 'no frame',
					sleep(20000).then(() => `${op}: no answer`),
				]);
		};
		const proxied = shape(await walk(at));
		ok(
			`${mode}: Web Bluetooth: each site lists, names and forgets its own device, as natively`,
			describe(proxied) === describe(native),
			`\n  proxied ${describe(proxied)}\n  native  ${describe(native)}`,
		);
		await context.close();
	}
}
server.close();
await done(browser);
