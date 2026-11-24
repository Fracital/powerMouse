// A configured Chrome identity, independent of the host browser, in both demo
// modes and at both form factors. A local recorder sees navigation, fetch, XHR,
// worker and WebSocket requests; a local fake feed checks the backend's cache,
// timeout and last-good behavior. Chrome for Android's native navigator.platform
// oracle is Linux armv8l. Chromium's NavigatorID::platform reads Unix uname and
// appVersion is the UA after Mozilla/: third_party/blink/renderer/core/frame/
// navigator_id.cc.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { WebSocketServer } from 'ws';
import { createUserAgents, FALLBACK_VERSION } from '../../demo/userAgent.js';
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
	waitActive,
	waitForServer,
} from '../lib.mjs';

const FIXED =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.1234.56 Safari/537.36';
const MOBILE =
	'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.1234.56 Mobile Safari/537.36';
const HIGH_HINTS = [
	'architecture',
	'bitness',
	'formFactors',
	'fullVersionList',
	'model',
	'platformVersion',
	'uaFullVersion',
	'wow64',
];
const ACCEPT_CH = HIGH_HINTS.map(
	(name) =>
		`sec-ch-ua-${
			{
				architecture: 'arch',
				formFactors: 'form-factors',
				fullVersionList: 'full-version-list',
				platformVersion: 'platform-version',
				uaFullVersion: 'full-version',
			}[name] ?? name
		}`,
).join(', ');

async function readIdentity() {
	const data = navigator.userAgentData;
	const high = await data.getHighEntropyValues([
		'architecture',
		'bitness',
		'formFactors',
		'fullVersionList',
		'model',
		'platformVersion',
		'uaFullVersion',
		'wow64',
	]);
	const prototype =
		typeof Navigator === 'undefined'
			? WorkerNavigator.prototype
			: Navigator.prototype;
	let receiverRefused = false;
	try {
		Reflect.get(prototype, 'userAgent', {});
	} catch {
		receiverRefused = true;
	}
	let missingRefused = false;
	try {
		await data.getHighEntropyValues();
	} catch (error) {
		missingRefused = error.name === 'TypeError';
	}
	return {
		ua: navigator.userAgent,
		appVersion: navigator.appVersion,
		platform: navigator.platform,
		brands: data.brands,
		mobile: data.mobile,
		uaPlatform: data.platform,
		high,
		highKeys: Object.keys(high),
		json: data.toJSON(),
		uaDataNative: data instanceof NavigatorUAData,
		highObjectNative: Object.getPrototypeOf(high) === Object.prototype,
		descriptorsNative: ['userAgent', 'appVersion', 'platform'].every((name) => {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
			return (
				descriptor?.enumerable === true &&
				descriptor.configurable === true &&
				/native code/.test(Function.prototype.toString.call(descriptor.get))
			);
		}),
		functionsNative: [
			data.getHighEntropyValues,
			data.toJSON,
			Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'brands')?.get,
		].every((fn) => /native code/.test(Function.prototype.toString.call(fn))),
		receiverRefused,
		missingRefused,
	};
}

const requests = [];
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://fixture/');
	requests.push({
		path: url.pathname,
		query: url.search,
		headers: req.headers,
	});
	if (url.pathname === '/worker.js' || url.pathname === '/shared.js') {
		res.setHeader('content-type', 'text/javascript');
		const shared = url.pathname === '/shared.js';
		res.end(
			`${readIdentity}\n${
				shared
					? `onconnect = (event) => { (async () => {
			await fetch('/worker-fetch');
			event.ports[0].postMessage(await readIdentity());
		})(); };`
					: `(async () => {
			await fetch('/worker-fetch');
			postMessage(await readIdentity());
		})();`
			}`,
		);
		return;
	}
	if (url.pathname === '/fetch' || url.pathname === '/xhr') {
		res.setHeader('content-type', 'text/plain');
		res.end('ok');
		return;
	}
	if (url.pathname === '/worker-fetch') {
		res.end('ok');
		return;
	}
	res.setHeader('content-type', 'text/html');
	res.setHeader('accept-ch', ACCEPT_CH);
	res.end(`<!doctype html><script>
		const again = new URLSearchParams(location.search).has('again');
		if (again) {
			window.__uaResult = { done: true, again: true };
		} else {
			window.__uaResult = { done: false, again: false };
			(async () => {
				const readIdentity = ${readIdentity};
				const documentValue = await readIdentity();
				const worker = new Worker('/worker.js');
				const workerValue = await new Promise((resolve, reject) => {
					worker.onmessage = (event) => resolve(event.data);
					worker.onerror = reject;
					setTimeout(() => reject(new Error('worker timeout')), 15000);
				});
				worker.terminate();
				const shared = new SharedWorker('/shared.js');
				const sharedValue = await new Promise((resolve, reject) => {
					shared.port.onmessage = (event) => resolve(event.data);
					shared.port.onmessageerror = reject;
					shared.port.start();
					setTimeout(() => reject(new Error('shared worker timeout')), 15000);
				});
				await fetch('/fetch');
				await new Promise((resolve, reject) => {
					const xhr = new XMLHttpRequest();
					xhr.open('GET', '/xhr');
					xhr.onload = resolve;
					xhr.onerror = reject;
					xhr.send();
				});
				const socket = new WebSocket('ws://' + location.host + '/socket');
				await new Promise((resolve, reject) => {
					socket.onopen = resolve;
					socket.onerror = reject;
					setTimeout(() => reject(new Error('WebSocket timeout')), 15000);
				});
				socket.close();
				window.__uaResult = {
					done: true,
					again: false,
					document: documentValue,
					worker: workerValue,
					shared: sharedValue,
				};
			})().catch((error) => {
				window.__uaResult = { done: true, again: false, error: String(error) };
			});
		}
	</script>`);
});
const sockets = new WebSocketServer({ server, path: '/socket' });
sockets.on('connection', (socket, req) => {
	requests.push({ path: '/socket', query: '', headers: req.headers });
	socket.send('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const FIXTURE = `http://127.0.0.1:${server.address().port}`;

// The backend answers before the feed, caches a good answer, and keeps it when
// a later attempt hangs until the configured timeout.
const feedCalls = [];
let failFeed = false;
const agents = createUserAgents({
	api: 'http://versionhistory.fake/platforms',
	ttl: 30,
	timeout: 20,
	warm: false,
	fetchImpl: async (url, init) => {
		feedCalls.push(url);
		if (failFeed)
			return new Promise((_, reject) =>
				init.signal.addEventListener('abort', () =>
					reject(new Error('timed out')),
				),
			);
		const android = url.includes('/android/');
		return {
			ok: true,
			json: async () => ({
				versions: [{ version: android ? '158.0.8127.89' : '158.0.8127.88' }],
			}),
		};
	},
});
const fallback = agents.current();
ok(
	'backend: the first answer is the fixed fallback without waiting',
	fallback.desktop.includes(`Chrome/${FALLBACK_VERSION}`) &&
		fallback.mobile.includes(`Chrome/${FALLBACK_VERSION}`),
);
await agents.refresh();
const fed = agents.current();
ok(
	'backend: Linux and Android stable feeds build normal Chrome UAs',
	fed.desktop ===
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.88 Safari/537.36' &&
		fed.mobile ===
			'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.89 Mobile Safari/537.36',
	JSON.stringify(fed),
);
agents.current();
ok(
	'backend: fresh entries share one fetch per platform',
	feedCalls.length === 2,
);
failFeed = true;
await sleep(40);
const lastGood = agents.current();
const afterStale = feedCalls.length;
const duringFailure = agents.current();
await agents.refresh();
ok(
	'backend: stale visitors never wait, failures time out to last-good, and calls deduplicate',
	afterStale === 4 &&
		feedCalls.length === 4 &&
		JSON.stringify(duringFailure) === JSON.stringify(fed) &&
		JSON.stringify(lastGood) === JSON.stringify(fed),
	JSON.stringify({ afterStale, calls: feedCalls.length, duringFailure }),
);
ok(
	'backend: disabled and fixed configurations need no feed',
	createUserAgents({ enabled: false }).current() === null &&
		createUserAgents({ override: FIXED, warm: false }).current().desktop ===
			FIXED &&
		createUserAgents({ override: FIXED, warm: false }).current().mobile ===
			MOBILE,
);

const configText = await (await fetch(`${PROXY}config.js`)).text();
const config = JSON.parse(
	configText.slice(configText.indexOf('{'), configText.lastIndexOf('}') + 1),
);
ok(
	'/config.js carries the exact fixed desktop UA and its Android counterpart',
	config.userAgent?.desktop === FIXED && config.userAgent?.mobile === MOBILE,
	JSON.stringify(config.userAgent),
);

function expected(mobile) {
	const userAgent = mobile ? MOBILE : FIXED;
	return {
		ua: userAgent,
		appVersion: userAgent.slice(userAgent.indexOf('/') + 1),
		platform: mobile ? 'Linux armv8l' : 'Linux x86_64',
		brands: [
			{ brand: 'Not/A)Brand', version: '8' },
			{ brand: 'Chromium', version: '150' },
			{ brand: 'Google Chrome', version: '150' },
		],
		mobile,
		uaPlatform: mobile ? 'Android' : 'Linux',
		high: {
			brands: [
				{ brand: 'Not/A)Brand', version: '8' },
				{ brand: 'Chromium', version: '150' },
				{ brand: 'Google Chrome', version: '150' },
			],
			mobile,
			platform: mobile ? 'Android' : 'Linux',
			architecture: mobile ? '' : 'x86',
			bitness: mobile ? '' : '64',
			formFactors: [mobile ? 'Mobile' : 'Desktop'],
			fullVersionList: [
				{ brand: 'Not/A)Brand', version: '8.0.0.0' },
				{ brand: 'Chromium', version: '150.0.1234.56' },
				{ brand: 'Google Chrome', version: '150.0.1234.56' },
			],
			model: '',
			platformVersion: mobile ? '10.0.0' : '',
			uaFullVersion: '150.0.1234.56',
			wow64: false,
		},
	};
}

const same = isDeepStrictEqual;
const quoted = (value) => `"${value}"`;
const brandHeader = (brands) =>
	brands
		.map(({ brand, version }) => `${quoted(brand)};v=${quoted(version)}`)
		.join(', ');
function checkRequest(name, record, mobile, high) {
	const want = expected(mobile);
	const headers = record?.headers ?? {};
	ok(
		`${name}: the configured UA and low-entropy hints reach upstream`,
		headers['user-agent'] === want.ua &&
			headers['sec-ch-ua'] === brandHeader(want.brands) &&
			headers['sec-ch-ua-mobile'] === (mobile ? '?1' : '?0') &&
			headers['sec-ch-ua-platform'] === quoted(want.uaPlatform),
		JSON.stringify(headers),
	);
	if (high)
		ok(
			`${name}: high-entropy hints use the same identity`,
			headers['sec-ch-ua-full-version'] === quoted('150.0.1234.56') &&
				headers['sec-ch-ua-full-version-list'] ===
					brandHeader(want.high.fullVersionList) &&
				headers['sec-ch-ua-arch'] === quoted(want.high.architecture) &&
				headers['sec-ch-ua-bitness'] === quoted(want.high.bitness) &&
				headers['sec-ch-ua-model'] === '""' &&
				headers['sec-ch-ua-platform-version'] ===
					quoted(want.high.platformVersion) &&
				headers['sec-ch-ua-wow64'] === '?0' &&
				headers['sec-ch-ua-form-factors'] === quoted(want.high.formFactors[0]),
			JSON.stringify(headers),
		);
}

const browser = await launch();
const errors = [];
let offServer;
try {
	for (const mobile of [false, true])
		for (const [mode, base] of [
			['same-origin', PROXY],
			['isolated', HOST],
		]) {
			const label = `${mode} ${mobile ? 'Android' : 'desktop'}`;
			const before = requests.length;
			const context = mobile
				? await browser.newContext({
						viewport: { width: 390, height: 844 },
						hasTouch: true,
						isMobile: true,
					})
				: browser;
			const page = await openDemo(context, base);
			if (mobile)
				ok(
					`${label}: the existing coarse-pointer signal selects Android`,
					await page.evaluate(
						() => matchMedia('(hover: none) and (pointer: coarse)').matches,
					),
				);
			const target = `${FIXTURE}/?case=${mobile ? 'mobile' : 'desktop'}-${mode}`;
			const nativeShape = await page.evaluate(readIdentity);
			await submitLanding(page, target);
			const frame = await waitActive(
				page,
				() => window.__uaResult?.done === true,
			);
			const result = await frame.evaluate(() => window.__uaResult);
			const want = expected(mobile);
			ok(
				`${label}: document navigator and low/high UA-CH are coherent`,
				!result.error &&
					same(
						{
							ua: result.document.ua,
							appVersion: result.document.appVersion,
							platform: result.document.platform,
							brands: result.document.brands,
							mobile: result.document.mobile,
							uaPlatform: result.document.uaPlatform,
							high: result.document.high,
							json: result.document.json,
						},
						{
							...want,
							json: { brands: want.brands, mobile, platform: want.uaPlatform },
						},
					),
				JSON.stringify(result),
			);
			ok(
				`${label}: native navigator objects, descriptors, key order and validation remain`,
				result.document.uaDataNative &&
					result.document.highObjectNative &&
					result.document.descriptorsNative &&
					result.document.functionsNative &&
					result.document.receiverRefused &&
					result.document.missingRefused &&
					same(result.document.highKeys, nativeShape.highKeys),
				JSON.stringify(result.document),
			);
			ok(
				`${label}: dedicated and shared workers share the document identity`,
				same(result.worker, result.document) &&
					same(result.shared, result.document),
				JSON.stringify({ worker: result.worker, shared: result.shared }),
			);
			const made = requests.slice(before);
			const navigation = made.find(
				(entry) => entry.path === '/' && entry.query.includes('case='),
			);
			checkRequest(`${label} first navigation`, navigation, mobile, false);
			for (const path of ['/fetch', '/xhr', '/worker-fetch'])
				checkRequest(
					`${label} ${path}`,
					made.find((entry) => entry.path === path),
					mobile,
					path !== '/worker-fetch',
				);
			checkRequest(
				`${label} WebSocket`,
				made.find((entry) => entry.path === '/socket'),
				mobile,
				false,
			);
			const secondStarts = requests.length;
			await submitOmni(page, `${target}&again=1`);
			await waitActive(page, () => window.__uaResult?.again === true);
			checkRequest(
				`${label} accepted navigation`,
				requests
					.slice(secondStarts)
					.find(
						(entry) => entry.path === '/' && entry.query.includes('again=1'),
					),
				mobile,
				true,
			);
			errors.push(...page.errors.map((error) => `${label}: ${error}`));
			await page.close();
			if (mobile) await context.close();
		}

	// With the option absent, the demo and library leave the host identity alone.
	const probe = createServer();
	const offPort = await new Promise((resolve, reject) => {
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
	const env = {
		...process.env,
		PORT: String(offPort),
		STOMP_LIVE_USER_AGENT: '0',
		STOMP_ADBLOCK: '0',
		STOMP_DIALING: '0',
		STOMP_DEFAULT_THEMES: '0',
		WISP_ALLOW_LOOPBACK: '1',
	};
	delete env.STOMP_USER_AGENT;
	offServer = spawn(
		process.execPath,
		[fileURLToPath(new URL('../../demo/server.js', import.meta.url))],
		{ env, stdio: ['ignore', 'ignore', 'inherit'] },
	);
	const off = `http://127.0.0.1:${offPort}/`;
	await waitForServer(`${off}api/status`);
	const offConfig = await (await fetch(`${off}config.js`)).text();
	ok('unset: /config.js has no userAgent', !offConfig.includes('"userAgent"'));
	const page = await openDemo(browser, off);
	const native = await page.evaluate(readIdentity);
	await submitLanding(page, `${FIXTURE}/?unset=1`);
	const frame = await waitActive(page, () => window.__uaResult?.done === true);
	const result = await frame.evaluate(() => window.__uaResult);
	ok(
		'unset: document and worker identities stay native',
		same(result.document, native) &&
			same(result.worker, native) &&
			same(result.shared, native),
		JSON.stringify({ native, result }),
	);
	errors.push(...page.errors.map((error) => `unset: ${error}`));
	await page.close();
} catch (error) {
	ok('user-agent suite completed', false, error.stack || String(error));
} finally {
	offServer?.kill();
	sockets.close();
	server.close();
}
await done(browser, errors);
