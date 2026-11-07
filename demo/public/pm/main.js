// Stomp demo: Powermouse-styled landing page, a browser view with tabs, and
// an early-Android style navigation bar. Everything uses the public
// StompController / Frame API from dist/Controller.js.

const DIRECTORY = '/stomp/';
const SEARCH = new SearchBuilder('https://www.google.com/search?q=%s');
const QUICK_LINKS = [
	['Reddit', 'https://old.reddit.com/', 'orange'],
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
const ISOLATED = !!PROXY_ORIGIN && PROXY_ORIGIN !== location.origin;
// HTTP cache in the service worker, on by default; ?nocache turns it off for a
// visit
const CACHE = !new URLSearchParams(location.search).has('nocache');
const proxyBase = ISOLATED ? PROXY_ORIGIN : '';
// STOMP_WISP_URL points the transports at an external wisp server (in
// production, the edge relay); otherwise the demo server's own /wisp/
const wisp =
	CFG.wisp ||
	`${(ISOLATED ? PROXY_ORIGIN : location.origin).replace(/^http/, 'ws')}/wisp/`;

// transports are described, not constructed: in isolation mode the instance
// has to be created inside the controller frame on the proxy origin
const transports = {
	epoxy: () => ({
		module: `${proxyBase}/epoxy/index.mjs`,
		options: [{ wisp }],
	}),
	libcurl: () => ({
		module: `${proxyBase}/libcurl/index.mjs`,
		// libcurl.js 0.7's default pool (50 total, 6 per host) deadlocks once a
		// page fans out more requests than that; see CHANGELOG known limitations
		options: [{ wisp, connections: [500, 400, 200] }],
	}),
};

async function instantiate(descriptor) {
	const { default: Transport } = await import(descriptor.module);
	return new Transport(...(descriptor.options || []));
}

let controller;

/** @type {{ frame: Frame, element: HTMLIFrameElement, url: string }[]} */
const tabs = [];
let activeTab = null;

// hooks for the live reload client (/pm/dev.js, loaded by index.html under
// `npm run dev` only): it reloads the proxied frames when an inject bundle or
// the service worker is rebuilt, and needs to know which controller runs
if (CFG.dev)
	window.__stompDev = Object.assign(window.__stompDev || {}, {
		isolated: ISOLATED,
		tabs: () => tabs,
		reloadFrames: () => {
			for (const tab of tabs) tab.frame.reload();
			return tabs.length;
		},
	});

function setStatus(text, error = false) {
	// the landing line, the live bar and every card's copy of the bar
	const chips = document.querySelectorAll('.cardLabel .status');
	for (const node of [landingStatus, chromeStatus, ...chips]) {
		node.textContent = text;
		node.classList.toggle('error', error);
	}
}

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

/** resolve once the registration has an activated worker */
function activated(registration) {
	const worker =
		registration.active || registration.waiting || registration.installing;
	if (!worker) throw new Error('No service worker in registration');
	if (worker.state === 'activated') return Promise.resolve(worker);
	return new Promise((resolve, reject) => {
		worker.addEventListener('statechange', () => {
			if (worker.state === 'activated') resolve(worker);
			else if (worker.state === 'redundant')
				reject(new Error('Service worker became redundant'));
		});
	});
}

async function boot() {
	if (!('serviceWorker' in navigator))
		throw new Error('This browser does not support service workers.');

	const name = preferredTransport();
	rememberTransport(name);

	badge(
		'Mode',
		ISOLATED
			? `isolated: proxy on ${PROXY_ORIGIN}, host on ${location.origin}`
			: `same origin (${location.origin}); not a security boundary`,
		ISOLATED ? 'green' : 'orange',
	);
	badge('Transport', `${name} over ${wisp}`);

	if (ISOLATED) {
		setStatus('Starting controller frame…');
		controller = new StompRemoteController({
			proxyOrigin: PROXY_ORIGIN,
			directory: DIRECTORY,
			transport: transports[name](),
			codec: 'xor',
			cache: CACHE,
			// every proxied request, for the request viewer
			onRequest: recordRequest,
			// a page's window.open / target=_blank becomes a tab here, never a
			// bare proxied popup (the page sees null, like a popup blocker)
			onOpen: (url) => navigate(url, { newTab: true }),
			// the page reports its URL and title as they change
			onNavigate: (info, frame) => {
				const tab = tabs.find((t) => t.frame === frame);
				if (!tab) return;
				tab.url = info.url;
				recordUrl(tab);
				if (tab === activeTab) syncOmnibox();
			},
		});
	} else {
		setStatus('Registering service worker…');
		const registration = await navigator.serviceWorker.register(
			`${DIRECTORY}serviceWorker.js`,
			{ scope: DIRECTORY, updateViaCache: 'none' },
		);
		const serviceworker = await activated(registration);
		setStatus(`Loading ${name} transport…`);
		controller = new StompController({
			serviceworker,
			transport: await instantiate(transports[name]()),
			directory: DIRECTORY,
			codec: 'xor',
			cache: CACHE,
			// every proxied request, for the request viewer
			onRequest: recordRequest,
			// a page's window.open / target=_blank becomes a tab here, never a
			// bare proxied popup (the page sees null, like a popup blocker)
			onOpen: (url) => navigate(url, { newTab: true }),
			// the page reports its URL and title as they change
			onNavigate: (info, frame) => {
				const tab = tabs.find((t) => t.frame === frame);
				if (!tab) return;
				tab.url = info.url;
				recordUrl(tab);
				if (tab === activeTab) syncOmnibox();
			},
		});
	}
	window.controller = controller; // handy from devtools

	setStatus('Waiting for the service worker…');
	await controller.wait();
	// a deploy can leave an older service worker in charge for a moment: the
	// controller keeps working on it and rebinds when the new one activates
	if (typeof controller.addEventListener === 'function') {
		// RemoteController does not surface these yet; its controller frame
		// heals and rebinds on its own
		controller.addEventListener('stale', () =>
			setStatus('Ready (service worker updating)'),
		);
		controller.addEventListener('rebind', () => setStatus('Ready'));
	}
	setStatus(controller.stale ? 'Ready (service worker updating)' : 'Ready');
	badge('Controller', `ready, codec ${controller.config.codec}`, 'green');
}

async function switchTransport(name) {
	rememberTransport(name);
	setStatus(`Switching to ${name}…`);
	try {
		const descriptor = transports[name]();
		await controller.setTransport(
			ISOLATED ? descriptor : await instantiate(descriptor),
		);
		setStatus('Ready');
		badge('Transport', `${name} over ${wisp}`);
	} catch (error) {
		setStatus(`Transport failed: ${error.message}`, true);
	}
}

// ---- tabs -----------------------------------------------------------------

function createTab() {
	const element = document.createElement('iframe');
	element.className = 'frame hidden';
	element.title = 'Proxied page';
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
	};
	element.addEventListener('load', async () => {
		// a RemoteFrame's url is polled: refresh before recording, or a redirect
		// leaves both the requested and the final URL in the list
		if (frame.refresh) await frame.refresh();
		recordUrl(tab);
		if (tab === activeTab) {
			setStatus(frame.url ? 'Ready' : 'Loaded');
			syncOmnibox();
		}
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
	hideRecents(tab); // animates the card back to full screen if the manager is open
	syncOmnibox(true);
}

function closeTab(tab, { stayInRecents = false } = {}) {
	const index = tabs.indexOf(tab);
	if (index === -1) return;
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
		// fade out as the card is pushed up
		element.style.opacity = lift
			? String(Math.max(0, 1 - Math.abs(lift) / h))
			: '';

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
			label.style.opacity = lift ? '0' : i === recentsIndex ? '1' : '0.6';
			label.classList.toggle(
				'dragging',
				!animated && (recentsDrag !== 0 || lift !== 0),
			);
		}
	});
	void h;
	recentsCardWidth = w + gap;

	recentsCount.textContent = `${tabs.length} active tab${tabs.length === 1 ? '' : 's'}`;
}

// one label element per tab, kept across renders so it can transition in
// step with its frame (rebuilding labels made them jump into place)
const labelFor = new Map();

function createLabel(tab) {
	const label = document.createElement('div');
	label.className = 'cardLabel';

	const hit = document.createElement('div');
	hit.className = 'hit';

	// a copy of the chrome bar, built from the same classes so it renders
	// exactly like the real one it will land on: the address box shows the
	// tab's URL, the chip the same service worker status as the live bar
	const chrome = document.createElement('div');
	chrome.className = 'cardChrome';
	const url = document.createElement('div');
	url.className = 'form-text omnibox url';
	const status = document.createElement('span');
	status.className = 'select status';
	status.textContent = chromeStatus.textContent;
	status.classList.toggle('error', chromeStatus.classList.contains('error'));
	chrome.append(url, status);

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
		// labels show where the frame actually is, redirects included
		tab.url = tab.frame.url || tab.url;

		let label = labelFor.get(tab);
		if (!label) {
			label = createLabel(tab);
			labelFor.set(tab, label);
			recentsLabels.append(label);
		}
		label.querySelector('.url').textContent = tab.url || '';
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
	for (const tab of tabs) {
		tab.element.style.cssText = '';
		tab.element.classList.remove('shade', 'dragging');
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
	// controls fade with the card. The dock is pinned solid while the manager
	// was entered from home (it slid out of the tiles); unpin it here, or it
	// stays put and vanishes when the stage goes instead of fading
	document.body.classList.remove('recents-visible', 'recents-from-home');
	// the labels container stays solid: the expanding card's bar copy is what
	// the user sees until the real bar takes over at teardown
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
		// the bar copy lands on the real bar: show what the real bar will show
		label.querySelector('.url').textContent = omni.url.value;
		label.style.transform = 'translate(0px, 0px) scale(1)';
		label.style.borderRadius = '0px';
		label.style.setProperty('--k', '1');
		label.style.opacity = '1';
	}
	// the other cards fade out underneath
	for (const tab of tabs) if (tab !== expand) tab.element.style.opacity = '0';
	for (const other of labelFor.values())
		if (other !== label) other.style.opacity = '0';

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
		if (event.target.closest('.close')) return; // a button, not a gesture
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
	tab.url = url;
	omni.url.value = url;
	setStatus('Loading…');
	try {
		await tab.frame.go(url);
		history.replaceState(null, '', `#${encodeURIComponent(url)}`);
	} catch (error) {
		setStatus(`Error: ${error.message}`, true);
	}
}

// keep the omnibox and hash in sync with the active tab (pushState included)
function syncOmnibox(force = false) {
	if (!activeTab || browser.classList.contains('hidden')) return;
	const url = activeTab.frame.url || activeTab.url;
	if (!url) return;
	activeTab.url = url;
	recordUrl(activeTab);
	if (!force && document.activeElement === omni.url) return;
	if (omni.url.value !== url) omni.url.value = url;
	const hash = `#${encodeURIComponent(url)}`;
	if (location.hash !== hash) history.replaceState(null, '', hash);
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
				await fetch(`/suggestions?input=${encodeURIComponent(value)}`)
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
		$('version').textContent = `stomp ${version}`;
		if (!loggedVersion) {
			loggedVersion = true;
			badge('Stomp', `${version}, up ${Math.floor(uptime / 3600)}h`);
		}
	} catch {
		uptimeAt = null;
		$('uptime').textContent = 'unavailable';
	}
}
pollStatus();
setInterval(pollStatus, 10000);
setInterval(renderUptime, 1000);

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
	// the document request itself arrives before the page has a client id
	// (frame null): nothing to attribute it to
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
		head.className = 'head';
		head.textContent = rest.slice(0, cut);
		const tail = document.createElement('span');
		tail.className = 'tail';
		tail.textContent = rest.slice(cut);
		path.append(head, tail);
		url.append(host, path);
	} else url.textContent = info.url;
	if (info.error) {
		const error = document.createElement('span');
		error.className = 'error';
		error.textContent = info.error;
		url.append(error);
	}
	cell('dest', info.destination || 'fetch');
	cell('ms', `${Math.round(info.ms)} ms`);
	cell('size', formatBytes(info.bytes));
	cell('tag', info.cached ? 'cached' : '');
	return row;
}

function renderRequestCounts(log) {
	const total = log ? log.total : 0;
	requestsCount.textContent = `${total} request${total === 1 ? '' : 's'} · ${
		log ? log.cached : 0
	} cached · ${log ? log.failed : 0} failed`;
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

// Ctrl+Shift+R toggles the viewer (key events inside a proxied frame never
// reach this window); Escape closes it before anything else sees the key
addEventListener(
	'keydown',
	(event) => {
		if (
			event.ctrlKey &&
			event.shiftKey &&
			!event.altKey &&
			event.code === 'KeyR'
		) {
			event.preventDefault(); // Chrome's hard reload
			toggleRequests();
		} else if (event.key === 'Escape' && requestsOpen()) {
			hideRequests();
			event.stopImmediatePropagation();
		}
	},
	true,
);

const booted = boot();
booted
	.then(() => {
		// restore a proxied URL from the fragment after a refresh
		const restore = decodeURIComponent(location.hash.slice(1));
		if (restore) navigate(restore, { newTab: true });
		else mainForm.url.focus();
	})
	.catch((error) => {
		badge('Error', error.message, 'red');
		console.error(error);
		setStatus(`Error: ${error.message}`, true);
	});
