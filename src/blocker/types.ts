// The built-in blocker's options and the shapes that cross between the
// controller, the service worker and the inject (docs/adblock.md,
// docs/rust-plan.md section 8). The engine itself is rust/block, Brave's
// adblock crate behind the buffer ABI; src/server/blocker.ts runs it.
/** one filter list to fetch */
export interface AdblockList {
	url: string;
	/**
	 * the list may use the `trusted-*` scriptlets (uBlock Origin's own lists
	 * are; a list anyone can edit must not be, since those scriptlets edit
	 * the page's cookies, storage and responses)
	 */
	trusted?: boolean;
	/** a hosts file (`0.0.0.0 host` lines) rather than filter syntax */
	format?: 'standard' | 'hosts';
	/**
	 * the list's filter text itself, compiled in place of fetching `url`: the
	 * demo's "custom filters" editor hands its uBlock-syntax rules this way
	 * (docs/adblock.md "Custom filters"). `url` then only names the inline list
	 * for the engine's cache key, and `trusted` must stay false (the user's own
	 * rules do not get the `trusted-*` scriptlets). The blocker uses this string
	 * directly and never fetches the list.
	 */
	filters?: string;
	/**
	 * a human-readable name for the host application's UI (the demo's Filter
	 * Lists page). Never sent to the engine, never part of the cache key.
	 */
	name?: string;
}

/**
 * what the controllers' `setAdblockLists`/`refreshAdblockLists` report:
 * `'live'` when the change was pushed to the running blocker (it rebuilds the
 * engine and swaps it in once compiled), `'off'` when the host turned the
 * blocker off and there was nothing to apply.
 */
export interface AdblockApplied {
	applied: 'live' | 'off';
}

export interface AdblockOptions {
	/**
	 * the lists, fetched through the transport when the controller starts
	 * (and again daily); default EasyList, EasyPrivacy and uBlock Origin's
	 * own. A list that cannot be fetched is left out; with none fetched the
	 * blocker stays off
	 */
	lists?: (string | AdblockList)[];
	/**
	 * the redirect resources and scriptlets, Brave's `resources.json`
	 * format; default uBlock Origin's, built into `adblock-resources.json` in
	 * the directory (scripts/adblock-resources.mjs)
	 */
	resources?: string;
	/**
	 * a serialized engine the host built (`Engine::serialize` of the same
	 * crate version, docs/adblock.md), loaded instead of fetching and
	 * compiling the lists; `resources` are still fetched
	 */
	engine?: string;
	/** hours between refreshes of the lists; default 24 */
	refresh?: number;
}

/**
 * what the controller tells the service worker. The module is not here: it
 * travels with the other wasm modules, as `modules.blocker` of the
 * handshake (src/wasm/thread.ts)
 */
export interface AdblockInit {
	lists: AdblockList[];
	resources: string;
	engine?: string;
	refreshMs: number;
	/**
	 * the directory's engine snapshot of SNAPSHOT_LISTS, by its URL (with the
	 * hash of its bytes): with the option left out, a worker that has no
	 * engine stored serves it while the lists are fetched
	 */
	snapshot?: string;
	/**
	 * the host did not name the option, and the blocker is on because that
	 * is the default: what it cannot have (its module, the lists) leaves it
	 * off with one line on the console
	 */
	byDefault?: true;
}

/**
 * what the service worker hands a document's inject, from the crate's
 * `url_cosmetic_resources`: the cosmetic side of the lists for that page
 */
export interface AdblockPage {
	/** selectors to hide (`display: none !important`) */
	hide: string[];
	/** procedural and action filters, the crate's JSON, applied in the page (src/inject/dom/modules/Adblock.ts) */
	procedural: string[];
	/** generic class and id selectors excepted for this page (`#@#`), for the worker's generic lookups */
	exceptions: string[];
	/** the scriptlets, one script, rewritten by the worker, run before any page script */
	script: string;
	/** `$generichide`: the page asks for no generic rules */
	generichide: boolean;
}

/** the crate's JSON for a procedural or action filter (filters/cosmetic.rs) */
export interface ProceduralFilter {
	selector: { type: string; arg: string }[];
	action?: { type: string; arg?: string };
}

/**
 * Per-site "shields" (the demo's content-blocker UI, after Brave Shields):
 * what the user turned on or off for one host. It governs STomp's privacy
 * layers for that host alone: the ad/tracker blocker, HTTPS upgrading, the
 * cookie policy, blocking the page's own scripts, STomp's fingerprint
 * emulation, and forgetting the site on close. STomp's core rewriting is never
 * touched. A host with no entry of its own is governed by the controller's
 * '*' default entry when it sends one (the demo's "goodies on by default"),
 * else it is neutral (the blocker as the controller configured it, no forced
 * upgrade, cookies as SameSite allows, fingerprint emulation on).
 */
export type ShieldsMode = 'aggressive' | 'standard' | 'allow';

/**
 * The per-site anti-fingerprinting surfaces STomp can protect one at a time
 * (the Shields "Block fingerprinting" detail submenu), after Brave's model.
 *
 * `performanceMemory` is match-native: STomp synthesizes a plausible per-site
 * `performance.memory` so a frame does not read the same shared-process heap as
 * the page that embeds it (the Memory module; the one cross-site tell a shared
 * renderer leaks, and the signal Cloudflare Turnstile reads). It is ON by
 * default because a real-looking figure helps pass bot checks.
 *
 * The rest are Brave-style protections that make STomp *stop* matching native:
 * they farble (canvas, webgl, audio: deterministic per-site sub-perceptual
 * noise from a per-session seed and the document's eTLD+1, so a site is stable
 * within itself but cannot be correlated across sites) or limit/round (fonts,
 * screen, hardwareConcurrency, deviceMemory, mediaDevices, locale). A farbled
 * canvas or a capped core count is itself a signal that can FAIL a strict bot
 * check, the opposite of STomp's "look like real Chrome" baseline, so every one
 * of them is OFF by default (opt-in per site). See FP_DEFAULT_ON.
 *
 * The inject's FingerprintModule installs a surface's hook only when the
 * surface is active for the document (src/inject/dom/modules/Fingerprint.ts),
 * so a surface left at its default adds nothing to the frame's heap. The master
 * "Block fingerprinting" is the umbrella kill switch over the set (off: every
 * surface native); it does not force the opt-in surfaces on. New surfaces join
 * here as real hooks appear (src/server/shields.ts, docs/adblock.md).
 */
export type FpSurface =
	| 'performanceMemory'
	| 'canvas'
	| 'webgl'
	| 'audio'
	| 'fonts'
	| 'screen'
	| 'hardwareConcurrency'
	| 'deviceMemory'
	| 'mediaDevices'
	| 'locale';

/** every fp surface, in submenu order; the master toggle is the kill switch over it */
export const FP_SURFACES: FpSurface[] = [
	'performanceMemory',
	'canvas',
	'webgl',
	'audio',
	'fonts',
	'screen',
	'hardwareConcurrency',
	'deviceMemory',
	'mediaDevices',
	'locale',
];

/**
 * Which surfaces STomp protects by default. Only `performanceMemory` is on:
 * it matches native and helps bot checks. Every farbling/limiting surface is
 * off (opt-in), because turning it on makes STomp diverge from a real Chrome
 * and can fail a strict bot check (docs/adblock.md "Anti-fingerprinting"). A
 * surface with no per-site flag takes this value.
 */
export const FP_DEFAULT_ON: Record<FpSurface, boolean> = {
	performanceMemory: true,
	canvas: false,
	webgl: false,
	audio: false,
	fonts: false,
	screen: false,
	hardwareConcurrency: false,
	deviceMemory: false,
	mediaDevices: false,
	locale: false,
};

/** the surfaces active by default (performanceMemory alone), in FP_SURFACES order */
export const FP_DEFAULT_ON_SURFACES: FpSurface[] = FP_SURFACES.filter(
	(surface) => FP_DEFAULT_ON[surface],
);

/**
 * The surfaces whose protection needs the per-session farbling seed: canvas,
 * webgl and audio add deterministic per-site noise seeded from it. The
 * limiting/rounding surfaces are deterministic and need no seed, so the shell
 * carries the seed (Config.fingerprintSeed) only when one of these is active.
 */
export const FP_SEEDED_SURFACES: FpSurface[] = ['canvas', 'webgl', 'audio'];

/**
 * Whether two surface sets are the same set (order-independent): the shell
 * omits `fingerprintOn` from a document's config when the active set is the
 * default, so a default page's config is unchanged.
 */
export function sameSurfaceSet(a: FpSurface[], b: FpSurface[]): boolean {
	if (a.length !== b.length) return false;
	for (const surface of a) if (!b.includes(surface)) return false;
	return true;
}

/**
 * One host's shields, as the demo stores them (host-keyed, in its own
 * localStorage) and plumbs to the service worker. `enabled` is the master
 * toggle; down (or mode 'allow') turns every layer below off for the host.
 */
export interface SiteShields {
	/** the host the entry is keyed by (lower-cased) */
	host: string;
	/** shields up (true) or down (false); down turns every layer off for the host */
	enabled: boolean;
	/** the ad/tracker blocker: 'allow' is "allow all", the blocking layer off */
	mode: ShieldsMode;
	/** HTTPS upgrade for the host's requests: 'off' leaves http alone */
	httpsUpgrade?: 'strict' | 'upgrade' | 'off';
	/** block the page's own scripts (the inject enforces script-src 'none' against the page's code, src/csp.ts) */
	blockScripts?: boolean;
	/**
	 * The master fingerprint toggle (on by default): the umbrella kill switch
	 * over the per-surface set. Off, the site reads this browser's native values
	 * for every surface (STomp protects none, src/server/shields.ts). On, each
	 * surface takes its own `fingerprint` flag, or FP_DEFAULT_ON when it has
	 * none. It does not force the opt-in surfaces on; it only turns everything
	 * off when down.
	 */
	blockFingerprinting?: boolean;
	/**
	 * Per-surface fingerprint protection. An absent key takes the surface's
	 * default (FP_DEFAULT_ON: `performanceMemory` on, every farbling/limiting
	 * surface off). A key set true opts the surface in (STomp farbles or limits
	 * it for the host); false opts it out. The master `blockFingerprinting` off,
	 * or shields down, forces every surface off whatever these say. See
	 * FpSurface.
	 */
	fingerprint?: Partial<Record<FpSurface, boolean>>;
	/** the cookie policy for the host's requests */
	cookies?: 'all' | 'third-party' | 'allow';
	/** clear the host's cookies and virtualized storage when its last tab closes */
	forget?: boolean;
}

/**
 * Whether a host's shields turn every layer off: shields down, or the blocker
 * in "allow all" mode is still shields-up for the other layers, so this is
 * only the master switch. The per-layer getters on the server's store read it.
 */
export function shieldsDown(shields: SiteShields | undefined): boolean {
	return !!shields && !shields.enabled;
}

export const DEFAULT_LISTS: AdblockList[] = [
	{ url: 'https://easylist.to/easylist/easylist.txt', name: 'EasyList' },
	{
		url: 'https://easylist.to/easylist/easyprivacy.txt',
		name: 'EasyPrivacy',
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/filters.min.txt',
		name: 'uBlock Origin filters',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt',
		name: 'uBlock Origin unbreak',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/badware.min.txt',
		name: 'uBlock Origin badware risks',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/privacy.min.txt',
		name: 'uBlock Origin privacy',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/resource-abuse.txt',
		name: 'uBlock Origin resource abuse',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.min.txt',
		name: 'uBlock Origin quick fixes',
		trusted: true,
	},
];

/**
 * the default lists compiled into the directory's engine snapshot
 * (assets/adblock-snapshot.dat.gz, scripts/adblock-snapshot.mjs): uBlock
 * Origin's own, which carry its YouTube rules. With no engine stored (a first
 * visit) the worker serves the snapshot within milliseconds and the default
 * lists, fetched in the background, replace it once built. EasyList and
 * EasyPrivacy are left out of it for size: the eight lists were 3.6 MB
 * gzipped (8.6 MB raw), these six 1.1 MB (2.5 MB raw)
 */
export const SNAPSHOT_LISTS: AdblockList[] =
	/* @__PURE__ */ DEFAULT_LISTS.filter((list) => list.trusted);

/**
 * the file of the directory that holds uBlock Origin's scriptlets and
 * redirect resources (assets/adblock-resources.json): the lists' `+js()` and
 * `$redirect` rules name them, and the lists are written for the uBO release
 * that shipped them, as the file is built from one
 */
export const DEFAULT_RESOURCES = 'adblock-resources.json';

export const DEFAULT_REFRESH_HOURS = 24;

/**
 * the options as the host gave them, resolved: every list an object, every
 * default filled in. Only `false` is off: an option left out is the default
 * lists, as `true` is
 */
export function resolveAdblockOptions(
	given: boolean | AdblockOptions | null | undefined,
	/** where the default resources are served (the directory's copy) */
	resources: string = DEFAULT_RESOURCES,
	/** where the directory's engine snapshot is served, for the default */
	snapshot?: string,
): AdblockInit | null {
	if (given === false) return null;
	const options = given === true || !given ? {} : given;
	const lists = (options.lists ?? DEFAULT_LISTS).map((list) =>
		typeof list === 'string' ? { url: list } : { ...list },
	);
	const hours = Number(options.refresh);
	return {
		lists,
		resources: options.resources ?? resources,
		...(options.engine ? { engine: options.engine } : {}),
		refreshMs:
			(Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_REFRESH_HOURS) *
			3600_000,
		...(given === undefined || given === null
			? { byDefault: true, ...(snapshot ? { snapshot } : {}) }
			: {}),
	};
}

/**
 * The same blocker options with a different set of lists: the host application
 * changed them at runtime (the demo's Filter Lists editor, docs/adblock.md).
 * The resources and the refresh interval are kept; a prebuilt `engine` is
 * dropped, since the engine is the old lists compiled and cannot take new ones.
 * The lists are normalized as `resolveAdblockOptions` does, and `byDefault` is
 * cleared: a list the user chose, unlike one that is merely the default, is the
 * user's to hear of when it cannot be fetched.
 */
export function withAdblockLists(
	base: AdblockInit,
	lists: (string | AdblockList)[],
): AdblockInit {
	// kept: the resources and the refresh interval; dropped: a prebuilt engine
	// (it is the old lists compiled) and byDefault (the user chose these lists)
	return {
		lists: lists.map((list) =>
			typeof list === 'string' ? { url: list } : { ...list },
		),
		resources: base.resources,
		refreshMs: base.refreshMs,
	};
}

/**
 * the request type the lists know, from a fetch event's destination (the
 * browser's `RequestDestination`): what uBlock Origin's webRequest listener
 * would see for the same load. Anything else is `other`, which the crate
 * also gives an unknown name, so the mapping is spelled out here
 */
export function requestTypeOf(
	destination: string,
	navigation: boolean,
	topLevel: boolean,
): string {
	if (navigation) return topLevel ? 'document' : 'subdocument';
	switch (destination) {
		case '':
		case 'empty':
			return 'xmlhttprequest';
		case 'script':
		case 'worker':
		case 'sharedworker':
		case 'serviceworker':
		case 'audioworklet':
		case 'paintworklet':
		case 'json':
			return 'script';
		case 'style':
			return 'stylesheet';
		case 'image':
			return 'image';
		case 'font':
			return 'font';
		case 'iframe':
		case 'frame':
		case 'fencedframe':
			return 'subdocument';
		case 'document':
			return 'document';
		case 'audio':
		case 'video':
		case 'track':
			return 'media';
		case 'object':
		case 'embed':
			return 'object';
		case 'report':
			return 'csp_report';
		case 'xslt':
			return 'xslt';
		case 'manifest':
			return 'other';
		default:
			return 'other';
	}
}
