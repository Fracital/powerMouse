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

const wisp = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;

const transports = {
	async epoxy() {
		const { default: EpoxyTransport } = await import('/epoxy/index.mjs');
		return new EpoxyTransport({ wisp });
	},
	async libcurl() {
		const { default: LibcurlTransport } = await import('/libcurl/index.mjs');
		// libcurl.js 0.7's default pool (50 total, 6 per host) deadlocks once a
		// page fans out more requests than that; see CHANGELOG known limitations
		return new LibcurlTransport({ wisp, connections: [500, 400, 200] });
	},
};

let controller;

/** @type {{ frame: Frame, element: HTMLIFrameElement, url: string }[]} */
const tabs = [];
let activeTab = null;

function setStatus(text, error = false) {
	for (const node of [landingStatus, chromeStatus]) {
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

	setStatus('Registering service worker…');
	const registration = await navigator.serviceWorker.register(
		`${DIRECTORY}serviceWorker.js`,
		{ scope: DIRECTORY, updateViaCache: 'none' },
	);
	const serviceworker = await activated(registration);

	const name = preferredTransport();
	rememberTransport(name);
	setStatus(`Loading ${name} transport…`);
	const transport = await transports[name]();

	controller = new StompController({
		serviceworker,
		transport,
		directory: DIRECTORY,
		codec: 'xor',
	});
	window.controller = controller; // handy from devtools

	setStatus('Waiting for the service worker…');
	await controller.wait();
	setStatus('Ready');
}

async function switchTransport(name) {
	rememberTransport(name);
	setStatus(`Switching to ${name}…`);
	try {
		controller.setTransport(await transports[name]());
		setStatus('Ready');
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
	// Each tab keeps its own history. The frame's history.back() walks the
	// shared session history, so with nothing left to go back to it would back
	// the whole demo page out of the site; the counters below stop that.
	const tab = {
		frame,
		element,
		url: '',
		history: [],
		index: -1,
		traversal: null,
	};
	element.addEventListener('load', () => {
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
function recordUrl(tab) {
	const url = tab.frame.url;
	if (!url || url === tab.history[tab.index]) return;
	if (tab.traversal) {
		tab.traversal = null;
		return;
	}
	tab.history.length = tab.index + 1;
	tab.history.push(url);
	tab.index = tab.history.length - 1;
}

function canGoBack(tab) {
	return !!tab && tab.index > 0;
}

function canGoForward(tab) {
	return !!tab && tab.index < tab.history.length - 1;
}

function goBack(tab) {
	if (!canGoBack(tab)) return false;
	tab.traversal = 'back';
	tab.index--;
	tab.frame.back();
	return true;
}

function goForward(tab) {
	if (!canGoForward(tab)) return false;
	tab.traversal = 'forward';
	tab.index++;
	tab.frame.forward();
	return true;
}

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

function showLanding() {
	const dockRects = document.body.classList.contains('recents')
		? rectsOf(dockButtons)
		: null;
	browser.classList.add('hidden');
	landing.classList.remove('hidden');
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

function layoutRecents(animated = false) {
	const vw = innerWidth;
	const vh = innerHeight - 48; // navigation bar
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
		const transform = `translate(${x}px, ${y0 + lift}px) scale(${k})`;
		// the radius is applied before the scale, so express it in page pixels
		const radius = `${18 / k}px`;
		const { element } = tab;
		element.style.width = `${vw}px`;
		element.style.height = `${vh}px`;
		element.style.transform = transform;
		element.style.borderRadius = radius;
		element.style.clipPath = `inset(0 round ${radius})`;
		element.classList.toggle('shade', i !== recentsIndex);
		element.classList.toggle(
			'dragging',
			!animated && (recentsDrag !== 0 || lift !== 0),
		);
		// fade out as the card is pushed up
		element.style.opacity = lift
			? String(Math.max(0, 1 - Math.abs(lift) / h))
			: '';

		// the label is a full-size overlay with the very same transform, so it
		// can never fall out of step with the frame while animating
		const label = recentsLabels.children[i];
		if (label) {
			label.style.width = `${vw}px`;
			label.style.height = `${vh}px`;
			label.style.transform = transform;
			label.style.borderRadius = radius;
			label.style.setProperty('--k', String(k));
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

function renderRecents(fromFullScreen = false) {
	recentsLabels.textContent = '';

	tabs.forEach((tab, i) => {
		// labels show where the frame actually is, redirects included
		tab.url = tab.frame.url || tab.url;

		const label = document.createElement('div');
		label.className = 'cardLabel';

		const hit = document.createElement('div');
		hit.className = 'hit';
		hit.title = tabTitle(tab);

		const title = document.createElement('span');
		title.className = 'title';
		title.textContent = tabTitle(tab);

		const close = document.createElement('button');
		close.className = 'close';
		close.title = 'Close tab';
		close.setAttribute('aria-label', 'Close tab');
		close.textContent = '×';
		close.addEventListener('click', (event) => {
			event.stopPropagation();
			closeTab(tab, { stayInRecents: true });
		});

		label.append(hit, title, close);
		label.addEventListener('click', () => {
			if (recentsSwiped) return;
			if (i === recentsIndex) activateTab(tab);
			else {
				recentsIndex = i;
				layoutRecents();
			}
		});
		recentsLabels.append(label);
	});

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
		tabs.forEach((tab, i) => {
			const label = recentsLabels.children[i];
			label.style.width = `${vw}px`;
			label.style.height = `${vh}px`;
			label.style.transform = 'translate(0px, 0px) scale(1)';
			label.style.setProperty('--k', '1');
			label.style.opacity = tab === activeTab ? '1' : '0';
			if (tab !== activeTab) tab.element.style.opacity = '0';
		});
		void recentsLabels.offsetHeight; // flush, so the next layout transitions
	}

	layoutRecents();
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
	document.body.classList.remove('recents-visible'); // controls fade with the card
	const i = tabs.indexOf(expand);
	const label = recentsLabels.children[i];
	expand.element.classList.remove('shade', 'dragging');
	expand.element.style.opacity = '1';
	expand.element.style.transform = 'translate(0px, 0px) scale(1)';
	expand.element.style.borderRadius = '0px';
	expand.element.style.clipPath = 'inset(0 round 0px)';
	if (label) {
		label.classList.remove('dragging');
		label.style.transform = 'translate(0px, 0px) scale(1)';
		label.style.borderRadius = '0px';
		label.style.setProperty('--k', '1');
		label.style.opacity = '0';
	}
	// the other cards fade out underneath
	for (const tab of tabs) if (tab !== expand) tab.element.style.opacity = '0';
	for (const other of recentsLabels.children)
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
			? tabs[[...recentsLabels.children].indexOf(label)] || null
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
	if (!controller) return;
	const url = SEARCH.query(input.trim());
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
setInterval(() => syncOmnibox(), 500);

// TLD autocomplete under the address bars, as in Powermouse: every keystroke
// asks /suggestions for suffixes close to what was typed after the last dot,
// and clicking one swaps the typed suffix for it.
function attachSuggestions(input) {
	const container = input.parentElement;
	const TLD = /\.[^./?#\s]{1,16}(?:\.[^./?#\s]{1,16})?(?=$|\/)/i;
	let request = 0;

	const clear = () => {
		for (const node of container.querySelectorAll('.auto-fill')) node.remove();
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
			container.append(suggestion);
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
$('back').addEventListener('click', () => {
	if (!recentsPanel.classList.contains('hidden')) {
		leaveRecents();
	} else if (browser.classList.contains('hidden') && activeTab)
		activateTab(activeTab);
	else if (!goBack(activeTab)) showLanding(); // nothing to go back to: home, like Android
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
	elements.forEach((el, i) => {
		const from = fromRects[i];
		const to = el.getBoundingClientRect();
		if (!from || !from.width || !to.width) return;
		el.style.transition = 'none';
		el.style.transformOrigin = 'top left';
		el.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
	});
	void document.body.offsetHeight; // flush the start state
	for (const el of elements) {
		if (!el.style.transform) continue;
		el.style.transition = 'transform 0.25s ease';
		el.style.transform = '';
		el.addEventListener(
			'transitionend',
			() => {
				el.style.transition = '';
				el.style.transformOrigin = '';
			},
			{ once: true },
		);
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

// server status line: uptime + version
async function pollStatus() {
	try {
		const { uptime, version } = await (await fetch('/api/status')).json();
		const h = Math.floor(uptime / 3600);
		const m = Math.floor((uptime % 3600) / 60);
		const s = Math.floor(uptime % 60);
		$('uptime').textContent = `${h} hours, ${m} minutes, ${s} seconds`;
		$('version').textContent = `stomp ${version}`;
	} catch {
		$('uptime').textContent = 'unavailable';
	}
}
pollStatus();
setInterval(pollStatus, 10000);

boot()
	.then(() => {
		// restore a proxied URL from the fragment after a refresh
		const restore = decodeURIComponent(location.hash.slice(1));
		if (restore) navigate(restore, { newTab: true });
		else mainForm.url.focus();
	})
	.catch((error) => {
		console.error(error);
		setStatus(`Error: ${error.message}`, true);
	});
