// The demo UI's themes (docs/themes.md): Default (Powermouse's own look),
// Light, Dark, Follow system, and themes installed from the Chrome Web
// Store. A classic script in index.html's <head>, after main.css: it puts
// the chosen theme on the root before the body is parsed, so the first
// paint is in it. globalThis.PMTheme is the interface; pm/main.js builds
// the picker on it and the Web Store install hands it themes.
//
// The tokens are CSS custom properties (main.css, :root): the built-in
// themes are attribute rules there (data-pm-theme), and an installed theme
// is Light or Dark (its scheme) with its own values for some tokens, written
// here into a rule of their own.
(() => {
	const CHOICE_KEY = 'stomp-demo:theme';
	const INSTALLED_KEY = 'stomp-demo:themes';
	const DB_NAME = 'stomp-demo-themes';
	const DB_STORE = 'images';
	const root = document.documentElement;

	// every token main.css defines (without the leading --pm-)
	const TOKENS = Object.freeze([
		'page',
		'page-image',
		'text',
		'ntp',
		'ntp-image',
		'ntp-position',
		'ntp-size',
		'ntp-repeat',
		'ntp-text',
		'ntp-attribution',
		'border',
		'link',
		'link-hover',
		'link-active',
		'link-bright',
		'focus',
		'status',
		'error',
		'error-soft',
		'muted',
		'hover',
		'raised',
		'raised-ring',
		'rail',
		'avatar',
		'accent',
		'accent-hover',
		'accent-active',
		'accent-text',
		'on-accent',
		'frame',
		'frame-image',
		'frame-overlay',
		'frame-text',
		'frame-inactive',
		'toolbar',
		'toolbar-image',
		'toolbar-text',
		'toolbar-button',
		'toolbar-fg-rgb',
		'navbar',
		'navbar-icon',
		'navbar-icon-hover',
		'navbar-press',
		'navbar-press-icon',
		'field',
		'field-active',
		'field-text',
		'field-border',
		'field-muted',
		'field-focus',
		'field-focus-ring',
		'field-divider',
		'field-hover',
		'field-hover-text',
		'field-fg-rgb',
		'chip',
		'chip-text',
		'badge',
		'badge-text',
		'letter',
		'letter-text',
		'btn-blue',
		'btn-green',
		'btn-orange',
		'btn-red',
		'btn-text',
		'recents',
		'tab-image',
		'tab-text',
		'tab-icon',
		'tab-text-muted',
		'tab-pill',
		'tab-pill-border',
		'tab-hover',
		'tab-line',
		'sheet',
		'sheet-fg-rgb',
		'sheet-pill',
		'sheet-ok',
		'sheet-warn',
		'sheet-error',
		'sheet-link',
		'sheet-on-link',
		'sheet-tag',
		'sheet-tag-border',
		'bookmark-text',
		'handle',
		'handle-hover',
		'handle-active',
		'scrim',
		'dialog',
		'dialog-text',
		'dialog-muted',
		'dialog-focus',
		'dialog-scrim',
		'panel',
		'panel-sunken',
		'panel-raised',
		'panel-raised-hover',
		'panel-control',
		'panel-gutter',
		'panel-text',
		'panel-text-2',
		'panel-text-3',
		'panel-text-4',
		'panel-strong',
		'panel-accent',
		'panel-accent-rgb',
		'panel-on-accent',
		'panel-accent-border',
		'panel-accent-hover',
		'panel-icon',
		'panel-divider',
		'panel-outline',
		'panel-thumb',
		'panel-fg-rgb',
		'panel-warn',
		'panel-warn-rgb',
		'panel-good',
		'panel-bad',
		'panel-danger',
		'panel-on-danger',
		'panel-chevron',
		'code-domain',
		'code-sep',
		'code-selector',
		'code-option',
		'code-exception',
		'shadow-rgb',
		'shadow-k',
	]);
	const TOKEN_SET = new Set(TOKENS);
	// an installed theme's pictures (Chrome's image names) and the token
	// each one fills; one the theme does not have is `none`, so no picture
	// of the theme under it shows through
	const IMAGE_TOKENS = {
		theme_frame: 'frame-image',
		theme_frame_overlay: 'frame-overlay',
		theme_toolbar: 'toolbar-image',
		theme_tab_background: 'tab-image',
		theme_ntp_background: 'ntp-image',
		theme_ntp_attribution: 'ntp-attribution',
	};

	/** a swatch for the picker: the bar, the frame, the page and the accent */
	const preview = (frame, toolbar, ntp, accent, text) => ({
		frame,
		toolbar,
		ntp,
		accent,
		text,
	});
	const BUILTIN = [
		{
			id: 'default',
			name: 'Default',
			scheme: 'dark',
			preview: preview('#000', '#000', '#000', '#e8ed58', '#fff'),
		},
		{
			id: 'light',
			name: 'Light',
			scheme: 'light',
			preview: preview('#eeeeec', '#f6f6f4', '#fbfbfa', '#3465a4', '#2e3436'),
		},
		{
			id: 'dark',
			name: 'Dark',
			scheme: 'dark',
			preview: preview('#2e3436', '#2a2f31', '#232728', '#8cb3e0', '#eeeeec'),
		},
		{ id: 'system', name: 'Follow system', scheme: 'light', preview: null },
	].map((theme) =>
		Object.freeze({
			...theme,
			source: 'builtin',
			tokens: Object.freeze({}),
			images: Object.freeze({}),
		}),
	);
	const builtin = (id) => BUILTIN.find((theme) => theme.id === id) ?? null;

	const storage = {
		get(key) {
			try {
				return localStorage.getItem(key);
			} catch {
				return null;
			}
		},
		set(key, value) {
			try {
				if (value === null) localStorage.removeItem(key);
				else localStorage.setItem(key, value);
			} catch {
				// private mode, or storage full: the theme lasts this visit
			}
		},
	};

	// ---- colour math, after Chromium's ui/gfx/color_utils.cc ---------------
	// colours are [r, g, b, a] with every channel 0..255

	const round = (x) => Math.min(255, Math.max(0, Math.round(x)));
	function toHSL([R, G, B]) {
		const r = R / 255;
		const g = G / 255;
		const b = B / 255;
		const mn = Math.min(r, g, b);
		const mx = Math.max(r, g, b);
		const d = mx - mn;
		const l = (mn + mx) / 2;
		if (R === G && R === B) return { h: 0, s: 0, l };
		const dr = ((mx - r) / 6 + d / 2) / d;
		const dg = ((mx - g) / 6 + d / 2) / d;
		const db = ((mx - b) / 6 + d / 2) / d;
		let h =
			r >= g && r >= b
				? db - dg
				: g >= r && g >= b
					? 1 / 3 + dr - db
					: 2 / 3 + dg - dr;
		if (h < 0) h += 1;
		else if (h > 1) h -= 1;
		return { h, s: d / (l < 0.5 ? mx + mn : 2 - mx - mn), l };
	}
	function hue(t1, t2, h) {
		if (h < 0) h += 1;
		else if (h > 1) h -= 1;
		let v = t1;
		if (h * 6 < 1) v = t1 + (t2 - t1) * h * 6;
		else if (h * 2 < 1) v = t2;
		else if (h * 3 < 2) v = t1 + (t2 - t1) * (2 / 3 - h) * 6;
		return round(v * 255);
	}
	function fromHSL({ h, s, l }, a = 255) {
		if (!s) {
			const v = round(l * 255);
			return [v, v, v, a];
		}
		const t2 = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const t1 = 2 * l - t2;
		return [hue(t1, t2, h + 1 / 3), hue(t1, t2, h), hue(t1, t2, h - 1 / 3), a];
	}
	/** color_utils::HSLShift: a tint [h, s, l], -1 for a channel kept */
	function hslShift(color, [h, s, l]) {
		let out = color;
		if (h >= 0 || s >= 0) {
			const hsl = toHSL(color);
			if (h >= 0) hsl.h = h;
			if (s >= 0)
				hsl.s =
					s <= 0.5 ? hsl.s * s * 2 : hsl.s + (1 - hsl.s) * ((s - 0.5) * 2);
			out = fromHSL(hsl, color[3]);
		}
		if (l < 0) return out;
		return [
			...out
				.slice(0, 3)
				.map((v) =>
					round(l <= 0.5 ? v * l * 2 : v + (255 - v) * ((l - 0.5) * 2)),
				),
			out[3],
		];
	}
	const linear = (v) =>
		v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	const luminance = ([r, g, b]) =>
		0.2126 * linear(r / 255) +
		0.7152 * linear(g / 255) +
		0.0722 * linear(b / 255);
	function contrast(a, b) {
		const x = luminance(a) + 0.05;
		const y = luminance(b) + 0.05;
		return x > y ? x / y : y / x;
	}
	// g_luminance_midpoint: the luminance at which Grey900 and white contrast
	// alike with a colour
	const isDark = (color) => luminance(color) < 0.211692036;
	const WHITE = [255, 255, 255, 255];
	const BLACK = [0, 0, 0, 255];
	const GREY050 = [0xf8, 0xf9, 0xfa, 255];
	const GREY100 = [0xf1, 0xf3, 0xf4, 255];
	const GREY700 = [0x5f, 0x63, 0x68, 255];
	const GREY800 = [0x3c, 0x40, 0x43, 255];
	const GREY900 = [0x20, 0x21, 0x24, 255];
	const BLUE700 = [0x19, 0x67, 0xd2, 255];
	const DEFAULT_FRAME = [0xde, 0xe1, 0xe6, 255];
	const DEFAULT_NTP_HEADER = [0x96, 0x96, 0x96, 255];
	const maxContrast = (color) => (isDark(color) ? WHITE : GREY900);
	const endpointMinContrast = (color) => (isDark(color) ? GREY900 : WHITE);
	/** color_utils::AlphaBlend: `fg` over `bg` at `alpha` (0..255) */
	function blend(fg, bg, alpha) {
		if (alpha <= 0) return [...bg.slice(0, 3), 255];
		if (alpha >= 255) return [...fg.slice(0, 3), 255];
		const k = alpha / 255;
		return [
			...fg.slice(0, 3).map((v, i) => round(v * k + bg[i] * (1 - k))),
			255,
		];
	}
	/** a colour with alpha painted over an opaque one */
	const paint = (color, bg) => blend(color, bg, color[3]);
	/** color_utils::BlendForMinContrast */
	function blendForMinContrast(fg, bg, toward = maxContrast(bg), ratio = 4.5) {
		if (contrast(fg, bg) >= ratio) return fg;
		let best = toward;
		let lo = 0;
		let hi = 256;
		while (lo < hi) {
			const alpha = (lo + hi) >> 1;
			const candidate = blend(toward, fg, alpha);
			if (contrast(candidate, bg) >= ratio) {
				best = candidate;
				hi = alpha;
			} else lo = alpha + 1;
		}
		return best;
	}
	const towardMaxContrast = (color, alpha) =>
		blend(maxContrast(color), color, alpha);

	const css = ([r, g, b, a = 255]) =>
		a >= 255
			? `rgb(${r}, ${g}, ${b})`
			: `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
	const channels = ([r, g, b]) => `${r}, ${g}, ${b}`;
	const withAlpha = ([r, g, b], alpha) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

	// ---- Chrome's theme manifest --------------------------------------------

	/** a manifest colour ([r, g, b] or [r, g, b, a], a 0..1), or null */
	function readColor(value) {
		if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4))
			return null;
		const [r, g, b, a] = value;
		if (![r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
			return null;
		if (value.length === 3) return [r, g, b, 255];
		if (typeof a !== 'number' || !(a >= 0 && a <= 1)) return null;
		// an integer alpha is 0 or 1; a fraction is rounded half away from 0
		return [r, g, b, Number.isInteger(a) ? a * 255 : Math.round(a * 255)];
	}
	/** a manifest tint: three numbers, a channel out of [0, 1] kept (-1) */
	function readTint(value) {
		if (!Array.isArray(value) || value.length !== 3) return null;
		if (!value.every((v) => typeof v === 'number')) return null;
		return value.map((v) => (v >= 0 && v <= 1 ? v : -1));
	}
	const lowerKeys = (object) =>
		Object.fromEntries(
			Object.entries(object && typeof object === 'object' ? object : {}).map(
				([key, value]) => [key.toLowerCase(), value],
			),
		);
	/** ntp_background_alignment as a CSS background-position */
	function alignment(value) {
		const words = String(value ?? '')
			.toLowerCase()
			.split(/\s+/);
		const x = words.includes('left')
			? 'left'
			: words.includes('right')
				? 'right'
				: 'center';
		const y = words.includes('top')
			? 'top'
			: words.includes('bottom')
				? 'bottom'
				: 'center';
		return `${x} ${y}`;
	}
	function repeat(value) {
		const word = String(value ?? '').toLowerCase();
		return ['repeat-x', 'repeat-y', 'repeat'].includes(word)
			? word
			: 'no-repeat';
	}

	/**
	 * A Chrome theme (a manifest's `theme`: colors, tints, properties, and
	 * images as URLs the caller made of the package's files) as a PMTheme
	 * theme, every colour derived as Chromium derives a missing one
	 * (BrowserThemePack, the colour mixers). `meta` names it: id, name,
	 * extensionId; source is 'webstore'.
	 */
	function fromChrome(theme = {}, meta = {}) {
		const given = lowerKeys(theme.colors);
		const tintsIn = lowerKeys(theme.tints);
		const props = lowerKeys(theme.properties);
		const imagesIn = lowerKeys(theme.images);
		const color = (key) => readColor(given[key]);
		const tint = (key, fallback = [-1, -1, -1]) =>
			readTint(tintsIn[key]) ?? fallback;
		const images = {};
		for (const name of Object.keys(IMAGE_TOKENS)) {
			const value = readImage(imagesIn[name]);
			if (value) images[name] = value;
		}

		// the frame (GenerateFrameColorsFromTints)
		const frameGiven = color('frame');
		const frame = frameGiven ?? hslShift(DEFAULT_FRAME, tint('frame'));
		const frameBase = frameGiven ?? DEFAULT_FRAME;
		const frameInactive =
			color('frame_inactive') ??
			hslShift(frameBase, tint('frame_inactive', [-1, -1, 0.642]));
		// the toolbar and its text (SetFrameAndToolbarRelatedColors); white is
		// the toolbar a theme without one has
		const toolbar = color('toolbar') ?? WHITE;
		const toolbarText =
			color('toolbar_text') ?? blendForMinContrast(GREY800, toolbar);
		const buttonIcon =
			color('toolbar_button_icon') ?? hslShift(GREY700, tint('buttons'));
		const bookmarkText = color('bookmark_text') ?? toolbarText;
		const tabText = color('tab_text') ?? toolbarText;
		const backgroundTab =
			color('background_tab') ?? hslShift(frame, tint('background_tab'));
		const tabBackgroundText =
			color('tab_background_text') ??
			blendForMinContrast(
				toolbarText,
				backgroundTab,
				maxContrast(backgroundTab),
				7.98,
			);
		// the address box: at rest the toolbar pushed to 1.3:1, focused and its
		// suggestions omnibox_background (CustomThemeSupplier, the omnibox mixer)
		const end = endpointMinContrast(toolbar);
		const field = blendForMinContrast(
			toolbar,
			toolbar,
			contrast(toolbar, end) >= 1.3 ? end : maxContrast(end),
			1.3,
		);
		const omniboxGiven = color('omnibox_background');
		const omniboxTextGiven = color('omnibox_text');
		const omniboxText = omniboxTextGiven
			? paint(
					omniboxTextGiven,
					omniboxGiven ? paint(omniboxGiven, toolbar) : GREY100,
				)
			: maxContrast(field);
		const fieldActive = omniboxGiven
			? paint(omniboxGiven, toolbar)
			: maxContrast(omniboxText);
		const buttonBackground = color('button_background');
		// the new tab page (GenerateMissingNtpColors, the NTP mixer)
		const ntpGiven = color('ntp_background');
		const ntp = ntpGiven ? paint(ntpGiven, WHITE) : toolbar;
		const ntpImage = 'theme_ntp_background' in images;
		const ntpText =
			color('ntp_text') ?? (ntpImage || ntpGiven ? maxContrast(ntp) : BLACK);
		const ntpLink = color('ntp_link') ?? BLUE700;
		const ntpHeader =
			color('ntp_header') ?? color('ntp_section') ?? DEFAULT_NTP_HEADER;
		const accent = [...ntpHeader.slice(0, 3), 255];

		// Chromium picks no scheme from a theme (the user's setting does); the
		// panels and dialogs here take Light or Dark by the frame, with
		// Chromium's IsDark
		const scheme = isDark(frame) ? 'dark' : 'light';
		const muted = blend(ntpText, ntp, 160);
		const tokens = {
			page: css(ntp),
			text: css(ntpText),
			ntp: css(ntp),
			'ntp-text': css(ntpText),
			'ntp-position': alignment(props.ntp_background_alignment),
			'ntp-repeat': repeat(props.ntp_background_repeat),
			'ntp-size': 'auto',
			// the section border Chrome draws in the header colour at 0x50
			border: withAlpha(ntpHeader, 0.31),
			link: css(ntpLink),
			'link-hover': css(towardMaxContrast(ntpLink, 0x30)),
			'link-active': css(towardMaxContrast(ntpLink, 0x60)),
			'link-bright': css(ntpLink),
			focus: css(ntpLink),
			status: css(ntpLink),
			muted: css(muted),
			hover: css(towardMaxContrast(ntp, 0x10)),
			raised: css(towardMaxContrast(ntp, 0x18)),
			'raised-ring': css(towardMaxContrast(ntp, 0x40)),
			rail: css(towardMaxContrast(ntp, 0x40)),
			avatar: css(towardMaxContrast(ntp, 0x30)),
			accent: css(accent),
			'accent-hover': css(towardMaxContrast(accent, 0x20)),
			'accent-active': css(towardMaxContrast(accent, 0x40)),
			'accent-text': css(blendForMinContrast(accent, ntp)),
			'on-accent': css(maxContrast(accent)),
			frame: css(frame),
			'frame-text': css(tabBackgroundText),
			'frame-inactive': css(frameInactive),
			toolbar: css(toolbar),
			'toolbar-text': css(toolbarText),
			// button_background is the window's caption buttons' (minimize,
			// maximize, close), which this page has none of: the toolbar's
			// buttons have no background in Chrome
			'toolbar-button': 'transparent',
			'toolbar-fg-rgb': channels(toolbarText),
			navbar: css(toolbar),
			'navbar-icon': css(buttonIcon),
			'navbar-icon-hover': css(buttonIcon),
			'navbar-press': withAlpha(buttonIcon, 0.2),
			'navbar-press-icon': css(buttonIcon),
			field: css(field),
			'field-active': css(fieldActive),
			'field-text': css(omniboxText),
			'field-border': css(blend(omniboxText, field, 0x40)),
			'field-muted': css(blend(omniboxText, fieldActive, 0xa0)),
			'field-focus': css(ntpLink),
			'field-focus-ring': withAlpha(ntpLink, 0.25),
			'field-divider': css(blend(omniboxText, fieldActive, 0x18)),
			'field-hover': css(towardMaxContrast(fieldActive, 0x14)),
			'field-hover-text': css(omniboxText),
			'field-fg-rgb': channels(omniboxText),
			chip: css(blend(toolbarText, toolbar, 0x70)),
			'chip-text': css(maxContrast(blend(toolbarText, toolbar, 0x70))),
			// the tab manager is the window's tab strip: the inactive tabs'
			// colour (the frame with the background_tab tint) under the frame and
			// tab pictures, its pills the active tab's (the toolbar)
			recents:
				'var(--pm-tab-image) left top repeat-x, ' +
				'var(--pm-frame-overlay) left top no-repeat, ' +
				`var(--pm-frame-image) left top repeat-x, ${css(backgroundTab)}`,
			'tab-text': css(tabText),
			'tab-icon': css(tabBackgroundText),
			'tab-text-muted': css(tabBackgroundText),
			'tab-pill': css(toolbar),
			'tab-pill-border': withAlpha(tabText, 0.35),
			'tab-hover': css(towardMaxContrast(toolbar, 0x20)),
			'tab-line': withAlpha(tabBackgroundText, 0.2),
			'bookmark-text': css(bookmarkText),
		};
		// the omnibox's resting field is painted over by the image, as the
		// toolbar is in Chrome
		const out = {
			id: meta.id ?? (meta.extensionId ? `webstore:${meta.extensionId}` : ''),
			name: meta.name ?? 'Theme',
			source: meta.source ?? 'webstore',
			scheme,
			tokens,
			images,
		};
		if (meta.extensionId) out.extensionId = meta.extensionId;
		if (typeof meta.version === 'string') out.version = meta.version;
		// what Chromium resolved, for a caller (and the suite) to check
		Object.defineProperty(out, 'chrome', {
			value: Object.freeze({
				frame,
				frame_inactive: frameInactive,
				toolbar,
				toolbar_text: toolbarText,
				toolbar_button_icon: buttonIcon,
				tab_text: tabText,
				background_tab: backgroundTab,
				tab_background_text: tabBackgroundText,
				bookmark_text: bookmarkText,
				ntp_background: ntp,
				ntp_text: ntpText,
				ntp_link: ntpLink,
				ntp_header: ntpHeader,
				omnibox_background: fieldActive,
				omnibox_text: omniboxText,
				location_bar_background: field,
				button_background: buttonBackground,
				ntp_logo_alternate:
					props.ntp_logo_alternate !== undefined
						? props.ntp_logo_alternate === 1
						: ntpImage || (!!ntpGiven && isColorful(ntpGiven)),
			}),
		});
		return out;
	}
	const isBlob = (value) => typeof Blob === 'function' && value instanceof Blob;
	const SCALE = /^([1-9]\d{1,2})_percent$/;
	/**
	 * A manifest picture: a URL or a Blob, or one per scale as Chrome takes
	 * them ({"100_percent": ..., "200_percent": ...}); one at 100% alone is
	 * that picture
	 */
	function readImage(value) {
		if ((typeof value === 'string' && value) || isBlob(value)) return value;
		if (!value || typeof value !== 'object') return null;
		const scales = {};
		for (const [key, picture] of Object.entries(value))
			if (
				SCALE.test(key) &&
				((typeof picture === 'string' && picture) || isBlob(picture))
			)
				scales[key] = picture;
		const keys = Object.keys(scales);
		if (!keys.length) return null;
		return keys.length === 1 && keys[0] === '100_percent'
			? scales['100_percent']
			: scales;
	}
	const isColorful = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) >= 9;

	// ---- installed themes: tokens in localStorage, pictures in IndexedDB ---

	function readInstalled() {
		try {
			const list = JSON.parse(storage.get(INSTALLED_KEY) ?? '[]');
			return Array.isArray(list)
				? list.filter((theme) => validTheme(theme))
				: [];
		} catch {
			return [];
		}
	}
	let installed = []; // read once validTheme can run (below)
	const saveInstalled = () =>
		storage.set(
			INSTALLED_KEY,
			JSON.stringify(
				installed.map((theme) => ({
					...theme,
					// a picture is kept in IndexedDB; the list names which
					images: mapPictures(theme.images, (value) =>
						stored(value) ? 'stored' : value,
					),
				})),
			),
		);
	const stored = (value) =>
		value === 'stored' ||
		(typeof value === 'string' && value.startsWith('blob:'));
	/**
	 * a theme's pictures with `change(picture, name, scale)` made of each
	 * one (a picture per scale is a dictionary of them); one it makes
	 * nothing of is left out
	 */
	function mapPictures(images, change) {
		const out = {};
		for (const [name, value] of Object.entries(images)) {
			if (value && typeof value === 'object' && !isBlob(value)) {
				const scales = {};
				for (const [scale, picture] of Object.entries(value)) {
					const made = change(picture, name, scale);
					if (made) scales[scale] = made;
				}
				if (Object.keys(scales).length) out[name] = scales;
			} else {
				const made = change(value, name, null);
				if (made) out[name] = made;
			}
		}
		return out;
	}
	/** every picture of a theme's: [picture, name, scale or null] */
	const eachPicture = (images) => {
		const all = [];
		mapPictures(images, (...entry) => {
			all.push(entry);
		});
		return all;
	};

	let dbOpen = null;
	function db() {
		dbOpen ??= new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, 1);
			request.onupgradeneeded = () =>
				request.result.createObjectStore(DB_STORE);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return dbOpen;
	}
	async function idb(mode, run) {
		const database = await db();
		return new Promise((resolve, reject) => {
			const tx = database.transaction(DB_STORE, mode);
			const result = run(tx.objectStore(DB_STORE));
			tx.oncomplete = () => resolve(result?.result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}
	const imageKey = (id, name, scale) =>
		scale ? `${id}\n${name}\n${scale}` : `${id}\n${name}`;

	// blob: URLs of the pictures read back this visit, by theme id
	const pictures = new Map();
	async function loadPictures(theme) {
		if (pictures.has(theme.id)) return pictures.get(theme.id);
		const blobs = {};
		for (const [value, name, scale] of eachPicture(theme.images)) {
			if (!stored(value)) continue;
			try {
				const key = imageKey(theme.id, name, scale);
				blobs[key] = await idb('readonly', (store) => store.get(key));
			} catch {
				// no IndexedDB: the theme shows without this picture
			}
		}
		const urls = mapPictures(theme.images, (value, name, scale) => {
			if (!stored(value)) return value;
			const blob = blobs[imageKey(theme.id, name, scale)];
			return blob instanceof Blob ? URL.createObjectURL(blob) : null;
		});
		pictures.set(theme.id, urls);
		return urls;
	}
	/** a picture as a CSS image: one per scale is an image-set() */
	const cssImage = (value) =>
		typeof value === 'string'
			? cssURL(value)
			: `image-set(${Object.entries(value)
					.map(([scale, url]) => [parseInt(scale, 10) / 100, url])
					.sort((a, b) => a[0] - b[0])
					.map(([x, url]) => `${cssURL(url)} ${x}x`)
					.join(', ')})`;

	const ID = /^[\w.:@-]{1,128}$/;
	// a token's value is one CSS value: no declaration or rule ends in it,
	// and no url() (pictures come through `images`)
	const SAFE_VALUE = /^[^;{}<>\\]*$/;
	function validTheme(theme) {
		return (
			theme &&
			typeof theme === 'object' &&
			typeof theme.id === 'string' &&
			ID.test(theme.id) &&
			!builtin(theme.id) &&
			typeof theme.name === 'string' &&
			(theme.scheme === 'light' || theme.scheme === 'dark') &&
			theme.tokens &&
			typeof theme.tokens === 'object' &&
			theme.images &&
			typeof theme.images === 'object'
		);
	}
	const imageURL = (value) =>
		typeof value === 'string' && /^(blob:|data:image\/|https?:)/i.test(value);
	function cleanTheme(theme) {
		if (!validTheme(theme)) throw new TypeError('PMTheme: not a theme');
		const tokens = {};
		for (const [name, value] of Object.entries(theme.tokens)) {
			const key = name.replace(/^--pm-/, '');
			if (!TOKEN_SET.has(key) || Object.values(IMAGE_TOKENS).includes(key))
				continue;
			const text = String(value);
			if (!SAFE_VALUE.test(text) || /url\s*\(/i.test(text)) continue;
			tokens[key] = text;
		}
		const images = mapPictures(
			Object.fromEntries(
				Object.entries(theme.images).filter(([name]) => name in IMAGE_TOKENS),
			),
			(value, name, scale) =>
				(scale === null || SCALE.test(scale)) &&
				(imageURL(value) || isBlob(value))
					? value
					: null,
		);
		const clean = {
			id: theme.id,
			name: theme.name.slice(0, 200),
			source:
				theme.source === 'builtin' ? 'webstore' : theme.source || 'webstore',
			scheme: theme.scheme,
			tokens,
			images,
		};
		if (typeof theme.extensionId === 'string')
			clean.extensionId = theme.extensionId;
		if (typeof theme.version === 'string')
			clean.version = theme.version.slice(0, 64);
		return clean;
	}
	installed = readInstalled();

	// ---- applying ---------------------------------------------------------

	const systemDark =
		typeof matchMedia === 'function'
			? matchMedia('(prefers-color-scheme: dark)')
			: null;
	const systemScheme = () => (systemDark?.matches ? 'dark' : 'light');

	let custom = null; // the rule an installed theme writes its tokens into
	function customRule() {
		if (!custom) {
			const style = document.createElement('style');
			style.id = 'pmTheme';
			style.textContent = ':root[data-pm-theme][data-pm-custom] {}';
			(document.head ?? root).append(style);
			custom = style.sheet.cssRules[0].style;
		}
		return custom;
	}
	function clearCustom() {
		if (!custom) return;
		for (const name of [...custom]) custom.removeProperty(name);
	}

	const cssURL = (url) =>
		`url("${String(url).replace(/["\\\n]/g, encodeURIComponent)}")`;

	let choice = 'default';
	let shown = null; // the theme on screen (an object), for current()
	let applying = 0;

	/** put `theme` (a built-in or installed one) on the page */
	function paintTheme(theme) {
		const ticket = ++applying;
		shown = theme;
		const scheme =
			theme.id === 'system'
				? systemScheme()
				: theme.id === 'default'
					? null
					: theme.scheme;
		clearCustom();
		root.removeAttribute('data-pm-custom');
		root.removeAttribute('data-pm-ntp-image');
		root.removeAttribute('data-pm-attribution');
		if (scheme) root.setAttribute('data-pm-theme', scheme);
		else root.removeAttribute('data-pm-theme');
		root.dataset.pmChoice = theme.id;
		if (theme.source === 'builtin') return;
		const rule = customRule();
		for (const [name, value] of Object.entries(theme.tokens))
			rule.setProperty(`--pm-${name}`, value);
		// until its pictures are read back, none: never the theme's under it
		for (const token of Object.values(IMAGE_TOKENS))
			rule.setProperty(`--pm-${token}`, 'none');
		if (theme.images.theme_ntp_background)
			root.setAttribute('data-pm-ntp-image', '');
		root.setAttribute('data-pm-custom', '');
		loadPictures(theme).then((urls) => {
			if (ticket !== applying) return;
			for (const [name, url] of Object.entries(urls))
				if (IMAGE_TOKENS[name])
					rule.setProperty(`--pm-${IMAGE_TOKENS[name]}`, cssImage(url));
			// Chrome shows the attribution only with a new tab page picture
			if (urls.theme_ntp_attribution && urls.theme_ntp_background)
				root.setAttribute('data-pm-attribution', '');
		});
	}

	const events = new EventTarget();
	function changed(reason) {
		events.dispatchEvent(
			new CustomEvent('change', {
				detail: { reason, id: choice, theme: current() },
			}),
		);
	}

	function find(id) {
		return builtin(id) ?? installed.find((theme) => theme.id === id) ?? null;
	}

	function select(id, reason) {
		const theme = find(id) ?? builtin('default');
		choice = theme.id;
		paintTheme(theme);
		changed(reason);
	}

	function current() {
		const theme = shown ?? builtin('default');
		const scheme = theme.id === 'system' ? systemScheme() : theme.scheme;
		return {
			...theme,
			scheme,
			images: { ...theme.images, ...pictures.get(theme.id) },
		};
	}

	function list() {
		return [
			...BUILTIN.map((theme) =>
				theme.id === 'system'
					? { ...theme, scheme: systemScheme() }
					: { ...theme },
			),
			...installed.map((theme) => ({
				...theme,
				images: { ...theme.images, ...pictures.get(theme.id) },
			})),
		];
	}

	/**
	 * Show a theme: an id (built-in or installed) is chosen and kept; a theme
	 * object that is not installed is shown for this visit only (a preview).
	 */
	function apply(themeOrId) {
		const id = typeof themeOrId === 'string' ? themeOrId : themeOrId?.id;
		if (typeof id === 'string' && find(id)) {
			storage.set(CHOICE_KEY, id);
			select(id, 'apply');
			return current();
		}
		if (themeOrId && typeof themeOrId === 'object') {
			const theme = cleanTheme(themeOrId);
			theme.images = mapPictures(theme.images, (value) =>
				isBlob(value) ? URL.createObjectURL(value) : value,
			);
			pictures.set(theme.id, { ...theme.images });
			choice = theme.id;
			paintTheme(theme);
			changed('preview');
			return current();
		}
		throw new TypeError(`PMTheme: no theme ${id}`);
	}

	/**
	 * Keep a theme and switch to it, as Chrome does when one is installed;
	 * one with an installed theme's id replaces it (an update). Its pictures
	 * (blob: URLs or Blobs) are copied into IndexedDB, so they outlive the
	 * URLs. The same version of an installed theme again (the Web Store side
	 * hands the theme over on every load) changes nothing, and the choice
	 * stays. Resolves the installed theme.
	 */
	async function install(theme) {
		const clean = cleanTheme(theme);
		const had = installed.find((t) => t.id === clean.id);
		if (had && sameRelease(had, clean))
			return list().find((t) => t.id === clean.id);
		const blobs = new Map();
		for (const [value, name, scale] of eachPicture(clean.images)) {
			let blob = isBlob(value) ? value : null;
			if (!blob && /^(blob:|data:)/i.test(value)) {
				try {
					blob = await (await fetch(value)).blob();
				} catch {
					// gone already: the theme comes without this picture
				}
			}
			if (blob) blobs.set(imageKey(clean.id, name, scale), blob);
		}
		const kept = [];
		clean.images = mapPictures(clean.images, (value, name, scale) => {
			const key = imageKey(clean.id, name, scale);
			if (!blobs.has(key)) return /^(blob:|data:)/i.test(value) ? null : value;
			kept.push(key);
			return 'stored';
		});
		try {
			await idb('readwrite', (store) => {
				for (const [key, blob] of blobs) store.put(blob, key);
			});
		} catch {
			// no IndexedDB: the pictures last this visit
			clean.images = mapPictures(clean.images, (value, name, scale) => {
				const blob = blobs.get(imageKey(clean.id, name, scale));
				return blob ? URL.createObjectURL(blob) : value;
			});
			kept.length = 0;
		}
		await dropPictures(clean.id, kept);
		installed = [...installed.filter((t) => t.id !== clean.id), clean];
		saveInstalled();
		storage.set(CHOICE_KEY, clean.id);
		choice = clean.id;
		paintTheme(clean);
		changed('install');
		return current();
	}
	/** the same release of a theme: its version, values and pictures' names */
	const sameRelease = (a, b) =>
		a.version !== undefined &&
		a.version === b.version &&
		a.name === b.name &&
		a.scheme === b.scheme &&
		JSON.stringify(a.tokens) === JSON.stringify(b.tokens) &&
		JSON.stringify(eachPicture(a.images).map(([, n, x]) => [n, x])) ===
			JSON.stringify(eachPicture(b.images).map(([, n, x]) => [n, x]));

	/** forget the read-back URLs of a theme, and its stored pictures but `keep` */
	async function dropPictures(id, keep = []) {
		for (const [url] of eachPicture(pictures.get(id) ?? {}))
			if (String(url).startsWith('blob:')) URL.revokeObjectURL(url);
		pictures.delete(id);
		try {
			await idb('readwrite', (store) => {
				const request = store.getAllKeys(
					IDBKeyRange.bound(`${id}\n`, `${id}\n\uffff`),
				);
				request.onsuccess = () => {
					for (const key of request.result)
						if (!keep.includes(key)) store.delete(key);
				};
			});
		} catch {
			// nothing stored
		}
	}

	/**
	 * Remove an installed theme; the page goes back to Default when it was
	 * the one shown, as Chrome resets to its default theme. A 'remove' event
	 * names it (the Web Store side uninstalls the extension on it).
	 */
	async function remove(id) {
		const theme = installed.find((t) => t.id === id);
		if (!theme) return false;
		installed = installed.filter((t) => t.id !== id);
		saveInstalled();
		const wasShown = choice === id;
		if (wasShown) {
			storage.set(CHOICE_KEY, 'default');
			choice = 'default';
			paintTheme(builtin('default'));
		}
		await dropPictures(id);
		events.dispatchEvent(
			new CustomEvent('remove', {
				detail: { id, extensionId: theme.extensionId ?? null },
			}),
		);
		changed('remove');
		return true;
	}

	// Follow system: the scheme moves with the system's
	systemDark?.addEventListener('change', () => {
		if (choice !== 'system') return;
		paintTheme(builtin('system'));
		changed('system');
	});
	// another window of the demo chose or installed a theme
	addEventListener('storage', (event) => {
		if (event.key !== CHOICE_KEY && event.key !== INSTALLED_KEY) return;
		installed = readInstalled();
		for (const id of [...pictures.keys()])
			if (!installed.some((theme) => theme.id === id)) pictures.delete(id);
		select(storage.get(CHOICE_KEY) ?? 'default', 'storage');
	});
	// Chrome's inactive frame: the window without the focus (a proxied page in
	// a frame of it having the focus still counts as this window's)
	const syncActive = () =>
		root.toggleAttribute('data-pm-inactive', !document.hasFocus());
	addEventListener('blur', () => setTimeout(syncActive));
	addEventListener('focus', syncActive);

	globalThis.PMTheme = Object.freeze({
		apply,
		list,
		current,
		install,
		remove,
		// (the name the Web Store side calls it by)
		uninstall: remove,
		fromChrome,
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
		TOKENS,
		IMAGES: Object.freeze(Object.keys(IMAGE_TOKENS)),
	});

	// before the first paint
	const saved = storage.get(CHOICE_KEY);
	const first = (saved && find(saved)) || builtin('default');
	choice = first.id;
	paintTheme(first);
})();
