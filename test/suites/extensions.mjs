// Chrome extensions on STomp (docs/extensions.md), in both host modes, with
// no network: an MV3 probe installed as an unpacked file map and an MV2
// blocker installed as a .zip Blob, both built here.
// - content scripts at document_start (once the page's root is written,
//   before its first script), document_end and document_idle, MAIN and
//   ISOLATED worlds, their CSS, under a page that requires Trusted Types;
// - the page never sees the extension's `chrome`, and `self.chrome` in an
//   isolated world is the extension's;
// - messaging (sendMessage, tabs.sendMessage, ports) with its latency,
//   chrome.storage, the action's badge, the popup and the options page;
// - the background service worker's relative importScripts and fetch;
// - blocking webRequest (cancel, redirect, response headers) and onCompleted;
// - declarativeNetRequest in the worker's DnrHost: a static rule blocks, a
//   dynamic one redirects to an extensionPath, the calls answer, matches
//   carry the tab and frame ids, and a disabled extension's rules stop;
// - extension pages' cross-origin XHR through the transport, the cookies API
//   on STomp's jar;
// - no runtime request on a page no extension reaches; disable, remove and
//   the errors install() throws;
// - a third probe for what extensions found missing against Chrome: a
//   localized getManifest, the user script world's runtime, tabs' and
//   webNavigation's events, a web accessible script under the page's CSP,
//   executeScript into a sandboxed frame, a popup sized to its content.
import { crc32, deflateRawSync } from 'node:zlib';
import {
	done,
	FIXTURE,
	HOST,
	launch,
	ok,
	PROXY,
	sleep,
	waitForServer,
} from '../lib.mjs';

/** a ZIP of `files`: deflated, but the .txt files stored */
function zip(files) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const stored = name.endsWith('.txt');
		const body = stored ? data : deflateRawSync(data);
		const nameBytes = Buffer.from(name);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(stored ? 0 : 8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(stored ? 0 : 8, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, body);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const target = `${FIXTURE}pages/ext-target.html`;
const trusted = `${FIXTURE}pages/ext-tt.html`;
// (on localhost: the probe's host permissions are 127.0.0.1's, so no
// extension can reach it)
const other = `${FIXTURE.replace('127.0.0.1', 'localhost')}pages/ext-other.html`;
const plain = `${FIXTURE}pages/ext-plain.txt`;
const pages = ['*://*/pages/ext-target.html*', '*://*/pages/ext-tt.html*'];

const median = `const median = (list) => [...list].sort((a, b) => a - b)[list.length >> 1];`;

// the MV3 probe, as an unpacked file map
const probe = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Probe Three',
		version: '1.0',
		permissions: [
			'storage',
			'scripting',
			'tabs',
			'cookies',
			'declarativeNetRequest',
			'declarativeNetRequestFeedback',
		],
		host_permissions: ['http://127.0.0.1/*'],
		background: { service_worker: 'bg/sw.js' },
		declarative_net_request: {
			rule_resources: [{ id: 'static', enabled: true, path: 'rules.json' }],
		},
		action: { default_popup: 'popup.html', default_title: 'Probe' },
		options_page: 'options.html',
		content_scripts: [
			{
				matches: pages,
				js: ['cs/main.js'],
				run_at: 'document_start',
				world: 'MAIN',
			},
			{ matches: pages, js: ['cs/start.js'], run_at: 'document_start' },
			{ matches: pages, js: ['cs/end.js'], run_at: 'document_end' },
			{
				matches: pages,
				js: ['cs/idle.js'],
				css: ['cs/style.css'],
				run_at: 'document_idle',
			},
			{
				matches: ['*://*/pages/ext-data.json*'],
				js: ['cs/text.js'],
				run_at: 'document_end',
			},
		],
		web_accessible_resources: [
			{ resources: ['war.txt'], matches: ['<all_urls>'] },
		],
	}),
	'war.txt': 'accessible',
	'cs/text.js': `const pre = document.querySelector('body > pre');
	document.documentElement.dataset.text = JSON.stringify({
		type: document.contentType, title: document.title,
		first: document.body?.firstElementChild?.tagName, text: pre?.textContent,
		id: chrome.runtime.id });`,
	'rules.json': JSON.stringify([
		{
			id: 1,
			action: { type: 'block' },
			condition: {
				urlFilter: 'ext-plain.txt?dnr-static',
				resourceTypes: ['xmlhttprequest'],
			},
		},
		// allow rules, matched only for the requests' tab and frame ids
		// (onRuleMatchedDebug)
		{
			id: 3,
			action: { type: 'allow' },
			condition: {
				urlFilter: 'pages/ext-target.html',
				resourceTypes: ['main_frame'],
			},
		},
		{
			id: 4,
			action: { type: 'allow' },
			condition: {
				urlFilter: '?ext-tab-probe=',
				resourceTypes: ['sub_frame', 'xmlhttprequest'],
			},
		},
	]),
	'cs/main.js': `window.__mainRan = typeof chrome === 'object' && chrome && chrome.storage ? 'leaked' : 'page-chrome';`,
	'cs/start.js': `document.documentElement.dataset.start = JSON.stringify({
		chrome: typeof chrome, id: chrome.runtime.id, self: self.chrome === chrome,
		window: window.chrome === chrome, globalThis: globalThis.chrome === chrome,
		root: !!document.documentElement, ready: document.readyState });`,
	'cs/end.js': `document.documentElement.dataset.end = JSON.stringify({
		ready: document.readyState, target: !!document.getElementById('target') });`,
	'cs/style.css': '#target { color: rgb(1, 2, 3) }',
	'cs/idle.js': `${median}
	const out = {};
	(async () => {
		out.ready = document.readyState;
		out.color = getComputedStyle(document.getElementById('target')).color;
		out.step = 'sendMessage';
		out.pong = await chrome.runtime.sendMessage({ type: 'ping' });
		const times = [];
		for (let i = 0; i < 30; i++) {
			const start = performance.now();
			await chrome.runtime.sendMessage({ type: 'ping' });
			times.push(performance.now() - start);
		}
		out.rtt = median(times);
		const port = chrome.runtime.connect({ name: 'probe' });
		const portTimes = [];
		await new Promise((resolve) => {
			let start = performance.now();
			port.onMessage.addListener((message) => {
				portTimes.push(performance.now() - start);
				if (portTimes.length === 30) return resolve();
				start = performance.now();
				port.postMessage({ n: portTimes.length });
			});
			port.postMessage({ n: 0 });
		});
		port.disconnect();
		out.portRtt = median(portTimes);
		out.step = 'storage';
		await chrome.storage.local.set({ fromContent: 'yes' });
		out.storage = await chrome.storage.local.get('fromContent');
		out.step = 'war';
		out.war = await (await fetch(chrome.runtime.getURL('war.txt'))).text();
		out.step = 'tabs';
		chrome.runtime.onMessage.addListener((message, sender, respond) => {
			if (message.type === 'hello-tab') respond({ back: true });
		});
		out.viaTab = await chrome.runtime.sendMessage({ type: 'call-me' });
		out.step = 'exec';
		out.exec = await chrome.runtime.sendMessage({ type: 'exec' });
		out.exec.ran = document.documentElement.dataset.execFile;
		out.step = 'dnr';
		out.rules = await chrome.runtime.sendMessage({ type: 'dnr' });
		const text = (path) => fetch(path).then((response) => response.text().then((body) => body.trim()), () => 'failed');
		out.dnr = {
			static: await text('/pages/ext-plain.txt?dnr-static'),
			dynamic: await text('/pages/ext-plain.txt?dnr-dynamic'),
			none: await text('/pages/ext-plain.txt?dnr-none'),
		};
		out.step = 'tab ids';
		// (a frame of the page's, then a request of its document)
		await new Promise((resolve) => {
			const frame = document.createElement('iframe');
			const timer = setTimeout(resolve, 5000);
			frame.addEventListener('load', () => { clearTimeout(timer); frame.remove(); resolve(); });
			frame.src = '/pages/ext-other.html?ext-tab-probe=frame';
			document.body.append(frame);
		});
		await text('/pages/ext-plain.txt?ext-tab-probe=xhr');
		out.matched = await chrome.runtime.sendMessage({ type: 'matched' });
		delete out.step;
		document.documentElement.dataset.idle = JSON.stringify(out);
	})().catch((error) => {
		out.error = String(error && error.message || error);
		document.documentElement.dataset.idle = JSON.stringify(out);
	});`,
	'bg/lib.js': 'self.libValue = 42;',
	'bg/root.js': 'self.rootValue = 7;',
	'cs/exec.js': `document.documentElement.dataset.execFile = document.title.slice(0, 9) + ':from-file';`,
	'bg/sw.js': `importScripts('lib.js');
	importScripts(chrome.runtime.getURL('bg/root.js'));
	const fetched = fetch('../war.txt').then((response) => response.text());
	const matched = [];
	chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(({ rule, request }) => {
		if (rule.ruleId >= 3 && matched.length < 20)
			matched.push({ rule: rule.ruleId, type: request.type, tabId: request.tabId, frameId: request.frameId, parentFrameId: request.parentFrameId });
	});
	chrome.runtime.onInstalled.addListener(() => {
		chrome.action.setBadgeText({ text: '7' });
		chrome.action.setBadgeBackgroundColor({ color: '#00ff00' });
	});
	chrome.runtime.onMessage.addListener((message, sender, respond) => {
		if (message.type === 'ping') {
			respond({ pong: true, lib: self.libValue, root: self.rootValue, tab: sender.tab ? sender.tab.id : null });
			return;
		}
		if (message.type === 'call-me') {
			chrome.tabs.sendMessage(sender.tab.id, { type: 'hello-tab' }, { frameId: sender.frameId })
				.then(respond, (error) => respond({ error: error.message }));
			return true;
		}
		if (message.type === 'exec') {
			const target = { tabId: sender.tab.id, frameIds: [sender.frameId] };
			Promise.all([
				chrome.scripting.executeScript({ target, func: (word) => document.title.slice(0, 9) + ':' + word, args: ['func'] }),
				chrome.scripting.executeScript({ target, files: ['cs/exec.js'] }),
			]).then(([func, file]) => respond({ func: func[0]?.result, file: file.length, frameId: file[0]?.frameId }),
				(error) => respond({ error: error.message }));
			return true;
		}
		if (message.type === 'dnr') {
			const dnr = chrome.declarativeNetRequest;
			dnr.updateDynamicRules({
				removeRuleIds: [2],
				addRules: [{
					id: 2,
					action: { type: 'redirect', redirect: { extensionPath: '/war.txt' } },
					condition: { urlFilter: 'ext-plain.txt?dnr-dynamic', resourceTypes: ['xmlhttprequest'] },
				}],
			})
				.then(() => Promise.all([dnr.getDynamicRules(), dnr.getEnabledRulesets(), dnr.isRegexSupported({ regex: '[' })]))
				.then(([dynamic, enabled, regex]) => respond({ dynamic: dynamic.map((rule) => rule.id), enabled, regex: regex.isSupported }),
					(error) => respond({ error: error.message }));
			return true;
		}
		if (message.type === 'matched') {
			// (the matches come on their own channel: wait for all three kinds)
			const until = Date.now() + 3000;
			const answer = () => {
				const kinds = new Set(matched.map((entry) => entry.type));
				if (kinds.size >= 3 || Date.now() > until) respond({ tab: sender.tab.id, matched });
				else setTimeout(answer, 50);
			};
			answer();
			return true;
		}
		if (message.type === 'fetched') {
			fetched.then(respond, (error) => respond('failed: ' + error));
			return true;
		}
		if (message.type === 'cross') {
			fetch(message.url).then((response) => response.text())
				.then((text) => respond({ text: text.trim() }), (error) => respond({ error: String(error) }));
			return true;
		}
		if (message.type === 'cookie') {
			chrome.cookies.set({ url: message.url, name: 'extcookie', value: 'v1' })
				.then(() => chrome.cookies.getAll({ url: message.url }))
				.then((all) => respond(all.map((cookie) => cookie.name)), (error) => respond({ error: error.message }));
			return true;
		}
	});
	chrome.runtime.onConnect.addListener((port) => port.onMessage.addListener((message) => port.postMessage(message)));`,
	'popup.html':
		'<!doctype html><html><body style="margin:0;width:320px;height:140px"><pre id="out">waiting</pre><script src="popup.js"></script></body></html>',
	'popup.js': `(async () => {
		const out = { id: chrome.runtime.id };
		out.bg = await chrome.runtime.sendMessage({ type: 'ping' });
		const request = new XMLHttpRequest();
		request.open('GET', ${JSON.stringify(plain)});
		await new Promise((resolve) => { request.onload = request.onerror = resolve; request.send(); });
		out.xhr = request.status + ':' + request.responseText.trim();
		out.cross = await chrome.runtime.sendMessage({ type: 'cross', url: ${JSON.stringify(plain)} });
		out.cookies = await chrome.runtime.sendMessage({ type: 'cookie', url: ${JSON.stringify(FIXTURE)} });
		out.fetched = await chrome.runtime.sendMessage({ type: 'fetched' });
		out.storage = await chrome.storage.local.get(null);
		document.getElementById('out').textContent = JSON.stringify(out);
	})().catch((error) => { document.getElementById('out').textContent = 'error: ' + error.message; });`,
	'options.html':
		'<!doctype html><html><head><title>options</title></head><body><script src="options.js"></script></body></html>',
	'options.js': `chrome.storage.local.get('fromContent').then((items) => {
		document.title = 'options:' + chrome.runtime.id + ':' + items.fromContent;
	});`,
};

// the compat probe: what extensions found missing against Chrome (a
// localized name, the user script world's runtime, tabs' and
// webNavigation's events, a web accessible script under the page's CSP,
// executeScript into a sandboxed frame, a popup sized to its content)
const compatPages = [
	'*://*/pages/ext-compat.html*',
	'*://*/pages/ext-compat-frame.html*',
];
const compat = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: '__MSG_extName__',
		default_locale: 'en',
		version: '1.0',
		permissions: ['tabs', 'webNavigation', 'scripting', 'userScripts'],
		host_permissions: ['http://127.0.0.1/*'],
		background: { service_worker: 'sw.js' },
		action: { default_popup: 'words.html' },
		content_scripts: [
			{
				matches: compatPages,
				js: ['cs.js'],
				all_frames: true,
				run_at: 'document_start',
			},
		],
		web_accessible_resources: [
			{ resources: ['war.js'], matches: ['<all_urls>'] },
		],
	}),
	'_locales/en/messages.json': JSON.stringify({
		extName: { message: 'Compat Probe' },
	}),
	'war.js': `document.documentElement.dataset.war = 'ran';`,
	'cs.js': `if (window === top) {
		document.documentElement.dataset.name = chrome.runtime.getManifest().name;
		const script = document.createElement('script');
		script.src = chrome.runtime.getURL('war.js');
		document.documentElement.append(script);
		new MutationObserver(async () => {
			const ask = document.documentElement.dataset.ask;
			if (!ask) return;
			delete document.documentElement.dataset.ask;
			document.documentElement.dataset[ask] = JSON.stringify(await chrome.runtime.sendMessage({ type: ask }));
		}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ask'] });
	}`,
	'words.html':
		'<!doctype html><html><body style="margin:0;height:40px;font:16px monospace"><p id="words" style="margin:0">aaaa bbbb cccc dddd</p><script src="words.js"></script></body></html>',
	// a bundle's top-level var Text is the page's global (Grammarly's popup)
	'words.js': `var Text = { bundled: true };
	const style = document.createElement('style');
	document.head.append(style);
	try {
		style.textContent = '#words { color: rgb(4, 5, 6) }';
		document.body.dataset.styled = getComputedStyle(document.getElementById('words')).color;
	} catch (error) {
		document.body.dataset.styled = String(error);
	}`,
	'sw.js': `const log = [];
	const note = (name) => (...args) => log.push([name, ...args]);
	for (const name of ['onCreated', 'onUpdated', 'onActivated', 'onRemoved'])
		chrome.tabs[name].addListener(note('tabs.' + name));
	for (const name of ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated'])
		chrome.webNavigation[name].addListener(note('webNavigation.' + name));
	chrome.webNavigation.onCompleted.addListener(note('filtered'), { url: [{ pathSuffix: 'ext-compat.html' }] });
	chrome.runtime.onInstalled.addListener(async () => {
		await chrome.userScripts.configureWorld({ messaging: true });
		await chrome.userScripts.register([{
			id: 'shape',
			matches: ['*://*/pages/ext-compat.html*'],
			runAt: 'document_start',
			js: [{ code: "document.documentElement.dataset.us = JSON.stringify({ keys: Object.keys(chrome).sort(), runtime: Object.keys(chrome.runtime).sort(), onMessage: typeof (chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) });" }],
		}]);
	});
	chrome.runtime.onMessage.addListener((message, sender, respond) => {
		if (message.type === 'log') {
			respond({ tab: sender.tab.id, log });
			return;
		}
		if (message.type === 'exec') {
			chrome.scripting.executeScript({ target: { tabId: sender.tab.id, allFrames: true }, func: () => location.pathname })
				.then((results) => respond({ frames: results.map((result) => result.frameId).sort(), paths: results.map((result) => result.result) }),
					(error) => respond({ error: error.message }));
			return true;
		}
		if (message.type === 'frames') {
			chrome.webNavigation.getAllFrames({ tabId: sender.tab.id })
				.then((frames) => respond(frames.map((frame) => [frame.frameId, frame.parentFrameId, new URL(frame.url).pathname])),
					(error) => respond({ error: error.message }));
			return true;
		}
	});`,
};

// the MV2 blocker, as a .zip
const blocker = zip({
	'manifest.json': JSON.stringify({
		manifest_version: 2,
		name: 'Blocker Two',
		version: '2.0',
		permissions: ['webRequest', 'webRequestBlocking', '<all_urls>', 'storage'],
		background: { scripts: ['bg.js'] },
		browser_action: { default_title: 'B2' },
		content_scripts: [
			{ matches: pages, js: ['cs.js'], run_at: 'document_end' },
		],
	}),
	'bg.js': `self.completed = [];
	chrome.webRequest.onBeforeRequest.addListener(() => ({ cancel: true }),
		{ urls: ['*://*/pages/ext-blocked.txt*'] }, ['blocking']);
	chrome.webRequest.onBeforeRequest.addListener(
		(details) => ({ redirectUrl: details.url.replace('ext-redirect.txt', 'ext-redirected.txt') }),
		{ urls: ['*://*/pages/ext-redirect.txt*'] }, ['blocking']);
	chrome.webRequest.onHeadersReceived.addListener(
		(details) => ({ responseHeaders: [...details.responseHeaders, { name: 'x-ext-added', value: 'yes' }] }),
		{ urls: ['*://*/pages/ext-plain.txt*'] },
		['blocking', chrome.webRequest.OnHeadersReceivedOptions.RESPONSE_HEADERS]);
	chrome.webRequest.onCompleted.addListener((details) => self.completed.push(details.url),
		{ urls: ['*://*/pages/ext-plain.txt*'] });
	chrome.browserAction.setBadgeText({ text: 'B' });
	chrome.runtime.onMessage.addListener((message, sender, respond) => {
		if (message === 'completed') respond({
			count: self.completed.length,
			extra: chrome.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS,
		});
	});`,
	'cs.js': `(async () => {
		const out = {};
		try { await fetch('/pages/ext-blocked.txt'); out.blocked = 'loaded'; } catch (error) { out.blocked = 'failed'; }
		out.redirect = (await (await fetch('/pages/ext-redirect.txt')).text()).trim();
		out.added = (await fetch('/pages/ext-plain.txt?h')).headers.get('x-ext-added');
		await new Promise((resolve) => setTimeout(resolve, 500));
		chrome.storage.local.get('x', (items) => {
			out.callback = typeof items;
			out.lastError = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
			chrome.runtime.sendMessage('completed', (answer) => {
				out.completed = answer;
				document.documentElement.dataset.mv2 = JSON.stringify(out);
			});
		});
	})().catch((error) => { document.documentElement.dataset.mv2 = JSON.stringify({ error: String(error) }); });`,
});

const browser = await launch();
const errors = [];

/**
 * The newest frame of `page` whose document's title starts with `title`
 * (what code evaluated from here reads of `location` is the route's)
 */
async function documentAt(page, title) {
	for (const frame of [...page.frames()].reverse()) {
		const found = await frame.evaluate(() => document.title).catch(() => '');
		if (found.startsWith(title)) return frame;
	}
	return null;
}

/** poll `read` in the newest frame at `path` until it gives a value */
async function poll(page, path, read, timeout = 20000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const frame = await documentAt(page, path);
		const value = frame ? await frame.evaluate(read).catch(() => null) : null;
		if (value) return value;
		await sleep(150);
	}
	return null;
}

const TARGET = 'extension target';
const OTHER = 'no extension here';
const TRUSTED = 'trusted types target';
const COMPAT = 'compat target';

const datasetOf = (key) =>
	new Function(
		`return document.documentElement.dataset[${JSON.stringify(key)}] || null`,
	);

for (const [mode, base] of [
	['same-origin', PROXY],
	['isolated', HOST],
].filter(
	([mode]) => !process.env.EXT_MODES || process.env.EXT_MODES.includes(mode),
)) {
	await waitForServer(base);
	const context = await browser.newContext();
	const page = await context.newPage();
	page.on('pageerror', (error) => errors.push(`${mode}: ${error.message}`));
	// what the frames (the extensions' pages and content scripts) log as errors
	page.on('console', (message) => {
		if (message.type() === 'error' || process.env.EXT_DEBUG)
			errors.push(
				`${mode} console ${message.type()}: ${message.text().slice(0, 400)}`,
			);
	});
	if (process.env.EXT_DEBUG)
		context.on('serviceworker', (worker) =>
			worker.on('console', (message) =>
				errors.push(
					`${mode} worker ${message.type()}: ${message.text().slice(0, 400)}`,
				),
			),
		);
	const runtimeLoads = [];
	page.on('request', (request) => {
		if (request.url().includes('extensionsRuntime.js'))
			runtimeLoads.push(request.url());
	});
	await page.goto(`${base}stomp/controllerFrame.html`);
	const isolated = mode === 'isolated';

	const setup = await page.evaluate(
		async ({ isolated, proxyOrigin, probe, blocker }) => {
			const { StompController, RemoteController, ExtensionError } =
				await import('/stomp/controller.mjs');
			const wisp = `${proxyOrigin.replace(/^http/, 'ws')}/wisp/`;
			const transport = {
				module: `${proxyOrigin}/epoxy/index.mjs`,
				options: [{ wisp }],
			};
			const controller = isolated
				? new RemoteController({
						proxyOrigin,
						directory: '/stomp/',
						transport,
						codec: 'xor',
					})
				: new StompController({
						serviceworker: await StompController.register('/stomp/'),
						transport,
						directory: '/stomp/',
						codec: 'xor',
					});
			await controller.wait();
			window.__controller = controller;
			const changes = [];
			controller.extensions.onChange((change) => changes.push(change.type));
			window.__changes = changes;
			const out = { errors: {} };
			let started = performance.now();
			const probeInfo = await controller.extensions.install(probe, {
				filename: 'probe',
			});
			out.probeMs = performance.now() - started;
			const bytes = Uint8Array.from(atob(blocker), (char) =>
				char.charCodeAt(0),
			);
			started = performance.now();
			const blockerInfo = await controller.extensions.install(
				new Blob([bytes]),
				{
					filename: 'blocker.zip',
				},
			);
			out.blockerMs = performance.now() - started;
			out.probe = probeInfo;
			out.blocker = blockerInfo;
			out.list = (await controller.extensions.list()).map((info) => info.name);
			for (const [label, source] of [
				['garbage', new Uint8Array([1, 2, 3, 4])],
				['empty', ''],
				['no manifest', { 'a.js': '1' }],
			])
				try {
					await controller.extensions.install(source);
					out.errors[label] = 'installed';
				} catch (error) {
					out.errors[label] =
						`${error instanceof ExtensionError}:${error.code}`;
				}
			const frame = controller.createFrame();
			document.body.append(frame.element);
			window.__frame = frame;
			return out;
		},
		{
			isolated,
			proxyOrigin: new URL(PROXY).origin,
			probe,
			blocker: blocker.toString('base64'),
		},
	);
	ok(
		`${mode}: both extensions install`,
		setup.list?.length === 2,
		JSON.stringify(setup.list),
	);
	ok(
		`${mode}: install reports the extensions`,
		setup.probe?.manifestVersion === 3 &&
			setup.probe.background === 'service_worker' &&
			setup.blocker?.manifestVersion === 2 &&
			setup.blocker.background === 'page' &&
			/^[a-p]{32}$/.test(setup.probe.id),
		JSON.stringify({ probe: setup.probe?.id, warnings: setup.probe?.warnings }),
	);
	console.log(
		`${mode}: install ms probe ${setup.probeMs?.toFixed(1)} blocker ${setup.blockerMs?.toFixed(1)}`,
	);
	ok(
		`${mode}: install() throws ExtensionErrors that say what went wrong`,
		setup.errors?.garbage === 'true:bad-package' &&
			setup.errors.empty === 'true:bad-source' &&
			setup.errors['no manifest'] === 'true:no-manifest',
		JSON.stringify(setup.errors),
	);
	const probeId = setup.probe.id;
	const blockerId = setup.blocker.id;

	// a page no extension reaches loads no runtime (the backgrounds' pages did)
	await sleep(1500);
	const loadsBefore = runtimeLoads.length;
	await page.evaluate((url) => window.__frame.go(url), other);
	await poll(page, OTHER, () => document.readyState === 'complete');
	await sleep(500);
	ok(
		`${mode}: a page no extension reaches loads no runtime`,
		runtimeLoads.length === loadsBefore,
		runtimeLoads.slice(loadsBefore).join(' '),
	);

	// a JSON answer is a text document Chrome renders, where content scripts
	// run as in any page (JSON viewers read its <pre>)
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/ext-data.json`,
	);
	let json = null;
	for (let tries = 0; tries < 100 && !json; tries++) {
		for (const frame of page.frames())
			json ??= await frame.evaluate(datasetOf('text')).catch(() => null);
		if (!json) await sleep(150);
	}
	json = JSON.parse(json ?? 'null');
	ok(
		`${mode}: content scripts run in a JSON document, which reads as Chrome's`,
		json?.id === probeId &&
			json.type === 'application/json' &&
			json.title === '' &&
			json.first === 'PRE' &&
			JSON.parse(json.text ?? 'null')?.probe === 'json <&> text',
		JSON.stringify(json),
	);

	await page.evaluate((url) => window.__frame.go(url), target);
	const start = JSON.parse(
		(await poll(page, TARGET, datasetOf('start'))) ?? 'null',
	);
	ok(
		`${mode}: document_start runs with the page's root, before its first script`,
		start?.root === true && start.ready === 'loading' && start.id === probeId,
		JSON.stringify(start),
	);
	ok(
		`${mode}: an isolated world's window, self and globalThis chrome are the extension's`,
		start?.chrome === 'object' &&
			start.self &&
			start.window &&
			start.globalThis,
		JSON.stringify(start),
	);
	const first = await (
		await documentAt(page, TARGET)
	)?.evaluate(() => window.__pageFirst);
	ok(
		`${mode}: the page's first script runs after document_start, MAIN world included`,
		!!first?.start && first.main === 'page-chrome',
		JSON.stringify(first),
	);
	ok(
		`${mode}: the page never sees the extension's chrome`,
		first?.storage === 'undefined' && first.runtimeId === 'undefined',
		JSON.stringify(first),
	);
	const end = JSON.parse(
		(await poll(page, TARGET, datasetOf('end'))) ?? 'null',
	);
	ok(
		`${mode}: document_end runs on the parsed document`,
		end?.target === true && end.ready !== 'loading',
		JSON.stringify(end),
	);
	const idle = JSON.parse(
		(await poll(page, TARGET, datasetOf('idle'), 30000)) ?? 'null',
	);
	ok(
		`${mode}: document_idle runs, with the entry's CSS applied`,
		idle?.color === 'rgb(1, 2, 3)',
		JSON.stringify(idle),
	);
	ok(
		`${mode}: runtime.sendMessage reaches the service worker, whose relative and getURL importScripts ran`,
		idle?.pong?.pong === true &&
			idle.pong.lib === 42 &&
			idle.pong.root === 7 &&
			typeof idle.pong.tab === 'number',
		JSON.stringify(idle?.pong),
	);
	ok(
		`${mode}: tabs.sendMessage reaches the content script's frame`,
		idle?.viaTab?.back === true,
		JSON.stringify(idle?.viaTab),
	);
	ok(
		`${mode}: chrome.storage from a content script`,
		idle?.storage?.fromContent === 'yes',
		JSON.stringify(idle?.storage),
	);
	ok(
		`${mode}: a web accessible resource loads from the page`,
		idle?.war === 'accessible',
		JSON.stringify(idle?.war),
	);
	ok(
		`${mode}: scripting.executeScript runs a function and a file in the tab's frame`,
		idle?.exec?.func === 'extension:func' &&
			idle.exec.file === 1 &&
			idle.exec.frameId === 0 &&
			idle.exec.ran === 'extension:from-file',
		JSON.stringify(idle?.exec),
	);
	ok(
		`${mode}: declarativeNetRequest's calls reach the worker's engine`,
		idle?.rules?.dynamic?.join() === '2' &&
			idle.rules.enabled?.join() === 'static' &&
			idle.rules.regex === false,
		JSON.stringify(idle?.rules),
	);
	ok(
		`${mode}: a static rule blocks, a dynamic one redirects to the extension, others pass`,
		idle?.dnr?.static === 'failed' &&
			idle.dnr.dynamic === 'accessible' &&
			idle.dnr.none === 'plain',
		JSON.stringify(idle?.dnr),
	);
	const kinds = Object.fromEntries(
		(idle?.matched?.matched ?? []).map((entry) => [entry.type, entry]),
	);
	ok(
		`${mode}: declarativeNetRequest's matches carry the tab's id: the main frame the host sent, a frame in it, a request of its document`,
		typeof idle?.matched?.tab === 'number' &&
			idle.matched.tab >= 0 &&
			['main_frame', 'sub_frame', 'xmlhttprequest'].every(
				(type) => kinds[type]?.tabId === idle.matched.tab,
			),
		JSON.stringify(idle?.matched),
	);
	ok(
		`${mode}: their frame ids: the main frame 0, the frame's parent 0, the top document's request 0`,
		kinds.main_frame?.frameId === 0 &&
			kinds.main_frame.parentFrameId === -1 &&
			kinds.sub_frame?.parentFrameId === 0 &&
			kinds.xmlhttprequest?.frameId === 0 &&
			kinds.xmlhttprequest.parentFrameId === -1,
		JSON.stringify(kinds),
	);
	ok(
		`${mode}: messaging round trips stay under 5 ms (median)`,
		idle?.rtt < 5 && idle.portRtt < 5,
		`sendMessage ${idle?.rtt?.toFixed(2)} ms, port ${idle?.portRtt?.toFixed(2)} ms`,
	);
	console.log(
		`${mode}: sendMessage RTT ${idle?.rtt?.toFixed(3)} ms, port RTT ${idle?.portRtt?.toFixed(3)} ms`,
	);

	const mv2 = JSON.parse(
		(await poll(page, TARGET, datasetOf('mv2'), 30000)) ?? 'null',
	);
	ok(
		`${mode}: blocking webRequest cancels`,
		mv2?.blocked === 'failed',
		JSON.stringify(mv2),
	);
	ok(
		`${mode}: blocking webRequest redirects`,
		mv2?.redirect === 'redirected',
		JSON.stringify(mv2),
	);
	ok(
		`${mode}: blocking webRequest adds a response header`,
		mv2?.added === 'yes',
		JSON.stringify(mv2),
	);
	ok(
		`${mode}: webRequest.onCompleted and the webRequest enums reach an MV2 background`,
		mv2?.completed?.count >= 1 && mv2.completed.extra === 'extraHeaders',
		JSON.stringify(mv2?.completed),
	);
	ok(
		`${mode}: MV2 callbacks with runtime.lastError`,
		mv2?.callback === 'object' && mv2.lastError === null,
		JSON.stringify(mv2),
	);

	// the pages and the toolbar
	const actions = await page.evaluate(
		async (ids) => {
			const extensions = window.__controller.extensions;
			return {
				probe: await extensions.action(ids[0]),
				blocker: await extensions.action(ids[1]),
				all: (await extensions.actions()).map((action) => action.id),
			};
		},
		[probeId, blockerId],
	);
	ok(
		`${mode}: the action's badge, set by the background`,
		actions.probe.badgeText === '7' &&
			actions.probe.badgeColor.length > 0 &&
			actions.blocker.badgeText === 'B',
		JSON.stringify(actions),
	);
	ok(
		`${mode}: the action has the popup`,
		/popup\.html$/.test(actions.probe.popupUrl ?? ''),
		actions.probe.popupUrl,
	);

	const popup = await page.evaluate(async (id) => {
		const handle = await window.__controller.extensions.openPopup(id);
		window.__popup = handle;
		return !!handle;
	}, probeId);
	ok(`${mode}: openPopup mounts the popup`, popup);
	let popupOut = null;
	for (let tries = 0; tries < 100 && !popupOut?.startsWith('{'); tries++) {
		await sleep(200);
		for (const frame of page.frames()) {
			const text = await frame
				.evaluate(() => document.getElementById('out')?.textContent ?? null)
				.catch(() => null);
			if (text) popupOut = text;
		}
	}
	const popupData = popupOut?.startsWith('{') ? JSON.parse(popupOut) : null;
	ok(
		`${mode}: the popup talks to the background`,
		popupData?.id === probeId && popupData.bg?.pong === true,
		popupOut,
	);
	ok(
		`${mode}: an extension page's cross-origin XHR goes through`,
		popupData?.xhr === '200:plain',
		popupOut,
	);
	ok(
		`${mode}: the service worker's cross-origin fetch goes through`,
		popupData?.cross?.text === 'plain',
		popupOut,
	);
	ok(
		`${mode}: the service worker's relative fetch resolves against its script`,
		popupData?.fetched === 'accessible',
		popupOut,
	);
	ok(
		`${mode}: chrome.cookies uses STomp's jar`,
		popupData?.cookies?.includes?.('extcookie'),
		popupOut,
	);
	const size = await page.evaluate(() => {
		const element = [...document.querySelectorAll('iframe')].find((frame) =>
			frame.name.startsWith('ext-context:popup'),
		);
		return element
			? {
					width: parseInt(element.style.width),
					height: parseInt(element.style.height),
				}
			: null;
	});
	ok(
		`${mode}: the popup is sized as its document asks`,
		size?.width >= 320 && size.height >= 140,
		JSON.stringify(size),
	);
	await page.evaluate(() => window.__popup.close());

	// the cookie reaches the page's document.cookie
	await page.evaluate((url) => window.__frame.go(url), target);
	const cookie = await poll(page, TARGET, () => document.cookie || null, 8000);
	ok(
		`${mode}: a cookie the extension set is the page's`,
		cookie?.includes('extcookie=v1'),
		cookie,
	);

	// options page
	const options = await page.evaluate(async (id) => {
		const extensions = window.__controller.extensions;
		const options = await extensions.options(id);
		await window.__frame.go(extensions.resolveUrl(options.displayUrl));
		return options;
	}, probeId);
	ok(
		`${mode}: options() names the page`,
		options.displayUrl === `chrome-extension://${probeId}/options.html`,
		JSON.stringify(options),
	);
	const title = await poll(page, 'options:', () =>
		document.title.startsWith('options:') ? document.title : null,
	);
	ok(
		`${mode}: the options page runs with its chrome`,
		title === `options:${probeId}:yes`,
		title,
	);

	// Trusted Types: the content scripts still run
	await page.evaluate((url) => window.__frame.go(url), trusted);
	const ttIdle = await poll(page, TRUSTED, datasetOf('idle'), 30000);
	ok(
		`${mode}: content scripts run on a page that requires Trusted Types`,
		ttIdle?.includes('"color":"rgb(1, 2, 3)"'),
		ttIdle,
	);

	// the compat probe (see `compat`), in a page whose CSP allows only its own scripts
	const compatInfo = await page.evaluate(
		(files) =>
			window.__controller.extensions.install(files, { filename: 'compat' }),
		compat,
	);
	const compatId = compatInfo.id;
	await sleep(1500);
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/ext-compat.html`,
	);
	const war = await poll(page, COMPAT, datasetOf('war'), 15000);
	const compatTop = await documentAt(page, COMPAT);
	const askCompat = async (type) => {
		const frame = await documentAt(page, COMPAT);
		await frame
			?.evaluate((type) => {
				delete document.documentElement.dataset[type];
				document.documentElement.dataset.ask = type;
			}, type)
			.catch(() => {});
		for (let tries = 0; tries < 100; tries++) {
			const value = await frame?.evaluate(datasetOf(type)).catch(() => null);
			if (value) return JSON.parse(value);
			await sleep(100);
		}
		return null;
	};
	ok(
		`${mode}: getManifest's name is localized, as Chrome gives it`,
		(await compatTop?.evaluate(datasetOf('name'))) === 'Compat Probe',
		String(await compatTop?.evaluate(datasetOf('name'))),
	);
	const userWorld = JSON.parse(
		(await compatTop?.evaluate(datasetOf('us')).catch(() => null)) ?? 'null',
	);
	ok(
		`${mode}: a user script's world with messaging has Chrome's runtime, onMessage included`,
		userWorld?.onMessage === 'function' &&
			userWorld.keys.includes('runtime') &&
			userWorld.runtime.join() ===
				'ContextType,OnInstalledReason,OnRestartRequiredReason,PlatformArch,PlatformNaclArch,PlatformOs,RequestUpdateCheckStatus,connect,dynamicId,id,onConnect,onMessage,sendMessage',
		JSON.stringify(userWorld),
	);
	ok(
		`${mode}: a content script's web accessible script runs past the page's CSP and referrer policy`,
		war === 'ran',
		String(war),
	);
	const exec = await askCompat('exec');
	ok(
		`${mode}: executeScript with allFrames runs in a sandboxed frame too`,
		exec?.frames?.length === 3 &&
			exec.paths.filter((path) => path === '/pages/ext-compat-frame.html')
				.length === 2,
		JSON.stringify(exec),
	);
	const frames = await askCompat('frames');
	ok(
		`${mode}: webNavigation.getAllFrames lists the tab's top and its frames`,
		Array.isArray(frames) &&
			frames.some(([id, parent]) => id === 0 && parent === -1) &&
			frames.some(
				([id, parent, path]) =>
					id > 0 && parent === 0 && path === '/pages/ext-compat-frame.html',
			),
		JSON.stringify(frames),
	);
	// the tab's history, its title, and a second tab shown and closed
	await compatTop?.evaluate(() => history.pushState({}, '', '?pushed'));
	await sleep(400);
	await compatTop?.evaluate(() => (document.title = 'compat target again'));
	await sleep(400);
	await page.evaluate(async (url) => {
		const controller = window.__controller;
		const frame = controller.createFrame();
		document.body.append(frame.element);
		controller.activeTab = frame;
		window.__second = frame;
		await frame.go(url);
	}, target);
	await sleep(2500);
	await page.evaluate(() => {
		const controller = window.__controller;
		controller.activeTab = window.__frame;
		window.__second.element.remove();
		controller.frames.splice(controller.frames.indexOf(window.__second), 1);
	});
	await sleep(800);
	const told = await askCompat('log');
	const log = told?.log ?? [];
	const tabId = told?.tab;
	const top = (name, test = () => true) =>
		log.some(
			([event, details]) =>
				event === name &&
				details.tabId === tabId &&
				details.frameId === 0 &&
				test(details),
		);
	const updated = (test) =>
		log.some(
			([event, id, change]) =>
				event === 'tabs.onUpdated' && id === tabId && test(change),
		);
	const page2 = log.find(([event]) => event === 'tabs.onCreated')?.[1]?.id;
	ok(
		`${mode}: webNavigation tells a tab's top document's commit, load and history`,
		typeof tabId === 'number' &&
			top('webNavigation.onBeforeNavigate', (details) =>
				details.url.endsWith('/pages/ext-compat.html'),
			) &&
			top(
				'webNavigation.onCommitted',
				(details) =>
					details.url.endsWith('/pages/ext-compat.html') &&
					/^[0-9A-F]{32}$/.test(details.documentId) &&
					typeof details.transitionType === 'string',
			) &&
			top('webNavigation.onCompleted') &&
			top('webNavigation.onHistoryStateUpdated', (details) =>
				details.url.endsWith('?pushed'),
			),
		JSON.stringify(log.map(([event]) => event)),
	);
	ok(
		`${mode}: webNavigation tells a frame's commit below the top`,
		log.some(
			([event, details]) =>
				event === 'webNavigation.onCommitted' &&
				details.tabId === tabId &&
				details.frameId > 0 &&
				details.parentFrameId === 0 &&
				details.url.endsWith('/pages/ext-compat-frame.html'),
		),
		JSON.stringify(log.filter(([event]) => event.startsWith('webNav'))),
	);
	ok(
		`${mode}: a webNavigation listener's URL filters pick its events`,
		log.some(([event]) => event === 'filtered') &&
			log.every(
				([event, details]) =>
					event !== 'filtered' || details.url.endsWith('ext-compat.html'),
			),
		JSON.stringify(log.filter(([event]) => event === 'filtered')),
	);
	ok(
		`${mode}: tabs.onUpdated tells a tab's loading, URL, title and completion`,
		updated(
			(change) =>
				change.status === 'loading' &&
				change.url?.endsWith('/pages/ext-compat.html'),
		) &&
			updated((change) => change.status === 'complete') &&
			updated((change) => change.title === 'compat target again'),
		JSON.stringify(log.filter(([event]) => event === 'tabs.onUpdated')),
	);
	ok(
		`${mode}: tabs.onCreated, onActivated and onRemoved follow the host's tabs`,
		typeof page2 === 'number' &&
			page2 !== tabId &&
			log.some(
				([event, info]) => event === 'tabs.onActivated' && info.tabId === page2,
			) &&
			log.some(
				([event, info]) => event === 'tabs.onActivated' && info.tabId === tabId,
			) &&
			log.some(([event, id]) => event === 'tabs.onRemoved' && id === page2),
		JSON.stringify(
			log.filter(
				([event]) => event.startsWith('tabs.on') && event !== 'tabs.onUpdated',
			),
		),
	);
	// a popup is as wide as its content's narrowest layout, and follows it
	await page.evaluate(async (id) => {
		window.__popup = await window.__controller.extensions.openPopup(id);
	}, compatId);
	const popupSize = () =>
		page.evaluate(() => {
			const element = [...document.querySelectorAll('iframe')].find((frame) =>
				frame.name.startsWith('ext-context:popup'),
			);
			return element?.style.width
				? {
						width: parseInt(element.style.width),
						height: parseInt(element.style.height),
					}
				: null;
		});
	let words = null;
	for (let tries = 0; tries < 100 && !words; tries++) {
		await sleep(150);
		for (const frame of page.frames())
			if (
				await frame
					.evaluate(() => !!document.getElementById('words'))
					.catch(() => false)
			)
				words = frame;
	}
	await sleep(800);
	const styled = await words
		?.evaluate(() => document.body.dataset.styled ?? null)
		.catch(() => null);
	ok(
		`${mode}: a page's own global named Text leaves a style's text to work`,
		styled === 'rgb(4, 5, 6)',
		String(styled),
	);
	const narrow = await popupSize();
	await words
		?.evaluate(() => (document.body.style.width = '480px'))
		.catch(() => {});
	await sleep(800);
	const wide = await popupSize();
	ok(
		`${mode}: a popup takes its content's min-content width, and follows a later change`,
		narrow?.width < 100 && wide?.width === 480,
		JSON.stringify({ narrow, wide }),
	);
	await page.evaluate(() => window.__popup?.close());
	await page.evaluate(
		(id) => window.__controller.extensions.remove(id),
		compatId,
	);

	// disable, enable, remove
	await page.evaluate(
		(id) => window.__controller.extensions.disable(id),
		probeId,
	);
	await page.evaluate((url) => window.__frame.go(url), target);
	await poll(page, TARGET, datasetOf('mv2'), 30000);
	const disabled = await (
		await documentAt(page, TARGET)
	)?.evaluate(() => document.documentElement.dataset.start ?? null);
	const unruled = await (
		await documentAt(page, TARGET)
	)?.evaluate(() =>
		fetch('/pages/ext-plain.txt?dnr-static').then(
			(response) => response.text().then((body) => body.trim()),
			() => 'failed',
		),
	);
	ok(
		`${mode}: a disabled extension's rules block nothing`,
		unruled === 'plain',
		String(unruled),
	);
	ok(
		`${mode}: a disabled extension's content scripts do not run`,
		disabled === null,
		String(disabled),
	);
	await page.evaluate(
		(id) => window.__controller.extensions.remove(id),
		blockerId,
	);
	await page.evaluate(
		(id) => window.__controller.extensions.enable(id),
		probeId,
	);
	await page.evaluate((url) => window.__frame.go(url), target);
	await poll(page, TARGET, datasetOf('idle'), 30000);
	const blockedNow = await (
		await documentAt(page, TARGET)
	)?.evaluate(async () => {
		try {
			return (await (await fetch('/pages/ext-blocked.txt')).text()).trim();
		} catch (error) {
			return 'failed';
		}
	});
	ok(
		`${mode}: a removed extension blocks nothing`,
		blockedNow === 'blocked',
		String(blockedNow),
	);
	const after = await page.evaluate(async () => ({
		list: (await window.__controller.extensions.list()).map(
			(info) => `${info.name}:${info.enabled}`,
		),
		changes: window.__changes,
	}));
	ok(
		`${mode}: list() and onChange follow install, disable, enable and remove`,
		after.list.join() === 'Probe Three:true' &&
			['installed', 'disabled', 'enabled', 'removed'].every((type) =>
				after.changes.includes(type),
			),
		JSON.stringify(after),
	);
	await page.evaluate(
		(id) => window.__controller.extensions.remove(id),
		probeId,
	);
	await context.close();
}

await done(browser, errors);
