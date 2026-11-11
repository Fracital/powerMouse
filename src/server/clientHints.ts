import { openDB, type IDBPDatabase } from 'idb';
import { potentiallyTrustworthy } from '../mixedContent';
import type { ClientHintsReport } from '../transport/messages';
import {
	ENABLED_FOR_ALL,
	HINT_FEATURES,
	isHintName,
	parseAcceptCH,
	SENT_BY_DEFAULT,
} from './hintNames';

/**
 * Client hints the way Chrome sends them, per proxied origin. The browser
 * sees the proxy origin only: it would keep a site's Accept-CH for the
 * proxy origin (every proxied site would then get it), retry the shell for
 * a Critical-CH, and decide delegation in proxy URL space, where every
 * request is same-origin. So the worker strips the hints the browser added
 * and builds them from Chrome's rules between the real origins
 * (docs/client-hints.md, measured against Chrome 152):
 *
 * - a top-level document's Accept-CH is kept for its origin (persisted, like
 *   Chrome's preference store) and applies at once to that document's own
 *   subresources; a frame's or a subresource's Accept-CH is ignored. A
 *   later top-level Accept-CH replaces the set; an empty one clears it.
 * - a top-level navigation whose Critical-CH names an accepted hint it did
 *   not carry is sent once more with the hints (Chrome restarts it).
 * - a document's subresource carries a hint when the top-level origin
 *   accepted it (or the top document's `<meta http-equiv="Accept-CH">` or
 *   `delegate-ch` named it) and the document's permissions policy allows
 *   its `ch-*` feature for the resource's origin: `self` by default, `*` for
 *   the low-entropy `sec-ch-ua`, `-mobile`, `-platform` and Save-Data.
 * - a frame's navigation is decided by the main frame's policy for the
 *   frame's origin, as the browser process decides it, with the parent's
 *   `delegate-ch` and the frame's `allow` attribute on top.
 *
 * The values are the real browser's: its userAgentData, device memory and
 * network estimate (read here, in the worker), and the pixel ratio, viewport
 * and media preferences each proxied document reports (CLIENT_HINTS).
 */

/** an allowlist of a permissions policy */
export interface Allowlist {
	all: boolean;
	self: boolean;
	origins: string[];
}

function originPattern(text: string): string | null {
	try {
		const url = new URL(text.replace('://*.', '://wildcard-placeholder.'));
		if (!/^https?:$/.test(url.protocol)) return null;
		return url.origin.replace('://wildcard-placeholder.', '://*.');
	} catch (error) {
		return null;
	}
}

/** whether `list` allows `origin` for a document of origin `self` */
export function allowlistMatches(
	list: Allowlist,
	origin: string,
	self: string,
): boolean {
	if (list.all) return true;
	if (list.self && origin === self) return true;
	for (const pattern of list.origins) {
		if (pattern === origin) return true;
		const star = pattern.indexOf('://*.');
		if (star !== -1) {
			const scheme = pattern.slice(0, star);
			const suffix = pattern.slice(star + 4);
			if (origin.startsWith(`${scheme}://`) && origin.endsWith(suffix))
				return true;
		}
	}
	return false;
}

/**
 * A Permissions-Policy header (a structured dictionary): each feature with
 * its allowlist, `*`, `self`, quoted origins or an inner list of those. A
 * member that is none of these is skipped, as Chrome skips it.
 */
export function parsePermissionsPolicy(
	value: string | null,
): Map<string, Allowlist> {
	const policy = new Map<string, Allowlist>();
	if (!value) return policy;
	// split on commas outside parentheses and quotes
	const members: string[] = [];
	let depth = 0;
	let quoted = false;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (quoted) {
			if (c === '\\') i++;
			else if (c === '"') quoted = false;
		} else if (c === '"') quoted = true;
		else if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (c === ',' && depth === 0) {
			members.push(value.slice(start, i));
			start = i + 1;
		}
	}
	members.push(value.slice(start));
	for (const member of members) {
		const match = /^\s*([a-z][a-z0-9_\-.*]*)\s*=\s*(.*?)\s*$/.exec(member);
		if (!match) continue;
		const [, feature, raw] = match;
		const items = raw.startsWith('(')
			? (raw
					.replace(/^\(|\)(;.*)?$/g, '')
					.match(/"(?:[^"\\]|\\.)*"|[^\s"]+/g) ?? [])
			: [raw.split(';')[0]];
		const list: Allowlist = { all: false, self: false, origins: [] };
		for (const item of items) {
			if (item === '*') list.all = true;
			else if (item === 'self') list.self = true;
			else if (item.startsWith('"')) {
				const origin = originPattern(item.slice(1, -1));
				if (origin) list.origins.push(origin);
			}
		}
		policy.set(feature, list);
	}
	return policy;
}

/**
 * An iframe's `allow` attribute: features separated by semicolons, each
 * followed by its allowlist (`src` when none: the frame's own origin)
 */
export function parseAllowAttribute(
	value: string,
	src: string,
): Map<string, Allowlist> {
	const policy = new Map<string, Allowlist>();
	for (const directive of value.split(';')) {
		const [feature, ...items] = directive.trim().split(/\s+/);
		if (!feature) continue;
		const list: Allowlist = { all: false, self: false, origins: [] };
		if (!items.length) list.origins.push(src);
		for (const item of items) {
			const token = item.replace(/^'|'$/g, '');
			if (token === '*') list.all = true;
			else if (token === 'src') list.origins.push(src);
			else if (token === 'self') list.self = true;
			else if (token !== 'none') {
				const origin = originPattern(token);
				if (origin) list.origins.push(origin);
			}
		}
		policy.set(feature.toLowerCase(), list);
	}
	return policy;
}

/** a `<meta http-equiv="delegate-ch">` content: each hint with the origins it is delegated to */
export function parseDelegateCH(value: string): Map<string, string[]> {
	const delegated = new Map<string, string[]>();
	for (const entry of value.toLowerCase().split(';')) {
		const [hint, ...origins] = entry.trim().split(/\s+/);
		if (!hint || !isHintName(hint)) continue;
		const valid: string[] = [];
		for (const text of origins) {
			try {
				const url = new URL(text);
				if (/^https?:$/.test(url.protocol)) valid.push(url.origin);
			} catch (error) {
				// an invalid origin is dropped
			}
		}
		delegated.set(hint, valid);
	}
	return delegated;
}

/** the hints-relevant `<meta http-equiv>` of a document's markup */
export function metaHints(markup: string): {
	accept: string[];
	delegate: Map<string, string[]>;
} {
	const accept: string[] = [];
	const delegate = new Map<string, string[]>();
	const metas = markup.match(/<meta\b[^>]*>/gi) ?? [];
	for (const tag of metas) {
		const attribute = (name: string) => {
			const match = new RegExp(
				`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
				'i',
			).exec(tag);
			return match ? (match[1] ?? match[2] ?? match[3]) : null;
		};
		const equiv = attribute('http-equiv')?.trim().toLowerCase();
		const content = attribute('content');
		if (content === null) continue;
		if (equiv === 'accept-ch')
			for (const hint of parseAcceptCH(content) ?? [])
				if (!accept.includes(hint)) accept.push(hint);
		if (equiv === 'delegate-ch')
			for (const [hint, origins] of parseDelegateCH(content))
				delegate.set(hint, [...(delegate.get(hint) ?? []), ...origins]);
	}
	return { accept, delegate };
}

/** a document's view of the permissions policy for the `ch-*` features */
export interface HintsPolicy {
	/** the document's own origin (its `self`) */
	self: string;
	/** features its parent, or the frame's container, turned off for it */
	disabled: Set<string>;
	/** its own declarations (its header, its delegate-ch) */
	declared: Map<string, Allowlist>;
}

/** whether `policy` lets a request to `origin` carry the hints of `feature` */
export function policyAllows(
	policy: HintsPolicy,
	feature: string,
	origin: string,
): boolean {
	if (policy.disabled.has(feature)) return false;
	const declared = policy.declared.get(feature);
	if (declared) return allowlistMatches(declared, origin, policy.self);
	return ENABLED_FOR_ALL.has(feature) || origin === policy.self;
}

/** a proxied document, as the hints of its requests go */
export interface HintsDocument {
	/** its real origin */
	origin: string;
	/** the proxied top's origin (its own for a top-level document) */
	top: string;
	topLevel: boolean;
	/** what its subresources may carry: its top origin's set when it committed, its meta's */
	enabled: Set<string>;
	policy: HintsPolicy;
	/** its delegate-ch, which its frames' containers carry */
	delegated: Map<string, Allowlist>;
	/** its viewport, as it reported it */
	viewport?: [number, number];
	/** a frame's parent's origin (its container's `self`) */
	parentOrigin: string;
	/**
	 * whether the document itself may use each powerful feature
	 * (permissions.ts): the browser decides it for the proxy origin, where
	 * every frame is same-origin with its parent
	 */
	features: Map<string, boolean>;
	/**
	 * whether the document may use each feature the browser knows, as
	 * natively: what reaches the browser (browserPolicy)
	 */
	allFeatures: Map<string, boolean>;
}

/**
 * Every policy-controlled feature Chrome 152 or 156 knows
 * (`document.featurePolicy.features()`, measured on both). A document's
 * policy reaches the browser as `Permissions-Policy` naming the ones it may
 * not use (browserPolicy), so the browser itself refuses them and
 * `document.featurePolicy` reads as natively. `cross-origin-isolated` is
 * not among them: the host's isolation decides it (src/isolation.ts).
 */
const BROWSER_FEATURES: string[] = [
	'accelerometer',
	'aria-notify',
	'autoplay',
	'browsing-topics',
	'camera',
	'captured-surface-control',
	'ch-device-memory',
	'ch-downlink',
	'ch-dpr',
	'ch-ect',
	'ch-prefers-color-scheme',
	'ch-prefers-reduced-motion',
	'ch-prefers-reduced-transparency',
	'ch-rtt',
	'ch-save-data',
	'ch-ua',
	'ch-ua-arch',
	'ch-ua-bitness',
	'ch-ua-form-factors',
	'ch-ua-full-version',
	'ch-ua-full-version-list',
	'ch-ua-high-entropy-values',
	'ch-ua-mobile',
	'ch-ua-model',
	'ch-ua-platform',
	'ch-ua-platform-version',
	'ch-ua-wow64',
	'ch-viewport-height',
	'ch-viewport-width',
	'ch-width',
	'clipboard-read',
	'clipboard-write',
	'compute-pressure',
	'deferred-fetch',
	'deferred-fetch-minimal',
	'digital-credentials-create',
	'digital-credentials-get',
	'display-capture',
	'encrypted-media',
	'fullscreen',
	'gamepad',
	'geolocation',
	'gyroscope',
	'hid',
	'identity-credentials-get',
	'idle-detection',
	'interest-cohort',
	'join-ad-interest-group',
	'keyboard-map',
	'language-detector',
	'language-model',
	'local-fonts',
	'local-network',
	'local-network-access',
	'loopback-network',
	'magnetometer',
	'media-playback-while-not-visible',
	'microphone',
	'midi',
	'on-device-speech-recognition',
	'otp-credentials',
	'payment',
	'picture-in-picture',
	'private-aggregation',
	'private-state-token-issuance',
	'private-state-token-redemption',
	'publickey-credentials-create',
	'publickey-credentials-get',
	'run-ad-auction',
	'screen-wake-lock',
	'serial',
	'shared-storage',
	'shared-storage-select-url',
	'speaker-selection',
	'storage-access',
	'summarizer',
	'sync-xhr',
	'translator',
	'unload',
	'usb',
	'window-management',
	'xr-spatial-tracking',
];

/**
 * The features one of those versions does not know, by the first major
 * version that does (`since`) or the last (`until`): a header naming a
 * feature the browser does not know earns a console warning
 */
const FEATURE_VERSIONS: Record<string, { since?: number; until?: number }> = {
	'digital-credentials-create': { since: 156 },
	'media-playback-while-not-visible': { since: 156 },
	'speaker-selection': { since: 156 },
	'join-ad-interest-group': { until: 155 },
	'private-aggregation': { until: 155 },
	'run-ad-auction': { until: 155 },
	'shared-storage': { until: 155 },
	'shared-storage-select-url': { until: 155 },
};

/** the browser's Chrome major version, from the worker's own user agent */
function browserMajor(): number {
	const match = /Chrome\/(\d+)/.exec(globalThis.navigator?.userAgent ?? '');
	return match ? Number(match[1]) : 0;
}

/** the features of BROWSER_FEATURES the browser running this worker knows */
let knownFeatures: string[] | undefined;
function browserFeatures(): string[] {
	if (knownFeatures) return knownFeatures;
	const major = browserMajor();
	return (knownFeatures = BROWSER_FEATURES.filter((feature) => {
		const versions = FEATURE_VERSIONS[feature];
		if (!versions || !major) return true;
		if (versions.since !== undefined && major < versions.since) return false;
		if (versions.until !== undefined && major > versions.until) return false;
		return true;
	}));
}

/**
 * The features whose default allowlist is `*`: a frame of another origin
 * has them without an allow attribute (measured on Chrome 152 and 156);
 * every other one's is `self`
 */
const DEFAULT_ALL_FEATURES = new Set([
	'aria-notify',
	'browsing-topics',
	'ch-save-data',
	'ch-ua',
	'ch-ua-high-entropy-values',
	'ch-ua-mobile',
	'ch-ua-platform',
	'deferred-fetch-minimal',
	'gamepad',
	'interest-cohort',
	'join-ad-interest-group',
	'media-playback-while-not-visible',
	'picture-in-picture',
	'private-aggregation',
	'private-state-token-issuance',
	'private-state-token-redemption',
	'run-ad-auction',
	'shared-storage',
	'shared-storage-select-url',
	'storage-access',
	'sync-xhr',
	'unload',
]);

/**
 * The policy-controlled features behind the permissions a page asks for
 * (default allowlist `self`): a frame of another origin gets one only when
 * its element's allow attribute names it
 */
export const POLICY_FEATURES = [
	'geolocation',
	'camera',
	'microphone',
	'clipboard-read',
	'clipboard-write',
	'midi',
	'local-fonts',
	'idle-detection',
	'window-management',
	'display-capture',
	'captured-surface-control',
	'local-network-access',
	'screen-wake-lock',
	// an AudioContext's output (setSinkId), a feature since Chrome 156
	'speaker-selection',
];

/** a document's powerful features, as Chrome's permissions policy decides them */
function featuresOf(
	origin: string,
	topLevel: boolean,
	declared: Map<string, Allowlist>,
	parent: HintsDocument | null,
	parentOrigin: string,
	container: Map<string, Allowlist>,
	list: Iterable<string> = POLICY_FEATURES,
	parentFeatures: (doc: HintsDocument) => Map<string, boolean> = (doc) =>
		doc.features,
): Map<string, boolean> {
	const features = new Map<string, boolean>();
	for (const feature of list) {
		// its parent lets it have the feature: the parent has it, and the
		// parent's header (when it names the feature) names this origin
		const fromParent =
			topLevel ||
			((!parent || parentFeatures(parent).get(feature) !== false) &&
				(!parent?.policy.declared.has(feature) ||
					allowlistMatches(
						parent.policy.declared.get(feature)!,
						origin,
						parent.origin,
					)));
		// the container's allow attribute, else the default allowlist (self,
		// or * for the few features every frame has)
		const named = container.get(feature);
		const inherited =
			topLevel ||
			(fromParent &&
				(named
					? allowlistMatches(named, origin, parentOrigin)
					: DEFAULT_ALL_FEATURES.has(feature) || origin === parentOrigin));
		const own = declared.get(feature);
		features.set(
			feature,
			inherited && (!own || allowlistMatches(own, origin, origin)),
		);
	}
	return features;
}

const documents = new Map<string, HintsDocument>();
const DOCUMENTS_KEPT = 512;
const withoutHash = (url: string) => url.split('#')[0];

function keep(key: string, doc: HintsDocument) {
	documents.delete(key);
	if (documents.size >= DOCUMENTS_KEPT)
		documents.delete(documents.keys().next().value!);
	documents.set(key, doc);
}

/** the latest top-level document of each origin, the main frame its frames are judged by */
const tops = new Map<string, HintsDocument>();

/** the document a client is, or the one served at one of `routed` */
export function hintsDocument(
	clientId: string | undefined,
	...routed: (string | null | undefined)[]
): HintsDocument | null {
	if (clientId) {
		const known = documents.get(`client ${clientId}`);
		if (known) return known;
	}
	for (const url of routed) {
		const known = url ? documents.get(`url ${withoutHash(url)}`) : undefined;
		if (known) {
			if (clientId) keep(`client ${clientId}`, known);
			return known;
		}
	}
	return null;
}

/** the main frame a frame of `top` is judged by */
export function topDocument(top: string): HintsDocument | null {
	return tops.get(top) ?? null;
}

/** display state, reported by the proxied documents (and the controller) */
interface Display {
	dpr: number;
	colorScheme: 'light' | 'dark';
	reducedMotion: 'no-preference' | 'reduce';
	reducedTransparency: 'no-preference' | 'reduce';
}
let display: Display | null = null;
/** the viewport of the latest top-level document that reported one, per controller address */
const topViewports = new Map<string, [number, number]>();

/** a document (or the controller) told the worker what it sees */
export function recordReport(
	directory: string,
	clientId: string | undefined,
	report: ClientHintsReport,
) {
	const number = (value: unknown, max: number) =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0
			? Math.min(value, max)
			: null;
	const dpr = number(report.dpr, 32);
	if (dpr !== null && dpr > 0)
		display = {
			dpr,
			colorScheme: report.colorScheme === 'dark' ? 'dark' : 'light',
			reducedMotion:
				report.reducedMotion === 'reduce' ? 'reduce' : 'no-preference',
			reducedTransparency:
				report.reducedTransparency === 'reduce' ? 'reduce' : 'no-preference',
		};
	const width = number(report.viewport?.[0], 1e5);
	const height = number(report.viewport?.[1], 1e5);
	if (!clientId) {
		// the controller's: a host frame about to navigate
		if (report.top && width && height)
			topViewports.set(directory, [Math.round(width), Math.round(height)]);
		return;
	}
	const doc = documents.get(`client ${clientId}`);
	if (doc && width !== null && height !== null) {
		doc.viewport = [Math.round(width), Math.round(height)];
		if (doc.topLevel) topViewports.set(directory, doc.viewport);
	}
	if (doc?.topLevel && Array.isArray(report.accept))
		for (const hint of report.accept)
			if (typeof hint === 'string' && isHintName(hint)) {
				doc.enabled.add(hint);
			}
}

// the origins' accepted hints (Chrome's preference store), persisted
let store: Promise<IDBPDatabase | null> | null = null;
const accepted = new Map<string, string[]>();
let loaded: Promise<void> | null = null;

function openStore(): Promise<IDBPDatabase | null> {
	store ??= openDB('stompClientHints', 1, {
		upgrade: (db) => {
			db.createObjectStore('accepted');
		},
	}).catch(() => null);
	return store;
}

function loadAccepted(): Promise<void> {
	loaded ??= (async () => {
		const db = await openStore();
		if (!db) return;
		try {
			const tx = db.transaction('accepted', 'readonly');
			const keys = (await tx.store.getAllKeys()) as string[];
			const values = (await tx.store.getAll()) as string[][];
			await tx.done;
			keys.forEach((key, i) => {
				if (!accepted.has(key) && Array.isArray(values[i]))
					accepted.set(key, values[i]);
			});
		} catch (error) {
			// no store: the session's own answers only
		}
	})();
	return loaded;
}

/** the hints `origin` accepted, as the browser keeps them */
export async function acceptedHints(origin: string): Promise<Set<string>> {
	await loadAccepted();
	return new Set(accepted.get(origin) ?? []);
}

/** keep a top-level response's Accept-CH for its origin; the set now accepted */
export async function persistAcceptCH(
	origin: string,
	header: string | null,
): Promise<Set<string>> {
	await loadAccepted();
	if (header !== null) {
		const hints = parseAcceptCH(header);
		if (hints !== null) {
			accepted.set(origin, hints);
			const db = await openStore();
			try {
				if (hints.length) await db?.put('accepted', hints, origin);
				else await db?.delete('accepted', origin);
			} catch (error) {
				// kept for this worker's life only
			}
		}
	}
	return new Set(accepted.get(origin) ?? []);
}

/**
 * The document a navigation creates, recorded once its response is in:
 * its own Permissions-Policy, under what its parent (for a frame, the main
 * frame) allows it, and the hints it may send
 */
export function recordDocument(
	routed: string,
	clientId: string | undefined,
	init: {
		origin: string;
		top: string;
		topLevel: boolean;
		enabled: Set<string>;
		permissionsPolicy: string | null;
		/** the parent document, when the worker knows it (a frame's) */
		parent: HintsDocument | null;
		/** a frame element's allow attribute, when its parent said */
		allow?: string;
	},
): HintsDocument {
	const declared = parsePermissionsPolicy(init.permissionsPolicy);
	// a frame inherits what its parent's policy allows its origin (the
	// parent's delegate-ch included), unless its element's allow attribute
	// names the feature: then the attribute decides (Chrome lets an
	// iframe's allow delegate a hint its parent's policy keeps to itself,
	// measured)
	const disabled = new Set<string>();
	const parent = init.parent;
	const parentOrigin = parent?.origin ?? init.top;
	const container = parseAllowAttribute(init.allow ?? '', init.origin);
	if (!init.topLevel)
		for (const feature of new Set(Object.values(HINT_FEATURES))) {
			const named = container.get(feature);
			const allowed = named
				? allowlistMatches(named, init.origin, parentOrigin)
				: parent
					? policyAllows(parent.policy, feature, init.origin)
					: ENABLED_FOR_ALL.has(feature) || init.origin === init.top;
			if (!allowed) disabled.add(feature);
		}
	const doc: HintsDocument = {
		origin: init.origin,
		top: init.top,
		topLevel: init.topLevel,
		enabled: new Set(init.enabled),
		policy: { self: init.origin, disabled, declared },
		delegated: new Map(),
		parentOrigin,
		features: featuresOf(
			init.origin,
			init.topLevel,
			declared,
			parent,
			parentOrigin,
			container,
		),
		allFeatures: featuresOf(
			init.origin,
			init.topLevel,
			declared,
			parent,
			parentOrigin,
			container,
			browserFeatures(),
			(doc) => doc.allFeatures,
		),
	};
	keep(`url ${withoutHash(routed)}`, doc);
	if (clientId) keep(`client ${clientId}`, doc);
	if (init.topLevel) tops.set(init.origin, doc);
	return doc;
}

/**
 * The `Permissions-Policy` a document is served to the browser with: every
 * feature the document may not use, off. The browser sees each proxied
 * document as same-origin with its parent, so a frame of another site would
 * otherwise have every `self` feature, and a page's own policy (which never
 * reaches the browser as the page sent it: its origins are not the proxy's)
 * would turn nothing off. Null when the document may use them all.
 */
export function browserPolicy(doc: HintsDocument): string | null {
	const off: string[] = [];
	for (const [feature, allowed] of doc.allFeatures)
		if (!allowed) off.push(`${feature}=()`);
	return off.length ? off.join(', ') : null;
}

/** a top-level document's static meta: its own hints, and the hints it delegates */
export function applyMeta(doc: HintsDocument, markup: string) {
	if (!doc.topLevel) return;
	const { accept, delegate } = metaHints(markup);
	for (const hint of accept) {
		doc.enabled.add(hint);
	}
	for (const [hint, origins] of delegate) {
		doc.enabled.add(hint);
		const feature = HINT_FEATURES[hint];
		// the delegation overrides the header's allowlist for the feature:
		// its own origin and the named ones
		const list: Allowlist = { all: false, self: true, origins };
		doc.policy.declared.set(feature, list);
		doc.delegated.set(feature, list);
	}
}

interface UAValues {
	brands: { brand: string; version: string }[];
	fullVersionList: { brand: string; version: string }[];
	mobile: boolean;
	platform: string;
	architecture: string;
	bitness: string;
	model: string;
	platformVersion: string;
	uaFullVersion: string;
	wow64: boolean;
	formFactors: string[];
}

let uaValues: Promise<UAValues | null> | null = null;

function userAgentValues(): Promise<UAValues | null> {
	uaValues ??= (async () => {
		const data = (
			navigator as Navigator & {
				userAgentData?: {
					getHighEntropyValues(hints: string[]): Promise<UAValues>;
				};
			}
		).userAgentData;
		if (!data) return null;
		try {
			return await data.getHighEntropyValues([
				'architecture',
				'bitness',
				'fullVersionList',
				'model',
				'platformVersion',
				'uaFullVersion',
				'wow64',
				'formFactors',
			]);
		} catch (error) {
			return null;
		}
	})();
	return uaValues;
}

const sfString = (value: string) =>
	`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const sfBoolean = (value: boolean) => (value ? '?1' : '?0');
const brandList = (brands: { brand: string; version: string }[]) =>
	brands
		.map(({ brand, version }) => `${sfString(brand)};v=${sfString(version)}`)
		.join(', ');

/** what a request to a document's subresource or a navigation carries */
export interface HintsContext {
	/** the request's target */
	target: URL;
	/** whether the browser would send hints to it at all (potentially trustworthy) */
	secure: boolean;
	navigation: boolean;
	topLevel: boolean;
	/** the requesting document (a subresource's), or the frame's parent (a frame's navigation) */
	doc: HintsDocument | null;
	/** the proxied top's origin, when known */
	top: string | null;
	/** the controller's address (its top-level viewport) */
	directory: string;
	/** the page's own request (fetch, XHR), whose fields of these names may be its own */
	pageRequest: boolean;
	/** a frame's navigation: its element's allow attribute, when its parent said */
	allow?: string;
}

/**
 * The client hints of a request, set on `headers` (the browser's are
 * removed first); the names sent
 */
export async function applyClientHints(
	headers: Headers,
	context: HintsContext,
): Promise<Set<string>> {
	// the browser's own user-agent hints: when the proxy origin is one it
	// sends hints to and it sent none, it has them turned off (a DevTools
	// user-agent override without metadata; the --user-agent switch keeps
	// them, measured), and the site gets none either; when it sent them,
	// they are the ones to send
	const browserUA = headers.get('sec-ch-ua');
	const browserMobile = headers.get('sec-ch-ua-mobile');
	const browserPlatform = headers.get('sec-ch-ua-platform');
	const uaOff =
		browserUA === null && potentiallyTrustworthy(new URL(location.href));
	for (const name of [...headers.keys()]) {
		if (!isHintName(name)) continue;
		// a page may name a legacy hint (DPR, ECT) on a fetch of its own,
		// which a hint the request carries replaces, as Blink's does; the
		// browser adds none of those in proxy URL space (the worker strips
		// Accept-CH from the shell, the inject a meta's content), and no page
		// can set a Sec- field
		if (context.pageRequest && !name.startsWith('sec-ch-')) continue;
		headers.delete(name);
	}
	const sent = new Set<string>();
	if (!context.secure) return sent;
	const origin = context.target.origin;
	const { enabled, allows, viewport } = await requestHints(context, origin);
	const ua = await userAgentValues();
	const connection = (
		navigator as Navigator & {
			connection?: {
				rtt?: number;
				downlink?: number;
				effectiveType?: string;
				saveData?: boolean;
			};
		}
	).connection;
	const deviceMemory = (navigator as Navigator & { deviceMemory?: number })
		.deviceMemory;
	const values: Record<string, string | null> = {
		'sec-ch-ua': browserUA ?? (ua ? brandList(ua.brands) : null),
		'sec-ch-ua-mobile': browserMobile ?? (ua ? sfBoolean(ua.mobile) : null),
		'sec-ch-ua-platform':
			browserPlatform ?? (ua ? sfString(ua.platform) : null),
		'sec-ch-ua-arch': ua ? sfString(ua.architecture) : null,
		'sec-ch-ua-bitness': ua ? sfString(ua.bitness) : null,
		'sec-ch-ua-model': ua ? sfString(ua.model) : null,
		'sec-ch-ua-platform-version': ua ? sfString(ua.platformVersion) : null,
		'sec-ch-ua-full-version': ua ? sfString(ua.uaFullVersion) : null,
		'sec-ch-ua-full-version-list': ua ? brandList(ua.fullVersionList) : null,
		'sec-ch-ua-wow64': ua ? sfBoolean(ua.wow64) : null,
		'sec-ch-ua-form-factors': ua
			? (ua.formFactors ?? []).map(sfString).join(', ')
			: null,
		'device-memory': deviceMemory ? String(deviceMemory) : null,
		'sec-ch-device-memory': deviceMemory ? String(deviceMemory) : null,
		rtt: typeof connection?.rtt === 'number' ? String(connection.rtt) : null,
		downlink:
			typeof connection?.downlink === 'number'
				? String(connection.downlink)
				: null,
		ect: connection?.effectiveType ?? null,
		'save-data': connection?.saveData ? 'on' : null,
		dpr: display ? String(display.dpr) : null,
		'sec-ch-dpr': display ? String(display.dpr) : null,
		// zero is a viewport the browser could not measure: not sent
		'viewport-width': viewport?.[0] ? String(viewport[0]) : null,
		'sec-ch-viewport-width': viewport?.[0] ? String(viewport[0]) : null,
		'sec-ch-viewport-height': viewport?.[1] ? String(viewport[1]) : null,
		'sec-ch-prefers-color-scheme': display?.colorScheme ?? null,
		'sec-ch-prefers-reduced-motion': display?.reducedMotion ?? null,
		'sec-ch-prefers-reduced-transparency': display?.reducedTransparency ?? null,
		// an element's rendered width: the worker cannot know it
		width: null,
		'sec-ch-width': null,
	};
	for (const name of Object.keys(HINT_FEATURES)) {
		if (!SENT_BY_DEFAULT.has(name) && !enabled.has(name)) continue;
		if (!allows(HINT_FEATURES[name])) continue;
		if (uaOff && name.startsWith('sec-ch-ua')) continue;
		const value = values[name];
		if (value === null || value === undefined) continue;
		headers.set(name, value);
		sent.add(name);
	}
	return sent;
}

/** what is enabled and allowed for a request, and the viewport it reports */
async function requestHints(
	context: HintsContext,
	origin: string,
): Promise<{
	enabled: Set<string>;
	allows: (feature: string) => boolean;
	viewport: [number, number] | null;
}> {
	const topViewport = topViewports.get(context.directory) ?? null;
	if (context.navigation && context.topLevel)
		// the main frame's own navigation: the origin's set, every hint allowed
		return {
			enabled: await acceptedHints(origin),
			allows: () => true,
			viewport: topViewport,
		};
	if (context.navigation) {
		// a frame: the main frame's set and policy for the frame's origin
		// (the browser process decides it), with its parent's delegate-ch
		const top = context.top;
		const main = top ? topDocument(top) : null;
		// the origin's kept set, never the main frame's meta (measured)
		const enabled = top ? await acceptedHints(top) : new Set<string>();
		const parent = context.doc;
		const parentOrigin = parent?.origin ?? top ?? origin;
		// the frame's container policy: its element's allow attribute, and
		// its parent's delegate-ch for what the attribute does not name; a
		// feature in it is the container's to decide, and turns on its hints
		// when it names the main frame's origin
		const container = new Map(parent?.delegated ?? []);
		for (const [feature, list] of parseAllowAttribute(
			context.allow ?? '',
			origin,
		))
			if (feature.startsWith('ch-')) container.set(feature, list);
		for (const [feature, list] of container)
			if (main && allowlistMatches(list, main.origin, parentOrigin))
				for (const [hint, gate] of Object.entries(HINT_FEATURES))
					if (gate === feature) enabled.add(hint);
		return {
			enabled,
			allows: (feature) => {
				const named = container.get(feature);
				if (named) return allowlistMatches(named, origin, parentOrigin);
				if (main) return policyAllows(main.policy, feature, origin);
				return ENABLED_FOR_ALL.has(feature) || origin === top;
			},
			viewport: main?.viewport ?? topViewport,
		};
	}
	const doc = context.doc;
	if (!doc)
		// a client the worker knows nothing of (a worker, a document it
		// served before it restarted): the defaults only
		return {
			enabled: new Set(),
			allows: (feature) => ENABLED_FOR_ALL.has(feature),
			viewport: null,
		};
	return {
		enabled: doc.enabled,
		allows: (feature) => policyAllows(doc.policy, feature, origin),
		viewport: doc.viewport ?? (doc.topLevel ? topViewport : null),
	};
}

/**
 * Whether a top-level navigation's answer asks for it again with hints it
 * lacked: a Critical-CH hint the origin accepts and the request did not
 * carry, which the worker can send
 */
export function criticalRetry(
	critical: string | null,
	accepted: Set<string>,
	sent: Set<string>,
): boolean {
	if (critical === null) return false;
	const hints = parseAcceptCH(critical) ?? [];
	return hints.some((hint) => accepted.has(hint) && !sent.has(hint));
}
