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
	 * format; default Brave's published set (uBlock Origin's scriptlets)
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
	 * the host did not name the option, and the blocker is on because that
	 * is the default: what it cannot have (its module, the lists) leaves it
	 * off with one line on the console, and no navigation waits for the
	 * lists to be fetched
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
 * layers for that host alone, the ad/tracker blocker, HTTPS upgrading and
 * the cookie policy today, and never STomp's core rewriting or fingerprint
 * emulation, which stay on whatever the shields say. A host with no entry
 * keeps STomp's defaults (the blocker as the controller configured it, no
 * forced upgrade, cookies as SameSite allows); the demo writes an entry the
 * first time a tab lands on a host, so its "goodies on" defaults then apply.
 */
export type ShieldsMode = 'aggressive' | 'standard' | 'allow';

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
	/** block the page's own scripts (framework flag; enforcement is phase 2) */
	blockScripts?: boolean;
	/** STomp's fingerprint emulation is core and on; the UI's toggle (framework flag, phase 2) */
	blockFingerprinting?: boolean;
	/** the cookie policy for the host's requests */
	cookies?: 'all' | 'third-party' | 'allow';
	/** clear the host's cookies and storage when its last tab closes (cookies wired, storage phase 2) */
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
	{ url: 'https://easylist.to/easylist/easylist.txt' },
	{ url: 'https://easylist.to/easylist/easyprivacy.txt' },
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/filters.min.txt',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/badware.min.txt',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/privacy.min.txt',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/resource-abuse.txt',
		trusted: true,
	},
	{
		url: 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.min.txt',
		trusted: true,
	},
];

export const DEFAULT_RESOURCES =
	'https://raw.githubusercontent.com/brave/adblock-resources/master/dist/resources.json';

export const DEFAULT_REFRESH_HOURS = 24;

/**
 * the options as the host gave them, resolved: every list an object, every
 * default filled in. Only `false` is off: an option left out is the default
 * lists, as `true` is
 */
export function resolveAdblockOptions(
	given: boolean | AdblockOptions | null | undefined,
): AdblockInit | null {
	if (given === false) return null;
	const options = given === true || !given ? {} : given;
	const lists = (options.lists ?? DEFAULT_LISTS).map((list) =>
		typeof list === 'string' ? { url: list } : { ...list },
	);
	const hours = Number(options.refresh);
	return {
		lists,
		resources: options.resources ?? DEFAULT_RESOURCES,
		...(options.engine ? { engine: options.engine } : {}),
		refreshMs:
			(Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_REFRESH_HOURS) *
			3600_000,
		...(given === undefined || given === null ? { byDefault: true } : {}),
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
