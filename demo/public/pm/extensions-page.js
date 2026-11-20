// The Extensions page of the settings dialog (#shieldsPage, view
// 'extensions'), after Chrome 157's chrome://extensions
// (chrome/browser/resources/extensions/): the cards with the search and
// Developer mode, an extension's details, its errors, the keyboard
// shortcuts of every extension's commands, and Pack extension. A classic
// script loaded before pm/main.js: its functions use main.js's globals
// (shieldsPage, element, extApi, extInstalled, syncExtensions, ...) only
// when they run, once main.js has made them. main.js calls
// buildExtensionsPage when the dialog opens on this view,
// renderExtensionsPage after each read of the extensions, and
// openExtensionsPage from the main menu, the puzzle piece's list and an
// extension's menu (Manage extension, View web permissions). The shortcuts
// themselves fire from main.js (setExtShortcuts), from what
// extensions.commands() says.
//
// Left out, as this browser has no such thing: Allow in Incognito (no
// incognito window), Allow access to file URLs (STomp loads no file: URL),
// Site settings (no per-origin settings page for an extension), View in
// DevTools and the errors' code view (no developer tools; the host page
// cannot read the extension's files), the Safety Check panel.

/** what the page shows: the view, its extension, the search and the developer mode */
const XP = {
	/** 'list', 'details', 'errors', 'shortcuts' or 'pack' */
	view: 'list',
	id: null,
	query: '',
	dev: false,
	/** the theme shown (extensions.theme()), for the Theme row */
	theme: null,
	/** extensions.views(id) and errors(id) by extension, commands(), as last read */
	views: new Map(),
	errors: new Map(),
	commands: null,
	/** the error the Errors view shows open (its id; the first by default) */
	openError: undefined,
	/** `<id>|<command>` of the shortcut being typed */
	editing: null,
	/** what each shortcut field said last (its validation message) */
	shortcutNote: new Map(),
	/** the details' row to scroll to once drawn ('permissions') */
	scrollTo: null,
	sideOpen: false,
	reads: 0,
};

const XP_DEV_KEY = 'pm:extensions-dev-mode';
const XP_STORE_LINK = 'https://chromewebstore.google.com/category/extensions';
/** Chrome's _execute_* commands click the action ("Activate the extension") */
const xpExecute = (name) => /^_execute_(page_|browser_)?action$/.test(name);

try {
	XP.dev = localStorage.getItem(XP_DEV_KEY) === '1';
} catch {
	// no storage: Developer mode starts off
}

const XP_ICONS = {
	menu: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 7h16M4 12h16M4 17h16"/>',
	search:
		'<circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m15 15 5 5"/>',
	reload:
		'<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4"/>',
	back: '<path fill="currentColor" fill-rule="evenodd" d="M6.701 11.167h11.466a.833.833 0 0 1 0 1.666H6.7l5.656 5.221a.833.833 0 0 1-1.13 1.225l-6.78-6.258a1.39 1.39 0 0 1 0-2.042l6.78-6.258a.833.833 0 1 1 1.13 1.225z" clip-rule="evenodd"/>',
	open: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
	next: '<path fill="currentColor" fill-rule="evenodd" d="M15.316 11.434a.8.8 0 0 1 0 1.132l-5.5 5.5a.8.8 0 1 1-1.132-1.132L13.62 12 8.684 7.066a.8.8 0 1 1 1.132-1.132z" clip-rule="evenodd"/>',
	more: '<path fill="currentColor" fill-rule="evenodd" d="M12.566 15.316a.8.8 0 0 1-1.132 0l-5.5-5.5a.8.8 0 1 1 1.132-1.132L12 13.62l4.934-4.935a.8.8 0 1 1 1.132 1.132z" clip-rule="evenodd"/>',
	edit: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
	trash:
		'<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
	clear:
		'<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m7 7 10 10M17 7 7 17"/>',
	error:
		'<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m9 9 6 6m0-6-6 6"/>',
	warn: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M12 3.5 21.5 20h-19z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 10v4.5"/><circle cx="12" cy="17.25" r="1.1" fill="currentColor"/>',
	log: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 11v5.5"/><circle cx="12" cy="7.75" r="1.15" fill="currentColor"/>',
};

function xpIcon(name, className = 'shieldsIcon') {
	return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${XP_ICONS[name] ?? ''}</svg>`;
}

/** a button with an icon only */
function xpIconButton(icon, label, control) {
	const button = element('button', 'xpIconBtn');
	button.type = 'button';
	button.innerHTML = xpIcon(icon);
	button.setAttribute('aria-label', label);
	button.title = label;
	if (control) button.dataset.control = control;
	return button;
}

function xpButton(label, control, run, kind = 'ghost') {
	const button = element('button', `spBtn ${kind}`.trim(), label);
	button.type = 'button';
	button.dataset.control = control;
	button.addEventListener('click', run);
	return button;
}

const xpInfo = (id) => extInstalled.find((info) => info.id === id) ?? null;
const xpOpen = () =>
	shieldsPageOpen() && shieldsPage.dataset.view === 'extensions';
const xpPart = (selector) => shieldsPage.querySelector(selector);
const xpControl = (control) =>
	xpPart(`[data-control="${CSS.escape(control)}"]`);
/** a URL of the extension as Chrome writes it, relative to chrome-extension://<id>/ */
const xpRelative = (url, id) =>
	String(url ?? '').replace(`chrome-extension://${id}/`, '');

/** go to a page in a new tab, the dialog closed */
function xpVisit(url) {
	closeShieldsPage();
	navigate(url, { newTab: true });
}

/**
 * The Extensions page: an extension's details for `focus` (scrolled to its
 * permissions for `permissions`), its errors (`errors`), its removal asked
 * (`remove`), or the shortcuts (`view: 'shortcuts'`)
 */
function openExtensionsPage(ask = null) {
	XP.view = 'list';
	XP.id = null;
	XP.editing = null;
	XP.openError = undefined;
	XP.scrollTo = null;
	if (ask?.focus) [XP.view, XP.id] = ['details', ask.focus];
	else if (ask?.errors) [XP.view, XP.id] = ['errors', ask.errors];
	else if (ask?.view === 'shortcuts') XP.view = 'shortcuts';
	if (ask?.permissions) XP.scrollTo = 'permissions';
	openShieldsPage('extensions');
	xpScrollTo();
	if (XP.view !== 'list')
		xpPart('#xpSubView .xpBack, #xpSubView button, #xpSubView input')?.focus();
	if (ask?.remove) {
		const info = xpInfo(ask.remove);
		if (info) xpRemove(info);
	}
}

function buildExtensionsPage() {
	shieldsPage.dataset.view = 'extensions';
	shieldsPage.innerHTML = `
		<div class="spHead xpHead">
			<button class="xpIconBtn xpMenuBtn" id="xpMenu" type="button" aria-label="Main menu" title="Main menu" aria-expanded="false" aria-controls="xpSide">${xpIcon('menu')}</button>
			<h2 class="spTitle" id="shieldsPageTitle">Extensions</h2>
			<label class="xpSearch">
				${xpIcon('search')}
				<input class="spInput" id="xpSearch" type="search" spellcheck="false" autocomplete="off" placeholder="Search extensions" aria-label="Search extensions" />
			</label>
			<label class="xpDevToggle">
				<span>Developer mode</span>
				<input type="checkbox" class="shieldsToggle small" id="xpDevMode" />
			</label>
			<button class="spClose" id="spClose" type="button" aria-label="Close">×</button>
		</div>
		<div class="xpDevBar" id="xpDevBar">
			<button class="spBtn ghost" id="xpLoadUnpacked" type="button">Load unpacked</button>
			<button class="spBtn ghost" id="xpPack" type="button">Pack extension</button>
			<button class="spBtn ghost" id="xpUpdate" type="button" title="Update extensions now">Update</button>
		</div>
		<div class="xpFrame">
			<nav class="xpSide" id="xpSide" aria-label="Extensions">
				<button class="xpNav" type="button" data-nav="list">My extensions</button>
				<button class="xpNav" type="button" data-nav="shortcuts">Keyboard shortcuts</button>
				<p class="spSectionNote xpStoreNote">Discover more extensions and themes on the <a class="xpLink" id="xpStoreLink" href="${XP_STORE_LINK}" target="_blank">Chrome Web Store</a></p>
			</nav>
			<div class="spBody xpMain" id="xpMain">
				<div id="xpListView">
					<section class="spSection xpAdd">
						<h3 class="spSectionTitle">Add an extension</h3>
						<p class="spSectionNote">From the Chrome Web Store (the extension's page or its id), a .crx or .zip file, or an unpacked extension's folder. An extension runs on the sites you visit here, with the permissions it asks for.</p>
						<form class="spAddRow" id="spExtStoreForm" autocomplete="off">
							<input class="spInput" id="spExtStore" type="text" spellcheck="false" placeholder="Web Store address or extension id" aria-label="Chrome Web Store address or extension id" />
							<button class="spBtn" id="spExtAdd" type="submit">Add</button>
						</form>
						<div class="spRowButtons">
							<button class="spBtn ghost" id="spExtFile" type="button">Add a file</button>
							<button class="spBtn ghost" id="spExtFolder" type="button">Load a folder</button>
						</div>
						<input id="spExtFileInput" type="file" accept=".crx,.zip" hidden />
						<input id="spExtFolderInput" type="file" webkitdirectory hidden />
					</section>
					<section class="spSection xpItems">
						<h3 class="spSectionTitle" id="xpItemsTitle">All Extensions</h3>
						<div class="extList xpGrid" id="spExtList" aria-busy="true" aria-labelledby="xpItemsTitle"></div>
					</section>
					<div id="xpTheme"></div>
				</div>
				<div id="xpSubView" hidden></div>
				<input id="xpPackFolder" type="file" webkitdirectory hidden />
				<input id="xpPackKey" type="file" accept=".pem" hidden />
				<div class="spStatus" id="spStatus" aria-live="polite"></div>
			</div>
		</div>`;
	xpPart('#spClose').addEventListener('click', closeShieldsPage);
	const search = xpPart('#xpSearch');
	search.value = XP.query;
	// (typing in the search from another view goes back to the list, as Chrome's)
	search.addEventListener('input', () => {
		XP.query = search.value;
		if (XP.view !== 'list') xpGo('list', null, false);
		else xpRender({ more: false });
	});
	const dev = xpPart('#xpDevMode');
	dev.checked = XP.dev;
	dev.addEventListener('change', () => xpSetDev(dev.checked));
	xpPart('#xpMenu').addEventListener('click', () => {
		XP.sideOpen = !XP.sideOpen;
		xpRender({ more: false });
		if (XP.sideOpen) xpPart('#xpSide .xpNav')?.focus();
	});
	for (const nav of shieldsPage.querySelectorAll('[data-nav]'))
		nav.addEventListener('click', () => {
			XP.sideOpen = false;
			xpGo(nav.dataset.nav, null);
		});
	xpPart('#xpStoreLink').addEventListener('click', (event) => {
		event.preventDefault();
		xpVisit(XP_STORE_LINK);
	});
	xpPart('#spExtStoreForm').addEventListener('submit', (event) => {
		event.preventDefault();
		const value = xpPart('#spExtStore').value.trim();
		if (!value) return;
		installExtension(value, 'from the Chrome Web Store').then((info) => {
			if (info) xpPart('#spExtStore').value = '';
		});
	});
	const file = xpPart('#spExtFileInput');
	const folder = xpPart('#spExtFolderInput');
	let fromToolbar = false;
	xpPart('#spExtFile').addEventListener('click', () => file.click());
	xpPart('#spExtFolder').addEventListener('click', () => {
		fromToolbar = false;
		folder.click();
	});
	xpPart('#xpLoadUnpacked').addEventListener('click', () => {
		fromToolbar = true;
		folder.click();
	});
	file.addEventListener('change', () => {
		const chosen = file.files[0];
		if (chosen)
			installExtension(chosen, chosen.name, { filename: chosen.name });
		file.value = '';
	});
	folder.addEventListener('change', () => {
		const files = folder.files;
		if (files.length) installExtension(files, 'the folder', {}, fromToolbar);
		folder.value = '';
	});
	xpPart('#xpPack').addEventListener('click', () => xpGo('pack', null));
	xpPart('#xpUpdate').addEventListener('click', xpUpdateAll);
	xpRender();
	xpReadTheme();
	syncExtensions();
}

/** what main.js redraws after each read of the extensions */
function renderExtensionsPage() {
	if (!xpOpen()) return;
	xpRender();
	xpReadTheme();
}

/** another view of the page (and what it reads), the focus on its first control */
function xpGo(view, id = XP.id, focus = true) {
	XP.view = view;
	XP.id = id;
	XP.editing = null;
	XP.openError = undefined;
	XP.scrollTo = null;
	xpRender();
	xpPart('#xpMain').scrollTop = 0;
	if (!focus) return;
	xpPart(
		view === 'list'
			? '#xpSearch'
			: '#xpSubView .xpBack, #xpSubView button, #xpSubView input',
	)?.focus();
}

function xpSetDev(on) {
	XP.dev = on;
	try {
		localStorage.setItem(XP_DEV_KEY, on ? '1' : '0');
	} catch {
		// kept for this page only
	}
	extApi()?.setDeveloperMode?.(on);
	// (Chrome's errors and pack views leave with the developer mode)
	if (!on && ['errors', 'pack'].includes(XP.view)) XP.view = 'list';
	if (!on) XP.errors.clear();
	xpRender();
	syncExtensions();
}

let xpThemeRead = 0;
async function xpReadTheme() {
	const api = extApi();
	if (!api?.theme) return;
	const read = ++xpThemeRead;
	let theme = null;
	try {
		theme = await api.theme();
	} catch {
		// no theme row
	}
	if (read !== xpThemeRead) return;
	const before = XP.theme?.extensionId ?? null;
	XP.theme = theme;
	if ((theme?.extensionId ?? null) !== before && xpOpen()) xpRenderTheme();
}

/** read what the view shows beyond the list (views, errors, commands), then redraw */
async function xpReadMore() {
	const api = extApi();
	if (!api) return;
	const read = ++XP.reads;
	const { view, id } = XP;
	const wants = [];
	const views = (of) =>
		api.views &&
		wants.push(api.views(of).then((list) => XP.views.set(of, list)));
	const errors = (of) =>
		api.errors &&
		wants.push(api.errors(of).then((list) => XP.errors.set(of, list)));
	if (XP.dev && view === 'list')
		for (const info of extInstalled) {
			views(info.id);
			if (info.errorCount) errors(info.id);
			else XP.errors.set(info.id, []);
		}
	if (XP.dev && view === 'details' && id) views(id);
	if (view === 'errors' && id) errors(id);
	if (view === 'shortcuts' && api.commands)
		wants.push(api.commands().then((list) => (XP.commands = list)));
	if (!wants.length) return;
	const before = xpMoreKey();
	await Promise.allSettled(wants);
	if (read !== XP.reads || !xpOpen()) return;
	if (xpMoreKey() !== before) xpRender({ more: false });
}

const xpMoreKey = () =>
	JSON.stringify([
		[...XP.views],
		[...XP.errors].map(([id, errors]) => [
			id,
			errors.map((error) => [error.id, error.occurrences]),
		]),
		XP.commands,
	]);

/** draw the page as XP says, the focus kept on the control it was on */
function xpRender({ more = true } = {}) {
	// (built before the dialog shows: drawn then too)
	if (shieldsPage.dataset.view !== 'extensions') return;
	const active = document.activeElement;
	const focused = shieldsPage.contains(active)
		? active.dataset.control
			? ['control', active.dataset.control]
			: active.id
				? ['id', active.id]
				: null
		: null;
	if (XP.id && !xpInfo(XP.id) && ['details', 'errors'].includes(XP.view)) {
		XP.view = 'list';
		XP.id = null;
	}
	shieldsPage.classList.toggle('xpDev', XP.dev);
	shieldsPage.classList.toggle('xpSideOpen', XP.sideOpen);
	xpPart('#xpMenu').setAttribute('aria-expanded', String(XP.sideOpen));
	xpPart('#xpDevMode').checked = XP.dev;
	xpPart('#xpDevBar').hidden = !XP.dev;
	for (const nav of shieldsPage.querySelectorAll('[data-nav]')) {
		const on =
			nav.dataset.nav === (XP.view === 'shortcuts' ? 'shortcuts' : 'list');
		if (on) nav.setAttribute('aria-current', 'page');
		else nav.removeAttribute('aria-current');
	}
	const listed = XP.view === 'list';
	xpPart('#xpListView').hidden = !listed;
	xpPart('#xpSubView').hidden = listed;
	if (listed) {
		xpRenderList();
		xpRenderTheme();
	} else
		({
			details: xpRenderDetails,
			errors: xpRenderErrors,
			shortcuts: xpRenderShortcuts,
			pack: xpRenderPack,
		})[XP.view]?.(xpPart('#xpSubView'));
	if (focused) {
		const again =
			focused[0] === 'control'
				? xpControl(focused[1])
				: shieldsPage.querySelector(`#${CSS.escape(focused[1])}`);
		if (again && again !== document.activeElement) again.focus();
	}
	if (xpOpen()) xpScrollTo();
	if (more) xpReadMore();
}

/** the details' row asked for (View web permissions: its permissions), at the top */
function xpScrollTo() {
	if (!XP.scrollTo || XP.view !== 'details') return;
	const row = xpPart(`[data-row="${XP.scrollTo}"]`);
	if (!row) return;
	XP.scrollTo = null;
	const main = xpPart('#xpMain');
	main.scrollTop +=
		row.getBoundingClientRect().top - main.getBoundingClientRect().top;
}

/** Chrome's order: unpacked first, then by name, then by id */
function xpSorted(list) {
	return [...list].sort(
		(a, b) =>
			(b.source === 'unpacked') - (a.source === 'unpacked') ||
			a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
			a.id.localeCompare(b.id),
	);
}

/** the extensions the search finds (Chrome matches the name or the id) */
function xpFound(list = extInstalled) {
	const query = XP.query.trim().toLowerCase();
	return xpSorted(
		query
			? list.filter(
					(info) =>
						info.name.toLowerCase().includes(query) || info.id.includes(query),
				)
			: list,
	);
}

// ---- the list ---------------------------------------------------------------

function xpRenderList() {
	const list = xpPart('#spExtList');
	list.removeAttribute('aria-busy');
	list.replaceChildren();
	const found = xpFound();
	xpPart('#xpItemsTitle').hidden = !found.length;
	if (!extInstalled.length) {
		const none = element(
			'p',
			'spSectionNote xpEmpty',
			'Find extensions and themes in the ',
		);
		const link = element('a', 'xpLink', 'Chrome Web Store');
		link.href = XP_STORE_LINK;
		link.target = '_blank';
		link.addEventListener('click', (event) => {
			event.preventDefault();
			xpVisit(XP_STORE_LINK);
		});
		none.append(link);
		list.append(none);
		return;
	}
	if (!found.length) {
		list.append(
			element('p', 'spSectionNote xpEmpty', 'No search results found'),
		);
		return;
	}
	for (const info of found) list.append(xpCard(info));
}

/** the toggle that turns an extension on and off, on a card and in its details */
function xpToggle(info, control) {
	const toggle = element('input', 'shieldsToggle small');
	toggle.type = 'checkbox';
	toggle.checked = info.enabled;
	toggle.dataset.control = control;
	toggle.setAttribute(
		'aria-label',
		info.enabled ? 'On, extension enabled' : 'Off',
	);
	toggle.disabled = !!info.policy;
	toggle.addEventListener('change', async () => {
		const on = toggle.checked;
		try {
			await (on ? extApi().enable(info.id) : extApi().disable(info.id));
		} catch (error) {
			toggle.checked = !on;
			setShieldsPageStatus(error.message, true);
		}
		syncExtensions();
	});
	return toggle;
}

/** a reload button, for an unpacked extension that is on (Chrome's card and details) */
function xpReloadButton(info, control) {
	if (info.source !== 'unpacked' || !info.enabled) return null;
	const reload = xpIconButton('reload', 'Reload', control);
	reload.addEventListener('click', () => xpReload(info));
	return reload;
}

/** one extension's card: Chrome's extensions-item */
function xpCard(info) {
	const card = element('div', `extCard xpItem${info.enabled ? '' : ' off'}`);
	card.dataset.ext = info.id;
	const head = element('div', 'extCardHead');
	const icon = element('div', 'xpIconBox');
	icon.append(extIcon(info.name, info.iconUrl, 'extCardIcon'));
	const source = xpSourceBadge(info);
	if (source) icon.append(source);
	const text = element('div', 'spRowText');
	const name = element('div', 'spListName xpName', info.name);
	if (XP.dev)
		name.append(' ', element('span', 'spTag xpVersion', info.version));
	text.append(name);
	if (info.description)
		text.append(element('div', 'spListSource xpDescription', info.description));
	head.append(icon, text);
	card.append(head);
	if (XP.dev) {
		const id = element('div', 'spListSource xpId', `ID: ${info.id}`);
		id.dir = 'ltr';
		card.append(id);
		const views = info.enabled ? (XP.views.get(info.id) ?? []) : [];
		if (views.length) {
			const line = element('div', 'spListSource xpViews');
			line.append(element('span', 'xpViewsLabel', 'Inspect views'));
			const first = xpViewLink(info, views[0], `${info.id}:view:0`);
			line.append(first);
			if (views.length > 1) {
				first.after(',');
				const more = element('button', 'xpLink', `${views.length - 1} more...`);
				more.type = 'button';
				more.dataset.control = `${info.id}:views-more`;
				more.addEventListener('click', () => xpGo('details', info.id));
				line.append(more);
			}
			card.append(line);
		}
	}
	const buttons = element('div', 'spRowButtons xpItemButtons extButtons');
	buttons.append(
		xpButton('Details', `${info.id}:details`, () => xpGo('details', info.id)),
	);
	if (!info.policy)
		buttons.append(
			xpButton('Remove', `${info.id}:remove`, () => xpRemove(info)),
		);
	// (the console keeps errors in developer mode only)
	if (XP.dev && info.errorCount) {
		const errors = XP.errors.get(info.id);
		const runtime = errors
			? errors.some((error) => error.type === 'runtime')
			: true;
		const button = xpButton(
			runtime ? 'Errors' : 'Warnings',
			`${info.id}:errors`,
			() => xpGo('errors', info.id),
		);
		button.classList.add(runtime ? 'xpErrorsBtn' : 'xpWarningsBtn');
		buttons.append(button);
	}
	const end = element('div', 'xpItemEnd');
	const reload = xpReloadButton(info, `${info.id}:reload`);
	if (reload) end.append(reload);
	end.append(xpToggle(info, `${info.id}:toggle`));
	buttons.append(end);
	card.append(buttons);
	return card;
}

/** Chrome's badge on a card's icon, for policy, unpacked and not from the store */
function xpSourceBadge(info) {
	const label = info.policy
		? 'Added by policy'
		: info.source === 'unpacked'
			? 'Unpacked extension'
			: info.source === 'webstore'
				? null
				: 'Not from Chrome Web Store.';
	if (!label) return null;
	const mark = element('span', 'xpSourceBadge');
	mark.dataset.source = info.policy ? 'policy' : info.source;
	mark.title = label;
	mark.setAttribute('role', 'img');
	mark.setAttribute('aria-label', label);
	mark.innerHTML = xpIcon(info.source === 'unpacked' ? 'edit' : 'log');
	return mark;
}

/** Chrome's label of an inspectable view */
function xpViewLabel(info, view) {
	const label =
		view.kind === 'service_worker'
			? 'service worker'
			: view.kind === 'background'
				? 'background page'
				: xpRelative(view.displayUrl ?? view.url, info.id) || view.kind;
	return view.active === false ? `${label} (Inactive)` : label;
}

function xpViewLink(info, view, control) {
	const link = element('button', 'xpLink', xpViewLabel(info, view));
	link.type = 'button';
	link.dataset.control = control;
	link.addEventListener('click', () => xpInspect(info, view));
	return link;
}

/**
 * Chrome opens DevTools on a view; this browser has none, so a page opens
 * in a tab and a background shows the errors it reported
 */
function xpInspect(info, view) {
	if (['background', 'service_worker', 'offscreen'].includes(view.kind)) {
		xpGo('errors', info.id);
		setShieldsPageStatus(
			'There are no developer tools here: the Errors page lists what the extension reported.',
		);
		return;
	}
	xpVisit(view.displayUrl ?? view.url);
}

async function xpReload(info) {
	setShieldsPageStatus('Reloading...');
	try {
		await extApi().reload(info.id);
		setShieldsPageStatus('Reloaded');
	} catch (error) {
		setShieldsPageStatus(error.message, true);
	}
	syncExtensions();
}

/** Chrome's uninstall dialog ("Remove "<name>"?"), then the removal */
async function xpRemove(info) {
	const yes = await askExtension({
		kind: 'uninstall',
		name: info.name,
		iconUrl: info.iconUrl,
		permissions: [],
	});
	if (!yes) {
		xpControl(
			XP.view === 'details' ? `${info.id}:detail-remove` : `${info.id}:remove`,
		)?.focus();
		return false;
	}
	// the focus goes to the next card's Remove, as Chrome's
	const order = xpFound().map((other) => other.id);
	const next = order[order.indexOf(info.id) + 1] ?? order.at(-2);
	try {
		await extApi().remove(info.id);
		if (XP.id === info.id) xpGo('list', null, false);
	} catch (error) {
		setShieldsPageStatus(error.message, true);
	}
	await syncExtensions();
	if (next && next !== info.id && xpOpen())
		xpControl(`${next}:remove`)?.focus();
	return true;
}

/** the developer toolbar's Update: the Web Store's now, then each unpacked one reloaded */
async function xpUpdateAll() {
	const api = extApi();
	if (!api) return;
	setShieldsPageStatus('Updating...');
	const failed = [];
	for (const info of extInstalled.filter((info) => info.source === 'webstore'))
		try {
			await api.update(info.id);
		} catch (error) {
			if (error.code !== 'no-update')
				failed.push(`${info.name}: ${error.message}`);
		}
	for (const info of extInstalled.filter((info) => info.source === 'unpacked'))
		try {
			await api.reload(info.id);
		} catch (error) {
			// (Chrome stops at the first unpacked one that fails to load)
			failed.push(`${info.name}: ${error.message}`);
			break;
		}
	if (failed.length) setShieldsPageStatus(failed.join(' '), true);
	else setShieldsPageStatus('Extensions updated');
	syncExtensions();
}

async function installExtension(source, what, options = {}, unpacked = false) {
	setShieldsPageStatus(`Adding ${what}…`);
	try {
		const info = await extApi().install(source, options);
		setShieldsPageStatus(
			unpacked ? 'Extension loaded' : `Added ${info.name} ${info.version}.`,
		);
		await syncExtensions();
		return info;
	} catch (error) {
		setShieldsPageStatus(error.message, true);
		return null;
	}
}

/** the theme shown, which chrome://extensions does not list: a row to its picker */
function xpRenderTheme() {
	const box = xpPart('#xpTheme');
	if (!box) return;
	box.replaceChildren();
	const theme = XP.theme;
	if (!theme) return;
	const section = element('section', 'spSection xpThemeRow');
	section.dataset.theme = theme.extensionId ?? '';
	const row = element('div', 'spSettingRow');
	const text = element('div', 'spRowText');
	text.append(
		element('div', 'spRowLabel', 'Theme'),
		element('div', 'spRowSub', theme.name),
	);
	row.append(text);
	// the theme picker is in Settings (pm/theme.js, docs/themes.md)
	if (typeof buildSettingsPage === 'function')
		row.append(
			xpButton('Appearance settings', 'theme:appearance', () =>
				openShieldsPage('settings'),
			),
		);
	section.append(row);
	box.append(section);
}

// ---- details ----------------------------------------------------------------

/** a heading and a back arrow, for a view of one extension */
function xpSubHead(info, title, backTo = 'list') {
	const head = element('div', 'xpSubHead');
	const back = xpIconButton(
		'back',
		info && backTo === 'list'
			? `${info.name} details page back button`
			: 'Back',
		'xp:back',
	);
	back.classList.add('xpBack');
	back.addEventListener('click', () => {
		const from = XP.id;
		xpGo(backTo, backTo === 'list' ? null : from, false);
		const target =
			backTo === 'list' && from ? xpControl(`${from}:details`) : null;
		(target ?? xpPart('#xpSubView .xpBack') ?? xpPart('#xpSearch'))?.focus();
	});
	head.append(back);
	if (info)
		head.append(extIcon(info.name, info.iconUrl, 'extCardIcon xpSubIcon'));
	head.append(element('h3', 'spSectionTitle xpSubTitle', title));
	return head;
}

/** a row of the details: its title, then what it says */
function xpRow(title, ...content) {
	const row = element('div', 'spSettingRow xpDetailRow');
	const text = element('div', 'spRowText');
	text.append(element('div', 'spRowLabel', title));
	for (const part of content.filter(Boolean))
		text.append(
			typeof part === 'string' ? element('div', 'spRowSub', part) : part,
		);
	row.append(text);
	return row;
}

/** a row that is a toggle */
function xpToggleRow(title, sub, checked, control, change, disabled = false) {
	const row = element('div', 'spSettingRow xpDetailRow');
	const text = element('div', 'spRowText');
	text.append(element('div', 'spRowLabel', title));
	if (sub) text.append(element('div', 'spRowSub', sub));
	const toggle = element('input', 'shieldsToggle small');
	toggle.type = 'checkbox';
	toggle.checked = checked;
	toggle.disabled = disabled;
	toggle.dataset.control = control;
	toggle.setAttribute('aria-label', title);
	toggle.addEventListener('change', () => change(toggle.checked, toggle));
	row.append(text, toggle);
	return row;
}

/** a row that goes somewhere (an arrow, or the open-in-a-tab mark) */
function xpLinkRow(title, control, run, icon = 'next', disabled = false) {
	const row = element('button', 'spSettingRow nav xpDetailRow');
	row.type = 'button';
	row.dataset.control = control;
	row.disabled = disabled;
	const text = element('div', 'spRowText');
	text.append(element('div', 'spRowLabel', title));
	row.append(text);
	row.insertAdjacentHTML('beforeend', xpIcon(icon));
	if (icon === 'open') row.setAttribute('aria-description', 'Opens in new tab');
	row.addEventListener('click', run);
	return row;
}

/** Chrome's size text (path_util.cc): "< 1 MB", else megabytes */
function xpSize(bytes) {
	if (typeof bytes !== 'number') return null;
	const mb = bytes / (1024 * 1024);
	if (mb < 1) return '< 1 MB';
	return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function xpSourceText(info) {
	if (info.policy) return ['Added by policy'];
	if (info.source === 'webstore') return ['Chrome Web Store'];
	if (info.source === 'unpacked')
		return [
			'Unpacked extension',
			info.path ? `Loaded from: ${info.path}` : null,
		];
	return ['Not from Chrome Web Store.'];
}

function xpRenderDetails(box) {
	const info = xpInfo(XP.id);
	box.replaceChildren();
	if (!info) return;
	const head = xpSubHead(info, info.name);
	const reload = xpReloadButton(info, `${info.id}:detail-reload`);
	if (reload) head.append(reload);
	box.append(head);
	const rows = element('div', 'spRows xpDetails');
	rows.dataset.ext = info.id;
	// On / Off, with the toggle
	const state = element('div', 'spSettingRow xpDetailRow xpOnRow');
	const stateText = element('div', 'spRowText');
	stateText.append(
		element(
			'div',
			`spRowLabel xpOnLabel${info.enabled ? ' on' : ''}`,
			info.enabled ? 'On' : 'Off',
		),
	);
	state.append(stateText, xpToggle(info, `${info.id}:detail-toggle`));
	rows.append(state);
	rows.append(
		xpRow('Description', info.description || 'No description provided'),
	);
	rows.append(xpRow('Version', info.version));
	const size = xpSize(info.size);
	if (size) rows.append(xpRow('Size', size));
	if (XP.dev) {
		const id = element('div', 'spRowSub', info.id);
		id.dir = 'ltr';
		rows.append(xpRow('ID', id));
		const views = info.enabled ? (XP.views.get(info.id) ?? []) : [];
		const list = element('div', 'spRowSub xpViewList');
		if (!views.length) list.textContent = 'No active views';
		views.forEach((view, index) =>
			list.append(xpViewLink(info, view, `${info.id}:detail-view:${index}`)),
		);
		rows.append(xpRow('Inspect views', list));
	}
	const access = xpSiteAccess(info);
	const permissions = xpPermissionsRow(info, !!access);
	permissions.dataset.row = 'permissions';
	rows.append(permissions);
	if (access) rows.append(access);
	// (Chrome's, for an extension with a button)
	if (info.hasAction && info.enabled && extApi()?.pin)
		rows.append(
			xpToggleRow(
				'Pin to toolbar',
				null,
				!!info.pinned,
				`${info.id}:pin`,
				async (on, toggle) => {
					try {
						await extApi().pin(info.id, on);
					} catch (error) {
						toggle.checked = !on;
						setShieldsPageStatus(error.message, true);
					}
					syncExtensions();
				},
			),
		);
	if (XP.dev)
		rows.append(
			xpToggleRow(
				'Collect errors',
				null,
				info.collectErrors ?? info.source === 'unpacked',
				`${info.id}:collect`,
				async (on, toggle) => {
					try {
						await extApi().setCollectErrors(info.id, on);
					} catch (error) {
						toggle.checked = !on;
						setShieldsPageStatus(error.message, true);
					}
					syncExtensions();
				},
			),
		);
	if (info.optionsUrl)
		rows.append(
			xpLinkRow(
				'Extension options',
				`${info.id}:options`,
				() => {
					closeShieldsPage();
					openExtOptions(info.id);
				},
				'next',
				!info.enabled,
			),
		);
	// (the manifest's homepage_url only: Chrome's row is not the store's page)
	const website = info.manifest?.homepage_url;
	if (typeof website === 'string' && /^https?:/.test(website))
		rows.append(
			xpLinkRow(
				'Open extension website',
				`${info.id}:website`,
				() => xpVisit(website),
				'open',
			),
		);
	if (info.webStoreUrl)
		rows.append(
			xpLinkRow(
				'View in Chrome Web Store',
				`${info.id}:store`,
				() => xpVisit(info.webStoreUrl),
				'open',
			),
		);
	rows.append(xpRow('Source', ...xpSourceText(info)));
	if (!info.policy)
		rows.append(
			xpLinkRow('Remove extension', `${info.id}:detail-remove`, () =>
				xpRemove(info),
			),
		);
	box.append(rows);
}

/** "Permissions": Chrome's warnings, without the sites when Site access shows them */
function xpPermissionsRow(info, withAccess) {
	const warnings = info.permissionWarnings ?? [];
	const row = xpRow('Permissions');
	const text = row.querySelector('.spRowText');
	if (!warnings.length && withAccess) return row;
	if (!warnings.length) {
		text.append(
			element(
				'div',
				'spRowSub',
				'This extension requires no special permissions',
			),
		);
		return row;
	}
	const list = element('ul', 'xpPermList');
	for (const warning of warnings) {
		const item = element('li', 'spRowSub', warning.message);
		if (warning.details?.length) {
			const sub = element('ul', 'xpPermList');
			for (const line of warning.details)
				sub.append(element('li', 'spRowSub', line));
			item.append(sub);
		}
		list.append(item);
	}
	if (!withAccess)
		list.append(
			element('li', 'spRowSub', 'This extension has no additional site access'),
		);
	text.append(list);
	return row;
}

/** a pattern that is every site, as Chrome's requested host permissions read it */
const xpAllSites = (pattern) =>
	/^(<all_urls>|(\*|https?):\/\/\*\/\*)$/.test(pattern);

/** where the extension runs, in Chrome's three words: 'all', 'specific' or 'on-click' */
function xpAccessOf(info) {
	const access = info.siteAccess;
	if (!access) return null;
	if (!access.withheld) return 'all';
	return access.sites?.length ? 'specific' : 'on-click';
}

/**
 * "Site access", for an extension with host permissions (Chrome's
 * runtime_host_permissions and host_permissions_toggle_list): On click / On
 * specific sites / On all sites when it asks for every site, a toggle per
 * site when it asks for some
 */
function xpSiteAccess(info) {
	const requested = info.requestedHosts ?? [];
	if (info.policy || !requested.length || !info.siteAccess) return null;
	if (!extApi()?.setSiteHosts) return null;
	const access = xpAccessOf(info);
	const granted = info.siteAccess.sites ?? [];
	const all = info.allHostsRequested ?? requested.some(xpAllSites);
	const wrap = element('div', 'xpAccess');
	wrap.dataset.access = access;
	wrap.dataset.row = 'site-access';
	const head = element('div', 'spSettingRow xpDetailRow xpAccessHead');
	const text = element('div', 'spRowText');
	text.append(element('div', 'spRowLabel', 'Site access'));
	head.append(text);
	wrap.append(head);
	if (all) {
		text.append(
			element(
				'div',
				'spRowSub',
				'Allow this extension to read and change all your data on websites you visit:',
			),
		);
		const select = spSelect(`xpAccess-${info.id}`, access, [
			{ v: 'on-click', label: 'On click' },
			{ v: 'specific', label: 'On specific sites' },
			{ v: 'all', label: 'On all sites' },
		]);
		select.dataset.control = `${info.id}:access`;
		select.setAttribute('aria-label', 'Site access');
		select.addEventListener('change', () => {
			// On specific sites asks for a site at once; cancelled, the choice stays
			if (select.value === 'specific') {
				select.value = access;
				xpAddSite(info, wrap);
				return;
			}
			if (select.value === 'all') xpSetAll(info);
			else xpSetHosts(info, []);
		});
		head.append(select);
		if (access === 'specific') {
			const hosts = element('div', 'xpHosts');
			for (const host of granted) {
				const line = element('div', 'spCustomRow xpHost');
				line.dataset.host = host;
				line.append(element('span', 'spCustomUrlText', host));
				const drop = xpIconButton(
					'trash',
					`Remove ${host}`,
					`${info.id}:host-remove:${host}`,
				);
				drop.addEventListener('click', () =>
					xpSetHosts(
						info,
						granted.filter((other) => other !== host),
					),
				);
				line.append(drop);
				hosts.append(line);
			}
			const add = element('button', 'xpLink xpAddSiteLink', 'Add a new page');
			add.type = 'button';
			add.dataset.control = `${info.id}:host-add-page`;
			add.addEventListener('click', () => xpAddSite(info, wrap));
			hosts.append(add);
			wrap.append(hosts);
		}
		return wrap;
	}
	text.append(
		element(
			'div',
			'spRowSub',
			'This extension can read and change your data on sites. You can control which sites the extension can access.',
		),
	);
	const allOn = access === 'all';
	wrap.append(
		xpToggleRow(
			'Automatically allow access on the following sites',
			null,
			allOn,
			`${info.id}:access-all`,
			(on) => (on ? xpSetAll(info) : xpSetHosts(info, [])),
		),
	);
	for (const host of [...requested].sort()) {
		const row = xpToggleRow(
			host,
			null,
			allOn || granted.includes(host),
			`${info.id}:host:${host}`,
			(on) =>
				xpSetHosts(
					info,
					on
						? [...new Set([...granted, host])]
						: granted.filter((other) => other !== host),
				),
			allOn,
		);
		row.classList.add('xpHostToggle');
		row.dataset.host = host;
		wrap.append(row);
	}
	return wrap;
}

/** Chrome's "Add a site" dialog, inline: a site, Cancel and Add */
function xpAddSite(info, wrap) {
	wrap.querySelector('.xpSiteForm')?.remove();
	const form = element('form', 'xpSiteForm');
	form.setAttribute('aria-label', 'Add a site');
	form.innerHTML = `<div class="spRowLabel">Add a site</div>
		<label class="spRowSub" for="xpSite-${info.id}">Site</label>
		<input class="spInput" id="xpSite-${info.id}" type="text" spellcheck="false" placeholder="http://example.com" data-control="${info.id}:host-input" />
		<div class="spSectionNote warn xpSiteError" hidden>Not a valid web address</div>
		<div class="spRowButtons">
			<button class="spBtn ghost" type="button" data-control="${info.id}:host-cancel">Cancel</button>
			<button class="spBtn" type="submit" data-control="${info.id}:host-add" disabled>Add</button>
		</div>`;
	const input = form.querySelector('input');
	const problem = form.querySelector('.xpSiteError');
	const add = form.querySelector('[type="submit"]');
	input.addEventListener('input', () => {
		const valid = !!xpSitePattern(input.value);
		problem.hidden = !input.value.trim() || valid;
		add.disabled = !valid;
	});
	form
		.querySelector('[type="button"]')
		.addEventListener('click', () => form.remove());
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		const host = xpSitePattern(input.value);
		if (!host) {
			problem.hidden = false;
			return;
		}
		form.remove();
		xpSetHosts(info, [...new Set([...(info.siteAccess?.sites ?? []), host])]);
	});
	wrap.append(form);
	input.focus();
}

/**
 * What a typed site grants, as Chrome's runtime_hosts_dialog reads it: an
 * optional http, https or * scheme, an optional *., a host with a dot (or
 * localhost), an optional port and / or /*; kept as <scheme>://<host>/*
 */
function xpSitePattern(value) {
	const match =
		/^(?:(https?|\*):\/\/)?(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost)(:\d+)?\/?\*?$/i.exec(
			value.trim(),
		);
	if (!match) return null;
	const scheme = match[1] ? match[1].toLowerCase() : '*';
	return `${scheme}://${match[2] ?? ''}${match[3].toLowerCase()}${match[4] ?? ''}/*`;
}

async function xpSetAll(info) {
	try {
		await extApi().setSiteAccess(info.id, 'all', null);
	} catch (error) {
		setShieldsPageStatus(error.message, true);
	}
	syncExtensions();
}

async function xpSetHosts(info, hosts) {
	try {
		await extApi().setSiteHosts(info.id, hosts);
	} catch (error) {
		setShieldsPageStatus(error.message, true);
	}
	syncExtensions();
}

// ---- errors -----------------------------------------------------------------

/** Chrome's line of a stack frame: <relative url>:<line> (<function>) */
function xpFrameLine(frame, id) {
	const name =
		!frame.functionName || frame.functionName === '(anonymous function)'
			? 'anonymous function'
			: frame.functionName;
	return `${xpRelative(frame.url, id)}:${frame.lineNumber} (${name})`;
}

function xpRenderErrors(box) {
	const info = xpInfo(XP.id);
	box.replaceChildren();
	if (!info) return;
	// (the manifest's first, as Chrome lists them)
	const errors = [...(XP.errors.get(info.id) ?? [])].sort(
		(a, b) => (a.type === 'manifest' ? 0 : 1) - (b.type === 'manifest' ? 0 : 1),
	);
	const head = xpSubHead(info, 'Errors', 'details');
	head
		.querySelector('.xpSubTitle')
		.append(' ', element('span', 'spRowSub xpSubName', info.name));
	const reload = xpReloadButton(info, `${info.id}:errors-reload`);
	if (reload) head.append(reload);
	if (errors.length)
		head.append(
			xpButton('Clear all', `${info.id}:clear-all`, async () => {
				try {
					await extApi().clearErrors(info.id);
					XP.errors.set(info.id, []);
				} catch (error) {
					setShieldsPageStatus(error.message, true);
				}
				syncExtensions();
			}),
		);
	box.append(head);
	if (!errors.length) return;
	// (the first entry starts open)
	if (XP.openError === undefined) XP.openError = errors[0].id;
	const list = element('div', 'spListBox xpErrors');
	list.setAttribute('role', 'list');
	for (const error of errors) {
		const severity = error.type === 'manifest' ? 'warn' : error.severity;
		const row = element('div', 'spListRow xpError');
		row.dataset.error = String(error.id);
		row.dataset.severity = severity;
		row.dataset.type = error.type;
		row.setAttribute('role', 'listitem');
		const open = XP.openError === error.id;
		const pick = element('button', 'xpErrorPick');
		pick.type = 'button';
		pick.dataset.control = `${info.id}:error:${error.id}`;
		pick.setAttribute('aria-expanded', String(open));
		const label = { error: 'Error', warn: 'Warning', log: 'Log' }[severity];
		pick.innerHTML = xpIcon(severity, `shieldsIcon xpSeverity ${severity}`);
		const mark = pick.firstElementChild;
		mark.removeAttribute('aria-hidden');
		mark.setAttribute('role', 'img');
		mark.setAttribute('aria-label', label);
		mark.insertAdjacentHTML('afterbegin', `<title>${label}</title>`);
		pick.append(element('span', 'spListName xpErrorMessage', error.message));
		if (error.occurrences > 1)
			pick.append(element('span', 'spTag xpCount', String(error.occurrences)));
		pick.insertAdjacentHTML(
			'beforeend',
			xpIcon('more', `shieldsIcon xpChevron${open ? ' open' : ''}`),
		);
		pick.addEventListener('click', () => {
			XP.openError = open ? null : error.id;
			xpRender({ more: false });
		});
		const drop = xpIconButton(
			'trash',
			'Clear entry',
			`${info.id}:error-drop:${error.id}`,
		);
		drop.addEventListener('click', async () => {
			try {
				await extApi().clearErrors(info.id, [error.id]);
				XP.errors.set(
					info.id,
					errors.filter((other) => other.id !== error.id),
				);
			} catch (failure) {
				setShieldsPageStatus(failure.message, true);
			}
			syncExtensions();
		});
		row.append(pick, drop);
		if (open) row.append(xpErrorDetail(info, error));
		list.append(row);
	}
	box.append(list);
}

function xpErrorDetail(info, error) {
	const detail = element('div', 'xpErrorDetail');
	if (error.type === 'manifest') {
		if (error.manifestKey)
			detail.append(
				element(
					'div',
					'spRowSub xpMono',
					`manifest.json: ${error.manifestKey}`,
				),
			);
		return detail;
	}
	detail.append(
		element('div', 'spRowLabel', 'Context'),
		element(
			'div',
			'spRowSub xpMono',
			error.contextUrl ? xpRelative(error.contextUrl, info.id) : 'Unknown',
		),
	);
	const frames = (error.stackTrace ?? []).filter(
		(frame) => !/^extensions::/.test(frame.url),
	);
	if (frames.length) {
		detail.append(element('div', 'spRowLabel', 'Stack Trace'));
		const stack = element('ul', 'xpStack xpMono');
		for (const frame of frames)
			stack.append(element('li', 'spRowSub', xpFrameLine(frame, info.id)));
		detail.append(stack);
	}
	return detail;
}

// ---- keyboard shortcuts ------------------------------------------------------

// the keys a shortcut may end in (cr_shortcut_util.ts), by key code, with
// Chrome's names
const XP_KEY_NAMES = {
	188: 'Comma',
	46: 'Delete',
	40: 'Down',
	35: 'End',
	36: 'Home',
	45: 'Insert',
	37: 'Left',
	176: 'MediaNextTrack',
	179: 'MediaPlayPause',
	177: 'MediaPrevTrack',
	178: 'MediaStop',
	34: 'PageDown',
	33: 'PageUp',
	190: 'Period',
	39: 'Right',
	32: 'Space',
	9: 'Tab',
	38: 'Up',
};

/** the key of a shortcut as Chrome names it, null for one a shortcut cannot end in */
function xpKeyName(keyCode) {
	if ((keyCode >= 65 && keyCode <= 90) || (keyCode >= 48 && keyCode <= 57))
		return String.fromCharCode(keyCode);
	return XP_KEY_NAMES[keyCode] ?? null;
}

/**
 * Chrome's reading of a key typed into a shortcut field (cr_shortcut_input
 * handleKey_): { shortcut } to keep, or { problem } in Chrome's words
 */
function xpTypedShortcut(event) {
	if (/^(Control|Alt|Shift|Meta)$/.test(event.key))
		return { problem: 'Type a letter', pending: true };
	if (event.altKey && event.ctrlKey)
		return { problem: 'Use either Ctrl or Alt' };
	const media = event.keyCode >= 176 && event.keyCode <= 179;
	const valid = media
		? !event.ctrlKey && !event.altKey
		: event.ctrlKey || event.altKey;
	if (!valid) return { problem: 'Include either Ctrl or Alt' };
	const key = xpKeyName(event.keyCode);
	if (!key) return { problem: 'Type a letter' };
	const parts = [];
	if (event.ctrlKey) parts.push('Ctrl');
	if (event.altKey) parts.push('Alt');
	if (event.shiftKey) parts.push('Shift');
	return { shortcut: [...parts, key].join('+') };
}

/** the shortcut as Chrome's field shows it: "Ctrl + Shift + Y" */
const xpShortcutText = (shortcut) =>
	shortcut ? shortcut.split('+').join(' + ') : '';

function xpRenderShortcuts(box) {
	box.replaceChildren();
	box.append(
		element('h3', 'spSectionTitle xpShortcutsTitle', 'Keyboard shortcuts'),
	);
	// (enabled extensions with commands, as Chrome lists them)
	const byExtension = new Map();
	for (const command of XP.commands ?? []) {
		const info = xpInfo(command.id);
		if (!info?.enabled) continue;
		if (!byExtension.has(info.id)) byExtension.set(info.id, []);
		byExtension.get(info.id).push(command);
	}
	for (const info of xpSorted(
		[...byExtension.keys()].map((id) => xpInfo(id)),
	)) {
		const card = element('div', 'extCard xpShortcutCard');
		card.dataset.ext = info.id;
		const head = element('div', 'extCardHead');
		head.append(
			extIcon(info.name, info.iconUrl, 'extCardIcon'),
			element('div', 'spListName xpName', info.name),
		);
		card.append(head);
		for (const command of byExtension.get(info.id))
			card.append(xpShortcutRow(info, command));
		box.append(card);
	}
}

function xpShortcutRow(info, command) {
	const key = `${info.id}|${command.name}`;
	const action = xpExecute(command.name);
	const title = action
		? 'Activate the extension'
		: command.description || command.name;
	const row = element('div', 'spSettingRow xpShortcut');
	row.dataset.command = command.name;
	const text = element('div', 'spRowText');
	text.append(element('div', 'spRowLabel', title));
	const note = XP.shortcutNote.get(key);
	const field = element('div', 'xpShortcutField');
	const input = element('input', 'spInput xpShortcutInput');
	input.type = 'text';
	input.readOnly = true;
	input.dataset.control = `${key}:input`;
	input.setAttribute('aria-label', `Shortcut ${title} for ${info.name}`);
	const editing = XP.editing === key;
	input.value = editing ? '' : xpShortcutText(command.shortcut);
	input.placeholder = editing ? 'Type a shortcut' : 'Not set';
	input.classList.toggle('editing', editing);
	input.setAttribute('aria-invalid', String(!!note));
	input.addEventListener('keydown', (event) =>
		xpShortcutKey(event, info, command, input),
	);
	input.addEventListener('blur', () => {
		if (XP.editing !== key) return;
		XP.editing = null;
		XP.shortcutNote.delete(key);
		xpRender({ more: false });
	});
	field.append(input);
	if (!editing) {
		const edit = xpIconButton(
			'edit',
			`Edit shortcut ${title} for ${info.name}`,
			`${key}:edit`,
		);
		edit.addEventListener('click', () => xpEditShortcut(key));
		field.append(edit);
	}
	if (command.shortcut) {
		const clear = xpIconButton('clear', 'Clear', `${key}:clear`);
		// (a press, so the field's blur does not end the edit first)
		clear.addEventListener('mousedown', (event) => event.preventDefault());
		clear.addEventListener('click', () => xpSaveShortcut(info, command, ''));
		field.append(clear);
	}
	const column = element('div', 'xpShortcutCol');
	column.append(field);
	if (note)
		column.append(element('div', 'spSectionNote warn xpShortcutNote', note));
	const scope = spSelect(`xpScope-${key}`, command.scope ?? 'chrome', [
		{ v: 'chrome', label: 'In powerMouse' },
		{ v: 'global', label: 'Global' },
	]);
	scope.dataset.control = `${key}:scope`;
	scope.setAttribute('aria-label', `Scope of ${title} for ${info.name}`);
	// (a global shortcut needs the operating system, which a page cannot reach)
	const global = scope.querySelector('option[value="global"]');
	if (global) global.disabled = true;
	scope.disabled = action || !command.shortcut || !extApi()?.setCommandScope;
	scope.addEventListener('change', async () => {
		try {
			await extApi().setCommandScope(info.id, command.name, scope.value);
		} catch (error) {
			setShieldsPageStatus(error.message, true);
		}
		syncExtensions();
	});
	const scopeBox = element('label', 'xpScope');
	scopeBox.append(scope);
	row.append(text, column, scopeBox);
	return row;
}

function xpEditShortcut(key) {
	XP.editing = key;
	XP.shortcutNote.delete(key);
	xpRender({ more: false });
	xpControl(`${key}:input`)?.focus();
}

function xpShortcutKey(event, info, command, input) {
	const key = `${info.id}|${command.name}`;
	if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) return;
	if (XP.editing !== key) {
		// a key on the field starts the capture, as Chrome's
		if (event.key === 'Escape') return;
		XP.editing = key;
		XP.shortcutNote.delete(key);
		input.value = '';
		input.placeholder = 'Type a shortcut';
		input.classList.add('editing');
	}
	// (the key is the field's: no shortcut, no page key)
	event.preventDefault();
	event.stopPropagation();
	if (event.key === 'Escape') {
		XP.editing = null;
		XP.shortcutNote.delete(key);
		xpRender({ more: false });
		xpControl(`${key}:input`)?.focus();
		return;
	}
	const typed = xpTypedShortcut(event);
	if (typed.problem) {
		XP.shortcutNote.set(key, typed.problem);
		input.setAttribute('aria-invalid', 'true');
		const column = input.closest('.xpShortcutCol');
		let note = column.querySelector('.xpShortcutNote');
		if (!note) {
			note = element('div', 'spSectionNote warn xpShortcutNote');
			column.append(note);
		}
		note.textContent = typed.problem;
		return;
	}
	xpSaveShortcut(info, command, typed.shortcut);
}

async function xpSaveShortcut(info, command, shortcut) {
	const key = `${info.id}|${command.name}`;
	XP.editing = null;
	XP.shortcutNote.delete(key);
	try {
		await extApi().setShortcut(info.id, command.name, shortcut);
	} catch (error) {
		XP.shortcutNote.set(key, error.message);
	}
	try {
		XP.commands = await extApi().commands();
	} catch {
		// the last list stays
	}
	xpRender({ more: false });
	xpControl(`${key}:input`)?.focus();
	// main.js's shortcuts follow commands() (setExtShortcuts)
	syncExtensions();
}

// ---- pack extension ------------------------------------------------------------

/** Chrome's Pack extension dialog: a folder and an optional key, then what it made */
const XP_PACK = { files: null, folder: '', key: null, keyName: '', made: null };

function xpRenderPack(box) {
	box.replaceChildren();
	box.append(xpSubHead(null, 'Pack extension'));
	if (XP_PACK.made) {
		const made = XP_PACK.made;
		const alert = element('div', 'spCallout xpPackDone');
		alert.setAttribute('role', 'alert');
		const lines = made.key
			? [
					'Created the following files:',
					`Extension: ${made.crx}`,
					`Key File: ${made.pem}`,
					'Keep your key file in a safe place. You will need it to create new versions of your extension.',
				]
			: ['Created the extension:', made.crx];
		for (const line of lines) alert.append(element('p', '', line));
		const buttons = element('div', 'spRowButtons');
		buttons.append(
			xpButton(
				'OK',
				'pack:ok',
				() => {
					XP_PACK.made = null;
					xpGo('list', null);
				},
				'',
			),
		);
		alert.append(buttons);
		box.append(alert);
		return;
	}
	box.append(
		element(
			'p',
			'spSectionNote',
			'Select the root directory of the extension to pack. To update an extension, also select the private key file to reuse.',
		),
	);
	const rows = element('div', 'spRows xpPack');
	const field = (label, value, control, browse) => {
		const row = element('div', 'spSettingRow xpDetailRow xpPackRow');
		const text = element('label', 'spRowText');
		text.append(element('div', 'spRowLabel', label));
		const input = element('input', 'spInput');
		input.type = 'text';
		input.readOnly = true;
		input.value = value;
		input.dataset.control = `${control}-value`;
		text.append(input);
		row.append(text, xpButton('Browse', control, browse));
		return row;
	};
	rows.append(
		field('Extension root directory', XP_PACK.folder, 'pack:browse', () =>
			xpPart('#xpPackFolder').click(),
		),
		field('Private key file (optional)', XP_PACK.keyName, 'pack:key', () =>
			xpPart('#xpPackKey').click(),
		),
	);
	const buttons = element('div', 'spRowButtons');
	const go = xpButton('Pack extension', 'pack:go', xpPackNow, '');
	go.disabled = !XP_PACK.files;
	buttons.append(
		xpButton('Cancel', 'pack:cancel', () => xpGo('list', null)),
		go,
	);
	rows.append(buttons);
	box.append(rows);
	const folder = xpPart('#xpPackFolder');
	folder.onchange = () => {
		if (!folder.files.length) return;
		XP_PACK.files = [...folder.files];
		XP_PACK.folder = folder.files[0].webkitRelativePath.split('/')[0];
		folder.value = '';
		xpRender({ more: false });
	};
	const keyInput = xpPart('#xpPackKey');
	keyInput.onchange = async () => {
		const file = keyInput.files[0];
		keyInput.value = '';
		if (!file) return;
		XP_PACK.key = await file.text();
		XP_PACK.keyName = file.name;
		xpRender({ more: false });
	};
}

/** a download of `blob` under `name` */
function xpDownload(blob, name) {
	const link = element('a');
	link.href = URL.createObjectURL(blob);
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

async function xpPackNow() {
	if (!XP_PACK.files) return;
	const name = XP_PACK.folder || 'extension';
	try {
		const packed = await extApi().pack(
			XP_PACK.files,
			XP_PACK.key ? { key: XP_PACK.key } : {},
		);
		xpDownload(packed.crx, `${name}.crx`);
		// (a key of its own only when none was given, as Chrome's)
		const madeKey = !XP_PACK.key && !!packed.key;
		if (madeKey)
			xpDownload(
				new Blob([packed.key], { type: 'application/x-pem-file' }),
				`${name}.pem`,
			);
		XP_PACK.made = { crx: `${name}.crx`, pem: `${name}.pem`, key: madeKey };
		Object.assign(XP_PACK, { files: null, folder: '', key: null, keyName: '' });
		xpRender({ more: false });
		xpControl('pack:ok')?.focus();
	} catch (error) {
		setShieldsPageStatus(error.message, true);
	}
}

// ---- keys --------------------------------------------------------------------

// Escape in a view of one extension goes back, and closes Chrome's
// uninstall dialog before the settings dialog under it (this listener is
// made before main.js's, which closes the whole dialog)
addEventListener(
	'keydown',
	(event) => {
		if (event.key !== 'Escape') return;
		const page = document.getElementById('shieldsPage');
		if (!page || page.classList.contains('hidden')) return;
		if (page.dataset.view !== 'extensions') return;
		const sheet = document.getElementById('passkeyPrompt');
		if (sheet) {
			event.preventDefault();
			event.stopImmediatePropagation();
			sheet.querySelector('button.close:not(:disabled)')?.click();
			return;
		}
		if (XP.editing) return; // the shortcut field's own
		const form = page.querySelector('.xpSiteForm');
		if (form) form.remove();
		else if (XP.sideOpen) {
			XP.sideOpen = false;
			xpRender({ more: false });
		} else if (XP.view !== 'list')
			xpGo(XP.view === 'errors' ? 'details' : 'list');
		else return;
		event.preventDefault();
		event.stopImmediatePropagation();
	},
	true,
);

// the developer mode the page was left in, once the controller is up
// (Chrome collects errors only with it on)
addEventListener('DOMContentLoaded', () => {
	if (typeof booted === 'undefined') return;
	booted.then(() => extApi()?.setDeveloperMode?.(XP.dev)).catch(() => {});
});
