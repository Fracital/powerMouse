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

/** the options as the host gave them, resolved: every list an object, every default filled in */
export function resolveAdblockOptions(
	given: boolean | AdblockOptions | undefined,
): AdblockInit | null {
	if (!given) return null;
	const options = given === true ? {} : given;
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
