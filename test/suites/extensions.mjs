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
//   executeScript into a sandboxed frame, a popup sized to its content;
// - a fourth for the extension's origin, chrome-extension://<id>, in a
//   content script, the service worker and an extension page;
// - a fifth for the service worker's fetch events (which requests reach
//   them, respondWith, the package past them) and its pages' messages.
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
			{
				resources: ['war.txt', 'cs/mod.js', 'cs/dep.js'],
				matches: ['<all_urls>'],
			},
			// (exposed to another site only: no page here may read it)
			{ resources: ['cs/secret.js'], matches: ['https://only.example/*'] },
		],
	}),
	'war.txt': 'accessible',
	'cs/secret.js': `export const secret = 'secret';`,
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
				resourceTypes: ['sub_frame', 'xmlhttprequest', 'websocket'],
			},
		},
		// request headers the MV2 blocker's onBeforeSendHeaders sees before
		// this rule's changes
		{
			id: 5,
			action: {
				type: 'modifyHeaders',
				requestHeaders: [
					{ header: 'x-order', operation: 'set', value: 'dnr' },
					{ header: 'x-dnr-added', operation: 'set', value: 'yes' },
				],
			},
			condition: {
				urlFilter: 'echo-headers?send-order',
				resourceTypes: ['xmlhttprequest'],
			},
		},
	]),
	'cs/main.js': `window.__mainRan = typeof chrome === 'object' && chrome && chrome.storage ? 'leaked' : 'page-chrome';`,
	'cs/start.js': `document.documentElement.dataset.start = JSON.stringify({
		chrome: typeof chrome, id: chrome.runtime.id, self: self.chrome === chrome,
		window: window.chrome === chrome, globalThis: globalThis.chrome === chrome,
		root: !!document.documentElement, ready: document.readyState });
	var startVar = 1;`,
	'cs/dep.js': `export const depValue = 'dep';
	export default function twice(text) { return text + text; }`,
	'cs/mod.js': `import twice, { depValue } from './dep.js';
	export let count = 0;
	export function bump() { count++; }
	export const describe = () => ({
		dep: depValue, twice: twice('a'), id: chrome.runtime.id,
		title: document.title.slice(0, 9), meta: import.meta.url.endsWith('/cs/mod.js'),
		page: typeof window.__pageVar });`,
	'cs/end.js': `const target = document.getElementById('target');
	// what the page made and changed after document_start, which an
	// isolated world does not see; and what it makes, which the page does not
	const events = {};
	const show = () => (document.documentElement.dataset.events = JSON.stringify(events));
	document.addEventListener('page-ping', (event) => {
		events.detail = JSON.stringify(event.detail);
		events.detailOwn = event.detail instanceof Object && event.detail.list instanceof Array;
		show();
	});
	window.addEventListener('message', (event) => {
		if (!event.data || event.data.from !== 'page') return;
		events.message = event.data.from;
		events.messageOwn = event.data instanceof Object;
		show();
	});
	document.addEventListener('world-ping', () => {});
	if (target) target.worldExpando = 'world';
	// a handler the page can read back: a native to it, as the world's
	// functions it holds are
	if (target) target.onmouseleave = function worldLeave() {};
	window.__worldVar = 1;
	var worldVar = 2;
	Array.prototype.__worldPolluted = 1;
	const tt = {};
	try {
		target.insertAdjacentHTML('beforeend', '<b id="world-html">w</b>');
		tt.html = !!document.getElementById('world-html');
	} catch (error) { tt.html = String(error); }
	try {
		const script = document.createElement('script');
		script.src = chrome.runtime.getURL('war.txt');
		tt.src = 'set';
	} catch (error) { tt.src = String(error); }
	try {
		const element = document.createElement('div');
		element.innerHTML = '<i>x</i>';
		tt.inner = element.firstChild.nodeName;
	} catch (error) { tt.inner = String(error); }
	document.documentElement.dataset.end = JSON.stringify({
		ready: document.readyState, target: !!target,
		pageVar: typeof window.__pageVar,
		pagePolluted: [].__pagePolluted === undefined,
		pageExpando: !!target && target.pageExpando === undefined,
		sheets: typeof document.styleSheets.length === 'number',
		windowInstance: window instanceof Window && self === window,
		nodeInstance: target instanceof HTMLElement && target instanceof Node,
		builtins: Object.getPrototypeOf([]) === Array.prototype,
		declaration: (() => {
			const probe = document.createElement('i');
			probe.style.color = 'rgb(4, 5, 6)';
			return probe.style.cssText + ' ' + probe.style.length;
		})(),
		chains: Object.getPrototypeOf(target.style) === CSSStyleDeclaration.prototype &&
			Object.getPrototypeOf(document.body.classList) === DOMTokenList.prototype &&
			Object.getPrototypeOf(CSSStyleDeclaration.prototype) === Object.prototype,
		shared: typeof startVar === 'number',
		path: location.pathname,
		href: window.location.href === document.location.href && String(location) === location.href,
		tt });`,
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
		out.step = 'module';
		const mod = await import(chrome.runtime.getURL('cs/mod.js'));
		mod.bump();
		out.module = { ...mod.describe(), live: mod.count };
		out.module.secret = await import(chrome.runtime.getURL('cs/secret.js')).then(
			() => 'loaded',
			() => 'refused',
		);
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
		// a frame of the page's and a request of its document, a request of
		// the page's document and a WebSocket it opens
		const frame = document.createElement('iframe');
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 5000);
			frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
			frame.src = '/pages/ext-other.html?ext-tab-probe=frame';
			document.body.append(frame);
		});
		await frame.contentWindow.fetch('/pages/ext-plain.txt?ext-tab-probe=nested').catch(() => {});
		// the parent sets the frame's src: the frame keeps its id
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 5000);
			frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
			frame.src = '/pages/ext-other.html?ext-tab-probe=resrc';
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		await frame.contentWindow.fetch('/pages/ext-plain.txt?ext-tab-probe=again').catch(() => {});
		// the frame goes to an image (its document announces that), then the
		// parent sets its src: the image document says nothing, and the next
		// document takes the frame's id back when it reports
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 5000);
			frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
			frame.contentWindow.location.href = '/pages/object-events.png?ext-tab-probe=img';
		});
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 5000);
			const heard = (event) => {
				if (event.data !== 'fetched:iagain') return;
				clearTimeout(timer);
				removeEventListener('message', heard);
				resolve();
			};
			addEventListener('message', heard);
			frame.src = '/pages/ext-frame-fetch.html?ext-tab-probe=iresrc&fetch=iagain';
		});
		// and a frame of another origin whose parent sets its src
		const cross = document.createElement('iframe');
		const otherOrigin = location.origin.replace('127.0.0.1', 'localhost');
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 5000);
			cross.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
			cross.src = otherOrigin + '/pages/ext-other.html?ext-tab-probe=xframe';
			document.body.append(cross);
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 5000);
			const heard = (event) => {
				if (event.data !== 'fetched:xagain') return;
				clearTimeout(timer);
				removeEventListener('message', heard);
				resolve();
			};
			addEventListener('message', heard);
			cross.src = otherOrigin + '/pages/ext-frame-fetch.html?ext-tab-probe=xresrc&fetch=xagain';
		});
		// a dedicated worker's request and WebSocket
		await new Promise((resolve) => {
			const worker = new Worker('/pages/ext-worker-socket.js');
			const timer = setTimeout(resolve, 5000);
			worker.onmessage = () => { clearTimeout(timer); worker.terminate(); resolve(); };
		});
		await text('/pages/ext-plain.txt?ext-tab-probe=xhr');
		await new Promise((resolve) => {
			const socket = new WebSocket(new URL('/open/ws-echo?ext-tab-probe=socket', location.href.replace(/^http/, 'ws')).href);
			socket.onopen = socket.onerror = () => { socket.close(); resolve(); };
			setTimeout(resolve, 5000);
		});
		out.matched = await chrome.runtime.sendMessage({ type: 'matched' });
		frame.remove();
		cross.remove();
		const since = /[?&]tab-rules=(\\d+)/.exec(location.search);
		if (since) out.tabRules = await chrome.runtime.sendMessage({ type: 'tab-rules', since: Number(since[1]) });
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
		const probe = /ext-tab-probe=(\\w+)/.exec(request.url);
		if ((rule.ruleId === 3 || rule.ruleId === 4) && matched.length < 40)
			matched.push({ name: probe ? probe[1] : 'main', type: request.type, url: request.url, tabId: request.tabId, frameId: request.frameId, parentFrameId: request.parentFrameId });
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
			// (the matches come on their own channel: wait for the requests'
			// four, then take them with the frames' ids as executeScript sees them)
			const until = Date.now() + 4000;
			const answer = () => {
				const names = new Set(matched.map((entry) => entry.name));
				if (!['frame', 'nested', 'resrc', 'again', 'img', 'iresrc', 'iagain', 'xframe', 'xresrc', 'xagain', 'wfetch', 'wsocket', 'xhr', 'socket'].every((name) => names.has(name)) && Date.now() < until)
					return setTimeout(answer, 50);
				const taken = Object.fromEntries(matched.splice(0).map((entry) => [entry.name, entry]));
				chrome.scripting.executeScript({ target: { tabId: sender.tab.id, allFrames: true }, func: () => location.href })
					.then((frames) => frames.map((frame) => [frame.frameId, frame.result]), (error) => error.message)
					.then((frames) => respond({ tab: sender.tab.id, matched: taken, frames }));
			};
			answer();
			return true;
		}
		if (message.type === 'tab-rules') {
			chrome.declarativeNetRequest.getMatchedRules({ tabId: sender.tab.id, minTimeStamp: message.since })
				.then((found) => respond(found.rulesMatchedInfo.map((info) => info.rule.ruleId)), (error) => respond(error.message));
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
			const start = performance.now();
			chrome.scripting.executeScript({ target: { tabId: sender.tab.id, allFrames: true }, func: () => location.pathname })
				.then((results) => respond({ frames: results.map((result) => result.frameId).sort(), paths: results.map((result) => result.result), ms: Math.round(performance.now() - start) }),
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

// the origin probe: what an extension reads of its own origin in its page,
// its service worker and a content script, which Chrome gives as
// chrome-extension://<id> (the same files make the native reference)
const originPages = ['*://*/pages/ext-origin.html*'];

const originProbe = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Origin Probe',
		version: '1.0',
		permissions: ['tabs'],
		host_permissions: ['http://127.0.0.1/*'],
		background: { service_worker: 'sw.js' },
		content_scripts: [{ matches: originPages, js: ['cs.js'] }],
		web_accessible_resources: [
			{
				resources: ['o-frame.html', 'o-frame.js', 'war.txt', 'x.svg'],
				matches: ['<all_urls>'],
			},
		],
	}),
	'war.txt': 'war body',
	'x.svg':
		'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
	'sw.js': `chrome.runtime.onMessage.addListener((message, sender, respond) => {
		if (message === 'sender') respond({
			url: sender.url, origin: sender.origin, tab: sender.tab ? sender.tab.url : null,
			swHref: location.href, swOrigin: location.origin, swHost: location.host, self: self.origin,
			getURL: chrome.runtime.getURL(''),
		});
	});`,
	'o.html':
		'<!doctype html><html><head><title>origin page</title></head><body><iframe id="f" src="o-frame.html"></iframe><script src="o.js"></script></body></html>',
	'o-frame.html':
		'<!doctype html><html><head><title>origin frame</title></head><body><script src="o-frame.js"></script></body></html>',
	'o-frame.js': `addEventListener('message', (event) => {
		if (event.data === 'ping') event.source.postMessage('pong', event.origin === 'null' ? '*' : event.origin);
	});
	parent.postMessage({ frame: location.href, origin: location.origin }, '*');`,
	'o.js': `(async () => {
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'none')]);
		const loaded = (element) => new Promise((resolve) => { element.onload = () => resolve(true); element.onerror = () => resolve(false); });
		const out = {};
		out.href = location.href;
		out.origin = location.origin;
		out.protocol = location.protocol;
		out.host = location.host;
		out.string = String(location);
		out.url = document.URL;
		out.documentURI = document.documentURI;
		out.baseURI = document.baseURI;
		out.self = self.origin;
		out.domain = document.domain;
		out.getURL = chrome.runtime.getURL('x.svg');
		const blob = URL.createObjectURL(new Blob(['blob body']));
		out.blob = blob.replace(/[0-9a-f-]{36}$/, 'U');
		out.blobText = await (await fetch(blob)).text();
		const link = document.createElement('a');
		link.href = 'x.svg?q#h';
		out.link = [link.href, link.origin, link.protocol, link.host, link.hostname, link.pathname, link.search, link.hash];
		const blobLink = document.createElement('a');
		blobLink.href = blob;
		out.blobLink = [blobLink.origin, blobLink.protocol, blobLink.host, new URL(blob).origin];
		const sourceOf = (object, name) => { const own = Object.getOwnPropertyDescriptor(object, name); return Function.prototype.toString.call(own.get || own.value); };
		out.sources = [sourceOf(Document.prototype, 'URL'), sourceOf(HTMLImageElement.prototype, 'src'), sourceOf(HTMLAnchorElement.prototype, 'origin'), sourceOf(location, 'href'), sourceOf(location, 'toString'), sourceOf(Document.prototype, 'domain'), sourceOf(URL, 'createObjectURL'), sourceOf(Navigator.prototype, 'serviceWorker')];
		const img = new Image();
		img.src = chrome.runtime.getURL('x.svg');
		out.img = img.src;
		out.imgLoaded = await loaded(img);
		const response = await fetch(chrome.runtime.getURL('war.txt'));
		out.fetched = (await response.text()).trim();
		out.responseURL = response.url;
		out.byOrigin = (await (await fetch(location.origin + '/war.txt')).text()).trim();
		const frame = document.getElementById('f');
		if (!frame.contentDocument || frame.contentDocument.readyState !== 'complete') await within(loaded(frame), 5000);
		const pong = new Promise((resolve) => addEventListener('message', (event) => event.data === 'pong' && resolve(event.origin)));
		frame.contentWindow.postMessage('ping', location.origin);
		out.pong = await within(pong, 3000);
		out.sender = await chrome.runtime.sendMessage('sender');
		out.tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('o.html') + '*' }).then((tabs) => tabs.map((tab) => tab.url), (error) => String(error));
		const moved = loaded(frame);
		frame.contentWindow.location.href = location.origin + '/o-frame.html?moved';
		await within(moved, 5000);
		out.moved = frame.contentWindow.location.href;
		document.documentElement.dataset.origin = JSON.stringify(out);
	})().catch((error) => { document.documentElement.dataset.origin = JSON.stringify({ error: String(error && error.stack || error) }); });`,
	'cs.js': `if (window === top) (async () => {
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'none')]);
		const loaded = (element) => new Promise((resolve) => { element.onload = () => resolve(true); element.onerror = () => resolve(false); });
		const out = {};
		out.getURL = chrome.runtime.getURL('x.svg');
		const parsed = new URL(chrome.runtime.getURL('x.svg?q#h'));
		out.parsed = [parsed.protocol, parsed.host, parsed.origin, parsed.pathname, parsed.search, parsed.hash];
		const img = document.createElement('img');
		img.src = chrome.runtime.getURL('x.svg');
		out.img = img.src;
		document.documentElement.append(img);
		out.imgLoaded = await loaded(img);
		out.fetched = (await (await fetch(chrome.runtime.getURL('war.txt'))).text()).trim();
		const hello = new Promise((resolve) => addEventListener('message', (event) => event.data && event.data.frame && resolve({ origin: event.origin, frame: event.data.frame, frameOrigin: event.data.origin })));
		const frame = document.createElement('iframe');
		frame.src = chrome.runtime.getURL('o-frame.html');
		document.documentElement.append(frame);
		out.hello = await within(hello, 8000);
		const pong = new Promise((resolve) => addEventListener('message', (event) => event.data === 'pong' && resolve(event.origin)));
		frame.contentWindow.postMessage('ping', chrome.runtime.getURL('').slice(0, -1));
		out.pong = await within(pong, 3000);
		out.sender = await chrome.runtime.sendMessage('sender');
		document.documentElement.dataset.origin = JSON.stringify(out);
	})().catch((error) => { document.documentElement.dataset.origin = JSON.stringify({ error: String(error && error.stack || error) }); });`,
};

// the worker probe: which of an extension's requests reach its service
// worker's fetch handler, as Chrome 157 gives them, and its pages'
// messages to it and back (the same files make the native reference)
const workerPages = ['*://*/pages/ext-worker.html*'];

const workerProbe = {
	'manifest.json': JSON.stringify({
		manifest_version: 3,
		name: 'Worker Probe',
		version: '1.0',
		permissions: ['tabs'],
		host_permissions: ['http://127.0.0.1/*'],
		background: { service_worker: 'sw.js' },
		content_scripts: [{ matches: workerPages, js: ['cs.js'] }],
		web_accessible_resources: [
			{
				resources: ['w.txt', 'w-frame.html', 'w-frame.js', 'gen.js'],
				matches: ['<all_urls>'],
			},
		],
	}),
	'w.txt': 'package w',
	'plain.txt': 'package plain',
	'gone.txt': 'package gone',
	'later.txt': 'package later',
	'gen.js': 'window.GEN = "package";',
	'sw.js': `const seen = [];
	let installed = false;
	let activated = false;
	self.oninstall = () => { installed = true; };
	self.onactivate = (event) => { activated = true; event.waitUntil(clients.claim()); };
	self.onfetch = (event) => {
		const url = new URL(event.request.url);
		seen.push(url.pathname + url.search + ' ' + event.request.mode + ' ' + event.request.destination);
		if (url.pathname === '/gen.js') event.respondWith(new Response('window.GEN = ' + JSON.stringify(url.search) + ';', { headers: { 'content-type': 'text/javascript' } }));
		else if (url.pathname === '/w.txt') event.respondWith(new Response('worker w ' + event.request.url));
		else if (url.pathname === '/gone.txt') event.respondWith(Response.error());
		else if (url.pathname === '/later.txt') event.respondWith(new Promise((resolve) => setTimeout(() => resolve(new Response('worker later', { status: 201, headers: { 'x-from': 'worker' } })), 300)));
	};
	self.onmessage = (event) => {
		event.source.postMessage({ echo: event.data, type: event.source.type, url: event.source.url, origin: event.origin, client: event.source instanceof Client, event: event.constructor.name });
	};
	chrome.runtime.onMessage.addListener((message, sender, respond) => {
		clients.matchAll({ includeUncontrolled: true }).then((all) => respond({ seen, installed, activated, clients: all.map((client) => client.url).sort() }));
		return true;
	});`,
	'w.html':
		'<!doctype html><html><head><title>worker page</title><script src="gen.js?page"></script></head><body><script src="w.js"></script></body></html>',
	'w.js': `(async () => {
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'none')]);
		const out = {};
		out.gen = window.GEN;
		const text = (path) => fetch(path).then((response) => response.text(), (error) => error.name);
		out.w = await text('w.txt');
		out.plain = await text('plain.txt');
		out.gone = await text('gone.txt');
		const later = await fetch('later.txt');
		out.later = [later.status, later.headers.get('x-from'), await later.text()];
		const container = navigator.serviceWorker;
		out.controller = container.controller ? container.controller.scriptURL : null;
		const ready = await within(container.ready, 5000);
		out.ready = ready === 'none' ? 'none' : [ready.scope, ready.active && ready.active.scriptURL, ready.active && ready.active.state, ready.active === container.controller];
		const target = container.controller || (ready !== 'none' && ready.active);
		const echo = new Promise((resolve) => { container.onmessage = (event) => resolve({ data: event.data, origin: event.origin, source: event.source === target, event: event.constructor.name }); });
		if (target) target.postMessage({ hi: 1 });
		out.echo = await within(echo, 3000);
		out.seen = await chrome.runtime.sendMessage('seen');
		document.documentElement.dataset.worker = JSON.stringify(out);
	})().catch((error) => { document.documentElement.dataset.worker = JSON.stringify({ error: String(error && error.stack || error) }); });`,
	'w-frame.html':
		'<!doctype html><html><head><title>worker frame</title><script src="gen.js?frame"></script></head><body><script src="w-frame.js"></script></body></html>',
	'w-frame.js': `(async () => {
		const w = await fetch('w.txt?frame').then((response) => response.text(), (error) => error.name);
		parent.postMessage({ frame: location.pathname, gen: window.GEN, w, controller: !!navigator.serviceWorker.controller }, '*');
	})();`,
	'cs.js': `if (window === top) (async () => {
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'none')]);
		const out = {};
		out.fetched = await fetch(chrome.runtime.getURL('w.txt?cs')).then((response) => response.text(), (error) => error.name);
		const hello = new Promise((resolve) => addEventListener('message', (event) => event.data && event.data.frame && resolve(event.data)));
		const frame = document.createElement('iframe');
		frame.src = chrome.runtime.getURL('w-frame.html');
		document.documentElement.append(frame);
		out.frame = await within(hello, 8000);
		out.seen = await chrome.runtime.sendMessage('seen');
		document.documentElement.dataset.worker = JSON.stringify(out);
	})().catch((error) => { document.documentElement.dataset.worker = JSON.stringify({ error: String(error && error.stack || error) }); });`,
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
	// a request the probe's rules block: told to onBeforeRequest first, then onErrorOccurred
	self.seen = [];
	self.errors = [];
	chrome.webRequest.onBeforeRequest.addListener((details) => {
		if (details.url.includes('dnr-static&mv2')) self.seen.push(details.type);
	}, { urls: ['*://*/pages/ext-plain.txt*'] });
	chrome.webRequest.onErrorOccurred.addListener((details) => {
		if (details.url.includes('dnr-static&mv2')) self.errors.push(details.error);
	}, { urls: ['*://*/pages/ext-plain.txt*'] });
	// what onBeforeSendHeaders sees of a request the probe's rule changes
	// the headers of (the page's, before the rule's), and what it asks for:
	// x-order is a field the rule set, so its change is dropped whole
	self.order = [];
	const field = (headers, name) => headers.find((header) => header.name.toLowerCase() === name)?.value ?? null;
	chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
		const free = details.url.includes('&free');
		self.order.push(['before', free, field(details.requestHeaders, 'x-order'), field(details.requestHeaders, 'x-dnr-added')]);
		const requestHeaders = details.requestHeaders.filter((header) => free || header.name.toLowerCase() !== 'x-order');
		if (!free) requestHeaders.push({ name: 'x-order', value: 'listener' });
		requestHeaders.push({ name: 'x-listener', value: 'yes' });
		return { requestHeaders };
	}, { urls: ['*://*/echo-headers?send-order*'] }, ['blocking', 'requestHeaders']);
	chrome.webRequest.onSendHeaders.addListener((details) => {
		self.order.push(['sent', details.url.includes('&free'), field(details.requestHeaders, 'x-order'), field(details.requestHeaders, 'x-listener')]);
	}, { urls: ['*://*/echo-headers?send-order*'] }, ['requestHeaders']);
	chrome.browserAction.setBadgeText({ text: 'B' });
	chrome.runtime.onMessage.addListener((message, sender, respond) => {
		if (message === 'completed') respond({
			count: self.completed.length,
			seen: self.seen,
			errors: self.errors,
			order: self.order,
			extra: chrome.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS,
		});
	});`,
	'cs.js': `(async () => {
		const out = {};
		try { await fetch('/pages/ext-blocked.txt'); out.blocked = 'loaded'; } catch (error) { out.blocked = 'failed'; }
		out.redirect = (await (await fetch('/pages/ext-redirect.txt')).text()).trim();
		out.added = (await fetch('/pages/ext-plain.txt?h')).headers.get('x-ext-added');
		try { await fetch('/pages/ext-plain.txt?dnr-static&mv2'); out.dnrBlocked = 'loaded'; } catch (error) { out.dnrBlocked = 'failed'; }
		const echo = (query) => fetch('/echo-headers?send-order' + query, { headers: { 'x-order': 'page' } })
			.then((response) => response.json()).then((headers) => [headers['x-order'] ?? null, headers['x-dnr-added'] ?? null, headers['x-listener'] ?? null], (error) => String(error));
		out.order = { conflict: await echo(''), free: await echo('&free') };
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

/**
 * Ask for a world's module routes as a page that got past the inject would:
 * one exposed to every site, and one exposed to https://only.example only
 * with a query naming that origin. The routes are the ones `frame`'s world
 * loaded, read from its resource timing in a DevTools world (the inject
 * does not hook it); the asking document is one the worker controls that
 * is no routed page, so the worker can name no origin for it, and its
 * fetch is unhooked
 */
async function forgedModules(page, frame, id) {
	if (!frame) return null;
	let session;
	try {
		session = await page.context().newCDPSession(frame);
	} catch (error) {
		// (a frame of the page's process: the page's session has it)
		session = await page.context().newCDPSession(page);
	}
	let route;
	try {
		const { frameTree } = await session.send('Page.getFrameTree');
		const find = (tree) =>
			tree.frame.url === frame.url()
				? tree.frame.id
				: (tree.childFrames ?? []).map(find).find(Boolean);
		const { executionContextId } = await session.send(
			'Page.createIsolatedWorld',
			{ frameId: find(frameTree), worldName: 'routes' },
		);
		const loaded = (
			await session.send('Runtime.evaluate', {
				expression: `performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes(${JSON.stringify(`/extcs/${id}/`)}) && name.endsWith('/m/cs/mod.js'))`,
				contextId: executionContextId,
				returnByValue: true,
			})
		).result.value;
		if (!loaded) return { error: 'no module route in resource timing' };
		route = loaded.slice(0, -'mod.js'.length);
	} catch (error) {
		return { error: String(error) };
	} finally {
		await session.detach().catch(() => {});
	}
	const channel = route.slice(0, route.indexOf('/extcs/') + 1);
	const forge = `?o=${encodeURIComponent('https://only.example')}`;
	const forger = await page.context().newPage();
	try {
		// (a file of the worker's scope the server answers as it is, with no
		// policy to refuse a fetch: a controlled document at no routed URL)
		const scope = channel.replace(/[^/]+\/$/, '');
		await forger
			.goto(`${scope}controller.mjs`, { waitUntil: 'load' })
			.catch(() => {});
		// status and body length: a refusal of the worker's has no body, a
		// request it passed on gets the server's error page
		const read = (url) =>
			forger.evaluate(
				(at) =>
					fetch(at).then(
						async (response) =>
							`${response.status}:${(await response.text()).length}`,
						(error) => String(error),
					),
				url,
			);
		return {
			controlled: await forger.evaluate(
				() => !!navigator.serviceWorker.controller,
			),
			// (an entry's script, which the worker gives any document: its
			// routes answer this one)
			entry: await read(route.replace(/m\/cs\/$/, 'm0.js')),
			exposed: await read(`${route}mod.js`),
			forged: await read(`${route}secret.js${forge}`),
		};
	} catch (error) {
		return { error: String(error) };
	} finally {
		await forger.close().catch(() => {});
	}
}

const TARGET = 'extension target';
const OTHER = 'no extension here';
const TRUSTED = 'trusted types target';
const COMPAT = 'compat target';
const ORIGIN = 'origin target';
const ORIGIN_PAGE = 'origin page';
const WORKER = 'worker target';
const WORKER_PAGE = 'worker page';

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
	ok(
		`${mode}: an isolated world sees none of the page's globals, prototype changes or expandos`,
		end?.pageVar === 'undefined' &&
			end.pagePolluted === true &&
			end.pageExpando === true &&
			end.sheets === true,
		JSON.stringify(end),
	);
	ok(
		`${mode}: an isolated world's DOM objects, builtins and location are its own, its scripts share their globals`,
		end?.windowInstance === true &&
			end.nodeInstance === true &&
			end.builtins === true &&
			end.chains === true &&
			end.declaration === 'color: rgb(4, 5, 6); 1' &&
			end.shared === true &&
			end.path === '/pages/ext-target.html' &&
			end.href === true,
		JSON.stringify(end),
	);
	const events = JSON.parse(
		(await poll(page, TARGET, () => {
			const seen = document.documentElement.dataset.events;
			return seen && seen.includes('message') && seen.includes('detail')
				? seen
				: null;
		})) ?? 'null',
	);
	ok(
		`${mode}: an event's detail and a message's data reach an isolated world as its own`,
		events?.detail === '{"list":[1,2]}' &&
			events.detailOwn === true &&
			events.message === 'page' &&
			events.messageOwn === true,
		JSON.stringify(events),
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
		`${mode}: a content script's import() loads the extension's module in its world`,
		idle?.module?.dep === 'dep' &&
			idle.module.twice === 'aa' &&
			idle.module.id === probeId &&
			idle.module.title === 'extension' &&
			idle.module.meta === true &&
			idle.module.page === 'undefined' &&
			idle.module.live === 1 &&
			idle.module.secret === 'refused',
		JSON.stringify(idle?.module),
	);
	// a document that asks for a world's module itself, past the inject:
	// judged by its own origin (none the worker can name, here), whatever
	// origin its query names
	const forged = await forgedModules(
		page,
		await documentAt(page, TARGET),
		probeId,
	);
	ok(
		`${mode}: a world's module is refused to a document whose origin the worker cannot name, whatever origin its query names`,
		forged?.controlled === true &&
			/^200:[1-9]/.test(forged.entry) &&
			forged.exposed === '404:0' &&
			forged.forged === '404:0',
		JSON.stringify(forged),
	);
	// what the page saw of the worlds: no frame, node, load or global of
	// theirs, and none of their changes (the blocker's world was made at
	// document_end, after the page's observer was there)
	const pageSaw = await (
		await documentAt(page, TARGET)
	)?.evaluate(() => ({
		...window.__seen,
		length: window.length,
		frames: frames.length,
		worldVar: typeof window.__worldVar,
		worldVar2: typeof window.worldVar,
		polluted: [].__worldPolluted === undefined,
		expando: document.getElementById('target').worldExpando === undefined,
		handler: String(document.getElementById('target').onmouseleave),
		handlerName: document.getElementById('target').onmouseleave?.name,
		adds: window.__pageAdds,
		names: Object.getOwnPropertyNames(window).filter(
			(name) => !name.startsWith('__'),
		),
	}));
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
	const taken = idle?.matched?.matched ?? {};
	const tab = idle?.matched?.tab;
	ok(
		`${mode}: declarativeNetRequest's matches carry the tab's id: the main frame the host sent, a frame in it and its request, a request and a WebSocket of the top document`,
		typeof tab === 'number' &&
			tab >= 0 &&
			['main', 'frame', 'nested', 'xhr', 'socket'].every(
				(name) => taken[name]?.tabId === tab,
			),
		JSON.stringify(idle?.matched),
	);
	const nestedId = taken.frame?.frameId;
	const seen = Array.isArray(idle?.matched?.frames)
		? idle.matched.frames.find(([, url]) =>
				String(url).includes('ext-tab-probe=iresrc'),
			)
		: null;
	ok(
		`${mode}: their frame ids: the top document 0, the frame its own (the one executeScript reports), the parent of the frame's request 0`,
		taken.main?.frameId === 0 &&
			taken.main.parentFrameId === -1 &&
			nestedId > 0 &&
			taken.frame.parentFrameId === 0 &&
			taken.nested?.frameId === nestedId &&
			taken.nested.parentFrameId === 0 &&
			seen?.[0] === nestedId &&
			taken.xhr?.frameId === 0 &&
			taken.xhr.parentFrameId === -1 &&
			taken.socket?.frameId === 0,
		JSON.stringify({ taken, frames: idle?.matched?.frames }),
	);
	ok(
		`${mode}: a frame whose parent sets its src keeps its id: its navigation's request and its next document's`,
		nestedId > 0 &&
			taken.resrc?.type === 'sub_frame' &&
			taken.resrc.frameId === nestedId &&
			taken.resrc.parentFrameId === 0 &&
			taken.again?.frameId === nestedId &&
			taken.again.parentFrameId === 0,
		JSON.stringify({ nestedId, resrc: taken.resrc, again: taken.again }),
	);
	ok(
		`${mode}: a frame whose document announces nothing (an image) and whose parent sets its src: the next document keeps the frame's id once it reports`,
		nestedId > 0 &&
			taken.img?.frameId === nestedId &&
			taken.iagain?.frameId === nestedId &&
			taken.iagain.parentFrameId === 0,
		JSON.stringify({
			nestedId,
			img: taken.img,
			iresrc: taken.iresrc,
			iagain: taken.iagain,
		}),
	);
	ok(
		`${mode}: a frame of another origin whose parent sets its src keeps its id`,
		taken.xframe?.frameId > 0 &&
			taken.xframe.frameId !== nestedId &&
			taken.xresrc?.frameId === taken.xframe.frameId &&
			taken.xagain?.frameId === taken.xframe.frameId &&
			taken.xagain.parentFrameId === 0,
		JSON.stringify({
			xframe: taken.xframe,
			xresrc: taken.xresrc,
			xagain: taken.xagain,
		}),
	);
	ok(
		`${mode}: a dedicated worker's request and WebSocket are in its page's tab and frame`,
		typeof tab === 'number' &&
			['wfetch', 'wsocket'].every(
				(name) => taken[name]?.tabId === tab && taken[name].frameId === 0,
			) &&
			taken.wsocket.type === 'websocket',
		JSON.stringify({ wfetch: taken.wfetch, wsocket: taken.wsocket }),
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
		`${mode}: a request another extension's rule blocks reaches webRequest.onBeforeRequest, then onErrorOccurred`,
		mv2?.dnrBlocked === 'failed' &&
			mv2.completed?.seen?.join() === 'xmlhttprequest' &&
			mv2.completed.errors?.join() === 'net::ERR_BLOCKED_BY_CLIENT',
		JSON.stringify({ blocked: mv2?.dnrBlocked, completed: mv2?.completed }),
	);
	// as MergeOnBeforeSendHeadersResponses: the listener sees the page's
	// fields, DNR's changes go first, and a listener's change that sets a
	// field DNR set to another value is dropped whole
	const order = mv2?.completed?.order ?? [];
	const step = (name, free) =>
		JSON.stringify(
			order.find(([at, isFree]) => at === name && isFree === free)?.slice(2),
		);
	ok(
		`${mode}: onBeforeSendHeaders sees the headers before DNR's changes, and DNR's win a conflict as in Chrome`,
		step('before', false) === '["page",null]' &&
			step('before', true) === '["page",null]' &&
			JSON.stringify(mv2?.order?.conflict) === '["dnr","yes",null]' &&
			JSON.stringify(mv2?.order?.free) === '["dnr","yes","yes"]' &&
			step('sent', false) === '["dnr",null]' &&
			step('sent', true) === '["dnr","yes"]',
		JSON.stringify({ order, sent: mv2?.order }),
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

	// (the global names of a document no extension reaches, against what
	// the target's page saw above: the frame goes to the target after)
	await page.evaluate((url) => window.__frame.go(url), other);
	await poll(page, OTHER, () => document.readyState === 'complete');
	const control = await (
		await documentAt(page, OTHER)
	)?.evaluate(() =>
		Object.getOwnPropertyNames(window).filter((name) => !name.startsWith('__')),
	);
	const extra = pageSaw?.names.filter((name) => !control?.includes(name));
	ok(
		`${mode}: the page sees nothing of an isolated world: no frame, node, load event or global`,
		pageSaw?.length === 0 &&
			pageSaw.frames === 0 &&
			pageSaw.lengths.every((length) => length === 0) &&
			pageSaw.added.length === 0 &&
			pageSaw.loads.length === 0 &&
			pageSaw.worldVar === 'undefined' &&
			pageSaw.worldVar2 === 'undefined' &&
			pageSaw.polluted &&
			pageSaw.expando &&
			pageSaw.adds === 0 &&
			/^function worldLeave\(\) \{\s*\[native code\]\s*\}$/.test(
				pageSaw.handler,
			) &&
			pageSaw.handlerName === 'worldLeave' &&
			extra?.length === 0,
		JSON.stringify({ ...pageSaw, names: undefined, extra }),
	);
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
	const ttEnd = JSON.parse(
		(await poll(page, TRUSTED, datasetOf('end'))) ?? 'null',
	);
	const ttPage = await (
		await documentAt(page, TRUSTED)
	)?.evaluate(() => ({
		own: window.__ownWrite,
		violations: window.__violations,
		list: window.__violationList,
	}));
	ok(
		`${mode}: an isolated world writes markup and script URLs under the page's Trusted Types, which still refuse the page's own`,
		ttEnd?.tt?.html === true &&
			ttEnd.tt.src === 'set' &&
			ttEnd.tt.inner === 'I' &&
			ttPage?.own === 'refused' &&
			ttPage.violations === 1,
		JSON.stringify({ tt: ttEnd?.tt, page: ttPage }),
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
	// it answers once each document ran it, as Chrome's does: a frame's
	// isolated or USER_SCRIPT world is no document of its own to wait for
	// (the call waited out its 10 s bound for them, and askCompat's wait
	// is no longer than that)
	ok(
		`${mode}: executeScript answers once its frames ran it, not at its time limit`,
		typeof exec?.ms === 'number' && exec.ms < 5000,
		String(exec?.ms),
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

	// a main frame's redirect is the navigation's tab
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}redirect?to=${encodeURIComponent(target)}`,
	);
	const redirected = JSON.parse(
		(await poll(page, TARGET, datasetOf('idle'), 30000)) ?? 'null',
	);
	ok(
		`${mode}: a main frame's redirected request is in the tab the navigation is in`,
		typeof redirected?.matched?.tab === 'number' &&
			redirected.matched.matched?.main?.tabId === redirected.matched.tab &&
			redirected.matched.matched.main.url === target,
		JSON.stringify(redirected?.matched?.matched?.main),
	);
	// a navigation no hooked document announces: from an image document (no
	// inject), the host sets the frame's src itself. Its main frame's request
	// is in no known tab; its matched rules go to the tab its document reports
	await page.evaluate((url) => {
		// (an image document never reports: no wait for it)
		void window.__frame.go(url);
	}, `${FIXTURE}pages/object-events.png`);
	await sleep(2000);
	const since = Date.now() - 1;
	await page.evaluate(
		async ({ url, proxyOrigin }) => {
			const routed = await window.__controller.route(url);
			window.__frame.element.src = new URL(routed, proxyOrigin).href;
		},
		{ url: `${target}?tab-rules=${since}`, proxyOrigin: new URL(PROXY).origin },
	);
	const unannounced = JSON.parse(
		(await poll(
			page,
			TARGET,
			// (the new document's: the last one's has no tabRules)
			() => {
				const idle = document.documentElement.dataset.idle;
				return idle?.includes('"tabRules"') ? idle : null;
			},
			30000,
		)) ?? 'null',
	);
	ok(
		`${mode}: an unannounced navigation's main frame match is its tab's once its document reports (getMatchedRules)`,
		Array.isArray(unannounced?.tabRules) && unannounced.tabRules.includes(3),
		JSON.stringify({
			tabRules: unannounced?.tabRules,
			main: unannounced?.matched?.matched?.main,
		}),
	);

	// the origin probe (see `originProbe`): chrome-extension:// wherever
	// Chrome shows it, in a content script, the service worker and a page
	const originInfo = await page.evaluate(
		(files) =>
			window.__controller.extensions.install(files, { filename: 'origin' }),
		originProbe,
	);
	const originId = originInfo.id;
	const own = `chrome-extension://${originId}`;
	await sleep(1500);
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/ext-origin.html`,
	);
	const inContent = JSON.parse(
		(await poll(page, ORIGIN, datasetOf('origin'), 20000)) ?? 'null',
	);
	ok(
		`${mode}: a content script's getURL is at chrome-extension:// and loads there`,
		inContent?.getURL === `${own}/x.svg` &&
			inContent.parsed?.join() ===
				`chrome-extension:,${originId},${own},/x.svg,?q,#h` &&
			inContent.imgLoaded === true &&
			inContent.fetched === 'war body',
		JSON.stringify(inContent),
	);
	ok(
		`${mode}: an extension frame in a page is of chrome-extension://, to its messages and to the page`,
		inContent?.hello?.origin === own &&
			inContent.hello.frameOrigin === own &&
			inContent.hello.frame === `${own}/o-frame.html` &&
			inContent.pong === own,
		JSON.stringify(inContent?.hello) + JSON.stringify(inContent?.pong),
	);
	ok(
		`${mode}: the service worker's location is its script's at chrome-extension://`,
		inContent?.sender?.swHref === `${own}/sw.js` &&
			inContent.sender.swOrigin === own &&
			inContent.sender.swHost === originId &&
			inContent.sender.self === own &&
			inContent.sender.getURL === `${own}/`,
		JSON.stringify(inContent?.sender),
	);
	await page.evaluate(
		(url) => window.__frame.go(window.__controller.extensions.resolveUrl(url)),
		`${own}/o.html`,
	);
	const inPage = JSON.parse(
		(await poll(page, ORIGIN_PAGE, datasetOf('origin'), 20000)) ?? 'null',
	);
	const pageURL = `${own}/o.html`;
	ok(
		`${mode}: an extension page's location and document read chrome-extension://`,
		inPage?.href === pageURL &&
			inPage.origin === own &&
			inPage.protocol === 'chrome-extension:' &&
			inPage.host === originId &&
			inPage.string === pageURL &&
			inPage.url === pageURL &&
			inPage.documentURI === pageURL &&
			inPage.baseURI === pageURL &&
			inPage.self === own &&
			inPage.domain === originId,
		JSON.stringify(inPage),
	);
	ok(
		`${mode}: an extension page's own URLs read back at chrome-extension:// and load`,
		inPage?.getURL === `${own}/x.svg` &&
			inPage.img === `${own}/x.svg` &&
			inPage.imgLoaded === true &&
			inPage.fetched === 'war body' &&
			inPage.responseURL === `${own}/war.txt` &&
			inPage.byOrigin === 'war body' &&
			inPage.moved === `${own}/o-frame.html?moved`,
		JSON.stringify(inPage),
	);
	ok(
		`${mode}: an extension page's blob: URLs, a link's parts and the runtime's getters read as Chrome's`,
		inPage?.blob === `blob:${own}/U` &&
			inPage.blobText === 'blob body' &&
			JSON.stringify(inPage.link) ===
				JSON.stringify([
					`${own}/x.svg?q#h`,
					own,
					'chrome-extension:',
					originId,
					originId,
					'/x.svg',
					'?q',
					'#h',
				]) &&
			JSON.stringify(inPage.blobLink) ===
				JSON.stringify([own, 'blob:', '', own]) &&
			JSON.stringify(inPage.sources) ===
				JSON.stringify([
					'function get URL() { [native code] }',
					'function get src() { [native code] }',
					'function get origin() { [native code] }',
					'function get href() { [native code] }',
					'function toString() { [native code] }',
					'function get domain() { [native code] }',
					'function createObjectURL() { [native code] }',
					'function get serviceWorker() { [native code] }',
				]),
		JSON.stringify({
			blob: inPage?.blob,
			link: inPage?.link,
			blobLink: inPage?.blobLink,
			sources: inPage?.sources,
		}),
	);
	ok(
		`${mode}: an extension page's messages are from chrome-extension://, and reach a frame of it`,
		inPage?.pong === own &&
			inPage.sender?.url === pageURL &&
			inPage.sender.origin === own &&
			inPage.sender.tab === pageURL &&
			JSON.stringify(inPage.tabs) === JSON.stringify([pageURL]),
		JSON.stringify({
			pong: inPage?.pong,
			sender: inPage?.sender,
			tabs: inPage?.tabs,
		}),
	);
	await page.evaluate(
		(id) => window.__controller.extensions.remove(id),
		originId,
	);

	// the worker probe (see `workerProbe`): Chrome gives the worker's fetch
	// handler what the extension's pages load and its pages' navigations, a
	// web page's frame of one too, but not a web page's own loads
	const workerInfo = await page.evaluate(
		(files) =>
			window.__controller.extensions.install(files, { filename: 'worker' }),
		workerProbe,
	);
	const workerId = workerInfo.id;
	const ownWorker = `chrome-extension://${workerId}`;
	await sleep(1500);
	await page.evaluate(
		(url) => window.__frame.go(url),
		`${FIXTURE}pages/ext-worker.html`,
	);
	const workerContent = JSON.parse(
		(await poll(page, WORKER, datasetOf('worker'), 20000)) ?? 'null',
	);
	const framed = [
		'/w-frame.html navigate iframe',
		'/gen.js?frame no-cors script',
		'/w-frame.js no-cors script',
		'/w.txt?frame cors ',
	];
	ok(
		`${mode}: a web page's own load of a web accessible file does not reach the extension's worker`,
		workerContent?.fetched === 'package w' &&
			!workerContent.seen?.seen?.some((seen) => seen.startsWith('/w.txt?cs')),
		JSON.stringify(workerContent),
	);
	ok(
		`${mode}: an extension frame in a web page is its worker's, its navigation and loads too`,
		workerContent?.frame?.gen === '?frame' &&
			workerContent.frame.w === `worker w ${ownWorker}/w.txt?frame` &&
			workerContent.frame.controller === true &&
			JSON.stringify(workerContent.seen?.seen) === JSON.stringify(framed),
		JSON.stringify(workerContent),
	);
	await page.evaluate(
		(url) => window.__frame.go(window.__controller.extensions.resolveUrl(url)),
		`${ownWorker}/w.html`,
	);
	const workerPage = JSON.parse(
		(await poll(page, WORKER_PAGE, datasetOf('worker'), 20000)) ?? 'null',
	);
	ok(
		`${mode}: an extension page's loads reach its worker, which answers, lets one go to the package, fails one and answers one late`,
		workerPage?.gen === '?page' &&
			workerPage.w === `worker w ${ownWorker}/w.txt` &&
			workerPage.plain === 'package plain' &&
			workerPage.gone === 'TypeError' &&
			JSON.stringify(workerPage.later) ===
				JSON.stringify([201, 'worker', 'worker later']),
		JSON.stringify(workerPage),
	);
	ok(
		`${mode}: the worker's fetch events are Chrome's: which requests, their URLs, modes and destinations`,
		JSON.stringify(workerPage?.seen?.seen) ===
			JSON.stringify([
				...framed,
				'/w.html navigate document',
				'/gen.js?page no-cors script',
				'/w.js no-cors script',
				'/w.txt cors ',
				'/plain.txt cors ',
				'/gone.txt cors ',
				'/later.txt cors ',
			]),
		JSON.stringify(workerPage?.seen),
	);
	ok(
		`${mode}: an extension page's navigator.serviceWorker is the worker's, and its messages go both ways`,
		workerPage?.controller === `${ownWorker}/sw.js` &&
			JSON.stringify(workerPage.ready) ===
				JSON.stringify([
					`${ownWorker}/`,
					`${ownWorker}/sw.js`,
					'activated',
					true,
				]) &&
			JSON.stringify(workerPage.echo) ===
				JSON.stringify({
					data: {
						echo: { hi: 1 },
						type: 'window',
						url: `${ownWorker}/w.html`,
						origin: ownWorker,
						client: true,
						event: 'ExtendableMessageEvent',
					},
					origin: ownWorker,
					source: true,
					event: 'MessageEvent',
				}),
		JSON.stringify(workerPage?.echo),
	);
	ok(
		`${mode}: the worker ran its install and activate handlers, and its clients are the extension's pages`,
		workerPage?.seen?.installed === true &&
			workerPage.seen.activated === true &&
			JSON.stringify(workerPage.seen.clients) ===
				JSON.stringify([`${ownWorker}/w.html`]),
		JSON.stringify(workerPage?.seen),
	);
	await page.evaluate(
		(id) => window.__controller.extensions.remove(id),
		workerId,
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
