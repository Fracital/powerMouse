// STomp demo: Powermouse-styled landing page, a browser view with tabs, and
// an early-Android style navigation bar. Everything uses the public
// StompController / Frame API from dist/Controller.js.

const DIRECTORY = '/stomp/';
const SEARCH = new SearchBuilder('https://search.brave.com/search?q=%s');
const QUICK_LINKS = [
	['Reddit', 'https://www.reddit.com/', 'orange'],
	['Google', 'https://www.google.com/', 'green'],
	['YouTube', 'https://www.youtube.com/', 'red'],
	['Discord', 'https://discord.com/login', 'blue'],
];

const $ = (id) => document.getElementById(id);

// Console badges, after the two-tone "%c Browser %c ..." lines krunker's
// dev console prints: a grey label cell and a coloured value cell. The
// deployment facts (mode, origins, transport, version) go here, not on the
// page.
const BADGE_LEFT =
	'padding: 1px 4px; border-radius: 3px 0 0 3px; color: #fff; background: #606060;';
const BADGE_RIGHT =
	'padding: 1px 4px; border-radius: 0 3px 3px 0; color: #fff; background: ';
const BADGE = {
	blue: '#1475b2',
	green: '#2e9e4f',
	orange: '#f2a20d',
	red: '#c0392b',
	grey: '#606060',
};
function badge(label, value, color = 'blue') {
	console.info(
		`%c ${label} %c ${value} `,
		BADGE_LEFT,
		BADGE_RIGHT + (BADGE[color] || color) + ';',
	);
}
const landing = $('landing');
const browser = $('browser');
const framesContainer = $('frames');
const recentsPanel = $('recentsPanel');
const recentsList = $('recentsList');
const landingStatus = $('logMsg');
const chromeStatus = $('chromeStatus');
const transportSelect = $('transport');
const adblockToggle = $('adblock');
const omni = $('omni');
const mainForm = $('mainForm');

// Deployment config comes from /config.js (demo/server.js renders it from the
// environment); anything missing falls back to the local-development defaults.
const CFG = window.STOMP_CONFIG || {};

// Origin isolation: the proxy (dist/, transports, wisp, every proxied page)
// can be served from a different origin than this page, so proxied content is
// a cross-origin, sandboxed frame that can neither read this page nor navigate
// it. STOMP_PROXY_ORIGIN selects that; locally, opening the demo as localhost
// uses 127.0.0.1 (same server) as the proxy origin. Without either, the demo
// runs the same-origin controller, which is NOT a security boundary.
const PROXY_ORIGIN =
	'proxyOrigin' in CFG
		? CFG.proxyOrigin || null
		: location.hostname === 'localhost'
			? location.origin.replace('localhost', '127.0.0.1')
			: null;
let ISOLATED = !!PROXY_ORIGIN && PROXY_ORIGIN !== location.origin;
// HTTP cache in the service worker, on by default; ?nocache turns it off for a
// visit
const CACHE = !new URLSearchParams(location.search).has('nocache');
// emulated service workers for the proxied pages (docs/service-workers.md),
// on by default; ?nosw turns them off for a visit (?sw=<ms> sets how long a
// worker may take to answer, for the suites)
const SERVICE_WORKERS = !new URLSearchParams(location.search).has('nosw');
const SERVICE_WORKER_TIMEOUT =
	Number(new URLSearchParams(location.search).get('sw')) || undefined;
// ?swdelay=<ms>: every service worker event reaches the pages that much
// later than the answers to their calls (the suites' race check)
const SERVICE_WORKER_EVENT_DELAY =
	Number(new URLSearchParams(location.search).get('swdelay')) || undefined;
// HTTP/3 over wisp UDP for origins that offer it (docs/http3.md), on by
// default as in Chrome; STOMP_HTTP3=0 on the server turns it off, and
// ?http3=0 (off) or ?http3 (on) on this page decides for one visit
const HTTP3 = new URLSearchParams(location.search).has('http3')
	? new URLSearchParams(location.search).get('http3') !== '0'
	: CFG.http3 !== false;
// the Rust rewriters (docs/rust-plan.md): STOMP_REWRITER=wasm on the server
// or ?wasm on this page; ?js keeps the JavaScript ones for one load
const REWRITER = new URLSearchParams(location.search).has('js')
	? 'js'
	: CFG.rewriter === 'wasm' || new URLSearchParams(location.search).has('wasm')
		? 'wasm'
		: '';
// the built-in content blocker (docs/adblock.md), on unless something says
// off. In order: ?noadblock and ?adblock on this page (one load), the toggle
// beside the transport select (remembered), STOMP_ADBLOCK=0 on the server.
// On, the controller is given nothing (the blocker is the library's default)
// or the lists STOMP_ADBLOCK named; off, `adblock: false`
const ADBLOCK = (() => {
	const query = new URLSearchParams(location.search);
	let on = CFG.adblock !== false;
	try {
		const saved = localStorage.getItem('stomp-demo:adblock');
		if (saved !== null) on = saved === '1';
	} catch {}
	if (query.has('adblock')) on = true;
	if (query.has('noadblock')) on = false;
	if (!on) return { adblock: false };
	return typeof CFG.adblock === 'object' ? { adblock: CFG.adblock } : {};
})();

// Per-site shields (the content blocker's UI, docs/adblock.md). The state is
// host-keyed and kept in this page's own localStorage; the controller carries
// it to the service worker, which applies each layer (the ad/tracker blocker,
// HTTPS upgrading, the cookie policy) for that site. onShieldsChange persists
// every change the panel makes.
const SHIELDS_KEY = 'stomp-demo:shields';
function loadShields() {
	try {
		const raw = JSON.parse(localStorage.getItem(SHIELDS_KEY));
		return Array.isArray(raw) ? raw : [];
	} catch {
		return [];
	}
}
function persistShields() {
	try {
		localStorage.setItem(SHIELDS_KEY, JSON.stringify(controller.shields.all()));
	} catch {}
}
// the shields the controller starts with: what this page kept, plus a '*'
// default entry so every host with no entry of its own gets the "goodies on"
// defaults (the blocker on, HTTPS upgraded, fingerprint protected, third-party
// cookies blocked; DEFAULT_SHIELDS). STOMP_SHIELDS_DEFAULTS=0 on the server
// (the native-parity test suites) leaves it out, so no-entry hosts stay neutral
// and those suites compare against native behaviour.
function initialShields() {
	const list = loadShields();
	if (CFG.shieldsDefaults !== false && !list.some((e) => e && e.host === '*'))
		list.push({ host: '*' });
	return list;
}
// how many requests the blocker stopped or redirected for each tab's frame,
// for the omnibar badge and the panel's count; reset when a tab navigates
const blockedCounts = new Map();
// real Encrypted Client Hello where a site's HTTPS DNS record has a config,
// looked up over DoH by epoxy (STOMP_ECH_DNS on the server; ?noech sends
// GREASE ECH only, as before)
const ECH_DNS = new URLSearchParams(location.search).has('noech')
	? null
	: CFG.echDns;
// the transports and the built-in wisp live on the proxy origin
const proxyBase = () => (ISOLATED ? PROXY_ORIGIN : '');
// STOMP_WISP_URL points the transports at an external wisp server (in
// production, the edge relay); otherwise the demo server's own /wisp/
const wispURL = () =>
	CFG.wisp ||
	`${(ISOLATED ? PROXY_ORIGIN : location.origin).replace(/^http/, 'ws')}/wisp/`;

// transports are described, not constructed: the controller imports and
// constructs the module in a dedicated worker (in isolation mode inside the
// controller frame on the proxy origin), off this page's thread, so a
// proxied page's synchronous XHR can be answered while it spins
const transports = {
	epoxy: () => ({
		// a test run's epoxy that also reaches the suites' fixture hosts
		// (demo/public/test/mixed-transport.mjs)
		module: CFG.testTransport
			? `${proxyBase()}/test/mixed-transport.mjs`
			: `${proxyBase()}/epoxy/index.mjs`,
		options: [{ wisp: wispURL(), ...(ECH_DNS && { ech_dns: ECH_DNS }) }],
		// stomp-h3 is looked for next to the transport module, and the test
		// transport is not next to epoxy's
		...(HTTP3 && {
			http3: CFG.testTransport
				? { module: `${proxyBase()}/epoxy/h3/stomp_h3.js` }
				: true,
		}),
	}),
	libcurl: () => ({
		module: `${proxyBase()}/libcurl/index.mjs`,
		// libcurl.js 0.7's default pool (50 total, 6 per host) deadlocks once a
		// page fans out more requests than that; see CHANGELOG known limitations
		options: [{ wisp: wispURL(), connections: [500, 400, 200] }],
	}),
};

let controller;

/** @type {{ frame: Frame, element: HTMLIFrameElement, url: string }[]} */
const tabs = [];
let activeTab = null;

// hooks for the live reload client (/pm/dev.js, loaded by index.html under
// `npm run dev` only): it reloads the proxied frames when an inject bundle or
// the service worker is rebuilt, and needs to know which controller runs
if (CFG.dev) {
	window.__stompDev = Object.assign(window.__stompDev || {}, {
		tabs: () => tabs,
		reloadFrames: () => {
			for (const tab of tabs) tab.frame.reload();
			return tabs.length;
		},
	});
	// read when used: boot() falls back to same origin where isolation cannot run
	Object.defineProperty(window.__stompDev, 'isolated', {
		get: () => ISOLATED,
		configurable: true,
	});
}

function setStatus(text, error = false) {
	// the landing line, the live bar and every card's copy of the bar
	const chips = document.querySelectorAll('.cardLabel .status');
	for (const node of [landingStatus, chromeStatus, ...chips]) {
		node.textContent = text;
		node.classList.toggle('error', error);
	}
}

// the address box's text stops short of the status chip and the star over
// its right end, whatever the status says; the cards' copies take the same
// room (--omni-end), so a card's bar stays a picture of the live one
new ResizeObserver(() => {
	const width = $('omniEnd').offsetWidth;
	if (width)
		document.documentElement.style.setProperty('--omni-end', `${width}px`);
}).observe($('omniEnd'));

function preferredTransport() {
	try {
		const saved = localStorage.getItem('stomp-demo:transport');
		if (saved in transports) return saved;
	} catch {}
	return 'epoxy';
}

function rememberTransport(name) {
	try {
		localStorage.setItem('stomp-demo:transport', name);
	} catch {}
	transportSelect.value = name;
}

// the page's callbacks, the same for both controllers
// what a proxied page may ask the browser for: the proxy origin is another
// origin than this page in isolation mode, and its frame gets none of these
// without being named (STomp keeps each site's answer, docs/permissions.md)
const FRAME_ALLOW = [
	'geolocation',
	'camera',
	'microphone',
	'clipboard-read',
	'clipboard-write',
	'midi',
	'display-capture',
	'screen-wake-lock',
	'local-fonts',
	'idle-detection',
	'window-management',
	'captured-surface-control',
	'local-network-access',
	'speaker-selection',
].join('; ');

const PERMISSION_WORDS = {
	geolocation: 'know your location',
	camera: 'use your camera',
	microphone: 'use your microphone',
	notifications: 'show notifications',
	'clipboard-read': 'see text and images copied to the clipboard',
	midi: 'use your MIDI devices',
};

/**
 * A proxied site asks for a permission the browser already gave this proxy
 * for another site: ask the user for this one. Resolves true (Allow),
 * false (Block) or null (closed); one prompt at a time, newest last.
 */
let permissionQueue = Promise.resolve();
function askPermission({ origin, permission }) {
	const asked = permissionQueue.then(
		() =>
			new Promise((resolve) => {
				const box = document.createElement('div');
				box.id = 'permissionPrompt';
				box.className = 'permissionPrompt';
				box.setAttribute('role', 'dialog');
				const text = document.createElement('p');
				let host = origin;
				try {
					host = new URL(origin).host;
				} catch (error) {
					// shown as it came
				}
				text.textContent = `${host} wants to ${
					PERMISSION_WORDS[permission] ?? `use ${permission}`
				}`;
				const buttons = document.createElement('div');
				const button = (label, className, answer) => {
					const element = document.createElement('button');
					element.type = 'button';
					element.className = `btn ${className}`;
					element.textContent = label;
					element.addEventListener('click', () => {
						box.remove();
						resolve(answer);
					});
					buttons.append(element);
				};
				button('Block', 'block', false);
				button('Allow', 'allow btn-blu', true);
				button('Close', 'close', null);
				box.append(text, buttons);
				document.body.append(box);
			}),
	);
	permissionQueue = asked.catch(() => {});
	return asked;
}

// The demo's own keys (Ctrl+Shift+X, Escape, Alt+Left and Alt+Right) while
// a proxied page has focus: its key events never reach this window, so a
// host hook in every proxied document hands them over, as a browser's own
// shortcuts work whatever page has focus. Registered after the inject's
// hooks and the document's open, before the page's first script; the page
// still gets the keys (Ctrl+Shift+X with its default prevented, as here)
const KEY_MESSAGE = '$stompDemo$key';
const KEY_HOOK = `
if (stomp.kind === 'document')
	stomp.window.addEventListener('keydown', (event) => {
		const shortcut = event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyX';
		const arrow = event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
		if (!shortcut && !arrow && event.key !== 'Escape') return;
		if (shortcut) event.preventDefault();
		stomp.window.top.postMessage({ ${JSON.stringify(KEY_MESSAGE)}: {
			key: event.key, code: event.code, ctrlKey: event.ctrlKey,
			shiftKey: event.shiftKey, altKey: event.altKey,
		} }, '*');
	}, true);`;
addEventListener('message', (event) => {
	const key = event.data?.[KEY_MESSAGE];
	if (!key || !tabs.some((tab) => isFrameOf(tab.element, event.source))) return;
	dispatchEvent(
		new KeyboardEvent('keydown', {
			key: String(key.key),
			code: String(key.code),
			ctrlKey: !!key.ctrlKey,
			shiftKey: !!key.shiftKey,
			altKey: !!key.altKey,
		}),
	);
});
/** whether `source` is the window of `element` or a frame inside it */
function isFrameOf(element, source) {
	for (let window = source, depth = 0; window && depth < 16; depth++) {
		if (window === element.contentWindow) return true;
		if (window === window.parent) return false;
		window = window.parent;
	}
	return false;
}

// A bookmark keeps its site's icon as a small picture. The host page cannot
// load it itself: it is outside the service worker's scope, so its request
// would leave the proxy. Every proxied top document hands the host a port,
// and any of them loads any bookmark's icon on request, as a picture: an
// <img> whose src the inject routes (so neither the page's CSP nor a
// cross-origin icon host's missing CORS headers stop it), read back with
// createImageBitmap as it was before the inject's hooks (the route is the
// page's own origin to the browser), at 64 px at the most
const ICON_MESSAGE = '$stompDemo$icon';
const ICON_HOOK = `
if (stomp.kind === 'document' && stomp.isTop) {
	const win = stomp.window;
	const apply = win.Reflect.apply;
	const bitmap = win.createImageBitmap;
	const Image = win.Image;
	const channel = new win.MessageChannel();
	channel.port1.onmessage = async (event) => {
		const { id, url } = event.data || {};
		let picture = null;
		try {
			const image = new Image();
			image.src = url;
			await image.decode();
			const width = image.naturalWidth || 64;
			const height = image.naturalHeight || 64;
			const scale = Math.min(1, 64 / Math.max(width, height));
			picture = await apply(bitmap, win, [image, {
				resizeWidth: Math.max(1, Math.round(width * scale)),
				resizeHeight: Math.max(1, Math.round(height * scale)),
				resizeQuality: 'high',
			}]);
		} catch {}
		channel.port1.postMessage({ id, picture }, picture ? [picture] : []);
	};
	win.top.postMessage({ ${JSON.stringify(ICON_MESSAGE)}: true }, '*', [channel.port2]);
}`;
addEventListener('message', (event) => {
	if (!event.data?.[ICON_MESSAGE] || !event.ports[0]) return;
	const tab = tabs.find((t) => t.element.contentWindow === event.source);
	if (!tab) return;
	tab.iconPort = event.ports[0];
	fillIcons(); // a bookmark that waited for a page to ask through
});

// "Sign in with token" for Discord, mirroring the well-known community
// bookmarklet: the user pastes their OWN Discord account token into the
// chrome button (#toolToken) and it is written straight into the proxied
// discord.com page's OWN localStorage, so Discord logs in on reload.
//
// SECURITY: the token never leaves this browser. It is handed to the proxied
// Discord document over a same-browser MessagePort only, written only into
// that document's localStorage, and nowhere else: never a network request,
// never logged, never stored anywhere else. The host side (the click
// handler below) posts it to the page's port; the page writes it and
// navigates. Everything is gated strictly to the real host discord.com /
// *.discord.com, read from the page's real URL (stomp.origin), so no other
// site ever gets the port or the button.
//
// This is a `post` hook (after the inject installed its storage hooks,
// before the page's first script): the token must go into the SAME store
// Discord's client reads, which under STomp is the inject's per-origin
// localStorage, and that store exists only once the hooks are installed.
// It still runs before Discord's own scripts, which delete window.localStorage
// early, so the captured store keeps working after that deletion.
const TOKEN_MESSAGE = '$stompDemo$token';
const TOKEN_HOOK = `
if (stomp.kind === 'document' && stomp.isTop) {
	const win = stomp.window;
	let host = '';
	try { host = new win.URL(stomp.origin).hostname; } catch {}
	if (host === 'discord.com' || host.endsWith('.discord.com')) {
		// the page's own localStorage, captured now before Discord deletes it:
		// the token is written here and nowhere else; it never leaves the browser
		const store = win.localStorage;
		const channel = new win.MessageChannel();
		channel.port1.onmessage = (event) => {
			const token = event.data && event.data.token;
			if (typeof token !== 'string') return;
			try {
				store.token = win.JSON.stringify(token);
				// go to the home route so Discord logs in with the token, as the
				// bookmarklet's reload does. This is raw host code: win.location
				// is the real, unrouted location, so a click on an <a> is used
				// instead, whose href the inject routes (as every proxied link),
				// keeping the navigation inside the proxy.
				const link = win.document.createElement('a');
				link.href = '/channels/@me';
				(win.document.body || win.document.documentElement).appendChild(link);
				link.click();
				link.remove();
			} catch {}
		};
		win.top.postMessage({ ${JSON.stringify(TOKEN_MESSAGE)}: true }, '*', [channel.port2]);
	}
}`;
addEventListener('message', (event) => {
	if (!event.data?.[TOKEN_MESSAGE] || !event.ports[0]) return;
	const tab = tabs.find((t) => t.element.contentWindow === event.source);
	if (!tab) return;
	tab.tokenPort = event.ports[0];
	syncTokenButton(); // the button can show now the page can take the token
});

const controllerCallbacks = {
	hooks: {
		init: {
			pre: { source: ICON_HOOK },
			post: { source: `${KEY_HOOK}\n${TOKEN_HOOK}` },
		},
	},
	// per-site shields (the content blocker's UI): the state this page kept,
	// and a callback to persist each change back to it
	shields: initialShields(),
	onShieldsChange: persistShields,
	// a site asks for a permission another site was given (the browser's own
	// prompt asked for the first)
	onPermissionRequest: askPermission,
	// the demo's own page for a document the proxy could not produce
	errorPage: '/error.html',
	// every proxied request, for the request viewer
	onRequest: recordRequest,
	// a page's window.open / target=_blank becomes a tab here, never a
	// bare proxied popup (the page sees null, like a popup blocker)
	onOpen: (url) => navigate(url, { newTab: true }),
	// the page reports its URL and title as they change
	onNavigate: (info, frame) => {
		const tab = tabs.find((t) => t.frame === frame);
		if (!tab) return;
		// while a navigation is on its way, the document it leaves still
		// reports: that is not where the tab is going
		tab.reported = info.url;
		tab.stayedOn = null;
		settleGoing(tab);
		if (!tab.goingTo) tab.url = info.url;
		tab.icon = info.icon;
		recordUrl(tab);
		if (tab === activeTab) syncOmnibox();
		syncCardBar(tab); // its card in the switcher, if there is one
		fillIcons(); // its page may have declared an icon a bookmark lacks
	},
};

async function startController(name) {
	badge(
		'Mode',
		ISOLATED
			? `isolated: proxy on ${PROXY_ORIGIN}, host on ${location.origin}`
			: `same origin (${location.origin}); not a security boundary`,
		ISOLATED ? 'green' : 'orange',
	);
	badge(
		'Transport',
		`${name} over ${wispURL()}${HTTP3 && name === 'epoxy' ? ', HTTP/3 on' : ''}`,
	);

	// no id is given: the controller keeps one per open tab from visit to
	// visit, so the browser keeps the compiled code of the scripts proxied
	// pages load (it does so only for the same URL, and routed URLs start
	// with the id)
	if (ISOLATED) {
		setStatus('Starting controller frame…');
		controller = new StompRemoteController({
			proxyOrigin: PROXY_ORIGIN,
			directory: DIRECTORY,
			transport: transports[name](),
			codec: 'xor',
			cache: CACHE,
			serviceWorkers: SERVICE_WORKERS,
			serviceWorkerTimeout: SERVICE_WORKER_TIMEOUT,
			serviceWorkerEventDelay: SERVICE_WORKER_EVENT_DELAY,
			...(REWRITER && { rewriter: REWRITER }),
			...(CFG.allowSelfProxy && { allowSelfProxy: true }),
			...ADBLOCK,
			...controllerCallbacks,
		});
	} else {
		setStatus('Registering service worker…');
		// registers serviceWorker.js from the directory with that scope and
		// resolves once the worker is activated (30 s at the most)
		const registration = await StompController.register(DIRECTORY);
		setStatus(`Loading ${name} transport…`);
		controller = new StompController({
			serviceworker: registration,
			transport: transports[name](),
			directory: DIRECTORY,
			codec: 'xor',
			cache: CACHE,
			serviceWorkers: SERVICE_WORKERS,
			serviceWorkerTimeout: SERVICE_WORKER_TIMEOUT,
			serviceWorkerEventDelay: SERVICE_WORKER_EVENT_DELAY,
			...(REWRITER && { rewriter: REWRITER }),
			...(CFG.allowSelfProxy && { allowSelfProxy: true }),
			...ADBLOCK,
			...controllerCallbacks,
		});
	}
	window.controller = controller; // handy from devtools

	setStatus('Waiting for the service worker…');
	await controller.wait();
}

async function boot() {
	if (!('serviceWorker' in navigator))
		throw new Error('This browser does not support service workers.');

	const name = preferredTransport();
	rememberTransport(name);

	try {
		await startController(name);
	} catch (error) {
		// localhost's proxy origin, 127.0.0.1, is another site: a browser that
		// blocks third-party cookies (Brave and incognito windows by default)
		// gives its frame no service worker, and nothing would load. Isolation
		// the deployment asked for (STOMP_PROXY_ORIGIN) stays an error; the
		// local default runs same origin instead, as 127.0.0.1 and the live
		// demo do.
		if (
			!ISOLATED ||
			error.name !== 'StorageBlockedError' ||
			'proxyOrigin' in CFG
		)
			throw error;
		badge('Isolation', error.message, 'orange');
		controller.element.remove();
		ISOLATED = false;
		await startController(name);
	}
	// a deploy can leave an older service worker in charge for a moment: the
	// controller keeps working on it and rebinds when the new one activates
	controller.addEventListener('stale', () =>
		setStatus('Ready (service worker updating)'),
	);
	controller.addEventListener('rebind', () => setStatus('Ready'));
	setStatus(controller.stale ? 'Ready (service worker updating)' : 'Ready');
	badge('Controller', `ready, codec ${controller.config.codec}`, 'green');
}

async function switchTransport(name) {
	rememberTransport(name);
	setStatus(`Switching to ${name}…`);
	try {
		await controller.setTransport(transports[name]());
		setStatus('Ready');
		badge('Transport', `${name} over ${wispURL()}`);
	} catch (error) {
		setStatus(`Transport failed: ${error.message}`, true);
	}
}

// ---- tabs -----------------------------------------------------------------

function createTab() {
	const element = document.createElement('iframe');
	element.className = 'frame hidden';
	element.title = 'Proxied page';
	element.allow = FRAME_ALLOW;
	framesContainer.append(element);
	const frame = controller.createFrame(element);
	// Each tab keeps a list of the pages it reached, for browsers without the
	// Navigation API. Where the frame can tell (frame.canGoBack) it is the
	// authority: the list over-counts when a site redirects or replaces its
	// URL, and a history.back() past the frame's first entry walks the shared
	// session history, which backs the whole demo page out of the site.
	const tab = {
		frame,
		element,
		url: '',
		history: [],
		index: -1,
		traversal: null, // 'back' / 'forward' while a step we issued is in flight
		pending: Promise.resolve(false), // queue of back/forward presses
		goingTo: null, // { url, from }: a navigation not yet committed (navigate)
		stayedOn: null, // the URL a stopped navigation left the tab on, until it reports
		reported: null, // the URL the tab's document last reported
		icon: null, // the icon the page declared (NavigateInfo.icon)
		iconPort: null, // its document's port for fetching that icon (ICON_HOOK)
		tokenPort: null, // a Discord page's port for its login token (TOKEN_HOOK)
	};
	element.addEventListener('load', async () => {
		// a RemoteFrame's url is polled: refresh before recording, or a redirect
		// leaves both the requested and the final URL in the list
		if (frame.refresh) await frame.refresh();
		// a document loaded: the navigation committed, whatever its URL
		tab.goingTo = null;
		tab.stayedOn = null;
		recordUrl(tab);
		if (tab === activeTab) {
			setStatus(frame.url ? 'Ready' : 'Loaded');
			syncOmnibox();
		}
		syncCardBar(tab);
	});
	tabs.push(tab);
	return tab;
}

/** note a URL the frame reached, unless it was our own back/forward */
const normalizeUrl = (url) => {
	try {
		return new URL(url).href;
	} catch {
		return url;
	}
};

function recordUrl(tab) {
	// the requested URL and the one the frame reports can differ only by
	// normalisation ("https://a.com" vs "https://a.com/"); that is not a new entry
	const url = normalizeUrl(tab.frame.url);
	if (!url) return;
	if (tab.traversal) {
		// the frame still reports the page it is leaving until the step commits
		const from = tab.history[tab.index + (tab.traversal === 'back' ? 1 : -1)];
		if (url === from) return;
		tab.traversal = null;
		// landed somewhere else (the entry redirected or replaced its URL): that
		// is what this entry really is, not a new one
		tab.history[tab.index] = url;
		return;
	}
	if (url === tab.history[tab.index]) return;
	tab.history.length = tab.index + 1;
	tab.history.push(url);
	tab.index = tab.history.length - 1;
}

/**
 * Step the tab's own history. Presses queue up per tab so each one is a
 * single step even while the previous page is still loading. Resolves false
 * when there was nothing to go to; the frame itself never walks the host page.
 */
function step(tab, direction) {
	if (!tab) return Promise.resolve(false);
	const run = async () => {
		const back = direction === 'back';
		stopGoing(tab); // a step ends a navigation on its way, as a browser's
		// no Navigation API: our list is all there is, and history.back() from
		// the first entry would leave the site
		if (back ? tab.frame.canGoBack === null : tab.frame.canGoForward === null) {
			const can = back ? tab.index > 0 : tab.index < tab.history.length - 1;
			if (!can) return false;
		}
		tab.traversal = direction;
		const went = await (back ? tab.frame.back() : tab.frame.forward());
		if (!went) {
			tab.traversal = null;
			return false;
		}
		const next = tab.index + (back ? -1 : 1);
		tab.index = Math.min(Math.max(next, 0), tab.history.length - 1);
		return true;
	};
	tab.pending = tab.pending.then(run, run);
	return tab.pending;
}

const goBack = (tab) => step(tab, 'back');
const goForward = (tab) => step(tab, 'forward');

function activateTab(tab) {
	activeTab = tab;
	for (const other of tabs)
		other.element.classList.toggle('hidden', other !== tab);
	landing.classList.add('hidden');
	browser.classList.remove('hidden');
	document.body.classList.add('browsing');
	// the live bar first: an expanding card's bar copy is a copy of it
	syncOmnibox(true);
	syncToolbar();
	hideRecents(tab); // animates the card back to full screen if the manager is open
}

// "Forget me when I close this site" (shields): when the last tab on a host
// with that toggle on closes, clear its cookie jar and its virtualized storage
// (localStorage, sessionStorage, IndexedDB, Cache Storage). The controller
// carries the toggle; this is the host-side half.
function forgetSiteOnClose(tab) {
	if (!controller || !controller.shields) return;
	let origin, host;
	try {
		const url = new URL(pageUrl(tab) || '');
		origin = url.origin;
		host = url.hostname;
	} catch {
		return;
	}
	if (!host || !controller.shields.get(host).forget) return;
	// another open tab still on this host: keep its data
	if (tabs.some((other) => other !== tab && activeHostOf(other) === host))
		return;
	controller.cookies.clear(origin).catch(() => {});
	controller.forgetStorage?.(origin).catch(() => {});
}

function activeHostOf(tab) {
	try {
		return new URL(pageUrl(tab) || '').hostname || null;
	} catch {
		return null;
	}
}

function closeTab(tab, { stayInRecents = false } = {}) {
	const index = tabs.indexOf(tab);
	if (index === -1) return;
	forgetSiteOnClose(tab);
	tabs.splice(index, 1);
	tab.element.remove();
	labelFor.get(tab)?.remove();
	labelFor.delete(tab);
	requestLogs.delete(tab.frame);
	const frames = controller.frames.indexOf(tab.frame);
	if (frames !== -1) controller.frames.splice(frames, 1);
	if (tab === activeTab) activeTab = tabs[Math.max(0, index - 1)] || null;
	if (stayInRecents) {
		recentsIndex = Math.min(recentsIndex, Math.max(0, tabs.length - 1));
		if (tabs.length) renderRecents();
		else showLanding(); // slides the dock buttons back into the tiles
		return;
	}
	if (activeTab) activateTab(activeTab);
	else showLanding();
}

function tabTitle(tab) {
	if (tab.frame.title) return tab.frame.title; // remote frames report it
	try {
		return tab.element.contentDocument?.title || tab.url || 'New tab';
	} catch {
		return tab.url || 'New tab';
	}
}

// ---- views -----------------------------------------------------------------

function showBrowser() {
	landing.classList.add('hidden');
	browser.classList.remove('hidden');
	document.body.classList.add('browsing');
	hideRecents();
}

// Home screen entrance, like a launcher coming back into view: its pieces
// fade in while scaling down from 1.08 to 1. Each piece animates on its own
// but around the same point (the viewport centre), which reads as one zoom of
// the whole screen. The tiles row is left out while it is FLIPping in from
// the switcher's dock, so the two animations never fight.
function zoomLanding(includeTiles) {
	const pieces = [
		...landing.querySelectorAll(
			'.head, .inputWrapper > :not(#button-container), .lbottom, .rbottom',
		),
	];
	if (includeTiles) pieces.push($('button-container'));
	landing.classList.remove('entering');
	for (const el of pieces) {
		el.classList.remove('zoom');
		el.style.transformOrigin = '';
	}
	void landing.offsetHeight; // restart cleanly if it was still playing
	landing.classList.add('entering');
	const cx = innerWidth / 2;
	const cy = (innerHeight - 48) / 2;
	for (const el of pieces) {
		const r = el.getBoundingClientRect();
		el.style.transformOrigin = `${cx - r.left}px ${cy - r.top}px`;
		el.classList.add('zoom');
	}
	const finish = () => {
		landing.classList.remove('entering');
		for (const el of pieces) {
			el.classList.remove('zoom');
			el.style.transformOrigin = '';
		}
	};
	setTimeout(finish, 260);
}

function showLanding() {
	const dockRects = document.body.classList.contains('recents')
		? rectsOf(dockButtons)
		: null;
	browser.classList.add('hidden');
	// the landing is visible on first paint, so "was hidden" alone means
	// "coming back into view": no animation on initial load
	const wasHidden = landing.classList.contains('hidden');
	landing.classList.remove('hidden');
	// coming back from the browser view, or out of the switcher (where the
	// landing was only visibility-hidden under the stage)
	if (wasHidden || dockRects) zoomLanding(!dockRects);
	document.body.classList.remove('browsing');
	hideRecents();
	if (dockRects) slideFrom(homeTiles, dockRects);
	hashWrites++;
	history.replaceState(null, '', location.pathname);
	mainForm.url.focus();
}

// The recents screen never moves the iframes (that would reload them). It
// adds body.recents, which turns .frames into a fixed stage, and positions
// every frame with a transform so the cards are live, scaled-down previews.
let recentsIndex = 0;
let recentsReturn = 'landing';

const recentsLabels = $('recentsLabels');
const recentsCount = $('recentsCount');

let recentsDrag = 0; // horizontal offset while swiping, in px
let recentsLift = { index: -1, dy: 0 }; // card being swiped up to close
let recentsCardWidth = 1; // card pitch from the last layout, for snapping

// A card is a scaled preview of the whole browser view: the address bar and
// the page as one block with the view's own aspect. The block is drawn by two
// elements that share one transform, because moving an iframe into a wrapper
// would reload it: the tab's label overlay is the block (its top is a copy of
// the chrome bar, the rest is transparent) and the frame sits inside the
// block at the bar's height, scaled along with it. Expanding a card is one
// transform of the block back to translate(0,0) scale(1): the bar copy lands
// exactly over the real bar and the frame on its resting box, so nothing
// moves or resizes when the stage goes away.
const chromeBar = browser.querySelector('.chrome');
const chromeHeight = () => chromeBar.offsetHeight || 49;
const restingTransform = () => `translate(0px, ${chromeHeight()}px) scale(1)`;

function layoutRecents(animated = false) {
	const vw = innerWidth;
	const vh = innerHeight - 48; // the browser view: chrome bar + frame
	const ch = chromeHeight();
	const fh = vh - ch; // the frame's resting height
	const availH = vh - 100 - 220; // top controls, Close all + dock
	// scale by the available height so cards stay tall; cap the width
	const k = Math.max(0.15, Math.min(availH / vh, 0.72));
	const w = vw * k;
	const h = vh * k;
	const gap = 24;
	const x0 = (vw - w) / 2;
	const y0 = 100;

	tabs.forEach((tab, i) => {
		const x = x0 + (i - recentsIndex) * (w + gap) + recentsDrag;
		const lift = i === recentsLift.index ? recentsLift.dy : 0;
		const y = y0 + lift;
		const transform = `translate(${x}px, ${y}px) scale(${k})`;
		// the radius is applied before the scale, so express it in page pixels
		const radius = `${18 / k}px`;
		const { element } = tab;
		element.style.width = `${vw}px`;
		element.style.height = `${fh}px`;
		// the frame is the lower part of the block: below the scaled bar
		element.style.transform = `translate(${x}px, ${y + ch * k}px) scale(${k})`;
		// square on top, where the bar copy meets it; rounded at the bottom
		element.style.clipPath = `inset(0 round 0 0 ${radius} ${radius})`;
		element.classList.toggle('shade', i !== recentsIndex);
		element.classList.toggle(
			'dragging',
			!animated && (recentsDrag !== 0 || lift !== 0),
		);
		// the card fades as it is pushed up: the frame and its bar copy
		// together, as one block (the bar going first left a half card)
		const fade = lift ? Math.max(0, 1 - Math.abs(lift) / h) : 1;
		element.style.opacity = lift ? String(fade) : '';

		// the label is the block itself (bar copy on top, transparent below)
		// with the block's transform, so it can never fall out of step with the
		// frame while animating
		const label = labelFor.get(tab);
		if (label) {
			label.style.width = `${vw}px`;
			label.style.height = `${vh}px`;
			label.style.transform = transform;
			label.style.borderRadius = radius;
			label.style.setProperty('--k', String(k));
			label.style.setProperty('--ch', `${ch}px`);
			label.style.opacity = String((i === recentsIndex ? 1 : 0.6) * fade);
			label.classList.toggle(
				'dragging',
				!animated && (recentsDrag !== 0 || lift !== 0),
			);
		}
	});
	recentsCardWidth = w + gap;

	recentsCount.textContent = `${tabs.length} active tab${tabs.length === 1 ? '' : 's'}`;
}

// one label element per tab, kept across renders so it can transition in
// step with its frame (rebuilding labels made them jump into place)
const labelFor = new Map();
const TOOL_IDS = ['toolBack', 'toolForward', 'toolReload', 'toolSaved'];

/** the card's bar copy shows what the live bar would for this tab */
function syncCardBar(tab) {
	const label = labelFor.get(tab);
	if (!label) return;
	// landing on the live bar: it must match that, whatever the tab does
	if (label.classList.contains('expanding')) return mirrorLiveBar(label);
	const tools = label.querySelectorAll('.toolbtn');
	tools[0].classList.toggle('disabled', !canStep(tab, 'back'));
	tools[1].classList.toggle('disabled', !canStep(tab, 'forward'));
	label.querySelector('.urlText').textContent = shownUrl(tab);
	syncStar(label.querySelector('.starbtn'), tab);
}

/** the expanding card's bar copy shows exactly what the live bar does */
function mirrorLiveBar(label) {
	const tools = label.querySelectorAll('.toolbtn');
	TOOL_IDS.forEach((id, i) =>
		tools[i].classList.toggle('disabled', $(id).disabled),
	);
	label.querySelector('.urlText').textContent = omni.url.value;
	const star = label.querySelector('.starbtn');
	const live = $('toolStar');
	star.disabled = live.disabled;
	star.setAttribute('aria-pressed', live.getAttribute('aria-pressed'));
}

function createLabel(tab) {
	const label = document.createElement('div');
	label.className = 'cardLabel';

	const hit = document.createElement('div');
	hit.className = 'hit';

	// a copy of the chrome bar, built from the same classes so it renders
	// exactly like the real one it will land on: Back, Forward and Reload
	// greyed out as they would be for this tab, the address box with the
	// tab's URL, the chip the same service worker status as the live bar.
	// A picture but for the star, which bookmarks the tab's page as the live
	// bar's does: a press anywhere else on it opens the tab.
	const chrome = document.createElement('div');
	chrome.className = 'cardChrome';
	for (const id of TOOL_IDS) {
		const tool = document.createElement('span');
		tool.className = 'toolbtn';
		tool.dataset.tool = id;
		tool.setAttribute('aria-hidden', 'true');
		tool.append($(id).querySelector('img').cloneNode());
		chrome.append(tool);
	}
	// the address box and, over its right end, the status chip and the star,
	// as the live bar's form holds them
	const box = document.createElement('div');
	box.className = 'urlBox';
	const url = document.createElement('div');
	url.className = 'form-text omnibox url';
	const urlText = document.createElement('span');
	urlText.className = 'urlText';
	urlText.setAttribute('aria-hidden', 'true');
	url.append(urlText);
	const end = document.createElement('div');
	end.className = 'omniEnd';
	const star = document.createElement('button');
	star.type = 'button';
	star.className = 'starbtn';
	star.setAttribute('aria-label', "Bookmark this tab's page");
	star.addEventListener('click', (event) => {
		event.stopPropagation(); // not a press on the card
		toggleBookmark(tab);
	});
	const status = document.createElement('span');
	status.className = 'select status';
	status.setAttribute('aria-hidden', 'true');
	status.textContent = chromeStatus.textContent;
	status.classList.toggle('error', chromeStatus.classList.contains('error'));
	// a non-interactive copy of the live shields button so the card's chip
	// sits where the live one does (the live omniEnd is status, shields, star);
	// it mirrors the live button's shown state, saturation and badge
	const liveShields = $('toolShields');
	const liveBadge = $('shieldsBadge');
	const shields = document.createElement('button');
	shields.type = 'button';
	shields.className = 'shieldsbtn';
	shields.tabIndex = -1;
	shields.setAttribute('aria-hidden', 'true');
	shields.hidden = liveShields.hidden;
	shields.classList.toggle('up', liveShields.classList.contains('up'));
	const shieldsImg = document.createElement('img');
	shieldsImg.src = '/pm/logo.png';
	shieldsImg.width = 24;
	shieldsImg.height = 24;
	shieldsImg.alt = '';
	shieldsImg.draggable = false;
	const shieldsBadgeCopy = document.createElement('span');
	shieldsBadgeCopy.className = 'shieldsBadge';
	shieldsBadgeCopy.hidden = liveBadge.hidden;
	shieldsBadgeCopy.textContent = liveBadge.textContent;
	shields.append(shieldsImg, shieldsBadgeCopy);
	end.append(status, shields, star);
	box.append(url, end);
	chrome.append(box);

	const close = document.createElement('button');
	close.className = 'close';
	close.title = 'Close tab';
	close.setAttribute('aria-label', 'Close tab');
	close.textContent = '×';
	close.addEventListener('click', (event) => {
		event.stopPropagation();
		closeTab(tab, { stayInRecents: true });
	});

	label.append(hit, chrome, close);
	label.addEventListener('click', () => {
		if (recentsSwiped) return;
		const i = tabs.indexOf(tab);
		if (i === -1) return;
		if (i === recentsIndex) activateTab(tab);
		else {
			recentsIndex = i;
			layoutRecents();
		}
	});
	return label;
}

function renderRecents(fromFullScreen = false) {
	for (const empty of recentsLabels.querySelectorAll('.recentsEmpty'))
		empty.remove();

	for (const tab of tabs) {
		// labels show where the frame actually is, redirects included (or
		// where it is going)
		if (!tab.goingTo) tab.url = tab.frame.url || tab.url;

		let label = labelFor.get(tab);
		if (!label) {
			label = createLabel(tab);
			labelFor.set(tab, label);
			recentsLabels.append(label);
		}
		syncCardBar(tab);
		label.querySelector('.hit').title = tabTitle(tab);
	}

	// nothing open: no cards, no Close all, just the message
	recentsPanel.classList.toggle('empty', !tabs.length);
	if (!tabs.length) {
		const empty = document.createElement('div');
		empty.className = 'recentsEmpty';
		empty.textContent = 'No recently used websites';
		recentsLabels.append(empty);
	}

	if (fromFullScreen) {
		// start every label where its frame currently is (the active frame is
		// full screen, the others invisible) so both animate into place together
		const vw = innerWidth;
		const vh = innerHeight - 48;
		const fh = vh - chromeHeight();
		const rest = restingTransform();
		for (const tab of tabs) {
			const label = labelFor.get(tab);
			label.style.width = `${vw}px`;
			label.style.height = `${vh}px`;
			label.style.transform = 'translate(0px, 0px) scale(1)';
			label.style.setProperty('--k', '1');
			label.style.setProperty('--ch', `${chromeHeight()}px`);
			label.style.opacity = tab === activeTab ? '1' : '0';
			tab.element.style.width = `${vw}px`;
			tab.element.style.height = `${fh}px`;
			tab.element.style.transform = rest;
			if (tab !== activeTab) {
				tab.element.style.opacity = '0';
				// the other tabs were never on screen: they appear in their slots
				// and only fade in, instead of sliding out of the full-screen box
				label.style.transition = 'opacity 0.25s ease';
				tab.element.style.transition = 'opacity 0.25s ease';
			}
		}
		void recentsLabels.offsetHeight; // flush, so the next layout transitions
	}

	layoutRecents();

	if (fromFullScreen) {
		// the slots are applied now, without a transform transition; later
		// moves animate again
		void recentsLabels.offsetHeight;
		for (const tab of tabs) {
			if (tab === activeTab) continue;
			labelFor.get(tab).style.transition = '';
			tab.element.style.transition = '';
		}
	}
}

function showRecents() {
	if (!document.body.classList.contains('recents'))
		recentsReturn = browser.classList.contains('hidden')
			? 'landing'
			: 'browser';
	recentsIndex = Math.max(
		0,
		activeTab ? tabs.indexOf(activeTab) : tabs.length - 1,
	);
	const fromBrowser = recentsReturn === 'browser' && !!activeTab;
	const fromHome = recentsReturn === 'landing';
	const tileRects = fromHome ? rectsOf(homeTiles) : null;
	document.body.classList.toggle('recents-from-home', fromHome);
	document.body.classList.add('recents');
	recentsPanel.classList.remove('hidden');
	renderRecents(fromBrowser);
	void recentsPanel.offsetHeight; // flush, so the fade-in transitions
	document.body.classList.add('recents-visible');
	if (tileRects) slideFrom(dockButtons, tileRects);
}

let recentsClosing = false;

function teardownRecents() {
	document.body.classList.remove(
		'recents',
		'recents-visible',
		'recents-from-home',
		'recents-closing',
	);
	recentsPanel.classList.add('hidden');
	recentsLift = { index: -1, dy: 0 };
	recentsDrag = 0;
	recentsClosing = false;
	for (const label of labelFor.values())
		label.classList.remove('expanding', 'gone');
	for (const tab of tabs) {
		tab.element.style.cssText = '';
		tab.element.classList.remove('shade', 'dragging', 'gone');
	}
	if (recentsReturn === 'landing' && browser.classList.contains('hidden'))
		mainForm.url.focus();
}

/**
 * Close the manager. With `expand`, that tab's frame and label first animate
 * back to full screen (the exact reverse of opening), then the stage goes away.
 */
function hideRecents(expand = null) {
	if (!document.body.classList.contains('recents') || recentsClosing) return;
	if (!expand || !tabs.includes(expand)) return teardownRecents();

	recentsClosing = true;
	// the backdrop fades under the card; the dock is no longer pinned above
	// the cards (it is while the manager was entered from home, having slid
	// out of the tiles)
	document.body.classList.remove('recents-visible', 'recents-from-home');
	// the controls go at once (they are drawn over every page, so fading
	// painted them over the opening card); the labels container stays solid:
	// the expanding card's bar copy is what the user sees until the real bar
	// takes over at teardown
	document.body.classList.add('recents-closing');
	const label = labelFor.get(expand);
	// a frame created while the stage is up (new tab from the dock) has no box
	// yet: give it the resting one so it lands where the stage will leave it
	const rest = restingTransform();
	expand.element.classList.remove('shade', 'dragging');
	expand.element.style.opacity = '1';
	expand.element.style.width = `${innerWidth}px`;
	expand.element.style.height = `${innerHeight - 48 - chromeHeight()}px`;
	expand.element.style.transform = rest;
	expand.element.style.clipPath = 'inset(0 round 0px)';
	if (label) {
		label.classList.remove('dragging');
		// the bar copy lands on the real bar: show what the real bar will show,
		// and keep showing it while the page moves on underneath
		label.classList.add('expanding');
		mirrorLiveBar(label);
		label.style.transform = 'translate(0px, 0px) scale(1)';
		label.style.borderRadius = '0px';
		label.style.setProperty('--k', '1');
		label.style.opacity = '1';
	}
	// the other cards go at once, as in One UI. They cannot stay under the
	// opening card: every label (bar copy, close button) is drawn over every
	// frame, so a neighbour fading out painted its bar over the opening page,
	// and a later tab's frame faded over it too.
	for (const tab of tabs) {
		if (tab === expand) continue;
		tab.element.classList.add('gone');
		tab.element.style.opacity = '0';
	}
	for (const other of labelFor.values()) {
		if (other === label) continue;
		other.classList.add('gone');
		other.style.opacity = '0';
	}

	setTimeout(teardownRecents, 260);
}

/** leave the switcher the way it was entered: expand the active tab or go home */
function leaveRecents() {
	if (!document.body.classList.contains('recents')) return;
	if (recentsReturn === 'browser' && activeTab) activateTab(activeTab);
	else showLanding(); // measures the dock first, so the tiles slide out of it
}

function toggleRecents() {
	if (document.body.classList.contains('recents')) leaveRecents();
	else showRecents();
}

addEventListener('resize', () => {
	if (document.body.classList.contains('recents')) layoutRecents();
});

// Gestures on the stage: a horizontal swipe scrolls through the cards, a
// vertical swipe on a card pushes it off the top and closes it. The pointer
// is only captured once a drag is recognised, so plain clicks on cards and
// their close buttons still arrive as clicks.
let recentsSwiped = false;
{
	let startX = 0;
	let startY = 0;
	let pointer = null;
	// recent pointer samples, so the release velocity reflects the last
	// ~80ms of movement rather than the whole gesture
	let samples = [];
	const recordSample = (x, y, t) => {
		samples.push([x, y, t]);
		while (samples.length > 1 && t - samples[0][2] > 80) samples.shift();
	};
	const velocityOf = (axisIndex, t) => {
		const first = samples[0];
		const last = samples[samples.length - 1];
		if (!first || first === last) return 0;
		return (
			(last[axisIndex] - first[axisIndex]) / Math.max(1, last[2] - first[2])
		); // px per ms
	};
	let axis = null; // 'x' | 'y' once the gesture is recognised
	let liftTab = null;

	// momentum: a flick keeps travelling and decelerates onto a card. The
	// settle duration grows with the distance so fast flicks feel continuous.
	const settle = (velocity) => {
		const pitch = recentsCardWidth;
		const projected = velocity * 320; // px the flick would carry on for
		const travel = -(recentsDrag + projected) / pitch;
		const target = Math.min(
			tabs.length - 1,
			Math.max(0, Math.round(recentsIndex + travel)),
		);
		const cards = Math.abs(target - recentsIndex);
		const ms = Math.min(650, 220 + cards * 110);
		recentsIndex = target;
		recentsDrag = 0;
		document.documentElement.style.setProperty('--recents-settle', `${ms}ms`);
		layoutRecents(true);
		setTimeout(
			() => document.documentElement.style.removeProperty('--recents-settle'),
			ms,
		);
	};

	let flyingOut = false;
	const finishLift = (velocity) => {
		const tab = liftTab;
		const dy = recentsLift.dy;
		liftTab = null;
		// far enough up, or a quick upward flick: throw the card off the top,
		// then close it (closeTab goes home if it was the last one)
		if (tab && dy < 0 && (-dy > 120 || velocity < -0.5)) {
			flyingOut = true;
			recentsLift = { index: tabs.indexOf(tab), dy: -(innerHeight + 100) };
			layoutRecents(true);
			setTimeout(() => {
				flyingOut = false;
				recentsLift = { index: -1, dy: 0 };
				closeTab(tab, { stayInRecents: true });
			}, 220);
			return;
		}
		recentsLift = { index: -1, dy: 0 };
		layoutRecents(true);
	};

	recentsLabels.addEventListener('pointerdown', (event) => {
		if (event.button !== 0 || !tabs.length || flyingOut) return;
		if (event.target.closest('.close, .starbtn')) return; // a button, not a gesture
		pointer = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
		samples = [];
		recordSample(event.clientX, event.clientY, event.timeStamp);
		axis = null;
		recentsSwiped = false;
		const label = event.target.closest('.cardLabel');
		liftTab = label
			? [...labelFor.entries()].find(([, l]) => l === label)?.[0] || null
			: null;
	});
	recentsLabels.addEventListener('pointermove', (event) => {
		if (event.pointerId !== pointer) return;
		const dx = event.clientX - startX;
		const dy = event.clientY - startY;
		recordSample(event.clientX, event.clientY, event.timeStamp);
		if (!axis) {
			if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
			axis = Math.abs(dx) >= Math.abs(dy) || !liftTab ? 'x' : 'y';
			recentsSwiped = true;
			document.body.classList.add('swiping');
			recentsLabels.setPointerCapture(pointer);
		}
		if (axis === 'x') {
			// resist dragging past either end
			const atEdge =
				(recentsIndex === 0 && dx > 0) ||
				(recentsIndex === tabs.length - 1 && dx < 0);
			recentsDrag = atEdge ? dx / 3 : dx;
		} else {
			// only upward; pulling down just resists
			recentsLift = { index: tabs.indexOf(liftTab), dy: dy < 0 ? dy : dy / 4 };
		}
		layoutRecents();
	});
	const finish = (event) => {
		if (event.pointerId !== pointer) return;
		pointer = null;
		document.body.classList.remove('swiping');
		if (!recentsSwiped) {
			liftTab = null;
			return;
		}
		recordSample(event.clientX, event.clientY, event.timeStamp);
		if (axis === 'x') settle(velocityOf(0, event.timeStamp));
		else finishLift(velocityOf(1, event.timeStamp));
		axis = null;
		// let the click that follows pointerup see recentsSwiped, then reset
		setTimeout(() => (recentsSwiped = false), 0);
	};
	recentsLabels.addEventListener('pointerup', finish);
	recentsLabels.addEventListener('pointercancel', finish);

	let wheelLock = 0;
	recentsPanel.addEventListener(
		'wheel',
		(event) => {
			const delta =
				Math.abs(event.deltaX) > Math.abs(event.deltaY)
					? event.deltaX
					: event.deltaY;
			if (!delta) return;
			event.preventDefault();
			const now = event.timeStamp;
			if (now - wheelLock < 250) return; // one card per gesture burst
			wheelLock = now;
			const next = recentsIndex + Math.sign(delta);
			if (next < 0 || next >= tabs.length) return;
			recentsIndex = next;
			layoutRecents();
		},
		{ passive: false },
	);
}

// ---- navigation ----------------------------------------------------------

/** move focus from the host's controls into a tab's page */
function focusFrame(tab) {
	if (!tab || tab.element.classList.contains('hidden')) return;
	if (document.activeElement instanceof HTMLElement)
		document.activeElement.blur();
	tab.element.focus({ preventScroll: true });
}

// every link of the demo's own pages (Fork us on GitHub, the repository, the
// commits) opens in the proxy, never in the real browser: a click in the
// current tab, Ctrl, Cmd, Shift or the middle button in a new one
function proxyLink(event) {
	if (
		event.defaultPrevented ||
		(event.type === 'auxclick' && event.button !== 1)
	)
		return;
	const link = event.target.closest?.('a[href]');
	if (!link) return;
	let url;
	try {
		url = new URL(link.href, location.href);
	} catch {
		return;
	}
	if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return;
	event.preventDefault();
	navigate(url.href, {
		newTab:
			event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey,
	});
}
document.addEventListener('click', proxyLink);
document.addEventListener('auxclick', proxyLink);

async function navigate(input, { newTab = false } = {}) {
	const url = normalizeUrl(SEARCH.query(input.trim()));
	if (!controller) {
		// still booting (service worker, transport module): a press must switch
		// to the browser view at once, not get dropped. Show the view now and
		// open the tab once the controller is up; the frame loads in view.
		showBrowser();
		omni.url.value = url;
		setStatus('Loading…');
		await booted.catch(() => {});
		if (!controller) return; // boot failed; the status line says why
		if (browser.classList.contains('hidden')) return; // the user went home
	}
	if (newTab || !activeTab) activateTab(createTab());
	else showBrowser();
	const tab = activeTab;
	// the page the tab is on: what the bar shows once this navigation is
	// over without committing (a navigation still on its way never committed)
	const from = tab.goingTo ? tab.goingTo.from : normalizeUrl(shownUrl(tab));
	tab.url = url;
	// the address bar, the card and the star show where the tab is going
	// from now until the new document commits, as a browser's do; if it never
	// does (a download, a 204), the page it stayed on again
	const going = { url, from };
	tab.goingTo = going;
	tab.stayedOn = null;
	// a fresh navigation: the blocked count starts over for this tab's page
	blockedCounts.set(tab.frame, 0);
	omni.url.value = url;
	syncToolbar();
	syncCardBar(tab);
	// the page a browser navigates to from its address bar has focus (its
	// document.hasFocus() is true, its keyboard events arrive), not the
	// address bar: the frame takes it, and the document it loads keeps it
	focusFrame(tab);
	setStatus('Loading…');
	try {
		await tab.frame.go(url);
		writeHash(url);
		settleGoing(tab);
		// the frame answered without moving (the leaving document reported, or
		// nothing came): give the navigation the time a browser would, then
		// show the page the tab stayed on
		if (tab.goingTo === going)
			setTimeout(() => {
				if (tab.goingTo === going) stopGoing(tab);
			}, 30000);
	} catch (error) {
		if (tab.goingTo === going) stopGoing(tab);
		setStatus(`Error: ${error.message}`, true);
	}
}

/** the URL a tab's address bar shows: where it is going, else where it is */
const shownUrl = (tab) =>
	tab.goingTo?.url || tab.stayedOn || tab.frame.url || tab.url || '';

/** the frame has a document other than the one the navigation leaves: committed */
function settleGoing(tab, reported = tab.reported) {
	if (!tab.goingTo) return;
	const now = normalizeUrl(reported || '');
	if (now && now !== tab.goingTo.from) tab.goingTo = null;
}

/** a navigation that will not commit (stopped, replaced, failed) */
function stopGoing(tab) {
	if (!tab.goingTo) return;
	// the frame may already name the URL it was sent to (a remote frame
	// does): the page it stayed on is the one the bar showed before
	tab.stayedOn = tab.goingTo.from || null;
	tab.goingTo = null;
	if (tab === activeTab) syncOmnibox(true);
	syncCardBar(tab);
}

// keep the omnibox and hash in sync with the active tab (pushState included)
function syncOmnibox(force = false) {
	if (!activeTab || browser.classList.contains('hidden')) return;
	const url = shownUrl(activeTab);
	if (!url) return;
	if (!activeTab.goingTo) activeTab.url = url;
	recordUrl(activeTab);
	syncToolbar();
	if (!force && document.activeElement === omni.url) return;
	if (omni.url.value !== url) omni.url.value = url;
	writeHash(url);
}

// The fragment names the active tab's page by its route (`html/<sealed>`,
// what follows the controller's address), not by its URL: the host's own
// address, its history entries and a bookmark of it show no more of the
// page than the proxy's routes do.
let hashWrites = 0;
let hashed = { url: '', hash: '' };
async function writeHash(url) {
	const write = ++hashWrites;
	if (hashed.url !== url)
		try {
			const route = new URL(await controller.route(url));
			hashed = {
				url,
				hash: `#${route.pathname.split('/').slice(-2).join('/')}${route.hash}`,
			};
		} catch {
			return;
		}
	if (write !== hashWrites || browser.classList.contains('hidden')) return;
	if (location.hash !== hashed.hash)
		history.replaceState(null, '', hashed.hash);
}

/** the page the fragment names, '' for none */
async function readHash() {
	const text = location.hash.slice(1);
	if (/^html[^/]*\/[^/]+$/.test(text.split('#')[0]))
		return (
			(await controller
				.unroute(
					new URL(
						`${controller.config.directory}${text}`,
						ISOLATED ? PROXY_ORIGIN : location.origin,
					).href,
				)
				.catch(() => null)) ?? ''
		);
	// a fragment written before routes were (the URL itself), in an old
	// bookmark: it opens as it did
	try {
		return decodeURIComponent(text);
	} catch {
		return '';
	}
}
// the address bar's Back and Forward are greyed out with nowhere to go: the
// frame says where it can (Navigation API), else the tab's own list does
function canStep(tab, direction) {
	if (!tab) return false;
	const frame =
		direction === 'back' ? tab.frame.canGoBack : tab.frame.canGoForward;
	if (typeof frame === 'boolean') return frame;
	return direction === 'back'
		? tab.index > 0
		: tab.index < tab.history.length - 1;
}

function syncToolbar() {
	const tab = activeTab;
	$('toolBack').disabled = !canStep(tab, 'back');
	$('toolForward').disabled = !canStep(tab, 'forward');
	$('toolReload').disabled = !tab;
	syncStar($('toolStar'), tab);
	syncTokenButton();
	syncShields();
}

/** whether a URL's real host is Discord: discord.com or a subdomain of it */
function isDiscordHost(url) {
	try {
		const host = new URL(url).hostname;
		return host === 'discord.com' || host.endsWith('.discord.com');
	} catch {
		return false;
	}
}

// "Sign in with token" shows only on a Discord page, and only once that page
// has handed over its port (TOKEN_HOOK): off Discord, or before the port
// arrives, there is nothing the button could do, so it stays hidden. It
// refreshes with the toolbar (syncToolbar, so with the star), and again when
// a port arrives.
function syncTokenButton() {
	const button = $('toolToken');
	if (!button) return;
	const tab = activeTab;
	button.hidden = !tab || !tab.tokenPort || !isDiscordHost(pageUrl(tab));
}

// pages report navigation through onNavigate; this is only a safety net
setInterval(() => syncOmnibox(), 5000);

// TLD autocomplete under the address bars, as in Powermouse: every keystroke
// asks /suggestions for suffixes close to what was typed after the last dot,
// and clicking one swaps the typed suffix for it.
function attachSuggestions(input) {
	const container = input.parentElement;
	const box = document.createElement('div');
	box.className = 'suggestions';
	container.append(box);
	const TLD = /\.[^./?#\s]{1,16}(?:\.[^./?#\s]{1,16})?(?=$|\/)/i;
	let request = 0;

	const clear = () => {
		box.textContent = '';
	};

	const apply = (value, tld) => {
		const base = value.replace(/\.+$/, ''); // "google." -> "google"
		return TLD.test(base) && !value.endsWith('.')
			? base.replace(TLD, `.${tld}`)
			: `${base}.${tld}`;
	};

	input.addEventListener('keyup', async (event) => {
		if (
			['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'Tab'].includes(event.key)
		) {
			if (event.key === 'Escape') clear();
			return;
		}
		const value = input.value.trim();
		if (!value || /\s/.test(value) || value.includes('://')) return clear();
		const id = ++request;
		let list;
		try {
			list = await (
				await fetch('/suggestions', {
					method: 'POST',
					headers: { 'content-type': 'text/plain' },
					body: value,
				})
			).json();
		} catch {
			return;
		}
		if (id !== request || document.activeElement !== input) return;
		clear();
		for (const tld of list) {
			const suggestion = document.createElement('div');
			suggestion.className = 'auto-fill ns';
			suggestion.textContent = apply(value, tld);
			// mousedown, so it runs before the input loses focus
			suggestion.addEventListener('mousedown', (e) => {
				e.preventDefault();
				input.value = apply(value, tld);
				input.focus();
				clear();
			});
			box.append(suggestion);
		}
	});
	input.addEventListener('blur', () => setTimeout(clear, 100));
	input.form.addEventListener('submit', clear);
}

attachSuggestions(mainForm.url);
attachSuggestions(omni.url);

mainForm.addEventListener('submit', (event) => {
	event.preventDefault();
	// the landing page acts as the new-tab page
	navigate(mainForm.url.value, { newTab: true });
	mainForm.url.value = '';
});

omni.addEventListener('submit', (event) => {
	event.preventDefault();
	navigate(omni.url.value);
});

// bottom navigation bar: back, home, recents (tab manager)
$('back').addEventListener('click', async () => {
	if (!recentsPanel.classList.contains('hidden')) {
		leaveRecents();
		return;
	}
	// on the home screen Back does nothing: re-entering the tab from here made
	// repeated presses bounce between home and the last page
	if (browser.classList.contains('hidden')) return;
	const tab = activeTab;
	const went = await goBack(tab);
	// nothing to go back to: home, like Android (unless the user moved on)
	if (!went && tab === activeTab && !browser.classList.contains('hidden'))
		showLanding();
});
$('home').addEventListener('click', showLanding);
// address bar: Back, Forward and Reload act on the active tab only (Back at
// the start of its history stays put, unlike the navigation bar's)
const stepActive = async (direction) => {
	const tab = activeTab;
	if (!tab) return;
	if (direction === 'back') await goBack(tab);
	else await goForward(tab);
	if (tab === activeTab) syncToolbar();
};
$('toolBack').addEventListener('click', () => stepActive('back'));
$('toolForward').addEventListener('click', () => stepActive('forward'));
$('toolReload').addEventListener('click', () => {
	if (!activeTab) return;
	stopGoing(activeTab); // Reload stays on the page the tab shows
	setStatus('Loading…');
	// the page's blocked count starts over on a reload, as on a navigation
	blockedCounts.set(activeTab.frame, 0);
	activeTab.frame.reload();
});
$('recents').addEventListener('click', toggleRecents);
$('newTab').addEventListener('click', showLanding);
$('closeAll').addEventListener('click', () => {
	for (const tab of [...tabs]) closeTab(tab, { stayInRecents: true });
});
const dockButtons = [];
for (const [label, url, color] of QUICK_LINKS) {
	const button = document.createElement('button');
	button.className = `dockButton bnt-${color}`;
	button.textContent = label;
	button.addEventListener('click', () => navigate(url, { newTab: true }));
	$('dock').append(button);
	dockButtons.push(button);
}

// Shared-element move between the home tiles and the dock buttons (FLIP):
// start each element where its counterpart was and let it slide into place.
const rectsOf = (elements) => elements.map((el) => el.getBoundingClientRect());

function slideFrom(elements, fromRects) {
	// measure every destination first, then take the movers out of the flow
	// (absolute, at their destination) so animating one element's size never
	// shifts its siblings; glyphs are never scaled, only the box animates
	const targets = elements.map((el) => el.getBoundingClientRect());
	const moving = [];
	// the containers are bottom-anchored and sized by their children; freeze
	// their boxes so taking the children out of the flow doesn't move them
	const frozen = new Map();
	for (const el of elements) {
		const parent = el.offsetParent;
		if (parent && !frozen.has(parent)) {
			const r = parent.getBoundingClientRect();
			frozen.set(parent, [parent.style.height, parent.style.minHeight]);
			parent.style.height = `${r.height}px`;
			parent.style.minHeight = `${r.height}px`;
		}
	}
	let pending = 0;
	const release = () => {
		if (--pending > 0) return;
		for (const [parent, [h, mh]] of frozen) {
			parent.style.height = h;
			parent.style.minHeight = mh;
		}
	};
	elements.forEach((el, i) => {
		const from = fromRects[i];
		const to = targets[i];
		if (!from || !from.width || !to.width) return;
		const parent = el.offsetParent?.getBoundingClientRect() || {
			left: 0,
			top: 0,
		};
		moving.push([el, to]);
		pending++;
		el.style.transition = 'none';
		el.style.position = 'absolute';
		el.style.left = `${to.left - parent.left}px`;
		el.style.top = `${to.top - parent.top}px`;
		el.style.margin = '0';
		el.style.flex = 'none';
		el.style.boxSizing = 'border-box';
		el.style.width = `${from.width}px`;
		el.style.height = `${from.height}px`;
		el.style.lineHeight = `${from.height}px`;
		el.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
	});
	void document.body.offsetHeight; // flush the start state
	for (const [el, to] of moving) {
		el.style.transition =
			'transform 0.25s ease, width 0.25s ease, height 0.25s ease, line-height 0.25s ease';
		el.style.width = `${to.width}px`;
		el.style.height = `${to.height}px`;
		el.style.lineHeight = `${to.height}px`;
		el.style.transform = '';
		let finished = false;
		const done = (event) => {
			if (event && event.propertyName !== 'transform') return;
			if (finished) return;
			finished = true;
			el.removeEventListener('transitionend', done);
			release();
			for (const prop of [
				'transition',
				'position',
				'left',
				'top',
				'margin',
				'flex',
				'boxSizing',
				'width',
				'height',
				'lineHeight',
				'transform',
			])
				el.style[prop] = '';
		};
		el.addEventListener('transitionend', done);
		setTimeout(() => done(), 400); // safety net if the event never fires
	}
}

// keyboard: Alt+Left / Alt+Right like a desktop browser, Escape closes recents
addEventListener('keydown', (event) => {
	if (event.key === 'Escape') leaveRecents();
	if (document.body.classList.contains('recents') && !event.altKey) {
		if (event.key === 'ArrowLeft' && recentsIndex > 0) {
			recentsIndex--;
			layoutRecents();
		} else if (event.key === 'ArrowRight' && recentsIndex < tabs.length - 1) {
			recentsIndex++;
			layoutRecents();
		} else if (event.key === 'Enter' && tabs[recentsIndex]) {
			activateTab(tabs[recentsIndex]);
		}
		return;
	}
	if (!event.altKey || browser.classList.contains('hidden')) return;
	if (event.key === 'ArrowLeft') goBack(activeTab);
	else if (event.key === 'ArrowRight') goForward(activeTab);
});

transportSelect.addEventListener('change', () =>
	switchTransport(transportSelect.value),
);

// the blocker is an option of the controller: the choice is remembered and
// the page starts again with it (without a ?adblock that would overrule it)
adblockToggle.checked = ADBLOCK.adblock !== false;
adblockToggle.addEventListener('change', () => {
	try {
		localStorage.setItem(
			'stomp-demo:adblock',
			adblockToggle.checked ? '1' : '0',
		);
	} catch {}
	const url = new URL(location.href);
	url.searchParams.delete('adblock');
	url.searchParams.delete('noadblock');
	location.replace(url.href);
});

const homeTiles = [];
for (const [label, url, color] of QUICK_LINKS) {
	const button = document.createElement('div');
	button.className = `ns btn-fancy bnt-${color}`;
	button.textContent = label;
	button.addEventListener('click', () => navigate(url, { newTab: true }));
	$('button-container').append(button);
	homeTiles.push(button);
}

// server status line: uptime + version. The server is asked every 10 s;
// between answers the counter keeps ticking from the last one, so it moves
// every second like a clock instead of jumping on each poll.
let loggedVersion = false;
let uptimeAt = null; // [server uptime in s, Date.now() when it was fetched]
function renderUptime() {
	if (!uptimeAt) return;
	const uptime = uptimeAt[0] + (Date.now() - uptimeAt[1]) / 1000;
	const h = Math.floor(uptime / 3600);
	const m = Math.floor((uptime % 3600) / 60);
	const s = Math.floor(uptime % 60);
	$('uptime').textContent = `${h} hours, ${m} minutes, ${s} seconds`;
}
async function pollStatus() {
	try {
		const { uptime, version } = await (await fetch('/api/status')).json();
		uptimeAt = [uptime, Date.now()];
		renderUptime();
		$('version').textContent = `STomp ${version}`;
		if (!loggedVersion) {
			loggedVersion = true;
			badge('STomp', `${version}, up ${Math.floor(uptime / 3600)}h`);
		}
	} catch {
		uptimeAt = null;
		$('uptime').textContent = 'unavailable';
	}
}
pollStatus();
setInterval(pollStatus, 10000);
setInterval(renderUptime, 1000);

// the repository's latest commits (/api/commits, the server's copy of
// GitHub's answer), drawn as a git log: a rail with a dot per commit, the
// author's avatar, the message's first line, who and when, the short sha
const AGO_UNITS = [
	[31536000, 'year'],
	[2592000, 'month'],
	[604800, 'week'],
	[86400, 'day'],
	[3600, 'hour'],
	[60, 'minute'],
];
function ago(iso) {
	const seconds = (Date.now() - new Date(iso)) / 1000;
	for (const [unit, name] of AGO_UNITS) {
		const n = Math.floor(seconds / unit);
		if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
	}
	return 'just now';
}
function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}
async function showCommits() {
	const list = $('commitList');
	const note = $('commitsNote');
	try {
		const response = await fetch('/api/commits');
		const data = await response.json();
		if (!response.ok)
			throw new Error(data.error || `status ${response.status}`);
		const repoLink = $('commitsRepo');
		repoLink.textContent = data.repo;
		repoLink.href = data.url;
		for (const commit of data.commits) {
			const link = element('a', 'commit');
			link.href = commit.url; // opens in the proxy (proxyLink)
			if (commit.avatar) {
				const avatar = element('img', 'commitAvatar');
				avatar.src = `${commit.avatar}&s=48`;
				avatar.alt = '';
				avatar.width = 24;
				avatar.height = 24;
				link.append(avatar);
			} else link.append(element('span', 'commitAvatar'));
			const body = element('div', 'commitBody');
			const message = element('div', 'commitMsg', commit.message);
			message.title = commit.message;
			const meta = element('div', 'commitMeta');
			meta.append(`${commit.author}, `);
			if (commit.date) {
				const when = element('time', null, ago(commit.date));
				when.dateTime = commit.date;
				when.title = new Date(commit.date).toLocaleString();
				meta.append(when);
			}
			body.append(message, meta);
			link.append(body, element('code', 'commitSha', commit.sha));
			const item = element('li');
			item.append(link);
			list.append(item);
		}
		note.textContent = data.commits.length ? '' : 'No commits yet';
		fitCommits();
	} catch (error) {
		note.textContent = `GitHub did not answer (${error.message}). The repository is linked above.`;
	}
}
showCommits();
// as many commits as the room holds, whole rows only: the rest are hidden
// (and shown again when the window grows), so the list never scrolls
function fitCommits() {
	const list = $('commitList');
	const items = [...list.children];
	if (!items.length) return;
	for (const item of items) item.classList.remove('hidden', 'last');
	const room = list.clientHeight;
	if (!room) return; // the home page is not showing: fitted when it is
	let used = 0;
	let last = null;
	for (const item of items) {
		used += item.offsetHeight;
		if (used > room) item.classList.add('hidden');
		else last = item;
	}
	if (last) last.classList.add('last');
	list.closest('.commits').classList.toggle('none', !last);
}
// Re-fit on any change to the room. Observe the .commits box, not the list:
// it is anchored to the viewport (top/bottom), so it grows and shrinks with
// the window and comes back from nothing when the home page returns. The list
// itself cannot be observed for growth, because trimmed rows are display:none,
// so a fitted list keeps its short box when the window grows and never fires.
new ResizeObserver(fitCommits).observe($('commitList').closest('.commits'));

// ---- request viewer ---------------------------------------------------------
// The controller reports every proxied request (onRequest). Closed, the viewer
// costs one ring buffer push per request: rows are only built while the panel
// is up, and dropped when it goes down. It shows the active tab's requests,
// newest first, and slides up from above the navigation bar like the switcher.

const REQUEST_LOG_SIZE = 300;
const requestsPanel = $('requests');
const requestsList = $('requestsList');
const requestsTitle = $('requestsTitle');
const requestsCount = $('requestsCount');
const requestsEmpty = $('requestsEmpty');

/** @type {Map<Frame, { entries: object[], total: number, cached: number, failed: number }>} */
const requestLogs = new Map();
let requestsTab = null; // the tab whose rows are on screen
let pendingRequests = []; // reports that arrived while open, rendered next frame
let requestsFlush = 0;

const requestsOpen = () => requestsPanel.classList.contains('open');

function recordRequest(info) {
	// a document the proxy failed to produce (the error page) never reports a
	// client id, so its report carries no frame: it belongs to the tab that
	// asked for that URL. Anything else without a frame has nothing to go to.
	if (!info.frame && info.kind) {
		const tab = tabs.find((t) => t.url === info.url);
		if (tab) info = { ...info, frame: tab.frame };
	}
	if (!info.frame) return;
	let log = requestLogs.get(info.frame);
	if (!log) {
		log = { entries: [], total: 0, cached: 0, failed: 0 };
		requestLogs.set(info.frame, log);
	}
	log.entries.push(info);
	if (log.entries.length > REQUEST_LOG_SIZE) log.entries.shift();
	log.total++;
	if (info.cached) log.cached++;
	if (info.status === 0) log.failed++;
	// the content blocker stopped or redirected this request (the only reports
	// whose error names it): count it for this frame's shields badge
	if (info.error && info.error.includes('content blocker')) {
		blockedCounts.set(info.frame, (blockedCounts.get(info.frame) || 0) + 1);
		if (activeTab && activeTab.frame === info.frame) scheduleShieldsBadge();
	}
	if (!requestsOpen() || !activeTab || activeTab.frame !== info.frame) return;
	// bursts (a page fanning out its assets) become one DOM update per frame
	pendingRequests.push(info);
	if (!requestsFlush) requestsFlush = requestAnimationFrame(flushRequests);
}

function formatBytes(bytes) {
	if (bytes === null || bytes === undefined) return '';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function requestRow(info) {
	const row = document.createElement('div');
	row.className = info.status === 0 ? 'req failed' : 'req';
	const cell = (className, text) => {
		const span = document.createElement('span');
		span.className = className;
		span.textContent = text;
		row.append(span);
		return span;
	};
	cell('method', info.method);
	cell(`status s${Math.floor(info.status / 100)}`, String(info.status));
	const url = cell('url', '');
	url.title = info.url;
	let parsed = null;
	try {
		parsed = new URL(info.url);
	} catch {}
	if (parsed) {
		const host = document.createElement('b');
		host.className = 'host';
		host.textContent = parsed.host;
		// the path is two spans: the head gives way (text-overflow) and the
		// tail keeps its last characters, so the ellipsis lands in the middle
		const path = document.createElement('span');
		path.className = 'path';
		const rest = parsed.pathname + parsed.search;
		const cut = Math.max(0, rest.length - 18);
		const head = document.createElement('span');
		head.className = 'pathHead';
		head.textContent = rest.slice(0, cut);
		const tail = document.createElement('span');
		tail.className = 'pathTail';
		tail.textContent = rest.slice(cut);
		path.append(head, tail);
		url.append(host, path);
	} else url.textContent = info.url;
	if (info.error) {
		const error = document.createElement('span');
		error.className = 'error';
		error.textContent = info.kind ? `${info.kind}: ${info.error}` : info.error;
		url.append(error);
	}
	cell('dest', info.destination || 'fetch');
	cell('ms', `${Math.round(info.ms)} ms`);
	cell('size', formatBytes(info.bytes));
	cell('tag', info.cached ? 'cached' : info.revalidated ? '304' : '');
	return row;
}

function renderRequestCounts(log) {
	const total = log ? log.total : 0;
	requestsCount.textContent = `${total} request${total === 1 ? '' : 's'} ${
		log ? log.cached : 0
	} cached ${log ? log.failed : 0} failed`;
	requestsEmpty.classList.toggle('hidden', !!log && log.entries.length > 0);
}

function renderRequests() {
	const tab = activeTab;
	requestsTab = tab;
	pendingRequests = [];
	requestsTitle.textContent = tab ? tabTitle(tab) : 'No tab';
	requestsList.textContent = '';
	const log = tab ? requestLogs.get(tab.frame) : null;
	if (log) {
		const fragment = document.createDocumentFragment();
		for (let i = log.entries.length - 1; i >= 0; i--)
			fragment.append(requestRow(log.entries[i]));
		requestsList.append(fragment);
	}
	requestsList.scrollTop = 0;
	renderRequestCounts(log);
}

function flushRequests() {
	requestsFlush = 0;
	if (!requestsOpen()) return;
	// the active tab changed under the panel (a page opened a tab): start over
	if (requestsTab !== activeTab) return renderRequests();
	const infos = pendingRequests;
	pendingRequests = [];
	if (infos.length) {
		const fragment = document.createDocumentFragment();
		for (let i = infos.length - 1; i >= 0; i--)
			fragment.append(requestRow(infos[i]));
		const scrolled = requestsList.scrollTop > 0;
		const height = requestsList.scrollHeight;
		requestsList.prepend(fragment);
		// the reader has scrolled down: keep what they are looking at in place
		if (scrolled) requestsList.scrollTop += requestsList.scrollHeight - height;
		while (requestsList.childElementCount > REQUEST_LOG_SIZE)
			requestsList.lastElementChild.remove();
	}
	requestsTitle.textContent = requestsTab ? tabTitle(requestsTab) : 'No tab';
	renderRequestCounts(requestsTab ? requestLogs.get(requestsTab.frame) : null);
}

function showRequests() {
	renderRequests();
	requestsPanel.classList.add('open');
	requestsPanel.setAttribute('aria-hidden', 'false');
}

function hideRequests() {
	if (!requestsOpen()) return;
	requestsPanel.classList.remove('open');
	requestsPanel.setAttribute('aria-hidden', 'true');
	requestsTab = null;
	pendingRequests = [];
	// the rows go once the panel has slid away; nothing is kept up to date
	// while it is closed
	setTimeout(() => {
		if (!requestsOpen()) requestsList.textContent = '';
	}, 300);
}

const toggleRequests = () => (requestsOpen() ? hideRequests() : showRequests());

$('requestsClear').addEventListener('click', () => {
	if (requestsTab) requestLogs.delete(requestsTab.frame);
	pendingRequests = [];
	requestsList.textContent = '';
	renderRequestCounts(null);
});

// nothing in the panel is selectable but the URLs; a click on one copies it
requestsList.addEventListener('click', (event) => {
	const url = event.target.closest('.url');
	if (!url || getSelection().toString()) return; // a drag-select, not a click
	const flash = () => {
		url.classList.add('copied');
		setTimeout(() => url.classList.remove('copied'), 900);
	};
	if (navigator.clipboard) {
		navigator.clipboard.writeText(url.title).then(flash, () => {});
		return;
	}
	// http://192.168.x.x: no clipboard API outside a secure context
	const range = document.createRange();
	range.selectNodeContents(url);
	getSelection().removeAllRanges();
	getSelection().addRange(range);
	if (document.execCommand('copy')) flash();
	getSelection().removeAllRanges();
});

// A long press on Recents (500 ms) toggles the viewer. Clicks are handled in
// the capture phase at the document, ahead of the buttons' own handlers: the
// release after a long press is not a Recents click, Back closes the panel
// instead of stepping, and Home or a short Recents press take it down on
// their way to what they do.
{
	const recentsButton = $('recents');
	let timer = 0;
	let longPressed = false;
	recentsButton.addEventListener('pointerdown', (event) => {
		if (event.button !== 0) return;
		longPressed = false;
		clearTimeout(timer);
		timer = setTimeout(() => {
			longPressed = true;
			toggleRequests();
		}, 500);
	});
	const cancel = () => clearTimeout(timer);
	for (const type of ['pointerup', 'pointerleave', 'pointercancel'])
		recentsButton.addEventListener(type, cancel);
	// a touch long press would open the context menu
	recentsButton.addEventListener('contextmenu', (event) =>
		event.preventDefault(),
	);
	document.addEventListener(
		'click',
		(event) => {
			const button = event.target.closest('.navbar .navbtn');
			if (!button) return;
			if (button === recentsButton && longPressed) {
				longPressed = false;
				event.stopImmediatePropagation();
				return;
			}
			if (!requestsOpen()) return;
			hideRequests();
			if (button.id === 'back') event.stopImmediatePropagation();
		},
		true,
	);
}

// Ctrl+Shift+X toggles the viewer (key events inside a proxied frame never
// reach this window; Ctrl+Shift+R was the browser's hard reload); Escape
// closes it before anything else sees the key
addEventListener(
	'keydown',
	(event) => {
		if (
			event.ctrlKey &&
			event.shiftKey &&
			!event.altKey &&
			event.code === 'KeyX'
		) {
			event.preventDefault();
			toggleRequests();
		} else if (event.key === 'Escape' && requestsOpen()) {
			hideRequests();
			event.stopImmediatePropagation();
		}
	},
	true,
);

// ---- bookmarks --------------------------------------------------------------
// Kept in localStorage beside the demo's other choices, one list for every
// window of the demo (the storage event brings another window's changes):
// the real URL (what the address bar shows, never a route), the title and
// the icon as a small PNG data URL, newest first, one per URL. The stars in
// the address bar and on the cards and the sidebar all draw from it.

const BOOKMARKS_KEY = 'stomp-demo:bookmarks';
// The defaults' icons and tile colours are curated, as Fracital's quick
// links are: Fracital's, Estro's and Krunker's are copies of Fracital's
// public/icon.svg, estro.svg and krunker.png (Apache-2.0, the same owner),
// vibeOS (which declares none) has the Tango computer from vibeOS's own
// icon set, and globe.png, the Tango web browser from the same set, stands
// in for a page whose icon could not be had
const DEFAULT_BOOKMARKS = [
	{
		title: 'Fracital',
		url: 'https://fracit.al/',
		icon: '/pm/icons/fracital.svg',
		color: '#fb74fe',
	},
	{
		title: 'vibeOS',
		url: 'https://vibeos.fracit.al/',
		icon: '/pm/icons/vibeos.png',
		color: '#3465a4',
	},
	{
		title: 'Estro',
		url: 'https://estro.help/',
		icon: '/pm/icons/estro.svg',
		color: '#9a5ae7',
	},
	{
		title: 'Krunk',
		url: 'https://krunk.io/',
		icon: '/pm/icons/krunker.png',
		color: '#ffd95c',
	},
];
const GLOBE_ICON = '/pm/icons/globe.png';
// a site whose own icon reads poorly on a tile has a curated one, by host,
// whatever icon its bookmark kept: YouTube's white logo on its red, as
// Fracital's link cards draw it
const SITE_ICONS = new Map([
	['youtube.com', { icon: '/pm/icons/youtube.svg', color: '#ff0000' }],
]);
// icons drawn as a whole tile (their own rounded square, art to the edges)
// fill the tile instead of sitting in its middle
const FULL_TILE_ICONS = new Set([
	'/pm/icons/estro.svg',
	'/pm/icons/krunker.png',
]);
const bookmarksPanel = $('bookmarks');
const bookmarksList = $('bookmarksList');
const bookmarksTab = $('bookmarksTab');

function loadBookmarks() {
	let list = [];
	try {
		list = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]');
	} catch {}
	if (!Array.isArray(list)) return [];
	const seen = new Set();
	const kept = [];
	for (const entry of list) {
		if (typeof entry?.url !== 'string' || seen.has(entry.url)) continue;
		seen.add(entry.url);
		// a default seeded before it had its curated icon gets it now
		const curated = DEFAULT_BOOKMARKS.find((other) => other.url === entry.url);
		const icon =
			typeof entry.icon === 'string' &&
			(entry.icon.startsWith('data:image/') ||
				/^\/pm\/icons\/[\w.-]+$/.test(entry.icon))
				? entry.icon
				: curated?.icon || null;
		const color =
			typeof entry.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(entry.color)
				? entry.color
				: curated?.color || null;
		kept.push({
			url: entry.url,
			title: typeof entry.title === 'string' ? entry.title : '',
			icon,
			...(color && { color }),
		});
	}
	return kept;
}

let bookmarks = loadBookmarks();

function saveBookmarks() {
	try {
		localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
	} catch {}
	renderBookmarks();
}

addEventListener('storage', (event) => {
	if (event.key !== BOOKMARKS_KEY && event.key !== null) return;
	bookmarks = loadBookmarks();
	renderBookmarks();
	fillIcons();
});

/** the URL the address bar shows for a tab, when it is a page to bookmark */
function pageUrl(tab) {
	const url = tab ? normalizeUrl(shownUrl(tab)) : '';
	return /^https?:\/\//i.test(url) ? url : null;
}

/** a routed URL (one the frame's location could show) as the real one */
async function realUrl(url) {
	const scopes = [location.origin, PROXY_ORIGIN]
		.filter(Boolean)
		.map((origin) => `${origin}${DIRECTORY}`);
	if (!scopes.some((scope) => url.startsWith(scope))) return url;
	return (await controller.unroute(url).catch(() => null)) || null;
}

const bookmarkOf = (url) =>
	url ? bookmarks.find((entry) => entry.url === url) || null : null;

function syncStar(button, tab) {
	if (!button) return;
	const url = pageUrl(tab);
	const on = !!bookmarkOf(url);
	button.disabled = !url;
	button.setAttribute('aria-pressed', String(on));
	button.title = on ? 'Remove this bookmark' : 'Bookmark this page';
}

function syncStars() {
	syncStar($('toolStar'), activeTab);
	for (const [tab, label] of labelFor) {
		// the opening card shows the live bar's state, which is this tab's
		if (!label.classList.contains('expanding'))
			syncStar(label.querySelector('.starbtn'), tab);
		else mirrorLiveBar(label);
	}
}

async function toggleBookmark(tab) {
	const shown = pageUrl(tab);
	const url = shown && (await realUrl(shown));
	if (!url) return;
	const at = bookmarks.findIndex((entry) => entry.url === url);
	if (at !== -1) {
		bookmarks.splice(at, 1);
		saveBookmarks();
		return;
	}
	// still on its way: the title is the page it leaves, so none yet
	const title = tab.goingTo ? shown : tabTitle(tab);
	bookmarks.unshift({ url, title: title === shown ? '' : title, icon: null });
	saveBookmarks();
	fillIcons();
}

// Every bookmark without an icon gets one as soon as some tab's page can ask:
// the icon its page declared where a tab shows it (whatever its query or
// fragment became since: a soft navigation), else the site's /favicon.ico,
// as a browser tries.
// It runs when a bookmark is made, when a page hands over its port or
// reports (a soft navigation too), when another window changes the list,
// and on load, so a bookmark kept without an icon fills itself in. A
// candidate the page answered without a picture is not asked again this
// visit; one that went unanswered (the page went away) is.
const iconMisses = new Map(); // bookmark URL -> icon URLs with no picture
let iconsRunning = false;
let iconsAgain = false;

const originOf = (url) => {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
};
/** the page a URL names, without its query and fragment */
const pageOf = (url) => {
	try {
		const parsed = new URL(url);
		return parsed.origin + parsed.pathname;
	} catch {
		return null;
	}
};

async function fillIcons() {
	if (iconsRunning) {
		iconsAgain = true;
		return;
	}
	iconsRunning = true;
	try {
		do {
			iconsAgain = false;
			for (const entry of bookmarks.filter((other) => !other.icon)) {
				const origin = originOf(entry.url);
				if (!origin) continue;
				const misses = iconMisses.get(entry.url) || new Set();
				iconMisses.set(entry.url, misses);
				const sameSite = tabs.filter(
					(tab) => originOf(pageUrl(tab)) === origin,
				);
				const showing = sameSite.filter(
					(tab) => pageOf(pageUrl(tab)) === pageOf(entry.url),
				);
				const candidates = [
					...new Set([
						...showing.map((tab) => tab.icon).filter(Boolean),
						`${origin}/favicon.ico`,
					]),
				].filter((url) => !misses.has(url));
				for (const url of candidates) {
					// ask through the bookmarked page itself, else its site's,
					// where one is open
					const via =
						showing.find((tab) => tab.iconPort) ||
						sameSite.find((tab) => tab.iconPort) ||
						(activeTab?.iconPort ? activeTab : null) ||
						tabs.find((tab) => tab.iconPort);
					if (!via) return; // a port arriving runs this again
					const icon = await fetchIcon(via, url);
					if (icon === undefined) break; // unanswered: next time
					if (!icon) {
						misses.add(url);
						continue;
					}
					// the list may have changed meanwhile, here or in another window
					bookmarks = loadBookmarks();
					const kept = bookmarkOf(entry.url);
					if (kept && !kept.icon) {
						kept.icon = icon;
						saveBookmarks();
					}
					break;
				}
			}
		} while (iconsAgain);
	} finally {
		iconsRunning = false;
	}
}

let iconRequest = 0;
/**
 * The icon at `url` through the tab's page, as a 64 px PNG data URL; null
 * when the page answered without a picture, undefined when it did not answer
 */
async function fetchIcon(tab, url) {
	const port = tab.iconPort;
	const id = ++iconRequest;
	const reply = await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), 8000);
		port.addEventListener('message', function answer(event) {
			if (event.data?.id !== id) return;
			port.removeEventListener('message', answer);
			clearTimeout(timer);
			resolve(event.data);
		});
		port.start();
		port.postMessage({ id, url });
	});
	if (!reply) return undefined;
	const picture = reply.picture;
	if (!(picture instanceof ImageBitmap)) return null;
	try {
		const size = 64;
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = size;
		const scale = Math.min(size / picture.width, size / picture.height);
		const width = picture.width * scale;
		const height = picture.height * scale;
		const context = canvas.getContext('2d');
		context.drawImage(
			picture,
			(size - width) / 2,
			(size - height) / 2,
			width,
			height,
		);
		// nothing drawn (an SVG sprite sheet): no icon, the globe stands in
		const { data } = context.getImageData(0, 0, size, size);
		if (!data.some((value, i) => i % 4 === 3 && value)) return null;
		return canvas.toDataURL('image/png');
	} catch {
		return null;
	} finally {
		picture.close();
	}
}

const bookmarksOpen = () => bookmarksPanel.classList.contains('open');

function bookmarkRow(entry) {
	const row = element('li', 'bookmark');
	const open = element('button', 'bookmarkOpen');
	open.type = 'button';
	open.title = entry.url;
	let host = '';
	try {
		host = new URL(entry.url).hostname.replace(/^www\./, '');
	} catch {}
	// the icon on a rounded tile, in the site's colour where it has one (as
	// Fracital's link cards), else white, which most icons are drawn for
	const site = SITE_ICONS.get(host.replace(/^m\./, ''));
	const src = site?.icon || entry.icon;
	const color = site?.color || entry.color;
	const tile = element('span', 'bookmarkTile');
	if (color) tile.style.setProperty('--tile', color);
	const icon = element('img', 'bookmarkIcon');
	icon.alt = '';
	icon.width = 22;
	icon.height = 22;
	icon.src = src || GLOBE_ICON;
	if (!src) icon.classList.add('globe');
	if (FULL_TILE_ICONS.has(src)) icon.classList.add('full');
	tile.append(icon);
	open.append(tile);
	const text = element('span', 'bookmarkText');
	text.append(
		element('span', 'bookmarkTitle', entry.title || host || entry.url),
		element('span', 'bookmarkUrl', entry.url),
	);
	open.append(text);
	// a click opens it in the current tab; Ctrl, Cmd or the middle button in
	// a new one, as a browser's links do
	const go = (newTab) => {
		closeBookmarks(false);
		navigate(entry.url, { newTab });
	};
	open.addEventListener('click', (event) => {
		if (dragEnded) return; // the release of a drag, not a click
		go(event.ctrlKey || event.metaKey || event.shiftKey);
	});
	open.addEventListener('mousedown', (event) => {
		if (event.button === 1) event.preventDefault(); // no autoscroll
	});
	open.addEventListener('auxclick', (event) => {
		if (event.button === 1) go(true);
	});
	const remove = element('button', 'bookmarkRemove', '×');
	remove.type = 'button';
	remove.title = 'Remove';
	remove.setAttribute(
		'aria-label',
		`Remove bookmark ${entry.title || host || entry.url}`,
	);
	remove.addEventListener('click', () => {
		const rows = [...bookmarksList.children];
		const next = rows[rows.indexOf(row) + 1] || rows[rows.indexOf(row) - 1];
		bookmarks = bookmarks.filter((other) => other.url !== entry.url);
		saveBookmarks();
		// keep the keyboard in the list: on the next row, else the close button
		const url = next?.querySelector('.bookmarkOpen')?.title;
		const target = [...bookmarksList.querySelectorAll('.bookmarkOpen')].find(
			(button) => button.title === url,
		);
		(target || $('bookmarksClose')).focus();
	});
	row.append(open, remove);
	row.dataset.url = entry.url;
	return row;
}

/** move a bookmark to another place in the list and keep the order */
function moveBookmark(url, to) {
	const from = bookmarks.findIndex((entry) => entry.url === url);
	if (from === -1 || to === from || to < 0 || to >= bookmarks.length) return;
	const [entry] = bookmarks.splice(from, 1);
	bookmarks.splice(to, 0, entry);
	saveBookmarks();
}

// Dragging a row reorders the list: the row lifts and follows the pointer,
// the others slide aside, the order is kept on release. A mouse or pen drag
// starts after a few pixels of movement (a click still opens the bookmark);
// a finger has to rest on the row first (a long press), else it scrolls the
// list as ever. Near the list's top or bottom edge the list scrolls along.
let dragEnded = false;
{
	const START = 5; // px a mouse moves before a press is a drag
	const HOLD = 350; // ms a finger rests before a press is a drag
	const EDGE = 40; // px from the list's edges where it scrolls along
	let press = null; // { pointer, row, x, y, touch, timer }
	let drag = null; // { row, rows, from, to, startY, startScroll, height, y }
	let scrolling = 0;

	const place = () => {
		const { row, rows, from, startY, startScroll, height } = drag;
		const dy = drag.y - startY + (bookmarksList.scrollTop - startScroll);
		row.style.transform = `translateY(${dy}px) scale(1.02)`;
		// the place whose middle the lifted row's middle has passed
		const middle = drag.tops[from] + dy + height / 2;
		let to = 0;
		for (let i = 0; i < rows.length; i++)
			if (middle > drag.tops[i] + drag.heights[i] / 2) to = i;
		drag.to = to;
		rows.forEach((other, i) => {
			if (other === row) return;
			const shift =
				i > from && i <= to ? -height : i < from && i >= to ? height : 0;
			other.style.transform = shift ? `translateY(${shift}px)` : '';
		});
	};
	const autoscroll = () => {
		scrolling = 0;
		if (!drag) return;
		const box = bookmarksList.getBoundingClientRect();
		const step =
			drag.y < box.top + EDGE
				? -Math.ceil((box.top + EDGE - drag.y) / 4)
				: drag.y > box.bottom - EDGE
					? Math.ceil((drag.y - box.bottom + EDGE) / 4)
					: 0;
		if (!step) return;
		const before = bookmarksList.scrollTop;
		bookmarksList.scrollTop += step;
		if (bookmarksList.scrollTop !== before) place();
		scrolling = requestAnimationFrame(autoscroll);
	};
	const begin = () => {
		const { row } = press;
		const rows = [...bookmarksList.children];
		drag = {
			row,
			rows,
			from: rows.indexOf(row),
			to: rows.indexOf(row),
			tops: rows.map((other) => other.offsetTop),
			heights: rows.map((other) => other.offsetHeight),
			height: row.offsetHeight,
			startY: press.y,
			startScroll: bookmarksList.scrollTop,
			y: press.y,
		};
		bookmarksList.classList.add('sorting');
		row.classList.add('dragging');
		bookmarksList.setPointerCapture(press.pointer);
	};
	const finish = (keep) => {
		clearTimeout(press?.timer);
		press = null;
		cancelAnimationFrame(scrolling);
		scrolling = 0;
		if (!drag) return;
		const { row, rows, to } = drag;
		const url = row.dataset.url;
		const moved = keep && to !== drag.from;
		drag = null;
		bookmarksList.classList.remove('sorting');
		row.classList.remove('dragging');
		for (const other of rows) other.style.transform = '';
		// the click that follows the release is not a press on the row
		dragEnded = true;
		setTimeout(() => (dragEnded = false), 0);
		if (moved) {
			moveBookmark(url, to);
			bookmarksList
				.querySelector(`.bookmark[data-url="${CSS.escape(url)}"] .bookmarkOpen`)
				?.focus();
		}
	};

	bookmarksList.addEventListener('pointerdown', (event) => {
		const row = event.target.closest('.bookmark');
		if (!row || event.button !== 0 || event.target.closest('.bookmarkRemove'))
			return;
		finish(false);
		const touch = event.pointerType === 'touch';
		press = {
			pointer: event.pointerId,
			row,
			x: event.clientX,
			y: event.clientY,
			touch,
		};
		if (touch)
			press.timer = setTimeout(() => {
				if (press && !drag) begin();
			}, HOLD);
	});
	bookmarksList.addEventListener('pointermove', (event) => {
		if (!press || event.pointerId !== press.pointer) return;
		if (!drag) {
			const far = Math.hypot(event.clientX - press.x, event.clientY - press.y);
			if (press.touch) {
				if (far > 10) finish(false); // a scroll, not a long press
				return;
			}
			if (far < START) return;
			begin();
		}
		drag.y = event.clientY;
		place();
		if (!scrolling) scrolling = requestAnimationFrame(autoscroll);
	});
	bookmarksList.addEventListener('pointerup', (event) => {
		if (press && event.pointerId === press.pointer) finish(true);
	});
	bookmarksList.addEventListener('pointercancel', () => finish(false));
	// a finger that has lifted a row moves it, not the list
	bookmarksList.addEventListener(
		'touchmove',
		(event) => {
			if (drag) event.preventDefault();
		},
		{ passive: false },
	);
	// a long press is a drag, not the browser's menu
	bookmarksList.addEventListener('contextmenu', (event) => {
		if (press?.touch || drag) event.preventDefault();
	});
	// Alt+Up and Alt+Down move the focused bookmark
	bookmarksList.addEventListener('keydown', (event) => {
		if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown'))
			return;
		const row = event.target.closest('.bookmark');
		if (!row) return;
		event.preventDefault();
		const at = bookmarks.findIndex((entry) => entry.url === row.dataset.url);
		moveBookmark(row.dataset.url, at + (event.key === 'ArrowUp' ? -1 : 1));
	});
	// a list redrawn under a drag (another window changed it) ends the drag
	new MutationObserver(() => {
		if (drag && !drag.row.isConnected) finish(false);
	}).observe(bookmarksList, { childList: true });
}

function renderBookmarks() {
	syncStars();
	$('bookmarksCount').textContent = String(bookmarks.length);
	$('bookmarksEmpty').classList.toggle('hidden', bookmarks.length > 0);
	// the rows are built while the sidebar is up only
	if (!bookmarksOpen()) return;
	const focused = bookmarksList.contains(document.activeElement)
		? document.activeElement
				.closest('.bookmark')
				?.querySelector('.bookmarkOpen')?.title
		: null;
	bookmarksList.replaceChildren(...bookmarks.map(bookmarkRow));
	if (focused)
		[...bookmarksList.querySelectorAll('.bookmarkOpen')]
			.find((button) => button.title === focused)
			?.focus();
}

// the button that opened the sidebar: the home page's tab or the bar's
// Saved pages, which gets the focus back
let bookmarksOpener = bookmarksTab;

function openBookmarks(opener = bookmarksTab) {
	if (bookmarksOpen()) return;
	bookmarksOpener = opener;
	bookmarksPanel.classList.add('open');
	bookmarksPanel.setAttribute('aria-hidden', 'false');
	$('bookmarksScrim').classList.add('open');
	opener.setAttribute('aria-expanded', 'true');
	// the keyboard stays in the sidebar
	landing.inert = true;
	browser.inert = true;
	renderBookmarks();
	(bookmarksList.querySelector('.bookmarkOpen') || $('bookmarksClose')).focus();
}

function closeBookmarks(restoreFocus = true) {
	if (!bookmarksOpen()) return;
	bookmarksPanel.classList.remove('open');
	bookmarksPanel.setAttribute('aria-hidden', 'true');
	$('bookmarksScrim').classList.remove('open');
	bookmarksOpener.setAttribute('aria-expanded', 'false');
	landing.inert = false;
	browser.inert = false;
	if (restoreFocus) bookmarksOpener.focus();
	// the rows go once the sidebar has slid away
	setTimeout(() => {
		if (!bookmarksOpen()) bookmarksList.textContent = '';
	}, 300);
}

bookmarksTab.addEventListener('click', () => openBookmarks(bookmarksTab));
$('toolSaved').addEventListener('click', () => openBookmarks($('toolSaved')));
$('bookmarksClose').addEventListener('click', () => closeBookmarks());
$('bookmarksScrim').addEventListener('click', () => closeBookmarks());
$('toolStar').addEventListener('click', () => toggleBookmark(activeTab));
// "Sign in with token": the user pastes their own Discord token; it is sent
// to the proxied page over its MessagePort and written into that page's own
// localStorage there. The token is never sent over the network or logged; it
// stays in this browser. A cancelled, empty, or whitespace-bearing entry
// sends nothing; a token pasted with its JSON quotes is unwrapped once.
$('toolToken').addEventListener('click', () => {
	const tab = activeTab;
	if (!tab || !tab.tokenPort) return;
	let token = prompt('Paste your Discord token');
	if (token === null) return; // cancelled
	token = token.trim();
	try {
		token = JSON.parse(token); // strip surrounding quotes if the user pasted them
	} catch {}
	if (typeof token !== 'string' || !token || /\s/.test(token)) {
		setStatus('That does not look like a token', true);
		return;
	}
	tab.tokenPort.start?.();
	tab.tokenPort.postMessage({ token });
});
// Escape closes the sidebar before anything else sees the key, and the
// navigation bar takes it down on the way to what it does (Back only closes)
addEventListener(
	'keydown',
	(event) => {
		if (event.key !== 'Escape' || !bookmarksOpen()) return;
		closeBookmarks();
		event.stopImmediatePropagation();
	},
	true,
);
document.addEventListener(
	'click',
	(event) => {
		const button = event.target.closest('.navbar .navbtn');
		if (!button || !bookmarksOpen()) return;
		closeBookmarks(false);
		if (button.id === 'back') event.stopImmediatePropagation();
	},
	true,
);
// The maker's sites and two friends' are bookmarked once, on the first visit
// (after the user's own, for a list from before they were): a marker beside
// the list remembers it, so one the user removes stays removed.
const SEEDED_KEY = 'stomp-demo:bookmarks-seeded';
{
	let seeded = false;
	try {
		seeded = localStorage.getItem(SEEDED_KEY) === '1';
	} catch {}
	if (!seeded) {
		for (const entry of DEFAULT_BOOKMARKS)
			if (!bookmarkOf(entry.url)) bookmarks.push({ ...entry });
		try {
			localStorage.setItem(SEEDED_KEY, '1');
		} catch {}
		saveBookmarks();
	}
}
renderBookmarks();

// ---------------------------------------------------------------------------
// Shields: the content blocker's per-site panel (docs/adblock.md). The omnibar
// button shows the powerMouse mark saturated when shields are up and grey when
// down, with the tab's blocked count on a badge. Clicking it opens a popover
// modelled on Brave Shields. Every control is real: the master toggle, the
// "block trackers & ads" mode and count, HTTPS upgrade, block scripts, block
// fingerprinting, the third-party-cookie policy, and "forget me on close" all
// take effect in the service worker and the inject. The protective ones are on
// by default (the DEFAULT_SHIELDS the controller carries, applied to every
// host through the '*' default below); block scripts and forget-on-close are
// destructive and stay off.
const shieldsButton = $('toolShields');
const shieldsBadge = $('shieldsBadge');
const shieldsPanel = $('shieldsPanel');
const shieldsScrim = $('shieldsScrim');

function activeHost() {
	const url = pageUrl(activeTab);
	try {
		return url ? new URL(url).hostname : null;
	} catch {
		return null;
	}
}

// the active tab's blocked count, for the badge and the open panel
function shieldsCountNow() {
	return activeTab ? blockedCounts.get(activeTab.frame) || 0 : 0;
}

function syncShields() {
	const host = activeHost();
	if (!host || !controller || !controller.shields) {
		shieldsButton.hidden = true;
		return;
	}
	shieldsButton.hidden = false;
	// no seeding on mere navigation: a host with no entry stays neutral in the
	// worker (the blocker still runs, STomp's default), so simply browsing never
	// turns on the per-site layers (HTTPS upgrade, cookie policy) that would
	// change requests out from under a page. The entry, with its "goodies on"
	// defaults, is written when the user opens Shields for the site (openShields)
	const state = controller.shields.get(host);
	shieldsButton.classList.toggle('up', !!state.enabled);
	const count = shieldsCountNow();
	// the global "Show the number of blocked items on the shields icon" setting
	// hides the count badge everywhere when off (Global Settings page)
	shieldsBadge.hidden = count === 0 || !state.enabled || !shieldsShowBadge();
	shieldsBadge.textContent = count > 999 ? '999+' : String(count);
	// keep an open panel's live numbers in step with the badge
	if (
		!shieldsPanel.classList.contains('hidden') &&
		shieldsPanel.dataset.host === host
	)
		refreshShieldsCount(count);
}

let shieldsRaf = 0;
function scheduleShieldsBadge() {
	if (shieldsRaf) return;
	shieldsRaf = requestAnimationFrame(() => {
		shieldsRaf = 0;
		syncShields();
	});
}

function refreshShieldsCount(count) {
	const big = shieldsPanel.querySelector('.shieldsCount b');
	if (big) big.textContent = String(count);
	const inline = shieldsPanel.querySelector('.adsCount');
	if (inline) inline.textContent = count ? String(count) : '';
}

// small line icons, in the panel's own colour (stroke: currentColor)
const SHIELD_ICONS = {
	gear: '<path fill="currentColor" fill-rule="evenodd" d="M8.75 3.63C8.907 2.69 9.72 2 10.675 2h2.65c.955 0 1.769.69 1.925 1.63l.219 1.31c.017.104.095.23.256.319q.127.07.25.145c.157.095.306.1.405.062L17.624 5a1.95 1.95 0 0 1 2.374.852l1.325 2.296a1.95 1.95 0 0 1-.45 2.482l-1.026.845c-.081.067-.151.198-.148.38a8 8 0 0 1 0 .29c-.003.182.067.313.148.38l1.027.845c.736.606.926 1.656.45 2.482l-1.326 2.296a1.95 1.95 0 0 1-2.375.852l-1.243-.466c-.099-.037-.248-.033-.405.062q-.123.075-.25.145c-.16.089-.24.215-.256.32l-.219 1.309A1.95 1.95 0 0 1 13.326 22h-2.652c-.953 0-1.767-.69-1.924-1.63l-.218-1.31c-.018-.104-.096-.23-.256-.319a8 8 0 0 1-.251-.145c-.157-.095-.306-.1-.405-.062L6.377 19a1.95 1.95 0 0 1-2.375-.852l-1.325-2.296a1.95 1.95 0 0 1 .45-2.482l1.026-.845.51.619-.51-.619c.081-.067.151-.198.148-.38a8 8 0 0 1 0-.29c.003-.182-.067-.313-.148-.38l-1.027-.845a1.95 1.95 0 0 1-.45-2.482l1.326-2.296A1.95 1.95 0 0 1 6.377 5l1.243.466c.1.037.248.033.405-.062q.124-.075.25-.145c.161-.089.24-.215.257-.32zm1.925-.027a.35.35 0 0 0-.344.29l-.218 1.31c-.11.66-.543 1.171-1.061 1.458a6 6 0 0 0-.199.115c-.507.306-1.167.426-1.795.191l-1.244-.466a.35.35 0 0 0-.424.152L4.065 8.95a.35.35 0 0 0 .08.444l1.027.845c.516.425.742 1.054.731 1.647a6 6 0 0 0 0 .23c.011.593-.215 1.222-.731 1.647l-1.027.845-.51-.618.51.618a.35.35 0 0 0-.08.444l1.325 2.296a.35.35 0 0 0 .424.152l1.244-.466c.628-.235 1.288-.115 1.795.191q.099.06.199.115c.518.287.95.797 1.06 1.458l.219 1.31a.35.35 0 0 0 .344.29h2.65a.35.35 0 0 0 .344-.29l.219-1.31c.11-.66.543-1.171 1.06-1.458a6 6 0 0 0 .199-.115c.508-.306 1.167-.426 1.795-.191l1.244.466c.16.06.339-.005.424-.152l1.325-2.296a.35.35 0 0 0-.08-.444l-1.026-.845c-.517-.425-.743-1.054-.732-1.647a6 6 0 0 0 0-.23c-.011-.593.215-1.222.732-1.647l1.026-.845a.35.35 0 0 0 .08-.444L18.61 6.653a.35.35 0 0 0-.424-.152l-1.244.466c-.628.235-1.287.115-1.795-.191a6 6 0 0 0-.199-.115c-.518-.287-.95-.797-1.06-1.458l-.219-1.31a.35.35 0 0 0-.343-.29zM12 9.735a2.265 2.265 0 1 0 0 4.53 2.265 2.265 0 0 0 0-4.53M8.132 12a3.868 3.868 0 1 1 7.735 0 3.868 3.868 0 0 1-7.735 0" clip-rule="evenodd"/>',
	chevron:
		'<path fill="currentColor" fill-rule="evenodd" d="M12.566 15.316a.8.8 0 0 1-1.132 0l-5.5-5.5a.8.8 0 1 1 1.132-1.132L12 13.62l4.934-4.935a.8.8 0 0 1 1.132 1.132z" clip-rule="evenodd"/>',
	caret:
		'<path fill="currentColor" fill-rule="evenodd" d="M15.316 11.434a.8.8 0 0 1 0 1.132l-5.5 5.5a.8.8 0 1 1-1.132-1.132L13.62 12 8.684 7.066a.8.8 0 1 1 1.132-1.132z" clip-rule="evenodd"/>',
	ads: '<path fill="currentColor" d="M12.495 21.5h-1.77a6.713 6.713 0 0 1-6.708-6.708V7.63a2.18 2.18 0 0 1 2.762-2.096V4.99a2.18 2.18 0 0 1 2.893-2.052A2.17 2.17 0 0 1 11.715 1.5c.938 0 1.745.596 2.043 1.438.228-.079.465-.123.719-.123 1.192 0 2.166.973 2.166 2.175v4.603a2.18 2.18 0 0 1 2.709.29c.824.824.842 2.156.053 3.007v1.692a5.37 5.37 0 0 1-1.579 3.814l-1.517 1.517a5.37 5.37 0 0 1-3.814 1.578zM6.191 7.033a.597.597 0 0 0-.596.596v7.163a5.13 5.13 0 0 0 5.13 5.13h1.77a3.82 3.82 0 0 0 2.7-1.114l1.518-1.517a3.8 3.8 0 0 0 1.113-2.7V12.82c0-.369.15-.71.404-.974a.593.593 0 0 0 0-.833c-.22-.228-.614-.219-.833 0a2.57 2.57 0 0 0-.754 1.798v1.324a.786.786 0 0 1-.79.789 3.1 3.1 0 0 0-1.315.29 3 3 0 0 0-.912.64.789.789 0 0 1-1.113-1.114q.603-.604 1.377-.956a4.6 4.6 0 0 1 1.183-.368V4.998a.595.595 0 0 0-.587-.596.59.59 0 0 0-.588.596v5.849c0 .438-.35.789-.789.789a.786.786 0 0 1-.789-.79V3.684a.597.597 0 0 0-1.193 0V4.99l.07 5.19a.79.79 0 0 1-.78.798c-.464-.017-.789-.342-.798-.78l-.07-5.19a.597.597 0 0 0-.587-.606.597.597 0 0 0-.596.596v6.506c0 .439-.351.79-.79.79a.786.786 0 0 1-.789-.79V7.63a.595.595 0 0 0-.587-.596z"/>',
	https:
		'<path fill="currentColor" fill-rule="evenodd" d="M8.667 7A3.337 3.337 0 0 1 12 3.667 3.337 3.337 0 0 1 15.333 7v1.667H8.667zm9.166 1.667H17V7c0-2.758-2.242-5-5-5S7 4.242 7 7v1.667h-.833a2.503 2.503 0 0 0-2.5 2.5V19.5c0 1.378 1.121 2.5 2.5 2.5h11.666c1.379 0 2.5-1.122 2.5-2.5v-8.333c0-1.379-1.121-2.5-2.5-2.5m.834 10.833c0 .46-.375.833-.834.833H6.167a.834.834 0 0 1-.834-.833v-8.333c0-.46.374-.834.834-.834h11.666c.46 0 .834.374.834.834zm-8.334-4.167a.833.833 0 1 1-1.666 0 .833.833 0 0 1 1.666 0m1.667.834a.833.833 0 1 0 0-1.667.833.833 0 0 0 0 1.667m3.333-.834a.833.833 0 1 1-1.666 0 .833.833 0 0 1 1.666 0" clip-rule="evenodd"/>',
	scripts:
		'<path fill="currentColor" fill-rule="evenodd" d="M14.206 3.175a.85.85 0 0 1 .619 1.031l-4 16a.85.85 0 1 1-1.65-.412l4-16a.85.85 0 0 1 1.031-.619M7.601 7.4a.85.85 0 0 1 0 1.202L4.202 12l3.399 3.399a.85.85 0 0 1-1.202 1.202l-4-4a.85.85 0 0 1 0-1.202l4-4a.85.85 0 0 1 1.202 0m8.798 0a.85.85 0 0 1 1.202 0l4 4a.85.85 0 0 1 0 1.202l-4 4a.85.85 0 0 1-1.202-1.202L19.798 12l-3.4-3.399a.85.85 0 0 1 0-1.202" clip-rule="evenodd"/>',
	fingerprint:
		'<path fill="currentColor" fill-rule="evenodd" d="M21.298 12.15a.834.834 0 0 1-.954-.692c-.144-.897-.451-1.912-.802-2.647a.834.834 0 0 1 1.503-.719c.421.883.775 2.043.944 3.104a.834.834 0 0 1-.69.955m-2.237-4.98a.83.83 0 0 1-.658-.322 8.18 8.18 0 0 0-6.49-3.181c-1.354 0-2.626.282-3.78.839a.834.834 0 0 1-.725-1.501C8.791 2.338 10.307 2 11.913 2a9.84 9.84 0 0 1 7.806 3.823.835.835 0 0 1-.658 1.346m-8.667-1.125a.83.83 0 0 1-.424 1.1C8.04 8 6.693 10.001 6.693 12.012q0 .434.016.79a.834.834 0 0 1-.8.867h-.034a.833.833 0 0 1-.832-.8q-.016-.385-.017-.857c0-2.65 1.755-5.279 4.268-6.393a.833.833 0 0 1 1.1.425m-6.728 5.943c0 1.159.132 1.87.27 2.625.116.63.236 1.283.297 2.216a.834.834 0 0 1-.777.886l-.055.002a.833.833 0 0 1-.831-.78 16 16 0 0 0-.273-2.024C2.15 14.12 2 13.3 2 11.988c0-2.973 1.12-5.626 3.155-7.47a.833.833 0 1 1 1.119 1.235c-1.682 1.524-2.608 3.738-2.608 6.235m1.87 6.597c.135-.4.223-.665.223-1.076 0-.771-.132-1.259-.26-1.73l-.09-.34a.834.834 0 0 1 1.619-.4l.08.303c.141.523.318 1.175.318 2.167 0 .683-.157 1.153-.31 1.606-.06.183-.127.382-.191.618a.834.834 0 0 1-1.61-.431c.073-.274.15-.505.221-.717m2.685 1.688c.355-.785.589-1.304.589-2.62 0-1.904-.204-2.587-.402-3.247-.175-.584-.355-1.185-.355-2.394 0-2.219 1.66-3.893 3.86-3.893q.386.001.757.068a.833.833 0 1 1-.296 1.64 2.6 2.6 0 0 0-.461-.04c-1.291 0-2.193.915-2.193 2.225 0 .964.125 1.385.284 1.915.222.74.472 1.577.472 3.726 0 1.675-.358 2.467-.736 3.305-.069.153-.14.311-.212.483a.834.834 0 0 1-1.536-.65q.117-.274.23-.518m4.449-3.078h-.008a.834.834 0 0 1-.826-.84 11.6 11.6 0 0 0-.418-3.196c-.127-.457.097-.96.542-1.123.418-.155.88.048 1.008.476.242.807.55 2.18.535 3.858a.834.834 0 0 1-.833.825m-.806 1.593a.833.833 0 1 1 1.654.2c-.22 1.83-.866 2.608-.993 2.745a.833.833 0 0 1-1.237-1.117c.027-.035.423-.56.575-1.828m3.469-8.86c.38.565.644 1.254.786 2.047l.047.263c.313 1.729.607 3.361.052 7.064-.003.015-.246 1.554-.6 2.218a.834.834 0 1 1-1.471-.783c.124-.234.34-1.136.423-1.683.514-3.43.256-4.862-.044-6.52l-.047-.266c-.1-.564-.279-1.037-.53-1.409a.834.834 0 0 1 1.384-.93m-3.262-3.2a.834.834 0 0 1 .119-1.663c3.943.282 6.006 2.973 6.622 5.398l.06.231c.512 2.018.726 2.854.685 5.323a16.7 16.7 0 0 1-.5 3.83.834.834 0 0 1-1.613-.42c.155-.598.42-1.839.446-3.437.037-2.247-.133-2.912-.634-4.885l-.06-.232c-.472-1.861-2.066-3.927-5.125-4.145" clip-rule="evenodd"/>',
	cookie:
		'<path fill="currentColor" d="M10.47 9.77a1.326 1.326 0 1 0 0-2.65 1.326 1.326 0 0 0 0 2.65m-2.042 5.096a1.326 1.326 0 1 0 .002-2.651 1.326 1.326 0 0 0-.002 2.651M15 16.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3"/><path fill="currentColor" fill-rule="evenodd" d="M19.08 6.991a3.05 3.05 0 0 0 .467 2.82c.581.778 1.498 1.293 2.418 1.367C22.448 17.026 17.831 22 12 22c-5.52 0-10-4.474-10-9.987C2 6.475 7.022.873 13.887 2.196c-.45 2.958 2.232 5.5 5.194 4.795m-6.825-3.35.028.165c.414 2.503 2.407 4.492 4.92 4.866l.143.022.027.141a4.95 4.95 0 0 0 2.863 3.552l.13.059-.01.141c-.303 4.504-4.111 7.782-8.356 7.782-4.613 0-8.367-3.75-8.367-8.356 0-1.736.714-3.866 2.123-5.544 1.413-1.683 3.531-2.917 6.332-2.833z" clip-rule="evenodd"/>',
	forget:
		'<path fill="currentColor" fill-rule="evenodd" d="M21.366 2.122a.792.792 0 1 0-1.316-.881l-4.33 6.463-1.101-.738a.79.79 0 0 0-1.099.217v.002l-.007.009-.028.04-.12.167a16.7 16.7 0 0 1-2.253 2.471c-1.528 1.363-3.539 2.591-5.73 2.522a.792.792 0 0 0-.802.945l.777-.153-.777.154v.003l.002.005.002.012a3 3 0 0 0 .04.162q.04.155.131.422c.124.351.325.836.644 1.397.638 1.123 1.744 2.543 3.617 3.797s3.607 1.736 4.89 1.9c.639.08 1.164.082 1.536.062a6 6 0 0 0 .605-.064l.012-.002.005-.001h.002c.001 0 .002 0-.152-.778l.154.777a.792.792 0 0 0 .568-1.101c-.898-2-.528-4.327.15-6.259a16.7 16.7 0 0 1 1.427-3.024q.071-.116.109-.174l.027-.042.006-.01a.79.79 0 0 0-.217-1.099l-1.101-.738zm-7.25 6.895q.138-.168.25-.313l1.132.757 1.131.757a18 18 0 0 0-.73 1.428l-2.574-1.724c.308-.33.573-.639.79-.905m-1.947 2.037 3.123 2.092v.002c-.627 1.784-1.101 4.124-.48 6.375a8 8 0 0 1-.706-.057 9 9 0 0 1-.865-.157c-.308-1.044-.303-2.133-.104-3.202a.792.792 0 1 0-1.557-.29c-.172.925-.228 1.906-.086 2.895a11 11 0 0 1-1.595-.89c-1.646-1.102-2.59-2.33-3.122-3.264a8 8 0 0 1-.322-.632c2.318-.282 4.3-1.612 5.713-2.87zM1.345 16.203a.792.792 0 0 0 0 1.584h2.112a.792.792 0 1 0 0-1.584zm-.792 3.96c0-.437.354-.792.792-.792h4.224a.792.792 0 0 1 0 1.584H1.345a.79.79 0 0 1-.792-.792m.74-5.597a.792.792 0 1 0 0-1.584.792.792 0 0 0 0 1.584" clip-rule="evenodd"/>',
	back: '<path fill="currentColor" fill-rule="evenodd" d="M6.701 11.167h11.466a.833.833 0 0 1 0 1.666H6.7l5.656 5.221a.833.833 0 0 1-1.13 1.225l-6.78-6.258a1.39 1.39 0 0 1 0-2.042l6.78-6.258a.833.833 0 1 1 1.13 1.225z" clip-rule="evenodd"/>',
};
function shieldIcon(name, cls = 'shieldsIcon') {
	return `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${SHIELD_ICONS[name] || ''}</svg>`;
}

const escapeHtml = (text) =>
	String(text).replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
	);

// a custom dropdown (a native <select> cannot be styled like Brave's and its
// open list is not captured in a screenshot): a button and a list of options
function drop(id, current, opts, extra = '') {
	const selected = opts.find((o) => o.v === current) || opts[0];
	const items = opts
		.map(
			(o) =>
				`<li role="option" data-value="${o.v}"${o.v === current ? ' aria-selected="true"' : ''}>${o.label}</li>`,
		)
		.join('');
	return `<div class="shieldsDrop" id="${id}" data-value="${current}">
		<button type="button" class="shieldsDropBtn" aria-haspopup="listbox" aria-expanded="false">
			<span class="shieldsDropLabel">${selected.label}</span>
			${extra}
			${shieldIcon('chevron', 'shieldsIcon chev')}
		</button>
		<ul class="shieldsDropList" role="listbox" hidden>${items}</ul>
	</div>`;
}

function setShield(host, patch) {
	controller.shields.set(host, patch);
	syncShields();
	// most shields take effect only on a fresh load (block scripts,
	// fingerprinting, HTTPS upgrade, cookies, the blocker's mode): reload the
	// open page so the change applies
	if (activeTab && activeTab.frame) activeTab.frame.reload();
}

// --- Fingerprinting protections (the "Block fingerprinting" > detail) --------
// Brave-style, per surface. `performanceMemory` is match-native and ON by
// default: STomp synthesizes a per-site performance.memory so a frame does not
// read the shared process heap of the page that embeds it (the one cross-site
// tell a shared renderer leaks, and the signal Cloudflare Turnstile reads), and
// a real-looking figure helps pass bot checks. The rest are opt-in and OFF by
// default: they farble (canvas, WebGL, audio) or limit/round (fonts, screen,
// CPU cores, device memory, media devices, locale), which makes STomp diverge
// from a real Chrome. A farbled canvas or a capped core count is itself a signal
// a strict bot check can reject, the opposite of STomp's "look like real Chrome"
// baseline, so they default off and a site opts in. Keep this in step with
// src/blocker/types.ts FP_SURFACES / FP_DEFAULT_ON and src/server/shields.ts.
const FP_SURFACE_INFO = [
	{
		id: 'performanceMemory',
		icon: 'memory',
		label: 'Memory (per-site heap)',
		on: true,
		note: 'Reports a per-site performance.memory, so a frame can’t be matched to the page that embeds it by heap size. On by default; keeps bot checks passing.',
	},
	{
		id: 'canvas',
		icon: 'fingerprint',
		label: 'Canvas',
		on: false,
		note: 'Adds per-site noise to canvas readbacks (toDataURL, toBlob, getImageData).',
	},
	{
		id: 'webgl',
		icon: 'fingerprint',
		label: 'WebGL',
		on: false,
		note: 'Noises readPixels and spoofs the unmasked GPU vendor/renderer.',
	},
	{
		id: 'audio',
		icon: 'fingerprint',
		label: 'Audio',
		on: false,
		note: 'Adds tiny per-site noise to AudioBuffer and analyser readbacks.',
	},
	{
		id: 'fonts',
		icon: 'fingerprint',
		label: 'Fonts',
		on: false,
		note: 'Limits font enumeration (measureText and document.fonts) to a standard set.',
	},
	{
		id: 'screen',
		icon: 'fingerprint',
		label: 'Screen size',
		on: false,
		note: 'Rounds screen and window dimensions to a bucket.',
	},
	{
		id: 'hardwareConcurrency',
		icon: 'fingerprint',
		label: 'CPU cores',
		on: false,
		note: 'Caps navigator.hardwareConcurrency low (2).',
	},
	{
		id: 'deviceMemory',
		icon: 'memory',
		label: 'Device memory',
		on: false,
		note: 'Caps navigator.deviceMemory low (4).',
	},
	{
		id: 'mediaDevices',
		icon: 'fingerprint',
		label: 'Media devices',
		on: false,
		note: 'Reports one input/output of each kind, so the device count can’t enumerate.',
	},
	{
		id: 'locale',
		icon: 'fingerprint',
		label: 'Language & timezone',
		on: false,
		note: 'Reports a standard language list (en-US) and timezone (UTC).',
	},
];
// User Agent: deferred. Brave freezes/reduces it, but a reduced UA breaks
// STomp's "look like real Chrome" badly (it is the strongest bot-check signal),
// so it is not offered here. See the report / docs/adblock.md.

// a surface's default on/off, from FP_SURFACE_INFO (mirrors FP_DEFAULT_ON)
const fpDefaultOn = (id) => !!FP_SURFACE_INFO.find((s) => s.id === id)?.on;

// whether STomp protects a surface for this state; mirrors the service worker's
// ShieldsStore.fingerprintSurface (master off -> nothing; else the surface's own
// flag, or its default when it has none)
function fpEmulated(state, id) {
	if (state.blockFingerprinting === false) return false;
	const flag = state.fingerprint?.[id];
	return flag === undefined ? fpDefaultOn(id) : flag;
}

// the per-site note under the main panel's "Block fingerprinting" row
function fpSummary(state) {
	if (state.blockFingerprinting === false)
		return 'This site reads your browser’s own values.';
	const extra = FP_SURFACE_INFO.filter((s) => !s.on && fpEmulated(state, s.id));
	if (!extra.length) return '';
	if (extra.length === 1)
		return `${extra[0].label} protection on for this site.`;
	return `${extra.length} extra protections on for this site.`;
}

// Play the directional cross-fade when navigating between the panel's views
// (into a detail submenu and Back). The panel re-renders by swapping innerHTML,
// so a true two-pane slide would mean holding both views at once; this instead
// fades the freshly-rendered view in with a small directional offset. The
// animation is re-triggered by clearing the class and forcing a reflow before
// re-adding it; reduced motion neutralises it in CSS.
function playShieldsNav(dir) {
	shieldsPanel.classList.remove('shAnimFwd', 'shAnimBack');
	void shieldsPanel.offsetWidth; // reflow so the animation restarts
	shieldsPanel.classList.add(dir === 'back' ? 'shAnimBack' : 'shAnimFwd');
}

function buildShieldsPanel(host) {
	const state = controller.shields.get(host);
	const count = shieldsCountNow();
	const favicon = (activeTab && activeTab.icon) || '/pm/icons/globe.png';
	shieldsPanel.classList.toggle('down', !state.enabled);

	const head = `
		<div class="shieldsHead">
			<span class="shieldsFavicon" style="background-image:url('${escapeHtml(favicon)}')"></span>
			<span class="shieldsDomain" dir="ltr" title="${escapeHtml(host)}">${escapeHtml(host)}</span>
			<span class="shieldsState">Shields <b>${state.enabled ? 'up' : 'down'}</b> for this site</span>
			<input type="checkbox" class="shieldsToggle" id="shMaster" ${state.enabled ? 'checked' : ''} aria-label="Shields up for this site" />
		</div>`;

	const footer = `
		<div class="shieldsFooter">
			<button type="button" id="shFilterLists">Filter lists</button>
			<button type="button" id="shGlobal">Global Settings</button>
		</div>`;

	if (!state.enabled) {
		shieldsPanel.innerHTML =
			`<div class="shieldsCard shieldsCardOff">` + head + `</div>` + footer;
	} else {
		// every row ends with a .shieldsDetail slot so the toggles and dropdowns
		// share one right edge; the slot holds the > on the rows that have one
		// (trackers & ads, fingerprinting) and is empty but reserved on the rest
		const detail = (inner = '') => `<div class="shieldsDetail">${inner}</div>`;
		const rows = `
			<div class="shieldsRow">
				${shieldIcon('ads')}
				<div class="shieldsRowMain">
					${drop(
						'shAds',
						state.mode,
						[
							{
								v: 'aggressive',
								label: 'Aggressively block trackers &amp; ads',
							},
							{ v: 'standard', label: 'Block trackers &amp; ads' },
							{ v: 'allow', label: 'Allow all trackers &amp; ads' },
						],
						`<span class="count adsCount">${count || ''}</span>`,
					)}
				</div>
				${detail(
					`<button class="shieldsMore" id="shAdsMore" aria-label="Trackers and ads details">${shieldIcon('caret', 'shieldsIcon')}</button>`,
				)}
			</div>
			<div class="shieldsRow">
				${shieldIcon('https')}
				<div class="shieldsRowMain">
					${drop('shHttps', state.httpsUpgrade, [
						{ v: 'strict', label: 'Only connect with HTTPS' },
						{ v: 'upgrade', label: 'Upgrade connections to HTTPS' },
						{ v: 'off', label: "Don't upgrade HTTP connections" },
					])}
				</div>
				${detail()}
			</div>
			<div class="shieldsRow">
				${shieldIcon('scripts')}
				<div class="shieldsRowMain">
					<div class="shieldsRowLabel">Block scripts</div>
				</div>
				<input type="checkbox" class="shieldsToggle small" id="shScripts" ${state.blockScripts ? 'checked' : ''} aria-label="Block scripts" />
				${detail()}
			</div>
			<div class="shieldsRow">
				${shieldIcon('fingerprint')}
				<div class="shieldsRowMain">
					<div class="shieldsRowLabel">Block fingerprinting</div>
					<div class="shieldsNote" id="shFpNote"></div>
				</div>
				<input type="checkbox" class="shieldsToggle small" id="shFp" ${state.blockFingerprinting ? 'checked' : ''} aria-label="Block fingerprinting" />
				${detail(
					`<button class="shieldsMore" id="shFpMore" aria-label="Fingerprinting protections">${shieldIcon('caret', 'shieldsIcon')}</button>`,
				)}
			</div>
			<div class="shieldsRow">
				${shieldIcon('cookie')}
				<div class="shieldsRowMain">
					${drop('shCookies', state.cookies, [
						{ v: 'all', label: 'Block all cookies' },
						{ v: 'third-party', label: 'Block third-party cookies' },
						{ v: 'allow', label: 'Allow all cookies' },
					])}
				</div>
				${detail()}
			</div>
			<div class="shieldsRow">
				${shieldIcon('forget')}
				<div class="shieldsRowMain">
					<div class="shieldsRowLabel">Forget me when I close this site</div>
				</div>
				<input type="checkbox" class="shieldsToggle small" id="shForget" ${state.forget ? 'checked' : ''} aria-label="Forget me when I close this site" />
				${detail()}
			</div>`;

		const advOpen = shieldsAdvancedOpen();
		shieldsPanel.innerHTML =
			`<div class="shieldsCard">` +
			head +
			`<div class="shieldsCount"><b>${count}</b> trackers, ads, and more blocked</div></div>
			<div class="shieldsAdvanced${advOpen ? '' : ' closed'}" id="shAdvanced">
				<button class="shieldsAdvancedHead" id="shAdvancedHead" aria-expanded="${advOpen}">
					${shieldIcon('gear')}
					<span>Advanced options</span>
					${shieldIcon('chevron', 'shieldsIcon chev')}
				</button>
				<div class="shieldsRows">${rows}</div>
			</div>` +
			footer +
			`<div class="shieldsHint">If this site seems broken, try Shields down. This may reduce STomp's privacy protections.</div>`;
	}

	wireShieldsPanel(host);
}

function wireShieldsPanel(host) {
	const q = (sel) => shieldsPanel.querySelector(sel);
	q('#shMaster').addEventListener('change', (event) => {
		setShield(host, { enabled: event.target.checked });
		buildShieldsPanel(host); // the layout changes between up and down
	});
	q('#shFilterLists')?.addEventListener('click', () => {
		closeShields();
		openShieldsPage('filters');
	});
	q('#shGlobal')?.addEventListener('click', () => {
		closeShields();
		openShieldsPage('global');
	});

	const advanced = q('#shAdvanced');
	q('#shAdvancedHead')?.addEventListener('click', () => {
		const closed = advanced.classList.toggle('closed');
		q('#shAdvancedHead').setAttribute('aria-expanded', String(!closed));
		setShieldsAdvancedOpen(!closed);
	});

	wireDrop('shAds', (v) => setShield(host, { mode: v }));
	wireDrop('shHttps', (v) => setShield(host, { httpsUpgrade: v }));
	wireDrop('shCookies', (v) => setShield(host, { cookies: v }));
	q('#shScripts')?.addEventListener('change', (e) =>
		setShield(host, { blockScripts: e.target.checked }),
	);
	q('#shForget')?.addEventListener('change', (e) =>
		setShield(host, { forget: e.target.checked }),
	);
	q('#shAdsMore')?.addEventListener('click', () => {
		shieldsComingSoon('Trackers & ads');
		playShieldsNav('fwd');
	});
	// a click anywhere else in the panel closes an open dropdown
	shieldsPanel.onclick = (e) => {
		if (!e.target.closest('.shieldsDrop')) closeAllDrops();
	};

	// The master "Block fingerprinting": on (the default) STomp emulates every
	// surface to match a native Chrome; off, the site reads this browser's own
	// values for all of them (src/server/shields.ts). It is all-on/all-off over
	// the per-surface set in the > submenu, so turning it on clears any surfaces
	// a site had turned off individually. The note summarises the per-site state.
	const fp = q('#shFp');
	const fpNote = q('#shFpNote');
	if (fpNote) fpNote.textContent = fpSummary(controller.shields.get(host));
	fp?.addEventListener('change', (e) => {
		const on = e.target.checked;
		setShield(host, {
			blockFingerprinting: on,
			...(on ? { fingerprint: {} } : {}),
		});
		if (fpNote) fpNote.textContent = fpSummary(controller.shields.get(host));
	});
	q('#shFpMore')?.addEventListener('click', () => {
		buildFpSubmenu(host);
		playShieldsNav('fwd');
	});
}

// The "Block fingerprinting" detail submenu: a sub-view inside the panel, after
// Brave's fingerprinting detail. A back arrow returns to the per-site panel.
// Every surface is a real toggle now: the match-native one (performanceMemory,
// on by default) and the Brave-style opt-in protections (off by default, since
// farbling/limiting makes STomp diverge from a real Chrome and can fail a
// strict bot check). The applied count is the live number of active surfaces.
function fpRow(state, s, masterOff) {
	const on = fpEmulated(state, s.id);
	return `
		<div class="shieldsRow">
			${shieldIcon(s.icon)}
			<div class="shieldsRowMain">
				<div class="shieldsRowLabel">${escapeHtml(s.label)}</div>
				<div class="shieldsNote">${escapeHtml(s.note)}</div>
			</div>
			<input type="checkbox" class="shieldsToggle small" id="shFp_${s.id}" data-surface="${s.id}" ${on ? 'checked' : ''} ${masterOff ? 'disabled' : ''} aria-label="${escapeHtml(s.label)}" />
			<div class="shieldsDetail"></div>
		</div>`;
}

function buildFpSubmenu(host) {
	const state = controller.shields.get(host);
	const masterOff = state.blockFingerprinting === false;
	const active = masterOff
		? 0
		: FP_SURFACE_INFO.filter((s) => fpEmulated(state, s.id)).length;

	const baseline = FP_SURFACE_INFO.filter((s) => s.on)
		.map((s) => fpRow(state, s, masterOff))
		.join('');
	const optIn = FP_SURFACE_INFO.filter((s) => !s.on)
		.map((s) => fpRow(state, s, masterOff))
		.join('');

	shieldsPanel.innerHTML = `
		<div class="shieldsSubHead">
			<button type="button" class="shieldsBack" id="shFpBack" aria-label="Back to Shields">${shieldIcon('back', 'shieldsIcon')}</button>
			<div class="shieldsSubTitleBlock">
				<div class="shieldsSubTitle">Fingerprinting protections (${active})</div>
				<div class="shieldsSubDomain" dir="ltr" title="${escapeHtml(host)}">${escapeHtml(host)}</div>
			</div>
		</div>
		<div class="shieldsSubNote">
			STomp protects the reading that sharing one browser would otherwise leak
			across sites. A protection applied does not mean this site tried to
			fingerprint you.
		</div>
		${masterOff ? '<div class="shieldsSubNote shieldsSubWarn">Block fingerprinting is off for this site, so every surface reads native. Turn it on to adjust them.</div>' : ''}
		<div class="shieldsRows">
			${baseline}
			<div class="shieldsSubSection">Extra protections (off by default)</div>
			<div class="shieldsSubNote shieldsSubWarn">
				Turning these on makes this site’s values differ from a real Chrome’s,
				which can make some sites’ bot checks (Cloudflare, Turnstile) fail. Turn
				them on per site if a site is fingerprinting you.
			</div>
			${optIn}
		</div>`;

	wireFpSubmenu(host);
}

function wireFpSubmenu(host) {
	const q = (sel) => shieldsPanel.querySelector(sel);
	q('#shFpBack')?.addEventListener('click', () => {
		buildShieldsPanel(host);
		playShieldsNav('back');
	});
	for (const input of shieldsPanel.querySelectorAll('[data-surface]'))
		input.addEventListener('change', (e) => {
			const surface = e.target.dataset.surface;
			const current = controller.shields.get(host).fingerprint || {};
			setShield(host, {
				fingerprint: { ...current, [surface]: e.target.checked },
			});
			buildFpSubmenu(host); // refresh the applied-count and any dependents
		});
}

function closeAllDrops() {
	for (const list of shieldsPanel.querySelectorAll('.shieldsDropList'))
		list.hidden = true;
	for (const btn of shieldsPanel.querySelectorAll('.shieldsDropBtn'))
		btn.setAttribute('aria-expanded', 'false');
}

function wireDrop(id, onPick) {
	const root = shieldsPanel.querySelector(`#${id}`);
	if (!root) return;
	const btn = root.querySelector('.shieldsDropBtn');
	const list = root.querySelector('.shieldsDropList');
	btn.addEventListener('click', (event) => {
		event.stopPropagation();
		const wasClosed = list.hidden;
		closeAllDrops();
		if (wasClosed) {
			list.hidden = false;
			btn.setAttribute('aria-expanded', 'true');
		}
	});
	for (const item of list.querySelectorAll('li')) {
		item.addEventListener('click', () => {
			const value = item.dataset.value;
			root.dataset.value = value;
			root.querySelector('.shieldsDropLabel').innerHTML = item.innerHTML;
			for (const other of list.querySelectorAll('li'))
				other.removeAttribute('aria-selected');
			item.setAttribute('aria-selected', 'true');
			closeAllDrops();
			onPick(value);
		});
	}
}

// ---- Shields settings pages -------------------------------------------------
// Two full-overlay pages the Shields panel's footer opens, after Brave's
// brave://settings/shields and .../shields/filters: "Content Filters" (the
// filter-list editor, with the custom-filters code editor) and "Global
// Settings" (the defaults behind the per-site shields, the '*' entry). Both
// are real: the Global rows write the controller's '*' shields default, so
// they change new-site behaviour; the Filter Lists editor calls
// controller.setAdblockLists, which rebuilds the blocker's engine LIVE (the
// old lists keep serving until the new ones compile). The custom-filters
// editor feeds the user's own uBlock-syntax rules as one inline, untrusted
// list (docs/adblock.md "Changing the lists").

const shieldsPage = $('shieldsPage');
const shieldsPageScrim = $('shieldsPageScrim');

// a few optional community lists STomp can fetch, beyond the eight defaults
// (the "Additional popular community lists" box). Plain third-party lists are
// untrusted: only uBlock Origin's own carry the trusted-* scriptlets, and the
// user did not write these, so they stay as published. These are not uBO's, so
// untrusted all round.
const OPTIONAL_LISTS = [
	{
		url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
		name: 'Cookie notice blocker',
		source: 'EasyList Cookie',
	},
	{
		url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
		name: 'Annoying distractions blocker',
		source: "Fanboy's Annoyances",
	},
	{
		url: 'https://secure.fanboy.co.nz/fanboy-social.txt',
		name: 'Social media buttons blocker',
		source: "Fanboy's Social",
	},
];

// the host-owned editor state, kept in this page's own localStorage and
// applied to the blocker. `off`: default-list URLs the user unchecked; `on`:
// optional-list URLs the user checked; `custom`: user-added list URLs
// (untrusted); `filters`: the custom-filters editor's text; `developer`: the
// developer-mode switch that reveals the custom-filters editor.
const ADBLOCK_CONFIG_KEY = 'stomp-demo:adblock-config';
const SHIELDS_BADGE_KEY = 'stomp-demo:shields-badge';
const SHIELDS_ADVANCED_KEY = 'stomp-demo:shields-advanced';

function loadAdblockConfig() {
	try {
		const raw = JSON.parse(localStorage.getItem(ADBLOCK_CONFIG_KEY));
		if (raw && typeof raw === 'object')
			return {
				off: Array.isArray(raw.off)
					? raw.off.filter((u) => typeof u === 'string')
					: [],
				on: Array.isArray(raw.on)
					? raw.on.filter((u) => typeof u === 'string')
					: [],
				custom: Array.isArray(raw.custom)
					? raw.custom.filter((e) => e && typeof e.url === 'string')
					: [],
				filters: typeof raw.filters === 'string' ? raw.filters : '',
				developer: !!raw.developer,
			};
	} catch {}
	return { off: [], on: [], custom: [], filters: '', developer: false };
}

let adblockConfig = loadAdblockConfig();

function persistAdblockConfig() {
	try {
		localStorage.setItem(ADBLOCK_CONFIG_KEY, JSON.stringify(adblockConfig));
	} catch {}
}

// whether this config asks for anything but the eight defaults: a fresh visit
// (nothing of its own) loads the defaults with no extra engine build
function adblockConfigCustomized() {
	return (
		adblockConfig.off.length > 0 ||
		adblockConfig.on.length > 0 ||
		adblockConfig.custom.length > 0 ||
		adblockConfig.filters.trim() !== ''
	);
}

// the lists to hand the blocker: the enabled defaults, the enabled optional
// lists, the user's custom URL lists (untrusted), then the custom-filters
// editor's text as one inline, untrusted list
function effectiveAdblockLists() {
	const defaults = controller.adblockDefaults
		? controller.adblockDefaults()
		: [];
	const lists = [];
	for (const list of defaults)
		if (!adblockConfig.off.includes(list.url)) lists.push(list);
	for (const opt of OPTIONAL_LISTS)
		if (adblockConfig.on.includes(opt.url))
			lists.push({ url: opt.url, name: opt.name });
	for (const entry of adblockConfig.custom)
		lists.push({
			url: entry.url,
			name: entry.name || entry.url,
			trusted: false,
		});
	const filters = adblockConfig.filters.trim();
	if (filters)
		lists.push({
			url: 'stomp-filters:my-filters',
			name: 'My filters',
			filters: adblockConfig.filters,
			trusted: false,
		});
	return lists;
}

// push the current config to the blocker, rebuilding its engine live. Reports
// honestly whether it applied ('live') or the blocker is off ('off', nothing
// to apply); never claims "applied" when it did not.
async function applyAdblockLists(note = 'Filter lists updated', reload = true) {
	if (!controller?.setAdblockLists) return null;
	try {
		const result = await controller.setAdblockLists(effectiveAdblockLists());
		if (result.applied === 'live') {
			// setAdblockLists resolves once the engine is rebuilt and serving, so
			// a reload here re-serves the page with the new filter set (the live
			// change filters new requests; a reload also re-hides, re-runs the
			// cosmetic side the already-built page kept)
			if (reload) {
				reloadActiveTab();
				setShieldsPageStatus(
					`${note}. The page was reloaded with the updated filters.`,
				);
			} else
				setShieldsPageStatus(
					`${note}. New requests are filtered by the updated lists.`,
				);
		} else
			setShieldsPageStatus(
				'The content blocker is off. Turn it on (the shield toggle by the transport) to apply filter lists.',
				true,
			);
		return result;
	} catch (error) {
		setShieldsPageStatus(`Could not apply: ${error.message}`, true);
		return null;
	}
}

// on boot, a kept non-default config is applied once the controller is ready;
// a fresh config does nothing, so a first visit builds the defaults only. No
// reload here: the page the controller restores loads with the config already
// in force
function applyAdblockConfigOnBoot() {
	if (adblockConfigCustomized())
		applyAdblockLists('Filter lists restored', false);
}

// re-serve the active tab, as the reload button does, so a shields or filter
// change that only takes effect on a fresh load actually takes effect. A no-op
// with no active tab (the shields pages open from a site, so there is one)
function reloadActiveTab() {
	if (!activeTab) return;
	stopGoing(activeTab); // the reload stays on the page the tab shows
	blockedCounts.set(activeTab.frame, 0); // the blocked count starts over
	activeTab.frame.reload();
}

function shieldsShowBadge() {
	try {
		return localStorage.getItem(SHIELDS_BADGE_KEY) !== '0';
	} catch {
		return true;
	}
}
function setShieldsShowBadge(on) {
	try {
		localStorage.setItem(SHIELDS_BADGE_KEY, on ? '1' : '0');
	} catch {}
	syncShields();
}

// Whether the Advanced options section is expanded, remembered across popup
// opens (and reloads) in this page's own localStorage. Defaults to open.
function shieldsAdvancedOpen() {
	try {
		return localStorage.getItem(SHIELDS_ADVANCED_KEY) !== '0';
	} catch {
		return true;
	}
}
function setShieldsAdvancedOpen(on) {
	try {
		localStorage.setItem(SHIELDS_ADVANCED_KEY, on ? '1' : '0');
	} catch {}
}

// the '*' default shields entry (the baseline behind every site with no entry
// of its own): what the Global Settings rows read and write
function globalShields() {
	return controller.shields.get('*');
}
function setGlobalShield(patch) {
	controller.shields.set('*', patch);
	syncShields();
	// the per-layer defaults (mode, HTTPS upgrade, cookies, fingerprint, block
	// scripts) take effect when a page is served, so reload the active tab so
	// its site, if it has no entry of its own, re-serves under the new defaults
	reloadActiveTab();
}

// a short status line at the foot of the page, cleared after a while
let shieldsPageStatusTimer = 0;
function setShieldsPageStatus(text, bad = false) {
	const line = shieldsPage.querySelector('.spStatus');
	if (!line) return;
	line.textContent = text;
	line.classList.toggle('bad', bad);
	line.classList.toggle('show', true);
	clearTimeout(shieldsPageStatusTimer);
	shieldsPageStatusTimer = setTimeout(() => {
		line.classList.remove('show');
	}, 6000);
}

// lightweight uBlock-syntax highlighting for the custom-filters editor: a
// coloured <pre> backdrop behind a transparent textarea (the caret and
// selection stay native). Comments, the cosmetic separators (##, #@#, #?#),
// network options after $, and @@ exceptions are tinted; everything else is
// plain. Cheap: one pass of small regexps per line, only on input.
function highlightFilters(text) {
	const esc = (s) => escapeHtml(s);
	return text
		.split('\n')
		.map((line) => {
			if (line === '') return '<span class="cmPlain"> </span>';
			const trimmed = line.trimStart();
			if (trimmed.startsWith('!') || trimmed.startsWith('# '))
				return `<span class="cmComment">${esc(line)}</span>`;
			// cosmetic rule: domains ## selector (or #@#, #?#, #$#)
			const cosmetic = line.match(/^(.*?)(#@?\$?\??#)(.*)$/);
			if (cosmetic)
				return (
					`<span class="cmDomain">${esc(cosmetic[1])}</span>` +
					`<span class="cmSep">${esc(cosmetic[2])}</span>` +
					`<span class="cmSelector">${esc(cosmetic[3])}</span>`
				);
			// network rule: optional @@ exception, a pattern, optional $options
			let html = '';
			let rest = line;
			if (rest.startsWith('@@')) {
				html += '<span class="cmException">@@</span>';
				rest = rest.slice(2);
			}
			const opt = rest.match(/^(.*?)(\$)([^$]*)$/);
			if (opt)
				html +=
					`<span class="cmPlain">${esc(opt[1])}</span>` +
					`<span class="cmSep">$</span>` +
					`<span class="cmOption">${esc(opt[3])}</span>`;
			else html += `<span class="cmPlain">${esc(rest)}</span>`;
			return html;
		})
		.join('\n');
}

// a monospace code editor: a line-number gutter and a textarea over a
// syntax-highlighted backdrop. Returns the textarea so callers can read it.
function buildFilterEditor(initial) {
	const wrap = element('div', 'cmEditor');
	const gutter = element('div', 'cmGutter');
	const area = element('div', 'cmArea');
	const pre = element('pre', 'cmHighlight');
	pre.setAttribute('aria-hidden', 'true');
	const code = element('code', 'cmCode');
	pre.append(code);
	const input = element('textarea', 'cmInput');
	input.spellcheck = false;
	input.autocapitalize = 'off';
	input.setAttribute('autocomplete', 'off');
	input.setAttribute('autocorrect', 'off');
	input.setAttribute(
		'aria-label',
		'Custom filters, one uBlock-syntax rule per line',
	);
	input.value = initial;
	area.append(pre, input);
	wrap.append(gutter, area);

	const sync = () => {
		code.innerHTML = highlightFilters(input.value);
		const lines = input.value.split('\n').length;
		let nums = '';
		for (let i = 1; i <= lines; i++) nums += `${i}\n`;
		gutter.textContent = nums;
	};
	const scroll = () => {
		pre.scrollTop = input.scrollTop;
		pre.scrollLeft = input.scrollLeft;
		gutter.scrollTop = input.scrollTop;
	};
	input.addEventListener('input', sync);
	input.addEventListener('scroll', scroll);
	// a Tab inserts two spaces instead of leaving the editor
	input.addEventListener('keydown', (event) => {
		if (event.key !== 'Tab' || event.shiftKey) return;
		event.preventDefault();
		const start = input.selectionStart;
		const end = input.selectionEnd;
		input.value = `${input.value.slice(0, start)}  ${input.value.slice(end)}`;
		input.selectionStart = input.selectionEnd = start + 2;
		sync();
	});
	sync();
	wrap._input = input;
	return wrap;
}

// count the real filter rules in the editor text (non-blank, non-comment),
// for the honest "N rules" status
function countFilterRules(text) {
	return text.split('\n').filter((line) => {
		const t = line.trim();
		return t && !t.startsWith('!') && !t.startsWith('# ');
	}).length;
}

function buildFilterListsPage() {
	const defaults = controller.adblockDefaults
		? controller.adblockDefaults()
		: [];
	const blockerOff = defaults.length === 0;
	shieldsPage.dataset.view = 'filters';
	shieldsPage.innerHTML = `
		<div class="spHead">
			<button class="spBack" id="spBack" type="button" aria-label="Back">
				${shieldIcon('caret', 'shieldsIcon')}
			</button>
			<h2 class="spTitle" id="shieldsPageTitle">Content Filters</h2>
			<button class="spClose" id="spClose" type="button" aria-label="Close">×</button>
		</div>
		<div class="spBody">
			${
				blockerOff
					? `<div class="spCallout warn">The content blocker is off. Turn it on with the shield toggle beside the transport selector to edit and apply filter lists.</div>`
					: ''
			}
			<section class="spSection">
				<h3 class="spSectionTitle">Filter lists</h3>
				<p class="spSectionNote">Additional popular community lists. Note that enabling too many filters will degrade browsing speeds.</p>
				<div class="spListBox" id="spListBox"></div>
				<div class="spRowButtons">
					<button class="spBtn ghost" id="spShowFull" type="button">Show full list</button>
					<button class="spBtn ghost" id="spUpdate" type="button">Update lists</button>
				</div>
			</section>

			<section class="spSection">
				<h3 class="spSectionTitle">Add custom filter lists</h3>
				<p class="spSectionNote">Add additional lists created and maintained by your trusted community. Only subscribe to lists from entities you trust.</p>
				<p class="spSectionNote good">Lists are fetched through the proxy, so the list server never sees your address, only the wisp server's. A custom list is untrusted: it cannot run the trusted-* scriptlets that edit a page's cookies, storage or responses.</p>
				<div class="spAddRow">
					<input class="spInput" id="spCustomUrl" type="url" inputmode="url" placeholder="Enter filter list URL" aria-label="Filter list URL" />
					<button class="spBtn" id="spCustomAdd" type="button">Add</button>
				</div>
				<div class="spCustomList" id="spCustomList"></div>
			</section>

			<section class="spSection">
				<div class="spToggleRow">
					<div class="spRowText">
						<div class="spRowLabel">Developer mode</div>
						<div class="spRowSub">Allow adding custom filters and scriptlets.</div>
					</div>
					<input type="checkbox" class="shieldsToggle small" id="spDeveloper" ${adblockConfig.developer ? 'checked' : ''} aria-label="Developer mode" />
				</div>
			</section>

			<div id="spDevArea" class="${adblockConfig.developer ? '' : 'hidden'}">
				<section class="spSection">
					<h3 class="spSectionTitle">Create custom filters</h3>
					<p class="spSectionNote">Add custom filters you've created, one per line, in the field below. Be sure to use the Adblock filter syntax.</p>
					<div id="spEditorMount"></div>
					<div class="spRowButtons">
						<span class="spEditorStat" id="spEditorStat"></span>
						<button class="spBtn" id="spSaveFilters" type="button">Save changes</button>
					</div>
				</section>

				<section class="spSection">
					<h3 class="spSectionTitle">Custom scriptlets</h3>
					<p class="spSectionNote warn">Not available in STomp. Scriptlets run with the trusted-* powers that edit a page's cookies, storage and responses, so STomp never runs scriptlets a user typed. Only the maintained lists' own scriptlets run, and only from lists marked trusted.</p>
				</section>
			</div>

			<div class="spStatus" id="spStatus" aria-live="polite"></div>
		</div>`;

	// the filter-list rows: the eight defaults (checked unless unchecked) then
	// the optional community lists (checked only when the user added them)
	const box = shieldsPage.querySelector('#spListBox');
	const rowFor = (url, name, source, on, trusted) => {
		const row = element('label', 'spListRow');
		const check = element('input');
		check.type = 'checkbox';
		check.className = 'spCheck';
		check.checked = on;
		check.disabled = blockerOff;
		const text = element('span', 'spListText');
		const title = element('span', 'spListName', name);
		if (trusted) {
			const tag = element('span', 'spTag', 'trusted');
			title.append(' ', tag);
		}
		text.append(title, element('span', 'spListSource', source));
		row.append(check, text);
		return { row, check };
	};
	for (const list of defaults) {
		const on = !adblockConfig.off.includes(list.url);
		const { row, check } = rowFor(
			list.url,
			list.name || list.url,
			shortListUrl(list.url),
			on,
			list.trusted,
		);
		check.addEventListener('change', () => {
			adblockConfig.off = adblockConfig.off.filter((u) => u !== list.url);
			if (!check.checked) adblockConfig.off.push(list.url);
			persistAdblockConfig();
			applyAdblockLists();
		});
		box.append(row);
	}
	for (const opt of OPTIONAL_LISTS) {
		const on = adblockConfig.on.includes(opt.url);
		const { row, check } = rowFor(opt.url, opt.name, opt.source, on, false);
		check.addEventListener('change', () => {
			adblockConfig.on = adblockConfig.on.filter((u) => u !== opt.url);
			if (check.checked) adblockConfig.on.push(opt.url);
			persistAdblockConfig();
			applyAdblockLists();
		});
		box.append(row);
	}

	renderCustomLists();

	const editor = buildFilterEditor(adblockConfig.filters);
	shieldsPage.querySelector('#spEditorMount').append(editor);
	const editorInput = editor._input;
	const stat = shieldsPage.querySelector('#spEditorStat');
	const showStat = () => {
		const n = countFilterRules(editorInput.value);
		stat.textContent = n ? `${n} rule${n === 1 ? '' : 's'}` : 'No rules yet';
	};
	editorInput.addEventListener('input', showStat);
	showStat();

	shieldsPage
		.querySelector('#spBack')
		.addEventListener('click', backShieldsPage);
	shieldsPage
		.querySelector('#spClose')
		.addEventListener('click', closeShieldsPage);
	shieldsPage
		.querySelector('#spShowFull')
		.addEventListener('click', () =>
			setShieldsPageStatus(
				'STomp ships the eight default lists and these optional ones; a fuller catalogue is a later phase. Add any list by URL below.',
			),
		);
	shieldsPage.querySelector('#spUpdate').addEventListener('click', async () => {
		setShieldsPageStatus('Updating lists…');
		const result = await controller.refreshAdblockLists?.();
		if (result?.applied === 'live') {
			reloadActiveTab();
			setShieldsPageStatus(
				'Lists re-fetched and recompiled through the proxy; the page was reloaded.',
			);
		} else if (result?.applied === 'off')
			setShieldsPageStatus(
				'The content blocker is off; nothing to update.',
				true,
			);
	});
	shieldsPage
		.querySelector('#spDeveloper')
		.addEventListener('change', (event) => {
			adblockConfig.developer = event.target.checked;
			persistAdblockConfig();
			shieldsPage
				.querySelector('#spDevArea')
				.classList.toggle('hidden', !event.target.checked);
		});
	shieldsPage.querySelector('#spSaveFilters').addEventListener('click', () => {
		adblockConfig.filters = editorInput.value;
		persistAdblockConfig();
		applyAdblockLists('Custom filters saved');
	});
	const addInput = shieldsPage.querySelector('#spCustomUrl');
	const addList = () => {
		const url = addInput.value.trim();
		if (!url) return;
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			setShieldsPageStatus('That is not a valid URL.', true);
			return;
		}
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			setShieldsPageStatus('A filter list must be an http(s) URL.', true);
			return;
		}
		if (
			adblockConfig.custom.some((e) => e.url === parsed.href) ||
			[...defaults, ...OPTIONAL_LISTS].some((l) => l.url === parsed.href)
		) {
			setShieldsPageStatus('That list is already in the list.', true);
			return;
		}
		adblockConfig.custom.push({ url: parsed.href });
		addInput.value = '';
		persistAdblockConfig();
		renderCustomLists();
		applyAdblockLists('Custom list added');
	};
	shieldsPage.querySelector('#spCustomAdd').addEventListener('click', addList);
	addInput.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			addList();
		}
	});
}

// the shortest readable form of a list URL for the grey source line
function shortListUrl(url) {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, '') + u.pathname;
	} catch {
		return url;
	}
}

function renderCustomLists() {
	const box = shieldsPage.querySelector('#spCustomList');
	if (!box) return;
	box.replaceChildren();
	if (!adblockConfig.custom.length) return;
	for (const entry of adblockConfig.custom) {
		const row = element('div', 'spCustomRow');
		const text = element('span', 'spCustomUrlText', entry.url);
		const remove = element('button', 'spCustomRemove', '×');
		remove.type = 'button';
		remove.title = 'Remove';
		remove.setAttribute('aria-label', `Remove ${entry.url}`);
		remove.addEventListener('click', () => {
			adblockConfig.custom = adblockConfig.custom.filter(
				(e) => e.url !== entry.url,
			);
			persistAdblockConfig();
			renderCustomLists();
			applyAdblockLists('Custom list removed');
		});
		row.append(text, remove);
		box.append(row);
	}
}

// a native select styled like the panel's dropdowns, for the Global rows
function spSelect(id, value, options) {
	const sel = element('select', 'shieldsSelect spSelect');
	sel.id = id;
	for (const opt of options) {
		const o = element('option', null, opt.label);
		o.value = opt.v;
		if (opt.v === value) o.selected = true;
		sel.append(o);
	}
	return sel;
}

function buildGlobalPage() {
	const g = globalShields();
	shieldsPage.dataset.view = 'global';
	shieldsPage.innerHTML = `
		<div class="spHead">
			<h2 class="spTitle" id="shieldsPageTitle">Shields</h2>
			<button class="spClose" id="spClose" type="button" aria-label="Close">×</button>
		</div>
		<div class="spBody">
			<div class="spCallout">
				<div class="spCalloutTitle">Block trackers and ads which follow you across the web</div>
				<p>These are the default Shields settings. They apply to all websites unless you change something in the Shields panel on a particular site. Changing these won't affect your existing per-site settings.</p>
			</div>

			<div class="spRows">
				<div class="spSettingRow">
					<div class="spRowText"><div class="spRowLabel">Show the number of blocked items on the shields icon</div></div>
					<input type="checkbox" class="shieldsToggle small" id="spBadge" ${shieldsShowBadge() ? 'checked' : ''} aria-label="Show the number of blocked items on the shields icon" />
				</div>
				<div class="spSettingRow">
					<div class="spRowText"><div class="spRowLabel">Trackers &amp; ads blocking</div></div>
					<div class="spRowControl" id="spModeMount"></div>
				</div>
				<div class="spSettingRow">
					<div class="spRowText"><div class="spRowLabel">Upgrade connections to HTTPS</div></div>
					<div class="spRowControl" id="spHttpsMount"></div>
				</div>
				<div class="spSettingRow">
					<div class="spRowText"><div class="spRowLabel">Block scripts</div></div>
					<input type="checkbox" class="shieldsToggle small" id="spScripts" ${g.blockScripts ? 'checked' : ''} aria-label="Block scripts" />
				</div>
				<div class="spSettingRow">
					<div class="spRowText"><div class="spRowLabel">Block fingerprinting</div></div>
					<input type="checkbox" class="shieldsToggle small" id="spFp" ${g.blockFingerprinting !== false ? 'checked' : ''} aria-label="Block fingerprinting" />
				</div>
				<div class="spSettingRow">
					<div class="spRowText"><div class="spRowLabel">Block cookies</div></div>
					<div class="spRowControl" id="spCookiesMount"></div>
				</div>
				<div class="spSettingRow">
					<div class="spRowText">
						<div class="spRowLabel">Forget me when I close this site</div>
						<div class="spRowSub">Clears cookies and other site data when you close a site.</div>
					</div>
					<input type="checkbox" class="shieldsToggle small" id="spForget" ${g.forget ? 'checked' : ''} aria-label="Forget me when I close this site" />
				</div>
				<button class="spSettingRow nav" id="spContentFiltering" type="button">
					<div class="spRowText"><div class="spRowLabel">Content filtering</div><div class="spRowSub">Filter lists and your own custom filters.</div></div>
					${shieldIcon('caret', 'shieldsIcon')}
				</button>
			</div>

			<div class="spStatus" id="spStatus" aria-live="polite"></div>
		</div>`;

	shieldsPage.querySelector('#spModeMount').append(
		spSelect('spMode', g.mode, [
			{ v: 'aggressive', label: 'Aggressive' },
			{ v: 'standard', label: 'Standard' },
			{ v: 'allow', label: 'Allow all trackers & ads' },
		]),
	);
	shieldsPage.querySelector('#spHttpsMount').append(
		spSelect('spHttps', g.httpsUpgrade, [
			{ v: 'strict', label: 'Only connect with HTTPS' },
			{ v: 'upgrade', label: 'Upgrade connections to HTTPS' },
			{ v: 'off', label: "Don't upgrade connections" },
		]),
	);
	shieldsPage.querySelector('#spCookiesMount').append(
		spSelect('spCookies', g.cookies, [
			{ v: 'all', label: 'Block all cookies' },
			{ v: 'third-party', label: 'Block third-party cookies' },
			{ v: 'allow', label: 'Allow all cookies' },
		]),
	);

	const q = (sel) => shieldsPage.querySelector(sel);
	q('#spClose').addEventListener('click', closeShieldsPage);
	q('#spBadge').addEventListener('change', (e) =>
		setShieldsShowBadge(e.target.checked),
	);
	q('#spMode').addEventListener('change', (e) =>
		setGlobalShield({ mode: e.target.value }),
	);
	q('#spHttps').addEventListener('change', (e) =>
		setGlobalShield({ httpsUpgrade: e.target.value }),
	);
	q('#spScripts').addEventListener('change', (e) =>
		setGlobalShield({ blockScripts: e.target.checked }),
	);
	q('#spFp').addEventListener('change', (e) =>
		setGlobalShield({ blockFingerprinting: e.target.checked }),
	);
	q('#spCookies').addEventListener('change', (e) =>
		setGlobalShield({ cookies: e.target.value }),
	);
	q('#spForget').addEventListener('change', (e) =>
		setGlobalShield({ forget: e.target.checked }),
	);
	q('#spContentFiltering').addEventListener('click', () =>
		openShieldsPage('filters', 'global'),
	);
}

// which page opened this one, so the Filter Lists back arrow returns to Global
// Settings when that is where it came from, else closes
let shieldsPageFrom = null;
let shieldsPageOpener = null;

function openShieldsPage(view, from = null) {
	shieldsPageFrom = from;
	if (!shieldsPageOpener) shieldsPageOpener = document.activeElement;
	if (view === 'global') buildGlobalPage();
	else buildFilterListsPage();
	shieldsPage.classList.remove('hidden');
	shieldsPage.setAttribute('aria-hidden', 'false');
	shieldsPageScrim.classList.remove('hidden');
	landing.inert = true;
	browser.inert = true;
	shieldsPage.scrollTop = 0;
	(shieldsPage.querySelector('.spClose') || shieldsPage).focus();
}

function backShieldsPage() {
	if (shieldsPageFrom === 'global') openShieldsPage('global');
	else closeShieldsPage();
}

function closeShieldsPage() {
	shieldsPage.classList.add('hidden');
	shieldsPage.setAttribute('aria-hidden', 'true');
	shieldsPageScrim.classList.add('hidden');
	landing.inert = false;
	browser.inert = false;
	shieldsPageFrom = null;
	const opener = shieldsPageOpener;
	shieldsPageOpener = null;
	if (opener && opener.isConnected) opener.focus();
}

const shieldsPageOpen = () => !shieldsPage.classList.contains('hidden');

shieldsPageScrim.addEventListener('click', closeShieldsPage);
addEventListener(
	'keydown',
	(event) => {
		if (event.key !== 'Escape' || !shieldsPageOpen()) return;
		if (shieldsPage.dataset.view === 'filters' && shieldsPageFrom === 'global')
			backShieldsPage();
		else closeShieldsPage();
		event.stopImmediatePropagation();
	},
	true,
);

// the detail views and the panel's own popovers are placeholders in phase 1
function shieldsComingSoon(title) {
	const back = shieldsPanel.dataset.host;
	shieldsPanel.classList.remove('down');
	shieldsPanel.innerHTML = `
		<div class="shieldsHead">
			<button class="shieldsMore" id="shBack" aria-label="Back" style="transform:rotate(180deg)">${shieldIcon('caret', 'shieldsIcon')}</button>
			<span class="shieldsDomain" dir="ltr" style="grid-column:2">${escapeHtml(title)}</span>
		</div>
		<div class="shieldsReport">Coming in a later phase.</div>`;
	shieldsPanel.querySelector('#shBack').addEventListener('click', () => {
		buildShieldsPanel(back);
		playShieldsNav('back');
	});
}

function positionShields() {
	const rect = shieldsButton.getBoundingClientRect();
	shieldsPanel.style.top = `${Math.round(rect.bottom + 4)}px`;
	shieldsPanel.style.left = 'auto';
	shieldsPanel.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
}

function openShields() {
	const host = activeHost();
	if (!host) return;
	if (!controller.shields.has(host)) controller.shields.set(host, {});
	shieldsPanel.dataset.host = host;
	// clear any leftover view-swap class so reopening plays only the panel-in
	// animation, not a stale per-child one
	shieldsPanel.classList.remove('shAnimFwd', 'shAnimBack');
	buildShieldsPanel(host);
	positionShields();
	shieldsPanel.classList.remove('hidden');
	shieldsPanel.setAttribute('aria-hidden', 'false');
	shieldsScrim.classList.remove('hidden');
	shieldsButton.setAttribute('aria-expanded', 'true');
}

function closeShields() {
	shieldsPanel.classList.add('hidden');
	shieldsPanel.setAttribute('aria-hidden', 'true');
	shieldsScrim.classList.add('hidden');
	shieldsButton.setAttribute('aria-expanded', 'false');
}

const shieldsOpen = () => !shieldsPanel.classList.contains('hidden');

shieldsButton.addEventListener('click', () => {
	if (shieldsOpen()) closeShields();
	else openShields();
});
shieldsScrim.addEventListener('click', closeShields);
window.addEventListener('resize', () => {
	if (shieldsOpen()) positionShields();
});
addEventListener(
	'keydown',
	(event) => {
		if (event.key !== 'Escape' || !shieldsOpen()) return;
		closeShields();
		event.stopImmediatePropagation();
	},
	true,
);

const booted = boot();
booted
	.then(async () => {
		// a kept, non-default filter-list config is applied once the controller
		// is up (a fresh visit loads the defaults with no extra engine build)
		applyAdblockConfigOnBoot();
		// restore a proxied URL from the fragment after a refresh
		const restore = await readHash();
		if (restore) navigate(restore, { newTab: true });
		else mainForm.url.focus();
	})
	.catch((error) => {
		badge('Error', error.message, 'red');
		console.error(error);
		setStatus(`Error: ${error.message}`, true);
	});
